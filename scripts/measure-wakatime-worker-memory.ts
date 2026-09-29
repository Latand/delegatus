/**
 * Memory of the WakaTime sync worker, measured in a private state directory.
 *
 *   ~/.cache/llv-bun-1.4.0/bin/bun scripts/measure-wakatime-worker-memory.ts [conversations] [cycles]
 *
 * Nothing here reads the operator's state or reaches the network: the state
 * directory, config root and home are fresh temp directories, the credential is
 * absent, and the scheduler lease is a stub. What it does run for real is what
 * a worker cycle spends memory on: the persisted scan snapshot read, the
 * registry snapshot read, the per-file conversation lookup, and the turn-window
 * derivation over transcript files it writes itself.
 *
 * It prints resident memory for an empty runtime, for a real
 * `wakatimeSync.worker.ts` child with only its module graph loaded
 * (integration disabled), and then, from a fresh process that did none of the
 * seeding, RSS, heap and the peak RSS so far at the start and after cycles.
 * Children are stopped by the PID they were started with.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mode = process.argv[2] === "--seed" || process.argv[2] === "--measure" ? process.argv[2] : "main";
const arg = mode === "main" ? 2 : 3;
const conversations = Number(process.argv[arg] ?? 3000);
const cycles = Number(process.argv[arg + 1] ?? 12);
const mib = (bytes: number) => Math.round(bytes / 1_048_576);

function residentMib(pid: number): number {
  const line = fs.readFileSync(`/proc/${pid}/status`, "utf8").split("\n").find((row) => row.startsWith("VmRSS:"));
  return Math.round(Number(line?.match(/\d+/)?.[0] ?? 0) / 1024);
}

async function childResidentMib(entry: string[], env: NodeJS.ProcessEnv): Promise<number> {
  // The open stdin pipe is the worker's lifetime lease, exactly as the Viewer holds it.
  const child = spawn(process.execPath, entry, { env, stdio: ["pipe", "ignore", "ignore"] });
  child.stdin?.on("error", () => {});
  const pid = child.pid!;
  try {
    await Bun.sleep(4_000);
    return residentMib(pid);
  } finally {
    process.kill(pid, "SIGTERM");
  }
}

async function runChild(flag: string, env: NodeJS.ProcessEnv): Promise<void> {
  const child = spawn(process.execPath, [process.argv[1]!, flag, String(conversations), String(cycles)], { env, stdio: "inherit" });
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  if (code !== 0) throw new Error(`${flag} exited with ${code}`);
}

if (mode === "main") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-wakatime-rss-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LLV_STATE_DIR: path.join(root, "state"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    HOME: path.join(root, "home"),
    LLV_MEASURE_ROOT: root,
  };
  delete env.LLV_STRUCTURED_HOST;
  delete env.LLV_WAKATIME_ENABLED;
  for (const directory of [env.LLV_STATE_DIR!, env.XDG_CONFIG_HOME!, env.HOME!]) fs.mkdirSync(directory, { recursive: true });
  console.log(`bun ${Bun.version}, ${conversations} conversations, ${cycles} cycles, state ${env.LLV_STATE_DIR}`);
  console.log(`${"empty runtime (child)".padEnd(34)} rss ${String(await childResidentMib(["-e", "setInterval(() => {}, 1000)"], env)).padStart(5)} MiB`);
  console.log(`${"worker module graph (child)".padEnd(34)} rss ${String(await childResidentMib([path.resolve("src/lib/wakatimeSync.worker.ts")], env)).padStart(5)} MiB`);
  await runChild("--seed", env);
  for (const variant of (process.env.LLV_MEASURE_VARIANTS ?? "snapshot-clone,snapshot-readonly,keyed").split(",")) {
    await runChild("--measure", { ...env, LLV_MEASURE_VARIANT: variant });
  }
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(0);
}

const root = process.env.LLV_MEASURE_ROOT;
if (!root || !process.env.LLV_STATE_DIR?.startsWith(root)) throw new Error("run through the main mode: the state directory must be private");

if (mode === "--seed") {
  // The corpus: one transcript per conversation, a catalogue entry per transcript.
  const transcripts = path.join(root, "transcripts");
  fs.mkdirSync(transcripts, { recursive: true });
  const base = Date.now() - 3_600_000;
  const files: unknown[] = [];
  const observations: unknown[] = [];
  for (let index = 0; index < conversations; index += 1) {
    const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    const pathname = path.join(transcripts, `${id}.jsonl`);
    const at = (offset: number) => new Date(base + index * 1000 + offset).toISOString();
    fs.writeFileSync(pathname, [
      { type: "user", timestamp: at(0), message: { role: "user", content: "start the task" } },
      { type: "assistant", timestamp: at(5_000), message: { role: "assistant", content: [{ type: "text", text: "done" }], stop_reason: "end_turn" } },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");
    const stat = fs.statSync(pathname);
    files.push({
      path: pathname, root: "claude-projects", name: `${id}.jsonl`, project: "measured-project", title: `Conversation ${index}`,
      engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: stat.mtimeMs / 1000, size: stat.size,
      activity: "idle", proc: null, pid: null, model: null, pendingQuestion: null, waitingInput: null, derivationComplete: true,
    });
    observations.push({
      engine: "claude", path: pathname, accountId: null,
      launchProfile: { cwd: "/measured/project", model: "opus", title: `Conversation ${index}`, role: "builder" },
      turn: { state: "idle", source: "assistant", terminalAt: null }, observedAt: new Date(base).toISOString(),
    });
  }
  fs.writeFileSync(path.join(process.env.LLV_STATE_DIR!, "files-scan-snapshot.json"), JSON.stringify({
    version: 1, schemaVersion: 12, epoch: "measure", generation: 1,
    snapshot: { files, projectCatalog: [], complete: true },
  }) + "\n");
  const { AgentRegistry } = await import("../src/lib/agent/registry");
  const { statePath } = await import("../src/lib/configDir");
  const seeded = new AgentRegistry(statePath("registry.json"), undefined, undefined, { sqliteMode: "sqlite" });
  seeded.reconcileConversations(observations as never, { snapshot: false });
  seeded.close();
  process.exit(0);
}

function report(label: string): void {
  Bun.gc(true);
  const memory = process.memoryUsage();
  const peak = Math.round(process.resourceUsage().maxRSS / 1024);
  const status = fs.readFileSync("/proc/self/status", "utf8");
  const kib = (field: string) => Math.round(Number(status.match(new RegExp(`${field}:\\s+(\\d+)`))?.[1] ?? 0) / 1024);
  console.log(`${label.padEnd(34)} rss ${String(mib(memory.rss)).padStart(5)} MiB (anon ${String(kib("RssAnon")).padStart(4)}, file ${String(kib("RssFile")).padStart(4)})  heap ${String(mib(memory.heapUsed)).padStart(4)} MiB  peak rss ${String(peak).padStart(5)} MiB`);
}

report("fresh process");
const { AgentRegistry } = await import("../src/lib/agent/registry");
const { statePath } = await import("../src/lib/configDir");
const { conversationLookupFromSnapshot, readOnlyConversationLookupFromSnapshot } = await import("../src/lib/agent/registry");
const { recentTurnWindowsFor } = await import("../src/lib/scanner/turnDuration");
const { createWakatimeSync, wakatimeConversation, wakatimeProductionScan } = await import("../src/lib/wakatime/sync");
const registry = new AgentRegistry(statePath("registry.json"), undefined, undefined, { sqliteMode: "sqlite" });
report("sync graph loaded");

/* The three ways the worker can ask the registry who owns its transcripts:
   the whole snapshot with a cloning lookup (what shipped), the same snapshot
   with a lookup that shares its rows, and keyed reads projected to the fields
   attribution uses. */
