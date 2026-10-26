import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";

import { clampEffortToScale } from "@/lib/agent/efforts";
import { translate } from "@/lib/i18n/core";
import type { FileEntry } from "@/lib/types";

import {
  adoptRuntimeProfile,
  defaults,
  effectiveProfile,
  launchedModelId,
  listedModelId,
  modelHoldMessage,
  observedModelId,
  readProfile,
  readResumeDraft,
  runningModelId,
  savedResumeProfile,
  sendRuntimeFrom,
  writeProfile,
  writeResumeProfile,
} from "./runtimeProfile";

const dom = new Window();
Object.assign(globalThis, { localStorage: dom.localStorage });

const file: FileEntry = {
  path: "/codex.jsonl", root: "codex-sessions", name: "codex.jsonl", project: "viewer", title: "codex",
  engine: "codex", kind: "session", fmt: "codex", parent: null, mtime: 1, size: 1, activity: "idle",
  proc: "running", pid: 10, conversationId: "conversation_runtime", model: "gpt-5.6-sol", effort: "high", fast: false,
  pendingQuestion: null, waitingInput: null,
};
const claudeFile: FileEntry = {
  ...file,
  path: "/claude.jsonl", root: "claude-projects", name: "claude.jsonl", fmt: "claude",
  engine: "claude", conversationId: "conversation_claude", model: "sonnet",
};
const key = "llvAgentRuntime:conversation_runtime";

afterEach(() => {
  localStorage.clear();
});

test("savedResumeProfile is null without saved state, so resume sends zero overrides (finding 4)", () => {
  // No saved profile — display defaults must NOT leak into the send as overrides.
  expect(savedResumeProfile(file)).toBeNull();
  // …but the picker still needs a concrete draft to display.
  expect(readResumeDraft(file).model).toBe("gpt-5.6-sol");
});

test("savedResumeProfile returns the applied profile once one is explicitly saved (finding 4)", () => {
  localStorage.setItem(key + ":resume", JSON.stringify({ model: "gpt-5.6-sol", effort: "medium", fast: false }));
  const saved = savedResumeProfile(file);
  expect(saved?.model).toBe("gpt-5.6-sol");
  expect(saved?.effort).toBe("medium");
});

test("readResumeDraft clamps an out-of-range persisted effort back to the file default", () => {
  localStorage.setItem(key + ":resume", JSON.stringify({ model: "gpt-5.6-sol", effort: "not-a-real-effort", fast: false }));
  const draft = readResumeDraft(file);
  expect(draft.model).toBe("gpt-5.6-sol");
  expect(draft.effort).toBe("high"); // the file's own effort, since the stored one is invalid
});

test("writeResumeProfile materializes a concrete draft on the :resume key (auto-apply IS the save)", () => {
  const written = writeResumeProfile(file, { effort: "medium" });
  expect(written).toEqual({ model: "gpt-5.6-sol", effort: "medium", fast: false });
  expect(savedResumeProfile(file)?.effort).toBe("medium");
  // Never touches the live-runtime key.
  expect(localStorage.getItem(key)).toBeNull();
});

test("writeProfile persists only explicitly selected fields (issue #241 finding 4)", () => {
  writeProfile(file, { effort: "ultra" });
  expect(readProfile(file)).toEqual({ effort: "ultra" });
  // The send override mirrors the sparse profile — no synthesized model rides.
  expect(sendRuntimeFrom(file)).toEqual({ effort: "ultra" });
  // Nothing selected ⇒ nothing rides the send at all.
  localStorage.clear();
  expect(sendRuntimeFrom(file)).toBeUndefined();
});

test("a model switch keeps an effort the new scale supports and clamps one it doesn't (§4.3)", () => {
  writeProfile(file, { effort: "ultra" });        // sol supports ultra
  writeProfile(file, { model: "gpt-5.6-terra" }); // terra shares the six-tier scale
  expect(readProfile(file)).toEqual({ model: "gpt-5.6-terra", effort: "ultra" });
  // The clamp itself: a plain codex model tops out at xhigh, so ultra drops to
  // the nearest end of the target scale (and an in-scale tier is untouched).
  expect(clampEffortToScale("codex", "gpt-5.5", "ultra")).toBe("xhigh");
  expect(clampEffortToScale("codex", "gpt-5.5", "medium")).toBe("medium");
  expect(clampEffortToScale("codex", "gpt-5.5", "unknown-tier")).toBe("low");
  expect(clampEffortToScale("shell", null, "high")).toBeNull();
});

test("effectiveProfile resolves persisted selection over the observed runtime", () => {
  expect(effectiveProfile(file)).toEqual({ model: "gpt-5.6-sol", effort: "high", fast: false });
  writeProfile(file, { effort: "ultra", fast: true });
  expect(effectiveProfile(file)).toEqual({ model: "gpt-5.6-sol", effort: "ultra", fast: true });
});

