import { expect, test } from "bun:test";

import {
  CODEX_ASTRA_MODEL,
  CODEX_SOL_MODEL,
  CODEX_TERRA_MODEL,
  CODEX_LUNA_MODEL,
  codexModelSupportsImages,
  defaultModelFor,
  ENGINE_MODELS,
  modelFromBody,
  normalizeClaudeLaunchModel,
  validateLaunchModel, claudeSpawnTier, claudeTierDisplayName } from "./models";

test("the model catalog exposes Opus 5 as the Claude default and GPT-6-Astra as the Codex one", () => {
  expect(ENGINE_MODELS.claude[0]).toEqual({ id: "opus", label: "Opus 5", shortLabel: "Opus 5", use: "review" });
  expect(ENGINE_MODELS.codex).toEqual([
    { id: CODEX_ASTRA_MODEL, label: "GPT-6-Astra", shortLabel: "6-Astra", use: "review" },
    { id: CODEX_SOL_MODEL, label: "GPT-5.6-Sol", shortLabel: "5.6-Sol", use: "review" },
    { id: CODEX_TERRA_MODEL, label: "GPT-5.6-Terra", shortLabel: "5.6-Terra", use: "implement" },
    { id: CODEX_LUNA_MODEL, label: "GPT-5.6-Luna", shortLabel: "5.6-Luna", use: "general" },
  ]);
  expect(defaultModelFor("codex")).toBe(CODEX_ASTRA_MODEL);
  expect(defaultModelFor("claude")).toBe("opus");
});

test("GPT-6-Astra is launchable and takes image input, and Sol keeps both", () => {
  expect(validateLaunchModel("codex", CODEX_ASTRA_MODEL)).toEqual({ model: CODEX_ASTRA_MODEL });
  expect(codexModelSupportsImages(CODEX_ASTRA_MODEL)).toBeTrue();
  // Astra is an addition: Sol stays in the catalog and keeps its modalities.
  expect(validateLaunchModel("codex", CODEX_SOL_MODEL)).toEqual({ model: CODEX_SOL_MODEL });
  expect(codexModelSupportsImages(CODEX_SOL_MODEL)).toBeTrue();
});

test("spawn model validation accepts CLI ids and rejects control characters", () => {
  expect(modelFromBody({ model: " gpt-5.6-terra " })).toEqual({ model: CODEX_TERRA_MODEL });
  expect(modelFromBody({})).toEqual({ model: null });
  expect(modelFromBody({ model: "terra\n--help" }).error).toBeDefined();
});

test("explicit launch models are admitted only from the selected engine catalog", () => {
  expect(validateLaunchModel("codex", CODEX_TERRA_MODEL)).toEqual({ model: CODEX_TERRA_MODEL });
  expect(validateLaunchModel("codex", "gpt-5.6-codex")).toEqual({
    error: `invalid codex model id "gpt-5.6-codex"; valid codex model ids: ${ENGINE_MODELS.codex.map((option) => option.id).join(", ")}`,
  });
  expect(validateLaunchModel("claude", "claude-fable-5")).toEqual({
    error: `invalid claude model id "claude-fable-5"; valid claude model ids: ${ENGINE_MODELS.claude.map((option) => option.id).join(", ")}`,
  });
});

test("Claude transcript model families normalize to stable launch aliases", () => {
  expect(normalizeClaudeLaunchModel("fable")).toBe("fable");
  expect(normalizeClaudeLaunchModel("claude-fable")).toBe("fable");
  expect(normalizeClaudeLaunchModel("fable-20260701")).toBe("fable");
  expect(normalizeClaudeLaunchModel("claude-opus-4-8-20260630")).toBe("opus");
  expect(normalizeClaudeLaunchModel("claude-sonnet-5-20260701")).toBe("sonnet");
  expect(normalizeClaudeLaunchModel("claude-3-5-haiku-20241022")).toBe("haiku");
});

test("unknown or unsafe Claude transcript model ids omit the launch override", () => {
  expect(normalizeClaudeLaunchModel("mythos-1")).toBeNull();
  expect(normalizeClaudeLaunchModel("claude-opus\n--dangerously-skip-permissions")).toBeNull();
  expect(normalizeClaudeLaunchModel(" ")).toBeNull();
  expect(normalizeClaudeLaunchModel(null)).toBeNull();
});

test("a Claude spawn names the provider tier it draws on, and an unstated model the launch default (#1796)", () => {
  expect(claudeSpawnTier("unknown-model")).toBeNull();
  expect(claudeSpawnTier(null)).toBe("opus");
  expect(claudeSpawnTier(undefined)).toBe("opus");
  expect(claudeSpawnTier("fable")).toBe("fable");
  expect(claudeSpawnTier("claude-fable-5-1")).toBe("fable");
  expect(claudeSpawnTier("opus")).toBe("opus");
  expect(claudeSpawnTier("claude-opus-5")).toBe("opus");
  expect(claudeSpawnTier("sonnet")).toBe("sonnet");
  expect(claudeSpawnTier("claude-haiku-4-5-20251001")).toBe("haiku");
});

test("a provider tier bucket names its row by the tier, capitalised when unknown", () => {
  expect(claudeTierDisplayName("opus")).toBe("Opus");
  expect(claudeTierDisplayName("fable")).toBe("Fable");
  expect(claudeTierDisplayName("mythos")).toBe("Mythos");
  expect(claudeTierDisplayName("sonnet")).toBe("Sonnet");
  expect(claudeTierDisplayName("nova")).toBe("Nova");
});

test("the provider's own label names the row, and a codenamed bucket is never shown raw (#1839)", () => {
  // Several metered buckets arrive under codenames. The label the provider
  // sends is what the operator reads; without one the codename is spelled out
  // as words rather than handed over as a key.
  expect(claudeTierDisplayName("nimbus_quill", "Fable")).toBe("Fable");
  expect(claudeTierDisplayName("nimbus_quill")).toBe("Nimbus Quill");
  expect(claudeTierDisplayName("iguana_necktie")).toBe("Iguana Necktie");
  // An empty or blank label is no label: the tier key still names the row.
  expect(claudeTierDisplayName("opus", "   ")).toBe("Opus");
  expect(claudeTierDisplayName("opus", null)).toBe("Opus");
});
