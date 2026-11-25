import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { stateDir } from "../configDir";
import type { GuardRefusal } from "@/lib/types";

export interface GuardJournalRow {
  v: 1; id: string; at: string; layer: "hook" | "wrapper" | "error"; tool: string; command: string; cwd: string;
  targets: { given: string; resolved: string; rule: string; entry: string; kind: string }[];
  caller?: { capabilityDigest?: string; pipelineId?: string; stageId?: string; sessionId?: string; transcriptPath?: string; toolUseId?: string };
  parents: { pid: number; startTime?: string; comm: string; args: string }[];
}
interface Cursor { v: 1; identity: string; offset: number; skipping?: boolean; latest: Record<string, GuardRefusal>; notified: Record<string, string> }
const empty = (): Cursor => ({ v: 1, identity: "", offset: 0, latest: {}, notified: {} });
const cursors = new Map<string, { signature: string; cursor: Cursor }>();
function readCursor(file: string): Cursor {
  try {
    const stat = fs.statSync(file), signature = `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.size}`;
    const cached = cursors.get(file); if (cached?.signature === signature) return cached.cursor;
    if (stat.size > 16 * 1024 * 1024) return empty();
    const row = JSON.parse(fs.readFileSync(file, "utf8"));
    if (row.v === 1 && typeof row.identity === "string" && Number.isSafeInteger(row.offset) && row.offset >= 0 && (row.skipping === undefined || typeof row.skipping === "boolean")
      && row.latest && typeof row.latest === "object" && !Array.isArray(row.latest) && Object.keys(row.latest).length <= 2000
      && Object.values(row.latest).every(value => value && typeof value === "object" && ["id", "at", "tool", "entry", "kind", "command"].every(key => typeof (value as Record<string, unknown>)[key] === "string") && Number.isFinite(Date.parse((value as GuardRefusal).at)))
      && row.notified && typeof row.notified === "object" && !Array.isArray(row.notified) && Object.keys(row.notified).length <= 2000 && Object.values(row.notified).every(value => typeof value === "string" && Number.isFinite(Date.parse(value)))) {
      if (cursors.size >= 8) cursors.delete(cursors.keys().next().value!);
      cursors.set(file, { signature, cursor: row }); return row;
    }
  } catch { /* first run */ }
  return empty();
}
export function guardRefusalsForState(state: string): Record<string, GuardRefusal> {
  return readCursor(path.join(state, "destructive-guard/refusals.cursor.json")).latest;
}
export interface GuardIngestPorts {
  current?(): boolean;
  resolve(row: GuardJournalRow): { conversationId: string | null; project: string | null };
  record(row: GuardJournalRow, owner: { conversationId: string | null; project: string | null }, refusal: GuardRefusal): Promise<void>;
  notify(conversationId: string, project: string | null, row: GuardJournalRow, refusal: GuardRefusal): Promise<void>;
  error(reason: string): void;
}
/** A bounded incremental reader. Cursor and projected attention commit together;
 * event and message keys are idempotent when interrupted before that commit. */
