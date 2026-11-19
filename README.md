# Workout Ledger for Obsidian

A full-featured workout ledger plugin for Obsidian that works on both desktop and mobile. Build workout templates, run timed sessions, track personal records, and review your history with charts and stats — all inside your vault.

## Features

### Home Screen
- See all your saved workouts at a glance
- Each workout card shows exercise/set count, estimated duration, and days since last completed
- Tap any workout to immediately start a session

### Plans & Weekly Schedule
- Group workouts into **plans** (e.g. "Summer Strength") that fold up on the Home screen, so a long list stays tidy
- Put each workout on one or more **weekdays** (Edit → Days)
- Mark one plan as **current**: today's workout from that plan sits at the top of Home, open and ready to start
- On rest days, Home shows what's next ("Next up: Pull Day tomorrow")
- Plan menu (⋯): set as current, new workout in plan, add existing workouts, rename, reorder, delete (workouts move to "No plan", nothing else is lost)
- Command: **Start today's workout**

### Active Workout Mode
- Step-by-step guided workout with a progress bar
- **Workout plan** list: every exercise in order with a button per set. Done sets fade green, so what's left is obvious
- Skip around: tap any unfinished set (or exercise) to jump to it; during rest, the tap picks what's next. Skip leaves a set open to come back to
- **End → Save or Discard**: Discard throws the session away (no history, PRs or daily-note entry; remembered weights restored)
- Built-in rest timer with configurable duration
- Sound ping and vibration alerts when rest is over (mobile supported)
- Displays your previous sets for each exercise so you know what to beat
- Superset support — exercises are interleaved automatically
- Log your actual weight and reps for each set as you go

### Edit Mode
- Create, duplicate, rename, and delete workout templates
- **Location** per workout (e.g. "Home gym"), shown on Home and Today cards and on the rest-day "Next up" card
- Add exercises with custom sets, reps, and weight targets
- Drag-and-drop reordering (with up/down buttons on mobile)
- Exercise name autocomplete based on your workout history
- Group exercises into supersets

### History & Stats
- **History tab**: Scrollable log of every completed workout with date, duration, and total volume
- **Stats tab**: Summary cards (total workouts, volume, avg duration, streak), line/bar charts, and per-exercise breakdowns
- Filter by workout name
- Switch between **Weekly**, **Monthly**, **Yearly**, and **All Time** views
- Navigate forward/backward through time periods with arrow buttons
- Handles months and years of data with automatic point aggregation in charts

### Personal Records (PRs)
- Automatically detects 4 types of PRs for every exercise:
  - **Max Weight** — heaviest weight lifted
  - **Max Volume** — highest single-set volume (weight x reps)
  - **Max Reps** — most reps in a single set
  - **Max Estimated 1RM** — highest estimated one-rep max (Epley formula)
- PR badges shown on the completion screen when you set a new record
- Full PR table in the Stats tab

### Settings
- Default rest timer duration
- Toggle rest timer sound on/off
- Toggle rest timer vibration on/off (mobile)

## Installation

### With BRAT (Recommended for Beta Testing)

