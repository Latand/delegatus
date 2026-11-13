/** Run in scratch exports with the tasks transaction logger's threshold and
 * rounding disabled in both versions. See docs/design/task-writes.md. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { admissionSnapshot } from "../src/lib/tasks/groupHide";
import type { BoardTask } from "../src/lib/tasks/types";

const at = "2026-11-01T00:00:00.000Z";
async function* lines(stream: ReadableStream<Uint8Array>) {
  let pending = "";
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      pending += decoder.decode(chunk.value, { stream: true });
      for (;;) {
        const newline = pending.indexOf("\n");
        if (newline < 0) break;
        yield pending.slice(0, newline); pending = pending.slice(newline + 1);
      }
    }
  } finally { reader.releaseLock(); }
  if (pending) yield pending;
}

if (process.argv[2] === "--worker") {
  console.info = (...args: unknown[]) => console.error(...args);
  const source = process.argv[3]!;
  const state = process.env.LLV_STATE_DIR!;
  if (!state.startsWith(path.resolve(process.env.TMPDIR!) + path.sep)) throw new Error("private benchmark state required");
  const store = await import(path.join(source, "src/lib/tasks/store.ts")) as typeof import("../src/lib/tasks/store");
  const commands = await import(path.join(source, "src/lib/tasks/commands.ts")) as typeof import("../src/lib/tasks/commands");
  const { SqliteStateCollection } = await import(path.join(source, "src/lib/state/sqliteStateStore.ts")) as typeof import("../src/lib/state/sqliteStateStore");
  fs.copyFileSync(process.argv[4]!, path.join(state, "tasks.json"));
  const file = path.join(state, "tasks.json");
  Date.now = () => Date.parse(at);
  store.importLegacyTasks(file);
  const cleanup = new SqliteStateCollection<BoardTask>(path.join(state, "state.sqlite"), {
    collection: "tasks", schemaVersion: 1, busyMessage: "benchmark cleanup busy",
    key: task => `t:${task.id}`, decode: value => value as BoardTask, clone: row => structuredClone(row),
  });
  const started = performance.now();
  const preparedRows = store.prepareTaskRows ? store.prepareTaskRows(file) : store.mutateTasks(tasks => ({ tasks: tasks.slice(), result: 0 }), file);
  const preparationMs = performance.now() - started;
  store.loadTasksForList(file);
  store.mutateTasks(tasks => ({ tasks, result: null }), file);
  const db = new Database(path.join(state, "state.sqlite"), { readonly: true });
  const count = db.query<{ count: number }, []>("SELECT count(*) AS count FROM state_rows WHERE collection='tasks' AND row_key GLOB 't:*'");
  let spans: number[] = [], clones = 0;
  const warn = console.warn;
  console.warn = (message: unknown, ...rest: unknown[]) => {
    if (typeof message === "string" && message.startsWith("[state transaction-hold] ")) {
      const value = JSON.parse(message.slice("[state transaction-hold] ".length));
      if (value.collection === "tasks") spans.push(value.heldMs);
    } else warn(message, ...rest);
  };
  const clone = structuredClone;
  globalThis.structuredClone = (<T>(value: T, options?: StructuredSerializeOptions): T => {
    if (value && typeof value === "object" && "status" in value && "id" in value) clones++;
    return clone(value, options);
  });
  console.log(JSON.stringify({ ready: true, preparationMs, preparedRows }));
  try {
    for await (const line of lines(Bun.stdin.stream())) {
      const { kind, iteration } = JSON.parse(line) as { kind: string; iteration: number };
      if (kind === "stop") break;
      const inputRows = count.get()!.count;
      if (inputRows !== 4599) throw new Error("benchmark row count changed");
      spans = []; clones = 0;
      const loadavg = os.loadavg();
      const started = performance.now();
      const cpu = process.cpuUsage();
      if (kind === "create") store.mutateTasksFile(state => {
        const result = commands.createTask(state.tasks, { project: "dir-fixture-1", text: `New fixture ${iteration}`, placement: "unplaced", clientRequestId: `request-${iteration}` }, state.recentCreates, { now: () => at, id: () => `new-fixture-${iteration}` });
        if (!result.ok) throw new Error(result.error);
        return { state: { tasks: result.tasks, recentCreates: result.recentCreates }, result: null };
      }, file);
      else store.mutateTasks(tasks => {
        const result = commands.patchTask(tasks, "fixture-04598", kind === "patch" ? { text: `Changed fixture ${iteration}` } : { note: `Fixture note ${iteration}` }, at);
        if (!result.ok) throw new Error(result.error);
        return { tasks: result.tasks, result: null };
      }, file);
      const used = process.cpuUsage(cpu);
      const result = { kind, iteration, inputRows, totalMs: performance.now() - started, cpuMs: (used.user + used.system) / 1000, heldMs: spans, taskClones: clones, loadavg };
      if (result.heldMs.length !== 1) throw new Error("enable all tasks transaction timing in the scratch export");
      spans = [];
      if (kind === "create") cleanup.boundedPatch(1, tx => tx.delete(`t:new-fixture-${iteration}`));
      console.log(JSON.stringify(result));
    }
  } finally { db.close(); globalThis.structuredClone = clone; console.warn = warn; }
} else {
  const sources = process.argv.slice(2);
  const sizesArgument = sources.indexOf("--sizes");
  const sizeFile = sizesArgument < 0 ? undefined : sources.splice(sizesArgument, 2)[1];
  const root = process.env.LLV_BENCH_DIR;
  if (!root || !root.startsWith(path.resolve(process.env.TMPDIR!) + path.sep)) throw new Error("LLV_BENCH_DIR must be inside private TMPDIR");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const rows: BoardTask[] = Array.from({ length: 4599 }, (_, i) => ({
    id: "fixture-" + String(i).padStart(5, "0"), project: "dir-fixture-" + i % 17,
    text: "Recorded fixture task " + i, status: i % 7 === 0 ? "inbox" : "done",
    placement: "unplaced", board: i % 7 === 0 ? "shown" : "hidden",
    assignments: Array.from({ length: i % 4 }, (_, j) => ({ path: "fixture/conversation-" + i + "-" + j + ".jsonl", panePid: null, state: "delivered", error: null, at, conversationId: "fixture-conversation-" + i + "-" + j })),
    ...(i % 7 === 0 ? {} : { doneAt: at, doneAdmissions: [] }),
    ...(i % 5 === 0 ? { findingKey: "fixture-finding-" + i, finding: { count: 1, lastSeenAt: at } } : {}),
    revision: "task-v1:00000000-0000-4000-8000-" + String(i).padStart(12, "0"),
    details: "Fixture acceptance and implementation history. ".repeat(8 + i % 23 * 7), createdAt: at, updatedAt: at,
  }));
  for (const row of rows) if (row.status === "done") row.doneAdmissions = admissionSnapshot(row.assignments);
  const target = 24 * 1024 * 1024;
  let distributionRows = 0;
  if (sizeFile) {
    const sizes = JSON.parse(fs.readFileSync(sizeFile, "utf8")) as unknown;
    if (!Array.isArray(sizes) || !sizes.length || !sizes.every(value => Number.isSafeInteger(value) && value > 0)) throw new Error("row sizes must be positive integer lengths");
    sizes.sort((a, b) => a - b);
    distributionRows = sizes.length;
    for (const row of rows) row.details = "";
    const available = target - Buffer.byteLength(JSON.stringify(rows));
    const weights = rows.map((row, i) => Math.max(1, sizes[Math.floor(i * (sizes.length - 1) / (rows.length - 1))] - Buffer.byteLength(JSON.stringify(row))));
    const sum = weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < rows.length; i++) rows[i]!.details = "x".repeat(Math.floor(available * weights[i]! / sum));
  }
  let bytes = Buffer.byteLength(JSON.stringify(rows));
  for (let i = 0; i < rows.length && bytes < target; i++) {
    const add = Math.ceil((target - bytes) / (rows.length - i));
    rows[i]!.details = (rows[i]!.details ?? "") + "x".repeat(add); bytes += add;
  }
  const data = JSON.stringify({ tasks: rows });
  const sizes = rows.map(row => Buffer.byteLength(JSON.stringify(row))).sort((a, b) => a - b);
  const fixture = path.join(root, "fixture.json");
  fs.writeFileSync(fixture, data, { mode: 0o400 });
  console.log(JSON.stringify({ fixture: { rows: rows.length, bytes: Buffer.byteLength(data), sha256: createHash("sha256").update(data).digest("hex"), synthetic: true, distributionRows, min: sizes[0], median: sizes[Math.floor(sizes.length / 2)], p95: sizes[Math.floor(sizes.length * .95)], max: sizes.at(-1) }, conditions: { bun: Bun.version, cpus: os.availableParallelism(), loadavg: os.loadavg(), repetitions: 9, linked: false, warmup: "preparation, import, list read, no-op mutation", cleanup: "one keyed deletion outside timing, identical on both versions", paired: true, activeWriters: 1 } }));
  if (sources.length !== 2) throw new Error("pass the before and after scratch export directories");
  const startWorker = (source: string, i: number) => {
    const directory = path.join(root, i === 0 ? "before" : "after");
    const temp = path.join(directory, "tmp"), state = path.join(temp, "state");
    for (const name of ["home", "config", "tmp/state"]) fs.mkdirSync(path.join(directory, name), { recursive: true, mode: 0o700 });
    const child = Bun.spawn([process.execPath, import.meta.path, "--worker", path.resolve(source), fixture], { cwd: source, stdin: "pipe", stdout: "pipe", stderr: Bun.file(path.join(directory, "stderr.log")), env: { ...process.env, HOME: path.join(directory, "home"), XDG_CONFIG_HOME: path.join(directory, "config"), TMPDIR: temp, LLV_STATE_DIR: state, LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" } });
    return { child, replies: lines(child.stdout)[Symbol.asyncIterator](), version: i === 0 ? "before" : "after" };
  };
  const workers: ReturnType<typeof startWorker>[] = [];
  try {
    for (const [i, source] of sources.entries()) {
      const worker = startWorker(source, i);
      workers.push(worker);
      const response = await worker.replies.next();
      console.log(JSON.stringify({ version: worker.version, ...JSON.parse(response.value!) }));
    }
    for (let iteration = 0; iteration < 9; iteration++) for (const kind of ["patch", "note", "create"]) {
      const order = iteration % 2 === 0 ? workers : [...workers].reverse();
      for (const worker of order) {
        worker.child.stdin.write(JSON.stringify({ kind, iteration }) + "\n"); await worker.child.stdin.flush();
        const response = await worker.replies.next();
        if (response.done) throw new Error("benchmark worker stopped before its verdict");
        console.log(JSON.stringify({ version: worker.version, ...JSON.parse(response.value) }));
      }
    }
    for (const worker of workers) {
      worker.child.stdin.write('{"kind":"stop"}\n'); await worker.child.stdin.flush(); worker.child.stdin.end();
      const code = await worker.child.exited;
      console.log(JSON.stringify({ version: worker.version, exit: code }));
      if (code !== 0) throw new Error("benchmark worker failed");
    }
  } finally {
    for (const worker of workers) if (worker.child.exitCode === null) { worker.child.kill("SIGKILL"); await worker.child.exited; }
  }
}
