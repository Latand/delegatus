import { expect, test } from "bun:test";

import { ENGINE_MODELS } from "@/lib/agent/models";

import { GLYPH_STATE, GLYPH_TURN_MS, glyphTier, modelGlyphKind, modelGlyphName } from "./modelGlyph";

test("every catalogued Claude and Codex model has its glyph, by family", () => {
  expect(ENGINE_MODELS.claude.map((option) => modelGlyphKind("claude", option.id))).toEqual(["opus", "fable", "sonnet", "sonnet", "haiku", "haiku", "haiku"]);
  expect(ENGINE_MODELS.codex.map((option) => [option.id, modelGlyphKind("codex", option.id)])).toEqual([
    ["gpt-6-astra", "astra"],
    ["gpt-6.1-sol", "sol"],
    ["gpt-6.1-terra", "terra"],
    ["gpt-6-luna", "luna"],
    ["gpt-6-sol", "sol"],
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
  expect(modelGlyphName("claude", "haiku")).toBe("Haiku 5.5");
  expect(modelGlyphName("claude", "claude-haiku-5-5")).toBe("Haiku 5.5");
  expect(modelGlyphName("claude", "claude-haiku-4-5")).toBe("Haiku 4.5");
});

test("every stage state has exactly one glyph reading", () => {
  expect(GLYPH_STATE).toEqual({
    pending: "waiting", skipped: "waiting", running: "running", committing: "running", reviewing: "running",
    passed: "passed", failed: "failed", needs_decision: "needs",
  });
});

/* Variant B of docs/design/model-icon-motion-brief.md: 4 s, 2 s and 0.5 s a turn. */
test("a turn takes 4 s, fast twice as fast and ultrafast eight times", () => {
  expect(GLYPH_TURN_MS).toEqual({ ordinary: 4000, fast: 2000, ultra: 500 });
  expect(GLYPH_TURN_MS.ordinary / GLYPH_TURN_MS.fast).toBe(2);
  expect(GLYPH_TURN_MS.ordinary / GLYPH_TURN_MS.ultra).toBe(8);
});

test("only an applied priority or ultrafast tier speeds a Codex glyph up; anything else turns at the ordinary pace", () => {
  expect(glyphTier("codex", "priority")).toBe("fast");
  expect(glyphTier("codex", "ultrafast")).toBe("ultra");
  for (const tier of [null, undefined, "default", "standard", "flex", "turbo", ""]) expect(glyphTier("codex", tier)).toBe("ordinary");
  /* Claude has no tier: a stray value on its entry changes nothing. */
  expect(glyphTier("claude", "ultrafast")).toBe("ordinary");
  expect(glyphTier("copilot", "priority")).toBe("ordinary");
});
