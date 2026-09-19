import crypto from "node:crypto";

import { isTaskAttachment } from "./attachments";
import { taskRevision } from "./revision";
import { isoNow } from "./helpers";
import { countBoardTasks, taskShowsOnBoard } from "./boardVisibility";
import { admissionSnapshot } from "./groupHide";
import { assignmentAdmissionOrigin, assignmentIdentity, ensureTaskMembership, identityHeldBy, type MembershipIdentity } from "./membership";
import { TASK_COLORS, TASK_DETAILS_LIMIT, TASK_TEXT_LIMIT, type AssignmentRef, type BoardTask, type TaskAttachment, type TaskAssignment, type TaskBoardVisibility, type TaskColor, type TaskGroupHidden, type TaskSource, type TaskStatus } from "./types";

/* The caps live beside the type, which a client component can import without
   pulling this module's node dependencies into the browser bundle. */
export { TASK_DETAILS_LIMIT, TASK_TEXT_LIMIT } from "./types";
/**
 * How many bands one project's board may carry (#1627).
 *
 * A DISPLAY bound, and only that: it counts the tasks the board draws, never
 * the rows the task file stores. The stored list is a history — since #1614
 * every task that has nothing on the canvas keeps its row and its place in the
 * task list with `board: "hidden"` — and a history has no cap here, so a
 * project with hundreds of finished tasks can still take a new one. What is
 * bounded is the vertical stack of bands that made the board unusable in the
 * first place.
 *
 * The number is unchanged from the row cap it replaces.
 */
export const BOARD_TASKS_PER_PROJECT_LIMIT = 300;
/** How many recent create receipts are kept for `clientRequestId` replay. Sized
    to the double-tap / retry-after-timeout window; a replay older than the cap
    can mint a twin (documented, durability beyond the cap is deferred). */
export const RECENT_CREATES_CAP = 100;

export type TaskRefusal = { ok: false; error: string; status: number; code?: string; field?: string };

export type TaskCommandResult =
  | { ok: true; tasks: BoardTask[]; task: BoardTask }
  | TaskRefusal;

/** A `clientRequestId → taskId` receipt, persisted in `tasks.json` so a replay
    survives a server restart. Oldest entries evict past {@link RECENT_CREATES_CAP}. */
export interface RecentCreate {
  clientRequestId: string;
  taskId: string;
}

export type CreateTaskResult =
  | { ok: true; tasks: BoardTask[]; task: BoardTask; recentCreates: RecentCreate[]; replay: boolean }
  | TaskRefusal;

export interface CreateTaskInput {
  project?: unknown;
  text?: unknown;
  /** Agent-facing context, kept out of the human description (#1834). An
      absent or blank value creates a task with no details at all. */
  details?: unknown;
  placement?: unknown;
  pos?: unknown;
  dueAt?: unknown;
  dueTz?: unknown;
  attachments?: unknown;
  clientRequestId?: unknown;
  source?: unknown;
  /** Optional board membership of the new task's band. Omitted creates a task
      the board shows; `"hidden"` creates it off the board, which is how a
      caller records work while the board is full. */
  board?: unknown;
}

export interface PatchTaskInput {
  expectedProject?: unknown;
  expectedRevision?: unknown;
  text?: unknown;
  /** Agent-facing context (#1834). A string sets or replaces it; `null` or an
      empty string clears it. Omitted leaves it exactly as stored, so an update
      carrying only `details` never touches `text` and the reverse. */
  details?: unknown;
  status?: unknown;
  placement?: unknown;
  pos?: unknown;
  dueAt?: unknown;
  dueTz?: unknown;
  board?: unknown;
  /** One of `TASK_COLORS`, or "none" to clear the label. Leaves `updatedAt`
      unchanged when it is the whole patch (with `hide`). */
  color?: unknown;
  /** `true` hides the task's whole group from the kanban board, `false` shows
      it again. Requires the revision fence. Leaves `updatedAt` unchanged when
      it is the whole patch (with `color`). */
  hide?: unknown;
}

