import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { defaultPipelinePorts } from "@/lib/pipelines/engine";
import { classifyStructuredHostStartupError } from "@/lib/viewerInstrumentation";
import * as cuts from "./interruptionObligations";
import { adoptStructuredHostsAtStartup } from "./startup";
import { addStructuredRestartConversation } from "./startupRecipient.fixture";
import { startupRowRetries } from "./startupRowRetries";
import { journalClaims, journalTickets, startJournalPeer, until } from "./startup.interruptionAdmission.fixture";

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "startup-journal-"));
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = cuts.interruptionObligationDirectory(registry.filename);
  const seed = path.join(directory, "seed");
  const record = (n: number) => cuts.interruptionObligationStore(seed).record({
    conversationId: `conversation_fixture-${n}` as cuts.InterruptionObligation["conversationId"],
    engine: "codex", hostKey: `codex:fixture-${n}`, path: `/transcripts/fixture-${n}.jsonl`,
    owner: null, claimEpoch: 1, turnRef: "fixture-turn", boundary: "fixture-release", reason: "viewer-release",
    checkpoint: { lastEventKind: null, lastEventAt: null }, seat: null, recordedAt: "2026-11-28T03:40:00.000Z",
  }).obligation;
  const clean = () => {
    registry.close();
    fs.rmSync(directory, { recursive: true, force: true });
  };
  return { directory, registry, journal, record, clean };
}
const jsonl = (...records: cuts.InterruptionObligation[]) => records.map(record => JSON.stringify(record) + "\n").join("");

function tracked<T>(operation: () => T | Promise<T>) {
  let settled = false;
  const result = Promise.resolve().then(operation).finally(() => { settled = true; });
  void result.catch(() => {});
  return { result, settled: () => settled };
}

function probe() {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ready") });
  return { async request() { expect(await (await fetch(server.url)).text()).toBe("ready"); }, stop() { server.stop(true); } };
}

async function readJournal(journal: string, options: { deadline?: number; signal?: AbortSignal; afterPendingRead?: () => void } = {}) {
  if (cuts.readInterruptionObligations) return cuts.readInterruptionObligations(journal, options);
  // Exercise the reviewed implementation on the same corpus when replaying RED.
  return cuts.interruptionObligationStore(journal, { ...options, tryAdmission: true }).list();
}

test("startup serves requests during the first journal fence and keeps its queue place across writers", async () => {
  const f = fixture();
  const record = f.record(1);
  const server = probe();
  const owner = startJournalPeer(f.journal, path.join(f.directory, "owner"), {
    append: jsonl(record), triggered: true, maxHoldMs: 1_800,
  });
  const next = startJournalPeer(f.journal, path.join(f.directory, "next"), { triggered: true });
  const abort = new AbortController();
  const snapshot = f.registry.prepareReadOnlySnapshot.bind(f.registry);
  const reached = Promise.withResolvers<number>();
  let armed = true;
  f.registry.prepareReadOnlySnapshot = async signal => {
    const view = await snapshot(signal);
    if (armed) {
      armed = false;
      owner.trigger();
      await owner.ready();
      reached.resolve(performance.now());
    }
    return view;
  };
  const startup = tracked(() => adoptStructuredHostsAtStartup({
    registry: f.registry, client: null, orchestratorSeats: () => [], signal: abort.signal,
  }));
  try {
    const start = await Promise.race([reached.promise, startup.result.then(() => { throw new Error("startup skipped the census"); })]);
    // Let startup reach its journal acquisition before we send the request.
    await Bun.sleep(30);
    await server.request();
    expect(performance.now() - start).toBeLessThan(1_000);
    expect(owner.held()).toBe(true);
    await until(() => journalTickets(f.journal) === 2 || startup.settled());
    expect(journalTickets(f.journal)).toBe(2);
    next.trigger();
    await until(() => journalTickets(f.journal) === 3);
    owner.release();
    await next.ready();
    // An already queued peer can cross between claim and publication.
    expect(next.held()).toBe(true);
    await server.request();
    next.release();
    await startup.result;
    expect(cuts.recipientInterruptionEvidence(f.journal, [record.conversationId]).records)
      .toMatchObject([{ id: record.id, state: "discharged", resolution: "the conversation no longer exists" }]);
    expect(journalClaims(f.journal)).toEqual([]);
    expect(journalTickets(f.journal)).toBe(0);
  } finally {
    abort.abort();
    await Promise.allSettled([owner.stop(), next.stop(), startup.result]);
    server.stop();
    f.clean();
  }
}, 20_000);

