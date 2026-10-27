import { frameWasRead } from "@/lib/attention/frames";
import { navigableAnchorKeys, resolveFocusTarget, type FocusFrameIndex } from "@/lib/attention/resolve";
import { focusTargetAnchorKeys, isGeometricTarget } from "@/lib/attention/targets";
import type { FocusTarget } from "@/lib/attention/types";
import type { AttentionRequestV1, FocusFrame, FocusResolutionKind, ReturnPoint } from "@/lib/attention/types";

import type { FocusDestination, FocusHandoffBus } from "./focusHandoffBus";

/**
 * What an accepted request actually does to the view (#688 D7/D8).
 *
 * The whole move is one function of a request and a bus, so the part that is
 * easy to get wrong — which project, which frame, and what happens when the
 * anchor is gone — is testable without a renderer or a camera.
 *
 * Two rules from the design are enforced here rather than left to the caller:
 *
 * - the anchor is resolved against the CURRENT layout, never the stored rect,
 *   because the board reflows and a rect recorded at creation is stale as soon
 *   as a sibling appears. The stored frame is the destination only when the
 *   anchor itself has vanished;
 * - a frame that was never really read is not a destination. A request raised
 *   through the agent's tool has no board geometry to record, so it carries a
 *   zero-area frame; degrading to it would drop the operator at the world
 *   origin, which is precisely the "somewhere arbitrary" the design forbids.
 *   Such a frame is discarded, and the resolution reports `lost` instead.
 */

/** How long a handoff waits for another project's board to publish its layout
    after the shell was asked to open it. */
export const BOARD_WAIT_MS = 4_000;
const BOARD_POLL_MS = 40;

/** Zoom the camera reaches for when the operator is about to READ the target. */
export const INSPECT_ZOOM = 0.9;

export interface FocusHandoffResult {
  resolution: FocusResolutionKind;
  /** Whether the view was actually asked to move. False for `lost`. */
  moved: boolean;
  frame: FocusFrame | null;
  /** The destination the board was asked to take, when it was asked. */
  destination?: FocusDestination;
  /** True when the transaction's signal ended it early. Nothing may be posted
      about an aborted move — the record is closed by the server's own bounded
      deadline, not by a report from a tab that stopped mid-flight. */
  aborted?: boolean;
}

