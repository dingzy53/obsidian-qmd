import { ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QmdRunner } from "../src/qmd/runner";
import {
	cleanSnippet,
	DEFAULT_DEEP_RERANK_TIMEOUT_MIN,
	DEFAULT_DEEP_TIMEOUT_MIN,
	deepSearchStatus,
	deepSearchTimeoutMs,
	proseToVecQuery,
	SLOW_DEEP_SEARCH_MS,
	toLexQuery,
	toVecQuery,
} from "../src/qmd/search";
import { DEFAULT_SETTINGS } from "../src/types";

describe("toLexQuery", () => {
	it("collapses whitespace", () => {
		expect(toLexQuery("  a \n b  ")).toBe("a b");
	});
	it("keeps balanced quotes", () => {
		expect(toLexQuery('"exact phrase" -x')).toBe('"exact phrase" -x');
	});
	it("drops quotes when unbalanced", () => {
		expect(toLexQuery('say "hello')).toBe("say  hello");
	});
});

describe("toVecQuery", () => {
	it("removes negated terms and phrases", () => {
		expect(toVecQuery('foo -bar -"baz qux" quux')).toBe("foo quux");
	});
	it("removes quote marks", () => {
		expect(toVecQuery('"exact phrase"')).toBe("exact phrase");
	});
});

describe("proseToVecQuery", () => {
	it("strips dashes that touch a word, so negative numbers do not read as negation", () => {
		expect(proseToVecQuery("a -1 b --c")).toBe("a 1 b c");
	});
});

describe("cleanSnippet", () => {
	it("returns empty for no input", () => {
		expect(cleanSnippet(undefined)).toEqual({ text: "", startLine: 0 });
	});
	it("strips the diff header and reads the start line", () => {
		expect(cleanSnippet("@@ -12,3 @@\nline a\nline b\n")).toEqual({
			text: "line a\nline b",
			startLine: 12,
		});
	});
	it("strips REST line-number prefixes", () => {
		expect(cleanSnippet("1: @@ -5,2 @@\n2: x\n3: y")).toEqual({ text: "x\ny", startLine: 5 });
	});
});

describe("deepSearchTimeoutMs", () => {
	it("defaults to 10 minutes without rerank and 20 minutes with rerank", () => {
		expect(deepSearchTimeoutMs({ deepRerank: false, deepTimeoutMinutes: null })).toBe(
			DEFAULT_DEEP_TIMEOUT_MIN * 60 * 1000
		);
		expect(deepSearchTimeoutMs({ deepRerank: true, deepTimeoutMinutes: null })).toBe(
			DEFAULT_DEEP_RERANK_TIMEOUT_MIN * 60 * 1000
		);
	});
	it("returns 0 (no limit) when configured to 0, regardless of rerank", () => {
		expect(deepSearchTimeoutMs({ deepRerank: false, deepTimeoutMinutes: 0 })).toBe(0);
		expect(deepSearchTimeoutMs({ deepRerank: true, deepTimeoutMinutes: 0 })).toBe(0);
	});
	it("uses the configured minutes when positive", () => {
		expect(deepSearchTimeoutMs({ deepRerank: false, deepTimeoutMinutes: 5 })).toBe(5 * 60 * 1000);
		expect(deepSearchTimeoutMs({ deepRerank: true, deepTimeoutMinutes: 30 })).toBe(30 * 60 * 1000);
	});
	it("falls back to defaults on invalid stored values and caps huge values", () => {
		expect(deepSearchTimeoutMs({ deepRerank: false, deepTimeoutMinutes: -2 })).toBe(10 * 60 * 1000);
		expect(deepSearchTimeoutMs({ deepRerank: true, deepTimeoutMinutes: Number.NaN })).toBe(20 * 60 * 1000);
		expect(deepSearchTimeoutMs({ deepRerank: false, deepTimeoutMinutes: 99_999 })).toBe(1440 * 60 * 1000);
	});
});

describe("deepSearchStatus", () => {
	it("shows download progress while a model is missing", () => {
		expect(deepSearchStatus("Downloading query model (0.4 / 1.3 GB)", 45_000, 0)).toBe(
			"Downloading query model (0.4 / 1.3 GB)… 45 s"
		);
	});
	it("shows a bare timer before 30 s and explains slow model loading after 30 s", () => {
		expect(deepSearchStatus(null, 29_000, 29_000)).toBe("Deep search… 29 s");
		expect(deepSearchStatus(null, SLOW_DEEP_SEARCH_MS, SLOW_DEEP_SEARCH_MS)).toBe(
			"Deep search… 30 s (loading models; slow on low-memory machines)"
		);
		expect(deepSearchStatus(null, 95_000, 20_000)).toBe("Deep search… 95 s");
	});
});

describe("QmdRunner.exec timeoutMs = 0", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("does not arm a timeout when timeoutMs is 0", async () => {
		vi.useFakeTimers();
		vi.stubGlobal("window", { setTimeout, clearTimeout });
		const child = Object.assign(new EventEmitter(), {
			stdout: new EventEmitter(),
			stderr: new EventEmitter(),
			exitCode: null as number | null,
			signalCode: null as NodeJS.Signals | null,
			kill: vi.fn(),
		});
		const runner = new QmdRunner(() => DEFAULT_SETTINGS, "/vault");
		vi.spyOn(runner, "spawn").mockResolvedValue(child as unknown as ChildProcess);

		const done = runner.exec(["query", "x"], { timeoutMs: 0 });
		await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
		expect(child.kill).not.toHaveBeenCalled();

		child.stdout.emit("data", Buffer.from("[]"));
		child.exitCode = 0;
		child.emit("close", 0);
		await expect(done).resolves.toBe("[]");
	});
});
