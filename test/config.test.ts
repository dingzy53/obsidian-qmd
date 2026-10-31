import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { editIgnore, editIsSafe, folderPattern, parseCollections, patternFolder, withIgnore } from "../src/qmd/config";

// The shape of a real vault config: hand-written rules, context and models.
const VAULT = `collections:
  obsidian:
    path: .
    pattern: "**/*.md"
    ignore:
      - "Z - Template/**"
      - "99 - Assets/**"
      - ".trash/**"
      - "*.aux"
    context:
      "/": "Personal vault"
      "01 - Courses": "University courses"
models:
  embed: hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf
`;

const ignoreOf = (text: string, name: string) => (parse(text) as { collections: Record<string, { ignore?: string[] }> }).collections[name].ignore;

describe("folderPattern", () => {
	it("leaves plain names alone", () => {
		expect(folderPattern("99 - Assets/covers")).toBe("99 - Assets/covers/**");
		expect(folderPattern("数学 笔记")).toBe("数学 笔记/**");
	});
	it("escapes glob syntax", () => {
		expect(folderPattern("Archive (old)")).toBe("Archive \\(old\\)/**");
		expect(folderPattern("a[1]")).toBe("a\\[1\\]/**");
		expect(folderPattern("!bang")).toBe("\\!bang/**");
		expect(folderPattern("@(y)")).toBe("\\@\\(y\\)/**");
	});
});

describe("patternFolder", () => {
	it.each(["Archive", "Archive (old)", "a[1]", "x{y}", "!bang", "what?", "star*", "a|b", "c++ (x)", "+(z)", "back\\slash", "a/b (c)/d"])(
		"round-trips %s",
		(name) => {
			expect(patternFolder(folderPattern(name))).toBe(name);
		}
	);
	it.each(["*.aux", ".trash/**", "a/.hidden/**", "**/drafts/**", "Archive/**/*.md", "a[1]/**", "/rooted/**"])("treats %s as another rule", (rule) => {
		expect(patternFolder(rule)).toBeNull();
	});
});

describe("parseCollections", () => {
	it("resolves roots against the project folder", () => {
		const text = "collections:\n  a:\n    path: .\n  b:\n    path: sub/dir\n  c:\n    path: /abs\n  d: {}\n";
		expect(parseCollections(text, "/vault").map((c) => c.root)).toEqual(["/vault", "/vault/sub/dir", "/abs", "/vault"]);
	});
	it("reads ignore lists and tolerates empty configs", () => {
		expect(parseCollections(VAULT, "/vault")[0].ignore).toHaveLength(4);
		expect(parseCollections("collections: {}\n", "/vault")).toEqual([]);
		expect(parseCollections("", "/vault")).toEqual([]);
	});
});