export interface HandoffTiming {
  timeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** What the transaction can OBSERVE about the live view, read from the same
    bus presence publishes from. The camera's world rect is the ground truth of
    "the operator is looking at the frame"; `focusedPath` short-circuits the
    wait when the target's own surface has opened. */
export interface FocusObservation {
  camera: { x: number; y: number; zoom: number; worldRect?: { x: number; y: number; width: number; height: number } } | null;
  focusedPath: string | null;
}

export interface FocusTransactionOptions extends HandoffTiming {
  signal?: AbortSignal;
  /** The live-view reader. The production host passes the view bus; tests pass
      a scripted observer. Absent, the settle wait is skipped (a harness with
      no observable camera has nothing to await). */
  observe?: () => FocusObservation;
  /** True when this tab already claimed this handoff once (a remount picking
      an interrupted move back up). A resume whose view ALREADY shows the frame
      re-issues nothing — the one navigation already happened; what is owed is
      only the arrival report. */
  resume?: boolean;
}

const wait = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/** The project a request lands in. A geometric target names its own; every
    object anchor is found in whichever project's layout holds it, so the frame
    recorded at creation is what says where to look. */
export function focusHandoffProject(request: Pick<AttentionRequestV1, "target" | "frameAtCreation">): string {
  return isGeometricTarget(request.target) ? request.target.project : request.frameAtCreation.project;
}

/**
 * The stored frame, but only when it is a real reading of a board.
 *
 * See the module note: a degenerate rect is the signature of a request raised
 * without a board in front of it, and standing in for a vanished anchor with it
 * would land the operator nowhere in particular.
 */
export function usableFrame(frame: FocusFrame | null | undefined): FocusFrame | null {
  return frameWasRead(frame) ? frame! : null;
}

/**
 * The anchor's keys that the board actually holds, in preference order. Empty
 * when the landing has no object behind it at all.
 *
 * Resolved through the index rather than filtered by it, so an aliased anchor
 * arrives as the key the board is DRAWING and not only as the one the request
 * asked for. A launched or retried pipeline stage is exactly that case: the
 * request names its slot, the board has long since replaced that slot with the
 * running agent's card, and a phone handed only the slot key concludes the
 * stage is gone while it is on screen in front of the operator.
 */
function presentAnchorKeys(target: FocusTarget | null, index: FocusFrameIndex): string[] {
  if (!target || isGeometricTarget(target)) return [];
  return navigableAnchorKeys(index, focusTargetAnchorKeys(target));
}

/** The destination a board is handed. A board that measures its own arrival
    also learns the intent and the conversation, because opening a reader is
    how it arrives; a camera frames the same rect either way. */
function destinationFor(
  request: Pick<AttentionRequestV1, "target" | "intent" | "zoom"> & { id?: string },
  resolved: ReturnType<typeof resolveFocusTarget>,
  frame: FocusFrame,
  board: NonNullable<ReturnType<FocusHandoffBus["board"]>>,
): FocusDestination {
  const destination: FocusDestination = {
    rect: frame.rect,
    zoom: request.zoom,
    anchorKeys: presentAnchorKeys(resolved.degraded ? null : resolved.target, board.index),
  };
  if (!board.arrival) return destination;
  return {
    ...destination,
    intent: request.intent,
    path: request.target.kind === "conversation" ? request.target.path : null,
    ...(request.id ? { requestId: request.id } : {}),
  };
}

async function boardForProject(bus: FocusHandoffBus, project: string, timing: HandoffTiming) {
  return waitForBoard(bus, timing, (board) => board.project === project);
}

async function waitForBoard(
  bus: FocusHandoffBus,
  timing: HandoffTiming,
  ready: (board: NonNullable<ReturnType<FocusHandoffBus["board"]>>) => boolean,
) {
  const timeoutMs = timing.timeoutMs ?? BOARD_WAIT_MS;
  const pollMs = timing.pollMs ?? BOARD_POLL_MS;
  const sleep = timing.sleep ?? wait;
  const now = timing.now ?? (() => Date.now());
  const deadline = now() + timeoutMs;
  for (;;) {
    const board = bus.board();
    if (board && ready(board)) return board;
    if (now() >= deadline) return null;
    await sleep(pollMs);
  }
}

/**
 * Move the operator's view to an accepted request's target.
 *
 * The caller has already captured where they were leaving from — that has to
 * happen before this runs, because opening another project moves the view on
 * its own.
 */
export async function runFocusHandoff(
  request: Pick<AttentionRequestV1, "target" | "frameAtCreation" | "intent" | "zoom"> & { id?: string },
  bus: FocusHandoffBus,
  timing: HandoffTiming = {},
): Promise<FocusHandoffResult> {
  const project = focusHandoffProject(request);
  const shell = bus.shell();
  /* EVERY conversation handoff is ONE gesture, so it must leave ONE history
     entry (issue #866, both rounds): the project applies quietly here — early,
     because the target board has to publish before the resolution below can
     run — and the single entry is the transaction's verified-arrival record
     (which, for `open`, the quiet open coalesces with). Letting `openProject`
     record its own project navigation under that entry would make Back a
     two-press traversal through a state that was never a gesture. A handoff
     with no conversation behind it stays a lone project switch and records
     as before. */
  const conversationHandoff = request.target.kind === "conversation";
  if (shell && shell.project !== project) {
    if (conversationHandoff) shell.openConversation(project, null);
    else shell.openProject(project);
  }

  let board = await boardForProject(bus, project, timing);
  let resolved = resolveFocusTarget(request.target, usableFrame(request.frameAtCreation), board?.index ?? null);

  /* Last resort for a conversation the board is not showing: ASK for it.
     This places a card the board would otherwise leave out — one folded away,
     or one that has not entered this layout at all. Until this existed, a
     request raised through the agent's tool (which carries no frame, so the
     anchor is the whole of the resolution) was reported `lost` for a
     conversation the shell could have put on screen in a hundred milliseconds,
     and the operator saw nothing move and got no way back. Tried only after a
     plain resolution failed, so nothing that already worked changes, and
     bounded by the same wait as everything else here.

     `placePath`, NOT `openPath`: the recovery wants the card in the layout, and
     nothing else. `openPath` would also arm the board's pending-focus channel,
     which glides the camera on its own — so the handoff's own `moveTo` below
     became the SECOND move of two, at a different zoom, each fighting the
     other for the same camera. The operator saw the view arrive somewhere and
     then slide off it. Placement here, navigation once, further down. */
  /* A lane the server has admitted and this board has not drawn yet (#1836).
     The record behind it is pushed to the client WITH the request and layered
     into the board's data layer by the poll that delivered it, so what is owed
     here is only the moment it takes React to render the new card and republish
     the index. Waiting for the ANCHOR rather than for the board is the whole
     change: a board was always there within milliseconds, answered "I do not
     hold that key", and the request was closed as lost while the server knew
     perfectly well the pipeline existed.

     Bounded by the same wait as everything else here, so a target that truly
     does not exist still reports `lost` well inside the landing grace — which
     is what keeps TARGET_LOST meaning "there is no such thing". */
  if (board && resolved.resolution === "lost" && !isGeometricTarget(request.target) && request.target.kind !== "conversation") {
    const keys = focusTargetAnchorKeys(request.target);
    board = await waitForBoard(
      bus,
      timing,
      (candidate) => candidate.project === project && keys.some((key) => candidate.index.rectFor(key) !== null),
    ) ?? board;
    resolved = resolveFocusTarget(request.target, usableFrame(request.frameAtCreation), board.index);
  }

  let asked = false;
  if (board && resolved.resolution === "lost" && request.target.kind === "conversation" && shell) {
    const wanted = request.target.path;
    shell.placePath(wanted);
    asked = true;
    board = await waitForBoard(bus, timing, (candidate) => candidate.project === project && candidate.index.rectFor(wanted) !== null)
      ?? board;
    resolved = resolveFocusTarget(request.target, usableFrame(request.frameAtCreation), board.index);
  }

  if (!board || !resolved.frame || resolved.resolution === "lost") {
    /* Nowhere to land. Nothing moves, and the caller reports `lost` to the
       record rather than pretending the operator arrived somewhere. */
    return { resolution: "lost", moved: false, frame: null };
  }

  const destination = destinationFor(request, resolved, resolved.frame, board);
  const moved = board.moveTo(destination);
  /* A surface that cannot go there has not gone there. The phone shows one pane
     at a time and has no camera, so "where that card used to be" is not
     somewhere it can take anyone — and saying so is better than a card that
     claims the operator arrived. */
  if (!moved) return { resolution: "lost", moved: false, frame: null };
  /* `open` also opens the target's own surface; `show` frames it and stops
     there. Only a conversation has a surface to open — a geometric target is
     refused the intent at creation, and the rest are board objects the frame
     itself puts on screen. QUIETLY: `moveTo` above is this handoff's one and
     only camera move, so the open contributes the card and the history entry
     and never a second glide. A navigator without the quiet half gets
     `placePath` — materialization without the competing move — rather than
     the gliding `openPath` this used to race against. */
  if (request.intent === "open" && request.target.kind === "conversation" && shell) {
    if (shell.openPathQuiet) shell.openPathQuiet(request.target.path);
    else if (!asked) shell.placePath(request.target.path);
  }
  return { resolution: resolved.resolution, moved: true, frame: resolved.frame, destination };
}

/**
 * What a camera-less board's own page says about an arrival, as the resolution
 * the record takes, or null while it has not happened (#1695).
 *
 * An `open` of a conversation is its reader, and nothing less: a card on screen
 * with the reader still loading has not put the conversation in front of the
 * operator. Everything else arrives when its card is on screen, keeping the
 * resolution the anchor itself resolved to.
 */
function structuralResolution(
  request: Pick<AttentionRequestV1, "target" | "intent">,
  observed: "reader" | "visible" | null,
  resolved: FocusResolutionKind,
): FocusResolutionKind | null {
  if (observed === null) return null;
  if (request.intent === "open" && request.target.kind === "conversation") return observed === "reader" ? "reader" : null;
  return resolved;
}

/** Two camera readings that describe the same place. */
function sameObservedCamera(
  left: FocusObservation["camera"],
  right: FocusObservation["camera"],
): boolean {
  return left !== null && right !== null
    && Math.abs(left.x - right.x) < 0.5 && Math.abs(left.y - right.y) < 0.5
    && Math.abs(left.zoom - right.zoom) < 0.005;
}

/** Whether the observed camera is actually AT the frame: its world rect covers
    the frame's center. Only a camera carrying its world rect can be judged —
    without one there is no geometry to verify against, and the caller falls
    back to waiting for the glide to stop moving. */
function cameraAtFrame(camera: FocusObservation["camera"], frame: FocusFrame): boolean {
  const world = camera?.worldRect;
  if (!world) return false;
  const centerX = frame.rect.x + frame.rect.w / 2;
  const centerY = frame.rect.y + frame.rect.h / 2;
  return centerX >= world.x && centerX <= world.x + world.width
    && centerY >= world.y && centerY <= world.y + world.height;
}

/**
 * One abortable focus transaction (#873 review, finding 4): the move, and the
 * OBSERVED postcondition the arrival report stands on.
 *
 * `board.moveTo` starts a glide; it does not finish one. Posting the arrival
 * the moment it returned wrote "the operator is looking at it" while the
 * camera was still seconds away — and a tab closed mid-glide had already told
 * the record it landed. So the transaction waits until the live view actually
 * shows the frame (camera world rect covering the frame's center, stable
 * across two consecutive readings, or the target's own surface focused) and
 * only then returns a result the caller may report. The signal ends it at any
 * step: an aborted transaction reports `aborted` and the caller posts
 * NOTHING — the server's own bounded deadline closes the record honestly.
 *
 * The settled arrival is also where the gesture enters focus history (#866
 * production regression): every successful conversation-target handoff —
 * `show` exactly as `open` — records ONE typed same-document entry through
 * the shell, and only here. `show` used to move the camera and record
 * nothing, so the next Back left the in-app stack, crossed the document
 * boundary and terminated the active voice conversation. Recording at this
 * one exit keeps the invariant structural: a lost or aborted transaction
 * records nothing (nothing verified an arrival — the resume owes the entry
 * later), a replayed request never reaches a second transaction, and the
 * history layer's own coalescing (`decideFocusAction`) absorbs the `open`
 * path's quiet-open record beside it.
 */
export async function runFocusTransaction(
  request: Pick<AttentionRequestV1, "target" | "frameAtCreation" | "intent" | "zoom"> & { id?: string },
  bus: FocusHandoffBus,
  options: FocusTransactionOptions = {},
): Promise<FocusHandoffResult> {
  const result = await settleFocusTransaction(request, bus, options);
  if (result.moved && result.aborted !== true && request.target.kind === "conversation") {
    bus.shell()?.recordFocusArrival?.(request.target.path, focusHandoffProject(request));
  }
  return result;
}

/** The move and the observed-postcondition wait, without the arrival record —
    see `runFocusTransaction`, whose one exit owns that record. */
async function settleFocusTransaction(
  request: Pick<AttentionRequestV1, "target" | "frameAtCreation" | "intent" | "zoom"> & { id?: string },
  bus: FocusHandoffBus,
  options: FocusTransactionOptions,
): Promise<FocusHandoffResult> {
  const aborted = (): boolean => options.signal?.aborted === true;
  if (aborted()) return { resolution: "lost", moved: false, frame: null, aborted: true };

  /* A resumed handoff whose camera is already showing the frame owes only the
     report: re-running the move would re-glide a camera that has landed and,
     for `open`, re-record the gesture in history. Resolved against the live
     board exactly as the move itself would resolve it. */
  if (options.resume) {
    const board = bus.board();
    if (board?.arrival && board.project === focusHandoffProject(request)) {
      const resolved = resolveFocusTarget(request.target, usableFrame(request.frameAtCreation), board.index);
      if (resolved.frame && resolved.resolution !== "lost") {
        const destination = destinationFor(request, resolved, resolved.frame, board);
        const already = structuralResolution(request, board.arrival(destination), resolved.resolution);
        if (already) return { resolution: already, moved: true, frame: resolved.frame, destination };
      }
    }
  }
  if (options.resume && options.observe) {
    const board = bus.board();
    if (board && board.project === focusHandoffProject(request)) {
      const resolved = resolveFocusTarget(request.target, usableFrame(request.frameAtCreation), board.index);
      if (resolved.frame && resolved.resolution !== "lost" && cameraAtFrame(options.observe().camera, resolved.frame)) {
        return { resolution: resolved.resolution, moved: true, frame: resolved.frame };
      }
    }
  }

  const result = await runFocusHandoff(request, bus, options);
  if (aborted()) return { ...result, aborted: true };
  if (!result.moved || !result.frame) return result;

  const pollMs = options.pollMs ?? BOARD_POLL_MS;
  const sleep = options.sleep ?? wait;
  const now = options.now ?? (() => Date.now());
  const deadline = now() + (options.timeoutMs ?? BOARD_WAIT_MS);

  /* A board that measures its own page is the only witness to its arrival:
     it has no camera to watch, and a focused path there means a reader was
     opened, not that it is on screen with its transcript settled. */
  const measuring = bus.board();
  if (measuring?.arrival && result.destination && measuring.project === focusHandoffProject(request)) {
    const destination = result.destination;
    for (;;) {
      const board = bus.board();
      const arrived = board?.arrival && board.project === measuring.project
        ? structuralResolution(request, board.arrival(destination), result.resolution)
        : null;
      if (arrived) return { ...result, resolution: arrived };
      if (aborted()) return { ...result, aborted: true };
      if (now() >= deadline) return { resolution: "lost", moved: false, frame: null };
      await sleep(pollMs);
    }
  }
  if (!options.observe) return result;
  const openedPath = request.intent === "open" && request.target.kind === "conversation" ? request.target.path : null;

  let previous: FocusObservation["camera"] = null;
  for (;;) {
    const observed = options.observe();
    if (openedPath !== null && observed.focusedPath === openedPath) return result;
    if (observed.camera) {
      /* A camera that carries its world rect is judged geometrically: the
         frame's center is on screen. One without (a mode presence forbids a
         camera's geometry in) can only be watched until the glide stops. */
      if (observed.camera.worldRect) {
        if (cameraAtFrame(observed.camera, result.frame)) return result;
      } else if (sameObservedCamera(previous, observed.camera)) {
        return result;
      }
    }
    previous = observed.camera;
    if (aborted()) return { ...result, aborted: true };
    if (now() >= deadline) {
      /* The surface agreed to move and the view never showed the frame inside
         the bound. Reporting a follow anyway is the lie this wait exists to
         remove; `lost` lets the caller close the record as the failure it is. */
      return { resolution: "lost", moved: false, frame: null };
    }
    await sleep(pollMs);
  }
}

/**
 * Put the view back where the operator was before they agreed — ALL of it, as
 * one quiet settled operation (#873 review, finding 5): the project, the mode,
 * the exact camera, and the focused card, followed by the caller closing the
 * record.
 *
 * A captured camera is the authoritative framing and wins the camera seat
 * outright; the focused path comes back QUIETLY beside it (`openPathQuiet`),
 * because re-opening it through the gliding `openPath` would pull the board to
 * that node and undo the restore it just made. In the modes presence forbids a
 * camera in, the focused path IS what they were looking at, so there it is the
 * restore. However the parts combine, the operator sees ONE move and history
 * gains at most ONE entry.
 *
 * The mode is part of where they were, not decoration on it: a point captured
 * on the overview restores the overview (the one mode that is the ABSENCE of a
 * project, which no project-scoped step below can express). The remaining
 * capturable modes need no separate switch — a desktop can only be moved in
 * `scheme`/`overview`, and a phone never navigates at all — so restoring
 * project, camera and focus restores the mode with them.
 *
 * A camera is world coordinates in ONE project's layout, so it is only ever
 * restored into the project it was captured in. `project` is null when this
 * device has no memory of capturing the point — after a reload, or in a second
 * tab that shares the device id and therefore renders the same return control.
 * Restoring into whichever board happens to be registered would put the
 * operator at a position that means nothing there, so the camera is skipped and
 * the focused path — which names a thing rather than a coordinate — is what
 * comes back instead.
 */
export async function restoreFocusPoint(
  point: Pick<ReturnPoint, "camera" | "focusedPath" | "mode">,
  project: string | null,
  bus: FocusHandoffBus,
  timing: HandoffTiming = {},
  /** The request being returned from: a camera-less board undoes what that
      request's handoff opened, and only that. */
  requestId?: string,
): Promise<boolean> {
  const shell = bus.shell();
  /* A board whose handoff opened a reader closes it on the way back: that is
     the part of "where they were" a camera-less board changed. */
  bus.board()?.returnFromHandoff?.(requestId);

  /* Answered before anything else, because the steps below would otherwise put
     the operator back into the project they were being brought out of. */
  if (point.mode === "overview") {
    if (!shell) return false;
    shell.openOverview();
    return true;
  }

  /* A return that is going straight to a focused card (the voice/PiP
     return-to-card case) is ONE gesture and records ONE entry through the
     combined open below. A bare project return is a lone project switch and
     records as before. */
  const switchNeeded = Boolean(project && shell && shell.project !== project);
  const focusOnly = Boolean(point.focusedPath) && !(point.camera && project);
  const cameraRestore = Boolean(point.camera && project);
  if (switchNeeded && !focusOnly) {
    /* With an exact camera AND a focused card to restore, the project applies
       QUIETLY (the same half `openConversation` gives a cross-project open) so
       the whole return stays one operation with ONE history entry — the
       focused card's, below. A return with no card to record keeps the switch
       as its one recorded action, exactly as before. */
    if (cameraRestore && point.focusedPath && shell!.openPathQuiet) shell!.openConversation(project!, null);
    else shell!.openProject(project!);
  }

  if (cameraRestore) {
    const board = await boardForProject(bus, project!, timing);
    if (board?.restoreCamera(point.camera!)) {
      /* The framing is back; the focused card comes back beside it, quietly —
         never through the gliding open that would undo the exact camera the
         line above just restored. A navigator without the quiet half keeps
         the pre-#873 behavior: the camera is the restore. */
      if (point.focusedPath) shell?.openPathQuiet?.(point.focusedPath);
      return true;
    }
    /* A surface with no camera falls through to what was focused there, which
       is the only part of that viewport it can put back. */
  }
  if (point.focusedPath && shell) {
    if (focusOnly) shell.openConversation(switchNeeded ? project : null, point.focusedPath);
    else shell.openPath(point.focusedPath);
    return true;
  }
  /* Nothing was captured worth restoring — an overview with no focused card is
     already where they were, and the project switch above is the whole move. */
  return Boolean(project && shell);
}
