import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeEach, expect, test } from "bun:test";

/* A throwaway state directory: role-presets.json and its audit log live inside
   the sandbox, never in the operator's runtime state. */
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-role-presets-"));
const originalStateDir = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
fs.mkdirSync(process.env.LLV_STATE_DIR, { recursive: true });

afterAll(() => {
  if (originalStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = originalStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const { viewerMcpBindings } = await import("./bindings");
const { McpToolRefusal } = await import("./server");
type Attribution = import("./bindings").CallerAttribution;
type Refusal = import("./server").McpToolRefusal;

const SEAT: Attribution = { kind: "manager", conversationId: "seat-1", role: "orchestrator" };
const GATEWAY: Attribution = { kind: "gateway", conversationId: "root-1", role: null };
const WORKER: Attribution = { kind: "agent", conversationId: "worker-1", role: "builder" };
const UNKNOWN: Attribution = { kind: "unidentified", conversationId: null, role: null };

function tools(attribution: Attribution) {
  return viewerMcpBindings(undefined, undefined, { callerAttribution: () => attribution } as never);
}

const stateFile = (name: string) => path.join(process.env.LLV_STATE_DIR!, name);
const auditLines = () => fs.existsSync(stateFile("role-presets-audit.jsonl"))
  ? fs.readFileSync(stateFile("role-presets-audit.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line))
  : [];

const SONNET = { engine: "claude", model: "claude-sonnet-5-5", effort: "high" };
const SOL = { engine: "codex", model: "gpt-6.1-sol", effort: "high" };

type Registry = { revision: string; health: { state: string }; roles: { id: string; config: Record<string, string>; variants?: Record<string, Record<string, string>>; shipped: { config: Record<string, string> } }[]; choices: Record<string, Record<string, string[]>> };

async function read(): Promise<Registry> {
  return await tools(WORKER).role_presets({ clientRequestId: "read", detail: true }) as unknown as Registry;
}

async function refusal(call: Promise<unknown>): Promise<Refusal> {
  try {
    await call;
  } catch (error) {
    if (error instanceof McpToolRefusal) return error;
    throw error;
  }
  throw new Error("the call was not refused");
}

beforeEach(() => {
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
  fs.mkdirSync(process.env.LLV_STATE_DIR!, { recursive: true });
});

test("the default read answers configs, variants, revision and health without the shipped detail", async () => {
  const answer = await tools(WORKER).role_presets({ clientRequestId: "plain" }) as unknown as Registry & { choices?: unknown };
  expect(answer.revision).toStartWith("roles-");
  expect(answer.health).toEqual({ state: "healthy" });
  expect(answer.roles.find((role) => role.id === "builder")!.config).toEqual(expect.objectContaining({ engine: expect.any(String) }));
  expect(Object.keys(answer.roles.find((role) => role.id === "builder")!.variants!)).toContain("frontend");
  expect(answer.roles.some((role) => "shipped" in role)).toBe(false);
  expect(answer.choices).toBeUndefined();
});

test("a read answers every role's config and variants, the revision, the health and the valid choices", async () => {
  const registry = await read();
  expect(registry.revision).toStartWith("roles-");
  expect(registry.health).toEqual({ state: "healthy" });
  expect(registry.roles.map((role) => role.id)).toEqual(["orchestrator", "reviewer", "verifier", "builder", "architect", "cleaner", "prod-auditor", "deployer"]);
  const builder = registry.roles.find((role) => role.id === "builder")!;
  expect(builder.config).toEqual(builder.shipped.config);
  expect(Object.keys(builder.variants!)).toContain("frontend");
  expect(Object.keys(registry.roles.find((role) => role.id === "reviewer")!.variants!)).toEqual(["trivial"]);
  expect(registry.choices.claude!["claude-sonnet-5-5"]).toContain("high");
  expect(Object.keys(registry.choices.codex!)).toContain("gpt-6.1-sol");
  expect(fs.existsSync(stateFile("role-presets.json"))).toBe(false);
});

test("the seat writes a full config, and the row, the revision and an independent read agree", async () => {
  const before = await read();
  const answer = await tools(SEAT).role_presets({
    clientRequestId: "write-1",
    overrides: { builder: { config: SONNET }, reviewer: { config: SOL } },
    expectedRevision: before.revision,
  }) as { changed: boolean; revision: string; previousRevision: string; rows: { row: string; before: unknown; after: unknown }[]};
  expect(answer).toMatchObject({ changed: true, previousRevision: before.revision });
  expect(answer.revision).not.toBe(before.revision);
  expect(answer.rows.map((row) => row.row)).toEqual(expect.arrayContaining(["builder", "reviewer"]));
  expect(JSON.parse(fs.readFileSync(stateFile("role-presets.json"), "utf8")).overrides).toMatchObject({ reviewer: { config: SOL } });
  const after = await read();
  expect(after.revision).toBe(answer.revision);
  expect(after.roles.find((role) => role.id === "reviewer")!.config).toEqual(SOL);
  expect(after.roles.find((role) => role.id === "builder")!.config).toEqual(SONNET);
});

test("the operator's own session may write a variant row", async () => {
  const answer = await tools(GATEWAY).role_presets({
    clientRequestId: "write-gateway",
    overrides: { builder: { variants: { frontend: { engine: "claude", model: "opus", effort: "high" } } } },
  }) as { changed: boolean };
  expect(answer.changed).toBe(true);
  expect((await read()).roles.find((role) => role.id === "builder")!.variants!.frontend).toEqual({ engine: "claude", model: "opus", effort: "high" });
});

test("null resets a row to the shipped default and the file drops it", async () => {
  const shipped = (await read()).roles.find((role) => role.id === "reviewer")!.shipped.config;
  await tools(SEAT).role_presets({ clientRequestId: "set", overrides: { reviewer: { config: SOL } } });
  const reset = await tools(SEAT).role_presets({ clientRequestId: "reset", overrides: { reviewer: { config: null } } }) as { changed: boolean; rows: { row: string; before: unknown; after: unknown }[] };
  expect(reset.changed).toBe(true);
  expect(reset.rows).toEqual([{ row: "reviewer", before: SOL, after: shipped }]);
  expect((await read()).roles.find((role) => role.id === "reviewer")!.config).toEqual(shipped);
  expect(JSON.parse(fs.readFileSync(stateFile("role-presets.json"), "utf8")).overrides.reviewer).toBeUndefined();
});

test("a stale revision is refused with the current registry and writes nothing", async () => {
  const before = await read();
  await tools(SEAT).role_presets({ clientRequestId: "move", overrides: { builder: { config: SONNET } } });
  const file = fs.readFileSync(stateFile("role-presets.json"), "utf8");
  const refused = await refusal(tools(SEAT).role_presets({
    clientRequestId: "stale",
    overrides: { reviewer: { config: SOL } },
    expectedRevision: before.revision,
  }));
  expect(refused.details.code).toBe("role_presets_stale_revision");
  expect((refused.details as unknown as Registry).revision).not.toBe(before.revision);
  expect((refused.details as unknown as Registry).roles.find((role) => role.id === "builder")!.config).toEqual(SONNET);
  expect(fs.readFileSync(stateFile("role-presets.json"), "utf8")).toBe(file);
  expect(auditLines()).toHaveLength(1);
});

test("an unknown model is refused with the valid choices and nothing is written, not even the valid rows", async () => {
  const refused = await refusal(tools(SEAT).role_presets({
    clientRequestId: "bad-model",
    overrides: { builder: { config: SONNET }, reviewer: { config: { engine: "codex", model: "gpt-9-imaginary", effort: "high" } } },
  }));
  expect(refused.details.code).toBe("role_presets_invalid");
  expect(refused.message).toContain("gpt-9-imaginary");
  expect(refused.message).toContain("gpt-6.1-sol");
  expect(refused.details.violations).toEqual([expect.objectContaining({ field: "overrides.reviewer.config.model", expected: expect.stringContaining("gpt-6-astra") })]);
  expect(fs.existsSync(stateFile("role-presets.json"))).toBe(false);
  expect(auditLines()).toEqual([]);
});

test("a model of the other engine, and a family the store would accept but the catalogue lacks, are refused", async () => {
  for (const config of [
    { engine: "claude", model: "gpt-6.1-sol", effort: "high" },
    { engine: "claude", model: "claude-opus-5-5", effort: "high" },
  ]) {
    const refused = await refusal(tools(SEAT).role_presets({ clientRequestId: `bad-${config.model}`, overrides: { builder: { config } } }));
    expect(refused.details.code).toBe("role_presets_invalid");
    expect(refused.message).toContain("claude-sonnet-5-5");
  }
});

test("an effort the model does not offer is refused with the valid efforts, including in a variant", async () => {
  const refused = await refusal(tools(SEAT).role_presets({
    clientRequestId: "bad-effort",
    overrides: {
      builder: { config: { engine: "claude", model: "claude-sonnet-5-5", effort: "ultra" } },
      reviewer: { variants: { trivial: { engine: "codex", model: "gpt-6.1-sol", effort: "turbo" } } },
    },
  }));
  expect(refused.details.violations).toEqual([
    expect.objectContaining({ field: "overrides.builder.config.effort", expected: "one of: low, medium, high, xhigh, max" }),
    expect.objectContaining({ field: "overrides.reviewer.variants.trivial.effort", expected: expect.stringContaining("ultra") }),
  ]);
  expect(fs.existsSync(stateFile("role-presets.json"))).toBe(false);
});

test("a malformed patch is refused with the store's own words and the choices", async () => {
  const refused = await refusal(tools(SEAT).role_presets({ clientRequestId: "bad-role", overrides: { janitor: { config: SONNET } } }));
  expect(refused.details.code).toBe("role_presets_invalid");
  expect(refused.message).toContain("unknown role: janitor");
  expect(fs.existsSync(stateFile("role-presets.json"))).toBe(false);
});

test("a spawned worker and an unidentified caller read but their writes are refused with a clear code", async () => {
  for (const caller of [WORKER, UNKNOWN]) {
    const refused = await refusal(tools(caller).role_presets({ clientRequestId: `worker-${caller.kind}`, overrides: { builder: { config: SONNET } } }));
    expect(refused.details.code).toBe("role_presets_write_refused");
    expect(fs.existsSync(stateFile("role-presets.json"))).toBe(false);
    expect(auditLines()).toEqual([]);
    expect(await tools(caller).role_presets({ clientRequestId: `read-${caller.kind}` })).toHaveProperty("roles");
  }
});

test("every write appends who wrote it and each row's before and after", async () => {
  const before = await read();
  const first = await tools(SEAT).role_presets({ clientRequestId: "audit-1", overrides: { builder: { config: SONNET } } }) as { revision: string };
  const second = await tools({ ...SEAT, via: { deputy: "ghost-1" } }).role_presets({ clientRequestId: "audit-2", overrides: { builder: { config: null } } }) as { revision: string };
  const third = await tools(GATEWAY).role_presets({ clientRequestId: "audit-3", overrides: { reviewer: { config: SOL } } }) as { revision: string };
  const shipped = before.roles.find((role) => role.id === "builder")!.shipped.config;
  expect(auditLines()).toEqual([
    {
      at: expect.any(String),
      actor: { kind: "manager", conversationId: "seat-1", role: "orchestrator" },
      clientRequestId: "audit-1",
      revisionBefore: before.revision,
      revisionAfter: first.revision,
      rows: [{ row: "builder", before: shipped, after: SONNET }],
    },
    {
      at: expect.any(String),
      actor: { kind: "manager", conversationId: "seat-1", role: "orchestrator", via: { deputy: "ghost-1" } },
      clientRequestId: "audit-2",
      revisionBefore: first.revision,
      revisionAfter: second.revision,
      rows: [{ row: "builder", before: SONNET, after: shipped }],
    },
    {
      at: expect.any(String),
      actor: { kind: "gateway", conversationId: "root-1", role: null },
      clientRequestId: "audit-3",
      revisionBefore: second.revision,
      revisionAfter: third.revision,
      rows: [{ row: "reviewer", before: before.roles.find((role) => role.id === "reviewer")!.shipped.config, after: SOL }],
    },
  ]);
});

test("restoring a shipped prompt is recorded without the prompt text", async () => {
  fs.writeFileSync(stateFile("role-presets.json"), JSON.stringify({ schemaVersion: 1, overrides: { builder: { promptScaffold: "Hand-edited scaffold" } } }));
  const answer = await tools(SEAT).role_presets({ clientRequestId: "prompt", overrides: { builder: { promptScaffold: null } } }) as { rows: unknown[] };
  expect(answer.rows).toEqual([{ row: "builder:promptScaffold", before: "override", after: "shipped" }]);
  expect(JSON.stringify(auditLines())).not.toContain("Hand-edited");
});

test("expectedRevision without overrides is refused as a misuse, not silently read", async () => {
  await expect(tools(SEAT).role_presets({ clientRequestId: "misuse", expectedRevision: "roles-1-x" })).rejects.toThrow("expectedRevision applies to a write");
});

test("a write whose audit record cannot be stored is refused and leaves the registry as it was", async () => {
  const before = await read();
  fs.mkdirSync(stateFile("role-presets-audit.jsonl"));
  const refused = await refusal(tools(SEAT).role_presets({ clientRequestId: "no-audit", overrides: { reviewer: { config: SOL } } }));
  expect(refused.details.code).toBe("role_presets_audit_unavailable");
  expect(fs.existsSync(stateFile("role-presets.json"))).toBe(false);
  expect((await read()).revision).toBe(before.revision);

  fs.rmSync(stateFile("role-presets-audit.jsonl"), { recursive: true });
  await tools(SEAT).role_presets({ clientRequestId: "ok", overrides: { builder: { config: SONNET } } });
  const file = fs.readFileSync(stateFile("role-presets.json"), "utf8");
  fs.rmSync(stateFile("role-presets-audit.jsonl"));
  fs.mkdirSync(stateFile("role-presets-audit.jsonl"));
  await refusal(tools(SEAT).role_presets({ clientRequestId: "no-audit-2", overrides: { reviewer: { config: SOL } } }));
  expect(fs.readFileSync(stateFile("role-presets.json"), "utf8")).toBe(file);
});

test("a second process that writes between the read and the write makes the stale write refuse and leaves its row and no audit entry", async () => {
  const before = await read();
  const child = Bun.spawn(["bun", path.join(import.meta.dir, "../roles/registryLock.fixture.ts")], { stdout: "pipe", stderr: "inherit", env: { ...process.env } });
  const reader = child.stdout.getReader();
  const chunk = await reader.read();
  expect(new TextDecoder().decode(chunk.value)).toContain("locked");
  /* This call waits on the registry lock the child holds, then reads the
     registry the child wrote. */
  const refused = await refusal(tools(SEAT).role_presets({
    clientRequestId: "interleaved",
    overrides: { builder: { config: SONNET } },
    expectedRevision: before.revision,
  }));
  await child.exited;
  expect(refused.details.code).toBe("role_presets_stale_revision");
  expect((await read()).roles.find((role) => role.id === "builder")!.config).toEqual({ engine: "claude", model: "opus", effort: "high" });
  expect(auditLines()).toEqual([]);
});
