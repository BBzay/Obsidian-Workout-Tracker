const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const { buildSync } = require('esbuild');
// 2026-11-16 is a Monday (local time)
let now = new Date(2026, 10, 16, 9, 0, 0).getTime();
class FakeDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
const notices = [];
const obsidian = {
  Plugin: class {}, ItemView: class {}, Modal: class {}, PluginSettingTab: class {}, Menu: class {},
  Notice: class { constructor(text) { notices.push(text); } }, Platform: { isMobile: false },
};
const code = buildSync({ stdin: { contents: fs.readFileSync('src/main.ts', 'utf8') + '\nexport * from "./plans";', resolveDir: process.cwd() + '/src', loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', external: ['obsidian'], write: false }).outputFiles[0].text;
const sandbox = { module: { exports: {} }, require: () => obsidian, Date: FakeDate };
vm.runInNewContext(code, sandbox);
const { default: Plugin, formatDays, workoutsOnDay, nextScheduled, planWorkoutIndices, normalizePlanData } = sandbox.module.exports;

const w = (name, planId, days) => ({ name, planId, days, exercises: [{ name: name + ' ex', modifier: '', sets: [{ reps: 5, weight: 10, restSeconds: 0 }] }], supersets: [] });

(async () => {
  // ── formatting ──
  assert.equal(formatDays([5, 1, 3]), 'Mon · Wed · Fri');
  assert.equal(formatDays([0, 6]), 'Sat · Sun', 'Sunday sorts last (Monday-first week)');
  assert.equal(formatDays([]), '');
  assert.equal(formatDays(undefined), '');

  // ── scheduling ──
  const workouts = [w('Legs', 'p1', [5]), w('Push', 'p1', [1, 4]), w('Other plan Monday', 'p2', [1]), w('Loose', undefined, [1]), w('Pull', 'p1', [3]), w('Unscheduled', 'p1')];
  assert.deepEqual([...workoutsOnDay(workouts, 'p1', 1)], [1], 'only the current plan counts');
  assert.deepEqual([...workoutsOnDay(workouts, undefined, 1)], [], 'no current plan → nothing today');
  assert.deepEqual([...workoutsOnDay(workouts, 'p1', 2)], [], 'Tuesday is a rest day');
  const next = nextScheduled(workouts, 'p1', 2);
  assert.deepEqual([...next.indices], [4]); assert.equal(next.offset, 1, 'Pull on Wednesday is tomorrow from Tuesday');
  const wrap = nextScheduled(workouts, 'p1', 6);
  assert.deepEqual([...wrap.indices], [1]); assert.equal(wrap.offset, 2, 'Saturday → Monday wraps the week');
  assert.equal(nextScheduled(workouts, 'p9', 1), null);
  assert.deepEqual([...planWorkoutIndices(workouts, 'p1')], [1, 4, 0, 5], 'plan workouts sort Monday-first, unscheduled last');
  assert.deepEqual([...planWorkoutIndices(workouts, undefined)], [3], 'unplanned group keeps original order');

  // ── normalization ──
  const data = { plans: [{ id: 'p1', name: 'A' }, { id: 'p1', name: 'dupe' }, { id: '', name: 'bad' }, null, { id: 'p2', name: '  ' }], currentPlanId: 'gone',
    workouts: [{ name: 'x', planId: 'missing', days: [1, 1, 9, -1, 'x', 0] }, { name: 'y', planId: 'p2', days: [] }, { name: 'z' }] };
  normalizePlanData(data);
  assert.deepEqual([...data.plans.map(p => p.id)], ['p1', 'p2']);
  assert.equal(data.plans[1].name, 'Untitled plan');
  assert.equal(data.currentPlanId, undefined, 'dangling current plan cleared');
  assert.equal(data.workouts[0].planId, undefined, 'dangling planId dropped');
  assert.deepEqual([...data.workouts[0].days], [1, 0], 'days deduped, filtered, Monday-first');
  assert.equal('days' in data.workouts[1], false, 'empty days removed');
  assert.equal(data.workouts[1].planId, 'p2');
  const noPlans = { workouts: [] }; normalizePlanData(noPlans); assert.deepEqual([...noPlans.plans], []);

  // ── plugin load keeps older data working and does not share default arrays ──
  const legacy = new Plugin(); legacy.loadData = async () => ({ workouts: [{ name: 'Old', exercises: [] }], history: [] });
  await legacy.loadPluginData();
  assert.deepEqual([...legacy.data.plans], []); assert.deepEqual([...legacy.data.workouts[0].supersets], []);
  legacy.data.plans.push({ id: 'leak', name: 'Leak' });
  const fresh = new Plugin(); fresh.loadData = async () => null; await fresh.loadPluginData();
  assert.deepEqual([...fresh.data.plans], [], 'default plans array is not shared between loads');

  // ── today's workout ──
  const plugin = new Plugin(); plugin.savePluginData = async () => {}; plugin.activateView = async () => {};
  plugin.loadData = async () => ({ workouts: JSON.parse(JSON.stringify(workouts)), history: [], plans: [{ id: 'p1', name: 'Summer' }, { id: 'p2', name: 'Winter' }], currentPlanId: 'p1' });
  await plugin.loadPluginData();
  assert.deepEqual([...plugin.getTodayWorkouts().map(x => x.name)], ['Push']);
  await plugin.startTodaysWorkout();
  assert.equal(plugin.activeState.workout.name, 'Push', 'command starts the single workout scheduled today');

  plugin.activeState = null; now = new Date(2026, 10, 17, 9).getTime(); // Tuesday
  assert.deepEqual([...plugin.getTodayWorkouts()], []);
  await plugin.startTodaysWorkout();
  assert.equal(plugin.activeState, null, 'rest day starts nothing');
  assert.match(notices.at(-1), /Rest day.*Pull.*tomorrow/i);

  plugin.data.currentPlanId = undefined;
  await plugin.startTodaysWorkout();
  assert.match(notices.at(-1), /current plan/i);

  plugin.data.currentPlanId = 'p1'; plugin.activeState = { workout: { name: 'Busy' } }; now = new Date(2026, 10, 16, 9).getTime();
  await plugin.startTodaysWorkout();
  assert.equal(plugin.activeState.workout.name, 'Busy', 'never replaces a workout already in progress');

  console.log('PASS: day formatting, current-plan-only scheduling, rest-day next-up with week wrap, plan ordering, normalization, legacy load, today command');
})().catch(e => { console.error(e); process.exitCode = 1; });
