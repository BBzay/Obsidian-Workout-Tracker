# Workout Tracker for Obsidian

A full-featured workout tracker plugin for Obsidian that works on both desktop and mobile. Build workout templates, run timed sessions, track personal records, and review your history with charts and stats — all inside your vault.

## Features

### Home Screen
- See all your saved workouts at a glance
- Each workout card shows exercise/set count, estimated duration, and days since last completed
- Tap any workout to immediately start a session

### Active Workout Mode
- Step-by-step guided workout with a progress bar
- Built-in rest timer with configurable duration
- Sound ping and vibration alerts when rest is over (mobile supported)
- Displays your previous sets for each exercise so you know what to beat
- Superset support — exercises are interleaved automatically
- Log your actual weight and reps for each set as you go

### Edit Mode
- Create, duplicate, rename, and delete workout templates
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
5. Enable **Workout Tracker** in Settings → Community Plugins

### Manual Installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/BBzay/Obsidian-Workout-Tracker/releases/latest)
2. Create a folder in your vault: `<vault>/.obsidian/plugins/workout-tracker/`
3. Place the three files inside that folder
4. Open Obsidian → Settings → Community Plugins → Enable **Workout Tracker**

## Usage

### Getting Started

1. After enabling the plugin, click the **dumbbell icon** in the left sidebar to open the tracker
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
