import { expect, test } from "bun:test";

import { ENGINE_MODELS } from "@/lib/agent/models";

import { GLYPH_STATE, modelGlyphKind, modelGlyphName } from "./modelGlyph";

test("every catalogued Claude and Codex model has its glyph, by family", () => {
  expect(ENGINE_MODELS.claude.map((option) => modelGlyphKind("claude", option.id))).toEqual(["opus", "fable", "sonnet", "sonnet", "haiku"]);
  expect(ENGINE_MODELS.codex.map((option) => [option.id, modelGlyphKind("codex", option.id)])).toEqual([
    ["gpt-6-astra", "astra"],
    ["gpt-6.1-sol", "sol"],
    ["gpt-6-sol", "sol"],
    ["gpt-6-luna", "luna"],
    ["gpt-5.6-sol", "sol"],
    ["gpt-5.6-terra", "terra"],
    ["gpt-5.6-luna", "luna"],
  ]);
});

test("versioned Claude ids read as their family, as resume and migration read them", () => {
  expect(modelGlyphKind("claude", "opus-5-5")).toBe("opus");
  expect(modelGlyphKind("claude", "claude-fable-5-1")).toBe("fable");
  expect(modelGlyphKind("claude", "claude-sonnet-5")).toBe("sonnet");
  expect(modelGlyphKind("claude", "Haiku")).toBe("haiku");
});

test("any other model, engine or a blank record has no glyph, so the host keeps its dot", () => {
  expect(modelGlyphKind("codex", "gpt-5.5")).toBeNull();
  expect(modelGlyphKind("codex", "gpt-6-nova")).toBeNull();
  expect(modelGlyphKind("codex", "sol")).toBeNull();
  expect(modelGlyphKind("claude", "mythos-1")).toBeNull();
  expect(modelGlyphKind("claude", "")).toBeNull();
  expect(modelGlyphKind("claude", null)).toBeNull();
  /* The same families on another runtime are not the runtime the glyph names. */
  expect(modelGlyphKind("copilot", "claude-sonnet-5")).toBeNull();
  expect(modelGlyphKind("codex", "opus")).toBeNull();
  expect(modelGlyphKind("shell", "gpt-6-sol")).toBeNull();
});

test("the accessible name takes the catalogue's full label", () => {
  expect(modelGlyphName("codex", "gpt-6-astra")).toBe("GPT-6-Astra");
  expect(modelGlyphName("claude", "opus")).toBe("Opus 5.5");
  expect(modelGlyphName("claude", "fable-5-1")).toBe("Fable 5.1");
});

test("every stage state has exactly one glyph reading", () => {
  expect(GLYPH_STATE).toEqual({
    pending: "waiting", skipped: "waiting", running: "running", committing: "running", reviewing: "running",
    passed: "passed", failed: "failed", needs_decision: "needs",
  });
});
