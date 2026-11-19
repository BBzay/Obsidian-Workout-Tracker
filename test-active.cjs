const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const { transformSync } = require('esbuild');
let now = 100000;
const FakeDate = class extends Date { static now() { return now; } };
const opened = [];
const obsidian = {
	Plugin: class {}, ItemView: class {}, PluginSettingTab: class {}, Notice: class {}, Platform: { isMobile: false },
	Modal: class { constructor(app) { this.app = app; } open() { opened.push(this); } close() {} },
};
const sandbox = { module: { exports: {} }, require: () => obsidian, Date: FakeDate };
vm.runInNewContext(transformSync(fs.readFileSync('src/main.ts', 'utf8') + '\nexport { WorkoutTrackerView, applyLoggedSetsToTemplate };', { loader: 'ts', format: 'cjs', target: 'es2020' }).code, sandbox);
const { default: Plugin, WorkoutTrackerView: View, applyLoggedSetsToTemplate } = sandbox.module.exports;

const key = (s) => `${s.exerciseIndex}:${s.setIndex}`;
const json = (x) => JSON.stringify(x);
const tick = () => new Promise((r) => setImmediate(r));
// A, B, C × 2 sets. Set 1 rests 30s, set 2 none. Steps: 0 A1, 1 A2, 2 B1, 3 B2, 4 C1, 5 C2
const workout = { name: 'Test', supersets: [], exercises: ['A', 'B', 'C'].map((name) => ({ name, modifier: '', sets: [{ reps: 5, weight: 10, restSeconds: 30 }, { reps: 6, weight: 20, restSeconds: 0 }] })) };
const template = json(workout);

function setup() {
	const plugin = new Plugin();
	plugin.savePluginData = async () => {};
	plugin.data = { workouts: [JSON.parse(template)], history: [{ id: 'old', workoutName: 'Old', date: '2026-01-01T00:00:00.000Z', totalDurationSeconds: 1, exercises: [] }], lastUsed: { 'Test|A|0': { reps: 1, weight: 1 } }, personalRecords: {}, plans: [], settings: { weightUnit: 'lbs', restTimerSound: false, restTimerVibrate: false } };
	const view = new View({}, plugin);
	view.render = () => {}; view.contentEl = { querySelector: () => null }; view.app = {};
	return { plugin, view };
}