/** What a hide asks of the caller that can see the orchestrator seats: whether
    this task holds the project's seat conversation. `unknown` when the seat
    record cannot be read, which refuses the hide rather than guessing. */
export type SeatHolding = "holds" | "free" | "unknown";

export interface PatchTaskOptions {
  requirePlacementGuards?: boolean;
  hasBoardMembers?: (task: BoardTask) => boolean;
  /** Who is writing: the operator's dashboard or an agent's tool call. */
  actor?: TaskGroupHidden["by"];
  /** Required for `hide: true`; without it the hide is refused. */
  seatHolding?: (task: BoardTask) => SeatHolding;
}

/** Injected so the pure command can ask the store whether an attachment ref's
    bytes actually exist; defaults to "trust the ref" for unit tests. */
export interface TaskCommandDeps {
  now?: () => string;
  id?: () => string;
  attachmentExists?: (att: TaskAttachment) => boolean;
  /** Whether a hidden task still holds something the board draws — the answer
      only a caller that can see the resolved bands has. Defaults to "no", which
      counts exactly the bands the board was ASKED to draw; see
      {@link countBoardTasks} for why guessing it from stored rows is worse than
      not answering. */
  hasBoardMembers?: (task: BoardTask) => boolean;
}

/** The refusal both admission paths give when the board is full. */
function boardFullError(field: "board" | "project"): TaskRefusal {
  return {
    ok: false,
    error: `The board already shows ${BOARD_TASKS_PER_PROJECT_LIMIT} task bands for this project. Hide a band you no longer need, or keep this task off the board with board: "hidden".`,
    status: 409,
    code: "TASK_BOARD_FULL",
    field,
  };
}

export type SpawnEngine = "claude" | "codex";

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text : null;
}

function normalizeProject(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const project = value.trim();
  return project ? project : null;
}

function positionError(value: unknown): TaskRefusal {
  const pos = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const field = !pos ? "pos" : typeof pos.x !== "number" || !Number.isFinite(pos.x) ? "pos.x" : "pos.y";
  return { ok: false, error: `${field} must be ${field === "pos" ? "an object with finite x and y" : "a finite number"}`, status: 400, code: "TASK_INVALID_FIELD", field };
}

function normalizePos(value: unknown): { x: number; y: number } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const pos = value as { x?: unknown; y?: unknown };
  if (typeof pos.x !== "number" || !Number.isFinite(pos.x)) return null;
  if (typeof pos.y !== "number" || !Number.isFinite(pos.y)) return null;
  return { x: pos.x, y: pos.y };
}

function normalizeStatus(value: unknown): TaskStatus | null {
  return value === "inbox" || value === "assigned" || value === "blocked" || value === "done" ? value : null;
}

function normalizeColor(value: unknown): TaskColor | "none" | null {
  return value === "none" || (typeof value === "string" && (TASK_COLORS as readonly string[]).includes(value)) ? value as TaskColor | "none" : null;
}

function normalizeBoardVisibility(value: unknown): TaskBoardVisibility | null {
  return value === "shown" || value === "hidden" ? value : null;
}

/** Client-writable placement values; `auto` is server-reserved (#17). */
function normalizePlacement(value: unknown): "pinned" | "unplaced" | null {
  return value === "pinned" || value === "unplaced" ? value : null;
}

/** True when the IANA zone is one `Intl` accepts without throwing. */
function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

type DueResult = { ok: true; dueAt?: string; dueTz?: string } | { ok: false; error: string };

/** `dueAt`/`dueTz` are both-or-neither. `dueAt` must round-trip `Date.parse`
    and `dueTz` must be a real IANA zone. Returns the canonical UTC instant. */
