import { ChildProcess } from 'child_process';
import { Plugin } from 'obsidian';
import { QmdSettings } from '../types';
import { QmdRunner, stripAnsi } from './runner';
import { QmdSearch } from './search';
import { QmdServer } from './server';

export type IndexState = 'idle' | 'updating' | 'embedding' | 'purging' | 'error';

const LAUNCH_DELAY_MS = 20 * 1000;
const DAILY_CHECK_MS = 15 * 60 * 1000;

/** Keeps the project index fresh: `qmd update`, then `qmd embed` for what changed. */
export class QmdIndexer {
	state: IndexState = 'idle';
	/** Outcome of the last run, for the status bar and settings. */
	message = '';

	private removed = 0;
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

	/**
	 * Notes taken out of the index since the last call. A running total, because a
	 * refresh already under way can pick up a config change before the one that follows it.
	 */
	takeRemoved(): number {
		const removed = this.removed;
		this.removed = 0;
		return removed;
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

	/** For a changed config: a job already running may have read the old one, so this starts a new one after it. */
	async rerun(): Promise<void> {
		await this.job;
		if (!this.aborted) await this.run();
	}

	/**
	 * Delete what notes no longer indexed left behind: their text and vectors, plus the
	 * LLM cache. `qmd cleanup` ends with VACUUM, so the server is off while it runs.
	 */
	async purge(): Promise<void> {
		await this.job;
		if (this.aborted) return;
		this.job ??= this.executePurge().finally(() => {
			this.job = null;
		});
		return this.job;
	}

	abort(): void {
		this.aborted = true;
		if (this.launchTimer !== null) window.clearTimeout(this.launchTimer);
		if (this.child) this.runner.kill(this.child);
	}

	/** True, with the reason reported, when qmd must not run now. */
	private blocked(): boolean {
		if (!this.runner.problem) return false;
		this.message = this.runner.problem;
		this.setState('error');
		return true;
	}

	private fail(e: unknown): void {
		if (this.aborted) {
			this.setState('idle');
			return;
		}
		this.message = e instanceof Error ? e.message : String(e);
		console.error('[qmd-vault-search] index job failed:', e);
		this.setState('error');
	}

	private async executePurge(): Promise<void> {
		if (this.blocked()) return;
		const serverWasOn = this.server.state !== 'stopped';
		try {
			this.setState('purging');
			await this.server.stop();
			await this.stream(['cleanup']);
			this.search.invalidate();
			this.message = 'removed notes purged';
			this.setState('idle');
		} catch (e) {
			this.fail(e);
		} finally {
			if (serverWasOn && !this.aborted) await this.server.start();
		}
	}

	private async execute(): Promise<void> {
		if (this.blocked()) return;
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
			this.removed += removed;
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
			this.fail(e);
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
