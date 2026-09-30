import { repairLinkedTasks } from "./taskRepair";
import { sharedLinkState } from "./runtimeState";
/**
 * A's half of the `tasks` part of `boards/sync` (docs/design/linked-installs.md
 * M.5). A makes every request and carries both directions: it pulls B's log
 * from its cursor and pushes its own log from `pushed`, advancing each only on
 * B's answer. A project newly linked, or a store whose log no longer reaches
 * back, is rebuilt by scanning its rows by key; the merge is idempotent, so a
 * row sent twice changes nothing.
 */
import { readPeerTaskWireVersion, readTaskCursor, writeTaskCursor, type TaskCursor } from "./boardLinks";
import { installPrefix } from "./stamp";
import { applyTaskRows } from "./taskApply";
import { isPosition, readLogPage, readScanPage, PAGE_ROWS, type Position } from "./taskFeed";
import { decodeWireRow, MalformedRow, TASK_WIRE_VERSION, type WireRow } from "./taskWire";
import { taskFeedSource } from "@/lib/tasks/store";

export const TaskSyncError = sharedLinkState("taskExchange.errorClass", () => class TaskSyncError extends Error { constructor(readonly code: "malformed" | "clock" | "quota") { super(code); } });

/** A scan covers at most this many projects; more wait for the next scan. */
export const SCAN_PROJECTS = 200;
/** A cursor that only moved past other projects' writes is saved this often. */
const IDLE_CURSOR_SAVE_MS = 600_000;
/** Membership omitted before an older v3 cursor confirmed its first peer. */
const BOARD_MEMBERSHIP_REPLAY_VERSION = 1;
const lastSaved = sharedLinkState("taskExchange.lastSaved", () => new Map<string, number>());
/** One exchange per link and peer store, kept across calls: a cursor that
    moved in memory is what the next call sends. */
const exchanges = sharedLinkState("taskExchange.exchanges", () => new Map<string, TaskExchange>());

export function taskExchange(link: { id: string; install: string; store: string }, self: { id: string; prefix: string }): TaskExchange {
  const key = `${link.id}:${link.store}:${link.install}:${self.id}`;
  let held = exchanges.get(key);
  if (!held) {
    for (const stale of exchanges.keys()) if (stale.startsWith(`${link.id}:`)) exchanges.delete(stale);
    held = new TaskExchange(link, self);
    exchanges.set(key, held);
  }
  return held;
}

export function forgetTaskExchange(id: string): void {
  for (const key of exchanges.keys()) if (key.startsWith(`${id}:`)) exchanges.delete(key);
}

type Scan = { p: string[]; after: string; full: boolean; at: Position | null };
type Inflight = { kind: "log"; through: Position; rows: number; more: boolean } | { kind: "scan"; next: string | null; rows: number };
export type TaskRequest = { tasks?: Record<string, unknown>; push?: Record<string, unknown> };

const sameSet = (left: ReadonlySet<string>, right: readonly string[]) => right.every((key) => left.has(key));
const encodedAck = (value: Position | string | null) => JSON.stringify(value);

export class TaskExchange {
  private pull: Position | null;
  private pushed: Position | null;
  private pullCovered: Set<string>;
  private pushCovered: Set<string>;
  private pullScan: Scan | null = null;
  private pushScan: Scan | null = null;
  private inflight: Inflight | null = null;
  private pullMore = false;
  private pushMore = false;
  private dirty = false;
  private moved = false;
  private peerTaskWireVersion: number;
  private hasConsumedPull: boolean;
  private boardReplayVersion: number;
  /** Rows applied or sent over this exchange. */
  movedRows = 0;

  constructor(private readonly link: { id: string; install: string; store: string }, private readonly self: { id: string; prefix: string }) {
    const held = readTaskCursor(link.id, link.store);
    this.peerTaskWireVersion = readPeerTaskWireVersion(link.id, link.store);
    this.boardReplayVersion = held?.boardReplayVersion ?? 0;
    this.hasConsumedPull = Boolean(held && (held.pull !== null || held.pullCovered.length));
    this.pull = held?.pull ?? null;
    this.pushed = held?.pushed ?? null;
    this.pullCovered = new Set(held?.pullCovered ?? []);
    this.pushCovered = new Set(held?.pushCovered ?? []);
    if (this.peerTaskWireVersion >= TASK_WIRE_VERSION && this.boardReplayVersion < BOARD_MEMBERSHIP_REPLAY_VERSION) {
      // Earlier releases persisted v3 before replaying a fresh exchange's
      // pre-confirmation push. Rescan the sender's rows with membership now.
      this.pushed = null;
      this.pushCovered.clear();
      this.pushScan = null;
      this.pushMore = true;
      this.boardReplayVersion = BOARD_MEMBERSHIP_REPLAY_VERSION;
      this.dirty = true;
    }
  }

  private get peerPrefix() { return installPrefix(this.link.install); }

