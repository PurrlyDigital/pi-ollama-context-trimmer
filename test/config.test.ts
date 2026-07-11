// ─── Unit tests — config resolution (pure) ──────────────────────────────
//
// Exercises `parseConfigFile` + `resolveConfig` with synthetic file
// contents and env records. No file I/O, no `process.env` — both
// inputs are passed in, so the precedence (env over file, file over
// defaults) is tested deterministically.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	resolveConfig,
	parseConfigFile,
	ENV,
	DEFAULT_PROTECT_DISPATCH,
	DEFAULT_LOOP_GUARD,
	type EnvRecord,
} from "../config.ts";

describe("parseConfigFile", () => {
	it("extracts well-typed fields", () => {
		const f = parseConfigFile({
			personalityPath: "/a/personality.md",
			protectDispatch: "auto",
		});
		assert.equal(f.personalityPath, "/a/personality.md");
		assert.equal(f.protectDispatch, "auto");
	});

	it("accepts boolean protectDispatch", () => {
		assert.equal(parseConfigFile({ protectDispatch: true }).protectDispatch, true);
		assert.equal(parseConfigFile({ protectDispatch: false }).protectDispatch, false);
	});

	it("ignores unknown keys", () => {
		const f = parseConfigFile({ unknown: "x", personalityPath: "/p" });
		assert.equal(f.personalityPath, "/p");
		assert.equal((f as Record<string, unknown>).unknown, undefined);
	});

	it("rejects badly-typed values", () => {
		const f = parseConfigFile({ personalityPath: 42, protectDispatch: "maybe" });
		assert.equal(f.personalityPath, undefined);
		assert.equal(f.protectDispatch, undefined);
	});

	it("returns empty for non-object input", () => {
		assert.deepEqual(parseConfigFile(null), {});
		assert.deepEqual(parseConfigFile("string"), {});
		assert.deepEqual(parseConfigFile(undefined), {});
	});
});

describe("resolveConfig — precedence", () => {
	it("defaults when nothing is configured", () => {
		const cfg = resolveConfig({});
		assert.equal(cfg.personalityPath, undefined);
		assert.equal(cfg.protectDispatch, DEFAULT_PROTECT_DISPATCH);
		assert.equal(cfg.protectDispatch, "auto");
	});

	it("uses file values when env is absent", () => {
		const cfg = resolveConfig({
			file: { personalityPath: "/file/p", protectDispatch: false },
		});
		assert.equal(cfg.personalityPath, "/file/p");
		assert.equal(cfg.protectDispatch, false);
	});

	it("env overrides file", () => {
		const env: EnvRecord = {
			[ENV.personalityPath]: "/env/p",
			[ENV.protectDispatch]: "1",
		};
		const cfg = resolveConfig({
			file: { personalityPath: "/file/p", protectDispatch: false },
			env,
		});
		assert.equal(cfg.personalityPath, "/env/p");
		assert.equal(cfg.protectDispatch, true);
	});

	it("env protectDispatch=0 forces OFF over file true", () => {
		const cfg = resolveConfig({
			file: { protectDispatch: true },
			env: { [ENV.protectDispatch]: "0" } as EnvRecord,
		});
		assert.equal(cfg.protectDispatch, false);
	});

	it("env protectDispatch unset falls back to file value", () => {
		const cfg = resolveConfig({
			file: { protectDispatch: true },
			env: {},
		});
		assert.equal(cfg.protectDispatch, true);
	});

	it("file protectDispatch 'auto' is honored", () => {
		const cfg = resolveConfig({ file: { protectDispatch: "auto" } });
		assert.equal(cfg.protectDispatch, "auto");
	});

	it("empty-string env is treated as unset (falls back to file)", () => {
		const env: EnvRecord = { [ENV.personalityPath]: "" };
		const cfg = resolveConfig({
			file: { personalityPath: "/file/p" },
			env,
		});
		assert.equal(cfg.personalityPath, "/file/p");
	});

	it("bogus env protectDispatch value is ignored (falls back to file/default)", () => {
		const cfg = resolveConfig({
			file: { protectDispatch: false },
			env: { [ENV.protectDispatch]: "maybe" } as EnvRecord,
		});
		assert.equal(cfg.protectDispatch, false);
	});
});