for (const withdraw of [false, true]) test(`publication waits for a peer on the second fence (withdraw=${withdraw})`, async () => {
  const f = fixture();
  const kept = f.record(1);
  const removed = f.record(2);
  await cuts.initializeRecipientInterruptionIndex(f.journal);
  fs.appendFileSync(`${f.journal}.pending.jsonl`, jsonl(kept, ...(withdraw ? [removed] : [])));
  const marker = path.join(f.directory, "publication");
  const owner = startJournalPeer(f.journal, marker, { triggered: true, withdraw: withdraw ? removed.id : undefined });
  const server = probe();
  const admission = tracked(() => readJournal(f.journal, { afterPendingRead() {
    expect(journalClaims(f.journal)).toHaveLength(1);
    owner.trigger();
    // Establish the second fence in the peer before returning from the import hook.
    const end = performance.now() + 1_000;
    while (!fs.existsSync(marker + ".held") && performance.now() < end) Bun.sleepSync(5);
    expect(owner.held()).toBe(true);
  } }));
  try {
    await owner.ready();
    await until(() => journalTickets(f.journal) === 2 || admission.settled());
    await server.request();
    owner.release();
    expect(await admission.result).toEqual([kept]);
    expect(cuts.recipientInterruptionEvidence(f.journal, [kept.conversationId, removed.conversationId]).records).toEqual([kept]);
    expect(journalClaims(f.journal)).toEqual([]);
    expect(journalTickets(f.journal)).toBe(0);
  } finally {
    await Promise.allSettled([owner.stop(), admission.result]);
    server.stop();
    f.clean();
  }
}, 20_000);

test("second-fence timeout preserves the claim and the next reader publishes it", async () => {
  const f = fixture();
  const record = f.record(1);
  await cuts.initializeRecipientInterruptionIndex(f.journal);
  fs.appendFileSync(`${f.journal}.pending.jsonl`, jsonl(record));
  const marker = path.join(f.directory, "timeout");
  const owner = startJournalPeer(f.journal, marker, { triggered: true });
  const started = performance.now();
  const read = tracked(() => readJournal(f.journal, { deadline: started + 1_500, afterPendingRead() {
    owner.trigger();
    const end = performance.now() + 1_000;
    while (!fs.existsSync(marker + ".held") && performance.now() < end) Bun.sleepSync(5);
    expect(owner.held()).toBe(true);
  } }));
  try {
    const refused = await read.result.catch(error => error);
    expect(classifyStructuredHostStartupError(refused).category).toBe("registry-contention");
    expect(journalClaims(f.journal)).toHaveLength(1);
    expect(journalTickets(f.journal)).toBe(1);
    expect(await owner.stop()).toBe(0);
    expect(() => cuts.recipientInterruptionEvidence(f.journal, [record.conversationId])).toThrow("pending journal changed");
    expect(await readJournal(f.journal)).toEqual([record]);
    expect(cuts.recipientInterruptionEvidence(f.journal, [record.conversationId]).records).toEqual([record]);
    expect(journalClaims(f.journal)).toEqual([]);
    expect(journalTickets(f.journal)).toBe(0);
    expect(performance.now() - started).toBeGreaterThanOrEqual(1_400);
  } finally {
    await Promise.allSettled([owner.stop(), read.result]);
    f.clean();
  }
});

test("an aborted reader releases its queue ticket without claiming the journal", async () => {
  const f = fixture();
  const record = f.record(1);
  await cuts.initializeRecipientInterruptionIndex(f.journal);
  const owner = startJournalPeer(f.journal, path.join(f.directory, "abort"), { append: jsonl(record) });
  const abort = new AbortController();
  const reason = new Error("fixture cancelled");
  try {
    await owner.ready();
    const read = tracked(() => readJournal(f.journal, { signal: abort.signal }));
    await until(() => journalTickets(f.journal) === 2 || read.settled());
    abort.abort(reason);
    await expect(read.result).rejects.toBe(reason);
    expect(journalTickets(f.journal)).toBe(1);
    expect(journalClaims(f.journal)).toEqual([]);
    expect(await owner.stop()).toBe(0);
    expect(await readJournal(f.journal)).toEqual([record]);
  } finally {
    abort.abort();
    await owner.stop();
    f.clean();
  }
});

