import {
	App,
	ItemView,
	Menu,
	Modal,
	Notice,
	Plugin,
	Platform,
	PluginSettingTab,
	Setting,
	WorkspaceLeaf,
	setIcon,
} from 'obsidian';
import { writeWorkoutDailyNote } from './daily-note';
import {
	Plan,
	WEEKDAY_LONG,
	WEEKDAY_SHORT,
	WEEK_ORDER,
	distinctLocations,
	formatDays,
	nextScheduled,
	normalizePlanData,
	planWorkoutIndices,
	weekRank,
	workoutsOnDay,
} from './plans';

// ─── View Type Constants ─────────────────────────────────────────────────────

const VIEW_TYPE_TRACKER = 'workout-ledger-view';

// ─── Data Model ──────────────────────────────────────────────────────────────

interface ExerciseSet {
	reps: number;
	weight: number;
	restSeconds: number;
}

interface Exercise {
	name: string;
	modifier: string;
	sets: ExerciseSet[];
	supersetGroupId?: string;
}

interface Superset {
	id: string;
	restSeconds: number;
}

interface Workout {
	name: string;
	exercises: Exercise[];
	supersets: Superset[];
	lastUpdatedDurationSeconds?: number;
	/** Plan this workout belongs to (at most one). */
	planId?: string;
	/** Weekdays (Date.getDay(), 0 = Sunday) this workout is scheduled in its plan. */
	days?: number[];
	/** Where it's done, free text (e.g. "Home gym"). Trimmed; absent when blank. */
	location?: string;
}

interface CompletedSet {
	reps: number;
	weight: number;
	setSeconds: number;
	actualRestSeconds: number;
}

interface CompletedExercise {
	name: string;
	sets: CompletedSet[];
}

interface CompletedWorkout {
	id: string;
	workoutName: string;
	date: string;
	dailyNoteDate?: string;
	dailyNoteTime?: string;
	totalDurationSeconds: number;
	exercises: CompletedExercise[];
	prs?: string[];
	notes?: string;
}

interface PRRecord {
	maxWeight: number;
	maxWeightDate: string;
	maxVolume: number;
	maxVolumeDate: string;
	maxReps: number;
	maxRepsDate: string;
	max1RM: number;
	max1RMDate: string;
}

interface PluginSettings {
	dailyNoteFolder: string;
	dailyNoteTemplate: string;
	weightUnit: 'lbs' | 'kg';
	defaultRestSeconds: number;
	restTimerSound: boolean;
	restTimerVibrate: boolean;
}

interface PluginData {
	workouts: Workout[];
	lastUsed: Record<string, { reps: number; weight: number }>;
	history: CompletedWorkout[];
	settings: PluginSettings;
	personalRecords: Record<string, PRRecord>;
	plans: Plan[];
	/** Only this plan's weekdays count for "today". */
	currentPlanId?: string;
	noPlanCollapsed?: boolean;
}

const DEFAULT_SETTINGS: PluginSettings = {
	dailyNoteFolder: 'Journal',
	dailyNoteTemplate: 'Home/Templates/Daily note.md',
	weightUnit: 'lbs',
	defaultRestSeconds: 60,
	restTimerSound: true,
	restTimerVibrate: true,
};

const DEFAULT_DATA: PluginData = {
	workouts: [],
	lastUsed: {},
	history: [],
	settings: DEFAULT_SETTINGS,
	personalRecords: {},
	plans: [],
};

// ─── Workout Step — flat sequence for active mode ────────────────────────────

interface WorkoutStep {
	exerciseIndex: number;
	setIndex: number;
	restSeconds: number;
}

// ─── Active Workout State ────────────────────────────────────────────────────

interface CompletedStepEntry {
	/** Index into `steps`, which keep plan order for the whole session. */
	stepIndex: number;
	/** Same object as the one in `completedExercises`, so edits and rest times stay in sync. */
	completedSet: CompletedSet;
	exerciseName: string;
}

interface ActiveWorkoutState {
	setStarted: boolean;
	setDrafts: Record<string, { reps: number; weight: number }>;
	workout: Workout;
	startTime: number;
	steps: WorkoutStep[];
	currentStepIndex: number;
	isResting: boolean;
	restRemaining: number;
	setElapsed: number;
	completedExercises: CompletedExercise[];
	currentSetStartTime: number;
	restStartTime: number;
	currentReps: number;
	currentWeight: number;
	isPaused: boolean;
	pauseStartTime: number;
	totalPausedMs: number;
	/** Completed sets in the order they were done. A step is done when it appears here. */
	stepHistory: CompletedStepEntry[];
	/** While resting: the set picked in the workout plan to do next (default: next unfinished in plan order). */
	nextStepIndex?: number;
	/** `lastUsed` values this session overwrote (null = key was new), so Discard can put them back. */
	lastUsedBefore: Record<string, { reps: number; weight: number } | null>;
}

// ─── Screen type for unified view ───────────────────────────────────────────