function normalizeDue(dueAt: unknown, dueTz: unknown): DueResult {
  const hasAt = dueAt !== undefined && dueAt !== null;
  const hasTz = dueTz !== undefined && dueTz !== null;
  if (!hasAt && !hasTz) return { ok: true };
  if (hasAt !== hasTz) return { ok: false, error: "dueAt and dueTz must be set together" };
  if (typeof dueAt !== "string" || typeof dueTz !== "string") return { ok: false, error: "invalid deadline" };
  const parsed = Date.parse(dueAt);
  if (!Number.isFinite(parsed)) return { ok: false, error: "invalid dueAt" };
  if (!isValidTimeZone(dueTz)) return { ok: false, error: "invalid dueTz" };
  return { ok: true, dueAt: new Date(parsed).toISOString(), dueTz };
}

type AttachmentsResult = { ok: true; attachments?: TaskAttachment[] } | TaskRefusal;

function normalizeAttachments(value: unknown, exists: (att: TaskAttachment) => boolean): AttachmentsResult {
  if (value === undefined || value === null) return { ok: true };
  if (!Array.isArray(value)) return { ok: false, error: "invalid attachments", status: 400 };
  if (value.length === 0) return { ok: true };
  const attachments: TaskAttachment[] = [];
  for (const item of value) {
    if (!isTaskAttachment(item)) return { ok: false, error: "invalid attachment ref", status: 400 };
    if (!exists(item)) return { ok: false, error: "attachment not found in store", status: 400 };
    attachments.push(item);
  }
  return { ok: true, attachments };
}

function normalizeSource(value: unknown): TaskSource | undefined | null {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Partial<TaskSource>;
  if (typeof source.path !== "string" || !source.path.trim()) return null;
  if (source.ts !== null && typeof source.ts !== "string") return null;
  if (typeof source.text !== "string" || !source.text.trim()) return null;
  if (typeof source.fingerprint !== "string" || !source.fingerprint.trim()) return null;
  if (source.engine !== "claude" && source.engine !== "codex") return null;
  return {
    path: source.path,
    ts: source.ts,
    text: source.text,
    fingerprint: source.fingerprint,
    engine: source.engine,
  };
}

function textLimitError(): { ok: false; error: string; status: number } {
  return { ok: false, error: `Task text must be no longer than ${TASK_TEXT_LIMIT} characters`, status: 400 };
}

type DetailsResult = { ok: true; details?: string } | TaskRefusal;

/** Agent-facing `details` (#1834): a string is trimmed and capped, and a blank
    one is no details at all — the same value an absent field leaves. */
function normalizeDetails(value: unknown): DetailsResult {
  if (value === undefined || value === null) return { ok: true };
  if (typeof value !== "string") {
    return { ok: false, error: "details must be a string", status: 400, code: "TASK_INVALID_FIELD", field: "details" };
  }
  const details = value.trim();
  if (!details) return { ok: true };
  if (details.length > TASK_DETAILS_LIMIT) {
    return { ok: false, error: `Task details must be no longer than ${TASK_DETAILS_LIMIT} characters`, status: 400, code: "TASK_INVALID_FIELD", field: "details" };
  }
  return { ok: true, details };
}