  /** Starts one sync: counts the rows it moves. */
  begin(): void {
    repairLinkedTasks();
    this.movedRows = 0;
    this.pullMore = false;
    this.pushMore = false;
  }

  /** The parts of the next request, or none while nothing is linked. */
  request(linked: ReadonlySet<string>): TaskRequest {
    if (!linked.size) return {};
    // Sharing may become agreed midway through the connect-time exchange.
    // Finish the repair before its first scan, so the following idle call writes nothing.
    repairLinkedTasks();
    for (const covered of [this.pullCovered, this.pushCovered]) for (const key of covered) if (!linked.has(key)) { covered.delete(key); this.dirty = true; }
    const sorted = [...linked].sort();
    const request: TaskRequest = {};
    // Pull.
    if (!this.pullScan) {
      const uncovered = sorted.filter((key) => !this.pullCovered.has(key));
      if (this.pull === null) this.pullScan = { p: sorted.slice(0, SCAN_PROJECTS), after: "", full: true, at: null };
      else if (uncovered.length) this.pullScan = { p: uncovered.slice(0, SCAN_PROJECTS), after: "", full: false, at: null };
    }
    if (this.pullScan && !sameSet(linked, this.pullScan.p)) this.pullScan = null;
    request.tasks = this.pullScan ? { after: this.pull, scan: { p: this.pullScan.p, after: this.pullScan.after } } : { after: this.pull };
    // Push, one page per call.
    this.inflight = null;
    this.pushMore = false;
    if (!this.pushScan) {
      const uncovered = sorted.filter((key) => !this.pushCovered.has(key));
      if (this.pushed === null) this.pushScan = { p: sorted.slice(0, SCAN_PROJECTS), after: "", full: true, at: [taskFeedSource()?.revision() ?? 0] };
      else if (uncovered.length) this.pushScan = { p: uncovered.slice(0, SCAN_PROJECTS), after: "", full: false, at: null };
    }
    if (this.pushScan && !sameSet(linked, this.pushScan.p)) this.pushScan = null;
    const filter = { self: this.self, skipPrefix: this.peerPrefix, includeBoard: this.peerTaskWireVersion >= TASK_WIRE_VERSION };
    if (this.pushScan) {
      const page = readScanPage(this.pushScan.after, { ...filter, projects: new Set(this.pushScan.p), skipPrefix: null });
      this.inflight = { kind: "scan", next: page.next, rows: page.rows.length };
      request.push = { rows: page.rows, scan: page.next };
    } else if (this.pushed) {
      const page = readLogPage(this.pushed, { ...filter, projects: linked });
      if (page.kind === "resync") {
        this.pushed = null;
        this.pushCovered.clear();
        this.dirty = true;
        this.pushMore = true;
      } else if (page.rows.length) {
        this.inflight = { kind: "log", through: page.cursor, rows: page.rows.length, more: page.more };
        request.push = { rows: page.rows, through: page.cursor };
      } else {
        if (JSON.stringify(page.cursor) !== JSON.stringify(this.pushed)) this.moved = true;
        this.pushed = page.cursor;
        this.pushMore = page.more;
      }
    }
    return request;
  }

  /** Folds one answer in: applies B's rows, then advances what B acknowledged. */
  accept(body: Record<string, unknown>, linked: ReadonlySet<string>): void {
    const peerVersion = body.taskWireVersion;
    const upgradeVersion = typeof peerVersion === "number" && Number.isSafeInteger(peerVersion) && peerVersion > this.peerTaskWireVersion ? peerVersion : null;
    const tasks = body.tasks as Record<string, unknown> | undefined;
    const replayPull = this.hasConsumedPull;
    if (tasks?.wait === true) {
      // B did not yet hold the shared lists this request assumed.
      this.inflight = null;
      this.pushMore = true;
      return;
    }
    if (tasks) this.hasConsumedPull = true;
    if (this.inflight) {
      const ack = (body.ack as { push?: unknown } | undefined)?.push;
      const expected = this.inflight.kind === "log" ? this.inflight.through : this.inflight.next;
      if (ack === undefined || encodedAck(ack as Position | string | null) !== encodedAck(expected)) throw new TaskSyncError("malformed");
      this.movedRows += this.inflight.rows;
      if (this.inflight.kind === "log") {
        this.pushed = this.inflight.through;
        this.pushMore = this.inflight.more;
        this.dirty = true;
      } else if (this.pushScan) {
        this.pushScan.after = this.inflight.next ?? "";
        if (this.inflight.next === null) {
          for (const key of this.pushScan.p) this.pushCovered.add(key);
          if (this.pushScan.full) this.pushed = this.pushScan.at;
          this.pushScan = null;
          this.dirty = true;
        }
        this.pushMore = true;
      }
      this.inflight = null;
    }
    if (!tasks) { if (upgradeVersion !== null && linked.size) this.confirmPeerTaskWireUpgrade(upgradeVersion, replayPull); return; }
    if (tasks.resync === true) {
      this.pull = null;
      this.pullCovered.clear();
      this.pullScan = null;
      this.pullMore = true;
      this.dirty = true;
      if (upgradeVersion !== null) this.confirmPeerTaskWireUpgrade(upgradeVersion, replayPull);
      return;
    }
    const rows = this.decode(tasks.rows);
    if (rows.length) this.apply(rows, linked);
    if (this.pullScan && tasks.scan !== undefined) {
      if (tasks.scan !== null && typeof tasks.scan !== "string") throw new TaskSyncError("malformed");
      if (this.pullScan.full && this.pullScan.after === "") {
        if (!isPosition(tasks.at)) throw new TaskSyncError("malformed");
        this.pullScan.at = tasks.at;
      }
      if (tasks.scan === null) {
        for (const key of this.pullScan.p) this.pullCovered.add(key);
        if (this.pullScan.full) this.pull = this.pullScan.at;
        this.pullScan = null;
        this.dirty = true;
      } else this.pullScan.after = tasks.scan;
      this.pullMore = true;
      if (upgradeVersion !== null) this.confirmPeerTaskWireUpgrade(upgradeVersion, replayPull);
      return;
    }
    if (!isPosition(tasks.cursor)) throw new TaskSyncError("malformed");
    if (JSON.stringify(tasks.cursor) !== JSON.stringify(this.pull)) this.moved = true;
    this.pull = tasks.cursor;
    this.pullMore = tasks.more === true;
    if (rows.length) this.dirty = true;
    if (upgradeVersion !== null) this.confirmPeerTaskWireUpgrade(upgradeVersion, replayPull);
  }

