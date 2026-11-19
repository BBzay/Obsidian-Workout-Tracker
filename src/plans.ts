// Plans group workouts into weekly programs. Days use Date.getDay() numbers (0 = Sunday).

export interface Plan {
	id: string;
	name: string;
	collapsed?: boolean;
}

export interface Schedulable {
	planId?: string;
	days?: number[];
}

export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** Display order: Monday-first, matching the stats week. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

export function weekRank(day: number): number {
	return (day + 6) % 7;
}

export function formatDays(days: number[] | undefined): string {
	if (!days || days.length === 0) return '';
	return [...days].sort((a, b) => weekRank(a) - weekRank(b)).map((d) => WEEKDAY_SHORT[d]).join(' · ');
}

/** Indices of the plan's workouts scheduled on `day`. No plan → none. */
export function workoutsOnDay(workouts: Schedulable[], planId: string | undefined, day: number): number[] {
	if (!planId) return [];
	const out: number[] = [];
	workouts.forEach((w, i) => { if (w.planId === planId && w.days?.includes(day)) out.push(i); });
	return out;
}

/** First upcoming day (1–6 days after `today`) that has workouts in the plan. */
export function nextScheduled(workouts: Schedulable[], planId: string | undefined, today: number): { indices: number[]; offset: number } | null {
	for (let offset = 1; offset <= 6; offset++) {
		const indices = workoutsOnDay(workouts, planId, (today + offset) % 7);
		if (indices.length > 0) return { indices, offset };
	}
	return null;
}

/** Workout indices for a plan group. Planned: Monday-first by earliest day, unscheduled last. Unplanned: original order. */
export function planWorkoutIndices(workouts: Schedulable[], planId: string | undefined): number[] {
	const indices: number[] = [];
	workouts.forEach((w, i) => { if ((w.planId ?? undefined) === planId) indices.push(i); });
	if (!planId) return indices;
	const firstDay = (i: number): number => {
		const days = workouts[i].days;
		return days && days.length ? Math.min(...days.map(weekRank)) : 7;
	};
	return indices.sort((a, b) => firstDay(a) - firstDay(b) || a - b);
}

/** Trimmed, non-empty locations, deduped case-insensitively (first spelling wins), sorted A–Z. */
export function distinctLocations(values: Array<string | undefined>): string[] {
	const byKey = new Map<string, string>();
	for (const raw of values) {
		const loc = typeof raw === 'string' ? raw.trim() : '';
		const key = loc.toLowerCase();
		if (loc && !byKey.has(key)) byKey.set(key, loc);
	}
	return [...byKey.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

/** Repair plan data from older versions, imports, or hand edits. Mutates `data`. */
export function normalizePlanData(data: { plans?: unknown; currentPlanId?: string; workouts: Schedulable[] }): void {
	const seen = new Set<string>();
	const plans: Plan[] = [];
	if (Array.isArray(data.plans)) {
		for (const raw of data.plans as Partial<Plan>[]) {
			if (!raw || typeof raw.id !== 'string' || !raw.id || seen.has(raw.id)) continue;
			seen.add(raw.id);
			const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name : 'Untitled plan';
			plans.push({ ...raw, id: raw.id, name });
		}
	}
	data.plans = plans;

	for (const w of data.workouts) {
		if (w.planId !== undefined && !seen.has(w.planId)) delete w.planId;
		if (w.days !== undefined) {
			const valid = Array.isArray(w.days) ? w.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) : [];
			const days = [...new Set(valid)].sort((a, b) => weekRank(a) - weekRank(b));
			if (days.length) w.days = days; else delete w.days;
		}
	}

	if (data.currentPlanId !== undefined && !seen.has(data.currentPlanId)) delete data.currentPlanId;
}