test("pipeline recovery reads its cut asynchronously while the Viewer serves", async () => {
  const f = fixture();
  const record = f.record(1);
  const server = probe();
  await cuts.initializeRecipientInterruptionIndex(f.journal);
  setAgentRegistryForTests(f.registry);
  const owner = startJournalPeer(f.journal, path.join(f.directory, "pipeline"), { append: jsonl(record), maxHoldMs: 1_800 });
  let cut: ReturnType<typeof tracked<{ recordedAt: string } | null>> | undefined;
  try {
    await owner.ready();
    const start = performance.now();
    cut = tracked(() => defaultPipelinePorts().conversationRestartCut!(record.conversationId));
    await Bun.sleep(30);
    await server.request();
    expect(performance.now() - start).toBeLessThan(1_000);
    expect(owner.held()).toBe(true);
    expect(cut.settled()).toBe(false);
    owner.release();
    expect(await cut.result).toEqual({ recordedAt: record.recordedAt });
    expect(cuts.recipientInterruptionEvidence(f.journal, [record.conversationId]).records).toEqual([record]);
    expect(journalClaims(f.journal)).toEqual([]);
  } finally {
    await Promise.allSettled([owner.stop(), cut?.result]);
    setAgentRegistryForTests(null);
    server.stop();
    f.clean();
  }
}, 15_000);


test("a scheduled row retry preserves its two adoption failures when the journal times out", async () => {
  const f = fixture();
  const sessionId = ["00000000", "0000", "4000", "8000", "000000000042"].join("-");
  const key = `codex:${sessionId}`;
  addStructuredRestartConversation(f.registry, f.directory, { sessionId, status: "idle", turn: "idle" });
  const retries = startupRowRetries(f.registry);
  const now = Date.now();
  await retries.failed(key, "adoption-failed", now);
  const original = await retries.failed(key, "adoption-failed", now);
  const callbacks: Array<() => void> = [];
  const abort = new AbortController();
  const log = spyOn(console, "error");
  const record = f.record(1);
  let owner: ReturnType<typeof startJournalPeer> | undefined;
  try {
    await adoptStructuredHostsAtStartup({
      registry: f.registry, client: null, orchestratorSeats: () => [], signal: abort.signal,
      adopt: async () => [], adoptClaude: async () => [],
      schedule: callback => { callbacks.push(callback); return {}; },
    });
    expect(callbacks).toHaveLength(1);
    owner = startJournalPeer(f.journal, path.join(f.directory, "row"), { append: jsonl(record) });
    await owner.ready();
    callbacks.shift()!();
    await until(() => callbacks.length > 0, 8_000);
    expect(retries.get(key)).toEqual(original);
    expect(log.mock.calls).toContainEqual([
      "[structured hosts] row retry deferred",
      expect.objectContaining({ category: "registry-contention" }),
    ]);
    const dir = `${f.registry.filename}.startup-retries`;
    expect(JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]!), "utf8"))).toEqual(original);
    expect(journalTickets(f.journal)).toBe(1);
    expect(await owner.stop()).toBe(0);
    expect(await readJournal(f.journal)).toEqual([record]);
  } finally {
    abort.abort();
    log.mockRestore();
    await owner?.stop();
    f.clean();
  }
}, 20_000);

for (const startupFirst of [false, true]) test(`a torn sealed journal preserves repair bytes and recovers its complete cut (startup first=${startupFirst})`, async () => {
  const f = fixture();
  const record = f.record(1);
  const raw = jsonl(record) + '{"version":1,"incomplete":';
  const errors = spyOn(console, "error");
  try {
    await cuts.initializeRecipientInterruptionIndex(f.journal);
    fs.appendFileSync(`${f.journal}.pending.jsonl`, raw);
    if (startupFirst) {
      const sessionId = ["00000000", "0000", "4000", "8000", "000000000043"].join("-");
      addStructuredRestartConversation(f.registry, f.directory, { sessionId, status: "idle", turn: "idle" });
      let refreshed = 0;
      await adoptStructuredHostsAtStartup({
        registry: f.registry, client: null, orchestratorSeats: () => [],
        refreshTranscriptState: async () => { refreshed++; }, adopt: async () => [], adoptClaude: async () => [],
      });
      expect(refreshed).toBe(1);
    }
    const expected = startupFirst
      ? { id: record.id, state: "discharged", resolution: "the conversation no longer exists" }
      : record;
    expect(await readJournal(f.journal)).toMatchObject([expected]);
    expect(await readJournal(f.journal)).toMatchObject([expected]);
    expect(cuts.recipientInterruptionEvidence(f.journal, [record.conversationId]).records).toMatchObject([expected]);
    expect(journalClaims(f.journal)).toEqual([]);
    expect(journalTickets(f.journal)).toBe(0);
    const artifact = fs.readdirSync(f.directory).filter(name => name.startsWith(path.basename(f.journal) + ".pending.jsonl.damaged-"));
    expect(artifact).toHaveLength(1);
    expect(fs.readFileSync(path.join(f.directory, artifact[0]!), "utf8")).toBe(raw);
    expect(errors.mock.calls).toContainEqual(["[interruption recovery] retained damaged journal for repair", { artifact: artifact[0] }]);
  } finally {
    errors.mockRestore();
    f.clean();
  }
}, 15_000);
