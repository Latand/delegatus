import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { stopFixtureIdentity, stopFixtureProcess } from "@/lib/testing/fixtureProcess";
import { captureProcessIdentity, processIdentityStatus } from "@/lib/processIdentity";
import { procBackend } from "@/lib/proc";
import { indexTranscriptSources, searchTranscripts, type TranscriptSearchOptions } from "./transcriptSearch";
import { TranscriptSearchWorker, searchTranscriptsInWorker, shutdownTranscriptSearchWorker, type TranscriptSearchWorkerRuntime } from "./transcriptSearchWorker";
import { InvalidTranscriptSearchCursorError, TranscriptSearchPageTooLargeError } from "./transcriptSearch";

let root: string;
let previous: string | undefined;
let workers: TranscriptSearchWorker[];
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-query-worker-"));
  previous = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(root, "state");
  workers = [];
});
afterEach(async () => {
  await shutdownTranscriptSearchWorker();
  await Promise.all(workers.map(worker => worker.shutdown()));
  if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
  fs.rmSync(root, { recursive: true, force: true });
});

test("a lane shared by Next bundles restores the caller's domain error identity", async () => {
  class ForeignLane extends TranscriptSearchWorker {
    name = "InvalidTranscriptSearchCursorError";
    override async search(): Promise<never> { throw Object.assign(new Error("foreign bundle"), { name: this.name }); }
  }
  const lane = new ForeignLane();
  const shared = globalThis as typeof globalThis & { __llvTranscriptSearchWorker?: { directory: string; worker: TranscriptSearchWorker } };
  shared.__llvTranscriptSearchWorker = { directory: process.env.LLV_STATE_DIR!, worker: lane };
  await expect(searchTranscriptsInWorker({ query: "cursor" })).rejects.toBeInstanceOf(InvalidTranscriptSearchCursorError);
  lane.name = "TranscriptSearchPageTooLargeError";
  await expect(searchTranscriptsInWorker({ query: "page" })).rejects.toBeInstanceOf(TranscriptSearchPageTooLargeError);
});

function worker(runtime: TranscriptSearchWorkerRuntime = {}): TranscriptSearchWorker {
  const result = new TranscriptSearchWorker({ env: { LLV_STATE_DIR: process.env.LLV_STATE_DIR },
    launch: { executable: process.execPath, workerPath: path.resolve("src/lib/transcriptSearchQuery.worker.ts") }, ...runtime });
  workers.push(result);
  return result;
}

async function seed(): Promise<void> {
  const sources = [];
  for (let i = 0; i < 4; i++) {
    const filename = path.join(root, `conversation-${i}.jsonl`);
    fs.writeFileSync(filename, ["cobalt shared", `cobalt quartz unique ${i}`, "quartz complement", "cobalt secret-value"]
      .map((content, n) => JSON.stringify({ type: n % 2 ? "assistant" : "user", timestamp: new Date((100 + i * 10 + n) * 1000).toISOString(), message: { content } })).join("\n") + "\n");
    sources.push({ path: filename, engine: "claude" as const, project: i < 2 ? "north" : "south", mtimeMs: 1000, size: fs.statSync(filename).size });
  }
  await indexTranscriptSources(sources, { complete: true });
}

test("worker preserves every page, order, scope, copies and redaction before excerpts", async () => {
  await seed();
  const lane = worker({ timeoutMs: 5000 });
  for (const order of ["newest", "relevance"] as const) {
    for (const speaker of [undefined, "user", "assistant"] as const) {
      for (const project of [undefined, "north", "unknown"]) {
        const options: TranscriptSearchOptions = { query: "cobalt quartz", order, speaker, project, limit: 1,
          fence: { timestamp: 1000, excludeTranscript: "absent" } };
        let pages = 0;
        do {
          const expected = searchTranscripts(options);
          expect(await lane.search(options)).toEqual(expected);
          options.cursor = expected.nextCursor;
          expect(++pages).toBeLessThan(20);
        } while (options.cursor);
      }
    }
    const redactText = (text: string) => text.replaceAll("secret-value", "[redacted]");
    const options = { query: "cobalt", order, redactText, fence: { timestamp: 1000, excludeTranscript: "absent" } };
    const actual = await lane.search(options);
    expect(actual).toEqual(searchTranscripts(options));
    expect(JSON.stringify(actual)).not.toContain("secret-value");
  }
  // Await IPC before matching: Bun's nested promise-matcher wait can strand
  // replies after an IO continuation (https://github.com/oven-sh/bun/issues/37189).
  const invalidCursor = await lane.search({ query: "cobalt", cursor: "invalid" }).catch((error: unknown) => error);
  expect(invalidCursor).toBeInstanceOf(InvalidTranscriptSearchCursorError);
  expect((await lane.search({ query: "cobalt" })).total).toBeGreaterThan(0);
}, 20_000);