describe("preservedPaths", () => {
	// --- parseConfigFile (file channel) ---

	it("file parse: well-typed array of non-empty strings is extracted", () => {
		const f = parseConfigFile({ preservedPaths: ["AGENTS.md", "CLAUDE.md"] });
		assert.deepEqual(f.preservedPaths, ["AGENTS.md", "CLAUDE.md"]);
	});

	it("file parse: array with a non-string element is rejected (field undefined)", () => {
		const f = parseConfigFile({ preservedPaths: ["AGENTS.md", 42] });
		assert.equal(f.preservedPaths, undefined);
	});

	it("file parse: array with an empty string element is rejected (field undefined)", () => {
		const f = parseConfigFile({ preservedPaths: ["AGENTS.md", ""] });
		assert.equal(f.preservedPaths, undefined);
	});

	it("file parse: non-array value is rejected (field undefined)", () => {
		assert.equal(parseConfigFile({ preservedPaths: "AGENTS.md" }).preservedPaths, undefined);
		assert.equal(parseConfigFile({ preservedPaths: { a: 1 } }).preservedPaths, undefined);
		assert.equal(parseConfigFile({ preservedPaths: 42 }).preservedPaths, undefined);
	});

	it("file parse: missing key leaves the field undefined", () => {
		const f = parseConfigFile({ personalityPath: "/p" });
		assert.equal(f.preservedPaths, undefined);
	});

	it("file parse: empty array is accepted (no patterns)", () => {
		const f = parseConfigFile({ preservedPaths: [] });
		assert.deepEqual(f.preservedPaths, []);
	});

	// --- resolveConfig (env wins over file) ---

	it("resolveConfig: env wins over file (env present and non-empty)", () => {
		const cfg = resolveConfig({
			file: { preservedPaths: ["file-only"] },
			env: { [ENV.preservedPaths]: "AGENTS.md,~/CLAUDE.md" } as EnvRecord,
		});
		assert.deepEqual(cfg.preservedPaths, ["AGENTS.md", "~/CLAUDE.md"]);
	});

	it("resolveConfig: empty-string env falls back to file", () => {
		const cfg = resolveConfig({
			file: { preservedPaths: ["AGENTS.md"] },
			env: { [ENV.preservedPaths]: "" } as EnvRecord,
		});
		assert.deepEqual(cfg.preservedPaths, ["AGENTS.md"]);
	});

	it("resolveConfig: file-only (no env) returns the file list", () => {
		const cfg = resolveConfig({
			file: { preservedPaths: ["AGENTS.md", "CLAUDE.md"] },
		});
		assert.deepEqual(cfg.preservedPaths, ["AGENTS.md", "CLAUDE.md"]);
	});

	it("resolveConfig: nothing configured leaves the field undefined", () => {
		const cfg = resolveConfig({});
		assert.equal(cfg.preservedPaths, undefined);
	});

	// --- env parse grammar ---

	it("env parse: comma-separated, trimmed, empties filtered", () => {
		const cfg = resolveConfig({
			env: { [ENV.preservedPaths]: "AGENTS.md, CLAUDE.md ,,~/secrets.md" } as EnvRecord,
		});
		assert.deepEqual(cfg.preservedPaths, ["AGENTS.md", "CLAUDE.md", "~/secrets.md"]);
	});

	it("env parse: single value (no commas) is a list of one", () => {
		const cfg = resolveConfig({
			env: { [ENV.preservedPaths]: "AGENTS.md" } as EnvRecord,
		});
		assert.deepEqual(cfg.preservedPaths, ["AGENTS.md"]);
	});

	it("env parse: whitespace-only commas are dropped", () => {
		const cfg = resolveConfig({
			env: { [ENV.preservedPaths]: "  ,  ,AGENTS.md,  " } as EnvRecord,
		});
		assert.deepEqual(cfg.preservedPaths, ["AGENTS.md"]);
	});

	it("env parse: all-whitespace / all-commas env is treated as unset", () => {
		const cfg = resolveConfig({
			file: { preservedPaths: ["file-only"] },
			env: { [ENV.preservedPaths]: " , , " } as EnvRecord,
		});
		assert.deepEqual(cfg.preservedPaths, ["file-only"]);
	});

	// --- ENV map ---

	it("ENV.preservedPaths is the documented namespace", () => {
		assert.equal(ENV.preservedPaths, "PI_CONTEXT_TRIMMER_PRESERVED_PATHS");
	});
});

describe("tier1MaxTokens", () => {
	// --- parseConfigFile (file channel) ---

	it("file parse: well-typed positive number is extracted", () => {
		assert.equal(parseConfigFile({ tier1MaxTokens: 75000 }).tier1MaxTokens, 75000);
	});

	it("file parse: non-numeric value (string) is treated as absent", () => {
		assert.equal(parseConfigFile({ tier1MaxTokens: "75000" }).tier1MaxTokens, undefined);
	});

	it("file parse: zero is treated as absent (not a valid token budget)", () => {
		assert.equal(parseConfigFile({ tier1MaxTokens: 0 }).tier1MaxTokens, undefined);
	});

	it("file parse: negative number is treated as absent", () => {
		assert.equal(parseConfigFile({ tier1MaxTokens: -100 }).tier1MaxTokens, undefined);
	});

	it("file parse: NaN is treated as absent", () => {
		assert.equal(parseConfigFile({ tier1MaxTokens: Number.NaN }).tier1MaxTokens, undefined);
	});

	it("file parse: Infinity is treated as absent", () => {
		assert.equal(parseConfigFile({ tier1MaxTokens: Number.POSITIVE_INFINITY }).tier1MaxTokens, undefined);
		assert.equal(parseConfigFile({ tier1MaxTokens: Number.NEGATIVE_INFINITY }).tier1MaxTokens, undefined);
	});

	it("file parse: missing key leaves the field undefined", () => {
		assert.equal(parseConfigFile({ personalityPath: "/p" }).tier1MaxTokens, undefined);
	});

	// --- resolveConfig (env wins over file) ---

	it("resolveConfig: env wins over file", () => {
		const cfg = resolveConfig({
			file: { tier1MaxTokens: 50_000 },
			env: { [ENV.tier1MaxTokens]: "75000" } as EnvRecord,
		});
		assert.equal(cfg.tier1MaxTokens, 75000);
	});

	it("resolveConfig: empty-string env falls back to file", () => {
		const cfg = resolveConfig({
			file: { tier1MaxTokens: 50_000 },
			env: { [ENV.tier1MaxTokens]: "" } as EnvRecord,
		});
		assert.equal(cfg.tier1MaxTokens, 50_000);
	});

	it("resolveConfig: non-numeric env falls back to file", () => {
		const cfg = resolveConfig({
			file: { tier1MaxTokens: 50_000 },
			env: { [ENV.tier1MaxTokens]: "not-a-number" } as EnvRecord,
		});
		assert.equal(cfg.tier1MaxTokens, 50_000);
	});

	it("resolveConfig: file-only returns the file value", () => {
		const cfg = resolveConfig({ file: { tier1MaxTokens: 75_000 } });
		assert.equal(cfg.tier1MaxTokens, 75_000);
	});

	it("resolveConfig: nothing configured leaves the field undefined", () => {
		const cfg = resolveConfig({});
		assert.equal(cfg.tier1MaxTokens, undefined);
	});

	// --- env parse grammar ---

	it("env parse: numeric string is coerced to number", () => {
		const cfg = resolveConfig({
			env: { [ENV.tier1MaxTokens]: "125000" } as EnvRecord,
		});
		assert.equal(cfg.tier1MaxTokens, 125000);
		assert.equal(typeof cfg.tier1MaxTokens, "number");
	});

	// --- ENV map ---

	it("ENV.tier1MaxTokens is the documented namespace", () => {
		assert.equal(ENV.tier1MaxTokens, "PI_CONTEXT_TRIMMER_TIER1_MAX_TOKENS");
	});
});