describe("withIgnore", () => {
	it("changes only the ignore block", () => {
		const rules = ["Z - Template/**", "99 - Assets/**", ".trash/**", "*.aux", "10 - Clipping/**"];
		const edited = withIgnore(VAULT, "obsidian", rules);
		expect(edited).toBe(VAULT.replace('      - "*.aux"\n', '      - "*.aux"\n      - "10 - Clipping/**"\n'));
	});
	it("adds the key after pattern when there is none", () => {
		const text = 'collections:\n  a:\n    path: .\n    pattern: "**/*.md"\n    context:\n      "/": "x"\nmodels:\n  embed: e\n';
		expect(withIgnore(text, "a", ["b/**"])).toBe(
			'collections:\n  a:\n    path: .\n    pattern: "**/*.md"\n    ignore:\n      - "b/**"\n    context:\n      "/": "x"\nmodels:\n  embed: e\n'
		);
	});
	it("adds the key after path when there is no pattern", () => {
		expect(withIgnore("collections:\n  a:\n    path: .\n", "a", ["b/**"])).toBe('collections:\n  a:\n    path: .\n    ignore:\n      - "b/**"\n');
	});
	it("removes the key with the last entry", () => {
		const text = 'collections:\n  a:\n    path: .\n    ignore:\n      - "b/**"\n    context: {}\n';
		expect(withIgnore(text, "a", [])).toBe("collections:\n  a:\n    path: .\n    context: {}\n");
	});
	it("replaces flow lists", () => {
		const text = 'collections:\n  a:\n    path: .\n    ignore: ["x/**"]\n    pattern: "**/*.md"\n';
		expect(ignoreOf(withIgnore(text, "a", ["x/**", "y/**"]), "a")).toEqual(["x/**", "y/**"]);
		const multi = 'collections:\n  a:\n    path: .\n    ignore: [\n      "x/**"\n    ]\n    pattern: "**/*.md"\n';
		expect(withIgnore(multi, "a", ["y/**"])).toBe('collections:\n  a:\n    path: .\n    ignore:\n      - "y/**"\n    pattern: "**/*.md"\n');
	});
	it("handles a list at the same indent as its key", () => {
		const text = 'collections:\n  a:\n    path: .\n    ignore:\n    - "x/**"\n    pattern: "**/*.md"\n';
		expect(withIgnore(text, "a", ["y/**"])).toBe('collections:\n  a:\n    path: .\n    ignore:\n      - "y/**"\n    pattern: "**/*.md"\n');
	});
	it("touches one collection among several, including the last in the file", () => {
		const text = 'collections:\n  "my notes":\n    path: a\n    ignore:\n      - "x/**"\n\n  # work\n  other:\n    path: b\n    ignore:\n      - "x/**"\n';
		const first = withIgnore(text, "my notes", []);
		expect(first).toBe('collections:\n  "my notes":\n    path: a\n\n  # work\n  other:\n    path: b\n    ignore:\n      - "x/**"\n');
		const last = withIgnore(text, "other", ["y/**"]);
		expect(ignoreOf(last, "my notes")).toEqual(["x/**"]);
		expect(ignoreOf(last, "other")).toEqual(["y/**"]);
		expect(last.endsWith('      - "y/**"\n')).toBe(true);
	});
	it("does not mistake a nested ignore key for the list", () => {
		const text = 'collections:\n  a:\n    path: .\n    context:\n      ignore: "a context path"\n';
		expect(ignoreOf(withIgnore(text, "a", ["b/**"]), "a")).toEqual(["b/**"]);
		expect(withIgnore(text, "a", ["b/**"])).toContain('ignore: "a context path"');
	});
	it("keeps comments outside the block", () => {
		const text = '# top\ncollections:\n  a: # note\n    path: . # here\n    ignore:\n      - "b/**"\n# end\n';
		expect(withIgnore(text, "a", ["c/**"])).toBe('# top\ncollections:\n  a: # note\n    path: . # here\n    ignore:\n      - "c/**"\n# end\n');
	});
	it("writes names a YAML parser reads back exactly", () => {
		const rule = folderPattern('a "quoted" \\ (name)');
		expect(ignoreOf(withIgnore(VAULT, "obsidian", [rule]), "obsidian")).toEqual([rule]);
	});
	it("throws for layouts it cannot read", () => {
		expect(() => withIgnore("models:\n  embed: e\n", "a", ["b/**"])).toThrow();
		expect(() => withIgnore("collections: {}\n", "a", ["b/**"])).toThrow();
		expect(() => withIgnore(VAULT, "missing", ["b/**"])).toThrow();
	});
});

describe("editIsSafe", () => {
	const after = withIgnore(VAULT, "obsidian", ["a/**"]);
	it("accepts a change to the ignore list alone", () => {
		expect(editIsSafe(VAULT, after, "obsidian", ["a/**"])).toBe(true);
	});
	it("rejects a different list", () => {
		expect(editIsSafe(VAULT, after, "obsidian", ["b/**"])).toBe(false);
	});
	it("rejects any other change", () => {
		expect(editIsSafe(VAULT, after.replace("path: .", "path: elsewhere"), "obsidian", ["a/**"])).toBe(false);
		expect(editIsSafe(VAULT, after.replace("embed: hf", "generate: hf"), "obsidian", ["a/**"])).toBe(false);
	});
	it("rejects text that no longer parses", () => {
		expect(editIsSafe(VAULT, `${after}\n  - "bad\n`, "obsidian", ["a/**"])).toBe(false);
	});
});

describe("editIgnore", () => {
	it("returns the edit when it is safe", () => {
		expect(ignoreOf(editIgnore(VAULT, "obsidian", ["a/**"]), "obsidian")).toEqual(["a/**"]);
	});
	it("refuses a collection written as a flow mapping", () => {
		expect(() => editIgnore('collections:\n  a: {path: ., ignore: ["x/**"]}\n', "a", ["y/**"])).toThrow();
	});
});
