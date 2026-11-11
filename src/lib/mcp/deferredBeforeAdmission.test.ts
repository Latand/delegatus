/**
 * A state-lock deferral raised before any store admitted a writer never
 * consumes the clientRequestId (docs/design/viewer-stalls-root-cause.md,
 * section 4.3). The real tool service and the real receipt store, in an
 * isolated state directory; the bindings write the store the seat-tick tool
 * writes, and the contention is the real one: another connection holds the
 * state database's write lock.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";

const previousStateDir = process.env.LLV_STATE_DIR;
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-deferred-before-admission-"));
process.env.LLV_STATE_DIR = path.join(sandbox, "state");

const { AgentRegistry } = await import("@/lib/agent/registry");
const { readSeatTickSettings, writeSeatTickSettings } = await import("@/lib/monitor/seatTickSettings");
const { witnessAdmissions, noteWriterAdmitted } = await import("@/lib/state/admissionWitness");
const { StateLockDeferredError } = await import("@/lib/state/lockWait");
const { deferredBeforeAnyWriter, witnessStoreWriters } = await import("./admittedWriters");
const { MCP_TOOL_NAMES, SqliteMcpReceiptStore, createMcpToolService } = await import("./server");
type McpToolBindings = import("./server").McpToolBindings;

const receipts = new SqliteMcpReceiptStore(path.join(sandbox, "mcp-receipts.sqlite"));
afterAll(() => {
  receipts.close();
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

/* The store the seat-tick tool writes, initialised once so the lock below is the only thing in a write's way. */
const settled = readSeatTickSettings("fixture-project");
writeSeatTickSettings("fixture-project", settled);
const stateDatabase = fs.readdirSync(process.env.LLV_STATE_DIR!).filter(name => name.endsWith(".sqlite"))
  .map(name => path.join(process.env.LLV_STATE_DIR!, name))
  .find(filename => {
    const db = new Database(filename, { readonly: true });
    try { return Boolean(db.query("SELECT 1 FROM sqlite_master WHERE name = 'state_leases'").get()); }
    finally { db.close(); }
  });
if (!stateDatabase) throw new Error("the settings write must have created the state database");

function writeNote(project: string, note: string): void {
  writeSeatTickSettings(project, { ...readSeatTickSettings(project), monitorPrompt: note });
}

function service(bindings: Partial<Record<string, (args: Record<string, unknown>) => Promise<Record<string, unknown>>>>) {
  const all = Object.fromEntries(MCP_TOOL_NAMES.map(name => [name, async () => ({})]));
  return createMcpToolService({ ...all, ...bindings } as unknown as McpToolBindings, receipts);
}

async function whileStateWriterHeld<T>(work: () => Promise<T>): Promise<T> {
  const peer = new Database(stateDatabase!);
  peer.exec("BEGIN IMMEDIATE");
  try { return await work(); }
  finally { peer.exec("ROLLBACK"); peer.close(); }
}

test("a deferral before any writer gives the key back, and the same key then executes", async () => {
  let calls = 0;
  const tools = service({ seat_tick_settings: async (args) => {
    calls += 1;
    writeNote(String(args.project), "written on the retry");
    return { changed: true };
  } });
  const request = { clientRequestId: "deferred-before-writer", project: "project-released" };

  const refused = await whileStateWriterHeld(() => tools.callTool("seat_tick_settings", request));
  expect(refused).toMatchObject({ ok: false, code: "store_busy", retryable: true, replayed: false });
  expect(String(refused.error)).toContain("state admission is busy");
  expect(readSeatTickSettings("project-released").monitorPrompt ?? null).toBeNull();

  const retried = await tools.callTool("seat_tick_settings", request);
  expect(retried).toMatchObject({ ok: true, replayed: false, changed: true });
  expect(calls).toBe(2);
  expect(readSeatTickSettings("project-released").monitorPrompt).toBe("written on the retry");
  /* Settled now: a third call under the key replays the answer and runs nothing. */
  expect(await tools.callTool("seat_tick_settings", request)).toMatchObject({ ok: true, replayed: true });
  expect(calls).toBe(2);
});

test("a deferral after a writer entered stays the key's answer", async () => {
  let calls = 0;
  const tools = service({ seat_tick_settings: async (args) => {
    calls += 1;
    writeNote(String(args.project), `first write of call ${calls}`);
    return whileStateWriterHeld(async () => {
      writeNote(String(args.project), "second write");
      return { changed: true };
    });
  } });
  const request = { clientRequestId: "deferred-after-writer", project: "project-recorded" };

  const refused = await tools.callTool("seat_tick_settings", request);
  expect(refused).toMatchObject({ ok: false, code: "tool_failed", replayed: false });
  expect(String(refused.error)).toContain("state admission is busy");

  const replayed = await tools.callTool("seat_tick_settings", request);
  expect(replayed).toMatchObject({ ok: false, code: "tool_failed", replayed: true });
  expect(calls).toBe(1);
  expect(readSeatTickSettings("project-recorded").monitorPrompt).toBe("first write of call 1");
});