function stub(body: string): { executable: string; workerPath: string } {
  const workerPath = path.join(root, "stub.mjs");
  fs.writeFileSync(workerPath, `import fs from "node:fs"; import { createInterface } from "node:readline"; import { spawn } from "node:child_process";
    createInterface({ input: process.stdin }).on("line", line => { const frame = JSON.parse(line); ${body} });`);
  return { executable: process.execPath, workerPath };
}

async function ready(): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(path.join(root, "ready"))) {
    if (Date.now() >= deadline) throw new Error("worker did not become ready");
    await Bun.sleep(5);
  }
}

const powershell = process.env.LLV_TEST_POWERSHELL ?? (process.platform === "win32" ? "powershell.exe" : undefined);
test.skipIf(!powershell)("Windows retirement rejects a stale descendant row after PID reuse", async () => {
  // Exercise the guardian's actual script with a retained-handle model and
  // a stale CIM row: the new process has another parent, within the same ms.
  const template = fs.readFileSync(path.resolve("bin/helper-lease.mjs"), "utf8").match(/const script = `([\s\S]*?)`;/)?.[1];
  expect(template).toBeDefined();
  const rootTime = BigInt(Date.UTC(2026, 0, 1)) * 10_000n + 116_444_736_000_000_000n;
  const script = template!.replaceAll("${group}", "10").replaceAll("${process.pid}", "99")
    .replaceAll("${windowsIdentity}", `10:${rootTime}`).replaceAll("System.Diagnostics.Process", "LeaseOwnershipProbe.Process");
  const log = path.join(root, "terminated");
  const setup = `Add-Type -TypeDefinition @'
using System;
using System.IO;
namespace LeaseOwnershipProbe {
  public class Process {
    public static string Log;
    public static Process Root = new Process(10, "owned", new DateTime(2026,1,1,0,0,0,DateTimeKind.Utc));
    public static Process Peer = new Process(42, "unrelated", Root.StartTime.AddMilliseconds(10).AddTicks(5000));
    public int Id; public string Name; public DateTime StartTime; public bool HasExited;
    public IntPtr Handle { get { return new IntPtr(Id); } }
    public Process(int id, string name, DateTime start) { Id=id; Name=name; StartTime=start; }
    public static Process GetProcessById(int id) { return id==10 ? Root : Peer; }
    public void Kill() { File.AppendAllText(Log, Name + "\\n"); HasExited=true; }
    public bool WaitForExit(int timeout) { return HasExited; }
    public void Dispose() { }
  }
}
'@
[LeaseOwnershipProbe.Process]::Log=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(log).toString("base64")}'));
function Get-CimInstance {
  param($ClassName, $Property, $Filter)
  if ($Filter) { return [pscustomobject]@{ ProcessId=42; ParentProcessId=777 } }
  @([pscustomobject]@{ ProcessId=10; ParentProcessId=99; CreationDate=[LeaseOwnershipProbe.Process]::Root.StartTime },
    [pscustomobject]@{ ProcessId=42; ParentProcessId=10; CreationDate=[LeaseOwnershipProbe.Process]::Peer.StartTime.AddTicks(-1) })
}
`;
  const probe = spawn(powershell!, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(setup + script, "utf16le").toString("base64")],
    { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let diagnostics = "";
  probe.stderr!.setEncoding("utf8").on("data", chunk => { diagnostics += chunk; });
  try {
    const code = await new Promise<number | null>((resolve, reject) => { probe.once("close", resolve); probe.once("error", reject); });
    expect({ code, diagnostics }).toEqual({ code: 0, diagnostics: "" });
    expect(fs.readFileSync(log, "utf8").trim().split(/\r?\n/)).toEqual(["owned"]);
  } finally { await stopFixtureProcess(probe); }
}, 20_000);

for (const reason of ["cancellation", "timeout", "shutdown"] as const) {
  test(`lease retirement after ${reason} reaps a busy query and descendant before replacement`, async () => {
    const launch = stub(`
      const descendant = spawn(process.execPath, ["-e", 'process.stdout.write(String(process.pid)); setInterval(() => {}, 1000);'], { stdio: ["ignore", "pipe", "inherit"] });
      descendant.stdout.once("data", () => {
        fs.writeFileSync(${JSON.stringify(path.join(root, "ready"))}, JSON.stringify([process.pid, descendant.pid]));
        while (true) {}
      });`);
    const lane = worker({ launch, timeoutMs: reason === "timeout" ? 2000 : 15_000 });
    const controller = new AbortController();
    const pending = lane.search({ query: "busy" }, controller.signal).catch(error => error);
    await ready();
    const identities = (JSON.parse(fs.readFileSync(path.join(root, "ready"), "utf8")) as number[]).map(pid => captureProcessIdentity(pid));
    const resident = (lane as unknown as { worker: { child: ChildProcess } }).worker;
    // Windows terminates the guardian without executing JS signal handlers.
    // Apply that same behaviour on Unix so this regression also runs locally.
    const kill = resident.child.kill.bind(resident.child);
    resident.child.kill = () => kill("SIGKILL");
    try {
      stub(`process.stdout.write(JSON.stringify({ id: frame.id, type: "result", result: { items: [], total: 0, nextCursor: null, stats: { conversationsIndexed: 0, messagesIndexed: 0, fieldsSearched: [], tokenizer: "fixture" } } }) + "\\n");`);
      if (reason === "cancellation") controller.abort();
      if (reason === "shutdown") await lane.shutdown();
      const error = await pending;
      expect(reason === "cancellation" ? error.name : error.message).toBe(reason === "cancellation" ? "AbortError"
        : reason === "timeout" ? "Transcript search timed out" : "Transcript search worker stopped");
      await lane.shutdown();
      for (const identity of identities) {
        expect(processIdentityStatus(identity) === "dead" || procBackend.processExited(identity.pid)).toBe(true);
      }
      expect((await lane.search({ query: "replacement" })).total).toBe(0);
      await lane.shutdown();
      const records = path.join(process.env.LLV_STATE_DIR!, "helpers");
      expect(fs.existsSync(records) ? fs.readdirSync(records).filter(file => file.endsWith(".json")) : []).toEqual([]);
    } finally {
      for (const identity of identities.reverse()) await stopFixtureIdentity(identity);
      await lane.shutdown().catch(() => {});
      workers = workers.filter(candidate => candidate !== lane);
    }
  }, 20_000);
}

test("a confirmed exit after the retirement deadline unblocks the lane", async () => {
  await seed();
  const lane = worker();
  await lane.search({ query: "cobalt" });
  const resident = (lane as unknown as { worker: { closed: Promise<void> } }).worker;
  const actualClose = resident.closed;
  let confirm!: () => void;
  const confirmation = new Promise<void>(resolve => { confirm = resolve; });
  resident.closed = actualClose.then(() => confirmation);
  try {
    await expect(lane.shutdown()).rejects.toThrow("Transcript search worker did not stop");
    confirm();
    expect((await lane.search({ query: "cobalt" })).total).toBeGreaterThan(0);
  } finally {
    confirm?.();
    await lane.shutdown().catch(() => {});
    workers = workers.filter(candidate => candidate !== lane);
  }
}, 15_000);

test("cancelled queued jobs never run; cancelling a busy query ends its worker and allows repair", async () => {
  const marker = JSON.stringify(path.join(root, "ready"));
  const log = JSON.stringify(path.join(root, "queries"));
  const launch = stub(`fs.appendFileSync(${log}, frame.options.query + "\\n"); fs.writeFileSync(${marker}, String(process.pid)); while (true) {}`);
  const lane = worker({ launch, timeoutMs: 8000 });
  const active = new AbortController();
  const queued = new AbortController();
  const first = lane.search({ query: "active" }, active.signal).catch(error => error);
  const second = lane.search({ query: "queued" }, queued.signal).catch(error => error);
  await ready();
  queued.abort();
  expect((await second).name).toBe("AbortError");
  const start = performance.now();
  await Bun.sleep(10);
  expect(performance.now() - start).toBeLessThan(200); // the stub holds its own thread
  active.abort();
  expect((await first).name).toBe("AbortError");
  await lane.shutdown();
  expect(fs.readFileSync(path.join(root, "queries"), "utf8")).toBe("active\n");
  const pid = Number(fs.readFileSync(path.join(root, "ready"), "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
  stub(`process.stdout.write(JSON.stringify({ id: frame.id, type: "result", result: { items: [], total: 0, nextCursor: null, stats: { conversationsIndexed: 0, messagesIndexed: 0, fieldsSearched: [], tokenizer: "fixture" } } }) + "\\n");`);
  expect((await lane.search({ query: "repaired" })).total).toBe(0);
});

test("queue and execution share a timeout, with a clean error and reaped worker", async () => {
  const lane = worker({ launch: stub(`fs.writeFileSync(${JSON.stringify(path.join(root, "ready"))}, String(process.pid)); while (true) {}`), timeoutMs: 1500 });
  const first = lane.search({ query: "active" }).catch(error => error);
  const second = lane.search({ query: "queued" }).catch(error => error);
  await ready();
  expect((await first).message).toBe("Transcript search timed out");
  expect((await second).message).toBe("Transcript search timed out");
  await lane.shutdown();
  const pid = Number(fs.readFileSync(path.join(root, "ready"), "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
}, 10_000);

test("a saturated queue is bounded and pre-cancelled requests never launch", async () => {
  const launch = stub(`fs.writeFileSync(${JSON.stringify(path.join(root, "ready"))}, "ready"); while (true) {}`);
  const lane = worker({ launch, timeoutMs: 8000 });
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(lane.search({ query: "pre-cancelled" }, cancelled.signal)).rejects.toHaveProperty("name", "AbortError");
  expect(fs.existsSync(path.join(root, "ready"))).toBe(false);
  const requests = Array.from({ length: 64 }, () => lane.search({ query: "queued" }).catch(error => error));
  await expect(lane.search({ query: "excess" })).rejects.toThrow("queue is full");
  await ready();
  await lane.shutdown();
  expect((await Promise.all(requests)).every(error => error.message === "Transcript search worker stopped")).toBe(true);
});

test("exit and malformed protocol fail cleanly and the next request starts a replacement", async () => {
  const launch = stub("process.exit(1);");
  const lane = worker({ launch });
  await expect(lane.search({ query: "exit" })).rejects.toThrow("worker is unavailable");
  stub('process.stdout.write("invalid protocol\\n");');
  await expect(lane.search({ query: "malformed" })).rejects.toThrow("worker is unavailable");
  stub(`process.stdout.write(JSON.stringify({ id: frame.id, type: "result", result: { items: [], total: 0, nextCursor: null, stats: { conversationsIndexed: 0, messagesIndexed: 0, fieldsSearched: [], tokenizer: "fixture" } } }) + "\\n");`);
  expect((await lane.search({ query: "repaired" })).total).toBe(0);
});

test("a throwing trusted projector closes the read snapshot and remains retryable", async () => {
  await seed();
  const lane = worker();
  await expect(lane.search({ query: "cobalt", redactText: () => { throw new Error("private projector detail"); } })).rejects.toThrow("worker is unavailable");
  expect((await lane.search({ query: "cobalt" })).total).toBeGreaterThan(0);
});

test("the real query launch ends with a hard-killed owner", async () => {
  const launch = stub(`process.stdout.write(JSON.stringify({ id: frame.id, type: "result", result: { items: [], total: 0, nextCursor: null, stats: { pid: process.pid, conversationsIndexed: 0, messagesIndexed: 0, fieldsSearched: [], tokenizer: "fixture" } } }) + "\\n");`);
  const parentPath = path.join(root, "parent.mjs");
  fs.writeFileSync(parentPath, `import { TranscriptSearchWorker } from ${JSON.stringify(path.resolve("src/lib/search/transcriptSearchWorker.ts"))};
    const lane = new TranscriptSearchWorker({ launch: ${JSON.stringify(launch)} });
    const page = await lane.search({ query: "owner" }); console.log(page.stats.pid); setInterval(() => {}, 1000);`);
  const parent = spawn(process.execPath, [parentPath], { cwd: process.cwd(), env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
  try {
    const pid = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("owner did not report query worker readiness")), 5000);
      parent.stdout!.once("data", chunk => { clearTimeout(timer); resolve(Number(String(chunk).trim())); });
      parent.once("error", error => { clearTimeout(timer); reject(error); });
    });
    expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
    parent.kill("SIGKILL");
    const deadline = Date.now() + 5000;
    while (true) {
      try { process.kill(pid, 0); }
      catch { break; }
      if (Date.now() >= deadline) throw new Error("query worker survived owner death");
      await Bun.sleep(25);
    }
  } finally { await stopFixtureProcess(parent); }
}, 12_000);
