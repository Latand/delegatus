import { expect, test } from "bun:test";

import { isLightRuntime, isOpusClass, launchSizingRefusal, LIGHT_DENIED_ROLE_MESSAGE, mappingRowRefusal, spawnSizingRefusal, type Briefer } from "./sizing";

const OPERATOR: Briefer = { kind: "operator" };
const OPUS_AGENT: Briefer = { kind: "agent", runtime: { engine: "claude", model: "opus" } };
const ASTRA_AGENT: Briefer = { kind: "agent", runtime: { engine: "codex", model: "gpt-6-astra" } };
const SONNET_AGENT: Briefer = { kind: "agent", runtime: { engine: "claude", model: "claude-sonnet-5" } };
const UNREADABLE_AGENT: Briefer = { kind: "agent", runtime: null };

const SONNET = { engine: "claude", model: "sonnet" };
const OPUS = { engine: "claude", model: "opus" };
const LUNA = { engine: "codex", model: "gpt-6-luna" };

test("a dated Sonnet id is light and not Opus class, and a null Claude model is Opus", () => {
  for (const model of ["sonnet", "claude-sonnet-5", "haiku", "claude-haiku-4-5"]) {
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

test("R1: orchestrator, architect, reviewer and verifier never run Sonnet or Haiku for an agent", () => {
  for (const roleId of ["orchestrator", "architect", "reviewer", "verifier"]) {
    for (const explicitRuntime of [true, false]) {
      for (const config of [SONNET, { engine: "claude", model: "haiku" }, { engine: "claude", model: "claude-sonnet-5" }]) {
        expect(launchSizingRefusal({ roleId, params: {}, config, explicitRuntime, briefer: OPUS_AGENT })).toBe(LIGHT_DENIED_ROLE_MESSAGE);
      }
    }
    expect(launchSizingRefusal({ roleId, params: {}, config: OPUS, explicitRuntime: true, briefer: SONNET_AGENT })).toBeNull();
  }
  /* The trivial reviewer runs Luna, which is not on the deny list. */
  expect(launchSizingRefusal({ roleId: "reviewer", params: { size: "trivial" }, config: LUNA, explicitRuntime: false, briefer: OPUS_AGENT })).toBeNull();
});

test("R2: size=trivial needs an Opus-class briefer; an unreadable agent is not one", () => {
  const trivial = { roleId: "builder", params: { size: "trivial" }, config: SONNET, explicitRuntime: false };
  expect(launchSizingRefusal({ ...trivial, briefer: OPUS_AGENT })).toBeNull();
  expect(launchSizingRefusal({ ...trivial, briefer: ASTRA_AGENT })).toBeNull();
  expect(launchSizingRefusal({ ...trivial, briefer: SONNET_AGENT })).toBe("size=trivial runs a light model and needs a brief written by an Opus-class agent; this brief comes from claude/claude-sonnet-5.");
  expect(launchSizingRefusal({ ...trivial, briefer: UNREADABLE_AGENT })).toContain("an agent whose runtime cannot be read");
  expect(launchSizingRefusal({ ...trivial, roleId: "reviewer", config: LUNA, briefer: SONNET_AGENT })).toContain("size=trivial");
});

test("R3: a builder reaches a light model by hand only through size=trivial; the mapping's own light row passes", () => {
  const builder = { roleId: "builder", params: {}, briefer: OPUS_AGENT };
  expect(launchSizingRefusal({ ...builder, config: SONNET, explicitRuntime: true })).toContain("only as size=trivial");
  expect(launchSizingRefusal({ ...builder, config: { engine: "codex", model: "gpt-5.6-terra" }, explicitRuntime: true })).toContain("only as size=trivial");
  expect(launchSizingRefusal({ ...builder, config: { engine: "codex", model: "gpt-5.6-terra" }, explicitRuntime: false })).toBeNull();
  expect(launchSizingRefusal({ ...builder, config: SONNET, explicitRuntime: false })).toBeNull();
  expect(launchSizingRefusal({ ...builder, params: { size: "trivial" }, config: SONNET, explicitRuntime: true })).toBeNull();
  /* A role-less stage is judged as a builder. */
  expect(launchSizingRefusal({ ...builder, roleId: null, config: SONNET, explicitRuntime: true })).toContain("only as size=trivial");
  /* Other roles are not builders; the cleaner may run light by hand. */
  expect(launchSizingRefusal({ ...builder, roleId: "cleaner", config: SONNET, explicitRuntime: true })).toBeNull();
});

test("the operator passes every rule", () => {
  for (const roleId of ["orchestrator", "architect", "reviewer", "verifier", "builder", null]) {
    for (const params of [{}, { size: "trivial" }] as Record<string, string>[]) {
      expect(launchSizingRefusal({ roleId, params, config: SONNET, explicitRuntime: true, briefer: OPERATOR })).toBeNull();
    }
  }
});

test("a mapping row is refused for the four denied roles on Sonnet or Haiku, from any writer", () => {
  expect(mappingRowRefusal("reviewer", { engine: "claude", model: "sonnet" })).toContain("reviewer:");
  expect(mappingRowRefusal("architect", { engine: "claude", model: "haiku" })).toContain("Sonnet and Haiku");
  expect(mappingRowRefusal("builder", { engine: "claude", model: "sonnet" })).toBeNull();
  expect(mappingRowRefusal("reviewer", { engine: "codex", model: "gpt-6-luna" })).toBeNull();
});

test("a role-less spawn that names its own light model is judged as a hand-set builder", () => {
  expect(spawnSizingRefusal({ role: null, engine: "claude", model: "sonnet", briefer: OPUS_AGENT })).toContain("only as size=trivial");
  expect(spawnSizingRefusal({ role: null, engine: "claude", briefer: OPUS_AGENT })).toBeNull();
  expect(spawnSizingRefusal({
    role: { role: "builder", params: { size: "trivial" }, config: SONNET, explicitRuntime: false },
    briefer: SONNET_AGENT,
  })).toContain("size=trivial");
});
