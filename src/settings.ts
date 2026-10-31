import { App, Notice, PluginSettingTab, Setting, SettingDefinitionItem } from 'obsidian';
import type QmdPlugin from './main';
import { DEFAULT_SETTINGS, QmdSettings } from './types';
import { FolderPicker } from './ui/folder-picker';

/** Settings that change which qmd runs or how: the server is restarted after them. */
const RECONFIGURE = new Set<string>(['projectDir', 'qmdBinaryPath', 'serverEnabled', 'serverPort']);
/** Settings that other rows' visibility depends on. */
const TOGGLES_ROWS = new Set<string>(['dailyRefresh', 'serverEnabled', 'deepRerank']);

export class QmdSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: QmdPlugin) {
		super(app, plugin);
	}

	getControlValue(key: string): unknown {
		const value = this.plugin.settings[key as keyof QmdSettings];
		// Dropdowns hold strings.
		return key === 'dailyHour' ? String(value) : value;
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const { plugin } = this;
		const settings = plugin.settings as unknown as Record<string, unknown>;
		const fallback = DEFAULT_SETTINGS[key as keyof QmdSettings];
		if (typeof fallback === 'number') settings[key] = Number(value);
		else if (typeof value === 'string') settings[key] = value.trim();
		else settings[key] = value;

		if (key === 'relatedResults') plugin.search.invalidate();
		await plugin.saveSettings(RECONFIGURE.has(key));
		if (TOGGLES_ROWS.has(key)) this.refreshDomState();
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const { plugin } = this;
		const s = () => plugin.settings;
		const hours: Record<string, string> = {};
		for (let hour = 0; hour < 24; hour++) hours[String(hour)] = `${String(hour).padStart(2, '0')}:00`;

		return [
			{
				type: 'group',
				heading: 'Index',
				items: [
					{
						name: 'Index location',
						desc: 'Folder that contains .qmd. Empty: the vault root.',
						control: { type: 'text', key: 'projectDir', placeholder: plugin.vaultPath },
					},
					{
						name: 'Index status',
						render: (setting) => this.renderIndexStatus(setting),
					},
					{
						name: 'Path to qmd',
						desc: 'Empty: find it automatically.',
						control: { type: 'text', key: 'qmdBinaryPath', placeholder: 'Auto-detect' },
					},
					{
						name: 'Other ignore rules',
						desc: `From index.yml, left as they are: ${plugin.config.otherPatterns.join(', ')}`,
						visible: () => plugin.config.otherPatterns.length > 0,
						searchable: false,
					},
				],
			},
			{
				type: 'list',
				heading: 'Excluded folders',
				emptyState: 'All folders are indexed.',
				addItem: {
					name: 'Exclude a folder',
					action: () => {
						const folders = this.app.vault.getAllFolders().filter((folder) => plugin.config.canExclude(folder.path));
						new FolderPicker(this.app, folders, (path) => plugin.excludeFolder(path)).open();
					},
				},
				onDelete: (index) => plugin.includeFolder(plugin.config.folders[index]),
				items: plugin.config.folders.map((folder) => ({
					name: folder,
					desc: this.app.vault.getFolderByPath(folder) ? '' : 'Not in the vault.',
					searchable: false,
				})),
			},
			{
				type: 'group',
				heading: 'Refresh',
				items: [
					{
						name: 'Update index now',
						render: (setting) => this.renderUpdateNow(setting),
					},
					{
						name: 'Purge removed notes',
						desc: 'Deletes the text and vectors of notes no longer indexed. The server restarts. Including them again means embedding them again.',
						render: (setting) => this.renderPurge(setting),
					},
					{
						name: 'Refresh at startup',
						desc: 'Runs "qmd update" about 20 seconds after Obsidian starts.',
						control: { type: 'toggle', key: 'refreshOnLaunch' },
					},
					{
						name: 'Refresh daily',
						desc: 'Once a day, at the first chance after the hour below.',
						control: { type: 'toggle', key: 'dailyRefresh' },
					},
					{
						name: 'Daily refresh hour',
						control: { type: 'dropdown', key: 'dailyHour', options: hours },
						visible: () => s().dailyRefresh,
					},
					{
						name: 'Embed changed notes',
						desc: 'Runs "qmd embed" after an update, so changed notes are found by meaning too.',
						control: { type: 'toggle', key: 'embedOnRefresh' },
					},
				],
			},
			{
				type: 'group',
				heading: 'Server',
				items: [
					{
						name: 'Keep a qmd server running',
						desc: 'Keeps the models loaded, so a search takes under a second. Off: keyword search only.',
						control: { type: 'toggle', key: 'serverEnabled' },
					},
					{
						name: 'Server status',
						render: (setting) => this.renderServerStatus(setting),
						visible: () => s().serverEnabled,
						searchable: false,
					},
					{
						name: 'Port',
						desc: 'First port to try. If it is taken, the next five are tried.',
						control: {
							type: 'number',
							key: 'serverPort',
							min: 1024,
							max: 65530,
							step: 1,
							validate: (port) =>
								Number.isInteger(port) && port >= 1024 && port <= 65530 ? undefined : 'Use a port from 1024 to 65530.',
						},
						visible: () => s().serverEnabled,
					},
				],
			},
			{
				type: 'group',
				heading: 'Search',
				items: [
					{
						name: 'Search results',
						control: { type: 'slider', key: 'maxResults', min: 5, max: 40, step: 5 },
					},
					{
						name: 'Related notes shown',
						control: { type: 'slider', key: 'relatedResults', min: 3, max: 30, step: 1 },
					},
					{
						name: 'Hover preview delay',
						desc: 'How long to rest on a result in the sidebar before its preview opens. With the modifier key held it opens at once.',
						control: {
							type: 'slider',
							key: 'hoverDelayMs',
							min: 0,
							max: 5000,
							step: 250,
							displayFormat: (ms) => `${ms / 1000} s`,
						},
					},
					{
						name: 'Rerank deep search',
						desc: 'Let the LLM reorder deep-search results. Can take minutes without a GPU.',
						control: { type: 'toggle', key: 'deepRerank' },
					},
					{
						name: 'Rerank candidates',
						desc: 'How many results the reranker reads. Fewer is faster.',
						control: { type: 'slider', key: 'candidateLimit', min: 5, max: 40, step: 5 },
						visible: () => s().deepRerank,
					},
				],
			},
		];
	}

	private renderIndexStatus(setting: Setting): void {
		const { plugin } = this;
		const check = async () => {
			setting.setDesc('Checking…');
			const status = await plugin.runner.verify();
			plugin.refreshStatus();
			plugin.config.reload(); // picks up hand edits; a change renders this tab again
			if (!status) {
				setting.setDesc(plugin.runner.problem ?? plugin.runner.checkError ?? 'Could not check the index.');
				setting.settingEl.addClass('qmd-settings-error');
				return;
			}
			setting.settingEl.removeClass('qmd-settings-error');
			const pending = status.pending ? `, ${status.pending} waiting for embedding` : '';
			const orphaned = status.orphaned ? `, ${status.orphaned} orphaned` : '';
			setting.setDesc(
				`${status.indexPath}: ${status.docs} notes, ${status.vectors} vectors${pending}${orphaned}. Updated ${status.updated || 'never'}.`
			);
		};
		setting.addButton((btn) => btn.setButtonText('Check').onClick(() => void check()));
		void check();
	}

	private renderUpdateNow(setting: Setting): void {
		const { plugin } = this;
		const describe = () => {
			const { lastIndexRun } = plugin.settings;
			const last = lastIndexRun ? new Date(lastIndexRun).toLocaleString() : 'never';
			setting.setDesc(`Last refresh: ${last}${plugin.indexer.message ? ` (${plugin.indexer.message})` : ''}.`);
		};
		describe();
		setting.addButton((btn) =>
			btn.setButtonText('Update now').onClick(async () => {
				btn.setDisabled(true).setButtonText('Updating…');
				await plugin.indexer.run();
				btn.setDisabled(false).setButtonText('Update now');
				describe();
			})
		);
	}

	private renderPurge(setting: Setting): void {
		const { plugin } = this;
		setting.addButton((btn) =>
			btn
				.setButtonText('Purge')
				.setDestructive()
				.onClick(async () => {
					btn.setDisabled(true).setButtonText('Purging…');
					await plugin.indexer.purge();
					btn.setDisabled(false).setButtonText('Purge');
					const failed = plugin.indexer.state === 'error';
					new Notice(failed ? `Purge failed: ${plugin.indexer.message}` : 'Removed notes purged.', failed ? 10000 : 4000);
					this.update(); // re-runs the index status check
				})
		);
	}

	private renderServerStatus(setting: Setting): () => void {
		const { server } = this.plugin;
		const log = setting.infoEl.createEl('details', { cls: 'qmd-settings-log' });
		log.createEl('summary', { text: 'Server log' });
		const logText = log.createEl('pre');
		const describe = () => {
			setting.setDesc(server.state === 'ready' ? `Running on port ${server.port}.` : `Server ${server.state}.`);
			logText.setText(server.log.join('\n'));
			log.toggle(server.log.length > 0);
		};
		describe();
		setting.addButton((btn) =>
			btn.setButtonText('Restart').onClick(async () => {
				btn.setDisabled(true);
				await server.restart();
				btn.setDisabled(false);
			})
		);
		return server.onChange(describe);
	}
}