export class DestructiveRefusalIngester {
  private busy = false;
  private retired = false;
  private readonly cursorFile: string;
  private readonly journal: string;
  private readonly rootIdentity: { dev: number; ino: number; real: string };
  constructor(private state: string, private ports: GuardIngestPorts) {
    const root = fs.statSync(state);
    this.rootIdentity = { dev: root.dev, ino: root.ino, real: fs.realpathSync(state) };
    this.cursorFile = path.join(state, "destructive-guard/refusals.cursor.json");
    this.journal = path.join(state, "destructive-guard/refusals.ndjson");
  }
  private current() {
    if (this.retired || this.ports.current?.() === false) return false;
    try {
      const root = fs.statSync(this.state);
      return root.dev === this.rootIdentity.dev && root.ino === this.rootIdentity.ino && fs.realpathSync(this.state) === this.rootIdentity.real;
    } catch { return false; }
  }
  private save(cursor: Cursor) {
    if (!this.current()) return;
    const temporary = this.cursorFile + "." + randomUUID() + ".tmp";
    const descriptor = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(descriptor, JSON.stringify(cursor)); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    if (!this.current()) { fs.unlinkSync(temporary); return; }
    fs.renameSync(temporary, this.cursorFile);
  }
  async ingest() {
    if (this.busy || !this.current()) return;
    this.busy = true;
    let fd: number | undefined;
    try {
      let cursor = readCursor(this.cursorFile);
      const archive = this.journal + ".previous";
      let input = this.journal;
      const previous = fs.lstatSync(archive, { throwIfNoEntry: false });
      if (previous) {
        if (!previous.isFile() || previous.isSymbolicLink()) throw Error("invalid guard journal rotation");
        const previousIdentity = `${previous.dev}:${previous.ino}`;
        if (cursor.identity === previousIdentity) {
          if (previous.size > cursor.offset) input = archive;
          else if (Date.now() - previous.mtimeMs > 5000) { if (!this.current()) return; fs.unlinkSync(archive); }
          else return; // let already-open synchronous appenders finish
        } else input = archive; // a missing/corrupt cursor cannot prove retirement
      }
      try { fd = fs.openSync(input, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) throw Error("guard journal is not a file");
      const identity = `${stat.dev}:${stat.ino}`;
      if (cursor.identity !== identity || cursor.offset > stat.size) cursor = { ...cursor, offset: 0, identity };
      let bytes = Buffer.alloc(Math.min(64 * 1024, stat.size - cursor.offset));
      const count = fs.readSync(fd, bytes, 0, bytes.length, cursor.offset);
      bytes = bytes.subarray(0, count);
      if (cursor.skipping) {
        const first = bytes.indexOf(10);
        if (first < 0) { this.save({ ...cursor, offset: cursor.offset + count }); return count === 64 * 1024 && stat.size > cursor.offset + count; }
        cursor = { ...cursor, offset: cursor.offset + first + 1, skipping: false }; bytes = bytes.subarray(first + 1);
        this.save(cursor);
      }
      const last = bytes.lastIndexOf(10);
      if (last < 0) {
        if (count === 64 * 1024 && bytes.length === count) {
          this.ports.error("oversized guard journal line");
          this.save({ ...cursor, offset: cursor.offset + count, skipping: true });
          return stat.size > cursor.offset + count;
        }
        return;
      }
      cursor = structuredClone(cursor);
      for (const line of bytes.subarray(0, last).toString("utf8").split("\n")) {
        if (!line) continue;
        if (Buffer.byteLength(line) >= 4096) { this.ports.error("oversized guard journal line"); continue; }
        let row: GuardJournalRow;
        try {
          row = JSON.parse(line);
          if (row.v !== 1 || typeof row.id !== "string" || !row.id || typeof row.tool !== "string" || typeof row.command !== "string" || typeof row.cwd !== "string"
            || typeof row.at !== "string" || !Number.isFinite(Date.parse(row.at)) || !["hook", "wrapper", "error"].includes(row.layer)
            || !Array.isArray(row.targets) || !Array.isArray(row.parents) || row.parents.length > 12
            || row.parents.some(parent => !parent || !Number.isSafeInteger(parent.pid) || parent.pid <= 0 || typeof parent.comm !== "string" || typeof parent.args !== "string" || parent.startTime !== undefined && typeof parent.startTime !== "string")
            || row.caller !== undefined && (!row.caller || typeof row.caller !== "object" || Array.isArray(row.caller)
              || Object.values(row.caller).some(value => value !== undefined && typeof value !== "string"))) throw Error("invalid guard record");
          if (row.layer === "error") { this.ports.error(`guard program error: ${row.command}`); continue; }
          if (!row.targets[0] || !["entry", "kind", "rule", "given", "resolved"].every(key => typeof (row.targets[0] as unknown as Record<string, unknown>)[key] === "string")) throw Error("invalid guard target");
        } catch { this.ports.error("invalid destructive refusal journal line"); continue; }
        const owner = this.ports.resolve(row);
        const refusal: GuardRefusal = { id: row.id, at: row.at, tool: row.tool, entry: row.targets[0]!.entry, kind: row.targets[0]!.kind, command: row.command };
        if (!this.current()) return;
        await this.ports.record(row, owner, refusal);
        if (!this.current()) return;
        if (owner.conversationId) {
          const current = cursor.latest[owner.conversationId];
          if (!current || current.at <= refusal.at) cursor.latest[owner.conversationId] = refusal;
          if (row.layer === "wrapper" && (!cursor.notified[owner.conversationId] || Date.parse(row.at) - Date.parse(cursor.notified[owner.conversationId]!) >= 60_000)) {
            await this.ports.notify(owner.conversationId, owner.project, row, refusal);
            if (!this.current()) return;
            cursor.notified[owner.conversationId] = row.at;
          }
        }
      }
      cursor.offset += last + 1;
      // Bound both persistent indices, owned by this ingester.
      const retained = Object.entries(cursor.latest).sort((a, b) => b[1].at.localeCompare(a[1].at)).slice(0, 2000);
      cursor.latest = Object.fromEntries(retained);
      cursor.notified = Object.fromEntries(retained.flatMap(([id]) => cursor.notified[id] ? [[id, cursor.notified[id]!]] : []));
      if (!this.current()) return;
      this.save(cursor);
      if (!this.current()) return;
      // Rotate only after consuming the current end. Rename keeps concurrent
      // append descriptors valid; consume that retained inode before retirement.
      if (input === this.journal && stat.size >= 5 * 1024 * 1024 && cursor.offset === stat.size && fs.statSync(this.journal).ino === stat.ino) {
        // Copy-truncate loses concurrent appends. Keep the consumed generation
        // and let the next tick read any final appends before switching files.
        if (!fs.existsSync(archive)) fs.renameSync(this.journal, archive);
      }
      return count === 64 * 1024 && stat.size > cursor.offset;
    } catch (error) { try { this.ports.error(error instanceof Error ? error.message : "guard ingestion failed"); } catch { console.warn("[destructive guard] refusal alarm could not be persisted"); } }
    finally { if (fd !== undefined) fs.closeSync(fd); this.busy = false; }
  }
  start() {
    const directory = path.dirname(this.journal);
    try { fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); } catch { /* polling still reports journal failures */ }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drain = () => { void this.ingest().then(more => { if (more && this.current()) wake(); }); };
    const wake = () => { if (!timer && this.current()) timer = setTimeout(() => { timer = undefined; drain(); }, 20); };
    let watcher: fs.FSWatcher | undefined;
    try { watcher = fs.watch(directory, (_event, filename) => { if (String(filename) === path.basename(this.journal)) wake(); }); watcher.unref(); }
    catch { console.warn("[destructive guard] journal watch unavailable; polling every five seconds"); }
    const poll = setInterval(drain, 5000); poll.unref();
    drain();
    return () => { this.retired = true; watcher?.close(); clearInterval(poll); if (timer) clearTimeout(timer); };
  }
}

