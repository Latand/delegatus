/** Ephemeral, bounded agent summaries for one linked-board connection (M.6). */
import { createHash, randomBytes } from "node:crypto";

import { lastScannedFiles } from "@/lib/scanner/scanCache";
import { loadTasksForList } from "@/lib/tasks/store";
import { findPipelineRecord } from "@/lib/pipelines/store";
import type { Engine, FileEntry } from "@/lib/types";
import { linkedContext } from "./linked";

export type AgentRow = { k: string; p: string; t: string; e: string; m: string; st: "working" | "waiting" | "done"; task?: string; at: number; pl?: { id: string; state: string; stage: string; stageState: string } };
type Change = AgentRow | { k: string; gone: true };
type Versioned = { row: AgentRow; version: number; encoded: string };
type Marker = { k: string; version: number; at: number };
export type Cursor = { epoch: string; version: number };
type Part = { after: Cursor | null; rows?: Change[]; reset?: true; more?: true; cursor: Cursor };
const PROJECT = /^repo-[0-9a-f]{32}$/;
const AGENT_ENGINES: ReadonlySet<Engine> = new Set(["claude", "codex", "copilot", "openclaw"]);
const feeds = new Map<string, AgentFeed>();
const received = new Map<string, { rows: Map<string, AgentRow>; at: number; reset?: { cursor: Cursor; rows: Map<string, AgentRow> } }>();

function safeId(value: unknown): string | null { return typeof value === "string" && /^[a-zA-Z0-9._-]{1,64}$/.test(value) ? value : null; }
function rowFor(file: FileEntry, tasks: ReturnType<typeof loadTasksForList>, projects: ReadonlySet<string>): AgentRow | null {
  if (!AGENT_ENGINES.has(file.engine)) return null;
  const identity = file.conversationId ?? file.path;
  if (!identity) return null;
  const task = tasks.find((item) => item.assignments.some((assignment) => assignment.conversationId === file.conversationId || assignment.path === file.path));
  const membership = file.durableLineage?.memberships.find((item) => item.kind === "pipeline" && item.containerId && item.stageId);
  const pipeline = membership ? findPipelineRecord(membership.containerId) : null;
  const boundTask = task ?? (pipeline ? tasks.find((item) => pipeline.taskIds.includes(item.id)) : undefined);
  const p = boundTask?.project ?? file.project;
  if (!projects.has(p) || !PROJECT.test(p)) return null;
  const at = file.lastAgentWorkAt ?? file.mtime * 1000;
  if (file.proc !== "running" && Date.now() - at > 86_400_000) return null;
  const engine = safeId(file.engine)!;
  const model = safeId(file.launchModel) ?? safeId(file.model) ?? "unknown";
  const stage = pipeline?.stages.find((item) => item.id === membership?.stageId);
  const attempt = pipeline?.runs.find((run) => run.stageId === stage?.id)?.attempts.find((item) => item.conversationId === file.conversationId || item.agentPath === file.path);
  const title = boundTask?.chosen ? boundTask.text.split(/\r?\n|\r/, 1)[0]!.slice(0, 120)
    : stage ? `${safeId(stage.id) ?? "Pipeline"} stage` : `${engine} agent`;
  const working = file.proc === "running" && (file.activity === "live" || file.activity === "recent");
  const st = file.pendingQuestion || file.waitingInput || file.pendingPermission ? "waiting" : working ? "working" : "done";
  return { k: `a:${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`, p, t: title,
    e: engine, m: model, st, ...(boundTask ? { task: boundTask.id } : {}), at,
    ...(pipeline && stage ? { pl: { id: safeId(pipeline.id) ?? "pipeline", state: safeId(pipeline.state) ?? "unknown", stage: safeId(stage.id) ?? "stage", stageState: safeId(attempt?.state) ?? "unknown" } } : {}) };
}

export function decodeAgentRow(value: unknown, projects: ReadonlySet<string>): AgentRow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as AgentRow;
  if (!/^a:[0-9a-f]{16}$/.test(row.k) || !PROJECT.test(row.p) || !projects.has(row.p) || typeof row.t !== "string" || row.t.length > 120 || /[\r\n]/.test(row.t)
    || !safeId(row.e) || !safeId(row.m) || !["working", "waiting", "done"].includes(row.st)
    || !Number.isSafeInteger(row.at) || row.at < 0 || row.task !== undefined && !safeId(row.task)
    || row.pl !== undefined && (!row.pl || typeof row.pl !== "object" || !safeId(row.pl.id) || !safeId(row.pl.state) || !safeId(row.pl.stage) || !safeId(row.pl.stageState))
    || Buffer.byteLength(JSON.stringify(row)) > 1536) return null;
  return { k: row.k, p: row.p, t: row.t, e: row.e, m: row.m, st: row.st,
    ...(row.task ? { task: row.task } : {}), at: row.at,
    ...(row.pl ? { pl: { id: row.pl.id, state: row.pl.state, stage: row.pl.stage, stageState: row.pl.stageState } } : {}) };
}