export function createTask(
  existing: BoardTask[],
  input: CreateTaskInput,
  recentCreates: RecentCreate[] = [],
  deps: TaskCommandDeps = {},
): CreateTaskResult {
  const project = normalizeProject(input.project);
  if (!project) return { ok: false, error: "project is required", status: 400 };
  const text = normalizeText(input.text);
  if (!text) return { ok: false, error: "task text is required", status: 400 };
  if (text.length > TASK_TEXT_LIMIT) return textLimitError();
  const details = normalizeDetails(input.details);
  if (!details.ok) return details;

  /* Idempotency: a replayed create (double-tap, retry after a lost response)
     returns the task the first attempt made instead of minting a twin. */
  const clientRequestId = typeof input.clientRequestId === "string" && input.clientRequestId.trim() ? input.clientRequestId.trim() : null;
  if (clientRequestId) {
    const prior = recentCreates.find((entry) => entry.clientRequestId === clientRequestId);
    if (prior) {
      const task = existing.find((item) => item.id === prior.taskId);
      /* The task may have been deleted since; a replay then behaves as a fresh
         create rather than resurrecting a phantom. */
      if (task) return { ok: true, tasks: existing, task, recentCreates, replay: true };
    }
  }

  const pos = normalizePos(input.pos);
  if (Object.hasOwn(input, "pos") && !pos) return positionError(input.pos);
  /* Placement omitted stays back-compatible: a `pos` means `pinned`, none is an
     error (the legacy create path always sent a pos). */
  const placement = normalizePlacement(input.placement) ?? (pos ? "pinned" : null);
  if (input.placement !== undefined && placement === null) {
    return { ok: false, error: "invalid placement", status: 400 };
  }
  if (placement === "pinned" && !pos) return { ok: false, error: "task position is required", status: 400, code: "TASK_INVALID_FIELD", field: "pos" };
  if (placement === "unplaced" && pos) return { ok: false, error: "unplaced task must not carry a position", status: 400, code: "TASK_INVALID_FIELD", field: "pos" };
  if (placement === null) return { ok: false, error: "task position is required", status: 400, code: "TASK_INVALID_FIELD", field: "pos" };

  const due = normalizeDue(input.dueAt, input.dueTz);
  if (!due.ok) return { ok: false, error: due.error, status: 400 };
  const attachments = normalizeAttachments(input.attachments, deps.attachmentExists ?? (() => true));
  if (!attachments.ok) return attachments;

  const source = normalizeSource(input.source);
  if (source === null) return { ok: false, error: "invalid task source", status: 400 };

  const board = Object.hasOwn(input, "board") ? normalizeBoardVisibility(input.board) : undefined;
  if (board === null) return { ok: false, error: "invalid board visibility", status: 400, code: "TASK_INVALID_FIELD", field: "board" };
  /* The bound is on bands, so only a task that will occupy one is counted
     against it: a task created off the board joins the history, which has no
     cap, and no durable identity is ever refused to keep a display small. */
  if (board !== "hidden" && countBoardTasks(existing, project, deps.hasBoardMembers ?? (() => false)) >= BOARD_TASKS_PER_PROJECT_LIMIT) {
    return boardFullError("project");
  }

  const now = deps.now?.() ?? isoNow();
  const id = deps.id?.() ?? crypto.randomUUID();
  const task: BoardTask = {
    id,
    project,
    status: "inbox",
    text,
    ...(details.details ? { details: details.details } : {}),
    placement,
    ...(placement === "pinned" && pos ? { pos } : {}),
    ...(due.dueAt ? { dueAt: due.dueAt, dueTz: due.dueTz } : {}),
    ...(attachments.attachments ? { attachments: attachments.attachments } : {}),
    ...(source ? { source } : {}),
    ...(board ? { board } : {}),
    assignments: [],
    createdAt: now,
    updatedAt: now,
  };
  const nextRecent = clientRequestId
    ? [...recentCreates, { clientRequestId, taskId: id }].slice(-RECENT_CREATES_CAP)
    : recentCreates;
  return { ok: true, tasks: [...existing, task], task, recentCreates: nextRecent, replay: false };
}

