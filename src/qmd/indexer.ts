import { ChildProcess } from 'child_process';
import { Plugin } from 'obsidian';
import { QmdSettings } from '../types';
import { QmdRunner, stripAnsi } from './runner';
import { QmdSearch } from './search';
import { QmdServer } from './server';

export type IndexState = 'idle' | 'updating' | 'embedding' | 'error';

const LAUNCH_DELAY_MS = 20 * 1000;
const DAILY_CHECK_MS = 15 * 60 * 1000;

/** Keeps the project index fresh: `qmd update`, then `qmd embed` for what changed. */
export class QmdIndexer {
	state: IndexState = 'idle';
	/** Outcome of the last run, for the status bar and settings. */
	message = '';

	private job: Promise<void> | null = null;
	private child: ChildProcess | null = null;
	private aborted = false;
	private launchTimer: number | null = null;
	private listeners = new Set<() => void>();

	constructor(
		private runner: QmdRunner,
		private server: QmdServer,
		private search: QmdSearch,
		private getSettings: () => QmdSettings,
		private saveSettings: () => Promise<void>
	) {}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private setState(state: IndexState): void {
		this.state = state;
		this.listeners.forEach((fn) => fn());
	}

	/** Refresh shortly after launch, then once a day after the configured hour. */
	schedule(plugin: Plugin): void {
		if (this.getSettings().refreshOnLaunch) {
			this.launchTimer = window.setTimeout(() => void this.run(), LAUNCH_DELAY_MS);
		}
		plugin.registerInterval(
			window.setInterval(() => {
				if (this.dailyDue()) void this.run();
			}, DAILY_CHECK_MS)
		);
	}

	private dailyDue(): boolean {
		const s = this.getSettings();
		if (!s.dailyRefresh) return false;
		const mark = new Date();
		mark.setHours(s.dailyHour, 0, 0, 0);
		return Date.now() >= mark.getTime() && s.lastIndexRun < mark.getTime();
	}

	/** Single-flight: a second call while a refresh is running joins it. */
	run(): Promise<void> {
		this.job ??= this.execute().finally(() => {
			this.job = null;
		});
		return this.job;
	}

	abort(): void {
		this.aborted = true;
		if (this.launchTimer !== null) window.clearTimeout(this.launchTimer);
		if (this.child) this.runner.kill(this.child);
	}

	private async execute(): Promise<void> {
		if (this.runner.problem) {
			this.message = this.runner.problem;
			this.setState('error');
			return;
		}
		this.aborted = false;
		try {
			this.setState('updating');
			const update = await this.stream(['update']);
			let added = 0;
			let updated = 0;
			let removed = 0;
			for (const m of update.matchAll(/Indexed:\s*(\d+) new,\s*(\d+) updated,\s*\d+ unchanged,\s*(\d+) removed/g)) {
				added += Number(m[1]);
				updated += Number(m[2]);
				removed += Number(m[3]);
			}
			const needsVectors = /unique hashes need vectors/.test(update);

			let embedded = false;
			if (needsVectors && this.getSettings().embedOnRefresh) {
				this.setState('embedding');
				await this.stream(['embed']);
				embedded = true;
			}

			// Restarting makes the server read the new index and lets SQLite fold its
			// write-ahead log back into index.sqlite. Skipped when nothing changed.
			if (added + updated + removed > 0 || embedded) {
				this.search.invalidate();
				if (this.server.state !== 'stopped') await this.server.restart();
			}

			this.getSettings().lastIndexRun = Date.now();
			await this.saveSettings();
			this.message =
				added + updated + removed > 0 ? `${added} new, ${updated} updated, ${removed} removed` : 'no changes';
			this.setState('idle');
		} catch (e) {
			if (this.aborted) {
				this.setState('idle');
				return;
			}
			this.message = e instanceof Error ? e.message : String(e);
			console.error('[qmd-vault-search] index refresh failed:', e);
			this.setState('error');
		}
	}

	/**
	 * Run a qmd job to completion. Streaming with no timeout of our own: `qmd embed`
	 * can take minutes and prints progress the whole time (qmd caps the session itself).
	 */
	private async stream(args: string[]): Promise<string> {
		const child = await this.runner.spawn(args);
		this.child = child;
		let output = '';
		const take = (data: Buffer) => {
			output = (output + data.toString('utf8')).slice(-20000);
		};
		child.stdout?.on('data', take);
		child.stderr?.on('data', take);
		const code = await new Promise<number | null>((resolve, reject) => {
			child.once('error', reject);
			child.once('close', resolve);
		});
		this.child = null;
		const text = stripAnsi(output);
		if (code !== 0) {
			const tail = text.trim().split('\n').slice(-3).join(' ').trim();
			throw new Error(tail || `qmd ${args[0]} exited with code ${code}`);
		}
		return text;
	}
}
