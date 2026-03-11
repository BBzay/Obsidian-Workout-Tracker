# My Obsidian Plugin

An Obsidian plugin targeting both desktop and mobile platforms.

## Folder Structure

```
my-obsidian-plugin/
├── src/
│   ├── main.ts           # Plugin entry point (MyPlugin class, onload/onunload)
│   ├── settings.ts       # Settings interface, defaults, and PluginSettingTab
│   ├── views/            # ItemView subclasses (custom side panels, tabs)
│   ├── modals/           # Modal subclasses (popups, dialogs)
│   └── utils/            # Shared helper functions and utilities
├── styles.css            # Plugin CSS
├── manifest.json         # Plugin metadata (id, name, version, minAppVersion)
├── versions.json         # Version-to-minAppVersion compatibility map
├── esbuild.config.mjs    # Build configuration
├── tsconfig.json         # TypeScript config (strict mode, react-jsx)
└── package.json          # Dependencies and scripts
```

## Key Commands

- `npm run dev` — Start esbuild in watch mode (rebuilds on every save)
- `npm run build` — Type-check with tsc then produce a production build

## Important Rules

- **Always use `this.register*()` methods** for events and intervals — they auto-cleanup on plugin unload:
  - `this.registerEvent(...)` for vault/workspace events
  - `this.registerDomEvent(...)` for DOM events
  - `this.registerInterval(window.setInterval(...))` for timers (use `window.setInterval`, not bare `setInterval`)
- **Use `this.contentEl`** inside `ItemView.onOpen()` — never use `this.containerEl.children[1]`, it is fragile in newer Obsidian versions.
- **Use `Platform.isMobile`** to guard mobile-specific code paths. Never call Node.js APIs (`fs`, `path`, `child_process`) or Electron APIs without a desktop-only check.
- **Settings persistence**: always use `this.loadData()` / `this.saveData()` — never roll your own file I/O for settings.
- **`manifest.json` changes require a full Obsidian restart** to take effect.
- **Wrap view registration in `this.app.workspace.onLayoutReady()`** to prevent startup crashes.

## Testing Locally

1. Run `npm run build` (or `npm run dev` for watch mode)
2. Copy these files into your vault:
   ```
   <vault>/.obsidian/plugins/my-obsidian-plugin/main.js
   <vault>/.obsidian/plugins/my-obsidian-plugin/manifest.json
   <vault>/.obsidian/plugins/my-obsidian-plugin/styles.css
   ```
3. Open Obsidian → Settings → Community Plugins → Enable "My Obsidian Plugin"

**Tip:** Install the [Hot Reload](https://github.com/pjeby/hot-reload) plugin to auto-reload on file changes during development (place a `.hotreload` file in your plugin folder).