describe("tier2MaxTokens", () => {
	// --- parseConfigFile (file channel) ---

	it("file parse: well-typed positive number is extracted", () => {
		assert.equal(parseConfigFile({ tier2MaxTokens: 150000 }).tier2MaxTokens, 150000);
	});

	it("file parse: non-numeric value (string) is treated as absent", () => {
		assert.equal(parseConfigFile({ tier2MaxTokens: "150000" }).tier2MaxTokens, undefined);
	});

	it("file parse: zero is treated as absent (not a valid token budget)", () => {
		assert.equal(parseConfigFile({ tier2MaxTokens: 0 }).tier2MaxTokens, undefined);
	});

	it("file parse: negative number is treated as absent", () => {
		assert.equal(parseConfigFile({ tier2MaxTokens: -200 }).tier2MaxTokens, undefined);
	});

	it("file parse: NaN is treated as absent", () => {
		assert.equal(parseConfigFile({ tier2MaxTokens: Number.NaN }).tier2MaxTokens, undefined);
	});

	it("file parse: Infinity is treated as absent", () => {
		assert.equal(parseConfigFile({ tier2MaxTokens: Number.POSITIVE_INFINITY }).tier2MaxTokens, undefined);
		assert.equal(parseConfigFile({ tier2MaxTokens: Number.NEGATIVE_INFINITY }).tier2MaxTokens, undefined);
	});

	it("file parse: missing key leaves the field undefined", () => {
		assert.equal(parseConfigFile({ personalityPath: "/p" }).tier2MaxTokens, undefined);
	});

	// --- resolveConfig (env wins over file) ---

	it("resolveConfig: env wins over file", () => {
		const cfg = resolveConfig({
			file: { tier2MaxTokens: 100_000 },
			env: { [ENV.tier2MaxTokens]: "150000" } as EnvRecord,
		});
		assert.equal(cfg.tier2MaxTokens, 150000);
	});

	it("resolveConfig: empty-string env falls back to file", () => {
		const cfg = resolveConfig({
			file: { tier2MaxTokens: 100_000 },
			env: { [ENV.tier2MaxTokens]: "" } as EnvRecord,
		});
		assert.equal(cfg.tier2MaxTokens, 100_000);
	});

	it("resolveConfig: non-numeric env falls back to file", () => {
		const cfg = resolveConfig({
			file: { tier2MaxTokens: 100_000 },
			env: { [ENV.tier2MaxTokens]: "abc" } as EnvRecord,
		});
		assert.equal(cfg.tier2MaxTokens, 100_000);
	});

	it("resolveConfig: file-only returns the file value", () => {
		const cfg = resolveConfig({ file: { tier2MaxTokens: 150_000 } });
		assert.equal(cfg.tier2MaxTokens, 150_000);
	});

	it("resolveConfig: nothing configured leaves the field undefined", () => {
		const cfg = resolveConfig({});
		assert.equal(cfg.tier2MaxTokens, undefined);
	});

	// --- env parse grammar ---

	it("env parse: numeric string is coerced to number", () => {
		const cfg = resolveConfig({
			env: { [ENV.tier2MaxTokens]: "200000" } as EnvRecord,
		});
		assert.equal(cfg.tier2MaxTokens, 200000);
		assert.equal(typeof cfg.tier2MaxTokens, "number");
	});

	// --- ENV map ---

	it("ENV.tier2MaxTokens is the documented namespace", () => {
		assert.equal(ENV.tier2MaxTokens, "PI_CONTEXT_TRIMMER_TIER2_MAX_TOKENS");
	});
});

