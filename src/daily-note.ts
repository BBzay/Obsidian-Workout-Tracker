import { App, TFile, moment, normalizePath } from 'obsidian';

export interface DailyWorkout {
	id: string;
	workoutName: string;
	date: string;
	dailyNoteDate?: string;
	dailyNoteTime?: string;
	totalDurationSeconds: number;
	exercises: { name: string; sets: unknown[] }[];
}

function plain(value: string): string {
	return value.replace(/[\r\n\t]+/g, ' ').replace(/[<>\[\]`*_\\]/g, '').replace(/\s+/g, ' ').trim();
}

export function workoutLogLine(workout: DailyWorkout): string {
	if (!/^[a-zA-Z0-9_-]+$/.test(workout.id)) throw new Error('Invalid workout ID');
	if (!Number.isFinite(workout.totalDurationSeconds) || workout.totalDurationSeconds < 0) throw new Error('Invalid workout duration');
	const seconds = Math.floor(workout.totalDurationSeconds);
	const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60), rest = seconds % 60;
	const duration = [hours ? `${hours} hr` : '', minutes ? `${minutes} min` : '', rest || !seconds ? `${rest} sec` : ''].filter(Boolean).join(' ');
	const exercises = workout.exercises.filter(ex => ex.sets.length > 0);
	const sets = exercises.reduce((count, ex) => count + ex.sets.length, 0);
	const names = exercises.slice(0, 4).map(ex => plain(ex.name) || 'unnamed exercise').join(', ');
	const extra = exercises.length > 4 ? ` and ${exercises.length - 4} more` : '';
	const detail = sets ? `${sets} completed set${sets === 1 ? '' : 's'} across ${names}${extra}` : 'no completed sets';
	const time = /^\d{2}:\d{2}$/.test(workout.dailyNoteTime || '') ? workout.dailyNoteTime : moment(workout.date).format('HH:mm');
	return `- ${time} workout: ${plain(workout.workoutName) || 'Workout'} — ${detail} in ${duration}. <!-- workout-ledger:${workout.id} -->`;
}

// Work only before Journal. Ignore apparent headings inside fenced code blocks.
function headings(text: string): { title: string; start: number; end: number }[] {
	const result = [];
	let offset = 0, fence = '';
	for (const line of text.match(/[^\n]*(?:\n|$)/g) || []) {
		const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
		if (match) {
			if (!fence) fence = match[1];
			else if (match[1][0] === fence[0] && match[1].length >= fence.length) fence = '';
		} else if (!fence) {
			const heading = /^##[ \t]+(.+?)[ \t]*\r?\n?$/.exec(line);
			if (heading) result.push({ title: heading[1], start: offset, end: offset + line.length });
		}
		offset += line.length;
	}
	return result;
}

export function upsertWorkoutLog(text: string, workout: DailyWorkout): string {
	const line = workoutLogLine(workout);
	const newline = text.includes('\r\n') ? '\r\n' : '\n';
	const sections = headings(text);
	const journal = sections.find(h => h.title === 'Journal');
	const boundary = journal?.start ?? text.length;
	const log = sections.find(h => h.title === 'Log' && h.start < boundary);
	if (!log) {
		const prefix = text.slice(0, boundary);
		return prefix + (prefix.endsWith(newline + newline) || !prefix ? '' : prefix.endsWith(newline) ? newline : newline + newline)
			+ `## Log${newline}${newline}${line}${newline}${newline}` + text.slice(boundary);
	}
	const end = sections.find(h => h.start > log.start)?.start ?? text.length;
	const body = text.slice(log.end, end);
	const marker = `<!-- workout-ledger:${workout.id} -->`;
	let found = false;
	const lines = body.split(/\r?\n/).filter(existing => {
		if (!existing.startsWith('- ') || !existing.trimEnd().endsWith(marker)) return true;
		if (found) return false;
		found = true;
		return true;
	}).map(existing => existing.startsWith('- ') && existing.trimEnd().endsWith(marker) ? line : existing);
	let replacement = lines.join(newline);
	if (!found) replacement = replacement.trimEnd() + `${newline}${line}${newline}${newline}`;
	return text.slice(0, log.end) + replacement + text.slice(end);
}

function safePath(path: string): string {
	const raw = path.trim().replace(/\\/g, '/');
	if (!raw || raw.startsWith('/') || raw.split('/').some(part => part === '..' || part.startsWith('.') || /[:<>|?*]/.test(part)) || /^Private(?:\/|$)/i.test(raw)) {
		throw new Error('Choose a visible vault-relative path');
	}
	return normalizePath(raw);
}

export async function writeWorkoutDailyNote(app: App, workout: DailyWorkout, folder: string, templatePath: string): Promise<boolean> {
	const date = moment(workout.date, moment.ISO_8601, true);
	if (!date.isValid()) throw new Error('Invalid workout date');
	workoutLogLine(workout); // Validate before creating anything.
	const day = workout.dailyNoteDate || date.format('YYYY-MM-DD');
	if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !moment(day, 'YYYY-MM-DD', true).isValid()) throw new Error('Invalid daily-note date');
	const path = `${safePath(folder)}/${day}.md`;
	let file = app.vault.getAbstractFileByPath(path);
	if (!file) {
		const template = app.vault.getAbstractFileByPath(safePath(templatePath));
		let body = template instanceof TFile ? await app.vault.read(template) : `# ${day}\n\n## Atlas\n\n## Log\n\n## Journal\n`;
		const localDate = moment(day, 'YYYY-MM-DD');
		body = body.replace(/\{\{date:([^}]+)\}\}/g, (_, format: string) => localDate.format(format)).replace(/\{\{date\}\}/g, day);
		const parts = safePath(folder).split('/');
		for (let i = 1; i <= parts.length; i++) {
			const parent = parts.slice(0, i).join('/');
			if (!app.vault.getAbstractFileByPath(parent)) {
				try { await app.vault.createFolder(parent); }
				catch (error) { if (!app.vault.getAbstractFileByPath(parent)) throw error; }
			}
		}
		try { file = await app.vault.create(path, body); }
		catch (error) {
			file = app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) throw error;
		}
	}
	if (!(file instanceof TFile)) throw new Error('Daily-note path is not a file');
	let changed = false;
	await app.vault.process(file, current => {
		const next = upsertWorkoutLog(current, workout);
		changed = next !== current;
		return next;
	});
	return changed;
}