test("a registry mutation before the deferral counts as a writer", async () => {
  const registry = new AgentRegistry(path.join(sandbox, "registry.json"), undefined, undefined, { sqliteMode: "sqlite" });
  let calls = 0;
  try {
    const tools = service({ seat_tick_settings: async (args) => {
      calls += 1;
      registry.ensureConversation("codex", `/sessions/registry-writer-${calls}.jsonl`, null);
      return whileStateWriterHeld(async () => { writeNote(String(args.project), "never written"); return {}; });
    } });
    const request = { clientRequestId: "registry-writer-first", project: "project-registry" };
    expect(await tools.callTool("seat_tick_settings", request)).toMatchObject({ ok: false, code: "tool_failed", replayed: false });
    expect(await tools.callTool("seat_tick_settings", request)).toMatchObject({ ok: false, replayed: true });
    expect(calls).toBe(1);
  } finally { registry.close(); }
});

test("a tool whose effects may leave this process keeps the refusal under its key", async () => {
  let calls = 0;
  const tools = service({ update_task: async () => {
    calls += 1;
    writeNote("project-other-tool", "never written");
    return {};
  } });
  const request = { clientRequestId: "other-tool-deferred", taskId: "task_fixture", text: "Edited task" };
  const refused = await whileStateWriterHeld(() => tools.callTool("update_task", request));
  expect(refused).toMatchObject({ ok: false, code: "tool_failed", replayed: false });
  expect(await tools.callTool("update_task", request)).toMatchObject({ ok: false, replayed: true });
  expect(calls).toBe(1);
});

test("another failure before any writer is still recorded", async () => {
  let calls = 0;
  const tools = service({ seat_tick_settings: async () => { calls += 1; throw new Error("the settings could not be read"); } });
  const request = { clientRequestId: "plain-failure", project: "project-plain" };
  expect(await tools.callTool("seat_tick_settings", request)).toMatchObject({ ok: false, code: "tool_failed", replayed: false });
  expect(await tools.callTool("seat_tick_settings", request)).toMatchObject({ ok: false, replayed: true });
  expect(calls).toBe(1);
});

test("each witnessed call counts its own writers, across awaits and beside other calls", async () => {
  const gate = Promise.withResolvers<void>();
  const quiet = { entered: 0 };
  const busy = { entered: 0 };
  const first = witnessAdmissions(quiet, async () => { await gate.promise; });
  const second = witnessAdmissions(busy, async () => {
    noteWriterAdmitted();
    await Promise.resolve();
    noteWriterAdmitted();
    gate.resolve();
  });
  await Promise.all([first, second]);
  expect(quiet.entered).toBe(0);
  expect(busy.entered).toBe(2);
  /* Outside a witness a store's note goes nowhere. */
  noteWriterAdmitted();
  expect(quiet.entered + busy.entered).toBe(2);
});

test("only the typed pre-admission deferral of a witnessed binding is read as unadmitted", async () => {
  const bindings = witnessStoreWriters({
    deferred: async () => { throw new StateLockDeferredError("fixture.lease"); },
    wrapped: async () => { throw new Error("store wrapper", { cause: new StateLockDeferredError("fixture.lease") }); },
    afterWriter: async () => { noteWriterAdmitted(); throw new StateLockDeferredError("fixture.lease"); },
    plain: async () => { throw new Error("database is locked"); },
    synchronous: () => { throw new StateLockDeferredError("fixture.sync"); },
  });
  const raised = async (run: () => unknown) => { try { await run(); } catch (error) { return error; } throw new Error("the binding must fail"); };
  expect(deferredBeforeAnyWriter(await raised(bindings.deferred))?.callSite).toBe("fixture.lease");
  expect(deferredBeforeAnyWriter(await raised(bindings.wrapped))?.callSite).toBe("fixture.lease");
  expect(deferredBeforeAnyWriter(await raised(bindings.synchronous))?.callSite).toBe("fixture.sync");
  expect(deferredBeforeAnyWriter(await raised(bindings.afterWriter))).toBeNull();
  expect(deferredBeforeAnyWriter(await raised(bindings.plain))).toBeNull();
  /* An error no witnessed binding raised proves nothing. */
  expect(deferredBeforeAnyWriter(new StateLockDeferredError("fixture.unwitnessed"))).toBeNull();
});

test("a witnessed binding keeps the properties it carries beside its call", () => {
  const prepareAdmission = async () => {};
  const binding = Object.assign(async () => ({}), { prepareAdmission });
  const bindings = witnessStoreWriters({ tool: binding });
  expect(bindings.tool.prepareAdmission).toBe(prepareAdmission);
  expect(bindings.tool).toBe(bindings.tool);
});
