import { describe, expect, test } from "bun:test";

import { structuredSpawnGap, structuredTransportAvailable, spawnTransport } from "./spawnTransport";

describe("spawnTransport", () => {
  test("is structured whether or not a runtime host is configured", () => {
    expect(spawnTransport({ LLV_RUNTIME_HOST_SOCKET: "/run/llv/runtime.sock" })).toBe("structured");
    expect(spawnTransport({})).toBe("structured");
    expect(spawnTransport({ LLV_SPAWN_TRANSPORT: "structured" })).toBe("structured");
  });

  /* A rollback switch no longer moves a spawn onto another transport: the
     spawn is refused with the gap that names the switch. */
  test.each([
    [{ NEXT_PUBLIC_RUNTIME_UI: "0" }, "NEXT_PUBLIC_RUNTIME_UI=0"],
    [{ LLV_STRUCTURED_HOSTS: "0" }, "LLV_STRUCTURED_HOSTS=0"],
    [{ LLV_RUNTIME_EVENTS: "0" }, "LLV_RUNTIME_EVENTS=0"],
  ] as const)("a rollback switch keeps the transport structured and names its gap", (rollback, gap) => {
    const env = { LLV_RUNTIME_HOST_SOCKET: "/run/llv/runtime.sock", ...rollback };
    expect(spawnTransport(env)).toBe("structured");
    expect(structuredSpawnGap({ engine: "claude", model: "fable", hasImages: false }, env)).toContain(gap);
  });

  test("rejects the retired terminal transport and unknown values", () => {
    expect(() => spawnTransport({ LLV_SPAWN_TRANSPORT: "tmux" })).toThrow();
    expect(() => spawnTransport({ LLV_SPAWN_TRANSPORT: "screen" })).toThrow();
  });
});

describe("structuredSpawnGap", () => {
  const enabled = {
    LLV_SPAWN_TRANSPORT: "structured",
    LLV_STRUCTURED_HOSTS: "1",
    LLV_RUNTIME_EVENTS: "1",
    LLV_RUNTIME_HOST_SOCKET: "/run/llv/runtime.sock",
    NEXT_PUBLIC_RUNTIME_UI: "1",
  };

  test("accepts the supported pane-less shape", () => {
    expect(structuredSpawnGap({ engine: "codex", model: "gpt-5.6-sol", hasImages: false }, enabled)).toBeNull();
  });

  test("accepts a deployment that only declares its runtime socket", () => {
    expect(
      structuredSpawnGap({ engine: "claude", model: "fable", hasImages: false }, {
        LLV_RUNTIME_HOST_SOCKET: "/run/llv/runtime.sock",
      }),
    ).toBeNull();
  });

  test.each([
    [{ ...enabled, LLV_STRUCTURED_HOSTS: "0" }, "LLV_STRUCTURED_HOSTS=0"],
    [{ ...enabled, LLV_RUNTIME_EVENTS: "0" }, "LLV_RUNTIME_EVENTS=0"],
    [{ ...enabled, LLV_RUNTIME_HOST_SOCKET: "" }, "runtime host socket"],
    [{ ...enabled, NEXT_PUBLIC_RUNTIME_UI: "0" }, "NEXT_PUBLIC_RUNTIME_UI=0"],
    [{ ...enabled, LLV_STRUCTURED_HOSTS: " 0 " }, "LLV_STRUCTURED_HOSTS=0"],
    [{ ...enabled, LLV_RUNTIME_EVENTS: "false" }, "LLV_RUNTIME_EVENTS=0"],
    [{ ...enabled, NEXT_PUBLIC_RUNTIME_UI: "'0'" }, "NEXT_PUBLIC_RUNTIME_UI=0"],
  ] as const)("names the explicit rollback that blocks the spawn", (env, gap) => {
    expect(structuredSpawnGap({ engine: "claude", model: "fable", hasImages: false }, env)).toContain(gap);
  });

  test("negotiates Claude images and Codex image-capable models", () => {
    expect(structuredSpawnGap({ engine: "claude", model: "fable", hasImages: true }, enabled)).toBeNull();
    expect(structuredSpawnGap({ engine: "codex", model: "gpt-5.6-sol", hasImages: true }, enabled)).toBeNull();
    expect(structuredSpawnGap({ engine: "codex", model: "gpt-6-astra", hasImages: true }, enabled)).toBeNull();
    expect(structuredSpawnGap({ engine: "codex", model: "gpt-5.3-codex-spark", hasImages: true }, enabled))
      .toContain("does not advertise image input");
  });

  test("admits Codex launches with service-tier support on the structured transport", () => {
    expect(structuredSpawnGap({ engine: "codex", model: "gpt-5.6-sol", hasImages: false }, enabled)).toBeNull();
  });
});

describe("structuredTransportAvailable", () => {
  const hosted = { LLV_RUNTIME_HOST_SOCKET: "/run/llv/runtime.sock" };

  test("a deployment that carries a runtime host can host a recovered conversation", () => {
    expect(structuredTransportAvailable(hosted)).toBe(structuredSpawnGap({ engine: "claude", model: "fable", hasImages: false }, hosted) === null);
    expect(structuredTransportAvailable(hosted)).toBe(true);
  });

  test.each([
    { ...hosted, LLV_STRUCTURED_HOSTS: "0" },
    { ...hosted, LLV_RUNTIME_EVENTS: "0" },
    { ...hosted, NEXT_PUBLIC_RUNTIME_UI: "0" },
  ])("a rollback switch leaves nothing to host a recovered conversation", (env) => {
    expect(structuredTransportAvailable(env)).toBe(false);
  });

  test("an explicit structured transport is taken at its word", () => {
    expect(structuredTransportAvailable({ LLV_SPAWN_TRANSPORT: "structured" })).toBe(true);
  });
});