describe("summaWords", () => {
	// --- parseConfigFile (file channel) ---

	it("file parse: well-typed positive number is extracted", () => {
		assert.equal(parseConfigFile({ summaWords: 100 }).summaWords, 100);
	});

	it("file parse: non-numeric value (string) is treated as absent", () => {
		assert.equal(parseConfigFile({ summaWords: "100" }).summaWords, undefined);
	});

	it("file parse: zero is treated as absent (not a valid word cap)", () => {
		assert.equal(parseConfigFile({ summaWords: 0 }).summaWords, undefined);
	});

	it("file parse: negative number is treated as absent", () => {
		assert.equal(parseConfigFile({ summaWords: -50 }).summaWords, undefined);
	});

	it("file parse: NaN is treated as absent", () => {
		assert.equal(parseConfigFile({ summaWords: Number.NaN }).summaWords, undefined);
	});

	it("file parse: Infinity is treated as absent", () => {
		assert.equal(parseConfigFile({ summaWords: Number.POSITIVE_INFINITY }).summaWords, undefined);
		assert.equal(parseConfigFile({ summaWords: Number.NEGATIVE_INFINITY }).summaWords, undefined);
	});

	it("file parse: missing key leaves the field undefined", () => {
		assert.equal(parseConfigFile({ personalityPath: "/p" }).summaWords, undefined);
	});

	// --- resolveConfig (env wins over file) ---

	it("resolveConfig: env wins over file", () => {
		const cfg = resolveConfig({
			file: { summaWords: 60 },
			env: { [ENV.summaWords]: "100" } as EnvRecord,
		});
		assert.equal(cfg.summaWords, 100);
	});

	it("resolveConfig: empty-string env falls back to file", () => {
		const cfg = resolveConfig({
			file: { summaWords: 60 },
			env: { [ENV.summaWords]: "" } as EnvRecord,
		});
		assert.equal(cfg.summaWords, 60);
	});

	it("resolveConfig: non-numeric env falls back to file", () => {
		const cfg = resolveConfig({
			file: { summaWords: 60 },
			env: { [ENV.summaWords]: "lots" } as EnvRecord,
		});
		assert.equal(cfg.summaWords, 60);
	});

	it("resolveConfig: file-only returns the file value", () => {
		const cfg = resolveConfig({ file: { summaWords: 80 } });
		assert.equal(cfg.summaWords, 80);
	});

	it("resolveConfig: nothing configured leaves the field undefined", () => {
		const cfg = resolveConfig({});
		assert.equal(cfg.summaWords, undefined);
	});

	// --- env parse grammar ---

	it("env parse: numeric string is coerced to number", () => {
		const cfg = resolveConfig({
			env: { [ENV.summaWords]: "120" } as EnvRecord,
		});
		assert.equal(cfg.summaWords, 120);
		assert.equal(typeof cfg.summaWords, "number");
	});

	// --- ENV map ---

	it("ENV.summaWords is the documented namespace", () => {
		assert.equal(ENV.summaWords, "PI_CONTEXT_TRIMMER_SUMMA_WORDS");
	});
});

describe("tier-threshold fields — per-field independence", () => {
	it("file parse: one field malformed does not poison the others", () => {
		const f = parseConfigFile({
			tier1MaxTokens: 75_000,
			tier2MaxTokens: "not-a-number",
			summaWords: 80,
		});
		assert.equal(f.tier1MaxTokens, 75_000);
		assert.equal(f.tier2MaxTokens, undefined);
		assert.equal(f.summaWords, 80);
	});

	it("resolveConfig: env sets one field, file sets another, third is undefined", () => {
		const cfg = resolveConfig({
			file: { tier2MaxTokens: 200_000 },
			env: { [ENV.tier1MaxTokens]: "75000" } as EnvRecord,
		});
		assert.equal(cfg.tier1MaxTokens, 75000);
		assert.equal(cfg.tier2MaxTokens, 200_000);
		assert.equal(cfg.summaWords, undefined);
	});
});