export class AgentFeed {
  private readonly epoch = randomBytes(8).toString("hex");
  private rows = new Map<string, Versioned>();
  private markers: Marker[] = [];
  private version = 0;
  private scanned: readonly FileEntry[] | null = null;
  private projectsKey = "";
  private resetSnapshot: { key: string; rows: AgentRow[]; cursor: Cursor } | null = null;
  private floor = 0;
  private expiresAt = Infinity;
  constructor(readonly id: string, private readonly source: () => readonly FileEntry[] | null = lastScannedFiles,
    private readonly tasks: () => ReturnType<typeof loadTasksForList> = loadTasksForList) {}

  refresh(projects: ReadonlySet<string>): void {
    const files = this.source();
    const projectsKey = [...projects].sort().join("|");
    if (files === this.scanned && projectsKey === this.projectsKey && Date.now() < this.expiresAt) { this.pruneMarkers(); return; }
    if (projectsKey !== this.projectsKey) this.resetSnapshot = null;
    this.scanned = files;
    this.projectsKey = projectsKey;
    this.expiresAt = Infinity;
    const tasks = files ? this.tasks() : [];
    const next = new Map<string, AgentRow>();
    for (const file of files ?? []) {
      const row = rowFor(file, tasks, projects);
      if (row) {
        next.set(row.k, row);
        if (file.proc !== "running") this.expiresAt = Math.min(this.expiresAt, row.at + 86_400_000);
      }
    }
    const selected = [...next.values()].sort((a, b) => b.at - a.at || a.k.localeCompare(b.k));
    const perProject = new Map<string, number>();
    const wanted = new Map<string, AgentRow>();
    for (const row of selected) {
      if (wanted.size === 200) break;
      const count = perProject.get(row.p) ?? 0;
      if (count >= 50) continue;
      perProject.set(row.p, count + 1);
      wanted.set(row.k, row);
    }
    for (const [key, held] of this.rows) if (!wanted.has(key)) {
      this.rows.delete(key);
      this.markers.push({ k: key, version: ++this.version, at: Date.now() });
    }
    for (const [key, row] of wanted) {
      const encoded = JSON.stringify(row);
      if (this.rows.get(key)?.encoded !== encoded) this.rows.set(key, { row, version: ++this.version, encoded });
    }
    this.pruneMarkers();
  }

  private pruneMarkers(): void {
    const kept = this.markers.filter((item) => Date.now() - item.at < 3_600_000).slice(-200);
    for (const marker of this.markers.slice(0, this.markers.length - kept.length)) this.floor = Math.max(this.floor, marker.version);
    this.markers = kept;
  }

  sizes() { return { rows: this.rows.size, markers: this.markers.length }; }

  page(after: Cursor | null, projects: ReadonlySet<string>, offset = 0): Part {
    this.refresh(projects);
    const reset = !after || after.epoch !== this.epoch || after.version < this.floor || after.version > this.version;
    if (reset) {
      const key = after ? `${after.epoch}:${after.version}` : "initial";
      const changedSnapshot = !this.resetSnapshot || this.resetSnapshot.key !== key;
      if (changedSnapshot) this.resetSnapshot = {
        key, rows: [...this.rows.values()].sort((a, b) => b.row.at - a.row.at).map((item) => item.row), cursor: { epoch: this.epoch, version: this.version },
      };
      const snapshot = this.resetSnapshot!;
      const start = changedSnapshot ? 0 : offset;
      const rows = snapshot.rows.slice(start, start + 50);
      const more = start + rows.length < snapshot.rows.length;
      return { after, rows, ...(start === 0 ? { reset: true as const } : {}), ...(more ? { more: true as const } : {}), cursor: snapshot.cursor };
    }
    this.resetSnapshot = null;
    const changes = [...this.rows.values()].filter((item) => item.version > after.version).map((item) => ({ version: item.version, row: item.row as Change }))
      .concat(this.markers.filter((item) => item.version > after.version).map((item) => ({ version: item.version, row: { k: item.k, gone: true } as Change })))
      .sort((a, b) => a.version - b.version);
    const page = changes.slice(0, 50);
    return { after, ...(page.length ? { rows: page.map((item) => item.row) } : {}), ...(changes.length > page.length ? { more: true as const } : {}),
      cursor: { epoch: this.epoch, version: page.at(-1)?.version ?? this.version } };
  }
}

