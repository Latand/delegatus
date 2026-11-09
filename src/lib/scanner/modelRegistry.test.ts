import { describe, expect, test } from "bun:test";

import { CLAUDE_ALIAS_RELEASES } from "@/lib/agent/models";

import { MODEL_REGISTRY_VERSION, normalizeModelKey, registryWindow, resolveRegistryKey } from "./modelRegistry";

describe("normalizeModelKey", () => {
  test("normalizes exact API, Bedrock, Vertex, dated, and 1M aliases", () => {
    expect(normalizeModelKey(" claude-opus-4-8 ")).toEqual({ key: "opus-4-8", mode: "standard" });
    expect(normalizeModelKey("us.anthropic.claude-opus-4-8-v1:0")).toEqual({ key: "opus-4-8", mode: "standard" });
    expect(normalizeModelKey("claude-opus-4-8@20251101")).toEqual({ key: "opus-4-8", mode: "standard" });
    expect(normalizeModelKey("claude-sonnet-4-5-20250929[1m]")).toEqual({ key: "sonnet-4-5", mode: "1m" });
  });

  test("keeps future versions exact so they miss the registry", () => {
    expect(normalizeModelKey("claude-opus-4-9")).toEqual({ key: "opus-4-9", mode: "standard" });
    expect(registryWindow("opus-4-9", "standard")).toBeNull();
    expect(registryWindow("sonnet-4-9", "standard")).toBeNull();
  });
});

describe("registryWindow", () => {
  test("contains the frozen documented registry seed", () => {
    expect(MODEL_REGISTRY_VERSION).toBe("2026-11-09");
    expect(registryWindow("fable-5", "standard")).toBe(1_000_000);
    expect(registryWindow("opus-4-8", "standard")).toBe(1_000_000);
    expect(registryWindow("sonnet-4-5", "standard")).toBe(200_000);
    expect(registryWindow("sonnet-4-5", "1m")).toBe(1_000_000);
    expect(registryWindow("haiku-4-5", "standard")).toBe(200_000);
  });

  test("Fable 5.2 is known by its own id, and the launch alias resolves to what the installed CLI runs", () => {
    /* Claude Code 2.1.321 lists claude-fable-5-2 with a native 1M window and
       its alias table resolves `fable` to it; a session reports that exact id,
       which would read as unknown without its own entry. */
    expect(registryWindow("fable-5-2", "standard")).toBe(1_000_000);
    expect(normalizeModelKey("claude-fable-5-2")).toEqual({ key: "fable-5-2", mode: "standard" });
    expect(normalizeModelKey("us.anthropic.claude-fable-5-2")).toEqual({ key: "fable-5-2", mode: "standard" });
    expect(normalizeModelKey("anthropic.claude-fable-5-2")).toEqual({ key: "fable-5-2", mode: "standard" });
    expect(normalizeModelKey("claude-fable-5-2[1m]")).toEqual({ key: "fable-5-2", mode: "1m" });
    expect(registryWindow("fable-5-2", "1m")).toBe(1_000_000);
    expect(resolveRegistryKey("fable")).toBe("fable-5-2");
    expect(resolveRegistryKey("fable")).toBe(normalizeModelKey(CLAUDE_ALIAS_RELEASES.fable)?.key);
  });

  test("the 2.1.318 catalogue's fable alias target keeps the same window", () => {
    /* 2.1.318 resolves `fable` to claude-fable-5-1: a session on it reports that id. */
    const older = normalizeModelKey("claude-fable-5-1")!;
    expect(registryWindow(older.key, older.mode)).toBe(registryWindow(resolveRegistryKey("fable"), "standard"));
  });

  test("Fable 5.1 and Fable 5 stay registered for older transcripts", () => {
    /* Claude Code 2.1.318 and earlier still run claude-fable-5-1 for `fable`,
       and Fable 5 is still what the gateway provider resolves it to. */
    expect(registryWindow("fable-5-1", "standard")).toBe(1_000_000);
    expect(normalizeModelKey("claude-fable-5-1")).toEqual({ key: "fable-5-1", mode: "standard" });
    expect(registryWindow("fable-5", "standard")).toBe(1_000_000);
    // A later revision stays unknown until it is registered on purpose.
    expect(registryWindow("fable-5-3", "standard")).toBeNull();
  });

  test("Opus 5.5 is known, the opus alias resolves to it, and Opus 5 stays registered", () => {
    /* Claude Code 2.1.280 lists claude-opus-5-5 with a native 1M window and
       resolves `opus` to it on first-party auth; claude-opus-5 stays
       selectable as the previous Opus with the same window. */
    expect(normalizeModelKey("claude-opus-5-5")).toEqual({ key: "opus-5-5", mode: "standard" });
    expect(normalizeModelKey("claude-opus-5-5[1m]")).toEqual({ key: "opus-5-5", mode: "1m" });
    expect(normalizeModelKey("us.anthropic.claude-opus-5-5")).toEqual({ key: "opus-5-5", mode: "standard" });
    expect(registryWindow("opus-5-5", "standard")).toBe(1_000_000);
    expect(registryWindow("opus-5-5", "1m")).toBe(1_000_000);
    expect(registryWindow("opus-5", "standard")).toBe(1_000_000);
    expect(resolveRegistryKey("opus")).toBe("opus-5-5");
  });

  test("Sonnet 5.5 is known at 1M, and the sonnet alias resolves to it", () => {
    expect(normalizeModelKey("claude-sonnet-5-5")).toEqual({ key: "sonnet-5-5", mode: "standard" });
    expect(registryWindow("sonnet-5-5", "standard")).toBe(1_000_000);
    expect(resolveRegistryKey("sonnet")).toBe("sonnet-5-5");
    expect(registryWindow("sonnet-5", "standard")).toBe(1_000_000);
  });

  test("Haiku 5.5 has native 1M context, the alias follows it, and Haiku 4.5 retains 200k", () => {
    for (const model of ["claude-haiku-5-5", "us.anthropic.claude-haiku-5-5", "claude-haiku-5-5[1m]"]) {
      const normalized = normalizeModelKey(model)!;
      expect(normalized.key).toBe("haiku-5-5");
      expect(registryWindow(normalized.key, normalized.mode)).toBe(1_000_000);
    }
    expect(resolveRegistryKey("haiku")).toBe("haiku-5-5");
    expect(registryWindow("haiku-4-5", "standard")).toBe(200_000);
    expect(registryWindow("haiku-5-6", "standard")).toBeNull();
  });
});