describe("dropFloorPercent", () => {
	// --- parseConfigFile (file channel) ---

	it("file parse: a value in (0, 100] is extracted (50, 1, 100 all valid)", () => {
		assert.equal(parseConfigFile({ dropFloorPercent: 50 }).dropFloorPercent, 50);
		assert.equal(parseConfigFile({ dropFloorPercent: 1 }).dropFloorPercent, 1);
		// 100 is the upper bound — accepted (drop effectively
		// disabled: 100% of the cap means the floor equals the
		// cap, which the drop never undershoots).
		assert.equal(parseConfigFile({ dropFloorPercent: 100 }).dropFloorPercent, 100);
	});

	it("file parse: 0 is treated as absent (open-lower bound excludes 0)", () => {
		assert.equal(parseConfigFile({ dropFloorPercent: 0 }).dropFloorPercent, undefined);
	});

	it("file parse: 101 is treated as absent (open-upper bound excludes >100)", () => {
		assert.equal(parseConfigFile({ dropFloorPercent: 101 }).dropFloorPercent, undefined);
	});

	it("file parse: negative is treated as absent", () => {
		assert.equal(parseConfigFile({ dropFloorPercent: -50 }).dropFloorPercent, undefined);
	});

	it("file parse: NaN is treated as absent", () => {
		assert.equal(parseConfigFile({ dropFloorPercent: Number.NaN }).dropFloorPercent, undefined);
	});

	it("file parse: Infinity (positive or negative) is treated as absent", () => {
		assert.equal(parseConfigFile({ dropFloorPercent: Number.POSITIVE_INFINITY }).dropFloorPercent, undefined);
		assert.equal(parseConfigFile({ dropFloorPercent: Number.NEGATIVE_INFINITY }).dropFloorPercent, undefined);
	});

	it("file parse: non-numeric (string) is treated as absent", () => {
		assert.equal(parseConfigFile({ dropFloorPercent: "50" }).dropFloorPercent, undefined);
	});

	it("file parse: missing key leaves the field undefined", () => {
		assert.equal(parseConfigFile({ tier1MaxTokens: 50_000 }).dropFloorPercent, undefined);
	});

	// --- resolveConfig (env wins over file) ---

	it("resolveConfig: env wins over file", () => {
		const cfg = resolveConfig({
			file: { dropFloorPercent: 50 },
			env: { [ENV.dropFloorPercent]: "75" } as EnvRecord,
		});
		assert.equal(cfg.dropFloorPercent, 75);
	});

	it("resolveConfig: empty-string env falls back to file", () => {
		const cfg = resolveConfig({
			file: { dropFloorPercent: 50 },
			env: { [ENV.dropFloorPercent]: "" } as EnvRecord,
		});
		assert.equal(cfg.dropFloorPercent, 50);
	});

	it("resolveConfig: out-of-range env (0, 101, negative) falls back to file", () => {
		const cfgZero = resolveConfig({
			file: { dropFloorPercent: 50 },
			env: { [ENV.dropFloorPercent]: "0" } as EnvRecord,
		});
		assert.equal(cfgZero.dropFloorPercent, 50);
		const cfg101 = resolveConfig({
			file: { dropFloorPercent: 50 },
			env: { [ENV.dropFloorPercent]: "101" } as EnvRecord,
		});
		assert.equal(cfg101.dropFloorPercent, 50);
		const cfgNeg = resolveConfig({
			file: { dropFloorPercent: 50 },
			env: { [ENV.dropFloorPercent]: "-10" } as EnvRecord,
		});
		assert.equal(cfgNeg.dropFloorPercent, 50);
	});

	it("resolveConfig: non-numeric env falls back to file", () => {
		const cfg = resolveConfig({
			file: { dropFloorPercent: 50 },
			env: { [ENV.dropFloorPercent]: "half" } as EnvRecord,
		});
		assert.equal(cfg.dropFloorPercent, 50);
	});

	it("resolveConfig: file-only returns the file value", () => {
		const cfg = resolveConfig({ file: { dropFloorPercent: 75 } });
		assert.equal(cfg.dropFloorPercent, 75);
	});

	it("resolveConfig: nothing configured leaves the field undefined", () => {
		const cfg = resolveConfig({});
		assert.equal(cfg.dropFloorPercent, undefined);
	});

	// --- env parse grammar ---

	it("env parse: numeric string in (0, 100] is coerced to number", () => {
		const cfg = resolveConfig({
			env: { [ENV.dropFloorPercent]: "60" } as EnvRecord,
		});
		assert.equal(cfg.dropFloorPercent, 60);
		assert.equal(typeof cfg.dropFloorPercent, "number");
	});

	// --- ENV map ---

	it("ENV.dropFloorPercent is the documented namespace", () => {
		assert.equal(ENV.dropFloorPercent, "PI_CONTEXT_TRIMMER_DROP_FLOOR_PERCENT");
	});
});

describe("recencyFloor", () => {
	// --- parseConfigFile (file channel) ---

	it("file parse: a positive number is extracted", () => {
		assert.equal(parseConfigFile({ recencyFloor: 5000 }).recencyFloor, 5000);
		assert.equal(parseConfigFile({ recencyFloor: 1 }).recencyFloor, 1);
	});

	it("file parse: 0 is treated as absent (matches isPositiveNumber's open-lower bound)", () => {
		assert.equal(parseConfigFile({ recencyFloor: 0 }).recencyFloor, undefined);
	});

	it("file parse: negative is treated as absent", () => {
		assert.equal(parseConfigFile({ recencyFloor: -100 }).recencyFloor, undefined);
	});

	it("file parse: NaN is treated as absent", () => {
		assert.equal(parseConfigFile({ recencyFloor: Number.NaN }).recencyFloor, undefined);
	});

	it("file parse: Infinity (positive or negative) is treated as absent", () => {
		assert.equal(parseConfigFile({ recencyFloor: Number.POSITIVE_INFINITY }).recencyFloor, undefined);
		assert.equal(parseConfigFile({ recencyFloor: Number.NEGATIVE_INFINITY }).recencyFloor, undefined);
	});

	it("file parse: non-numeric (string) is treated as absent", () => {
		assert.equal(parseConfigFile({ recencyFloor: "5000" }).recencyFloor, undefined);
	});

	it("file parse: missing key leaves the field undefined", () => {
		assert.equal(parseConfigFile({ tier1MaxTokens: 50_000 }).recencyFloor, undefined);
	});

	// --- resolveConfig (env wins over file) ---

	it("resolveConfig: env wins over file", () => {
		const cfg = resolveConfig({
			file: { recencyFloor: 5000 },
			env: { [ENV.recencyFloor]: "10000" } as EnvRecord,
		});
		assert.equal(cfg.recencyFloor, 10000);
	});

	it("resolveConfig: empty-string env falls back to file", () => {
		const cfg = resolveConfig({
			file: { recencyFloor: 5000 },
			env: { [ENV.recencyFloor]: "" } as EnvRecord,
		});
		assert.equal(cfg.recencyFloor, 5000);
	});

	it("resolveConfig: non-positive env (0, negative) falls back to file", () => {
		const cfgZero = resolveConfig({
			file: { recencyFloor: 5000 },
			env: { [ENV.recencyFloor]: "0" } as EnvRecord,
		});
		assert.equal(cfgZero.recencyFloor, 5000);
		const cfgNeg = resolveConfig({
			file: { recencyFloor: 5000 },
			env: { [ENV.recencyFloor]: "-1" } as EnvRecord,
		});
		assert.equal(cfgNeg.recencyFloor, 5000);
	});

	it("resolveConfig: non-numeric env falls back to file", () => {
		const cfg = resolveConfig({
			file: { recencyFloor: 5000 },
			env: { [ENV.recencyFloor]: "lots" } as EnvRecord,
		});
		assert.equal(cfg.recencyFloor, 5000);
	});

	it("resolveConfig: file-only returns the file value", () => {
		const cfg = resolveConfig({ file: { recencyFloor: 7500 } });
		assert.equal(cfg.recencyFloor, 7500);
	});

	it("resolveConfig: nothing configured leaves the field undefined", () => {
		const cfg = resolveConfig({});
		assert.equal(cfg.recencyFloor, undefined);
	});

	// --- env parse grammar ---

	it("env parse: numeric string is coerced to number", () => {
		const cfg = resolveConfig({
			env: { [ENV.recencyFloor]: "20000" } as EnvRecord,
		});
		assert.equal(cfg.recencyFloor, 20000);
		assert.equal(typeof cfg.recencyFloor, "number");
	});

	// --- ENV map ---

	it("ENV.recencyFloor is the documented namespace", () => {
		assert.equal(ENV.recencyFloor, "PI_CONTEXT_TRIMMER_RECENCY_FLOOR");
	});
});

