import { Notice, Platform, Plugin } from 'obsidian';
import { DEFAULT_SETTINGS, MyPluginSettingTab } from './settings';
import type { MyPluginSettings } from './settings';

// View type constant — update this when you add a custom view
// import { VIEW_TYPE_EXAMPLE, ExampleView } from './views/example-view';

export default class MyPlugin extends Plugin {
	settings: MyPluginSettings = DEFAULT_SETTINGS;

	async onload(): Promise<void> {
		await this.loadSettings();

		// Register the settings tab
		this.addSettingTab(new MyPluginSettingTab(this.app, this));

		// Placeholder command
		this.addCommand({
			id: 'placeholder-command',
			name: 'Placeholder Command',
			callback: () => {
				new Notice('My Plugin: command executed!');
			},
		});

		// Ribbon icon
		this.addRibbonIcon('dice', 'My Plugin', () => {
			new Notice('My Plugin: ribbon clicked!');
		});

		// Mobile-specific branch
		if (Platform.isMobile) {
			// Mobile-safe initialization goes here.
			// Avoid Node.js APIs (fs, path, child_process) in this branch.
		} else {
			// Desktop-only initialization goes here.
			// Safe to use Node.js / Electron APIs if needed.
		}

		// Register views after layout is ready to avoid startup crashes
		this.app.workspace.onLayoutReady(() => {
			// Example: register and activate a custom view
			// this.registerView(VIEW_TYPE_EXAMPLE, (leaf) => new ExampleView(leaf));
			// this.activateView();
		});
	}

	onunload(): void {
		// Detach any custom views registered by this plugin
		// this.app.workspace.detachLeavesOfType(VIEW_TYPE_EXAMPLE);
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