export function patchTask(existing: BoardTask[], id: string, input: PatchTaskInput, now = isoNow(), options: PatchTaskOptions = {}): TaskCommandResult {
  const index = existing.findIndex((task) => task.id === id);
  if (index < 0) return { ok: false, error: "task not found", status: 404 };
  const task = existing[index]!;
  /* A group hide is fenced on both surfaces: it is decided against the group
     the caller saw, and a group that changed since is the caller's to re-read. */
  const guardRequired = (options.requirePlacementGuards && (Object.hasOwn(input, "pos") || Object.hasOwn(input, "placement")))
    || Object.hasOwn(input, "hide");
  if (guardRequired || Object.hasOwn(input, "expectedProject") || Object.hasOwn(input, "expectedRevision")) {
    for (const field of ["expectedProject", "expectedRevision"] as const) {
      if (typeof input[field] !== "string" || !input[field].trim()) {
        return { ok: false, status: 400, code: "TASK_INVALID_FIELD", field, error: `${field} must be a non-empty string copied from the current task` };
      }
    }
    if (input.expectedProject !== task.project) {
      return { ok: false, status: 409, code: "TASK_PROJECT_MISMATCH", field: "expectedProject", error: "expectedProject does not match the current task project; read the task and reconsider the request" };
    }
    if (input.expectedRevision !== taskRevision(task)) {
      return { ok: false, status: 409, code: "TASK_REVISION_MISMATCH", field: "expectedRevision", error: "expectedRevision is stale; read the task and reconsider the request" };
    }
  }
  const patch: Partial<BoardTask> = {};

  if (Object.hasOwn(input, "text")) {
    const text = normalizeText(input.text);
    if (!text) return { ok: false, error: "task text is required", status: 400 };
    if (text.length > TASK_TEXT_LIMIT) return textLimitError();
    patch.text = text;
    /* An operator's edit names a placeholder for good: a later agent
       refinement returns "already named" instead of overwriting it (#1586). */
    if (existing[index]!.origin?.refinement === "pending" && text !== existing[index]!.text) {
      patch.origin = { ...existing[index]!.origin!, refinement: "titled" };
    }
  }
  /* Its own field, so it is set, replaced and cleared on its own: a patch
     carrying only `details` leaves `text` byte for byte, and a patch carrying
     only `text` leaves `details` (#1834). */
  if (Object.hasOwn(input, "details")) {
    const details = normalizeDetails(input.details);
    if (!details.ok) return details;
    patch.details = details.details;
  }
  if (Object.hasOwn(input, "status")) {
    const status = normalizeStatus(input.status);
    if (!status) return { ok: false, error: "invalid task status", status: 400 };
    patch.status = status;
  }
  if (Object.hasOwn(input, "pos")) {
    const pos = normalizePos(input.pos);
    if (!pos) return positionError(input.pos);
    /* A pos always pins: place-on-map and free drags both land here, so an
       unplaced task that gets a position becomes pinned in the same PATCH, and
       the collision pass then leaves it exactly where the user dropped it. */
    patch.pos = pos;
    patch.placement = "pinned";
  }
  /* Board membership of the band. Reversible either way, never a delete: the
     task keeps its row, its assignments and its place in the task list. */
  if (Object.hasOwn(input, "board")) {
    const board = normalizeBoardVisibility(input.board);
    if (!board) return { ok: false, error: "invalid board visibility", status: 400, code: "TASK_INVALID_FIELD", field: "board" };
    /* Restoring a band is the board's other admission (#1627), so it answers to
       the same bound as a create — otherwise the cap would only ever move a
       task's growth from one control to the other. A task that already occupies
       a band takes no new slot, so re-asserting `shown` is never refused, and
       neither is hiding one; and because the count is taken from the snapshot
       this call was handed, the serialized read-modify-write around it (see
       `mutateTasks`) is what stops two writers taking the last slot at once. */
    const hasMembers = options.hasBoardMembers ?? (() => false);
    if (board === "shown" && !taskShowsOnBoard(task, hasMembers(task))
      && countBoardTasks(existing, task.project, hasMembers) >= BOARD_TASKS_PER_PROJECT_LIMIT) {
      return boardFullError("board");
    }
    patch.board = board;
  }
  if (Object.hasOwn(input, "color")) {
    const color = normalizeColor(input.color);
    if (!color) return { ok: false, error: `color must be one of none, ${TASK_COLORS.join(", ")}`, status: 400, code: "TASK_INVALID_FIELD", field: "color" };
    patch.color = color === "none" ? undefined : color;
  }
  /* Hiding a group writes the hide and nothing else: no assignment, runtime,
     pipeline, flow, delivery or process state is touched, by design. */
  if (Object.hasOwn(input, "hide")) {
    if (input.hide !== true && input.hide !== false) return { ok: false, error: "hide must be true or false", status: 400, code: "TASK_INVALID_FIELD", field: "hide" };
    if (input.hide) {
      const holding = options.seatHolding ? options.seatHolding(task) : "unknown";
      if (holding === "holds") {
        return { ok: false, status: 409, code: "TASK_HIDE_PROTECTED", field: "hide", error: "this task holds the project's orchestrator seat conversation, which stays on the board; it cannot be hidden" };
      }
      if (holding === "unknown") {
        return { ok: false, status: 503, code: "TASK_HIDE_UNVERIFIED", field: "hide", error: "the orchestrator seat record could not be read, so the hide was not applied; try again" };
      }
      patch.groupHidden = { at: now, by: options.actor ?? "operator", admitted: admissionSnapshot(task.assignments) };
    } else {
      patch.groupHidden = undefined;
    }
  }
  if (Object.hasOwn(input, "placement")) {
    const placement = normalizePlacement(input.placement);
    if (!placement) return { ok: false, error: "invalid placement", status: 400 };
    /* Pinned needs a position: either supplied in this PATCH or already held. */
    if (placement === "pinned" && !patch.pos && !task.pos) {
      return { ok: false, error: "task position is required", status: 400, code: "TASK_INVALID_FIELD", field: "pos" };
    }
    patch.placement = placement;
  }
  /* Deadline: `{dueAt:null}` clears both fields; `{dueAt,dueTz}` sets them
     (both-or-neither, validated). Touching only one is a 400. */
  if (Object.hasOwn(input, "dueAt") || Object.hasOwn(input, "dueTz")) {
    if (input.dueAt === null && input.dueTz === undefined) {
      patch.dueAt = undefined;
      patch.dueTz = undefined;
    } else {
      const due = normalizeDue(input.dueAt, input.dueTz);
      if (!due.ok) return { ok: false, error: due.error, status: 400 };
      patch.dueAt = due.dueAt;
      patch.dueTz = due.dueTz;
    }
  }

  /* A colour label or a group hide is presentation of the task, never work on
     it: `updatedAt` stays, so the board's ranking and age and the seat tick's
     reading of card movement (its quiet guard, its "assigned, nothing started
     it" window) are unchanged by them. The revision still moves, because it
     hashes every field, so the fence and board freshness keep working, and a
     hide records its own instant in `groupHidden.at`. */
  const presentationOnly = Object.keys(input).every((key) => key === "color" || key === "hide" || key === "expectedProject" || key === "expectedRevision")
    && (Object.hasOwn(input, "color") || Object.hasOwn(input, "hide"));
  const updated: BoardTask = { ...task, ...patch, updatedAt: presentationOnly ? task.updatedAt : now };
  /* An explicit clear leaves `undefined` fields on the spread; drop them so the
     persisted row and its validator agree that the deadline is gone. */
  if (Object.hasOwn(patch, "dueAt") && patch.dueAt === undefined) {
    delete updated.dueAt;
    delete updated.dueTz;
  }
  if (updated.placement === "unplaced") delete updated.pos;
  if (Object.hasOwn(patch, "details") && patch.details === undefined) delete updated.details;
  if (Object.hasOwn(patch, "color") && patch.color === undefined) delete updated.color;
  if (Object.hasOwn(patch, "groupHidden") && patch.groupHidden === undefined) delete updated.groupHidden;
  const tasks = existing.slice();
  tasks[index] = updated;
  return { ok: true, tasks, task: updated };
}

