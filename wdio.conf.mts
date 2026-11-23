import { readFileSync } from 'node:fs';
import path from 'node:path';
import { env } from 'node:process';
import { obsidianBetaAvailable, parseObsidianVersions } from 'wdio-obsidian-service';

const manifest = JSON.parse(readFileSync(path.resolve('manifest.json'), 'utf8')) as {
	isDesktopOnly?: boolean;
};
const isDesktopOnly = Boolean(manifest.isDesktopOnly);

const cacheDir = path.resolve(env.OBSIDIAN_CACHE_DIR || '.obsidian-cache');
const target = env.OBSIDIAN_E2E_TARGET ?? 'all'; // 'all' | 'desktop' | 'mobile'

let defaultVersions = 'earliest/earliest latest/latest';
if (await obsidianBetaAvailable({ cacheDir })) {
	defaultVersions += ' latest-beta/latest';
}

const desktopVersions =
	target === 'mobile'
		? []
		: await parseObsidianVersions(env.OBSIDIAN_VERSIONS ?? defaultVersions, { cacheDir });

const mobileVersions =
	isDesktopOnly || target === 'desktop'
		? []
		: await parseObsidianVersions(env.OBSIDIAN_MOBILE_VERSIONS ?? env.OBSIDIAN_VERSIONS ?? defaultVersions, {
				cacheDir,
			});

if (env.CI) {
	console.log('obsidian-cache-key:', JSON.stringify([desktopVersions, mobileVersions]));
}

export const config: WebdriverIO.Config = {
	runner: 'local',
	framework: 'mocha',

	specs: ['./test/e2e/**/*.e2e.ts'],
	maxInstances: Number(env.WDIO_MAX_INSTANCES || 4),

	capabilities: [
		...desktopVersions.map<WebdriverIO.Capabilities>(([appVersion, installerVersion]) => ({
			browserName: 'obsidian',
			'wdio:obsidianOptions': {
				appVersion,
				installerVersion,
				plugins: ['.'],
				vault: 'test-vault',
			},
		})),
		...mobileVersions.map<WebdriverIO.Capabilities>(([appVersion, installerVersion]) => ({
			browserName: 'obsidian',
			'wdio:obsidianOptions': {
				appVersion,
				installerVersion,
				emulateMobile: true,
				plugins: ['.'],
				vault: 'test-vault',
			},
			'goog:chromeOptions': {
				mobileEmulation: {
					deviceMetrics: { width: 390, height: 844 },
				},
			},
		})),
	],

	services: ['obsidian'],
	reporters: ['obsidian'],

	mochaOpts: {
		ui: 'bdd',
		timeout: 60 * 1000,
	},
	waitforInterval: 250,
	waitforTimeout: 10 * 1000,
	logLevel: 'warn',

	cacheDir,
	injectGlobals: false,
};
