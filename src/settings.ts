import { App, PluginSettingTab, Setting } from 'obsidian';
import type MyPlugin from './main';

export interface MyPluginSettings {
	exampleSetting: string;
	enableFeature: boolean;
}

export const DEFAULT_SETTINGS: MyPluginSettings = {
	exampleSetting: 'default',
	enableFeature: true,
};

export class MyPluginSettingTab extends PluginSettingTab {
	plugin: MyPlugin;

	constructor(app: App, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'My Plugin Settings' });

		new Setting(containerEl)
			.setName('Example setting')
			.setDesc('A placeholder text setting.')
			.addText((text) =>
				text
					.setPlaceholder('Enter a value')
					.setValue(this.plugin.settings.exampleSetting)
					.onChange(async (value) => {
						this.plugin.settings.exampleSetting = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Enable feature')
			.setDesc('Toggle an example feature on or off.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableFeature)
					.onChange(async (value) => {
						this.plugin.settings.enableFeature = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