export interface MembershipDeps {
  now?: () => string;
  id?: () => string;
}

/**
 * The conversations of `removed` rows that no remaining task still records,
 * each bound to a replacement placeholder in the same snapshot (#1586): every
 * board conversation belongs to a task, and unlinking or deleting must not
 * leave one outside every task between two writes. The replacement carries the
 * row's admission origin (its launch key, else the conversation), so a replay
 * of that launch converges on the replacement. `forbid` names the task a
 * replacement may not resolve to, which is the very task the row leaves.
 */
function replaceLostMemberships(
  tasks: BoardTask[],
  project: string,
  removed: readonly TaskAssignment[],
  forbid: string | null,
  deps: MembershipDeps,
): { ok: true; tasks: BoardTask[]; replacements: string[] } | TaskRefusal {
  let current = tasks;
  const replacements: string[] = [];
  for (const assignment of removed) {
    if (assignment.state === "failed") continue;
    const identity: MembershipIdentity | null = assignmentIdentity(assignment);
    const origin = assignmentAdmissionOrigin(assignment);
    if (!identity || !origin || identityHeldBy(current, identity)) continue;
    const result = ensureTaskMembership(current, { project, origin, identity }, deps);
    if (!result.ok) return result;
    if (forbid && result.taskIds.includes(forbid)) {
      return { ok: false, error: "this task is the conversation's own membership; link the conversation to another task first or delete the task", status: 409 };
    }
    current = result.tasks;
    replacements.push(...result.created);
  }
  return { ok: true, tasks: current, replacements };
}