// ─── loopGuard (defense-in-depth for model-caused loops) ───────────────
//
// The loop-guard enable mode is opt-out: `loopGuard` in the config
// file or `PI_CONTEXT_TRIMMER_LOOP_GUARD` in env. `true` (default)
// turns the guard ON for every session; `false` turns it off. The
// guard is universal across session postures — the previous `"auto"`
// posture coupled the guard to a subagent-tool probe, but
// behavioral-loop detection is the same concern whether the model is
// in a parent or a subagent session, so the coupling was dropped.
// `parseConfigFile` accepts only the boolean shape; any other value
// (string, number, the previous `"auto"` sentinel) is treated as
// absent and the resolver falls through to the default `true`.

describe("loopGuard", () => {
	// --- parseConfigFile (file channel) ---

	it("file parse: boolean true is extracted", () => {
		assert.equal(parseConfigFile({ loopGuard: true }).loopGuard, true);
	});

	it("file parse: boolean false is extracted", () => {
		assert.equal(parseConfigFile({ loopGuard: false }).loopGuard, false);
	});

	it("file parse: the previous 'auto' string is treated as absent (sentinel was dropped)", () => {
		assert.equal(parseConfigFile({ loopGuard: "auto" }).loopGuard, undefined);
	});

	it("file parse: arbitrary string is treated as absent", () => {
		assert.equal(parseConfigFile({ loopGuard: "on" }).loopGuard, undefined);
		assert.equal(parseConfigFile({ loopGuard: "yes" }).loopGuard, undefined);
		assert.equal(parseConfigFile({ loopGuard: "" }).loopGuard, undefined);
	});

	it("file parse: number is treated as absent (boolean only)", () => {
		assert.equal(parseConfigFile({ loopGuard: 1 }).loopGuard, undefined);
		assert.equal(parseConfigFile({ loopGuard: 0 }).loopGuard, undefined);
	});

	it("file parse: missing key leaves the field undefined", () => {
		assert.equal(parseConfigFile({ personalityPath: "/p" }).loopGuard, undefined);
	});

	// --- resolveConfig (env wins over file) ---

	it("resolveConfig: env '1' forces loopGuard true over file false", () => {
		const cfg = resolveConfig({
			file: { loopGuard: false },
			env: { [ENV.loopGuard]: "1" } as EnvRecord,
		});
		assert.equal(cfg.loopGuard, true);
	});

	it("resolveConfig: env '0' forces loopGuard false over file true", () => {
		const cfg = resolveConfig({
			file: { loopGuard: true },
			env: { [ENV.loopGuard]: "0" } as EnvRecord,
		});
		assert.equal(cfg.loopGuard, false);
	});

	it("resolveConfig: env unset falls back to file value (boolean)", () => {
		const cfgTrue = resolveConfig({
			file: { loopGuard: true },
			env: {} as EnvRecord,
		});
		assert.equal(cfgTrue.loopGuard, true);
		const cfgFalse = resolveConfig({
			file: { loopGuard: false },
			env: {} as EnvRecord,
		});
		assert.equal(cfgFalse.loopGuard, false);
	});

	it("resolveConfig: env bogus value falls through to file then default true", () => {
		const cfgFromFile = resolveConfig({
			file: { loopGuard: true },
			env: { [ENV.loopGuard]: "on" } as EnvRecord,
		});
		assert.equal(cfgFromFile.loopGuard, true);
		const cfgFromDefault = resolveConfig({
			env: { [ENV.loopGuard]: "yes" } as EnvRecord,
		});
		assert.equal(cfgFromDefault.loopGuard, DEFAULT_LOOP_GUARD);
		assert.equal(cfgFromDefault.loopGuard, true);
	});

	it("resolveConfig: env 'auto' falls through to file then default true (sentinel was dropped)", () => {
		const cfgFromFile = resolveConfig({
			file: { loopGuard: true },
			env: { [ENV.loopGuard]: "auto" } as EnvRecord,
		});
		assert.equal(cfgFromFile.loopGuard, true);
		const cfgFromDefault = resolveConfig({
			env: { [ENV.loopGuard]: "auto" } as EnvRecord,
		});
		assert.equal(cfgFromDefault.loopGuard, DEFAULT_LOOP_GUARD);
		assert.equal(cfgFromDefault.loopGuard, true);
	});

	it("resolveConfig: empty-string env falls back to file", () => {
		const cfg = resolveConfig({
			file: { loopGuard: false },
			env: { [ENV.loopGuard]: "" } as EnvRecord,
		});
		assert.equal(cfg.loopGuard, false);
	});

	it("resolveConfig: file boolean is honored when env is unset", () => {
		const cfgOn = resolveConfig({ file: { loopGuard: true } });
		assert.equal(cfgOn.loopGuard, true);
		const cfgOff = resolveConfig({ file: { loopGuard: false } });
		assert.equal(cfgOff.loopGuard, false);
	});

	it("resolveConfig: nothing configured returns the default true (ON for all sessions)", () => {
		const cfg = resolveConfig({});
		assert.equal(cfg.loopGuard, DEFAULT_LOOP_GUARD);
		assert.equal(cfg.loopGuard, true);
	});

	// --- ENV map ---

	it("ENV.loopGuard is the documented namespace", () => {
		assert.equal(ENV.loopGuard, "PI_CONTEXT_TRIMMER_LOOP_GUARD");
	});
});