test("fast never persists for a non-codex engine", () => {
  writeProfile(claudeFile, { effort: "max", fast: true });
  expect(readProfile(claudeFile)).toEqual({ effort: "max" });
  expect(writeResumeProfile(claudeFile, { effort: "max" }).fast).toBe(false);
});

test("adoptRuntimeProfile moves profile/resume/draft records across an identity rotation, existing records winning", () => {
  localStorage.setItem("llvAgentRuntime:prov-1:profile", JSON.stringify({ effort: "ultra" }));
  localStorage.setItem("llvAgentRuntime:prov-1:resume", JSON.stringify({ model: "gpt-5.6-sol", effort: "low", fast: false }));
  localStorage.setItem("llvAgentRuntime:canon-1:resume", JSON.stringify({ model: "gpt-5.6-sol", effort: "medium", fast: false }));
  adoptRuntimeProfile("prov-1", "canon-1");
  expect(localStorage.getItem("llvAgentRuntime:canon-1:profile")).toContain("ultra");
  // A record already filed under the new identity always wins.
  expect(localStorage.getItem("llvAgentRuntime:canon-1:resume")).toContain("medium");
  expect(localStorage.getItem("llvAgentRuntime:prov-1:profile")).toBeNull();
  expect(localStorage.getItem("llvAgentRuntime:prov-1:resume")).toBeNull();
});

test("adoptRuntimeProfile carries the live reconfigure :phase so pending/confirming convergence survives id rotation (#405)", () => {
  localStorage.setItem("llvAgentRuntime:prov-2", JSON.stringify({ model: "gpt-5.6-sol", effort: "medium", fast: false }));
  localStorage.setItem("llvAgentRuntime:prov-2:phase", "confirming");
  localStorage.setItem("llvAgentRuntime:prov-2:phase:operation", "reconfigure-prov-2");
  localStorage.setItem("llvAgentRuntime:prov-2:phase:rollback", JSON.stringify({
    operationId: "reconfigure-prov-2",
    draft: { model: "gpt-5.6-sol", effort: "medium", fast: false },
    profile: null,
  }));
  adoptRuntimeProfile("prov-2", "canon-2");
  expect(localStorage.getItem("llvAgentRuntime:canon-2:phase")).toBe("confirming");
  expect(localStorage.getItem("llvAgentRuntime:canon-2:phase:operation")).toBe("reconfigure-prov-2");
  expect(localStorage.getItem("llvAgentRuntime:canon-2:phase:rollback")).toContain("reconfigure-prov-2");
  expect(localStorage.getItem("llvAgentRuntime:canon-2")).toContain("medium");
  expect(localStorage.getItem("llvAgentRuntime:prov-2:phase")).toBeNull();
  expect(localStorage.getItem("llvAgentRuntime:prov-2:phase:operation")).toBeNull();
  expect(localStorage.getItem("llvAgentRuntime:prov-2:phase:rollback")).toBeNull();
  // A phase already filed under the canonical id wins — a stale provisional
  // marker never regresses an adopted conversation's convergence state.
  localStorage.setItem("llvAgentRuntime:prov-3:phase", "pending");
  localStorage.setItem("llvAgentRuntime:canon-3:phase", "confirming");
  adoptRuntimeProfile("prov-3", "canon-3");
  expect(localStorage.getItem("llvAgentRuntime:canon-3:phase")).toBe("confirming");
  expect(localStorage.getItem("llvAgentRuntime:prov-3:phase")).toBeNull();
});

test("an observed model the catalogue does not list is no catalogue model, and the engine default never stands in", () => {
  const unknown: FileEntry = { ...file, model: "gpt-9-experimental", effort: "warp" };
  expect(defaults(unknown)).toEqual({ model: "", effort: "low", fast: false });
  expect(runningModelId(unknown)).toBe("gpt-9-experimental");
  /* What the transcript reports wins over what the launch asked for. */
  expect(defaults({ ...file, model: "gpt-5.5", launchModel: "gpt-6-luna" }).model).toBe("");
});

test("a Codex stage the transcript has not named yet shows the model its launch asked for", () => {
  const opening: FileEntry = { ...file, model: null, launchModel: "gpt-6-luna", effort: "high" };
  expect(defaults(opening)).toEqual({ model: "gpt-6-luna", effort: "high", fast: false });
  expect(effectiveProfile(opening).model).toBe("gpt-6-luna");
  expect(readResumeDraft(opening).model).toBe("gpt-6-luna");
  expect(runningModelId(opening)).toBe("gpt-6-luna");
  expect(listedModelId({ ...opening, model: "gpt-6.1-sol" })).toBe("gpt-6.1-sol");
});

