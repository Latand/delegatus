import type { RuntimeSession } from "@/components/runtime/runtimeModel";
import type { RuntimeBusState, RuntimeFrame } from "@/hooks/runtimeBus";
import type { FilesData } from "@/hooks/useFiles";
import { catalogPositions, shareCatalogPositions } from "@/lib/accounts/identity";
import { recordReplacedRows } from "@/lib/client/catalogOverlay";
import type { FileEntry } from "@/lib/types";

type Status = Pick<RuntimeSession, "conversationId" | "sessionKey" | "artifactPath" | "turn" | "activeTurnId" | "settledTurnId">
  & { hasAttention: boolean; observedTurn: boolean };
type Settlement = {
  conversationId: string;
  path: string;
  engine: FileEntry["engine"];
  settledTurnId: string | null;
  authoritativeTurn: NonNullable<FileEntry["authoritativeTurn"]>;
  clearAttention: boolean;
  sourceRow: FileEntry;
};
type Changes = { conversations: Set<string>; paths: Set<string>; expired?: Set<number> };

const identity = (session: Pick<RuntimeSession, "conversationId" | "artifactPath">) =>
  JSON.stringify([session.conversationId, session.artifactPath]);
const generationKey = (file: FileEntry) =>
  JSON.stringify([file.path, file.engine, file.lastTurn?.startedAt ?? [file.mtime, file.size]]);
const qualified = (s?: RuntimeSession) => s?.provenance === "structured" && s.hostKind !== "unhosted" ? s : undefined;

function sameBoardStatus(a?: RuntimeSession, b?: RuntimeSession): boolean {
  if (a === b) return true;
  return !!a && !!b && a.conversationId === b.conversationId && a.artifactPath === b.artifactPath
    && a.sessionKey.engine === b.sessionKey.engine && a.sessionKey.sessionId === b.sessionKey.sessionId
    && a.turn === b.turn && a.activeTurnId === b.activeTurnId && a.settledTurnId === b.settledTurnId
    && Boolean(a.attentionIds.length) === Boolean(b.attentionIds.length)
    && Boolean(a.liveTurn?.text || a.liveTurn?.items?.length) === Boolean(b.liveTurn?.text || b.liveTurn?.items?.length);
}

/** Only settlement overlays certified catalog bytes. The runtime reducer supplies
 * the identities written in a frame. A snapshot or missing frame takes the full path. */