(async () => {
	// ── Plan order, jumping, drafts, timers ──
	{
		const { plugin, view } = setup();
		plugin.beginWorkout(workout);
		const state = plugin.activeState;
		const planOrder = state.steps.map(key).join();
		assert.equal(planOrder, '0:0,0:1,1:0,1:1,2:0,2:1');
		assert.equal(state.currentReps, 1, 'first set uses remembered values');
		assert.equal(state.setStarted, false); now += 20000; view.tickActiveTimer(); assert.equal(state.setElapsed, 0, 'ready sets do not time');

		state.currentReps = 12; state.currentWeight = 45;
		view.jumpToStep(2); assert.equal(state.currentStepIndex, 2); assert.equal(state.currentReps, 5, 'B1 target');
		view.jumpToStep(0); assert.equal(state.currentReps, 12); assert.equal(state.currentWeight, 45, 'typed values survive jumping away and back');

		view.startCurrentSet(); now += 6000; view.tickActiveTimer(); assert.equal(state.setElapsed, 6);
		view.jumpToStep(4); assert.equal(state.currentStepIndex, 0, 'a running set cannot be displaced');
		view.pauseWorkout(); view.jumpToStep(4); assert.equal(state.currentStepIndex, 0, 'no jumping while paused');
		now += 10000; view.tickActiveTimer(); assert.equal(state.setElapsed, 6); view.resumeWorkout(); now += 2000; view.tickActiveTimer(); assert.equal(state.setElapsed, 8);

		await view.completeCurrentSet();
		assert.equal(state.completedExercises[0].sets[0].setSeconds, 8); assert.equal(state.isResting, true);
		assert.equal(state.stepHistory.length, 1);
		assert.equal(json(state.lastUsedBefore), json({ 'Test|A|0': { reps: 1, weight: 1 } }), 'original remembered value kept for Discard');
		assert.equal(json(plugin.data.lastUsed['Test|A|0']), json({ reps: 12, weight: 45 }));

		// During rest a tap picks the next set; done sets and plan order are untouched
		view.jumpToStep(4); assert.equal(state.nextStepIndex, 4); assert.equal(state.isResting, true);
		view.jumpToStep(0); assert.equal(state.nextStepIndex, 4, 'done sets cannot be picked');
		assert.equal(view.getUpNextStep(state), 4);
		assert.equal(state.steps.map(key).join(), planOrder, 'plan order never changes');
		now += 9000; view.advanceFromRest();
		assert.equal(state.stepHistory[0].completedSet.actualRestSeconds, 9);
		assert.equal(state.completedExercises[0].sets[0], state.stepHistory[0].completedSet, 'history and log share one set object');
		assert.equal(state.currentStepIndex, 4, 'rest goes to the picked set'); assert.equal(state.setStarted, true); assert.equal(state.nextStepIndex, undefined);

		view.goBackToLastSet();
		assert.equal(state.currentStepIndex, 0); assert.equal(state.completedExercises.length, 0); assert.equal(state.stepHistory.length, 0); assert.equal(state.setStarted, false);
		assert.equal(state.currentReps, 12);
		now += 5000; view.tickActiveTimer(); assert.equal(state.setElapsed, 0);

		// Skip leaves the set open and moves on in plan order
		view.skipCurrentSet(); assert.equal(state.currentStepIndex, 1); assert.equal(state.setStarted, false);
		await view.completeCurrentSet(); assert.equal(state.stepHistory.length, 0, 'ready sets cannot be completed accidentally');

		// Out of order: A2 first (no rest → next open in plan order), then back to the skipped A1
		view.startCurrentSet(); await view.completeCurrentSet();
		assert.equal(state.isResting, false); assert.equal(state.currentStepIndex, 2, 'A2 has no rest; B1 is next open');
		view.jumpToStep(0); assert.equal(state.currentReps, 12, 'skipped set kept its draft');
		view.startCurrentSet(); await view.completeCurrentSet();
		assert.equal(json(state.completedExercises[0].sets.map((s) => s.reps)), json([12, 6]), "an exercise's sets stay in plan order");
		assert.equal(state.isResting, true);
		view.advanceFromRest(); assert.equal(state.currentStepIndex, 2, 'default next = first open after A1');

		await view.completeCurrentSet(); view.advanceFromRest(); // B1 → rest → B2
		assert.equal(state.currentStepIndex, 3);
		await view.completeCurrentSet(); // B2, no rest → C1 ready
		assert.equal(state.currentStepIndex, 4); assert.equal(state.setStarted, false);
		view.skipCurrentSet(); assert.equal(state.currentStepIndex, 5);
		view.skipCurrentSet(); assert.equal(state.currentStepIndex, 4, 'skip wraps to the first open set');
		view.startCurrentSet(); await view.completeCurrentSet(); view.advanceFromRest(); // C1 → rest → C2
		assert.equal(state.currentStepIndex, 5);

		opened.length = 0;
		view.skipCurrentSet();
		assert.equal(state.currentStepIndex, 5, 'skipping the last open set does not move');
		assert.equal(opened.length, 1, 'it offers to end instead');
		assert.match(opened[0].detail, /^5 of 6 sets logged · /);
		assert.equal(json(plugin.data.history.length), '1', 'nothing saved yet');

		// Completing the final open set saves the workout
		opened.length = 0;
		await view.completeCurrentSet();
		assert.equal(plugin.activeState, null);
		assert.equal(plugin.data.history.length, 2);
		const saved = plugin.data.history[1];
		assert.equal(json(saved.exercises.map((e) => e.name)), json(['A', 'B', 'C']));
		assert.equal(json(saved.exercises[0].sets.map((s) => s.reps)), json([12, 6]));
		const update = opened.find((m) => typeof m.onUpdate === 'function');
		assert.ok(update, 'asks to update the template');
		await update.onUpdate();
		const tmpl = plugin.data.workouts[0];
		assert.equal(json(tmpl.exercises[0].sets.map((s) => [s.reps, s.weight])), json([[12, 45], [6, 20]]), 'template updated by set number');
		assert.equal(json(workout), template, 'the source workout object is never mutated');
	}

	// ── Discard from the End dialog ──
	{
		const { plugin, view } = setup();
		const historyBefore = json(plugin.data.history);
		plugin.beginWorkout(workout);
		const state = plugin.activeState;
		view.startCurrentSet(); await view.completeCurrentSet(); view.advanceFromRest(); // A1 (existing key)
		await view.completeCurrentSet(); // A2 (new key)
		assert.equal(json(Object.keys(plugin.data.lastUsed).sort()), json(['Test|A|0', 'Test|A|1']));
		opened.length = 0;
		view.openEndDialog();
		const end = opened[0];
		assert.match(end.detail, /^2 of 6 sets logged · /);
		end.onDiscard(); await tick();
		assert.equal(plugin.activeState, null, 'session is gone');
		assert.equal(json(plugin.data.history), historyBefore, 'nothing written to history');
		assert.equal(json(plugin.data.lastUsed), json({ 'Test|A|0': { reps: 1, weight: 1 } }), 'remembered weights restored, new keys removed');
		assert.equal(json(plugin.data.personalRecords), '{}');
		assert.equal(view.screen, 'home');
		assert.equal(state.stepHistory.length, 2);

		plugin.beginWorkout(workout);
		opened.length = 0;
		view.openEndDialog();
		assert.match(opened[0].detail, /^No sets logged yet · /);
	}

	// ── The plan's last set keeps its rest when other sets are still open ──
	{
		const { plugin, view } = setup();
		plugin.beginWorkout({ name: 'Two', supersets: [], exercises: [{ name: 'X', modifier: '', sets: [{ reps: 5, weight: 0, restSeconds: 45 }, { reps: 5, weight: 0, restSeconds: 45 }] }] });
		const state = plugin.activeState;
		view.skipCurrentSet(); view.startCurrentSet(); await view.completeCurrentSet();
		assert.equal(state.isResting, true); assert.equal(state.restRemaining, 45, 'X2 rests because X1 is still open');
		view.advanceFromRest(); assert.equal(state.currentStepIndex, 0);
		await view.completeCurrentSet();
		assert.equal(plugin.activeState, null, 'last open set finishes without resting');
	}

	// ── Review regressions ──
	{
		// Two exercises with the same name keep their blocks separate in history
		const { plugin, view } = setup();
		const s = (reps) => ({ reps, weight: 0, restSeconds: 0 });
		plugin.beginWorkout({ name: 'Dup', supersets: [], exercises: [
			{ name: 'Bench', modifier: '', sets: [s(1), s(2)] }, { name: 'Row', modifier: '', sets: [s(3)] }, { name: 'Bench', modifier: '', sets: [s(4), s(5)] }] });
		// Each set lasts its plan position + 1 seconds, so sets are identifiable (reps would collide:
		// remembered values are keyed by exercise name + set number).
		for (let i = 0; i < 5; i++) { view.startCurrentSet(); now += (i + 1) * 1000; await view.completeCurrentSet(); } // last → finish
		const bench = plugin.data.history.at(-1).exercises.find((e) => e.name === 'Bench');
		assert.equal(json(bench.sets.map((x) => x.setSeconds)), json([1, 2, 4, 5]), 'warm-up block stays before working block');
		assert.equal(view.justCompletedStep, -1, 'no stale green flash for the next workout');
	}
	{
		// While a finish is saving, the session can't change and End can't reopen
		const { plugin, view } = setup();
		plugin.beginWorkout(workout);
		const state = plugin.activeState;
		view.startCurrentSet(); await view.completeCurrentSet(); view.advanceFromRest(); // A1 done, A2 running
		let release; plugin.savePluginData = () => new Promise((r) => { release = r; });
		const finishing = view.finishWorkout();
		await view.completeCurrentSet(); view.jumpToStep(4); view.skipCurrentSet(); view.goBackToLastSet();
		opened.length = 0; view.openEndDialog();
		assert.equal(state.stepHistory.length, 1, 'no extra set logged during save'); assert.equal(state.currentStepIndex, 1);
		assert.equal(opened.length, 0, 'End cannot reopen mid-save');
		release(); await finishing;
		assert.equal(plugin.data.history.at(-1).exercises[0].sets.length, 1);
	}
	{
		// Failed final save: the logged last set can't be started/logged again
		const { plugin, view } = setup();
		plugin.beginWorkout({ name: 'One', supersets: [], exercises: [{ name: 'X', modifier: '', sets: [{ reps: 5, weight: 0, restSeconds: 0 }] }] });
		const state = plugin.activeState;
		plugin.savePluginData = async () => { throw new Error('disk full'); };
		view.startCurrentSet(); await view.completeCurrentSet();
		assert.equal(plugin.activeState, state, 'session stays open after a failed save');
		assert.equal(plugin.data.history.length, 1, 'failed entry rolled back');
		view.startCurrentSet(); await view.completeCurrentSet();
		assert.equal(state.stepHistory.length, 1, 'done set is not logged twice');
		// Starting another workout never replaces the running one
		plugin.beginWorkout(workout);
		assert.equal(plugin.activeState, state);
	}
	{
		// Back keeps what was typed for the set being left
		const { plugin, view } = setup();
		plugin.beginWorkout(workout);
		const state = plugin.activeState;
		view.startCurrentSet(); await view.completeCurrentSet(); view.advanceFromRest(); await view.completeCurrentSet(); // A1, A2 → B1 ready
		state.currentReps = 77;
		view.goBackToLastSet(); assert.equal(state.currentStepIndex, 1);
		view.jumpToStep(2); assert.equal(state.currentReps, 77);
	}

	// ── Template mapping helper ──
	{
		const t = JSON.parse(template);
		applyLoggedSetsToTemplate(t, [{ exerciseIndex: 0, exerciseName: 'A', setIndex: 1, set: { reps: 9, weight: 99 } }]);
		assert.equal(json(t.exercises[0].sets.map((s) => [s.reps, s.weight])), json([[5, 10], [9, 99]]));
		applyLoggedSetsToTemplate(t, [{ exerciseIndex: 0, exerciseName: 'C', setIndex: 0, set: { reps: 3, weight: 33 } }]);
		assert.equal(json(t.exercises[2].sets[0]), json({ reps: 3, weight: 33, restSeconds: 30 }), 'falls back to the exercise name');
		assert.equal(json(t.exercises[0].sets[0]), json({ reps: 5, weight: 10, restSeconds: 30 }));
	}

	console.log('PASS: plan order kept, jump/pick-next, drafts, timers, skip wrap, out-of-order sets, back, end dialog, save + template by set number, discard restores remembered weights, last-set rest');
})().catch((e) => { console.error(e); process.exitCode = 1; });
