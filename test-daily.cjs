const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { buildSync } = require('esbuild');
const moment = require('moment');
let now = new Date('2026-09-16T18:00:00Z').getTime();
class FakeDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
class TFile { constructor(path) { this.path = path; } }
const notices = [];
const obsidian = {
  TFile, moment, normalizePath: x => x.replace(/\\/g, '/'),
  Plugin: class {}, ItemView: class {}, Modal: class {}, PluginSettingTab: class {},
  Notice: class { constructor(text) { notices.push(text); } }, Platform: { isMobile: false }
};
const code = buildSync({ stdin: { contents: fs.readFileSync('src/main.ts', 'utf8') + '\nexport { WorkoutTrackerView, workoutElapsedSeconds };\nexport * from "./daily-note";', resolveDir: process.cwd() + '/src', loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', external: ['obsidian'], write: false }).outputFiles[0].text;
const sandbox = { module: { exports: {} }, require: () => obsidian, Date: FakeDate };
vm.runInNewContext(code, sandbox);
const { default: Plugin, WorkoutTrackerView: View, workoutLogLine, upsertWorkoutLog, writeWorkoutDailyNote, workoutElapsedSeconds } = sandbox.module.exports;

function memoryVault(initial = {}) {
  const files = new Map(Object.entries(initial));
  let fail = false, creates = 0;
  return {
    files, get creates() { return creates; }, set fail(value) { fail = value; },
    getAbstractFileByPath(path) { return files.has(path) ? files.get(path) === null ? { path } : new TFile(path) : null; },
    async read(file) { return files.get(file.path); },
    async createFolder(path) { files.set(path, null); },
    async create(path, body) { if (files.has(path)) throw Error('exists'); creates++; files.set(path, body); return new TFile(path); },
    async process(file, update) { if (fail) throw Error('read only'); files.set(file.path, update(files.get(file.path))); }
  };
}
const entry = { id: 'session-1', workoutName: 'Upper', date: '2026-09-16T04:30:00Z', dailyNoteDate: '2026-09-15', dailyNoteTime: '23:30', totalDurationSeconds: 3671,
  exercises: [{ name: 'Bench press', sets: [{}, {}] }, { name: 'Row', sets: [{}] }, { name: 'Skipped', sets: [] }] };
const template = '---\ntype: daily\ndate: {{date}}\nworkout:\n---\n# {{date:YYYY-MM-DD}}\n\n## Atlas\nplan\n\n## Log\n\n## Journal\n';
const original = '---\nmood: great\n---\n## Atlas\nplan\n\n## Log\n- human activity\n\n## Journal\nPersonal prose\n## Log\n- private log\n';

(async () => {
  assert.equal(workoutLogLine(entry), '- 23:30 workout: Upper — 3 completed sets across Bench press, Row in 1 hr 1 min 11 sec. <!-- workout-ledger:session-1 -->');
  const updated = upsertWorkoutLog(original, entry);
  assert.equal(updated.slice(updated.indexOf('## Journal')), original.slice(original.indexOf('## Journal')));
  assert.ok(updated.startsWith(original.slice(0, original.indexOf('## Log'))));
  assert.equal(upsertWorkoutLog(updated, entry), updated, 'repeat sync is idempotent');
  const legacy = original.replace('- human activity', '- human activity\n- 23:30 workout: Old — 0 min <!-- workout-ledger:session-1 -->');
  const migrated = upsertWorkoutLog(legacy, entry);
  assert.equal((migrated.match(/workout-ledger:session-1/g) || []).length, 1);
  assert.ok(migrated.includes('1 hr 1 min 11 sec'));
  const missingLog = '## Atlas\nplan\n\n## Journal\nprotected\n## Log\nprivate\n';
  const inserted = upsertWorkoutLog(missingLog, entry);
  assert.equal(inserted.slice(inserted.indexOf('## Journal')), missingLog.slice(missingLog.indexOf('## Journal')));
  const crlf = upsertWorkoutLog(original.replace(/\n/g, '\r\n'), entry);
  assert.ok(!/(?<!\r)\n/.test(crlf), 'CRLF preserved');
  assert.ok(workoutLogLine({ ...entry, totalDurationSeconds: 11 }).includes('11 sec.'));
  assert.ok(workoutLogLine({ ...entry, exercises: [] }).includes('no completed sets'));
  assert.ok(!workoutLogLine({ ...entry, workoutName: 'Upper\n## Journal <script>' }).includes('\n'));
  const fenced = '```md\n## Journal\n```\n\n## Log\n\n## Journal\nprotected';
  assert.ok(upsertWorkoutLog(fenced, entry).indexOf('workout-ledger:') > fenced.indexOf('## Log'));

  const vault = memoryVault({ 'Home/Templates/Daily note.md': template });
  const app = { vault };
  assert.equal(await writeWorkoutDailyNote(app, entry, 'Journal', 'Home/Templates/Daily note.md'), true);
  assert.ok(vault.files.get('Journal/2026-09-15.md').includes('date: 2026-09-15'));
  assert.ok(!vault.files.get('Journal/2026-09-15.md').includes('{{date'));
  assert.equal(await writeWorkoutDailyNote(app, entry, 'Journal', 'Home/Templates/Daily note.md'), false);
  await writeWorkoutDailyNote(app, { ...entry, id: 'session-2' }, 'Journal', 'Home/Templates/Daily note.md');
  assert.equal((vault.files.get('Journal/2026-09-15.md').match(/workout-ledger:/g) || []).length, 2);
  const beforeInvalid = vault.creates;
  for (const folder of ['../Private', 'Private', '/absolute', '.obsidian', 'C:/elsewhere']) {
    await assert.rejects(() => writeWorkoutDailyNote(app, entry, folder, 'Home/Templates/Daily note.md'));
  }
  await assert.rejects(() => writeWorkoutDailyNote(app, { ...entry, date: 'invalid' }, 'Journal', 'Home/Templates/Daily note.md'));
  assert.equal(vault.creates, beforeInvalid);

  const plugin = new Plugin(); plugin.app = app;
  plugin.data = { workouts: [], lastUsed: {}, history: [entry], personalRecords: {}, settings: { dailyNoteFolder: 'Journal', dailyNoteTemplate: 'Home/Templates/Daily note.md', weightUnit: 'lbs' } };
  vault.fail = true;
  await plugin.syncDailyNotes();
  assert.equal(plugin.pendingDailyNotes.size, 1);
  assert.equal(plugin.data.history.length, 1, 'note failure retains history');
  vault.fail = false;
  await plugin.syncDailyNotes(true, true);
  assert.equal(plugin.pendingDailyNotes.size, 0, 'retry succeeds');
  await Promise.all([plugin.syncDailyNotes(), plugin.syncDailyNotes()]);
  assert.equal((vault.files.get('Journal/2026-09-15.md').match(/workout-ledger:session-1/g) || []).length, 1);

  const workout = { name: 'Early finish', supersets: [], exercises: [{ name: 'Squat', sets: [{ reps: 5, weight: 20, restSeconds: 30 }] }] };
  plugin.beginWorkout(workout);
  const state = plugin.activeState;
  now += 120000;
  state.totalPausedMs = 20000;
  state.isPaused = true; state.pauseStartTime = now;
  now += 90000;
  assert.equal(workoutElapsedSeconds(state), 100, 'current and previous pauses excluded');
  state.completedExercises = [{ name: 'Squat', sets: [{ reps: 5, weight: 20, setSeconds: 15, actualRestSeconds: 30 }] }];
  let saves = 0;
  plugin.savePluginData = async () => { saves++; };
  const view = new View({}, plugin);
  view.clearTimers = () => {}; view.navigateTo = () => {};
  await Promise.all([view.finishWorkout(), view.finishWorkout()]);
  assert.equal(saves, 1, 'duplicate finish does not record twice');
  assert.equal(plugin.data.history.length, 2);
  const completed = plugin.data.history[1];
  assert.equal(completed.totalDurationSeconds, 100);
  assert.ok(vault.files.get(`Journal/${completed.dailyNoteDate}.md`).includes('1 completed set across Squat in 1 min 40 sec.'));
  assert.equal(plugin.activeState, null);

  plugin.beginWorkout(workout);
  plugin.savePluginData = async () => { throw Error('disk full'); };
  view.render = () => {};
  await view.finishWorkout();
  assert.ok(plugin.activeState, 'history save failure retains active session');
  assert.equal(plugin.data.history.length, 2, 'history save failure rolls back in-memory entry');
  assert.equal(view.finishingWorkout, false);
  console.log('PASS: summaries, exact duration, pause accounting, legacy migration, idempotency, multiple sessions, protected Journal/Atlas/frontmatter, CRLF, templates, local date, invalid paths/data, retry, concurrent finish, and failed-save recovery');
})().catch(error => { console.error(error); process.exitCode = 1; });