/** Deletes a task. Conversations whose only membership it held are bound to
    replacement placeholders in the same snapshot; nothing is left unbound. */
export function deleteTask(existing: BoardTask[], id: string, deps: MembershipDeps = {}): { ok: true; tasks: BoardTask[]; replacements: string[] } | TaskRefusal {
  const task = existing.find((candidate) => candidate.id === id);
  if (!task) return { ok: false, error: "task not found", status: 404 };
  const tasks = existing.filter((candidate) => candidate.id !== id);
  return replaceLostMemberships(tasks, task.project, task.assignments, null, deps);
}

/** Parse a usable assignment handle from the DELETE request body. */
export function assignmentRefFromBody(body: unknown): AssignmentRef | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as { launchId?: unknown; path?: unknown; conversationId?: unknown; panePid?: unknown };
  const ref: AssignmentRef = {};
  if (typeof record.launchId === "string" && record.launchId.trim()) ref.launchId = record.launchId.trim();
  if (typeof record.path === "string" && record.path.trim()) ref.path = record.path.trim();
  if (typeof record.conversationId === "string" && record.conversationId.trim()) {
    ref.conversationId = record.conversationId.trim();
  }
  if (typeof record.panePid === "number" && Number.isInteger(record.panePid) && record.panePid > 0) {
    ref.panePid = record.panePid;
  }
  return ref.launchId != null || ref.conversationId != null || ref.path != null || ref.panePid != null ? ref : null;
}

function assignmentMatchesRef(assignment: TaskAssignment, ref: AssignmentRef): boolean {
  /* The launch id predates any transcript path or conversation attribution, so
     it outranks the other handles — a pathless spawning assignment (no path,
     no conversation id, no pane) is only reachable through it. */
  if (ref.launchId != null) return assignment.launchId === ref.launchId;
  if (ref.conversationId != null) return assignment.conversationId === ref.conversationId;
  if (ref.path != null) return assignment.path === ref.path;
  if (ref.panePid != null) return assignment.panePid === ref.panePid;
  return false;
}

/**
 * Detach one assignment through its strongest available identity. A string
 * keeps the original path-based interface. An unmatched handle succeeds and
 * leaves the task object unchanged, which makes repeated recovery safe. When
 * the detached row was the conversation's last membership, a replacement
 * placeholder is bound in the same snapshot; detaching a conversation from the
 * placeholder that is its own admission is refused, because the replacement
 * would be that task again.
 */
