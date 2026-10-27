import { describe, expect, it } from "vitest";
import { cleanSnippet, proseToVecQuery, toLexQuery, toVecQuery } from "../src/qmd/search";

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
