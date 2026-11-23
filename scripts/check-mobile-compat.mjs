import { readFileSync, existsSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';

const manifestPath = path.resolve('manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

if (manifest.isDesktopOnly === true) {
	console.log('Skipping mobile bundle check (manifest.json has isDesktopOnly: true).');
	process.exit(0);
}

const bundlePath = path.resolve('main.js');
if (!existsSync(bundlePath)) {
	console.error('Error: main.js not found. Run "npm run build" before checking mobile compatibility.');
	process.exit(1);
}

const bundle = readFileSync(bundlePath, 'utf8');
const forbiddenModules = new Set([
	'electron',
	...builtinModules,
	...builtinModules.map((mod) => (mod.startsWith('node:') ? mod : `node:${mod}`)),
]);

const requirePattern = /\brequire\(\s*(['"])([^'"]+)\1\s*\)/g;
const importPattern = /\bimport\s*(?:[^'"]*?\sfrom\s*)?(['"])([^'"]+)\1/g;

const violations = new Set();
for (const pattern of [requirePattern, importPattern]) {
	for (const match of bundle.matchAll(pattern)) {
		const spec = match[2];
		if (spec && forbiddenModules.has(spec)) {
			violations.add(spec);
		}
	}
}

if (violations.size > 0) {
	console.error(
		`Mobile compatibility check failed for "${manifest.id ?? 'plugin'}" (isDesktopOnly: false).\n` +
			`Found desktop-only runtime imports in main.js:\n` +
			Array.from(violations)
				.sort()
				.map((m) => `  - ${m}`)
				.join('\n') +
			`\nRemove Node/Electron imports or set "isDesktopOnly": true in manifest.json.`,
	);
	process.exit(1);
}

console.log(`Mobile bundle check passed for "${manifest.id ?? 'plugin'}" (no Node/Electron runtime imports in main.js).`);