export function createRuntimeFilesStatusProjection() {
  let revision = 0;
  let changes: Changes | undefined;
  let live = false;
  let lastSessions: Record<string, RuntimeSession> | undefined;
  const byConversation = new Map<string, Status>();
  const byPath = new Map<string, Set<Status>>();
  const observedTurns = new Set<string>();
  const activeTurnIds = new Map<string, string>();
  const terminalGenerations = new Map<string, { turnId: string; keys: Set<string> }>();
  const settlements = new Map<string, Settlement>();
  const settledRows = new WeakMap<FileEntry, { settlement: Settlement; row: FileEntry }>();
  const ownedSettlements = new Map<string, Set<string>>();
  const projected = new WeakMap<FilesData, { revision: number; value: FilesData }>();
  const arrays = new WeakMap<FileEntry[], { revision: number; value: FileEntry[]; overlays: number }>();
  let activeFiles: FileEntry[] | undefined;
  const expiries = new Map<number, number>();
  let nextExpiry = Infinity;

  function removeStatus(status: Status) {
    byConversation.delete(status.conversationId);
    if (!status.artifactPath) return;
    const owners = byPath.get(status.artifactPath);
    owners?.delete(status);
    if (!owners?.size) byPath.delete(status.artifactPath);
  }

  function installStatus(session: RuntimeSession) {
    const key = identity(session);
    if (session.turn === "running" || session.turn === "interrupt_requested") {
      observedTurns.add(key);
      if (session.activeTurnId) activeTurnIds.set(key, session.activeTurnId);
      const owned = ownedSettlements.get(session.conversationId);
      for (const generation of owned ?? []) {
        const old = settlements.get(generation);
        if (old?.conversationId === session.conversationId && old.engine === session.sessionKey.engine
          && (old.path.startsWith("spawn:") || old.path === session.artifactPath)
          && session.activeTurnId !== null && session.activeTurnId !== old.settledTurnId) {
          settlements.delete(generation);
          owned!.delete(generation);
        }
      }
      if (!owned?.size) ownedSettlements.delete(session.conversationId);
    }
    if (session.turn !== "idle" && !(session.settledTurnId && (!session.activeTurnId || session.activeTurnId === session.settledTurnId))) return;
    const status: Status = {
      conversationId: session.conversationId, sessionKey: session.sessionKey, artifactPath: session.artifactPath,
      turn: session.turn, activeTurnId: session.activeTurnId, settledTurnId: session.settledTurnId,
      hasAttention: session.attentionIds.length > 0,
      observedTurn: Boolean(session.settledTurnId) || observedTurns.has(key) || Boolean(session.liveTurn?.text || session.liveTurn?.items?.length),
    };
    byConversation.set(status.conversationId, status);
    if (status.artifactPath) {
      const owners = byPath.get(status.artifactPath) ?? new Set<Status>();
      owners.add(status);
      byPath.set(status.artifactPath, owners);
    }
  }

  function updateRuntime(runtime: RuntimeBusState, frame?: RuntimeFrame): boolean {
    if (!runtime.enabled || runtime.connection !== "live" || !runtime.store) {
      if (!live) return false;
      live = false;
      changes = undefined;
      revision++;
      return true;
    }
    const current = runtime.store.sessions;
    if (live && current === lastSessions) return false;
    const incremental = live && frame && frame.before.sessions === lastSessions && frame.after.sessions === current ? frame : undefined;
    const ids = incremental ? incremental.conversations : new Set([...Object.keys(lastSessions ?? {}), ...Object.keys(current)]);
    const dirty: Changes = { conversations: new Set(), paths: new Set() };
    for (const id of ids) {
      const before = qualified(lastSessions?.[id]);
      const after = qualified(current[id]);
      if (sameBoardStatus(before, after)) continue;
      // Text arriving in a running turn cannot change its catalog status after
      // the first observed start. A retained end still has to bind its generation.
      if (before && after && before.turn === "running" && after.turn === "running"
        && before.activeTurnId === after.activeTurnId && !before.settledTurnId && !after.settledTurnId
        && before.conversationId === after.conversationId && before.artifactPath === after.artifactPath
        && before.sessionKey.engine === after.sessionKey.engine) continue;
      if (before) {
        const status = byConversation.get(before.conversationId);
        if (status) removeStatus(status);
        if (!after || identity(before) !== identity(after)) {
          observedTurns.delete(identity(before));
          activeTurnIds.delete(identity(before));
        }
        dirty.conversations.add(before.conversationId);
        if (before.artifactPath) dirty.paths.add(before.artifactPath);
      }
      if (after) {
        installStatus(after);
        dirty.conversations.add(after.conversationId);
        if (after.artifactPath) dirty.paths.add(after.artifactPath);
      }
    }
    lastSessions = current;
    if (!dirty.conversations.size && live) return false;
    changes = incremental ? dirty : undefined;
    live = true;
    revision++;
    if (incremental && activeFiles) {
      const layout = catalogPositions(activeFiles);
      for (const id of dirty.conversations) if (layout.byConversation.has(id)) return true;
      for (const path of dirty.paths) if (layout.byPath.has(path)) return true;
      // A later catalog admission still sees the current status. This scope has no row to publish.
      // Carry its array across the miss so the next real change can still use the index.
      const entry = arrays.get(activeFiles);
      if (entry?.revision === revision - 1) entry.revision = revision;
      return false;
    }
    return true;
  }

  function currentStatus(file: FileEntry) {
    let status: Status | undefined;
    if (file.conversationId) status = byConversation.get(file.conversationId);
    else {
      const owners = byPath.get(file.path);
      if (owners?.size === 1) status = owners.values().next().value;
    }
    const initialMessage = (file.spawn ?? file.launch)?.initialMessage;
    return status && status.sessionKey.engine === file.engine
      && (!(initialMessage === "queued" || initialMessage === "pending") || status.observedTurn)
      && (file.path.startsWith("spawn:") || status.artifactPath === file.path) ? status : undefined;
  }

  function applySettlement(file: FileEntry, settlement: Settlement, now: number): FileEntry {
    const activity = now < (file.mtime + 900) * 1000 ? "recent" : "idle";
    const cached = settledRows.get(file);
    if (cached?.settlement === settlement && cached.row.activity === activity) return cached.row;
    const row: FileEntry = { ...file, activity, activityReason: "runtime_turn_idle",
      authoritativeTurn: file.authoritativeTurn?.state === "terminal" ? file.authoritativeTurn : settlement.authoritativeTurn,
      ...(settlement.clearAttention ? { pendingQuestion: null, waitingInput: null } : {}) };
    settledRows.set(file, { settlement, row });
    return row;
  }

  function projectRow(file: FileEntry, now: number): FileEntry {
    const generation = generationKey(file);
    const old = settlements.get(generation);
    const prior = old && (!file.conversationId || old.conversationId === file.conversationId) ? old : undefined;
    const status = live ? currentStatus(file) : undefined;
    if (!status || (status.settledTurnId && !terminalGenerations.get(identity(status))?.keys.has(generation))) {
      return prior ? applySettlement(file, prior, now) : file;
    }
    const settledTurnId = status.settledTurnId ?? status.activeTurnId ?? activeTurnIds.get(identity(status)) ?? null;
    if (prior?.conversationId === status.conversationId && prior.settledTurnId === settledTurnId
      && prior.clearAttention === !status.hasAttention && (status.settledTurnId || prior.sourceRow === file)) {
      return applySettlement(file, prior, now);
    }
    const settlement: Settlement = { conversationId: status.conversationId, path: file.path, engine: file.engine, sourceRow: file,
      settledTurnId, clearAttention: !status.hasAttention, authoritativeTurn: file.authoritativeTurn?.state === "terminal"
        ? file.authoritativeTurn : { state: "idle", source: "lifecycle", terminalAt: null } };
    if (old && old.conversationId !== status.conversationId) ownedSettlements.get(old.conversationId)?.delete(generation);
    settlements.set(generation, settlement);
    const owned = ownedSettlements.get(status.conversationId) ?? new Set<string>();
    owned.add(generation);
    ownedSettlements.set(status.conversationId, owned);
    return applySettlement(file, settlement, now);
  }

  function expire(now = Date.now()): boolean {
    if (now < nextExpiry) return false;
    const expired = new Set<number>();
    nextExpiry = Infinity;
    for (const [position, deadline] of expiries) {
      if (deadline <= now) { expired.add(position); expiries.delete(position); }
      else nextExpiry = Math.min(nextExpiry, deadline);
    }
    if (!expired.size) return false;
    changes = { conversations: new Set(), paths: new Set(), expired };
    revision++;
    return true;
  }

  function project(data: FilesData, runtime: RuntimeBusState): FilesData {
    const now = Date.now();
    expire(now);
    updateRuntime(runtime);
    const sameCatalog = activeFiles === data.files;
    if (!sameCatalog) {
      activeFiles = data.files;
      expiries.clear();
      nextExpiry = Infinity;
    }
    const cached = projected.get(data);
    if (sameCatalog && cached?.revision === revision) return cached.value;
    const priorArray = arrays.get(data.files);
    let files = priorArray?.value ?? data.files;
    if (!sameCatalog || priorArray?.revision !== revision) {
      // All generations, including provisional rows and duplicate paths, share one catalog index.
      const layout = catalogPositions(data.files);
      let positions: Set<number> | undefined;
      if (sameCatalog && priorArray?.revision === revision - 1 && changes) {
        positions = new Set(changes.expired);
        for (const id of changes.conversations) for (const i of layout.byConversation.get(id) ?? []) positions.add(i);
        for (const path of changes.paths) for (const i of layout.byPath.get(path) ?? []) positions.add(i);
      }
      const indices = () => positions ?? data.files.keys();
      if (live) {
        const firstSeen = new Set<string>();
        for (const position of indices()) {
          const file = data.files[position]!;
          const status = currentStatus(file);
          if (!status?.settledTurnId) continue;
          const key = identity(status);
          if (terminalGenerations.get(key)?.turnId !== status.settledTurnId) {
            terminalGenerations.set(key, { turnId: status.settledTurnId, keys: new Set() });
            firstSeen.add(key);
          }
          if (firstSeen.has(key)) terminalGenerations.get(key)!.keys.add(generationKey(file));
        }
      }
      const previous = files;
      const replaced: number[] = [];
      let overlays = priorArray?.overlays ?? 0;
      for (const position of indices()) {
        const file = data.files[position]!;
        const row = projectRow(file, now);
        if (row !== file && row.activity === "recent") {
          const deadline = (file.mtime + 900) * 1000;
          expiries.set(position, deadline);
          nextExpiry = Math.min(nextExpiry, deadline);
        } else expiries.delete(position);
        if (previous[position] === row) continue;
        if (files === previous) files = previous.slice();
        overlays += Number(row !== file) - Number(previous[position] !== file);
        files[position] = row;
        replaced.push(position);
      }
      if (overlays === 0) files = data.files;
      shareCatalogPositions(data.files, files);
      /* Readers of the array this scope published before follow by position. */
      if (sameCatalog && priorArray) recordReplacedRows(priorArray.value, files, replaced);
      arrays.set(data.files, { revision, value: files, overlays });
    }
    const result = cached?.value.files === files ? cached.value : files === data.files ? data : { ...data, files };
    projected.set(data, { revision, value: result });
    return result;
  }
  return Object.assign(project, { updateRuntime, expire, nextExpiry: () => nextExpiry });
}