  /** Replay even a fresh exchange: its first push preceded capability confirmation. */
  private confirmPeerTaskWireUpgrade(version: number, replayPull: boolean): void {
    this.peerTaskWireVersion = version;
    if (version >= TASK_WIRE_VERSION) this.boardReplayVersion = BOARD_MEMBERSHIP_REPLAY_VERSION;
    // The confirming response already used the advertised request version.
    // Replay earlier pulls, while preserving a fresh v3 scan's current page.
    if (replayPull) {
      this.pull = null;
      this.pullCovered.clear();
      this.pullScan = null;
      this.pullMore = true;
    }
    this.pushed = null;
    this.pushCovered.clear();
    this.pushScan = null;
    this.pushMore = true;
    this.dirty = true;
  }

  private decode(value: unknown): WireRow[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > PAGE_ROWS) throw new TaskSyncError("malformed");
    try { return value.map(decodeWireRow); } catch (error) {
      if (error instanceof MalformedRow) throw new TaskSyncError("malformed");
      throw error;
    }
  }

  private apply(rows: WireRow[], linked: ReadonlySet<string>): void {
    let outcome;
    try { outcome = applyTaskRows(rows, { key: `peer:${this.link.id}`, install: this.link.install, prefix: this.peerPrefix, projects: linked }); }
    catch (error) {
      if (error instanceof MalformedRow) throw new TaskSyncError("malformed");
      throw error;
    }
    if (outcome.refused) throw new TaskSyncError(outcome.refused);
    this.movedRows += rows.length;
  }

  /** Whether this machine's log holds a linked change the peer has not yet
      taken. A cursor that only passes other projects' writes moves in memory. */
  hasPush(linked: ReadonlySet<string>): boolean {
    if (!linked.size) return false;
    if (this.pushScan || this.pushed === null || [...linked].some((key) => !this.pushCovered.has(key))) return true;
    const page = readLogPage(this.pushed, { self: this.self, skipPrefix: this.peerPrefix, projects: linked,
      includeBoard: this.peerTaskWireVersion >= TASK_WIRE_VERSION });
    if (page.kind === "resync" || page.rows.length) return true;
    if (JSON.stringify(page.cursor) !== JSON.stringify(this.pushed)) this.moved = true;
    this.pushed = page.cursor;
    return page.more;
  }

  /** Whether another call is owed before the link is quiet. */
  pending(): boolean {
    return this.pullMore || this.pushMore || this.pullScan !== null || this.pushScan !== null;
  }

  /** Saves the cursor after data moved, else at most every 10 minutes. */
  save(now = Date.now()): void {
    const key = `${this.link.id}:${this.link.store}`;
    if (!this.dirty && !(this.moved && now - (lastSaved.get(key) ?? 0) >= IDLE_CURSOR_SAVE_MS)) return;
    const cursor: TaskCursor = { pull: this.pull, pushed: this.pushed, pullCovered: [...this.pullCovered].sort(), pushCovered: [...this.pushCovered].sort(), boardReplayVersion: this.boardReplayVersion };
    writeTaskCursor(this.link.id, this.link.store, cursor, this.peerTaskWireVersion);
    lastSaved.set(key, now);
    this.dirty = false;
    this.moved = false;
  }
}