export function removeAssignment(existing: BoardTask[], id: string, handle: string | AssignmentRef, now = isoNow(), deps: MembershipDeps = {}): TaskCommandResult {
  const index = existing.findIndex((task) => task.id === id);
  if (index < 0) return { ok: false, error: "task not found", status: 404 };
  const ref: AssignmentRef = typeof handle === "string" ? { path: handle } : handle;
  const task = existing[index]!;
  const assignments = task.assignments.filter((assignment) => !assignmentMatchesRef(assignment, ref));
  if (assignments.length === task.assignments.length) return { ok: true, tasks: existing, task };
  const removed = task.assignments.filter((assignment) => assignmentMatchesRef(assignment, ref));
  const updated: BoardTask = { ...task, assignments, updatedAt: now };
  const tasks = existing.slice();
  tasks[index] = updated;
  const replaced = replaceLostMemberships(tasks, task.project, removed, id, { now: () => now, ...deps });
  if (!replaced.ok) return replaced;
  return { ok: true, tasks: replaced.tasks, task: updated };
}

export interface AssignmentPatch {
  launchId?: string | null;
  clientAttemptId?: string | null;
  conversationId?: string | null;
  path: string | null;
  panePid: number | null;
  state: TaskAssignment["state"];
  error: string | null;
  at: string;
  accountId?: string | null;
  engine?: "claude" | "codex" | null;
}

/** A task can own the same textual account id once per engine. */
export function pinnedAccountId(assignments: TaskAssignment[], engine: "claude" | "codex"): string | null {
  return assignments.find((assignment) => assignment.engine === engine && typeof assignment.accountId === "string")?.accountId ?? null;
}

export function mergeAssignments(assignments: TaskAssignment[], patches: AssignmentPatch[]): TaskAssignment[] {
  let next = assignments.slice();
  for (const patch of patches) {
    const index = next.findIndex((assignment) => {
      if (patch.launchId && assignment.launchId) return assignment.launchId === patch.launchId;
      if (patch.path !== null && assignment.path === patch.path) return true;
      return patch.path === null && patch.panePid !== null && assignment.path === null && assignment.panePid === patch.panePid;
      });
    const previous = index >= 0 ? next[index] : undefined;
    const launchId = patch.launchId !== undefined ? patch.launchId : previous?.launchId;
    const clientAttemptId = patch.clientAttemptId !== undefined ? patch.clientAttemptId : previous?.clientAttemptId;
    const conversationId = patch.conversationId !== undefined ? patch.conversationId : previous?.conversationId;
    const merged: TaskAssignment = {
      ...(launchId !== undefined ? { launchId } : {}),
      ...(clientAttemptId !== undefined ? { clientAttemptId } : {}),
      path: patch.path,
      ...(conversationId !== undefined ? { conversationId } : {}),
      panePid: patch.panePid,
      state: patch.state,
      error: patch.error,
      at: patch.at,
      ...(patch.accountId !== undefined ? { accountId: patch.accountId } : {}),
      ...(patch.engine !== undefined ? { engine: patch.engine } : {}),
    };
    if (index >= 0) {
      next = [...next.slice(0, index), merged, ...next.slice(index + 1)];
    } else {
      next = [...next, merged];
    }
  }
  return next;
}

export function applyAssignmentPatches(
  existing: BoardTask[],
  id: string,
  patches: AssignmentPatch[],
  now = isoNow(),
): TaskCommandResult {
  const index = existing.findIndex((task) => task.id === id);
  if (index < 0) return { ok: false, error: "task not found", status: 404 };
  const task = existing[index]!;
  const assignments = mergeAssignments(task.assignments, patches);
  const hasOwner = assignments.some(
    (assignment) => assignment.state === "delivered" || assignment.state === "spawning" || assignment.state === "handoff" || assignment.state === "linked",
  );
  let status = task.status;
  if (status === "inbox" || status === "assigned") {
    status = hasOwner ? "assigned" : "inbox";
  }
  const updated: BoardTask = {
    ...task,
    status,
    assignments,
    updatedAt: now,
  };
  const tasks = existing.slice();
  tasks[index] = updated;
  return { ok: true, tasks, task: updated };
}
