import type { TFile } from 'obsidian';

export interface QmdSettings {
	qmdBinaryPath: string;
	projectDir: string; // folder that contains .qmd; empty = vault root
	serverEnabled: boolean;
	serverPort: number;
	refreshOnLaunch: boolean;
	dailyRefresh: boolean;
	dailyHour: number;
	embedOnRefresh: boolean;
	maxResults: number;
	relatedResults: number;
	deepRerank: boolean;
	candidateLimit: number;
	hoverDelayMs: number; // wait before the sidebar page preview opens; 0 = at once
	lastIndexRun: number; // epoch ms, 0 = never
	history: string[];
}

export const DEFAULT_SETTINGS: QmdSettings = {
	qmdBinaryPath: '',
	projectDir: '',
	serverEnabled: true,
	serverPort: 8421, // not qmd's default 8181, so a hand-started server is never mistaken for ours
	refreshOnLaunch: true,
	dailyRefresh: true,
	dailyHour: 4,
	embedOnRefresh: true,
	maxResults: 20,
	relatedResults: 10,
	deepRerank: false,
	candidateLimit: 10,
	hoverDelayMs: 2000,
	lastIndexRun: 0,
	history: [],
};

export interface QmdResult {
	file: TFile | null; // null = not in the vault (index out of date)
	path: string; // vault-relative when inside the vault, absolute otherwise
	line: number; // 1-based matched line, 0 = unknown
	title: string; // first heading of the document, as qmd extracted it
	score: number;
	snippet: string; // qmd's snippet as plain text
	snippetLine: number; // 1-based file line the snippet starts at, 0 = unknown
}

export interface SearchOutcome {
	results: QmdResult[];
	degraded: boolean; // true = keyword only, because the server was not available
}

export function isAbort(e: unknown): boolean {
	const err = e as { name?: string; code?: string } | null;
	return err?.name === 'AbortError' || err?.code === 'ABORT_ERR';
}
