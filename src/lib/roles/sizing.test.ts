import { expect, test } from "bun:test";

import { isLightRuntime, isOpusClass, launchSizingRefusal, LIGHT_DENIED_ROLE_MESSAGE, mappingRowRefusal, reviewGateRefusal, spawnSizingRefusal, type Briefer } from "./sizing";

const OPERATOR: Briefer = { kind: "operator" };
const OPUS_AGENT: Briefer = { kind: "agent", runtime: { engine: "claude", model: "opus" } };
const ASTRA_AGENT: Briefer = { kind: "agent", runtime: { engine: "codex", model: "gpt-6-astra" } };
const SONNET_AGENT: Briefer = { kind: "agent", runtime: { engine: "claude", model: "claude-sonnet-5" } };
const UNREADABLE_AGENT: Briefer = { kind: "agent", runtime: null };

const SONNET = { engine: "claude", model: "sonnet" };
const OPUS = { engine: "claude", model: "opus" };
const LUNA = { engine: "codex", model: "gpt-6-luna" };

test("a dated Sonnet id is light and not Opus class, and a null Claude model is Opus", () => {
  for (const model of ["sonnet", "claude-sonnet-5", "claude-sonnet-5-5", "haiku", "claude-haiku-4-5"]) {
    expect({ model, light: isLightRuntime({ engine: "claude", model }), opus: isOpusClass({ engine: "claude", model }) }).toEqual({ model, light: true, opus: false });
  }
  expect(isOpusClass({ engine: "claude", model: null })).toBe(true);
  expect(isOpusClass({ engine: "claude", model: "fable" })).toBe(true);
  expect(isOpusClass({ engine: "claude", model: "claude-opus-5-5" })).toBe(true);
  expect(isOpusClass({ engine: "codex", model: "gpt-6-sol" })).toBe(true);
  expect(isOpusClass({ engine: "codex", model: null })).toBe(true);
  expect(isOpusClass({ engine: "codex", model: "gpt-6-luna" })).toBe(false);
  expect(isOpusClass({ engine: "copilot", model: "claude-opus-5" })).toBe(false);
  expect(isOpusClass(null)).toBe(false);
  expect(isLightRuntime({ engine: "codex", model: "gpt-5.6-terra" })).toBe(true);
  expect(isLightRuntime({ engine: "codex", model: "gpt-6-astra" })).toBe(false);
  expect(isLightRuntime({ engine: "claude", model: "opus" })).toBe(false);
});

test("R1: orchestrator, architect and a full-size reviewer never run Sonnet or Haiku for an agent; Haiku runs no verifier either", () => {
  for (const roleId of ["orchestrator", "architect", "reviewer"]) {
    for (const explicitRuntime of [true, false]) {
      for (const config of [SONNET, { engine: "claude", model: "claude-sonnet-5-5" }, { engine: "claude", model: "haiku" }, { engine: "claude", model: "claude-sonnet-5" }]) {
        expect(launchSizingRefusal({ roleId, params: {}, config, explicitRuntime, briefer: OPUS_AGENT })).toBe(LIGHT_DENIED_ROLE_MESSAGE);
      }
    }
  }
  for (const roleId of ["orchestrator", "architect", "reviewer", "verifier"]) {
    expect(launchSizingRefusal({ roleId, params: {}, config: { engine: "claude", model: "haiku" }, explicitRuntime: false, briefer: OPUS_AGENT })).toBe(LIGHT_DENIED_ROLE_MESSAGE);
    expect(launchSizingRefusal({ roleId, params: { size: "trivial" }, config: { engine: "claude", model: "haiku" }, explicitRuntime: false, briefer: OPUS_AGENT })).toBe(LIGHT_DENIED_ROLE_MESSAGE);
    expect(launchSizingRefusal({ roleId, params: {}, config: OPUS, explicitRuntime: true, briefer: SONNET_AGENT })).toBeNull();
  }
  /* Sonnet only reviews at size=trivial, and only the reviewer role gains that. */
  for (const roleId of ["orchestrator", "architect"]) {
    expect(launchSizingRefusal({ roleId, params: { size: "trivial" }, config: SONNET, explicitRuntime: false, briefer: OPUS_AGENT })).toBe(LIGHT_DENIED_ROLE_MESSAGE);
  }
  /* The trivial reviewer runs Luna, which is not on the deny list. */
  expect(launchSizingRefusal({ roleId: "reviewer", params: { size: "trivial" }, config: LUNA, explicitRuntime: false, briefer: OPUS_AGENT })).toBeNull();
});