// ─── loopGuardThreshold (nudge threshold, positive integer) ────────────

describe("loopGuardThreshold", () => {
	// --- parseConfigFile (file channel) ---

	it("file parse: positive integer is extracted", () => {
		assert.equal(parseConfigFile({ loopGuardThreshold: 3 }).loopGuardThreshold, 3);
		assert.equal(parseConfigFile({ loopGuardThreshold: 1 }).loopGuardThreshold, 1);
		assert.equal(parseConfigFile({ loopGuardThreshold: 100 }).loopGuardThreshold, 100);
	});

	it("file parse: zero is treated as absent (matches isPositiveNumber's open-lower bound)", () => {
		assert.equal(parseConfigFile({ loopGuardThreshold: 0 }).loopGuardThreshold, undefined);
	});

	it("file parse: negative number is treated as absent", () => {
		assert.equal(parseConfigFile({ loopGuardThreshold: -1 }).loopGuardThreshold, undefined);
		assert.equal(parseConfigFile({ loopGuardThreshold: -100 }).loopGuardThreshold, undefined);
	});

	it("file parse: NaN is treated as absent", () => {
		assert.equal(parseConfigFile({ loopGuardThreshold: Number.NaN }).loopGuardThreshold, undefined);
	});

	it("file parse: Infinity (positive or negative) is treated as absent", () => {
		assert.equal(parseConfigFile({ loopGuardThreshold: Number.POSITIVE_INFINITY }).loopGuardThreshold, undefined);
		assert.equal(parseConfigFile({ loopGuardThreshold: Number.NEGATIVE_INFINITY }).loopGuardThreshold, undefined);
	});

	it("file parse: non-numeric (string) is treated as absent", () => {
		assert.equal(parseConfigFile({ loopGuardThreshold: "3" }).loopGuardThreshold, undefined);
	});

	it("file parse: missing key leaves the field undefined", () => {
		assert.equal(parseConfigFile({ personalityPath: "/p" }).loopGuardThreshold, undefined);
	});

	// --- resolveConfig (env wins over file) ---

	it("resolveConfig: env wins over file", () => {
		const cfg = resolveConfig({
			file: { loopGuardThreshold: 3 },
			env: { [ENV.loopGuardThreshold]: "5" } as EnvRecord,
		});
		assert.equal(cfg.loopGuardThreshold, 5);
	});

	it("resolveConfig: empty-string env falls back to file", () => {
		const cfg = resolveConfig({
			file: { loopGuardThreshold: 3 },
			env: { [ENV.loopGuardThreshold]: "" } as EnvRecord,
		});
		assert.equal(cfg.loopGuardThreshold, 3);
	});

	it("resolveConfig: non-positive env (0, negative) falls back to file", () => {
		const cfgZero = resolveConfig({
			file: { loopGuardThreshold: 3 },
			env: { [ENV.loopGuardThreshold]: "0" } as EnvRecord,
		});
		assert.equal(cfgZero.loopGuardThreshold, 3);
		const cfgNeg = resolveConfig({
			file: { loopGuardThreshold: 3 },
			env: { [ENV.loopGuardThreshold]: "-1" } as EnvRecord,
		});
		assert.equal(cfgNeg.loopGuardThreshold, 3);
	});

	it("resolveConfig: non-numeric env falls back to file", () => {
		const cfg = resolveConfig({
			file: { loopGuardThreshold: 3 },
			env: { [ENV.loopGuardThreshold]: "lots" } as EnvRecord,
		});
		assert.equal(cfg.loopGuardThreshold, 3);
	});

	it("resolveConfig: file-only returns the file value", () => {
		const cfg = resolveConfig({ file: { loopGuardThreshold: 7 } });
		assert.equal(cfg.loopGuardThreshold, 7);
	});

	it("resolveConfig: nothing configured leaves the field undefined", () => {
		const cfg = resolveConfig({});
		assert.equal(cfg.loopGuardThreshold, undefined);
	});

	// --- env parse grammar ---

	it("env parse: numeric string is coerced to number", () => {
		const cfg = resolveConfig({
			env: { [ENV.loopGuardThreshold]: "10" } as EnvRecord,
		});
		assert.equal(cfg.loopGuardThreshold, 10);
		assert.equal(typeof cfg.loopGuardThreshold, "number");
	});

	// --- ENV map ---

	it("ENV.loopGuardThreshold is the documented namespace", () => {
		assert.equal(ENV.loopGuardThreshold, "PI_CONTEXT_TRIMMER_LOOP_GUARD_THRESHOLD");
	});
});