export async function destructiveRefusalPorts(current: () => boolean = () => true): Promise<GuardIngestPorts> {
  const releaseCurrent = current, directory = stateDir(), owner = process.env.LLV_STATE_OWNER, revision = process.env.LLV_HOT_STATE_RELEASE_REVISION;
  const root = fs.statSync(directory), real = fs.realpathSync(directory);
  const stateCurrent = () => {
    if (!releaseCurrent() || stateDir() !== directory || process.env.LLV_STATE_OWNER !== owner || process.env.LLV_HOT_STATE_RELEASE_REVISION !== revision) return false;
    try {
      const live = fs.statSync(directory);
      return live.dev === root.dev && live.ino === root.ino && fs.realpathSync(directory) === real;
    } catch { return false; }
  };
  const [{ agentRegistry }, { appendLifecycleEvents }, { projectInfoFromCwd }, { loadPipelinesForList, withPipelineMutation }, { deliverConversationMessage }, { delegatusMessageOrigin }, { stopMessage }, { StoreBusyBeforeAdmissionError }] = await Promise.all([
    import("@/lib/agent/registry"), import("@/lib/lifecycle/journal"), import("@/lib/scanner/describe"), import("@/lib/pipelines/store"), import("@/lib/delivery"), import("@/lib/runtime/agentMessageAuthor"), import("../../../bin/destructive-guard.mjs"), import("@/lib/state/fileTransaction"),
  ]);
  if (!stateCurrent()) throw Error("destructive guard ingestion lost release authority or its state root changed");
  const registry = agentRegistry();
  current = () => stateCurrent() && agentRegistry() === registry;
  return {
    current,
    resolve(row) {
      const id = row.caller?.capabilityDigest ? registry.conversationIdForSpawnCapabilityDigest(row.caller.capabilityDigest) : null;
      let conversation = id ? registry.conversation(id) : row.caller?.transcriptPath ? registry.conversationForPath(row.caller.transcriptPath) : null;
      if (!conversation && row.caller?.pipelineId) {
        const lane = loadPipelinesForList().find(pipeline => pipeline.id === row.caller!.pipelineId);
        const attempt = lane?.runs.find(run => run.stageId === (row.caller?.stageId ?? lane.cursor?.stageId))?.attempts.at(-1);
        if (attempt?.conversationId?.startsWith("conversation_")) conversation = registry.conversation(attempt.conversationId as `conversation_${string}`);
      }
      if (!conversation && row.parents.length) {
        // This registry read uses the structured-pid index on SQLite. Match the
        // recorded start token as well as pid before attributing an ancestor.
        const { snapshot } = registry.mcpCallerSnapshot(null, row.parents.map(parent => parent.pid), null);
        const entries = Object.values(snapshot?.entries ?? {});
        for (const parent of row.parents) {
          const entry = entries.find(entry => entry.structuredHost?.process?.pid === parent.pid
            && parent.startTime && entry.structuredHost.process.startIdentity === `${parent.pid}:${parent.startTime}`);
          if (entry) { conversation = registry.conversationForPath(entry.artifactPath); if (conversation) break; }
        }
      }
      return { conversationId: conversation?.id ?? null, project: projectInfoFromCwd(row.cwd)?.project ?? null };
    },
    async record(row, owner, refusal) {
      if (!current()) throw Error("destructive guard ingestion lost release authority");
      const locate = (pipelines: ReturnType<typeof loadPipelinesForList>) => {
        for (const pipeline of pipelines) for (const run of pipeline.runs) for (const attempt of [...run.attempts].reverse()) {
          if (owner.conversationId && attempt.conversationId === owner.conversationId && !attempt.historical) return { pipeline, run, attempt };
        }
        return null;
      };
      const lineage = locate(loadPipelinesForList());
      appendLifecycleEvents([{ type: "destructive_refused", key: `destructive-refused:${row.id}`, at: row.at, conversationId: owner.conversationId,
        project: lineage?.pipeline.project ?? owner.project, pipelineId: lineage?.pipeline.id ?? null, stageId: lineage?.run.stageId ?? null,
        attempt: lineage?.attempt.n ?? null, role: lineage?.attempt.effectiveRole?.roleId ?? null,
        summary: `Delegatus stopped ${row.tool}: ${refusal.entry} (${refusal.kind})` }]);
      for (let retry = 0; retry < 3; retry++) {
        try {
          await withPipelineMutation(async (pipelines, persist) => {
            if (!current()) throw Error("destructive guard ingestion lost release authority");
            const found = locate(pipelines); if (!found) return;
            if (!found.attempt.guardRefusals?.some(existing => existing.id === refusal.id)) {
              found.attempt.guardRefusals = [...(found.attempt.guardRefusals ?? []), refusal].slice(-20);
              await persist([found.pipeline]);
            }
          }); break;
        } catch (error) {
          if (!(error instanceof StoreBusyBeforeAdmissionError) || retry === 2) throw error;
          await new Promise(resolve => setTimeout(resolve, 250 * (retry + 1)));
        }
      }
    },
    async notify(conversationId, project, row) {
      if (!current()) return;
      const [{ DeliveryAdmissionRefusedError }, { enqueueStructuredMessage }] = await Promise.all([import("@/lib/deliveryAdmission"), import("@/lib/runtime/structuredMessageDelivery")]);
      if (!current()) return;
      const generation = registry.conversation(conversationId as `conversation_${string}`)?.generations.at(-1);
      if (!generation) return;
      const request = { conversationId, path: generation.path, clientMessageId: `destructive-guard:${row.id}`,
        admissionGuard: () => {
          if (!current() || registry.conversation(conversationId as `conversation_${string}`)?.generations.at(-1)?.path !== generation.path)
            throw new DeliveryAdmissionRefusedError("destructive guard ingestion lost release authority or its recipient generation changed");
        },
        text: stopMessage(row.targets[0], row.command), images: [], policy: "steer-or-queue" as const, origin: delegatusMessageOrigin("guard", project) };
      const queued = await enqueueStructuredMessage(request);
      if (!current()) return;
      const result = queued ?? await deliverConversationMessage({ ...request, pid: null });
      if (!current()) return;
      if (!result.ok) console.warn("[destructive guard] refusal message delivery unavailable");
    },
    error: reason => {
      console.warn("[destructive guard]", reason);
      if (!current()) return;
      appendLifecycleEvents([{ type: "destructive_guard_off", key: `destructive-guard-ingest:${Math.floor(Date.now() / 30000)}`, at: new Date().toISOString(), summary: reason }]);
    },
  };
}
const shared = globalThis as typeof globalThis & { __llvDestructiveRefusalIngest?: { stop(): void } };
export function stopDestructiveRefusalIngest() { shared.__llvDestructiveRefusalIngest?.stop(); shared.__llvDestructiveRefusalIngest = undefined; }
export async function startDestructiveRefusalIngest(isCurrent: () => boolean = () => true) {
  const { stateDir } = await import("@/lib/configDir");
  stopDestructiveRefusalIngest();
  let active = true;
  const current = () => active && isCurrent();
  let stop = () => {};
  const value = { stop: () => { active = false; stop(); } };
  shared.__llvDestructiveRefusalIngest = value;
  const ports = await destructiveRefusalPorts(current);
  if (!current() || ports.current?.() === false || shared.__llvDestructiveRefusalIngest !== value) return value.stop;
  stop = new DestructiveRefusalIngester(stateDir(), ports).start();
  return value.stop;
}