type Screen = 'home' | 'edit' | 'active' | 'completion' | 'history' | 'stats';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateId(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function formatTime(totalSeconds: number): string {
	const abs = Math.abs(totalSeconds);
	const h = Math.floor(abs / 3600);
	const m = Math.floor((abs % 3600) / 60);
	const s = Math.floor(abs % 60);
	const sign = totalSeconds < 0 ? '-' : '';
	return `${sign}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function workoutElapsedSeconds(state: ActiveWorkoutState, now = Date.now()): number {
	const end = state.isPaused ? state.pauseStartTime : now;
	return Math.max(0, Math.floor((end - state.startTime - state.totalPausedMs) / 1000));
}

function formatDurationShort(totalSeconds: number): string {
	const h = Math.floor(totalSeconds / 3600);
	const m = Math.floor((totalSeconds % 3600) / 60);
	if (h > 0) return `${h}h ${m}m`;
	return `${m}m`;
}

function lastUsedKey(workoutName: string, exerciseName: string, setIndex: number): string {
	return `${workoutName}|${exerciseName}|${setIndex}`;
}

function estimate1RM(weight: number, reps: number): number {
	if (reps <= 0 || weight <= 0) return 0;
	if (reps === 1) return weight;
	return Math.round(weight * (1 + reps / 30));
}

function buildSteps(workout: Workout): WorkoutStep[] {
	const steps: WorkoutStep[] = [];
	const processed = new Set<number>();

	for (let i = 0; i < workout.exercises.length; i++) {
		if (processed.has(i)) continue;
		const ex = workout.exercises[i];
		if (ex.supersetGroupId) {
			const groupId = ex.supersetGroupId;
			const groupIndices: number[] = [];
			for (let j = i; j < workout.exercises.length; j++) {
				if (workout.exercises[j].supersetGroupId === groupId) {
					groupIndices.push(j);
					processed.add(j);
				}
			}
			const ssConfig = workout.supersets.find((s) => s.id === groupId);
			const ssRest = ssConfig?.restSeconds ?? 0;
			const maxSets = Math.max(...groupIndices.map((gi) => workout.exercises[gi].sets.length));
			for (let round = 0; round < maxSets; round++) {
				for (let g = 0; g < groupIndices.length; g++) {
					const gi = groupIndices[g];
					const gex = workout.exercises[gi];
					if (round >= gex.sets.length) continue;
					const isLastInRound = g === groupIndices.length - 1 ||
						groupIndices.slice(g + 1).every((ni) => round >= workout.exercises[ni].sets.length);
					const isLastRound = round === maxSets - 1;
					let rest = 0;
					if (isLastInRound && !isLastRound) rest = ssRest;
					steps.push({ exerciseIndex: gi, setIndex: round, restSeconds: rest });
				}
			}
		} else {
			processed.add(i);
			for (let s = 0; s < ex.sets.length; s++) {
				steps.push({ exerciseIndex: i, setIndex: s, restSeconds: ex.sets[s].restSeconds });
			}
		}
	}
	// The last step keeps its rest: sets can be done out of order, and a finished workout never rests.
	return steps;
}

/** First unfinished step after `from` in plan order, wrapping to the start. Returns `from` if it is the only one left, -1 if all are done. */
function nextOpenStep(state: ActiveWorkoutState, from: number): number {
	const done = new Set(state.stepHistory.map((h) => h.stepIndex));
	const n = state.steps.length;
	for (let k = 1; k <= n; k++) {
		const i = (from + k) % n;
		if (!done.has(i)) return i;
	}
	return -1;
}

interface LoggedSet { exerciseIndex: number; exerciseName: string; setIndex: number; set: CompletedSet; }

/** Copy logged reps/weight onto the template by set number (sets may have been done out of order or skipped). */
function applyLoggedSetsToTemplate(template: Workout, logged: LoggedSet[]): void {
	for (const { exerciseIndex, exerciseName, setIndex, set } of logged) {
		const byIndex = template.exercises[exerciseIndex];
		const ex = byIndex?.name === exerciseName ? byIndex : template.exercises.find((e) => e.name === exerciseName);
		const target = ex?.sets[setIndex];
		if (target) { target.reps = set.reps; target.weight = set.weight; }
	}
}

// ─── Date helpers ───────────────────────────────────────────────────────────

function shortDate(isoStr: string): string {
	const d = new Date(isoStr);
	return `${d.getMonth() + 1}/${d.getDate()}`;
}

function daysBetween(dateStr: string): number {
	const d = new Date(dateStr);
	const now = new Date();
	return Math.floor((now.getTime() - d.getTime()) / 86400000);
}

function getWeekStart(date: Date): Date {
	const d = new Date(date);
	const day = d.getDay();
	const diff = d.getDate() - day + (day === 0 ? -6 : 1);
	d.setDate(diff); d.setHours(0, 0, 0, 0);
	return d;
}

function getMonthStart(date: Date): Date { return new Date(date.getFullYear(), date.getMonth(), 1); }
function getYearStart(date: Date): Date { return new Date(date.getFullYear(), 0, 1); }

function addWeeks(date: Date, n: number): Date { const d = new Date(date); d.setDate(d.getDate() + n * 7); return d; }
function addMonths(date: Date, n: number): Date { const d = new Date(date); d.setMonth(d.getMonth() + n); return d; }
function addYears(date: Date, n: number): Date { const d = new Date(date); d.setFullYear(d.getFullYear() + n); return d; }

function formatWeekLabel(date: Date): string {
	const end = new Date(date); end.setDate(end.getDate() + 6);
	return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}
function formatMonthLabel(date: Date): string { return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }); }
function formatYearLabel(date: Date): string { return String(date.getFullYear()); }

type TimeRange = 'week' | 'month' | 'year' | 'all';

function getPeriodBounds(range: TimeRange, offset: number): { start: Date; end: Date } {
	const now = new Date();
	let start: Date, end: Date;
	switch (range) {
		case 'week': { const b = getWeekStart(now); start = addWeeks(b, offset); end = addWeeks(start, 1); break; }
		case 'month': { const b = getMonthStart(now); start = addMonths(b, offset); end = addMonths(start, 1); break; }
		case 'year': { const b = getYearStart(now); start = addYears(b, offset); end = addYears(start, 1); break; }
		default: start = new Date(0); end = new Date(now.getTime() + 86400000); break;
	}
	return { start, end };
}

function filterHistoryByRange(history: CompletedWorkout[], range: TimeRange, offset: number): CompletedWorkout[] {
	if (range === 'all') return history;
	const { start, end } = getPeriodBounds(range, offset);
	return history.filter((w) => { const d = new Date(w.date); return d >= start && d < end; });
}

function getPeriodLabel(range: TimeRange, offset: number): string {
	if (range === 'all') return 'All Time';
	const { start } = getPeriodBounds(range, offset);
	switch (range) {
		case 'week': return formatWeekLabel(start);
		case 'month': return formatMonthLabel(start);
		case 'year': return formatYearLabel(start);
		default: return '';
	}
}

function aggregatePoints(points: { label: string; value: number }[], maxPoints: number): { label: string; value: number }[] {
	if (points.length <= maxPoints) return points;
	const bucketSize = Math.ceil(points.length / maxPoints);
	const result: { label: string; value: number }[] = [];
	for (let i = 0; i < points.length; i += bucketSize) {
		const bucket = points.slice(i, i + bucketSize);
		const avg = bucket.reduce((s, p) => s + p.value, 0) / bucket.length;
		result.push({ label: bucket[0].label, value: Math.round(avg * 10) / 10 });
	}
	return result;
}

// ─── Audio helper ───────────────────────────────────────────────────────────

let audioCtx: AudioContext | null = null;

function playRestBeep(): void {
	try {
		if (!audioCtx) audioCtx = new AudioContext();
		for (let i = 0; i < 2; i++) {
			const osc = audioCtx.createOscillator();
			const gain = audioCtx.createGain();
			osc.connect(gain); gain.connect(audioCtx.destination);
			osc.frequency.value = 880; osc.type = 'sine'; gain.gain.value = 0.3;
			const t = audioCtx.currentTime + i * 0.25;
			osc.start(t); osc.stop(t + 0.15);
		}
	} catch { /* Audio not available */ }
}

function vibrateDevice(): void {
	try { if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 200]); } catch { /* not available */ }
}

// ─── Confirmation Modal ──────────────────────────────────────────────────────

class ConfirmModal extends Modal {
	private message: string;
	private onConfirm: () => void;
	constructor(app: App, message: string, onConfirm: () => void) {
		super(app); this.message = message; this.onConfirm = onConfirm;
	}
	onOpen() {
		const { contentEl } = this;
		contentEl.createEl('h3', { text: 'Confirm' });
		contentEl.createEl('p', { text: this.message });
		const btnRow = contentEl.createDiv({ cls: 'wt-modal-buttons' });
		btnRow.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
		const confirmBtn = btnRow.createEl('button', { text: 'Confirm', cls: 'mod-warning' });
		confirmBtn.addEventListener('click', () => { this.onConfirm(); this.close(); });
	}
	onClose() { this.contentEl.empty(); }
}

/** End a running workout: save it to history, or discard the whole session (asks twice). */
class EndWorkoutModal extends Modal {
	private detail: string;
	private onSave: () => void;
	private onDiscard: () => void;
	constructor(app: App, detail: string, onSave: () => void, onDiscard: () => void) {
		super(app); this.detail = detail; this.onSave = onSave; this.onDiscard = onDiscard;
	}
	onOpen() {
		const { contentEl } = this;
		contentEl.addClass('wt-end-modal');
		contentEl.createEl('h3', { text: 'End workout?' });
		contentEl.createEl('p', { text: this.detail, cls: 'wt-end-detail' });
		const warning = contentEl.createDiv();
		const btnRow = contentEl.createDiv({ cls: 'wt-modal-buttons' });
		btnRow.createEl('button', { text: 'Keep going' }).addEventListener('click', () => this.close());
		const discardBtn = btnRow.createEl('button', { text: 'Discard', cls: 'mod-warning' });
		let armed = false;
		discardBtn.addEventListener('click', () => {
			if (!armed) {
				armed = true;
				discardBtn.setText('Tap again to discard');
				warning.createEl('p', { text: 'Nothing from this session will be saved: no history, PRs or daily-note entry, and remembered weights go back to what they were.', cls: 'wt-end-warning' });
				return;
			}
			this.close(); this.onDiscard();
		});
		const saveBtn = btnRow.createEl('button', { text: 'Save workout', cls: 'mod-cta' });
		saveBtn.addEventListener('click', () => { this.close(); this.onSave(); });
	}
	onClose() { this.contentEl.empty(); }
}

class RenameModal extends Modal {
	private currentName: string;
	private onSubmit: (newName: string) => void;
	private title: string;
	private buttonText: string;
	constructor(app: App, currentName: string, onSubmit: (newName: string) => void, title = 'Rename Workout', buttonText = 'Rename') {
		super(app); this.currentName = currentName; this.onSubmit = onSubmit; this.title = title; this.buttonText = buttonText;
	}
	onOpen() {
		const { contentEl } = this;
		contentEl.createEl('h3', { text: this.title });
		let newName = this.currentName;
		const submit = () => { if (newName.trim()) { this.onSubmit(newName.trim()); this.close(); } };
		new Setting(contentEl).setName('Name').addText((text) => {
			text.setValue(this.currentName).onChange((v) => { newName = v; });
			text.inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
			window.setTimeout(() => { text.inputEl.focus(); text.inputEl.select(); }, 0);
		});
		new Setting(contentEl).addButton((btn) => btn.setButtonText(this.buttonText).setCta().onClick(submit));
	}
	onClose() { this.contentEl.empty(); }
}

/** Checklist of workouts not yet in `plan`; checked ones move into it. */
class PlanWorkoutsModal extends Modal {
	private plan: Plan;
	private plugin: WorkoutTrackerPlugin;
	private onDone: () => void;
	constructor(app: App, plugin: WorkoutTrackerPlugin, plan: Plan, onDone: () => void) {
		super(app); this.plugin = plugin; this.plan = plan; this.onDone = onDone;
	}
	onOpen() {
		const { contentEl } = this;
		const { workouts, plans } = this.plugin.data;
		contentEl.createEl('h3', { text: `Add workouts to ${this.plan.name}` });
		const candidates = workouts.map((w, i) => ({ w, i })).filter(({ w }) => w.planId !== this.plan.id);
		if (candidates.length === 0) {
			contentEl.createEl('p', { text: 'Every workout is already in this plan.', cls: 'wt-muted' });
			return;
		}
		contentEl.createEl('p', { text: 'Workouts in another plan will move here. Their days are kept.', cls: 'wt-muted' });
		const selected = new Set<number>();
		const list = contentEl.createDiv({ cls: 'wt-plan-pick-list' });
		for (const { w, i } of candidates) {
			const row = list.createDiv({ cls: 'wt-ss-check-row' });
			const cb = row.createEl('input', { type: 'checkbox' });
			cb.id = `wt-plan-pick-${i}`;
			const label = row.createEl('label', { text: w.name });
			label.setAttribute('for', cb.id);
			const other = plans.find((p) => p.id === w.planId);
			if (other) label.createSpan({ text: `  (${other.name})`, cls: 'wt-muted' });
			cb.addEventListener('change', () => { if (cb.checked) selected.add(i); else selected.delete(i); });
		}
		const btnRow = contentEl.createDiv({ cls: 'wt-modal-buttons' });
		btnRow.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
		btnRow.createEl('button', { text: 'Add to plan', cls: 'mod-cta' }).addEventListener('click', async () => {
			if (selected.size === 0) { new Notice('Select at least one workout.'); return; }
			for (const i of selected) workouts[i].planId = this.plan.id;
			this.plan.collapsed = false;
			await this.plugin.savePluginData();
			this.onDone();
			this.close();
		});
	}
	onClose() { this.contentEl.empty(); }
}

class SupersetModal extends Modal {
	private exercises: Exercise[];
	private selected: Set<number> = new Set();
	private onSubmit: (indices: number[]) => void;
	constructor(app: App, exercises: Exercise[], onSubmit: (indices: number[]) => void) {
		super(app); this.exercises = exercises; this.onSubmit = onSubmit;
	}
	onOpen() {
		const { contentEl } = this;
		contentEl.createEl('h3', { text: 'Create Superset' });
		contentEl.createEl('p', { text: 'Select 2 or more exercises to superset:' });
		this.exercises.forEach((ex, idx) => {
			if (ex.supersetGroupId) return;
			const row = contentEl.createDiv({ cls: 'wt-ss-check-row' });
			const cb = row.createEl('input', { type: 'checkbox' }) as HTMLInputElement;
			cb.id = `ss-cb-${idx}`;
			row.createEl('label', { text: ex.name });
			(row.querySelector('label') as HTMLElement).setAttribute('for', cb.id);
			cb.addEventListener('change', () => { if (cb.checked) this.selected.add(idx); else this.selected.delete(idx); });
		});
		const btnRow = contentEl.createDiv({ cls: 'wt-modal-buttons' });
		btnRow.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
		const createBtn = btnRow.createEl('button', { text: 'Create Superset', cls: 'mod-cta' });
		createBtn.addEventListener('click', () => {
			if (this.selected.size < 2) { new Notice('Select at least 2 exercises.'); return; }
			this.onSubmit([...this.selected].sort((a, b) => a - b)); this.close();
		});
	}
	onClose() { this.contentEl.empty(); }
}

class UpdateWorkoutModal extends Modal {
	private workoutName: string;
	private onUpdate: () => void;
	private onSkip: () => void;
	constructor(app: App, workoutName: string, onUpdate: () => void, onSkip: () => void) {
		super(app); this.workoutName = workoutName; this.onUpdate = onUpdate; this.onSkip = onSkip;
	}
	onOpen() {
		const { contentEl } = this;
		contentEl.createEl('h3', { text: 'Update Workout Template?' });
		contentEl.createEl('p', { text: `Save the reps and weights you just did as the new defaults for "${this.workoutName}"?` });
		const btnRow = contentEl.createDiv({ cls: 'wt-modal-buttons' });
		btnRow.createEl('button', { text: 'No, keep as is' }).addEventListener('click', () => { this.onSkip(); this.close(); });
		const updateBtn = btnRow.createEl('button', { text: 'Yes, update', cls: 'mod-cta' });
		updateBtn.addEventListener('click', () => { this.onUpdate(); this.close(); });
	}
	onClose() { this.contentEl.empty(); }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PLUGIN CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export default class WorkoutTrackerPlugin extends Plugin {
	data: PluginData = DEFAULT_DATA;
	activeState: ActiveWorkoutState | null = null;
	private dailySync: Promise<void> = Promise.resolve();
	private pendingDailyNotes = new Set<string>();
	private dailySyncWarning = false;

	async onload(): Promise<void> {
		await this.loadPluginData();
		this.registerView(VIEW_TYPE_TRACKER, (leaf) => new WorkoutTrackerView(leaf, this));
		this.addSettingTab(new WorkoutSettingTab(this.app, this));

		this.addRibbonIcon('dumbbell', 'Open Workout Ledger', () => this.activateView());

		this.addCommand({ id: 'open-workout-ledger', name: 'Open Workout Ledger', callback: () => this.activateView() });
		this.addCommand({ id: 'start-last-workout', name: 'Start Last Workout', callback: () => this.startLastWorkout() });
		this.addCommand({ id: 'start-todays-workout', name: "Start today's workout", callback: () => this.startTodaysWorkout() });
		this.addCommand({ id: 'sync-daily-notes', name: 'Sync workout summaries to daily notes', callback: () => this.syncDailyNotes(false) });

		this.app.workspace.onLayoutReady(() => { void this.syncDailyNotes(); });
		this.registerInterval(window.setInterval(() => {
			if (this.pendingDailyNotes.size) void this.syncDailyNotes(true, true);
		}, 60000));
	}

	onunload(): void {
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_TRACKER);
	}

	async loadPluginData(): Promise<void> {
		const saved = await this.loadData();
		// Fresh containers so defaults are never shared between loads
		this.data = Object.assign({}, DEFAULT_DATA, { workouts: [], history: [], lastUsed: {}, personalRecords: {}, plans: [] }, saved);
		this.data.settings = Object.assign({}, DEFAULT_SETTINGS, this.data.settings);
		this.normalizeData();
	}

	/** Repair shapes from older versions or imports. Safe to call repeatedly. */
	normalizeData(): void {
		const d = this.data;
		if (!Array.isArray(d.workouts)) d.workouts = [];
		if (!Array.isArray(d.history)) d.history = [];
		if (!d.lastUsed) d.lastUsed = {};
		if (!d.personalRecords) d.personalRecords = {};
		for (const w of d.workouts) {
			if (!w.supersets) w.supersets = [];
			const location = typeof w.location === 'string' ? w.location.trim() : '';
			if (location) w.location = location; else delete w.location;
		}
		normalizePlanData(d);
	}

	async savePluginData(): Promise<void> { await this.saveData(this.data); }

	async onExternalSettingsChange(): Promise<void> {
		await this.loadPluginData();
		await this.syncDailyNotes();
	}

	async syncDailyNotes(quiet = true, retryOnly = false): Promise<void> {
		const run = async () => {
			let changed = 0, failures = 0;
			for (const workout of this.data.history) {
				if (retryOnly && !this.pendingDailyNotes.has(workout.id)) continue;
				try {
					if (await writeWorkoutDailyNote(this.app, workout, this.data.settings.dailyNoteFolder, this.data.settings.dailyNoteTemplate)) changed++;
					this.pendingDailyNotes.delete(workout.id);
				} catch {
					this.pendingDailyNotes.add(workout.id);
					failures++;
				}
			}
			if (failures && (!quiet || !this.dailySyncWarning)) new Notice('Workout history is saved, but daily-note sync failed; retrying automatically. Check the daily-note paths in Workout Ledger settings.');
			else if (!quiet && !failures) new Notice(`Workout summaries synced: ${changed} updated.`);
			this.dailySyncWarning = failures > 0;
		};
		this.dailySync = this.dailySync.then(run, run);
		await this.dailySync;
	}

	async activateView(): Promise<void> {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(VIEW_TYPE_TRACKER)[0];
		if (!leaf) {
			const newLeaf = Platform.isMobile ? workspace.getLeaf(false) : workspace.getRightLeaf(false);
			if (!newLeaf) return;
			leaf = newLeaf;
			await leaf.setViewState({ type: VIEW_TYPE_TRACKER, active: true });
		} else if (leaf.view instanceof WorkoutTrackerView) {
			leaf.view.showActiveIfRunning();
		}
		workspace.revealLeaf(leaf);
	}

	getCurrentPlan(): Plan | undefined {
		return this.data.plans.find((p) => p.id === this.data.currentPlanId);
	}

	getTodayWorkouts(date = new Date()): Workout[] {
		return workoutsOnDay(this.data.workouts, this.getCurrentPlan()?.id, date.getDay()).map((i) => this.data.workouts[i]);
	}

	/** e.g. "Pull Day tomorrow" / "Pull Day on Wednesday"; null when the plan has no days set. */
	describeNextWorkout(date = new Date()): string | null {
		const today = date.getDay();
		const next = nextScheduled(this.data.workouts, this.getCurrentPlan()?.id, today);
		if (!next) return null;
		const names = next.indices.map((i) => this.data.workouts[i].name).join(' + ');
		return next.offset === 1 ? `${names} tomorrow` : `${names} on ${WEEKDAY_LONG[(today + next.offset) % 7]}`;
	}

	/** Distinct locations of the next scheduled workout(s); empty if none are set. */
	nextWorkoutLocations(date = new Date()): string[] {
		const next = nextScheduled(this.data.workouts, this.getCurrentPlan()?.id, date.getDay());
		return next ? distinctLocations(next.indices.map((i) => this.data.workouts[i].location)) : [];
	}

	async startTodaysWorkout(): Promise<void> {
		if (this.activeState) { new Notice('A workout is already in progress.'); await this.activateView(); return; }
		const plan = this.getCurrentPlan();
		if (!plan) { new Notice('No current plan. Open a plan\'s menu on the Workout Ledger home screen and choose "Set as current plan".'); return; }
		const today = this.getTodayWorkouts();
		if (today.length === 1) {
			this.beginWorkout(today[0]);
			await this.activateView();
			return;
		}
		if (today.length > 1) {
			new Notice(`${today.length} workouts are scheduled today. Pick one on the home screen.`);
			await this.activateView();
			return;
		}
		const next = this.describeNextWorkout();
		new Notice(next ? `Rest day. Next up: ${next}.` : `Rest day. No days are set in "${plan.name}" yet.`);
	}

	async startLastWorkout(): Promise<void> {
		if (this.data.workouts.length === 0) { new Notice('No workout templates saved yet.'); return; }
		const workout = this.data.workouts[this.data.workouts.length - 1];
		this.beginWorkout(workout);
		await this.activateView();
	}

	beginWorkout(workout: Workout): void {
		// Never replace a running session (its sets and the Discard snapshot would be lost)
		if (this.activeState) { new Notice('A workout is already in progress. End it first.'); return; }
		if (workout.exercises.length === 0) { new Notice('This workout has no exercises. Add some first!'); return; }
		const steps = buildSteps(workout);
		if (steps.length === 0) { new Notice('No sets to do!'); return; }
		const firstStep = steps[0];
		const firstEx = workout.exercises[firstStep.exerciseIndex];
		const firstSet = firstEx.sets[firstStep.setIndex];
		const key = lastUsedKey(workout.name, firstEx.name, firstStep.setIndex);
		const last = this.data.lastUsed[key];
		this.activeState = {
			workout: JSON.parse(JSON.stringify(workout)),
			startTime: Date.now(), steps, currentStepIndex: 0, setStarted: false, setDrafts: {},
			isResting: false, restRemaining: 0, setElapsed: 0,
			completedExercises: [], currentSetStartTime: Date.now(), restStartTime: 0,
			currentReps: last?.reps ?? firstSet?.reps ?? 0,
			currentWeight: last?.weight ?? firstSet?.weight ?? 0,
			isPaused: false, pauseStartTime: 0, totalPausedMs: 0, stepHistory: [], lastUsedBefore: {},
		};
	}

	/** Drop the running session. Nothing reaches history; remembered weights it changed are restored. */
	async discardActiveWorkout(): Promise<void> {
		const state = this.activeState;
		if (!state) return;
		for (const [key, before] of Object.entries(state.lastUsedBefore)) {
			if (before) this.data.lastUsed[key] = before; else delete this.data.lastUsed[key];
		}
		this.activeState = null;
		await this.savePluginData();
	}

	getAllExerciseNames(): string[] {
		const names = new Set<string>();
		for (const w of this.data.workouts) for (const ex of w.exercises) if (ex.name) names.add(ex.name);
		for (const h of this.data.history) for (const ex of h.exercises) if (ex.name) names.add(ex.name);
		return [...names].sort((a, b) => a.localeCompare(b));
	}

	checkAndUpdatePRs(completed: CompletedWorkout): string[] {
		const prDescriptions: string[] = [];
		const unit = this.data.settings.weightUnit;
		for (const cex of completed.exercises) {
			let maxWeight = 0, totalVolume = 0, maxReps = 0, best1RM = 0;
			for (const s of cex.sets) {
				if (s.weight > maxWeight) maxWeight = s.weight;
				if (s.reps > maxReps) maxReps = s.reps;
				totalVolume += s.reps * s.weight;
				const e1rm = estimate1RM(s.weight, s.reps);
				if (e1rm > best1RM) best1RM = e1rm;
			}
			const existing = this.data.personalRecords[cex.name];
			const pr: PRRecord = existing ? { ...existing } : {
				maxWeight: 0, maxWeightDate: '', maxVolume: 0, maxVolumeDate: '',
				maxReps: 0, maxRepsDate: '', max1RM: 0, max1RMDate: '',
			};
			if (maxWeight > pr.maxWeight) { pr.maxWeight = maxWeight; pr.maxWeightDate = completed.date; prDescriptions.push(`${cex.name}: New max weight ${maxWeight} ${unit}`); }
			if (totalVolume > pr.maxVolume) { pr.maxVolume = totalVolume; pr.maxVolumeDate = completed.date; prDescriptions.push(`${cex.name}: New max session volume ${totalVolume.toLocaleString()} ${unit}`); }
			if (maxReps > pr.maxReps && maxWeight > 0) { pr.maxReps = maxReps; pr.maxRepsDate = completed.date; prDescriptions.push(`${cex.name}: New max reps ${maxReps}`); }
			if (best1RM > pr.max1RM) { pr.max1RM = best1RM; pr.max1RMDate = completed.date; prDescriptions.push(`${cex.name}: New est. 1RM ${best1RM} ${unit}`); }
			this.data.personalRecords[cex.name] = pr;
		}
		return prDescriptions;
	}

	rebuildAllPRs(): void {
		this.data.personalRecords = {};
		const sorted = [...this.data.history].sort((a, b) => a.date.localeCompare(b.date));
		for (const entry of sorted) this.checkAndUpdatePRs(entry);
	}

	/** Get the most recent completion date for a workout name */
	getLastCompletedDate(workoutName: string): string | null {
		for (let i = this.data.history.length - 1; i >= 0; i--) {
			if (this.data.history[i].workoutName === workoutName) return this.data.history[i].date;
		}
		return null;
	}
}

// ═══════════════════════════════════════════════════════════════════════════════
// UNIFIED WORKOUT LEDGER VIEW
// ═══════════════════════════════════════════════════════════════════════════════

class WorkoutTrackerView extends ItemView {
	private finishingWorkout = false;
	plugin: WorkoutTrackerPlugin;
	private screen: Screen = 'home';
	private editWorkoutIndex: number = 0;
	private timerIntervalId: number | null = null;
	private dragSourceIndex: number = -1;
	private restAlertFired: boolean = false;
	/** Step just completed, so the workout plan animates it to green once. */
	private justCompletedStep = -1;
	private datalistId = 'wt-exercise-datalist-' + generateId();
	private completedWorkout: CompletedWorkout | null = null;
	private completedPRs: string[] = [];

	// Home screen state
	private expandedWorkoutIndex: number = -1;
	/** Date the home screen was last drawn for, so "today" refreshes at midnight. */
	private renderedDay = '';

	// History/stats state
	private historyTab: 'history' | 'stats' = 'history';
	private statsTimeRange: TimeRange = 'month';
	private statsTimeOffset: number = 0;
	private historyPage: number = 0;
	private historyFilter: string = '';
	private selectedExercise: string = '';
	private readonly HISTORY_PAGE_SIZE = 20;

	constructor(leaf: WorkspaceLeaf, plugin: WorkoutTrackerPlugin) { super(leaf); this.plugin = plugin; }
	getViewType(): string { return VIEW_TYPE_TRACKER; }
	getDisplayText(): string { return 'Workout Ledger'; }
	getIcon(): string { return 'dumbbell'; }

	async onOpen(): Promise<void> {
		if (this.plugin.activeState) this.screen = 'active';
		this.render();
		this.registerInterval(window.setInterval(() => {
			if (this.screen === 'home' && this.renderedDay !== new Date().toDateString()) this.render();
		}, 60000));
	}

	/** Jump to the running workout (used when a command starts one while the view is already open). */
	showActiveIfRunning(): void {
		if (this.plugin.activeState && this.screen !== 'active') { this.screen = 'active'; this.render(); }
	}
	async onClose(): Promise<void> { this.clearTimers(); this.contentEl.empty(); }

	private clearTimers(): void {
		if (this.timerIntervalId !== null) { window.clearInterval(this.timerIntervalId); this.timerIntervalId = null; }
	}

	render(): void {
		this.clearTimers();
		this.contentEl.empty();
		switch (this.screen) {
			case 'home': this.renderHome(); break;
			case 'edit': this.renderEditMode(); break;
			case 'active': this.renderActiveMode(); break;
			case 'completion': this.renderCompletionScreen(); break;
			case 'history':
			case 'stats':
				this.renderHistoryStats(); break;
		}
	}

	private navigateTo(screen: Screen): void {
		this.screen = screen;
		this.render();
	}

	// ═══════════════════════════════════════════════════════════════════════════
	// HOME SCREEN — workout cards, tap to start
	// ═══════════════════════════════════════════════════════════════════════════

	private renderHome(): void {
		const container = this.contentEl;
		container.addClass('wt-home');

		// ── Top bar ──────────────────────────────────────────────────────────
		const topBar = container.createDiv({ cls: 'wt-home-topbar' });
		topBar.createEl('h3', { text: 'Workouts', cls: 'wt-home-title' });
		const topActions = topBar.createDiv({ cls: 'wt-home-actions' });

		const historyBtn = topActions.createEl('button', { cls: 'wt-btn wt-btn-sm' });
		setIcon(historyBtn, 'history');
		historyBtn.setAttribute('title', 'History & Stats');
		historyBtn.addEventListener('click', () => { this.historyTab = 'history'; this.navigateTo('history'); });

		const editBtn = topActions.createEl('button', { cls: 'wt-btn wt-btn-sm' });
		setIcon(editBtn, 'pencil');
		editBtn.setAttribute('title', 'Edit Workouts');
		editBtn.addEventListener('click', () => this.navigateTo('edit'));

		this.renderedDay = new Date().toDateString();
		const { workouts, plans } = this.plugin.data;

		if (workouts.length === 0 && plans.length === 0) {
			const emptyState = container.createDiv({ cls: 'wt-empty-state' });
			emptyState.createEl('div', { text: 'No workouts yet', cls: 'wt-empty-state-title' });
			emptyState.createEl('p', { text: 'Create your first workout template to get started.', cls: 'wt-empty-msg' });
			const createBtn = emptyState.createEl('button', { text: '+ Create Workout', cls: 'wt-btn wt-btn-primary' });
			createBtn.addEventListener('click', () => { void this.createWorkout(); });
			return;
		}

		this.renderToday(container);

		if (plans.length === 0) {
			// No plans: the original flat list
			const cardList = container.createDiv({ cls: 'wt-workout-cards' });
			workouts.forEach((workout, idx) => this.renderWorkoutCard(cardList, workout, idx));
		} else {
			const groups = container.createDiv({ cls: 'wt-plan-groups' });
			plans.forEach((plan) => this.renderPlanGroup(groups, plan));
			if (planWorkoutIndices(workouts, undefined).length > 0) this.renderPlanGroup(groups, null);
		}

		// ── New workout / plan buttons at bottom ─────────────────────────────
		const bottom = container.createDiv({ cls: 'wt-home-bottom-row' });
		bottom.createEl('button', { text: '+ New Workout', cls: 'wt-btn wt-home-add-btn' })
			.addEventListener('click', () => { void this.createWorkout(); });
		bottom.createEl('button', { text: '+ New Plan', cls: 'wt-btn wt-home-add-btn' })
			.addEventListener('click', () => this.promptNewPlan());
	}

	/** Add a blank workout (optionally inside a plan) and open it in the editor. */
	private async createWorkout(planId?: string): Promise<void> {
		const workouts = this.plugin.data.workouts;
		const workout: Workout = { name: `Workout ${workouts.length + 1}`, exercises: [], supersets: [] };
		if (planId) workout.planId = planId;
		workouts.push(workout);
		this.editWorkoutIndex = workouts.length - 1;
		await this.plugin.savePluginData();
		this.navigateTo('edit');
	}

	/** Ask for a name, create the plan (first plan becomes current), then call onCreated. */
	private promptNewPlan(onCreated?: (plan: Plan) => void | Promise<void>): void {
		const data = this.plugin.data;
		new RenameModal(this.app, `Plan ${data.plans.length + 1}`, async (name) => {
			const plan: Plan = { id: generateId(), name };
			data.plans.push(plan);
			if (!data.currentPlanId) data.currentPlanId = plan.id;
			if (onCreated) await onCreated(plan);
			await this.plugin.savePluginData();
			this.render();
		}, 'New Plan', 'Create').open();
	}

	// ── Today ────────────────────────────────────────────────────────────────

	private renderToday(container: HTMLElement): void {
		const { plans, workouts } = this.plugin.data;
		if (plans.length === 0) return;
		const now = new Date();
		const plan = this.plugin.getCurrentPlan();

		const section = container.createDiv({ cls: 'wt-today' });
		const header = section.createDiv({ cls: 'wt-today-header' });
		header.createSpan({ text: `Today · ${WEEKDAY_LONG[now.getDay()]}`, cls: 'wt-today-label' });
		if (plan) header.createSpan({ text: plan.name, cls: 'wt-today-plan' });

		if (!plan) {
			section.createDiv({ cls: 'wt-today-hint', text: 'Choose a current plan (⋯ on a plan below) to have today\'s workout ready here.' });
			return;
		}

		const todayIdx = workoutsOnDay(workouts, plan.id, now.getDay());
		if (todayIdx.length > 0) {
			const list = section.createDiv({ cls: 'wt-workout-cards wt-today-cards' });
			todayIdx.forEach((i) => this.renderWorkoutCard(list, workouts[i], i, true));
			return;
		}

		const rest = section.createDiv({ cls: 'wt-rest-card' });
		const next = this.plugin.describeNextWorkout(now);
		if (next) {
			rest.createDiv({ text: 'Rest day', cls: 'wt-rest-title' });
			rest.createDiv({ text: `Next up: ${next}`, cls: 'wt-rest-next' });
			const places = this.plugin.nextWorkoutLocations(now);
			if (places.length > 0) this.renderLocationLine(rest, 'wt-rest-location', places.join(' · '));
		} else {
			rest.createDiv({ text: 'No days scheduled yet', cls: 'wt-rest-title' });
			rest.createDiv({ text: `Edit a workout in ${plan.name} and pick its days.`, cls: 'wt-rest-next' });
		}
	}

	// ── Plan groups ──────────────────────────────────────────────────────────

	/** A foldable group of workouts. `plan === null` is the "No plan" group. */
	private renderPlanGroup(parent: HTMLElement, plan: Plan | null): void {
		const data = this.plugin.data;
		const indices = planWorkoutIndices(data.workouts, plan?.id);
		const collapsed = plan ? !!plan.collapsed : !!data.noPlanCollapsed;
		const isCurrent = !!plan && plan.id === data.currentPlanId;

		const group = parent.createDiv({ cls: 'wt-plan-group' });
		if (isCurrent) group.addClass('wt-plan-current');
		if (!plan) group.addClass('wt-plan-none');

		const header = group.createDiv({ cls: 'wt-plan-header' });
		header.setAttribute('role', 'button');
		header.setAttribute('tabindex', '0');
		header.setAttribute('aria-expanded', String(!collapsed));
		const toggle = async () => {
			if (plan) plan.collapsed = !collapsed; else data.noPlanCollapsed = !collapsed;
			await this.plugin.savePluginData();
			this.render();
		};
		header.addEventListener('click', () => { void toggle(); });
		header.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void toggle(); } });

		setIcon(header.createSpan({ cls: 'wt-plan-chevron' }), collapsed ? 'chevron-right' : 'chevron-down');
		const titleWrap = header.createDiv({ cls: 'wt-plan-title-wrap' });
		const titleLine = titleWrap.createDiv({ cls: 'wt-plan-title-line' });
		titleLine.createSpan({ text: plan ? plan.name : 'No plan', cls: 'wt-plan-name' });
		if (isCurrent) titleLine.createSpan({ text: 'Current', cls: 'wt-plan-badge' });

		const allDays = new Set<number>();
		for (const i of indices) for (const d of data.workouts[i].days ?? []) allDays.add(d);
		let sub = `${indices.length} workout${indices.length !== 1 ? 's' : ''}`;
		if (plan && allDays.size > 0) sub += ` · ${formatDays([...allDays])}`;
		titleWrap.createDiv({ text: sub, cls: 'wt-plan-sub' });

		if (plan) {
			const menuBtn = header.createEl('button', { cls: 'wt-btn-icon wt-plan-menu-btn' });
			menuBtn.setAttribute('aria-label', `${plan.name} options`);
			setIcon(menuBtn, 'more-horizontal');
			menuBtn.addEventListener('click', (e) => { e.stopPropagation(); this.openPlanMenu(plan, e); });
			menuBtn.addEventListener('keydown', (e) => e.stopPropagation());
		}

		if (collapsed) return;
		const list = group.createDiv({ cls: 'wt-workout-cards wt-plan-workouts' });
		if (indices.length === 0) {
			list.createDiv({ text: 'No workouts in this plan yet. Use ⋯ to add some.', cls: 'wt-plan-empty' });
			return;
		}
		indices.forEach((i) => this.renderWorkoutCard(list, data.workouts[i], i));
	}

	private openPlanMenu(plan: Plan, evt: MouseEvent): void {
		const data = this.plugin.data;
		const save = async () => { await this.plugin.savePluginData(); this.render(); };
		const planIdx = data.plans.indexOf(plan);
		const count = data.workouts.filter((w) => w.planId === plan.id).length;
		const menu = new Menu();

		if (plan.id === data.currentPlanId) {
			menu.addItem((item) => item.setTitle('Stop using as current plan').setIcon('star-off')
				.onClick(() => { delete data.currentPlanId; void save(); }));
		} else {
			menu.addItem((item) => item.setTitle('Set as current plan').setIcon('star')
				.onClick(() => { data.currentPlanId = plan.id; void save(); }));
		}
		menu.addSeparator();
		menu.addItem((item) => item.setTitle('New workout in this plan').setIcon('plus')
			.onClick(() => { plan.collapsed = false; void this.createWorkout(plan.id); }));
		menu.addItem((item) => item.setTitle('Add existing workouts…').setIcon('list-plus')
			.onClick(() => new PlanWorkoutsModal(this.app, this.plugin, plan, () => this.render()).open()));
		menu.addItem((item) => item.setTitle('Rename plan').setIcon('pencil')
			.onClick(() => new RenameModal(this.app, plan.name, (name) => { plan.name = name; void save(); }, 'Rename Plan').open()));
		if (planIdx > 0) {
			menu.addItem((item) => item.setTitle('Move up').setIcon('arrow-up').onClick(() => {
				[data.plans[planIdx - 1], data.plans[planIdx]] = [data.plans[planIdx], data.plans[planIdx - 1]]; void save();
			}));
		}
		if (planIdx < data.plans.length - 1) {
			menu.addItem((item) => item.setTitle('Move down').setIcon('arrow-down').onClick(() => {
				[data.plans[planIdx], data.plans[planIdx + 1]] = [data.plans[planIdx + 1], data.plans[planIdx]]; void save();
			}));
		}
		menu.addSeparator();
		menu.addItem((item) => item.setTitle('Delete plan').setIcon('trash').setWarning(true).onClick(() => {
			const what = count > 0 ? ` Its ${count} workout${count !== 1 ? 's' : ''} move to "No plan"; nothing else is deleted.` : '';
			new ConfirmModal(this.app, `Delete plan "${plan.name}"?${what}`, () => {
				for (const w of data.workouts) if (w.planId === plan.id) delete w.planId;
				data.plans.splice(data.plans.indexOf(plan), 1);
				if (data.currentPlanId === plan.id) delete data.currentPlanId;
				void save();
			}).open();
		}));
		menu.showAtMouseEvent(evt);
	}

	// ── Workout card ─────────────────────────────────────────────────────────

	/** Workout card; tap to preview. `pinned` (Today) is always open with Start ready. */
	private renderWorkoutCard(parent: HTMLElement, workout: Workout, idx: number, pinned = false): void {
		const isExpanded = pinned || this.expandedWorkoutIndex === idx;
		const card = parent.createDiv({ cls: 'wt-workout-card' });
		if (isExpanded) card.addClass('wt-workout-card-expanded');
		if (pinned) card.addClass('wt-today-card');

		const cardBody = card.createDiv({ cls: 'wt-workout-card-body' });
		if (!pinned) {
			cardBody.addEventListener('click', () => {
				this.expandedWorkoutIndex = isExpanded ? -1 : idx;
				this.render();
			});
		}

		cardBody.createEl('div', { text: workout.name, cls: 'wt-workout-card-name' });
		if (workout.location) this.renderLocationLine(cardBody, 'wt-workout-card-location', workout.location);

		const meta = cardBody.createDiv({ cls: 'wt-workout-card-meta' });
		const exCount = workout.exercises.length;
		const setCount = workout.exercises.reduce((s, e) => s + e.sets.length, 0);
		meta.createEl('span', { text: `${exCount} exercise${exCount !== 1 ? 's' : ''} · ${setCount} sets` });
		if (workout.lastUpdatedDurationSeconds && workout.lastUpdatedDurationSeconds > 0) {
			meta.createEl('span', { text: ` · ~${formatDurationShort(workout.lastUpdatedDurationSeconds)}`, cls: 'wt-workout-card-duration' });
		}
		if (!pinned && workout.planId && workout.days?.length) {
			meta.createEl('span', { text: formatDays(workout.days), cls: 'wt-workout-card-days' });
		}

		// Days since last completed
		const lastDate = this.plugin.getLastCompletedDate(workout.name);
		const lastRow = cardBody.createDiv({ cls: 'wt-workout-card-last' });
		if (lastDate) {
			const days = daysBetween(lastDate);
			if (days === 0) lastRow.setText('Last done: today');
			else if (days === 1) lastRow.setText('Last done: yesterday');
			else lastRow.setText(`Last done: ${days} days ago`);
		} else {
			lastRow.setText('Never completed');
			lastRow.addClass('wt-muted');
		}

		if (!pinned) {
			const arrow = cardBody.createDiv({ cls: 'wt-workout-card-arrow' });
			setIcon(arrow, isExpanded ? 'chevron-down' : 'play');
		}

		if (!isExpanded) return;
		const preview = card.createDiv({ cls: 'wt-workout-preview' });
		const unit = this.plugin.data.settings.weightUnit;
		if (workout.exercises.length === 0) {
			preview.createEl('p', { text: 'No exercises yet. Edit this workout to add some.', cls: 'wt-muted' });
		} else {
			workout.exercises.forEach((ex) => {
				const exRow = preview.createDiv({ cls: 'wt-preview-exercise' });
				exRow.createEl('span', { text: ex.name, cls: 'wt-preview-exercise-name' });
				const setInfo = ex.sets.length > 0
					? `${ex.sets.length} × ${ex.sets[0].reps} reps${ex.sets[0].weight > 0 ? ` @ ${ex.sets[0].weight} ${unit}` : ''}`
					: `${ex.sets.length} sets`;
				exRow.createEl('span', { text: setInfo, cls: 'wt-preview-exercise-meta' });
				if (ex.modifier) exRow.createEl('span', { text: ex.modifier, cls: 'wt-preview-modifier' });
			});
		}

		const startBtn = preview.createEl('button', { text: 'Start Workout', cls: 'wt-btn wt-btn-start wt-preview-start-btn' });
		startBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.plugin.beginWorkout(workout);
			if (this.plugin.activeState) this.navigateTo('active');
		});
	}

	/** Map-pin icon + location text (plain, not a link). */
	private renderLocationLine(parent: HTMLElement, cls: string, text: string): void {
		const line = parent.createDiv({ cls });
		const icon = line.createSpan({ cls: 'wt-location-icon' });
		icon.setAttribute('aria-hidden', 'true');
		setIcon(icon, 'map-pin');
		line.createSpan({ text, cls: 'wt-location-text', attr: { title: text } });
	}

	// ═══════════════════════════════════════════════════════════════════════════
	// EDIT MODE
	// ═══════════════════════════════════════════════════════════════════════════

	private renderEditMode(): void {
		const container = this.contentEl;
		container.addClass('wt-edit-mode');

		// ── Back button ──────────────────────────────────────────────────────
		const topBar = container.createDiv({ cls: 'wt-topbar' });
		const backBtn = topBar.createEl('button', { cls: 'wt-btn wt-btn-sm wt-back-btn' });
		setIcon(backBtn, 'arrow-left');
		backBtn.createEl('span', { text: ' Back' });
		backBtn.addEventListener('click', () => this.navigateTo('home'));
		topBar.createEl('span', { text: 'Edit Workouts', cls: 'wt-topbar-title' });

		const workouts = this.plugin.data.workouts;

		// ── Exercise name datalist ───────────────────────────────────────────
		const datalist = container.createEl('datalist');
		datalist.id = this.datalistId;
		for (const name of this.plugin.getAllExerciseNames()) datalist.createEl('option', { value: name });

		// ── Workout selector ─────────────────────────────────────────────────
		const selectorRow = container.createDiv({ cls: 'wt-selector-row' });
		const select = selectorRow.createEl('select', { cls: 'wt-workout-select' });
		if (workouts.length === 0) {
			select.createEl('option', { text: '— No workouts —', value: '-1' });
			this.editWorkoutIndex = -1;
		} else {
			if (this.editWorkoutIndex >= workouts.length) this.editWorkoutIndex = workouts.length - 1;
			if (this.editWorkoutIndex < 0) this.editWorkoutIndex = 0;
			const addOption = (parent: HTMLElement, i: number) => {
				const w = workouts[i];
				let label = w.name;
				if (w.planId && w.days?.length) label += ` · ${formatDays(w.days)}`;
				if (w.lastUpdatedDurationSeconds != null && w.lastUpdatedDurationSeconds > 0)
					label += ` (${formatDurationShort(w.lastUpdatedDurationSeconds)})`;
				const opt = parent.createEl('option', { text: label, value: String(i) });
				if (i === this.editWorkoutIndex) opt.selected = true;
			};
			const plans = this.plugin.data.plans;
			if (plans.length === 0) {
				workouts.forEach((_, i) => addOption(select, i));
			} else {
				// Grouped by plan so the list stays scannable
				for (const plan of plans) {
					const indices = planWorkoutIndices(workouts, plan.id);
					if (indices.length === 0) continue;
					const group = select.createEl('optgroup');
					group.label = plan.name;
					indices.forEach((i) => addOption(group, i));
				}
				const loose = planWorkoutIndices(workouts, undefined);
				if (loose.length > 0) {
					const group = select.createEl('optgroup');
					group.label = 'No plan';
					loose.forEach((i) => addOption(group, i));
				}
			}
		}
		select.addEventListener('change', () => { this.editWorkoutIndex = parseInt(select.value); this.render(); });

		// ── Buttons row ──────────────────────────────────────────────────────
		const btnRow = container.createDiv({ cls: 'wt-btn-row' });
		const newBtn = btnRow.createEl('button', { text: '+ New', cls: 'wt-btn wt-btn-sm' });
		newBtn.addEventListener('click', async () => {
			workouts.push({ name: `Workout ${workouts.length + 1}`, exercises: [], supersets: [] });
			this.editWorkoutIndex = workouts.length - 1;
			await this.plugin.savePluginData(); this.render();
		});

		if (workouts.length > 0) {
			const dupBtn = btnRow.createEl('button', { text: 'Duplicate', cls: 'wt-btn wt-btn-sm' });
			dupBtn.addEventListener('click', async () => {
				const source = workouts[this.editWorkoutIndex];
				const clone: Workout = JSON.parse(JSON.stringify(source));
				clone.name = source.name + ' (Copy)';
				delete clone.lastUpdatedDurationSeconds;
				delete clone.days; // same plan, but don't double-book its days
				const idMap = new Map<string, string>();
				for (const ss of clone.supersets) { const newId = generateId(); idMap.set(ss.id, newId); ss.id = newId; }
				for (const ex of clone.exercises) { if (ex.supersetGroupId && idMap.has(ex.supersetGroupId)) ex.supersetGroupId = idMap.get(ex.supersetGroupId); }
				workouts.push(clone);
				this.editWorkoutIndex = workouts.length - 1;
				await this.plugin.savePluginData(); this.render();
			});

			const renameBtn = btnRow.createEl('button', { text: 'Rename', cls: 'wt-btn wt-btn-sm' });
			renameBtn.addEventListener('click', () => {
				const w = workouts[this.editWorkoutIndex];
				new RenameModal(this.app, w.name, async (newName) => {
					w.name = newName; await this.plugin.savePluginData(); this.render();
				}).open();
			});

			const deleteBtn = btnRow.createEl('button', { text: 'Delete', cls: 'wt-btn wt-btn-danger wt-btn-sm' });
			deleteBtn.addEventListener('click', () => {
				new ConfirmModal(this.app, `Delete "${workouts[this.editWorkoutIndex].name}"?`, async () => {
					workouts.splice(this.editWorkoutIndex, 1);
					this.editWorkoutIndex = Math.max(0, this.editWorkoutIndex - 1);
					await this.plugin.savePluginData(); this.render();
				}).open();
			});
		}

		if (workouts.length === 0 || this.editWorkoutIndex < 0) return;
		const workout = workouts[this.editWorkoutIndex];
		if (!workout.supersets) workout.supersets = [];

		const editorSection = container.createDiv({ cls: 'wt-editor' });

		// Workout name
		const nameInput = editorSection.createEl('input', {
			cls: 'wt-workout-name-input', type: 'text', value: workout.name, placeholder: 'Workout name',
		});
		nameInput.addEventListener('change', async () => {
			workout.name = nameInput.value || 'Untitled';
			await this.plugin.savePluginData(); this.render();
		});

		this.renderLocation(editorSection, workout);
		this.renderPlanAndDays(editorSection, workout);

		// ── Render exercises ─────────────────────────────────────────────────
		const renderedGroups = new Set<string>();
		const unit = this.plugin.data.settings.weightUnit;

		workout.exercises.forEach((exercise, exIdx) => {
			if (exercise.supersetGroupId) {
				if (renderedGroups.has(exercise.supersetGroupId)) return;
				renderedGroups.add(exercise.supersetGroupId);
				this.renderSupersetGroup(editorSection, workout, exercise.supersetGroupId, unit);
				return;
			}
			this.renderExerciseCard(editorSection, workout, exercise, exIdx, unit);
		});

		const addExBtn = editorSection.createEl('button', { text: '+ Add Exercise', cls: 'wt-btn wt-add-exercise-btn' });
		addExBtn.addEventListener('click', async () => {
			workout.exercises.push({
				name: `Exercise ${workout.exercises.length + 1}`, modifier: '',
				sets: [{ reps: 10, weight: 0, restSeconds: this.plugin.data.settings.defaultRestSeconds }],
			});
			await this.plugin.savePluginData(); this.render();
		});

		const standaloneExercises = workout.exercises.filter((e) => !e.supersetGroupId);
		if (standaloneExercises.length >= 2) {
			const addSsBtn = editorSection.createEl('button', { text: '+ Add Superset', cls: 'wt-btn wt-btn-ss' });
			addSsBtn.addEventListener('click', () => {
				new SupersetModal(this.app, workout.exercises, async (indices) => {
					const ssId = generateId();
					indices.forEach((i) => { workout.exercises[i].supersetGroupId = ssId; });
					workout.supersets.push({ id: ssId, restSeconds: this.plugin.data.settings.defaultRestSeconds });
					await this.plugin.savePluginData(); this.render();
				}).open();
			});
		}

		// ── Bottom actions ───────────────────────────────────────────────────
		const bottomRow = editorSection.createDiv({ cls: 'wt-bottom-row' });
		const saveBtn = bottomRow.createEl('button', { text: 'Save', cls: 'wt-btn wt-btn-primary' });
		saveBtn.addEventListener('click', async () => {
			await this.plugin.savePluginData(); new Notice(`Workout "${workout.name}" saved.`);
		});
		const startBtn = bottomRow.createEl('button', { text: '▶ Start Workout', cls: 'wt-btn wt-btn-start' });
		startBtn.addEventListener('click', async () => {
			await this.plugin.savePluginData();
			this.plugin.beginWorkout(workout);
			if (this.plugin.activeState) this.navigateTo('active');
		});
	}

	/** Plan picker + weekday toggles for the workout being edited. */
	private renderPlanAndDays(parent: HTMLElement, workout: Workout): void {
		const data = this.plugin.data;
		const NEW_PLAN = '__new__';

		const planRow = parent.createDiv({ cls: 'wt-plan-row' });
		planRow.createEl('label', { text: 'Plan', cls: 'wt-plan-row-label' });
		const planSelect = planRow.createEl('select', { cls: 'wt-workout-select wt-plan-select' });
		planSelect.createEl('option', { text: 'No plan', value: '' });
		for (const plan of data.plans) {
			const label = plan.id === data.currentPlanId ? `${plan.name} (current)` : plan.name;
			planSelect.createEl('option', { text: label, value: plan.id });
		}
		planSelect.createEl('option', { text: '+ New plan…', value: NEW_PLAN });
		planSelect.value = workout.planId ?? '';
		planSelect.addEventListener('change', async () => {
			const value = planSelect.value;
			if (value === NEW_PLAN) {
				planSelect.value = workout.planId ?? '';
				this.promptNewPlan((plan) => { workout.planId = plan.id; });
				return;
			}
			if (value) workout.planId = value; else delete workout.planId;
			await this.plugin.savePluginData(); this.render();
		});

		if (!workout.planId) return;
		const dayRow = parent.createDiv({ cls: 'wt-day-row' });
		dayRow.createEl('label', { text: 'Days', cls: 'wt-plan-row-label' });
		const toggles = dayRow.createDiv({ cls: 'wt-day-toggles' });
		for (const day of WEEK_ORDER) {
			const on = !!workout.days?.includes(day);
			const btn = toggles.createEl('button', { text: WEEKDAY_SHORT[day], cls: 'wt-day-toggle' });
			btn.toggleClass('is-active', on);
			btn.setAttribute('aria-pressed', String(on));
			btn.setAttribute('aria-label', WEEKDAY_LONG[day]);
			// Update in place (no full re-render) so the editor doesn't jump
			btn.addEventListener('click', async () => {
				const days = new Set(workout.days ?? []);
				if (days.has(day)) days.delete(day); else days.add(day);
				if (days.size) workout.days = [...days].sort((a, b) => weekRank(a) - weekRank(b)); else delete workout.days;
				const nowOn = days.has(day);
				btn.toggleClass('is-active', nowOn);
				btn.setAttribute('aria-pressed', String(nowOn));
				await this.plugin.savePluginData();
			});
		}
	}

	/** Free-text location; suggests places other workouts already use. */
	private renderLocation(parent: HTMLElement, workout: Workout): void {
		const inputId = 'wt-location-' + generateId();
		const row = parent.createDiv({ cls: 'wt-plan-row wt-location-row' });
		row.createEl('label', { text: 'Location', cls: 'wt-plan-row-label', attr: { for: inputId } });
		const input = row.createEl('input', {
			cls: 'wt-location-input', type: 'text', value: workout.location ?? '', placeholder: 'e.g. Home gym',
		});
		input.id = inputId;

		const others = distinctLocations(this.plugin.data.workouts.filter((w) => w !== workout).map((w) => w.location));
		if (others.length > 0) {
			const list = row.createEl('datalist');
			list.id = inputId + '-list';
			for (const loc of others) list.createEl('option', { value: loc });
			input.setAttribute('list', list.id);
		}

		// Update in place (no full re-render) so the editor doesn't jump
		input.addEventListener('change', async () => {
			const location = input.value.trim();
			input.value = location;
			if (location) workout.location = location; else delete workout.location;
			await this.plugin.savePluginData();
		});
	}

	/** Render a single exercise card with drag support */
	private renderExerciseCard(parent: HTMLElement, workout: Workout, exercise: Exercise, exIdx: number, unit: string): void {
		const exCard = parent.createDiv({ cls: 'wt-exercise-card' });
		exCard.setAttribute('data-ex-idx', String(exIdx));

		if (!exercise.supersetGroupId) {
			exCard.draggable = true;
			exCard.addEventListener('dragstart', (e) => {
				this.dragSourceIndex = exIdx; exCard.addClass('wt-dragging');
				e.dataTransfer?.setData('text/plain', String(exIdx));
			});
			exCard.addEventListener('dragend', () => {
				exCard.removeClass('wt-dragging'); this.dragSourceIndex = -1;
				parent.querySelectorAll('.wt-drop-above, .wt-drop-below').forEach((el) => { el.removeClass('wt-drop-above'); el.removeClass('wt-drop-below'); });
			});
			exCard.addEventListener('dragover', (e) => {
				e.preventDefault(); if (this.dragSourceIndex === exIdx) return;
				const rect = exCard.getBoundingClientRect();
				exCard.removeClass('wt-drop-above'); exCard.removeClass('wt-drop-below');
				if (e.clientY < rect.top + rect.height / 2) exCard.addClass('wt-drop-above'); else exCard.addClass('wt-drop-below');
			});
			exCard.addEventListener('dragleave', () => { exCard.removeClass('wt-drop-above'); exCard.removeClass('wt-drop-below'); });
			exCard.addEventListener('drop', async (e) => {
				e.preventDefault(); exCard.removeClass('wt-drop-above'); exCard.removeClass('wt-drop-below');
				if (this.dragSourceIndex < 0 || this.dragSourceIndex === exIdx) return;
				const srcEx = workout.exercises[this.dragSourceIndex];
				if (srcEx.supersetGroupId) return;
				const dropAbove = e.clientY < exCard.getBoundingClientRect().top + exCard.getBoundingClientRect().height / 2;
				const [moved] = workout.exercises.splice(this.dragSourceIndex, 1);
				let targetIdx = workout.exercises.indexOf(exercise);
				if (!dropAbove) targetIdx++;
				workout.exercises.splice(targetIdx, 0, moved);
				this.dragSourceIndex = -1;
				await this.plugin.savePluginData(); this.render();
			});
		}

		const exHeader = exCard.createDiv({ cls: 'wt-exercise-header' });

		if (!exercise.supersetGroupId) {
			exHeader.createEl('span', { cls: 'wt-drag-handle', text: '⠿' }).setAttribute('title', 'Drag to reorder');
			if (exIdx > 0) {
				const upBtn = exHeader.createEl('button', { cls: 'wt-btn-icon wt-move-btn' });
				setIcon(upBtn, 'chevron-up');
				upBtn.addEventListener('click', async (e) => {
					e.stopPropagation();
					let prevIdx = exIdx - 1;
					while (prevIdx >= 0 && workout.exercises[prevIdx].supersetGroupId) prevIdx--;
					if (prevIdx >= 0) {
						[workout.exercises[prevIdx], workout.exercises[exIdx]] = [workout.exercises[exIdx], workout.exercises[prevIdx]];
						await this.plugin.savePluginData(); this.render();
					}
				});
			}
			if (exIdx < workout.exercises.length - 1) {
				const downBtn = exHeader.createEl('button', { cls: 'wt-btn-icon wt-move-btn' });
				setIcon(downBtn, 'chevron-down');
				downBtn.addEventListener('click', async (e) => {
					e.stopPropagation();
					let nextIdx = exIdx + 1;
					while (nextIdx < workout.exercises.length && workout.exercises[nextIdx].supersetGroupId) nextIdx++;
					if (nextIdx < workout.exercises.length) {
						[workout.exercises[exIdx], workout.exercises[nextIdx]] = [workout.exercises[nextIdx], workout.exercises[exIdx]];
						await this.plugin.savePluginData(); this.render();
					}
				});
			}
		}

		const exNameInput = exHeader.createEl('input', { type: 'text', value: exercise.name, placeholder: 'Exercise name', cls: 'wt-exercise-name-input' });
		exNameInput.setAttribute('list', this.datalistId);
		exNameInput.addEventListener('change', async () => { exercise.name = exNameInput.value || 'Untitled Exercise'; await this.plugin.savePluginData(); });

		const removeExBtn = exHeader.createEl('button', { text: 'Remove', cls: 'wt-btn wt-btn-danger wt-btn-sm' });
		removeExBtn.addEventListener('click', async () => { workout.exercises.splice(exIdx, 1); await this.plugin.savePluginData(); this.render(); });

		const modRow = exCard.createDiv({ cls: 'wt-modifier-row' });
		modRow.createEl('label', { text: 'Modifier:', cls: 'wt-modifier-label' });
		const modInput = modRow.createEl('input', { type: 'text', value: exercise.modifier || '', placeholder: 'e.g. pause rep, explosive, slow', cls: 'wt-modifier-input' });
		modInput.addEventListener('change', async () => { exercise.modifier = modInput.value.trim(); await this.plugin.savePluginData(); });

		this.renderSetsTable(exCard, workout, exercise, unit);
	}

	private renderSetsTable(exCard: HTMLElement, workout: Workout, exercise: Exercise, unit: string): void {
		if (exercise.sets.length > 0) {
			const table = exCard.createEl('table', { cls: 'wt-sets-table' });
			const thead = table.createEl('thead');
			const headerRow = thead.createEl('tr');
			headerRow.createEl('th', { text: '#' }); headerRow.createEl('th', { text: 'Reps' });
			headerRow.createEl('th', { text: `Wt (${unit})` }); headerRow.createEl('th', { text: 'Rest' }); headerRow.createEl('th', { text: '' });
			const tbody = table.createEl('tbody');
			exercise.sets.forEach((set, setIdx) => {
				const row = tbody.createEl('tr');
				row.createEl('td', { text: String(setIdx + 1) });
				const key = lastUsedKey(workout.name, exercise.name, setIdx);
				const last = this.plugin.data.lastUsed[key];
				const repsInput = row.createEl('td').createEl('input', { type: 'number', cls: 'wt-set-input', value: String(last?.reps ?? set.reps) });
				repsInput.addEventListener('change', () => {
					set.reps = parseInt(repsInput.value) || 0;
					this.plugin.data.lastUsed[key] = { reps: set.reps, weight: this.plugin.data.lastUsed[key]?.weight ?? set.weight };
				});
				const weightInput = row.createEl('td').createEl('input', { type: 'number', cls: 'wt-set-input', value: String(last?.weight ?? set.weight) });
				weightInput.addEventListener('change', () => {
					set.weight = parseFloat(weightInput.value) || 0;
					this.plugin.data.lastUsed[key] = { reps: this.plugin.data.lastUsed[key]?.reps ?? set.reps, weight: set.weight };
				});
				const restInput = row.createEl('td').createEl('input', { type: 'number', cls: 'wt-set-input', value: String(set.restSeconds) });
				restInput.addEventListener('change', () => { set.restSeconds = parseInt(restInput.value) || 0; });
				const removeSetBtn = row.createEl('td').createEl('button', { text: '✕', cls: 'wt-btn-icon' });
				removeSetBtn.addEventListener('click', async () => { exercise.sets.splice(setIdx, 1); await this.plugin.savePluginData(); this.render(); });
			});
		}
		const addSetBtn = exCard.createEl('button', { text: '+ Add Set', cls: 'wt-btn wt-btn-sm' });
		addSetBtn.addEventListener('click', async () => {
			const lastSet = exercise.sets.length > 0 ? exercise.sets[exercise.sets.length - 1] : null;
			exercise.sets.push({ reps: lastSet?.reps ?? 10, weight: lastSet?.weight ?? 0, restSeconds: lastSet?.restSeconds ?? this.plugin.data.settings.defaultRestSeconds });
			await this.plugin.savePluginData(); this.render();
		});
	}

	private renderSupersetGroup(parent: HTMLElement, workout: Workout, groupId: string, unit: string): void {
		const ssConfig = workout.supersets.find((s) => s.id === groupId);
		const groupExercises: { exercise: Exercise; index: number }[] = [];
		workout.exercises.forEach((ex, i) => { if (ex.supersetGroupId === groupId) groupExercises.push({ exercise: ex, index: i }); });
		const ssBox = parent.createDiv({ cls: 'wt-superset-box' });
		const ssHeader = ssBox.createDiv({ cls: 'wt-ss-header' });
		ssHeader.createEl('span', { text: 'SUPERSET', cls: 'wt-ss-label' });
		const restRow = ssHeader.createDiv({ cls: 'wt-ss-rest-row' });
		restRow.createEl('label', { text: 'Rest (s):' });
		const restInput = restRow.createEl('input', { type: 'number', cls: 'wt-set-input', value: String(ssConfig?.restSeconds ?? 0) });
		restInput.addEventListener('change', async () => { if (ssConfig) ssConfig.restSeconds = parseInt(restInput.value) || 0; await this.plugin.savePluginData(); });
		const removeSsBtn = ssHeader.createEl('button', { text: 'Ungroup', cls: 'wt-btn wt-btn-danger wt-btn-sm' });
		removeSsBtn.addEventListener('click', async () => {
			groupExercises.forEach((ge) => { delete ge.exercise.supersetGroupId; });
			const ssIdx = workout.supersets.findIndex((s) => s.id === groupId);
			if (ssIdx >= 0) workout.supersets.splice(ssIdx, 1);
			await this.plugin.savePluginData(); this.render();
		});
		groupExercises.forEach((ge) => { this.renderExerciseCard(ssBox, workout, ge.exercise, ge.index, unit); });
	}

	// ═══════════════════════════════════════════════════════════════════════════
	// ACTIVE MODE
	// ═══════════════════════════════════════════════════════════════════════════

	private renderActiveMode(): void {
		const state = this.plugin.activeState;
		if (!state) { this.navigateTo('home'); return; }

		const container = this.contentEl;
		container.addClass('wt-active-mode');
		const workout = state.workout;
		const total = state.steps.length;

		const header = container.createDiv({ cls: 'wt-active-header' });
		header.createEl('span', { text: workout.name, cls: 'wt-active-title' });
		header.createEl('span', { text: `Time spent: ${formatTime(workoutElapsedSeconds(state))}`, cls: 'wt-total-time' });
		const endBtn = header.createEl('button', { text: 'End', cls: 'wt-btn wt-btn-danger wt-btn-sm' });
		endBtn.addEventListener('click', () => this.openEndDialog());

		const done = state.stepHistory.length;
		const progressContainer = container.createDiv({ cls: 'wt-progress-container' });
		const progressBar = progressContainer.createDiv({ cls: 'wt-progress-bar' });
		progressBar.style.width = `${total > 0 ? (done / total) * 100 : 0}%`;
		progressContainer.createEl('span', { text: `${done} / ${total} sets`, cls: 'wt-progress-label' });

		const panel = container.createDiv({ cls: 'wt-current-panel' });
		const step = state.steps[state.currentStepIndex];
		const currentEx = step ? workout.exercises[step.exerciseIndex] : null;
		const currentSet = currentEx && step ? currentEx.sets[step.setIndex] : null;

		if (state.isPaused) {
			// ── Paused state ──────────────────────────────────────────────
			panel.addClass('wt-paused-panel');
			panel.createEl('div', { text: 'PAUSED', cls: 'wt-paused-label' });
			if (currentEx) {
				panel.createEl('div', { text: `${currentEx.name} — Set ${step.setIndex + 1}`, cls: 'wt-set-title wt-muted' });
			}
			const resumeBtn = panel.createEl('button', { text: 'Resume', cls: 'wt-btn wt-btn-complete' });
			resumeBtn.addEventListener('click', () => this.resumeWorkout());
		} else if (state.isResting) {
			panel.addClass('wt-rest-panel');
			if (state.restRemaining < 0) panel.addClass('wt-rest-overtime');
			panel.createEl('div', { text: 'Rest', cls: 'wt-rest-label' });
			const restTimerEl = panel.createEl('div', { cls: 'wt-big-timer' });
			restTimerEl.setText(formatTime(state.restRemaining));
			if (state.restRemaining < 0) restTimerEl.addClass('wt-timer-overtime');
			const nextSetBtn = panel.createEl('button', { text: 'Start Next Set', cls: 'wt-btn wt-btn-complete' });
			nextSetBtn.addEventListener('click', () => this.advanceFromRest());
			// Controls during rest
			const restControls = panel.createDiv({ cls: 'wt-controls-row' });
			const pauseBtn = restControls.createEl('button', { text: 'Pause', cls: 'wt-btn wt-btn-sm' });
			setIcon(pauseBtn, 'pause');
			pauseBtn.addEventListener('click', () => this.pauseWorkout());
			if (state.stepHistory.length > 0) {
				const backBtn = restControls.createEl('button', { text: 'Back', cls: 'wt-btn wt-btn-sm' });
				setIcon(backBtn, 'undo');
				backBtn.addEventListener('click', () => this.goBackToLastSet());
			}
		} else if (nextOpenStep(state, state.currentStepIndex) === -1) {
			// Every set is logged but the session is still open (e.g. saving failed): only offer to end.
			panel.addClass('wt-set-panel');
			panel.createEl('div', { text: 'All sets logged', cls: 'wt-set-title' });
			const saveBtn = panel.createEl('button', { text: 'End workout', cls: 'wt-btn wt-btn-complete' });
			saveBtn.addEventListener('click', () => this.openEndDialog());
		} else if (currentEx && currentSet) {
			panel.addClass('wt-set-panel');
			if (currentEx.supersetGroupId) panel.createEl('div', { text: 'SUPERSET', cls: 'wt-ss-active-label' });
			panel.createEl('div', { text: `${currentEx.name} — Set ${step.setIndex + 1} of ${currentEx.sets.length}`, cls: 'wt-set-title' });
			if (currentEx.modifier) panel.createEl('div', { text: currentEx.modifier, cls: 'wt-modifier' });

			const unit = this.plugin.data.settings.weightUnit;
			const repsRow = panel.createDiv({ cls: 'wt-input-row' });
			repsRow.createEl('label', { text: 'Reps:' });
			const repsInput = repsRow.createEl('input', { type: 'number', value: String(state.currentReps), cls: 'wt-active-input' });
			repsInput.addEventListener('change', () => { state.currentReps = parseInt(repsInput.value) || 0; });

			const weightRow = panel.createDiv({ cls: 'wt-input-row' });
			weightRow.createEl('label', { text: `Weight (${unit}):` });
			const weightInput = weightRow.createEl('input', { type: 'number', value: String(state.currentWeight), cls: 'wt-active-input' });
			weightInput.addEventListener('change', () => { state.currentWeight = parseFloat(weightInput.value) || 0; });

			const setElapsedEl = panel.createDiv({ cls: 'wt-set-elapsed' });
			const setElapsedValue = setElapsedEl.createEl('span', { cls: 'wt-timer-value', text: formatTime(state.setElapsed) });
			setElapsedValue.dataset.role = 'setElapsed';

			const completeBtn = panel.createEl('button', { text: state.setStarted ? '✓ Complete Set' : 'Start Set', cls: 'wt-btn wt-btn-complete' });
			completeBtn.addEventListener('click', () => state.setStarted ? this.completeCurrentSet() : this.startCurrentSet());

			// Controls row: Skip, Pause, Back
			const controls = panel.createDiv({ cls: 'wt-controls-row' });
			const skipBtn = controls.createEl('button', { text: ' Skip', cls: 'wt-btn wt-btn-sm' });
			setIcon(skipBtn, 'skip-forward');
			skipBtn.addEventListener('click', () => this.skipCurrentSet());
			const pauseBtn = controls.createEl('button', { text: ' Pause', cls: 'wt-btn wt-btn-sm' });
			setIcon(pauseBtn, 'pause');
			pauseBtn.addEventListener('click', () => this.pauseWorkout());
			if (state.stepHistory.length > 0) {
				const backBtn = controls.createEl('button', { text: ' Back', cls: 'wt-btn wt-btn-sm' });
				setIcon(backBtn, 'undo');
				backBtn.addEventListener('click', () => this.goBackToLastSet());
			}
		}

		// Immediate next set
		const nextInfo = this.getNextSetInfo(state);
		if (nextInfo) {
			const nextCard = container.createDiv({ cls: 'wt-next-card' });
			nextCard.createEl('span', { text: 'Next: ', cls: 'wt-next-label' });
			nextCard.createEl('span', { text: nextInfo });
		}

		this.renderWorkoutPlan(container, state);
		this.renderPreviousSets(container, state);
		this.startActiveTimer();
	}

	/** The whole workout in plan order. Done sets fade green; tap a set or an exercise to go there. */
	private renderWorkoutPlan(container: HTMLElement, state: ActiveWorkoutState): void {
		const { workout, steps } = state;
		const done = new Set(state.stepHistory.map((h) => h.stepIndex));
		const running = state.setStarted && !state.isResting;
		const locked = state.isPaused || running;
		const current = state.isResting ? -1 : state.currentStepIndex;
		const upNext = this.getUpNextStep(state);
		const justDone = this.justCompletedStep;
		this.justCompletedStep = -1;
		const unit = this.plugin.data.settings.weightUnit;

		// Step indices per exercise; Map keeps first-appearance (= plan) order
		const byExercise = new Map<number, number[]>();
		steps.forEach((s, i) => {
			const list = byExercise.get(s.exerciseIndex);
			if (list) list.push(i); else byExercise.set(s.exerciseIndex, [i]);
		});

		const section = container.createDiv({ cls: 'wt-workout-plan' });
		const head = section.createDiv({ cls: 'wt-workout-plan-head' });
		head.createSpan({ text: 'Workout plan', cls: 'wt-workout-plan-title' });
		const left = steps.length - done.size;
		head.createSpan({ text: left === 0 ? 'All done' : `${left} set${left !== 1 ? 's' : ''} left`, cls: 'wt-workout-plan-count' });
		const hint = state.isPaused ? 'Resume to move around the workout.'
			: running ? 'Finish or skip this set to jump somewhere else.'
			: state.isResting ? 'Tap any set to do it next.'
			: 'Tap any set to jump to it.';
		section.createDiv({ text: hint, cls: 'wt-workout-plan-hint' });

		let prevGroup: string | undefined;
		for (const [exIdx, idxs] of byExercise) {
			const ex = workout.exercises[exIdx];
			if (ex.supersetGroupId && ex.supersetGroupId !== prevGroup) section.createDiv({ text: 'Superset', cls: 'wt-workout-plan-ss' });
			prevGroup = ex.supersetGroupId;

			const doneCount = idxs.filter((i) => done.has(i)).length;
			const exDone = doneCount === idxs.length;
			const firstOpen = idxs.find((i) => !done.has(i)) ?? -1;

			const item = section.createDiv({ cls: 'wt-workout-plan-item' });
			if (ex.supersetGroupId) item.addClass('is-superset');
			if (exDone) item.addClass('is-done');
			else if (doneCount > 0) item.addClass('is-partial');
			if (idxs.includes(current)) item.addClass('is-current');
			else if (upNext !== -1 && idxs.includes(upNext)) item.addClass('is-next');
			if (exDone && idxs.includes(justDone)) item.addClass('wt-just-done');

			const main = item.createEl('button', { cls: 'wt-workout-plan-main' });
			const status = main.createSpan({ cls: 'wt-workout-plan-status' });
			if (exDone) setIcon(status, 'check');
			const text = main.createSpan({ cls: 'wt-workout-plan-text' });
			text.createSpan({ text: ex.name, cls: 'wt-workout-plan-name' });
			const first = ex.sets[0];
			let target = `${ex.sets.length} × ${first?.reps ?? 0}${first && first.weight > 0 ? ` @ ${first.weight} ${unit}` : ''}`;
			if (ex.modifier) target += ` · ${ex.modifier}`;
			const meta = exDone ? `All ${idxs.length} set${idxs.length !== 1 ? 's' : ''} done`
				: doneCount > 0 ? `${doneCount} of ${idxs.length} done` : target;
			text.createSpan({ text: meta, cls: 'wt-workout-plan-meta' });
			main.disabled = locked || exDone || firstOpen === current;
			if (!main.disabled) main.setAttribute('title', `${state.isResting ? 'Do next' : 'Go to'}: set ${steps[firstOpen].setIndex + 1}`);
			main.addEventListener('click', () => this.jumpToStep(firstOpen));

			const pills = item.createDiv({ cls: 'wt-workout-plan-sets' });
			for (const i of idxs) {
				const setNo = steps[i].setIndex + 1;
				const isDone = done.has(i);
				const pill = pills.createEl('button', { text: String(setNo), cls: 'wt-set-pill' });
				if (isDone) pill.addClass('is-done');
				if (i === current) pill.addClass('is-current');
				else if (i === upNext) pill.addClass('is-next');
				if (isDone && i === justDone) pill.addClass('wt-just-done');
				pill.disabled = locked || isDone || i === current;
				const label = isDone ? 'done' : i === current ? 'current' : i === upNext ? 'up next' : 'not done';
				pill.setAttribute('aria-label', `${ex.name} set ${setNo}, ${label}`);
				pill.addEventListener('click', () => this.jumpToStep(i));
			}
		}
	}

	private renderPreviousSets(container: HTMLElement, state: ActiveWorkoutState): void {
		if (state.stepHistory.length === 0) return;
		const section = container.createDiv({ cls: 'wt-previous-sets' });
		section.createEl('div', { text: 'Completed Sets', cls: 'wt-prev-heading' });
		const unit = this.plugin.data.settings.weightUnit;
		// Most recent first; labels use the plan's set number
		for (let i = state.stepHistory.length - 1; i >= 0; i--) {
			const { stepIndex, exerciseName, completedSet: cs } = state.stepHistory[i];
			const setRow = section.createDiv({ cls: 'wt-prev-set-row' });
			setRow.createEl('span', { text: `${exerciseName} S${state.steps[stepIndex].setIndex + 1}: `, cls: 'wt-prev-set-label' });
			const rInput = setRow.createEl('input', { type: 'number', value: String(cs.reps), cls: 'wt-prev-input' });
			setRow.createEl('span', { text: ' reps × ' });
			const wInput = setRow.createEl('input', { type: 'number', value: String(cs.weight), cls: 'wt-prev-input' });
			setRow.createEl('span', { text: ` ${unit}` });
			rInput.addEventListener('change', () => { cs.reps = parseInt(rInput.value) || 0; });
			wInput.addEventListener('change', () => { cs.weight = parseFloat(wInput.value) || 0; });
		}
	}

	/** Step after the current one: the set picked during rest, else the next unfinished one in plan order. -1 if none. */
	private getUpNextStep(state: ActiveWorkoutState): number {
		if (state.isResting && state.nextStepIndex !== undefined) return state.nextStepIndex;
		const next = nextOpenStep(state, state.currentStepIndex);
		return next === state.currentStepIndex ? -1 : next;
	}

	private getNextSetInfo(state: ActiveWorkoutState): string | null {
		const nextIdx = this.getUpNextStep(state);
		if (nextIdx === -1) return null;
		const nextStep = state.steps[nextIdx];
		const nextEx = state.workout.exercises[nextStep.exerciseIndex];
		return `${nextEx.name} — Set ${nextStep.setIndex + 1} of ${nextEx.sets.length}`;
	}

	private startActiveTimer(): void {
		this.timerIntervalId = this.registerInterval(window.setInterval(() => this.tickActiveTimer(), 1000)) as unknown as number;
	}

	private tickActiveTimer(): void {
		const state = this.plugin.activeState;
		if (!state || state.isPaused) return;
		this.contentEl.querySelector('.wt-total-time')?.setText(`Time spent: ${formatTime(workoutElapsedSeconds(state))}`);
		if (state.isResting) {
			const restElapsed = Math.floor((Date.now() - state.restStartTime) / 1000);
			const step = state.steps[state.currentStepIndex];
			const prevRemaining = state.restRemaining;
			state.restRemaining = step.restSeconds - restElapsed;
			if (prevRemaining >= 0 && state.restRemaining < 0 && !this.restAlertFired) {
				this.restAlertFired = true;
				if (this.plugin.data.settings.restTimerSound) playRestBeep();
				if (this.plugin.data.settings.restTimerVibrate && Platform.isMobile) vibrateDevice();
			}
			const restTimerEl = this.contentEl.querySelector('.wt-big-timer');
			if (restTimerEl) {
				restTimerEl.setText(formatTime(state.restRemaining));
				if (state.restRemaining < 0) {
					restTimerEl.addClass('wt-timer-overtime');
					this.contentEl.querySelector('.wt-current-panel')?.addClass('wt-rest-overtime');
				}
			}
		} else if (state.setStarted) {
			state.setElapsed = Math.floor((Date.now() - state.currentSetStartTime) / 1000);
			const el = this.contentEl.querySelector('[data-role="setElapsed"]');
			if (el) el.setText(formatTime(state.setElapsed));
		}
	}

	/** The running session, or null while a finish is saving (so taps can't change what gets saved). */
	private session(): ActiveWorkoutState | null {
		return this.finishingWorkout ? null : this.plugin.activeState;
	}

	private async completeCurrentSet(): Promise<void> {
		const state = this.session();
		if (!state || !state.setStarted || state.isResting || state.isPaused) return;
		state.setStarted = false;
		state.setElapsed = Math.floor((Date.now() - state.currentSetStartTime) / 1000);
		// Record synchronously so a tap during the save can't change which set this was.
		const stepIndex = state.currentStepIndex;
		const step = state.steps[stepIndex];
		const currentEx = state.workout.exercises[step.exerciseIndex];
		const cs: CompletedSet = { reps: state.currentReps, weight: state.currentWeight, setSeconds: state.setElapsed, actualRestSeconds: 0 };
		const key = lastUsedKey(state.workout.name, currentEx.name, step.setIndex);
		if (!(key in state.lastUsedBefore)) {
			const before = this.plugin.data.lastUsed[key];
			state.lastUsedBefore[key] = before ? { ...before } : null;
		}
		this.plugin.data.lastUsed[key] = { reps: state.currentReps, weight: state.currentWeight };
		let completedEx = state.completedExercises.find((e) => e.name === currentEx.name);
		if (!completedEx) { completedEx = { name: currentEx.name, sets: [] }; state.completedExercises.push(completedEx); }
		// Keep sets in plan order even when done out of order. Plan position (not set number),
		// because two exercises with the same name share one entry here.
		const planPos = (s: CompletedSet) => state.stepHistory.find((e) => e.completedSet === s)?.stepIndex ?? Number.MAX_SAFE_INTEGER;
		const at = completedEx.sets.findIndex((s) => planPos(s) > stepIndex);
		completedEx.sets.splice(at < 0 ? completedEx.sets.length : at, 0, cs);
		state.stepHistory.push({ stepIndex, completedSet: cs, exerciseName: currentEx.name });
		this.justCompletedStep = stepIndex;
		if (nextOpenStep(state, stepIndex) === -1) { await this.finishWorkout(); return; }
		if (step.restSeconds > 0) {
			state.isResting = true; state.restRemaining = step.restSeconds; state.restStartTime = Date.now(); this.restAlertFired = false; this.render();
		} else { this.advanceToNextStep(); }
		await this.plugin.savePluginData();
	}

	private advanceFromRest(): void {
		const state = this.session();
		if (!state || !state.isResting) return;
		const lastEntry = state.stepHistory[state.stepHistory.length - 1];
		if (lastEntry) lastEntry.completedSet.actualRestSeconds = Math.floor((Date.now() - state.restStartTime) / 1000);
		state.isResting = false;
		const chosen = state.nextStepIndex;
		delete state.nextStepIndex;
		const chosenOpen = chosen !== undefined && !state.stepHistory.some((h) => h.stepIndex === chosen);
		const target = chosenOpen ? chosen : nextOpenStep(state, state.currentStepIndex);
		if (target === -1) { void this.finishWorkout(); return; }
		state.currentStepIndex = target;
		this.prepareCurrentSet();
		this.startCurrentSet();
	}

	/** After a set with no rest: go to the next unfinished set in plan order. */
	private advanceToNextStep(): void {
		const state = this.plugin.activeState;
		if (!state) return;
		const next = nextOpenStep(state, state.currentStepIndex);
		if (next === -1) return;
		state.currentStepIndex = next;
		this.prepareCurrentSet();
	}

	/** Keep what was typed for the current set, so coming back to it restores it. */
	private saveDraft(state: ActiveWorkoutState): void {
		const step = state.steps[state.currentStepIndex];
		if (step) state.setDrafts[`${step.exerciseIndex}:${step.setIndex}`] = { reps: state.currentReps, weight: state.currentWeight };
	}

	private prepareCurrentSet(): void {
		const state = this.plugin.activeState;
		if (!state) return;
		const step = state.steps[state.currentStepIndex];
		if (!step) return;
		const ex = state.workout.exercises[step.exerciseIndex];
		const set = ex.sets[step.setIndex];
		const previous = state.setDrafts[`${step.exerciseIndex}:${step.setIndex}`] ?? this.plugin.data.lastUsed[lastUsedKey(state.workout.name, ex.name, step.setIndex)];
		state.currentReps = previous?.reps ?? set?.reps ?? 0;
		state.currentWeight = previous?.weight ?? set?.weight ?? 0;
		state.setStarted = false; state.setElapsed = 0; state.currentSetStartTime = 0;
		this.restAlertFired = false; this.render();
	}

	private startCurrentSet(): void {
		const state = this.session();
		if (!state || state.setStarted || state.isPaused || state.isResting) return;
		if (state.stepHistory.some((h) => h.stepIndex === state.currentStepIndex)) return; // already logged
		state.setStarted = true; state.setElapsed = 0; state.currentSetStartTime = Date.now();
		this.render();
	}

	/**
	 * Tap in the workout plan. Ready: go to that set now. Resting: make it the next set (rest keeps running).
	 * Ignored while a set is running or paused, and for sets already done. Plan order never changes.
	 */
	private jumpToStep(index: number): void {
		const state = this.session();
		if (!state || state.isPaused || (state.setStarted && !state.isResting)) return;
		if (index < 0 || index >= state.steps.length || state.stepHistory.some((h) => h.stepIndex === index)) return;
		if (state.isResting) { state.nextStepIndex = index; this.render(); return; }
		if (index === state.currentStepIndex) return;
		this.saveDraft(state);
		state.currentStepIndex = index;
		this.prepareCurrentSet();
	}

	/** Leave this set unfinished and go to the next unfinished one (wrapping). With nothing else left, offer to end. */
	private skipCurrentSet(): void {
		const state = this.session();
		if (!state || state.isPaused || state.isResting) return;
		const next = nextOpenStep(state, state.currentStepIndex);
		if (next === -1 || next === state.currentStepIndex) { this.openEndDialog(); return; }
		this.saveDraft(state);
		state.currentStepIndex = next;
		this.prepareCurrentSet();
	}

	private pauseWorkout(): void {
		const state = this.session();
		if (!state || state.isPaused) return;
		state.isPaused = true;
		state.pauseStartTime = Date.now();
		this.render();
	}

	private resumeWorkout(): void {
		const state = this.session();
		if (!state || !state.isPaused) return;
		const pausedDuration = Date.now() - state.pauseStartTime;
		state.totalPausedMs += pausedDuration;
		// Shift timing origins so timers don't jump
		state.currentSetStartTime += pausedDuration;
		if (state.isResting) state.restStartTime += pausedDuration;
		state.isPaused = false;
		this.render();
	}

	private goBackToLastSet(): void {
		const state = this.session();
		if (!state || state.stepHistory.length === 0) return;
		if (!state.isResting) this.saveDraft(state);
		const lastEntry = state.stepHistory.pop()!;
		// Remove exactly that set (it may sit anywhere in its exercise's list)
		const cex = state.completedExercises.find((e) => e.sets.includes(lastEntry.completedSet));
		if (cex) {
			cex.sets.splice(cex.sets.indexOf(lastEntry.completedSet), 1);
			if (cex.sets.length === 0) state.completedExercises.splice(state.completedExercises.indexOf(cex), 1);
		}
		// Go back to that step
		state.currentStepIndex = lastEntry.stepIndex;
		state.isResting = false;
		delete state.nextStepIndex;
		state.currentReps = lastEntry.completedSet.reps;
		state.currentWeight = lastEntry.completedSet.weight;
		state.setElapsed = 0;
		state.currentSetStartTime = 0;
		state.setStarted = false;
		this.restAlertFired = false;
		this.render();
	}

	/** End button (and Skip on the last open set): Save, Discard or keep going. */
	private openEndDialog(): void {
		const state = this.session();
		if (!state) return;
		const logged = state.stepHistory.length;
		const sets = logged === 0 ? 'No sets logged yet' : `${logged} of ${state.steps.length} sets logged`;
		new EndWorkoutModal(this.app, `${sets} · ${formatTime(workoutElapsedSeconds(state))}`,
			() => { void this.finishWorkout(); },
			() => { void this.discardWorkout(); }).open();
	}

	private async discardWorkout(): Promise<void> {
		if (!this.session()) return;
		this.clearTimers();
		this.justCompletedStep = -1;
		await this.plugin.discardActiveWorkout();
		new Notice('Workout discarded. Nothing was saved.');
		this.navigateTo('home');
	}

	private async finishWorkout(): Promise<void> {
		const state = this.plugin.activeState;
		if (!state || this.finishingWorkout) return;
		this.finishingWorkout = true;
		try {
			this.clearTimers();
			this.justCompletedStep = -1;
			const logged: LoggedSet[] = state.stepHistory.map((h) => ({
				exerciseIndex: state.steps[h.stepIndex].exerciseIndex, exerciseName: h.exerciseName,
				setIndex: state.steps[h.stepIndex].setIndex, set: h.completedSet,
			}));
			const finishedAt = new Date();
			const totalDuration = workoutElapsedSeconds(state, finishedAt.getTime());
			const completed: CompletedWorkout = {
				id: generateId(), workoutName: state.workout.name, date: finishedAt.toISOString(),
				dailyNoteDate: `${finishedAt.getFullYear()}-${String(finishedAt.getMonth() + 1).padStart(2, '0')}-${String(finishedAt.getDate()).padStart(2, '0')}`,
				dailyNoteTime: `${String(finishedAt.getHours()).padStart(2, '0')}:${String(finishedAt.getMinutes()).padStart(2, '0')}`,
				totalDurationSeconds: totalDuration, exercises: state.completedExercises,
			};
			const prDescriptions = this.plugin.checkAndUpdatePRs(completed);
			if (prDescriptions.length > 0) completed.prs = prDescriptions;
			this.plugin.data.history.push(completed);
			try { await this.plugin.savePluginData(); }
			catch {
				this.plugin.data.history = this.plugin.data.history.filter(entry => entry.id !== completed.id);
				this.plugin.rebuildAllPRs();
				new Notice('Could not save this workout. Your active session is still open; try End again.');
				this.render();
				return;
			}
			const template = this.plugin.data.workouts.find((w) => w.name === completed.workoutName);
			this.plugin.activeState = null;
			this.completedWorkout = completed;
			this.completedPRs = prDescriptions;

			if (template) {
				new UpdateWorkoutModal(this.app, completed.workoutName,
					async () => {
						applyLoggedSetsToTemplate(template, logged);
						template.lastUpdatedDurationSeconds = totalDuration;
						await this.plugin.savePluginData();
						new Notice('Workout template updated!');
						this.navigateTo('completion');
					},
					() => { this.navigateTo('completion'); }
				).open();
			} else {
				this.navigateTo('completion');
			}
			new Notice(`Workout "${completed.workoutName}" completed!`);
			await this.plugin.syncDailyNotes();
		} finally { this.finishingWorkout = false; }
	}

	// ═══════════════════════════════════════════════════════════════════════════
	// COMPLETION SCREEN
	// ═══════════════════════════════════════════════════════════════════════════

	private renderCompletionScreen(): void {
		const completed = this.completedWorkout;
		if (!completed) { this.navigateTo('home'); return; }

		const container = this.contentEl;
		container.addClass('wt-completion');
		container.createEl('h2', { text: 'Workout Complete!', cls: 'wt-completion-title' });

		const summary = container.createDiv({ cls: 'wt-summary' });
		summary.createEl('div', { text: `Workout: ${completed.workoutName}`, cls: 'wt-summary-item' });
		summary.createEl('div', { text: `Total Time: ${formatTime(completed.totalDurationSeconds)}`, cls: 'wt-summary-item' });
		summary.createEl('div', { text: `Exercises: ${completed.exercises.length}`, cls: 'wt-summary-item' });
		const totalSets = completed.exercises.reduce((s, e) => s + e.sets.length, 0);
		summary.createEl('div', { text: `Total Sets: ${totalSets}`, cls: 'wt-summary-item' });
		const totalVolume = completed.exercises.reduce((vol, ex) => vol + ex.sets.reduce((sv, s) => sv + s.reps * s.weight, 0), 0);
		const unit = this.plugin.data.settings.weightUnit;
		summary.createEl('div', { text: `Total Volume: ${totalVolume.toLocaleString()} ${unit}`, cls: 'wt-summary-item' });

		if (this.completedPRs.length > 0) {
			const prSection = container.createDiv({ cls: 'wt-pr-section' });
			prSection.createEl('h3', { text: 'New Personal Records!', cls: 'wt-pr-title' });
			for (const pr of this.completedPRs) {
				const prItem = prSection.createDiv({ cls: 'wt-pr-item' });
				prItem.createEl('span', { text: 'PR ', cls: 'wt-pr-badge' });
				prItem.createEl('span', { text: pr });
			}
		}

		// Notes section
		const notesSection = container.createDiv({ cls: 'wt-notes-section' });
		notesSection.createEl('div', { text: 'Workout Notes', cls: 'wt-notes-heading' });
		const notesInput = notesSection.createEl('textarea', { cls: 'wt-notes-input' });
		notesInput.placeholder = 'How did you feel? Any notes about this session...';
		notesInput.value = completed.notes || '';
		notesInput.addEventListener('input', () => { completed.notes = notesInput.value; });

		const returnBtn = container.createEl('button', { text: 'Done', cls: 'wt-btn wt-btn-primary wt-return-btn' });
		returnBtn.addEventListener('click', async () => {
			// Save notes to the history entry
			const historyEntry = this.plugin.data.history.find((h) => h.id === completed.id);
			if (historyEntry && completed.notes) historyEntry.notes = completed.notes;
			await this.plugin.savePluginData();
			this.completedWorkout = null;
			this.completedPRs = [];
			this.navigateTo('home');
		});
	}

	// ═══════════════════════════════════════════════════════════════════════════
	// HISTORY & STATS (combined view)
	// ═══════════════════════════════════════════════════════════════════════════

	private renderHistoryStats(): void {
		const container = this.contentEl;
		container.addClass('wt-history');

		// ── Back + tabs ──────────────────────────────────────────────────────
		const topBar = container.createDiv({ cls: 'wt-topbar' });
		const backBtn = topBar.createEl('button', { cls: 'wt-btn wt-btn-sm wt-back-btn' });
		setIcon(backBtn, 'arrow-left');
		backBtn.createEl('span', { text: ' Back' });
		backBtn.addEventListener('click', () => this.navigateTo('home'));

		const tabBar = container.createDiv({ cls: 'wt-tab-bar' });
		const hTab = tabBar.createEl('button', { text: 'History', cls: `wt-tab ${this.historyTab === 'history' ? 'wt-tab-active' : ''}` });
		const sTab = tabBar.createEl('button', { text: 'Stats', cls: `wt-tab ${this.historyTab === 'stats' ? 'wt-tab-active' : ''}` });
		hTab.addEventListener('click', () => { this.historyTab = 'history'; this.screen = 'history'; this.render(); });
		sTab.addEventListener('click', () => { this.historyTab = 'stats'; this.screen = 'stats'; this.render(); });

		if (this.screen === 'history') this.renderHistoryList(container);
		else this.renderStatsContent(container);
	}

	private renderHistoryList(container: HTMLElement): void {
		const history = this.plugin.data.history;

		if (history.length > 0) {
			const filterRow = container.createDiv({ cls: 'wt-filter-row' });
			const workoutNames = [...new Set(history.map((h) => h.workoutName))].sort();
			const filterSelect = filterRow.createEl('select', { cls: 'wt-workout-select wt-filter-select' });
			filterSelect.createEl('option', { text: 'All Workouts', value: '' });
			workoutNames.forEach((n) => { const opt = filterSelect.createEl('option', { text: n, value: n }); if (n === this.historyFilter) opt.selected = true; });
			filterSelect.addEventListener('change', () => { this.historyFilter = filterSelect.value; this.historyPage = 0; this.render(); });

			const clearBtn = filterRow.createEl('button', { text: 'Clear All', cls: 'wt-btn wt-btn-danger wt-btn-sm' });
			clearBtn.addEventListener('click', () => {
				new ConfirmModal(this.app, 'Delete ALL workout history? This cannot be undone.', async () => {
					this.plugin.data.history = []; this.plugin.data.personalRecords = {};
					await this.plugin.savePluginData(); this.render();
				}).open();
			});
		}

		let filtered = this.historyFilter ? history.filter((h) => h.workoutName === this.historyFilter) : history;
		if (filtered.length === 0) { container.createEl('p', { text: 'No workouts recorded yet.', cls: 'wt-empty-msg' }); return; }

		const sorted = [...filtered].reverse();
		const totalCount = sorted.length;
		const startIdx = this.historyPage * this.HISTORY_PAGE_SIZE;
		const pageItems = sorted.slice(startIdx, startIdx + this.HISTORY_PAGE_SIZE);
		const totalPages = Math.ceil(totalCount / this.HISTORY_PAGE_SIZE);

		if (totalCount > this.HISTORY_PAGE_SIZE) {
			container.createDiv({ cls: 'wt-pagination-info' }).setText(`Showing ${startIdx + 1}–${Math.min(startIdx + this.HISTORY_PAGE_SIZE, totalCount)} of ${totalCount}`);
		}

		const list = container.createDiv({ cls: 'wt-history-list' });
		const unit = this.plugin.data.settings.weightUnit;

		pageItems.forEach((entry) => {
			const card = list.createDiv({ cls: 'wt-history-card' });
			const cardHeader = card.createDiv({ cls: 'wt-history-header' });
			const info = cardHeader.createDiv({ cls: 'wt-history-info' });
			const dateStr = new Date(entry.date).toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
			info.createEl('div', { text: entry.workoutName, cls: 'wt-history-name' });
			const metaRow = info.createDiv({ cls: 'wt-history-meta' });
			metaRow.createEl('span', { text: `${dateStr} · ${formatTime(entry.totalDurationSeconds)}` });
			if (entry.prs && entry.prs.length > 0) metaRow.createEl('span', { text: ` · ${entry.prs.length} PR${entry.prs.length > 1 ? 's' : ''}`, cls: 'wt-pr-badge-inline' });

			const delBtn = cardHeader.createEl('button', { text: 'Delete', cls: 'wt-btn wt-btn-danger wt-btn-sm' });
			delBtn.addEventListener('click', () => {
				new ConfirmModal(this.app, 'Delete this workout entry?', async () => {
					const idx = this.plugin.data.history.findIndex((h) => h.id === entry.id);
					if (idx >= 0) { this.plugin.data.history.splice(idx, 1); this.plugin.rebuildAllPRs(); await this.plugin.savePluginData(); this.render(); }
				}).open();
			});

			const details = card.createEl('details', { cls: 'wt-history-details' });
			details.createEl('summary', { text: 'Show details' });
			if (entry.prs && entry.prs.length > 0) {
				const prDiv = details.createDiv({ cls: 'wt-history-pr-list' });
				for (const pr of entry.prs) {
					const prItem = prDiv.createDiv({ cls: 'wt-pr-item-small' });
					prItem.createEl('span', { text: 'PR ', cls: 'wt-pr-badge' });
					prItem.createEl('span', { text: pr });
				}
			}
			entry.exercises.forEach((ex) => {
				const exDiv = details.createDiv({ cls: 'wt-history-exercise' });
				exDiv.createEl('strong', { text: ex.name });
				ex.sets.forEach((s, si) => {
					const line = exDiv.createDiv({ cls: 'wt-history-set' });
					line.setText(s.weight > 0 ? `Set ${si + 1}: ${s.reps} reps × ${s.weight} ${unit}` : `Set ${si + 1}: ${s.reps} reps (bodyweight)`);
				});
			});
			if (entry.notes) {
				const notesDiv = details.createDiv({ cls: 'wt-history-notes' });
				notesDiv.createEl('strong', { text: 'Notes: ' });
				notesDiv.createEl('span', { text: entry.notes, cls: 'wt-history-notes-text' });
			}
		});

		if (totalPages > 1) {
			const pagRow = container.createDiv({ cls: 'wt-pagination-row' });
			const prevBtn = pagRow.createEl('button', { text: '← Newer', cls: 'wt-btn wt-btn-sm' });
			if (this.historyPage <= 0) prevBtn.disabled = true;
			prevBtn.addEventListener('click', () => { this.historyPage--; this.render(); });
			pagRow.createEl('span', { text: `Page ${this.historyPage + 1} / ${totalPages}`, cls: 'wt-page-label' });
			const nextBtn = pagRow.createEl('button', { text: 'Older →', cls: 'wt-btn wt-btn-sm' });
			if (this.historyPage >= totalPages - 1) nextBtn.disabled = true;
			nextBtn.addEventListener('click', () => { this.historyPage++; this.render(); });
		}
	}

	private renderStatsContent(container: HTMLElement): void {
		const history = this.plugin.data.history;
		const unit = this.plugin.data.settings.weightUnit;
		if (history.length === 0) { container.createEl('p', { text: 'Complete some workouts to see stats.', cls: 'wt-empty-msg' }); return; }

		// ── Time range controls ──────────────────────────────────────────────
		const timeControls = container.createDiv({ cls: 'wt-time-controls' });
		const rangeRow = timeControls.createDiv({ cls: 'wt-time-range-bar' });
		const ranges: { label: string; value: TimeRange }[] = [
			{ label: 'Week', value: 'week' }, { label: 'Month', value: 'month' },
			{ label: 'Year', value: 'year' }, { label: 'All', value: 'all' },
		];
		for (const r of ranges) {
			const btn = rangeRow.createEl('button', { text: r.label, cls: `wt-time-range-btn ${this.statsTimeRange === r.value ? 'wt-time-range-active' : ''}` });
			btn.addEventListener('click', () => { this.statsTimeRange = r.value; this.statsTimeOffset = 0; this.render(); });
		}

		if (this.statsTimeRange !== 'all') {
			const navRow = timeControls.createDiv({ cls: 'wt-time-nav' });
			const earlierData = filterHistoryByRange(history, this.statsTimeRange, this.statsTimeOffset - 1);
			const leftBtn = navRow.createEl('button', { cls: 'wt-btn wt-nav-arrow' });
			setIcon(leftBtn, 'chevron-left');
			if (earlierData.length === 0) leftBtn.disabled = true;
			leftBtn.addEventListener('click', () => { this.statsTimeOffset--; this.render(); });
			navRow.createEl('span', { text: getPeriodLabel(this.statsTimeRange, this.statsTimeOffset), cls: 'wt-time-period-label' });
			const rightBtn = navRow.createEl('button', { cls: 'wt-btn wt-nav-arrow' });
			setIcon(rightBtn, 'chevron-right');
			if (this.statsTimeOffset >= 0) rightBtn.disabled = true;
			rightBtn.addEventListener('click', () => { this.statsTimeOffset++; this.render(); });
		}

		const filtered = filterHistoryByRange(history, this.statsTimeRange, this.statsTimeOffset);
		const sorted = [...filtered].sort((a, b) => a.date.localeCompare(b.date));
		if (sorted.length === 0) { container.createEl('p', { text: 'No workouts in this period.', cls: 'wt-empty-msg' }); return; }

		const sc = container.createDiv({ cls: 'wt-stats' });

		// Summary cards
		const summaryRow = sc.createDiv({ cls: 'wt-stats-summary' });
		const totalWorkouts = sorted.length;
		const totalVolume = sorted.reduce((s, w) => s + w.exercises.reduce((ev, ex) => ev + ex.sets.reduce((sv, st) => sv + st.reps * st.weight, 0), 0), 0);
		const totalDuration = sorted.reduce((s, w) => s + w.totalDurationSeconds, 0);
		const totalSets = sorted.reduce((s, w) => s + w.exercises.reduce((ev, ex) => ev + ex.sets.length, 0), 0);
		const statCards = [
			{ label: 'Workouts', value: String(totalWorkouts) },
			{ label: 'Total Volume', value: `${totalVolume >= 1000 ? `${(totalVolume / 1000).toFixed(1)}k` : totalVolume} ${unit}` },
			{ label: 'Total Time', value: formatDurationShort(totalDuration) },
			{ label: 'Total Sets', value: String(totalSets) },
		];
		for (const sc2 of statCards) {
			const card = summaryRow.createDiv({ cls: 'wt-stat-card' });
			card.createEl('div', { text: sc2.value, cls: 'wt-stat-value' });
			card.createEl('div', { text: sc2.label, cls: 'wt-stat-label' });
		}

		// Consistency
		const weekMap = new Map<string, number>();
		sorted.forEach((w) => { const ws = getWeekStart(new Date(w.date)); const key = `${ws.getMonth() + 1}/${ws.getDate()}`; weekMap.set(key, (weekMap.get(key) ?? 0) + 1); });
		const cp: ChartPoint[] = []; weekMap.forEach((c, w) => cp.push({ label: w, value: c }));
		if (cp.length > 0) renderBarChart(sc, cp, 'Workout Consistency (per week)', 'Workouts', '#6366f1');

		// Total volume over time
		renderLineChart(sc, sorted.map((w) => ({
			label: shortDate(w.date),
			value: w.exercises.reduce((s, ex) => s + ex.sets.reduce((sv, st) => sv + st.reps * st.weight, 0), 0),
		})), `Total Volume Over Time (${unit})`, unit, '#22c55e');

		// Exercise breakdown
		const allNames = new Set<string>();
		sorted.forEach((w) => w.exercises.forEach((ex) => allNames.add(ex.name)));
		const exList = [...allNames].sort();
		if (exList.length > 0) {
			if (!this.selectedExercise || !allNames.has(this.selectedExercise)) this.selectedExercise = exList[0];
			sc.createEl('div', { text: 'Exercise Breakdown', cls: 'wt-stats-section-title' });
			const selRow = sc.createDiv({ cls: 'wt-stats-select-row' });
			selRow.createEl('label', { text: 'Exercise:' });
			const exSel = selRow.createEl('select', { cls: 'wt-workout-select' });
			exList.forEach((n) => { const o = exSel.createEl('option', { text: n, value: n }); if (n === this.selectedExercise) o.selected = true; });
			exSel.addEventListener('change', () => { this.selectedExercise = exSel.value; this.render(); });

			const en = this.selectedExercise;
			const sessions: { date: string; sets: number; maxWeight: number; totalReps: number; volume: number; avgReps: number; best1RM: number }[] = [];
			sorted.forEach((w) => {
				const matches = w.exercises.filter((e) => e.name === en);
				if (matches.length === 0) return;
				let sets = 0, maxW = 0, totR = 0, vol = 0, best1rm = 0;
				matches.forEach((m) => m.sets.forEach((s) => {
					sets++; if (s.weight > maxW) maxW = s.weight; totR += s.reps; vol += s.reps * s.weight;
					const e1rm = estimate1RM(s.weight, s.reps); if (e1rm > best1rm) best1rm = e1rm;
				}));
				sessions.push({ date: w.date, sets, maxWeight: maxW, totalReps: totR, volume: vol, avgReps: sets > 0 ? Math.round(totR / sets) : 0, best1RM: best1rm });
			});
			const ecd = sc.createDiv({ cls: 'wt-ex-charts' });
			if (sessions.length > 0) {
				renderBarChart(ecd, sessions.map((s) => ({ label: shortDate(s.date), value: s.sets })), `${en} — Sets Per Session`, 'Sets', '#f59e0b');
				renderLineChart(ecd, sessions.map((s) => ({ label: shortDate(s.date), value: s.maxWeight })), `${en} — Max Weight (${unit})`, unit, '#ef4444');
				renderLineChart(ecd, sessions.map((s) => ({ label: shortDate(s.date), value: s.totalReps })), `${en} — Total Reps`, 'Reps', '#3b82f6');
				renderLineChart(ecd, sessions.map((s) => ({ label: shortDate(s.date), value: s.volume })), `${en} — Volume (${unit})`, unit, '#22c55e');
				renderLineChart(ecd, sessions.map((s) => ({ label: shortDate(s.date), value: s.avgReps })), `${en} — Avg Reps/Set`, 'Reps', '#8b5cf6');
				renderLineChart(ecd, sessions.map((s) => ({ label: shortDate(s.date), value: s.best1RM })), `${en} — Est. 1RM (${unit})`, unit, '#ec4899');
			} else {
				ecd.createEl('p', { text: `No history for "${en}" in this period.`, cls: 'wt-empty-msg' });
			}
		}

		// Personal Records (below exercise breakdown)
		const prs = this.plugin.data.personalRecords;
		const prNames = Object.keys(prs).sort();
		if (prNames.length > 0) {
			sc.createEl('div', { text: 'Personal Records', cls: 'wt-stats-section-title' });
			const prTable = sc.createDiv({ cls: 'wt-pr-table' });
			for (const name of prNames) {
				const pr = prs[name];
				const prRow = prTable.createDiv({ cls: 'wt-pr-table-row' });
				prRow.createEl('div', { text: name, cls: 'wt-pr-exercise-name' });
				const vals = prRow.createDiv({ cls: 'wt-pr-values' });
				if (pr.maxWeight > 0) vals.createEl('span', { text: `Max: ${pr.maxWeight} ${unit}`, cls: 'wt-pr-value-item' });
				if (pr.max1RM > 0) vals.createEl('span', { text: `Est 1RM: ${pr.max1RM} ${unit}`, cls: 'wt-pr-value-item' });
				if (pr.maxVolume > 0) vals.createEl('span', { text: `Vol: ${pr.maxVolume.toLocaleString()} ${unit}`, cls: 'wt-pr-value-item' });
				if (pr.maxReps > 0) vals.createEl('span', { text: `Reps: ${pr.maxReps}`, cls: 'wt-pr-value-item' });
			}
		}
	}
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHART RENDERING
// ═══════════════════════════════════════════════════════════════════════════════

interface ChartPoint { label: string; value: number; }

function renderLineChart(container: HTMLElement, points: ChartPoint[], title: string, yLabel: string, color: string = '#6366f1'): void {
	if (points.length === 0) { container.createEl('p', { text: 'No data yet.', cls: 'wt-empty-msg' }); return; }
	const plotPoints = aggregatePoints(points, 40);
	const chartDiv = container.createDiv({ cls: 'wt-chart' });
	chartDiv.createEl('div', { text: title, cls: 'wt-chart-title' });
	const W = 320, H = 180, PL = 45, PR = 10, PT = 10, PB = 40;
	const pW = W - PL - PR, pH = H - PT - PB;
	const vals = plotPoints.map((p) => p.value);
	const maxV = Math.max(...vals, 1), minV = Math.min(...vals, 0), range = maxV - minV || 1;
	const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('class', 'wt-svg-chart');
	for (let i = 0; i <= 4; i++) {
		const y = PT + (pH / 4) * i;
		const gl = document.createElementNS('http://www.w3.org/2000/svg', 'line');
		gl.setAttribute('x1', String(PL)); gl.setAttribute('x2', String(W - PR));
		gl.setAttribute('y1', String(y)); gl.setAttribute('y2', String(y)); gl.setAttribute('class', 'wt-grid-line');
		svg.appendChild(gl);
		const lb = document.createElementNS('http://www.w3.org/2000/svg', 'text');
		lb.setAttribute('x', String(PL - 5)); lb.setAttribute('y', String(y + 4));
		lb.setAttribute('class', 'wt-axis-label'); lb.setAttribute('text-anchor', 'end');
		const v = maxV - (range / 4) * i;
		lb.textContent = v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v));
		svg.appendChild(lb);
	}
	const yl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
	yl.setAttribute('x', '12'); yl.setAttribute('y', String(PT + pH / 2));
	yl.setAttribute('class', 'wt-axis-title'); yl.setAttribute('transform', `rotate(-90, 12, ${PT + pH / 2})`);
	yl.textContent = yLabel; svg.appendChild(yl);
	const xStep = plotPoints.length > 1 ? pW / (plotPoints.length - 1) : pW / 2;
	const coords = plotPoints.map((p, i) => ({
		x: PL + (plotPoints.length > 1 ? i * xStep : pW / 2),
		y: PT + pH - ((p.value - minV) / range) * pH,
	}));
	if (coords.length > 1) {
		const d = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x},${c.y}`).join(' ');
		const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		path.setAttribute('d', d); path.setAttribute('fill', 'none');
		path.setAttribute('stroke', color); path.setAttribute('stroke-width', '2'); path.setAttribute('stroke-linejoin', 'round');
		svg.appendChild(path);
	}
	const maxLb = 8, lEvery = Math.max(1, Math.ceil(plotPoints.length / maxLb));
	coords.forEach((c, i) => {
		const ci = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
		ci.setAttribute('cx', String(c.x)); ci.setAttribute('cy', String(c.y));
		ci.setAttribute('r', '3'); ci.setAttribute('fill', color);
		const tt = document.createElementNS('http://www.w3.org/2000/svg', 'title');
		tt.textContent = `${plotPoints[i].label}: ${plotPoints[i].value}`; ci.appendChild(tt);
		svg.appendChild(ci);
		if (i % lEvery === 0 || i === plotPoints.length - 1) {
			const xl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
			xl.setAttribute('x', String(c.x)); xl.setAttribute('y', String(H - 5));
			xl.setAttribute('class', 'wt-axis-label'); xl.setAttribute('text-anchor', 'middle');
			xl.textContent = plotPoints[i].label; svg.appendChild(xl);
		}
	});
	chartDiv.appendChild(svg);
}

