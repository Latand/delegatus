import type { RuntimeSession } from "@/components/runtime/runtimeModel";
import type { RuntimeBusState } from "@/hooks/runtimeBus";
import type { FilesData } from "@/hooks/useFiles";
import type { FileEntry } from "@/lib/types";

type Status = Pick<RuntimeSession, "conversationId" | "sessionKey" | "artifactPath" | "turn" | "activeTurnId">
  & { hasAttention: boolean; observedTurn: boolean };

/** Inventory generations deliberately coalesce transcript revisions for five
 * minutes. Turn status must instead follow the structured runtime in the same
 * frame as its live feed. This projection stays outside the certified files
 * cache: neither its ETag/deltas nor its persisted snapshot contain UI overlays.
 * Text deltas do not change the status signature or wake the whole board.
 */
export function createRuntimeFilesStatusProjection() {
  let signature = "";
  let byConversation = new Map<string, Status>();
  let byPath = new Map<string, Status | null>();
  let projected = new WeakMap<FilesData, FilesData>();
  let rows = new WeakMap<FileEntry, FileEntry>();
  let arrays = new WeakMap<FileEntry[], FileEntry[]>();
  const lastTrustedRows = new WeakMap<FileEntry, FileEntry>();
  const observedTurns = new Set<string>();
  let live = false;

  const updateRuntime = (runtime: RuntimeBusState): boolean => {
    // During fallback polling the retained bus store can precede the newly
    // fetched transcript. It has authority again only after stream recovery.
    // Keep a settlement already rendered for unchanged catalog bytes; a new
    // fallback representation gets its own newer transcript evidence instead.
    if (!runtime.enabled || runtime.connection !== "live" || !runtime.store) {
      if (!live) return false;
      live = false;
      projected = new WeakMap();
      arrays = new WeakMap();
      return true;
    }
    const sessions = runtime.enabled && runtime.connection === "live" && runtime.store
      ? Object.values(runtime.store.sessions).filter((session) =>
        session.provenance === "structured"
        && session.hostKind !== "tmux-legacy" && session.hostKind !== "unhosted")
      : [];
    const identity = (session: RuntimeSession) => JSON.stringify([session.conversationId, session.artifactPath]);
    const currentIdentities = new Set(sessions.map(identity));
    for (const key of observedTurns) if (!currentIdentities.has(key)) observedTurns.delete(key);
    for (const session of sessions) {
      if (session.turn === "running" || session.turn === "interrupt_requested") observedTurns.add(identity(session));
    }
    const statuses = sessions.filter((session) => session.turn === "idle").map((session) => ({
      conversationId: session.conversationId, sessionKey: session.sessionKey, artifactPath: session.artifactPath,
      turn: session.turn, activeTurnId: session.activeTurnId, hasAttention: session.attentionIds.length > 0,
      observedTurn: observedTurns.has(identity(session)) || Boolean(session.liveTurn?.text || session.liveTurn?.items?.length),
    }));
    const nextSignature = JSON.stringify(statuses);
    if (nextSignature !== signature || !live) {
      live = true;
      signature = nextSignature;
      byConversation = new Map(statuses.map((status) => [status.conversationId, status]));
      byPath = new Map();
      for (const status of statuses) {
        if (status.artifactPath) byPath.set(status.artifactPath,
          byPath.has(status.artifactPath) ? null : status);
      }
      projected = new WeakMap();
      rows = new WeakMap();
      arrays = new WeakMap();
      return true;
    }
    return false;
  };

  const project = (data: FilesData, runtime: RuntimeBusState): FilesData => {
    updateRuntime(runtime);
    const cached = projected.get(data);
    if (cached) return cached;
    let changed = false;
    const files = arrays.get(data.files) ?? data.files.map((file) => {
      if (!live) {
        const retained = lastTrustedRows.get(file) ?? file;
        changed ||= retained !== file;
        return retained;
      }
      const cachedRow = rows.get(file);
      if (cachedRow) {
        changed ||= cachedRow !== file;
        return cachedRow;
      }
      const status = file.conversationId ? byConversation.get(file.conversationId) : byPath.get(file.path);
      const provisional = file.path.startsWith("spawn:");
      const initialMessage = (file.spawn ?? file.launch)?.initialMessage;
      const pendingLaunch = initialMessage === "queued" || initialMessage === "pending";
      // Only the current generation gets the runtime's authority. Historical
      // paths and a launch still waiting to deliver its prompt keep their facts.
      if (!status || status.sessionKey.engine !== file.engine || (pendingLaunch && !status.observedTurn)
        || (!provisional && status.artifactPath !== file.path)) {
        rows.set(file, file);
        lastTrustedRows.set(file, file);
        return file;
      }
      // The runtime's running axis stays open across silent tools and can lag
      // a terminal transcript flush. Only settlement overlays the inventory:
      // a running axis cannot revive a completed or stalled scanner turn.
      const activity = Date.now() / 1000 - file.mtime < 900 ? "recent" : "idle";
      const next: FileEntry = {
        ...file,
        activity,
        activityReason: "runtime_turn_idle",
        authoritativeTurn: file.authoritativeTurn?.state === "terminal" ? file.authoritativeTurn
          : { state: "idle", source: "lifecycle", terminalAt: null },
        ...(!status.hasAttention ? { pendingQuestion: null, waitingInput: null } : {}),
      };
      rows.set(file, next);
      lastTrustedRows.set(file, next);
      changed = true;
      return next;
    });
    // Local task/pipeline overlays can allocate fresh wrappers around the same
    // files array. Preserve the projected rows/array independently of them.
    if (!arrays.has(data.files)) arrays.set(data.files, changed ? files : data.files);
    const projectedFiles = arrays.get(data.files)!;
    const result = projectedFiles !== data.files ? { ...data, files: projectedFiles } : data;
    projected.set(data, result);
    return result;
  };
  return Object.assign(project, { updateRuntime });
}
