import { App, PluginSettingTab, Setting } from 'obsidian';
import type QmdPlugin from './main';

export class QmdSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: QmdPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl, plugin } = this;
		const { settings } = plugin;
		containerEl.empty();

		// ---- Index -------------------------------------------------------------
		new Setting(containerEl).setName('Index').setHeading();

		const indexInfo = containerEl.createDiv({ cls: 'qmd-settings-info' });
		const showIndex = async () => {
			indexInfo.setText('Checking…');
			const status = await plugin.runner.verify();
			plugin.refreshStatus();
			indexInfo.empty();
			if (!status) {
				indexInfo.addClass('is-error');
				indexInfo.setText(plugin.runner.problem ?? plugin.runner.checkError ?? 'Could not check the index.');
				return;
			}
			indexInfo.removeClass('is-error');
			indexInfo.createDiv({ text: status.indexPath });
			const pending = status.pending ? `, ${status.pending} waiting for embedding` : '';
			indexInfo.createDiv({
				text: `${status.docs} notes, ${status.vectors} vectors${pending}. Updated ${status.updated || 'never'}.`,
			});
		};
		void showIndex();

		new Setting(containerEl)
			.setName('Index location')
			.setDesc('Folder that contains the .qmd directory. Leave empty to use the vault root.')
			.addText((text) =>
				text
					.setPlaceholder(plugin.vaultPath)
					.setValue(settings.projectDir)
					.onChange(async (value) => {
						settings.projectDir = value.trim();
						await plugin.saveSettings(true);
					})
			)
			.addButton((btn) => btn.setButtonText('Check').onClick(() => void showIndex()));

		new Setting(containerEl)
			.setName('qmd binary')
			.setDesc('Path to the qmd executable. Leave empty to find it automatically.')
			.addText((text) =>
				text
					.setPlaceholder('Auto-detect')
					.setValue(settings.qmdBinaryPath)
					.onChange(async (value) => {
						settings.qmdBinaryPath = value.trim();
						await plugin.saveSettings(true);
					})
			);

		// ---- Refresh -----------------------------------------------------------
		new Setting(containerEl).setName('Index refresh').setHeading();

		const lastRun = settings.lastIndexRun ? new Date(settings.lastIndexRun).toLocaleString() : 'never';
		new Setting(containerEl)
			.setName('Update index now')
			.setDesc(`Last refresh: ${lastRun}${plugin.indexer.message ? ` (${plugin.indexer.message})` : ''}.`)
			.addButton((btn) =>
				btn.setButtonText('Update now').onClick(async () => {
					btn.setDisabled(true).setButtonText('Updating…');
					await plugin.indexer.run();
					this.display();
				})
			);

		new Setting(containerEl)
			.setName('Refresh when Obsidian starts')
			.setDesc('Runs "qmd update" about 20 seconds after launch.')
			.addToggle((toggle) =>
				toggle.setValue(settings.refreshOnLaunch).onChange(async (value) => {
					settings.refreshOnLaunch = value;
					await plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Refresh daily')
			.setDesc('While Obsidian is open, refresh once a day at the first chance after this hour.')
			.addToggle((toggle) =>
				toggle.setValue(settings.dailyRefresh).onChange(async (value) => {
					settings.dailyRefresh = value;
					await plugin.saveSettings();
				})
			)
			.addDropdown((dropdown) => {
				for (let hour = 0; hour < 24; hour++) dropdown.addOption(String(hour), `${String(hour).padStart(2, '0')}:00`);
				dropdown.setValue(String(settings.dailyHour)).onChange(async (value) => {
					settings.dailyHour = Number(value);
					await plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('Embed changed notes')
			.setDesc('After updating, run "qmd embed" so new and edited notes are found by meaning, not only by keyword.')
			.addToggle((toggle) =>
				toggle.setValue(settings.embedOnRefresh).onChange(async (value) => {
					settings.embedOnRefresh = value;
					await plugin.saveSettings();
				})
			);

		// ---- Server ------------------------------------------------------------
		new Setting(containerEl).setName('Background server').setHeading();

		const { server } = plugin;
		const serverState = server.state === 'ready' ? `running on port ${server.port}` : server.state;
		new Setting(containerEl)
			.setName('Keep a qmd server running')
			.setDesc(
				`Keeps the models loaded so searches take a fraction of a second. Without it only keyword search is fast. Currently ${serverState}.`
			)
			.addToggle((toggle) =>
				toggle.setValue(settings.serverEnabled).onChange(async (value) => {
					settings.serverEnabled = value;
					await plugin.saveSettings(true);
				})
			)
			.addButton((btn) =>
				btn.setButtonText('Restart').onClick(async () => {
					btn.setDisabled(true);
					await server.restart();
					this.display();
				})
			);

		new Setting(containerEl)
			.setName('Port')
			.setDesc('First port to try. If it is taken, the next five are tried.')
			.addText((text) =>
				text.setValue(String(settings.serverPort)).onChange(async (value) => {
					const port = Number(value);
					if (!Number.isInteger(port) || port < 1024 || port > 65530) return;
					settings.serverPort = port;
					await plugin.saveSettings(true);
				})
			);

		if (server.log.length > 0) {
			const details = containerEl.createEl('details', { cls: 'qmd-settings-log' });
			details.createEl('summary', { text: 'Server log' });
			details.createEl('pre', { text: server.log.join('\n') });
		}

		// ---- Search ------------------------------------------------------------
		new Setting(containerEl).setName('Search').setHeading();

		new Setting(containerEl).setName('Search results').addSlider((slider) =>
			slider
				.setLimits(5, 40, 5)
				.setValue(settings.maxResults)
				.setDynamicTooltip()
				.onChange(async (value) => {
					settings.maxResults = value;
					await plugin.saveSettings();
				})
		);

		new Setting(containerEl).setName('Related notes shown').addSlider((slider) =>
			slider
				.setLimits(3, 30, 1)
				.setValue(settings.relatedResults)
				.setDynamicTooltip()
				.onChange(async (value) => {
					settings.relatedResults = value;
					plugin.search.invalidate();
					await plugin.saveSettings();
				})
		);

		new Setting(containerEl)
			.setName('Hover preview delay')
			.setDesc(
				'In the sidebar panels, how long to rest on a result before its preview opens, in milliseconds. Hold Ctrl (Cmd on macOS) to preview at once.'
			)
			.addSlider((slider) =>
				slider
					.setLimits(0, 5000, 250)
					.setValue(settings.hoverDelayMs)
					.setDynamicTooltip()
					.onChange(async (value) => {
						settings.hoverDelayMs = value;
						await plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Rerank in deep search')
			.setDesc('Let the LLM reorder deep-search results. Can take minutes without a dedicated GPU.')
			.addToggle((toggle) =>
				toggle.setValue(settings.deepRerank).onChange(async (value) => {
					settings.deepRerank = value;
					await plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Rerank candidates')
			.setDesc('How many results the reranker reads. Fewer is faster.')
			.addSlider((slider) =>
				slider
					.setLimits(5, 40, 5)
					.setValue(settings.candidateLimit)
					.setDynamicTooltip()
					.onChange(async (value) => {
						settings.candidateLimit = value;
						await plugin.saveSettings();
					})
			);
	}
}
