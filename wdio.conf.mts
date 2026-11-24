import { readFileSync } from 'node:fs';
import path from 'node:path';
import { env } from 'node:process';
import { obsidianBetaAvailable, parseObsidianVersions } from 'wdio-obsidian-service';

interface ObsidianVersionEntry {
	version: string;
	isBeta?: boolean;
	downloads?: { asar?: string; apk?: string };
}

function compareSemver(a: string, b: string): number {
	const pa = a.split('.').map(Number);
	const pb = b.split('.').map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

function resolveEarliestPublicVersion(dir: string, minAppVersion: string | undefined): string {
	if (!minAppVersion) return 'earliest';
	try {
		const raw = JSON.parse(readFileSync(path.join(dir, 'obsidian-versions.json'), 'utf8')) as {
			versions?: ObsidianVersionEntry[];
		};
		const match = raw.versions?.find(
			(entry) =>
				!entry.isBeta &&
				Boolean(entry.downloads?.asar) &&
				compareSemver(entry.version, minAppVersion) >= 0,
		);
		return match?.version ?? 'latest';
	} catch {
		return 'latest';
	}
}

function rewriteVersionSpec(spec: string, earliestApp: string, allowBeta: boolean): string {
	if (allowBeta) return spec;
	return spec
		.split(/([ ,]+)/)
		.map((token) => {
			if (!token || /^[ ,]+$/.test(token)) return token;
			const [appVer, installerVer] = token.split('/');
			if (appVer !== 'earliest') return token;
			return installerVer !== undefined ? `${earliestApp}/${installerVer}` : earliestApp;
		})
		.join('');
}

const manifest = JSON.parse(readFileSync(path.resolve('manifest.json'), 'utf8')) as {
	isDesktopOnly?: boolean;
	minAppVersion?: string;
};
const isDesktopOnly = Boolean(manifest.isDesktopOnly);

const cacheDir = path.resolve(env.OBSIDIAN_CACHE_DIR || '.obsidian-cache');
const target = env.OBSIDIAN_E2E_TARGET ?? 'all'; // 'all' | 'desktop' | 'mobile'

const betaAvailable = await obsidianBetaAvailable({ cacheDir });
const earliestPublic = resolveEarliestPublicVersion(cacheDir, manifest.minAppVersion);

let defaultVersions = 'earliest/earliest latest/latest';
if (betaAvailable) {
	defaultVersions += ' latest-beta/latest';
}

const resolvedDesktopSpec = rewriteVersionSpec(env.OBSIDIAN_VERSIONS ?? defaultVersions, earliestPublic, betaAvailable);
const resolvedMobileSpec = rewriteVersionSpec(
	env.OBSIDIAN_MOBILE_VERSIONS ?? env.OBSIDIAN_VERSIONS ?? defaultVersions,
	earliestPublic,
	betaAvailable,
);

const desktopVersions =
	target === 'mobile' ? [] : await parseObsidianVersions(resolvedDesktopSpec, { cacheDir });

const mobileVersions =
	isDesktopOnly || target === 'desktop'
		? []
		: await parseObsidianVersions(resolvedMobileSpec, { cacheDir });

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