export function agentFeed(id: string): AgentFeed { let feed = feeds.get(id); if (!feed) { feed = new AgentFeed(id); feeds.set(id, feed); } return feed; }
const cursors = new Map<string, { pull: Cursor | null; pushed: Cursor | null; pullOffset: number; pushOffset: number; projectsKey: string }>();
export function agentCursors(id: string): { pull: Cursor | null; pushed: Cursor | null; pullOffset: number; pushOffset: number; projectsKey: string } {
  let state = cursors.get(id);
  if (!state) { state = { pull: null, pushed: null, pullOffset: 0, pushOffset: 0, projectsKey: "" }; cursors.set(id, state); }
  return state;
}
export function encodeCursor(cursor: Cursor | null): string | null { return cursor ? `${cursor.epoch}:${cursor.version.toString(36)}` : null; }
export function decodeCursor(value: unknown): Cursor | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const match = value.match(/^([0-9a-f]{16}):([0-9a-z]{1,10})$/);
  if (!match) return undefined;
  const version = parseInt(match[2]!, 36);
  return Number.isSafeInteger(version) ? { epoch: match[1]!, version } : undefined;
}
export function agentPart(id: string, after: Cursor | null, projects: ReadonlySet<string>, offset = 0) {
  const { rows, reset, more, cursor } = agentFeed(id).page(after, projects, offset);
  return { ...(rows?.length ? { rows } : {}), ...(reset ? { reset } : {}), ...(more ? { more } : {}), cursor: encodeCursor(cursor) };
}
export function dropAgents(id: string): void { feeds.delete(id); received.delete(id); cursors.delete(id); }
export function receivedAgentRows(id: string): readonly AgentRow[] { return [...(received.get(id)?.rows.values() ?? [])]; }
export function touchAgents(id: string): void { const state = received.get(id); if (state) state.at = Date.now(); }
export function remoteAgents(project: string, taskId?: string): Array<AgentRow & { peer: string; stale: boolean; asOf: number }> {
  const context = linkedContext();
  return context.links.flatMap((link) => {
    const state = received.get(link.key);
    if (!state || !link.projects.has(project)) return [];
    return [...state.rows.values()].filter((row) => row.p === project && (taskId === undefined || row.task === taskId))
      .map((row) => ({ ...row, peer: link.label, stale: Date.now() - state.at > 900_000, asOf: state.at }));
  });
}
export function acceptAgents(id: string, part: unknown, projects: ReadonlySet<string>): boolean {
  if (!part || typeof part !== "object" || Array.isArray(part)) return false;
  const wire = part as Partial<Part>;
  const cursor = decodeCursor(wire.cursor);
  if (!cursor || !Array.isArray(wire.rows) && wire.rows !== undefined || (wire.rows?.length ?? 0) > 50) return false;
  const held = received.get(id) ?? { rows: new Map<string, AgentRow>(), at: 0 };
  if (!wire.reset && held.reset && (held.reset.cursor.epoch !== cursor.epoch || held.reset.cursor.version !== cursor.version)) return false;
  if (wire.reset) held.reset = { cursor, rows: new Map() };
  const target = held.reset?.rows ?? held.rows;
  for (const value of wire.rows ?? []) {
    if (value && typeof value === "object" && "gone" in value && (value as { gone?: unknown }).gone === true && /^a:[0-9a-f]{16}$/.test((value as { k?: string }).k ?? "")) target.delete((value as { k: string }).k);
    else {
      const row = decodeAgentRow(value, projects);
      if (row) target.set(row.k, row);
    }
  }
  if (target.size > 50) {
    const counts = new Map<string, number>();
    const kept = [...target.values()].sort((a, b) => b.at - a.at).filter((row) => {
      const count = counts.get(row.p) ?? 0;
      if (count >= 50) return false;
      counts.set(row.p, count + 1);
      return true;
    }).slice(0, 200);
    target.clear();
    for (const row of kept) target.set(row.k, row);
  }
  if (!wire.more && held.reset) { held.rows = held.reset.rows; delete held.reset; }
  for (const [key, row] of held.rows) if (!projects.has(row.p)) held.rows.delete(key);
  held.at = Date.now();
  received.set(id, held);
  return true;
}