test("R1: Sonnet runs the verifier and a size=trivial review, pinned or by alias", () => {
  for (const model of ["sonnet", "claude-sonnet-5-5"]) {
    const config = { engine: "claude", model };
    for (const explicitRuntime of [true, false]) {
      expect(launchSizingRefusal({ roleId: "verifier", params: {}, config, explicitRuntime, briefer: OPUS_AGENT })).toBeNull();
      expect(launchSizingRefusal({ roleId: "reviewer", params: { size: "trivial" }, config, explicitRuntime, briefer: OPUS_AGENT })).toBeNull();
    }
    /* size=trivial still needs a large model's brief (R2). */
    expect(launchSizingRefusal({ roleId: "reviewer", params: { size: "trivial" }, config, explicitRuntime: false, briefer: SONNET_AGENT })).toContain("size=trivial");
    expect(launchSizingRefusal({ roleId: "reviewer", params: { size: "normal" }, config, explicitRuntime: false, briefer: OPUS_AGENT })).toBe(LIGHT_DENIED_ROLE_MESSAGE);
  }
});

test("R1 on a review gate: Sonnet gates a size=trivial stage only, Haiku never", () => {
  const gate = { roleId: "builder", explicitRuntime: false, briefer: OPUS_AGENT, reviewGate: true };
  expect(launchSizingRefusal({ ...gate, params: {}, config: SONNET })).toContain("review gate");
  expect(launchSizingRefusal({ ...gate, params: { size: "trivial" }, config: SONNET })).toBeNull();
  expect(launchSizingRefusal({ ...gate, params: { size: "trivial" }, config: { engine: "claude", model: "haiku" } })).toContain("review gate");
  expect(reviewGateRefusal(SONNET)).toContain("review gate");
  expect(reviewGateRefusal(SONNET, { size: "trivial" })).toBeNull();
  expect(reviewGateRefusal(OPUS)).toBeNull();
});

test("R2: size=trivial needs an Opus-class briefer; an unreadable agent is not one", () => {
  const trivial = { roleId: "builder", params: { size: "trivial" }, config: SONNET, explicitRuntime: false };
  expect(launchSizingRefusal({ ...trivial, briefer: OPUS_AGENT })).toBeNull();
  expect(launchSizingRefusal({ ...trivial, briefer: ASTRA_AGENT })).toBeNull();
  expect(launchSizingRefusal({ ...trivial, briefer: SONNET_AGENT })).toBe("size=trivial runs a light model and needs a brief written by a large model (Claude Opus or Fable, or a large Codex model); this brief comes from claude/claude-sonnet-5.");
  expect(launchSizingRefusal({ ...trivial, briefer: UNREADABLE_AGENT })).toContain("an agent whose runtime cannot be read");
  expect(launchSizingRefusal({ ...trivial, roleId: "reviewer", config: LUNA, briefer: SONNET_AGENT })).toContain("size=trivial");
});

test("R3: a builder reaches a light Codex model or Haiku by hand only through size=trivial; the mapping's own light row passes", () => {
  const builder = { roleId: "builder", params: {}, briefer: OPUS_AGENT };
  const terra = { engine: "codex", model: "gpt-5.6-terra" };
  const haiku = { engine: "claude", model: "haiku" };
  expect(launchSizingRefusal({ ...builder, config: terra, explicitRuntime: true })).toContain("only as size=trivial");
  expect(launchSizingRefusal({ ...builder, config: haiku, explicitRuntime: true })).toContain("only as size=trivial");
  expect(launchSizingRefusal({ ...builder, config: terra, explicitRuntime: false })).toBeNull();
  expect(launchSizingRefusal({ ...builder, config: SONNET, explicitRuntime: false })).toBeNull();
  expect(launchSizingRefusal({ ...builder, params: { size: "trivial" }, config: SONNET, explicitRuntime: true })).toBeNull();
  expect(launchSizingRefusal({ ...builder, params: { size: "trivial" }, config: terra, explicitRuntime: true })).toBeNull();
  /* A role-less stage is judged as a builder. */
  expect(launchSizingRefusal({ ...builder, roleId: null, config: haiku, explicitRuntime: true })).toContain("only as size=trivial");
  /* Other roles are not builders; the cleaner may run light by hand. */
  expect(launchSizingRefusal({ ...builder, roleId: "cleaner", config: SONNET, explicitRuntime: true })).toBeNull();
});