1. Install the [BRAT plugin](https://github.com/TfTHacker/obsidian42-brat) in Obsidian
2. Open BRAT settings and click **"Add Beta plugin"**
3. Enter this repo URL: `https://github.com/BBzay/Obsidian-Workout-Tracker`
4. Click **Add Plugin**
5. Enable **Workout Ledger** in Settings → Community Plugins

### Manual Installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/BBzay/Obsidian-Workout-Tracker/releases/latest)
2. Create a folder in your vault: `<vault>/.obsidian/plugins/workout-ledger/`
3. Place the three files inside that folder
4. Open Obsidian → Settings → Community Plugins → Enable **Workout Ledger**

## Usage

### Getting Started

1. After enabling the plugin, click the **dumbbell icon** in the left sidebar to open the ledger
2. Tap the **pencil icon** (top right) to enter Edit Mode
3. Create your first workout — give it a name, add exercises, set your target sets/reps/weight
4. Tap the **back arrow** to return to the Home screen
5. Tap a workout card to start your session

### During a Workout

1. Each step shows the current exercise, target reps, and suggested weight
2. Enter your actual weight and reps, then tap **Complete Set**
3. A rest timer starts automatically between sets — wait for the alert or tap **Skip Rest**
4. When all sets are done, you'll see a completion summary with any new PRs

### Reviewing Your Progress

1. Tap the **chart icon** (top right on the Home screen) to open History & Stats
2. Use the **History** tab to browse past workouts
3. Use the **Stats** tab to see charts, summary stats, and your PR table
4. Filter by workout name and change the time range to zoom in or out

## Building from Source

```bash
# Install dependencies
npm install

# Development (watch mode)
npm run dev

# Production build
npm run build
```

The build outputs `main.js` in the project root.

## License

MIT

## 1.4.0 changes

Start Workout waits for Start Set. Upcoming exercises stay expanded with Choose/Do next controls that reorder only unfinished sets. Finish or skip a running set before switching. Start Next Set explicitly starts timing; other transitions return to ready. Pause/Back/Skip are preserved. `npm run build` and `node test-active.cjs` validate the build and active-state regressions. Included in the 1.5.0 BRAT release.

## 1.5.0 changes

Finishing a workout now writes one sentence to that day's daily-note Log immediately, with the workout name, completed set count, up to four exercise names and exact time spent. Time runs from Start Workout to completion, includes rests and preparation, and excludes pauses (including ending while paused). No manual text entry or Atlas command is required.

Startup, imported history and externally synced plugin data also synchronize summaries. Failed daily-note writes keep workout history intact and retry every minute while Obsidian is open; the Sync workout summaries to daily notes command repairs/backfills entries on demand. Stable workout markers update older Atlas entries without duplicates; existing Atlas, frontmatter and Journal prose stay untouched. Defaults use Journal/YYYY-MM-DD.md and Home/Templates/Daily note.md, configurable in Workout Ledger settings. New sessions retain their local completion date/time across time zones. Active sessions remain in memory as before; finish before reloading.

Validation: `npm run build`, `node test-active.cjs`, `node test-daily.cjs`, `node --check main.js`. Published through BRAT. After completing any active workout, run BRAT update check, restart Obsidian and confirm version 1.5.0. Actual phone operation requires device verification.

## 1.6.0 changes

Plans group workouts into foldable sections on Home (fold state is remembered). Each workout can belong to one plan and be assigned weekdays in Edit mode. One plan is "current": its workout for today appears at the top of Home with Start ready, rest days show the next scheduled workout, and the "Start today's workout" command starts it directly (it never replaces a workout already in progress). Workouts outside any plan appear under "No plan"; with no plans at all, Home looks as before. History, PRs and remembered weights are untouched because plan membership is stored on the workout. Export/import carries plans.

Validation: `npm run build`, `npm test` (`test-active.cjs`, `test-daily.cjs`, `test-plans.cjs`), `node --check main.js`. Published through BRAT. After completing any active workout, run BRAT update check, restart Obsidian and confirm version 1.6.0. Actual phone operation requires device verification.

## 1.7.0 changes

Each workout can have a location (Edit → Location, with suggestions from your other workouts); it shows under the workout name on Home and Today cards and on the rest-day card for the next workout. During a workout, the Choose/Do next buttons are replaced by a Workout plan list: every exercise in plan order with a button per set. Done sets fade green; tap any unfinished set or exercise to jump there (while resting, the tap picks the next set and the rest timer keeps running). Skip leaves a set unfinished and moves to the next open one, wrapping around; skipping the last open set offers to end. End now asks Save workout / Discard / Keep going; Discard needs a second tap and saves nothing (remembered weights the session changed are restored). Sets done out of order are logged and copied to the template under the right set number.

Validation: `npm run build`, `npm test` (`test-active.cjs`, `test-daily.cjs`, `test-plans.cjs`), `node --check main.js`. Published through BRAT. After completing any active workout, run BRAT update check, restart Obsidian and confirm version 1.7.0. Actual phone operation requires device verification.

## Release delivery

Commit reviewed source and generated package with matching manifest/package version and versions.json entry. Push a matching version tag; GitHub Actions tests, rebuilds and publishes the three BRAT assets, then verifies public downloads. Local installs alone do not update other devices. Never publish settings, personal workout history or vault notes.