function renderBarChart(container: HTMLElement, points: ChartPoint[], title: string, yLabel: string, color: string = '#22c55e'): void {
	if (points.length === 0) { container.createEl('p', { text: 'No data yet.', cls: 'wt-empty-msg' }); return; }
	const plotPoints = aggregatePoints(points, 40);
	const chartDiv = container.createDiv({ cls: 'wt-chart' });
	chartDiv.createEl('div', { text: title, cls: 'wt-chart-title' });
	const W = 320, H = 180, PL = 45, PR = 10, PT = 10, PB = 40;
	const pW = W - PL - PR, pH = H - PT - PB;
	const maxV = Math.max(...plotPoints.map((p) => p.value), 1);
	const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('class', 'wt-svg-chart');
	for (let i = 0; i <= 4; i++) {
		const y = PT + (pH / 4) * i;
		const gl = document.createElementNS('http://www.w3.org/2000/svg', 'line');
		gl.setAttribute('x1', String(PL)); gl.setAttribute('x2', String(W - PR));
		gl.setAttribute('y1', String(y)); gl.setAttribute('y2', String(y)); gl.setAttribute('class', 'wt-grid-line');
		svg.appendChild(gl);
		const lb = document.createElementNS('http://www.w3.org/2000/svg', 'text');
		lb.setAttribute('x', String(PL - 5)); lb.setAttribute('y', String(y + 4));
		lb.setAttribute('class', 'wt-axis-label'); lb.setAttribute('text-anchor', 'end');
		lb.textContent = String(Math.round(maxV - (maxV / 4) * i)); svg.appendChild(lb);
	}
	const yl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
	yl.setAttribute('x', '12'); yl.setAttribute('y', String(PT + pH / 2));
	yl.setAttribute('class', 'wt-axis-title'); yl.setAttribute('transform', `rotate(-90, 12, ${PT + pH / 2})`);
	yl.textContent = yLabel; svg.appendChild(yl);
	const gap = 4, bW = Math.max(4, (pW - gap * plotPoints.length) / plotPoints.length);
	const maxLb = 8, lEvery = Math.max(1, Math.ceil(plotPoints.length / maxLb));
	plotPoints.forEach((p, i) => {
		const bH = (p.value / maxV) * pH, x = PL + i * (bW + gap), y = PT + pH - bH;
		const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
		rect.setAttribute('x', String(x)); rect.setAttribute('y', String(y));
		rect.setAttribute('width', String(bW)); rect.setAttribute('height', String(Math.max(1, bH)));
		rect.setAttribute('rx', '2'); rect.setAttribute('fill', color);
		const tt = document.createElementNS('http://www.w3.org/2000/svg', 'title');
		tt.textContent = `${p.label}: ${p.value}`; rect.appendChild(tt);
		svg.appendChild(rect);
		if (i % lEvery === 0 || i === plotPoints.length - 1) {
			const xl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
			xl.setAttribute('x', String(x + bW / 2)); xl.setAttribute('y', String(H - 5));
			xl.setAttribute('class', 'wt-axis-label'); xl.setAttribute('text-anchor', 'middle');
			xl.textContent = p.label; svg.appendChild(xl);
		}
	});
	chartDiv.appendChild(svg);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SETTINGS TAB
// ═══════════════════════════════════════════════════════════════════════════════

class WorkoutSettingTab extends PluginSettingTab {
	plugin: WorkoutTrackerPlugin;
	constructor(app: App, plugin: WorkoutTrackerPlugin) { super(app, plugin); this.plugin = plugin; }

	display(): void {
		const { containerEl } = this; containerEl.empty();
		containerEl.createEl('h2', { text: 'Workout Ledger Settings' });
		new Setting(containerEl).setName('Daily-note folder').setDesc('Completed workouts automatically add a one-sentence rundown and time spent to Log. Pauses are excluded.').addText(text =>
			text.setValue(this.plugin.data.settings.dailyNoteFolder).onChange(async value => {
				this.plugin.data.settings.dailyNoteFolder = value.trim(); await this.plugin.savePluginData();
			})
		);
		new Setting(containerEl).setName('Daily-note template').setDesc('Vault-relative template path, used only when the daily note does not exist.').addText(text =>
			text.setValue(this.plugin.data.settings.dailyNoteTemplate).onChange(async value => {
				this.plugin.data.settings.dailyNoteTemplate = value.trim(); await this.plugin.savePluginData();
			})
		);
		new Setting(containerEl).setName('Sync workout summaries').setDesc('Repair or backfill daily Log entries from saved history without duplicating workouts.').addButton(button =>
			button.setButtonText('Sync now').onClick(() => { void this.plugin.syncDailyNotes(false); })
		);

		new Setting(containerEl).setName('Weight unit').setDesc('Cosmetic label shown next to weight fields.').addDropdown((dd) =>
			dd.addOption('lbs', 'lbs').addOption('kg', 'kg').setValue(this.plugin.data.settings.weightUnit)
				.onChange(async (v) => { this.plugin.data.settings.weightUnit = v as 'lbs' | 'kg'; await this.plugin.savePluginData(); })
		);
		new Setting(containerEl).setName('Default rest time (seconds)').setDesc('Rest duration used when adding new sets.').addText((text) =>
			text.setValue(String(this.plugin.data.settings.defaultRestSeconds)).onChange(async (v) => {
				const n = parseInt(v); if (!isNaN(n) && n >= 0) { this.plugin.data.settings.defaultRestSeconds = n; await this.plugin.savePluginData(); }
			})
		);
		new Setting(containerEl).setName('Rest timer sound').setDesc('Play a beep when rest timer reaches zero.').addToggle((toggle) =>
			toggle.setValue(this.plugin.data.settings.restTimerSound).onChange(async (v) => { this.plugin.data.settings.restTimerSound = v; await this.plugin.savePluginData(); })
		);
		new Setting(containerEl).setName('Rest timer vibration').setDesc('Vibrate on mobile when rest timer reaches zero.').addToggle((toggle) =>
			toggle.setValue(this.plugin.data.settings.restTimerVibrate).onChange(async (v) => { this.plugin.data.settings.restTimerVibrate = v; await this.plugin.savePluginData(); })
		);

		containerEl.createEl('h3', { text: 'Personal Records' });
		new Setting(containerEl).setName('Rebuild PRs').setDesc('Recalculate all personal records from workout history.').addButton((btn) =>
			btn.setButtonText('Rebuild').onClick(async () => {
				this.plugin.rebuildAllPRs(); await this.plugin.savePluginData(); new Notice('Personal records rebuilt from history.');
			})
		);

		containerEl.createEl('h3', { text: 'Data Management' });

		new Setting(containerEl).setName('Export data').setDesc('Export all workouts, history, and stats to a JSON file in your vault.').addButton((btn) =>
			btn.setButtonText('Export').onClick(async () => {
				const exportData: PluginData = JSON.parse(JSON.stringify(this.plugin.data));
				const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
				const fileName = `workout-ledger-export-${timestamp}.json`;
				const content = JSON.stringify(exportData, null, 2);
				await this.app.vault.create(fileName, content);
				new Notice(`Data exported to ${fileName}`);
			})
		);

		new Setting(containerEl).setName('Import data').setDesc('Import workouts, history, and stats from a previously exported JSON file.').addButton((btn) =>
			btn.setButtonText('Import').onClick(() => {
				new ImportDataModal(this.app, this.plugin).open();
			})
		);
	}
}

// ─── Import Data Modal ──────────────────────────────────────────────────────

class ImportDataModal extends Modal {
	plugin: WorkoutTrackerPlugin;
	constructor(app: App, plugin: WorkoutTrackerPlugin) { super(app); this.plugin = plugin; }

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h2', { text: 'Import Workout Data' });

		// Option 1: Pick from vault files
		const vaultSection = contentEl.createDiv({ cls: 'wt-import-section' });
		vaultSection.createEl('p', { text: 'Select a JSON export file from your vault:' });
		const fileSelect = vaultSection.createEl('select', { cls: 'wt-import-select' });
		fileSelect.style.width = '100%';
		fileSelect.style.marginBottom = '8px';

		const jsonFiles = this.app.vault.getFiles().filter(f => f.extension === 'json' && f.name.startsWith('workout-ledger-export') || f.name.startsWith('workout-tracker-export'));
		if (jsonFiles.length === 0) {
			const opt = fileSelect.createEl('option', { text: 'No export files found in vault' });
			opt.disabled = true;
		} else {
			jsonFiles.sort((a, b) => b.stat.mtime - a.stat.mtime);
			for (const f of jsonFiles) {
				fileSelect.createEl('option', { text: f.path, attr: { value: f.path } });
			}
		}

		const importVaultBtn = vaultSection.createEl('button', { text: 'Import from vault', cls: 'mod-cta' });
		importVaultBtn.style.marginRight = '8px';
		importVaultBtn.disabled = jsonFiles.length === 0;
		importVaultBtn.addEventListener('click', async () => {
			const path = fileSelect.value;
			const file = this.app.vault.getAbstractFileByPath(path);
			if (!file || !('extension' in file)) { new Notice('File not found.'); return; }
			try {
				const content = await this.app.vault.read(file as any);
				await this.doImport(content);
			} catch (e) {
				new Notice('Failed to read file: ' + (e as Error).message);
			}
		});

		// Option 2: Upload / paste (works on mobile too)
		const uploadSection = contentEl.createDiv({ cls: 'wt-import-section' });
		uploadSection.style.marginTop = '16px';
		uploadSection.createEl('p', { text: 'Or paste exported JSON data:' });
		const textArea = uploadSection.createEl('textarea', { cls: 'wt-import-textarea' });
		textArea.style.width = '100%';
		textArea.style.height = '120px';
		textArea.style.fontFamily = 'monospace';
		textArea.style.fontSize = '12px';
		textArea.placeholder = 'Paste JSON data here...';

		const importPasteBtn = uploadSection.createEl('button', { text: 'Import from text', cls: 'mod-cta' });
		importPasteBtn.addEventListener('click', async () => {
			const content = textArea.value.trim();
			if (!content) { new Notice('Please paste JSON data first.'); return; }
			await this.doImport(content);
		});

		// Import mode selector
		const modeSection = contentEl.createDiv({ cls: 'wt-import-section' });
		modeSection.style.marginTop = '16px';
		modeSection.style.padding = '12px';
		modeSection.style.backgroundColor = 'var(--background-secondary)';
		modeSection.style.borderRadius = '8px';
		modeSection.createEl('p', { text: 'Import mode:', cls: 'setting-item-name' });

		const modeSelect = modeSection.createEl('select', { cls: 'wt-import-select' });
		modeSelect.style.width = '100%';
		modeSelect.createEl('option', { text: 'Merge — add imported data alongside existing data', attr: { value: 'merge' } });
		modeSelect.createEl('option', { text: 'Replace — overwrite all existing data', attr: { value: 'replace' } });
		this.modeSelect = modeSelect;
	}

	private modeSelect!: HTMLSelectElement;

	private async doImport(content: string): Promise<void> {
		let imported: PluginData;
		try {
			imported = JSON.parse(content);
		} catch {
			new Notice('Invalid JSON data. Please check the file contents.');
			return;
		}

		// Validate structure
		if (!imported.workouts || !Array.isArray(imported.workouts) || !imported.history || !Array.isArray(imported.history)) {
			new Notice('Invalid data format. Expected workout ledger export data.');
			return;
		}

		const mode = this.modeSelect.value as 'merge' | 'replace';

		if (mode === 'replace') {
			this.plugin.data.workouts = imported.workouts || [];
			this.plugin.data.history = imported.history || [];
			this.plugin.data.lastUsed = imported.lastUsed || {};
			this.plugin.data.personalRecords = imported.personalRecords || {};
			this.plugin.data.plans = Array.isArray(imported.plans) ? imported.plans : [];
			this.plugin.data.currentPlanId = imported.currentPlanId;
			this.plugin.data.noPlanCollapsed = imported.noPlanCollapsed;
			if (imported.settings) {
				this.plugin.data.settings = Object.assign({}, DEFAULT_SETTINGS, imported.settings);
			}
		} else {
			// Merge plans — add those with ids that don't already exist (imported workouts reference them)
			const existingPlanIds = new Set(this.plugin.data.plans.map(p => p.id));
			for (const p of (Array.isArray(imported.plans) ? imported.plans : [])) {
				if (p && !existingPlanIds.has(p.id)) this.plugin.data.plans.push(p);
			}
			if (!this.plugin.data.currentPlanId && imported.currentPlanId) this.plugin.data.currentPlanId = imported.currentPlanId;

			// Merge workouts — add those with names that don't already exist
			const existingNames = new Set(this.plugin.data.workouts.map(w => w.name));
			for (const w of (imported.workouts || [])) {
				if (!existingNames.has(w.name)) {
					this.plugin.data.workouts.push(w);
				}
			}

			// Merge history — add entries with IDs that don't already exist
			const existingIds = new Set(this.plugin.data.history.map(h => h.id));
			for (const h of (imported.history || [])) {
				if (!existingIds.has(h.id)) {
					this.plugin.data.history.push(h);
				}
			}

			// Merge lastUsed — imported values override existing
			Object.assign(this.plugin.data.lastUsed, imported.lastUsed || {});
		}

		this.plugin.normalizeData();
		// Rebuild PRs from merged/replaced history
		this.plugin.rebuildAllPRs();
		await this.plugin.savePluginData();

		// Refresh any open views
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_TRACKER);
		for (const leaf of leaves) {
			(leaf.view as WorkoutTrackerView).render();
		}

		const count = mode === 'replace'
			? `Replaced with ${imported.workouts.length} workouts and ${imported.history.length} history entries.`
			: `Merged data. Check your workouts and history.`;
		new Notice(`Import complete! ${count}`);
		await this.plugin.syncDailyNotes();
		this.close();
	}

	onClose(): void { this.contentEl.empty(); }
}