// ─── loopGuardHardBlock (hard-block threshold, positive integer) ──────

describe("loopGuardHardBlock", () => {
	// --- parseConfigFile (file channel) ---

	it("file parse: positive integer is extracted", () => {
		assert.equal(parseConfigFile({ loopGuardHardBlock: 3 }).loopGuardHardBlock, 3);
		assert.equal(parseConfigFile({ loopGuardHardBlock: 1 }).loopGuardHardBlock, 1);
		assert.equal(parseConfigFile({ loopGuardHardBlock: 100 }).loopGuardHardBlock, 100);
	});

	it("file parse: zero is treated as absent (matches isPositiveNumber's open-lower bound)", () => {
		assert.equal(parseConfigFile({ loopGuardHardBlock: 0 }).loopGuardHardBlock, undefined);
	});

	it("file parse: negative number is treated as absent", () => {
		assert.equal(parseConfigFile({ loopGuardHardBlock: -1 }).loopGuardHardBlock, undefined);
		assert.equal(parseConfigFile({ loopGuardHardBlock: -100 }).loopGuardHardBlock, undefined);
	});

	it("file parse: NaN is treated as absent", () => {
		assert.equal(parseConfigFile({ loopGuardHardBlock: Number.NaN }).loopGuardHardBlock, undefined);
	});

	it("file parse: Infinity (positive or negative) is treated as absent", () => {
		assert.equal(parseConfigFile({ loopGuardHardBlock: Number.POSITIVE_INFINITY }).loopGuardHardBlock, undefined);
		assert.equal(parseConfigFile({ loopGuardHardBlock: Number.NEGATIVE_INFINITY }).loopGuardHardBlock, undefined);
	});

	it("file parse: non-numeric (string) is treated as absent", () => {
		assert.equal(parseConfigFile({ loopGuardHardBlock: "3" }).loopGuardHardBlock, undefined);
	});

	it("file parse: missing key leaves the field undefined", () => {
		assert.equal(parseConfigFile({ personalityPath: "/p" }).loopGuardHardBlock, undefined);
	});

	// --- resolveConfig (env wins over file) ---

	it("resolveConfig: env wins over file", () => {
		const cfg = resolveConfig({
			file: { loopGuardHardBlock: 3 },
			env: { [ENV.loopGuardHardBlock]: "7" } as EnvRecord,
		});
		assert.equal(cfg.loopGuardHardBlock, 7);
	});

	it("resolveConfig: empty-string env falls back to file", () => {
		const cfg = resolveConfig({
			file: { loopGuardHardBlock: 3 },
			env: { [ENV.loopGuardHardBlock]: "" } as EnvRecord,
		});
		assert.equal(cfg.loopGuardHardBlock, 3);
	});

	it("resolveConfig: non-positive env (0, negative) falls back to file", () => {
		const cfgZero = resolveConfig({
			file: { loopGuardHardBlock: 3 },
			env: { [ENV.loopGuardHardBlock]: "0" } as EnvRecord,
		});
		assert.equal(cfgZero.loopGuardHardBlock, 3);
		const cfgNeg = resolveConfig({
			file: { loopGuardHardBlock: 3 },
			env: { [ENV.loopGuardHardBlock]: "-1" } as EnvRecord,
		});
		assert.equal(cfgNeg.loopGuardHardBlock, 3);
	});

	it("resolveConfig: non-numeric env falls back to file", () => {
		const cfg = resolveConfig({
			file: { loopGuardHardBlock: 3 },
			env: { [ENV.loopGuardHardBlock]: "many" } as EnvRecord,
		});
		assert.equal(cfg.loopGuardHardBlock, 3);
	});

	it("resolveConfig: file-only returns the file value", () => {
		const cfg = resolveConfig({ file: { loopGuardHardBlock: 5 } });
		assert.equal(cfg.loopGuardHardBlock, 5);
	});

	it("resolveConfig: nothing configured leaves the field undefined (hard-block off by default)", () => {
		const cfg = resolveConfig({});
		assert.equal(cfg.loopGuardHardBlock, undefined);
	});

	// --- env parse grammar ---

	it("env parse: numeric string is coerced to number", () => {
		const cfg = resolveConfig({
			env: { [ENV.loopGuardHardBlock]: "8" } as EnvRecord,
		});
		assert.equal(cfg.loopGuardHardBlock, 8);
		assert.equal(typeof cfg.loopGuardHardBlock, "number");
	});

	// --- ENV map ---

	it("ENV.loopGuardHardBlock is the documented namespace", () => {
		assert.equal(ENV.loopGuardHardBlock, "PI_CONTEXT_TRIMMER_LOOP_GUARD_HARD_BLOCK");
	});
});