test("R3: a builder runs Claude Sonnet at any size and any domain when an Opus-class runtime or the operator briefs it", () => {
  for (const model of ["sonnet", "claude-sonnet-5-5"]) {
    const config = { engine: "claude", model };
    for (const params of [{}, { domain: "general" }, { domain: "frontend" }, { domain: "docs" }, { mode: "apply-fixes" }, { domain: "docs", mode: "apply-fixes" }] as Record<string, string>[]) {
      const builder = { roleId: "builder", params, config, explicitRuntime: true };
      expect(launchSizingRefusal({ ...builder, briefer: OPUS_AGENT })).toBeNull();
      expect(launchSizingRefusal({ ...builder, briefer: ASTRA_AGENT })).toBeNull();
      expect(launchSizingRefusal({ ...builder, briefer: OPERATOR })).toBeNull();
      /* A light or unreadable briefer does not brief Sonnet. */
      expect(launchSizingRefusal({ ...builder, briefer: SONNET_AGENT })).toBe("a builder runs Claude Sonnet when a large model (Claude Opus or Fable, or a large Codex model) or the operator wrote its brief; this brief comes from claude/claude-sonnet-5.");
      expect(launchSizingRefusal({ ...builder, briefer: UNREADABLE_AGENT })).toContain("an agent whose runtime cannot be read");
    }
  }
  /* R1 is unchanged for what Sonnet does not run: the domain never lets it review at full size or orchestrate. */
  expect(launchSizingRefusal({ roleId: "reviewer", params: { domain: "frontend" }, config: SONNET, explicitRuntime: true, briefer: OPUS_AGENT })).toBe(LIGHT_DENIED_ROLE_MESSAGE);
  expect(launchSizingRefusal({ roleId: "builder", params: { domain: "frontend" }, config: SONNET, explicitRuntime: true, briefer: OPUS_AGENT, reviewGate: true })).toContain("review gate");
  /* A spawn of a role-less Sonnet is a builder too. */
  expect(spawnSizingRefusal({ role: null, engine: "claude", model: "claude-sonnet-5-5", briefer: OPUS_AGENT })).toBeNull();
  expect(spawnSizingRefusal({ role: null, engine: "claude", model: "claude-sonnet-5-5", briefer: SONNET_AGENT })).toContain("Claude Sonnet");
  expect(spawnSizingRefusal({ role: { role: "builder", params: { domain: "frontend" }, config: { engine: "claude", model: "claude-sonnet-5-5" }, explicitRuntime: true }, briefer: OPUS_AGENT })).toBeNull();
});

test("the operator passes every rule", () => {
  for (const roleId of ["orchestrator", "architect", "reviewer", "verifier", "builder", null]) {
    for (const params of [{}, { size: "trivial" }] as Record<string, string>[]) {
      expect(launchSizingRefusal({ roleId, params, config: SONNET, explicitRuntime: true, briefer: OPERATOR })).toBeNull();
    }
  }
});

test("a mapping row is refused for orchestrator, architect and the reviewer base row on Sonnet, and for all four on Haiku, from any writer", () => {
  expect(mappingRowRefusal("reviewer", { engine: "claude", model: "sonnet" })).toContain("reviewer:");
  expect(mappingRowRefusal("reviewer", { engine: "claude", model: "claude-sonnet-5-5" })).toContain("reviewer:");
  expect(mappingRowRefusal("architect", { engine: "claude", model: "haiku" })).toContain("Sonnet");
  expect(mappingRowRefusal("orchestrator", { engine: "claude", model: "claude-sonnet-5-5" })).toContain("orchestrator:");
  expect(mappingRowRefusal("verifier", { engine: "claude", model: "haiku" })).toContain("verifier:");
  expect(mappingRowRefusal("verifier", { engine: "claude", model: "claude-sonnet-5-5" })).toBeNull();
  expect(mappingRowRefusal("reviewer", { engine: "claude", model: "claude-sonnet-5-5" }, "trivial")).toBeNull();
  expect(mappingRowRefusal("reviewer", { engine: "claude", model: "haiku" }, "trivial")).toContain("reviewer:");
  expect(mappingRowRefusal("builder", { engine: "claude", model: "sonnet" })).toBeNull();
  expect(mappingRowRefusal("reviewer", { engine: "codex", model: "gpt-6-luna" })).toBeNull();
});

test("a role-less spawn that names its own light model is judged as a hand-set builder", () => {
  expect(spawnSizingRefusal({ role: null, engine: "claude", model: "haiku", briefer: OPUS_AGENT })).toContain("only as size=trivial");
  expect(spawnSizingRefusal({ role: null, engine: "claude", model: "sonnet", briefer: OPUS_AGENT })).toBeNull();
  expect(spawnSizingRefusal({ role: null, engine: "claude", briefer: OPUS_AGENT })).toBeNull();
  expect(spawnSizingRefusal({
    role: { role: "builder", params: { size: "trivial" }, config: SONNET, explicitRuntime: false },
    briefer: SONNET_AGENT,
  })).toContain("size=trivial");
});