const variant = process.env.LLV_MEASURE_VARIANT ?? "keyed";
const asked = (paths: readonly string[]) => {
  if (variant === "keyed") return registry.projectConversationsForPaths(paths, wakatimeConversation);
  const snapshot = registry.readOnlySnapshot();
  const lookup = variant === "snapshot-clone" ? conversationLookupFromSnapshot(snapshot) : readOnlyConversationLookupFromSnapshot(snapshot);
  return new Map(paths.flatMap((pathname) => {
    const conversation = lookup.conversationForPath(pathname);
    return conversation ? [[pathname, wakatimeConversation(conversation)] as const] : [];
  }));
};
console.log(`variant ${variant}`);

/* What each stage of the first cycle adds to resident memory, before any
   collection can hide it. */
const phases = new Map<string, number>();
const seconds = new Map<string, number>();
const phased = <A extends unknown[], R>(name: string, work: (...args: A) => R) => (...args: A): R => {
  const before = process.memoryUsage().rss;
  const started = performance.now();
  const result = work(...args);
  const finish = () => {
    phases.set(name, (phases.get(name) ?? 0) + process.memoryUsage().rss - before);
    seconds.set(name, (seconds.get(name) ?? 0) + (performance.now() - started) / 1000);
  };
  if (result instanceof Promise) return result.finally(finish) as R;
  finish();
  return result;
};

let stored: unknown = null;
const sync = createWakatimeSync({
  scan: phased("scan snapshot read", () => wakatimeProductionScan({ LLV_WAKATIME_SYNC_WORKER: "1" })),
  conversationsForPaths: phased("registry lookup", asked),
  recentTurnWindows: phased("turn windows", recentTurnWindowsFor),
  readCredential: () => null,
  readState: () => stored,
  writeState: phased("state write", (state: unknown) => { stored = structuredClone(state); }),
  fetch: async () => { throw new Error("the measurement never reaches the network"); },
  now: Date.now,
  random: Math.random,
  scheduleInterval: () => ({ unref() {} }),
  scheduleTimeout: () => ({ unref() {} }),
  clearTimer: () => {},
  acquireSchedulerLease: () => ({ isHeld: () => true, release() {} }),
  logger: () => {},
});
for (let cycle = 1; cycle <= cycles; cycle += 1) {
  const before = process.memoryUsage().rss;
  phases.clear();
  seconds.clear();
  await sync.tick();
  const total = process.memoryUsage().rss - before;
  console.log(`cycle ${cycle} rss growth ${mib(total)} MiB: ${[...phases].map(([name, bytes]) => `${name} ${mib(bytes)} (${(seconds.get(name) ?? 0).toFixed(1)}s)`).join(", ")}`);
  if (cycle === 1 || cycle % 4 === 0 || cycle === cycles) report(`after cycle ${cycle}`);
}
sync.stop();
registry.close();
