import { browser, expect } from '@wdio/globals';
import { describe, it } from 'mocha';

describe('QMD Vault Search E2E', function () {
	it('loads the qmd-vault-search plugin cleanly', async function () {
		const enabled = await browser.executeObsidian(({ app }) => {
			const plugins = (app as unknown as { plugins: { enabledPlugins: Set<string> } }).plugins;
			return plugins.enabledPlugins.has('qmd-vault-search');
		});
		expect(enabled).toBe(true);
	});

	it('opens the search modal via command', async function () {
		await browser.executeObsidianCommand('qmd-vault-search:search');

		await browser.waitUntil(
			async () => browser.execute(() => Boolean(document.querySelector('.modal-container .modal input'))),
			{ timeout: 10000, timeoutMsg: 'Expected QMD search modal to open' },
		);

		await browser.execute(() => {
			const closeBtn = document.querySelector<HTMLElement>('.modal-container .modal-close-button');
			closeBtn?.click();
		});
	});

	it('opens the search and related notes sidebar views', async function () {
		await browser.executeObsidianCommand('qmd-vault-search:open-search-panel');
		await browser.executeObsidianCommand('qmd-vault-search:open-related-notes');

		await browser.waitUntil(
			async () =>
				browser.executeObsidian(({ app }) => {
					return (
						app.workspace.getLeavesOfType('qmd-vault-search-view').length > 0 &&
						app.workspace.getLeavesOfType('qmd-vault-related-view').length > 0
					);
				}),
			{ timeout: 10000, timeoutMsg: 'Expected QMD sidebar leaves to open' },
		);
	});
});