test("with no observed and no requested model the draft names none, for every engine", () => {
  expect(defaults({ ...file, model: null, launchModel: null }).model).toBe("");
  expect(defaults({ ...file, model: null, launchModel: undefined }).model).toBe("");
  expect(defaults({ ...claudeFile, model: null, launchModel: null }).model).toBe("");
  expect(defaults({ ...claudeFile, model: "  ", launchModel: "" }).model).toBe("");
  expect(defaults({ ...file, engine: "copilot", model: null }).model).toBe("");
  expect(effectiveProfile({ ...file, model: null, launchModel: null }).model).toBe("");
  expect(readResumeDraft({ ...file, model: null, launchModel: null }).model).toBe("");
  expect(sendRuntimeFrom({ ...file, model: null, launchModel: null })).toBeUndefined();
});

test("a Claude conversation names its observed release, not the family alias a different version would read as", () => {
  expect(defaults({ ...claudeFile, model: "opus-4-1", launchModel: "opus" }).model).toBe("");
  expect(runningModelId({ ...claudeFile, model: "opus-4-1", launchModel: "opus" })).toBe("opus-4-1");
  expect(defaults({ ...claudeFile, model: "qwen3.8-max", launchModel: null }).model).toBe("");
  /* The observed model wins over the launch alias. */
  expect(defaults({ ...claudeFile, model: "claude-sonnet-5-5", launchModel: "opus" }).model).toBe("claude-sonnet-5-5");
  /* Before the transcript names one, the launch alias stands. */
  expect(defaults({ ...claudeFile, model: null, launchModel: "opus" }).model).toBe("opus");
});

test("a Fable conversation reads as the fable row whether the launch asked for the alias or recorded nothing", () => {
  for (const launchModel of ["fable", null, undefined] as const) {
    const fable: FileEntry = { ...claudeFile, model: "fable-5-1", launchModel };
    expect(defaults(fable).model).toBe("fable");
    expect(runningModelId(fable)).toBe("fable");
    expect(listedModelId(fable)).toBe("fable");
  }
  expect(defaults({ ...claudeFile, model: "claude-fable-5-1", launchModel: "fable" }).model).toBe("fable");
  expect(defaults({ ...claudeFile, model: "fable-5-1[1m]", launchModel: null }).model).toBe("fable");
  /* A family the catalogue lists a pinned release of keeps another version off its alias row. */
  expect(defaults({ ...claudeFile, model: "sonnet-4-5", launchModel: "sonnet" }).model).toBe("");
  expect(defaults({ ...claudeFile, model: "opus-4-1", launchModel: null }).model).toBe("");
});

test("a held change says why in words that name the change: no model, or one the pickers cannot send", () => {
  for (const locale of ["en", "uk"] as const) {
    const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) => translate(locale, key, params);
    const unknown: FileEntry = { ...claudeFile, model: null, launchModel: null };
    const unlisted: FileEntry = { ...claudeFile, model: "opus-4-1", launchModel: "opus" };
    expect(modelHoldMessage(t, unknown)).toBe(t("runtimeConfig.modelUnknown"));
    expect(modelHoldMessage(t, unlisted)).toBe(t("runtimeConfig.modelUnlisted", { model: "Opus 4.1" }));
    expect(modelHoldMessage(t, unknown, "move")).toBe(t("runtimeConfig.moveModelUnknown"));
    expect(modelHoldMessage(t, unlisted, "move")).toBe(t("runtimeConfig.moveModelUnlisted", { model: "Opus 4.1" }));
    expect(new Set([
      modelHoldMessage(t, unknown), modelHoldMessage(t, unlisted), modelHoldMessage(t, unknown, "move"), modelHoldMessage(t, unlisted, "move"),
    ]).size).toBe(4);
    /* A listed model holds nothing, Fable's transcript release included. */
    expect(modelHoldMessage(t, { ...claudeFile, model: "fable-5-1", launchModel: null }, "move")).toBeNull();
    expect(modelHoldMessage(t, { ...claudeFile, model: null, launchModel: "gpt-6-luna", engine: "codex" })).toBeNull();
  }
});

test("an explicit resume selection with no model sends no model", () => {
  const unknown: FileEntry = { ...file, model: null, launchModel: null };
  writeResumeProfile(unknown, { effort: "high" });
  expect(savedResumeProfile(unknown)).toEqual({ model: "", effort: "high", fast: false });
});

test("a conversation launched on the pinned Sonnet 5.5 id observes that id, so its runtime pill confirms", () => {
  const pinned: FileEntry = { ...claudeFile, model: "claude-sonnet-5-5", launchModel: "claude-sonnet-5-5" };
  expect(observedModelId(pinned)).toBe("claude-sonnet-5-5");
  expect(defaults(pinned).model).toBe("claude-sonnet-5-5");
  /* The alias launch and a dated transcript id still read as the family alias. */
  expect(observedModelId({ ...claudeFile, model: "claude-sonnet-5-5-20260928", launchModel: "sonnet" })).toBe("claude-sonnet-5-5");
  expect(launchedModelId({ ...claudeFile, model: "claude-sonnet-5-5-20260928", launchModel: "sonnet" })).toBe("sonnet");
  expect(observedModelId({ ...claudeFile, model: "claude-opus-5-5", launchModel: undefined })).toBe("opus");
});
