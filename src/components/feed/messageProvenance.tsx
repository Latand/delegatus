"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";

import type { DeliveredMessageOccurrence, DeliveredMessageProvenance, MandateDelivery } from "@/lib/runtime/messageOrigin";
import { messageOriginRole } from "@/lib/runtime/messageOrigin";
import { parseSelectedContextRef } from "@/lib/selection/selectedContext";

import { assignDeliveredOccurrences, candidateDigests, occurrenceCandidate } from "./deliveredOccurrences";
import type { FeedEntry, Item } from "./parse";
import { BoundedLru } from "./scrollMemory";

/**
 * Delivery-evidence provenance for the feed (#1117): a delivered Claude
 * "system" row resolves by its engine message id into the operator's own
 * bubble or an internal relay card, and a message that left no per-row
 * identity — a legacy tmux paste on either engine (composer, bulk send, MCP
 * `send_message` into a tmux-owned pane), a flow relay, a pre-#1117
 * structured send — resolves through the occurrence join: the server projects
 * each settled delivery's content digest, settlement time and authorship, and
 * the feed attaches it to the ONE row carrying that text nearest that time.
 * Codex structured rows need neither join: their authorship rides the
 * structured-user marker the parser already decodes.
 *
 * The lookup travels by context so every FeedItem — focused pane, compact
 * canvas pane — reads the same resolution without threading a prop through
 * the row tree. A surface that mounts no provider (demo renderer, tests) gets
 * the empty lookup and keeps today's rendering.
 */
export interface ProvenanceLookup {
  /** Delivery evidence for one feed row — the Claude ledger's id join first,
      then the occurrence join — or null when nothing proves its authorship. */
  forItem(item: Item): DeliveredMessageProvenance | null;
  /**
   * WHICH submission a delivery identity belongs to (#1950 round 2): the
   * `dedup` token a structured Codex record carries in its own marker,
   * resolved to the client message id that admitted it — the id of the outbox
   * row the operator is looking at.
   *
   * Null is the honest answer and it binds nothing. A token that resolves to
   * nothing is a delivery this browser cannot name, which is precisely NOT a
   * reason to hand the record to whichever row happens to share its words.
   */
  submissionFor(dedup: string | undefined): string | null;
}

export const NO_PROVENANCE: ProvenanceLookup = { forItem: () => null, submissionFor: () => null };
const ProvenanceContext = createContext<ProvenanceLookup>(NO_PROVENANCE);
export const MessageProvenanceProvider = ProvenanceContext.Provider;

export function useMessageProvenance(): ProvenanceLookup {
  return useContext(ProvenanceContext);
}

type ProvenanceMap = Record<string, DeliveredMessageProvenance>;
interface PathProvenance {
  messages: ProvenanceMap;
  occurrences: DeliveredMessageOccurrence[];
  /** `dedup token → submission id`, straight from the registry's own record
      of which client message id admitted which delivery operation. */
  submissions: Record<string, string>;
}

/* Browser-wide, so a revisited conversation answers from memory and a pane
   remount does not refetch what it already resolved. Entries only grow: a
   ledger's queued→delivered records, a settled delivery and a settled flow
   round are immutable once written. */
const PROVENANCE_CACHE_PATHS = 48;
const provenanceCache = new BoundedLru<PathProvenance>(PROVENANCE_CACHE_PATHS);

/** The ledger can record a delivery's engine message id AFTER the transcript
    row is already visible, and a legacy paste's row lands before the registry
    settles its receipt, so an unresolved row revalidates on this bounded
    schedule instead of waiting for a remount. A row that will never resolve
    costs at most this many extra fetches per pane, then stops. */
const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [1_500, 4_000, 10_000];
let retryDelaysMs = DEFAULT_RETRY_DELAYS_MS;

/** A row without a ledger id only races its own receipt while it is this
    fresh; a historical row without evidence is settled absence and never
    revalidates. */
const RECENT_ROW_MS = 2 * 60 * 1000;

export function resetMessageProvenanceCacheForTests(): void {
  provenanceCache.clear();
}

export function setMessageProvenanceRetryScheduleForTests(delays: readonly number[] | null): void {
  retryDelaysMs = delays ?? DEFAULT_RETRY_DELAYS_MS;
}

/** The seat-mandate projection of one delivery (#1166). The qualifier is the
    only thing a malformed payload can cost: a delivery the server called a
    mandate stays one, and the card falls back to naming no version rather than
    inventing one or handing the row back to the operator's bubble. */
function parseMandate(value: unknown): MandateDelivery | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { kind, version } = value as Record<string, unknown>;
  if (kind === "custom") return { kind: "custom" };
  if (kind !== "version" && kind !== "unqualified") return null;
  return kind === "version" && typeof version === "number" && Number.isInteger(version)
    ? { kind: "version", version }
    : { kind: "unqualified" };
}

/** A submission id is this browser's own idempotency key travelling back to
    it. Bounded and marker-safe so a corrupt record can only cost the join. */
const SUBMISSION_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

function parseSubmissionId(value: unknown): string | undefined {
  return typeof value === "string" && SUBMISSION_ID.test(value) ? value : undefined;
}

function parseProvenance(entry: unknown): DeliveredMessageProvenance | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const body = entry as Record<string, unknown>;
  if (body.origin !== "operator" && body.origin !== "agent") return null;
  const senderRole = messageOriginRole(body.senderRole);
  const selectedContext = parseSelectedContextRef(body.selectedContext);
  const mandate = parseMandate(body.mandate);
  const submissionId = parseSubmissionId(body.submissionId);
  return {
    origin: body.origin,
    ...(senderRole ? { senderRole } : {}),
    ...(selectedContext ? { selectedContext } : {}),
    ...(mandate ? { mandate } : {}),
    ...(submissionId ? { submissionId } : {}),
  };
}

const DEDUP_TOKEN = /^[a-f0-9]{64}$/;

function parseSubmissions(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const parsed: Record<string, string> = {};
  for (const [token, id] of Object.entries(value as Record<string, unknown>)) {
    if (!DEDUP_TOKEN.test(token)) continue;
    const submissionId = parseSubmissionId(id);
    if (submissionId) parsed[token] = submissionId;
  }
  return parsed;
}

function parseProvenanceMessages(value: unknown): ProvenanceMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const parsed: ProvenanceMap = {};
  for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!id) continue;
    const provenance = parseProvenance(entry);
    if (provenance) parsed[id] = provenance;
  }
  return parsed;
}

const CONTENT_DIGEST = /^[a-f0-9]{64}$/;

function parseOccurrences(value: unknown): DeliveredMessageOccurrence[] {
  if (!Array.isArray(value)) return [];
  const parsed: DeliveredMessageOccurrence[] = [];
  for (const entry of value) {
    const provenance = parseProvenance(entry);
    if (!provenance) continue;
    const { textDigest, deliveredAt } = entry as Record<string, unknown>;
    if (typeof textDigest !== "string" || !CONTENT_DIGEST.test(textDigest)) continue;
    if (typeof deliveredAt !== "string" || !Number.isFinite(Date.parse(deliveredAt))) continue;
    parsed.push({ ...provenance, textDigest, deliveredAt });
  }
  return parsed;
}

/** Union by exact identity: the server answers with the full set each time,
    and a row settled earlier in this page's life must not flip back when the
    registry later compacts its receipt. */
function mergeOccurrences(
  previous: readonly DeliveredMessageOccurrence[],
  next: readonly DeliveredMessageOccurrence[],
): DeliveredMessageOccurrence[] {
  const merged = new Map<string, DeliveredMessageOccurrence>();
  for (const occurrence of [...previous, ...next]) {
    merged.set(`${occurrence.textDigest}\n${occurrence.deliveredAt}\n${occurrence.origin}\n${occurrence.senderRole ?? ""}`, occurrence);
  }
  return [...merged.values()];
}

interface WantedDriver {
  item: Item;
  engineMessageId: string | null;
  tsMs: number;
  /** Bounded trigger token; collisions only cost a skipped refetch, never a
      wrong join — resolution always compares the full digest. */
  token: string;
  /** The record's own delivery identity, when it carries one (#1950 round 2).
      Unresolved until the registry names its submission, and a row whose
      submission is unnamed is exactly the row that must not be bound by its
      words — so it drives a fetch on its own. */
  dedup?: string;
}

interface WantedEvidence {
  /** Rows whose visual could still change with evidence — the ONLY fetch
      trigger, so an idle pane never polls. */
  drivers: WantedDriver[];
  /** Every row that can consume an occurrence (see occurrenceCandidate),
      including rows already attributed by the parser or the ledger. */
  candidates: Item[];
  /**
   * The submissions this window is still waiting on, by id (#1950 round 2).
   *
   * They are a fetch trigger in their own right, and the reason is timing,
   * not evidence: the registry writes a delivery's owner row when it ADMITS
   * the message, long before the engine journals anything. Asking then means
   * the join from the record's own identity to this row is already in hand
   * when the record finally appears — so the record is bound in the render it
   * first appears in, rather than painting a second copy of the message for
   * as long as a round trip takes.
   */
  pending: readonly string[];
}

function wantedEvidence(items: readonly FeedEntry[], pending: readonly string[]): WantedEvidence {
  const drivers: WantedDriver[] = [];
  const candidates: Item[] = [];
  const seenDedup = new Set<string>();
  for (const { item, submissionDedup } of items) {
    const candidate = occurrenceCandidate(item);
    if (candidate) candidates.push(item);
    const token = candidate ? candidateDigests(candidate)[0].slice(0, 16) : "";
    if (item.kind === "sysmsg" && item.deliveredMessage) {
      drivers.push({ item, engineMessageId: item.deliveredMessage.engineMessageId, tsMs: candidate?.tsMs ?? Number.NaN, token });
    } else if (item.kind === "user" && !item.selectedContext && candidate) {
      drivers.push({ item, engineMessageId: null, tsMs: candidate.tsMs, token });
    }
    /* One driver per RECORD, not per row: an image-only send paints several
       attachment rows that share one identity, and they need one answer. */
    if (submissionDedup && !seenDedup.has(submissionDedup)) {
      seenDedup.add(submissionDedup);
      drivers.push({ item, engineMessageId: null, tsMs: candidate?.tsMs ?? Number.NaN, token, dedup: submissionDedup });
    }
  }
  return { drivers, candidates, pending };
}

/** Whether some driver row still lacks evidence. `recentRowsOnly` is the
    revalidation rule: a ledger id revalidates regardless of age, a row
    without one only while it is fresh enough to be racing its receipt. */
function unresolvedDrivers(wanted: WantedEvidence, data: PathProvenance | null, recentRowsOnly: boolean, nowMs: number): boolean {
  if (wanted.drivers.length === 0 && wanted.pending.length === 0) return false;
  if (!data) return true;
  /* A submission the server has not named yet. Answering it early is the
     whole point; once every live submission is named there is nothing left
     to ask for on their account. */
  const named = new Set(Object.values(data.submissions));
  if (wanted.pending.some((id) => !named.has(id))) return true;
  if (wanted.drivers.length === 0) return false;
  const assigned = assignDeliveredOccurrences(wanted.candidates, data.occurrences);
  return wanted.drivers.some((driver) => {
    /* A delivery identity revalidates on its own terms: the registry writes
       the owner row at admission, so an unresolved token is either a send
       this conversation never made or one whose record has not been read
       back yet — and only a refetch can tell those apart. */
    if (driver.dedup) return !(driver.dedup in data.submissions);
    if (driver.engineMessageId && driver.engineMessageId in data.messages) return false;
    if (assigned.has(driver.item)) return false;
    if (driver.engineMessageId) return true;
    return !recentRowsOnly || nowMs - driver.tsMs < RECENT_ROW_MS;
  });
}

/* Stable per-object identity for the lookup's content key: a re-parsed feed
   keeps its item objects, so the key only moves when a row's object or its
   resolution actually changes. */
const itemSerials = new WeakMap<Item, number>();
let nextItemSerial = 1;
function itemSerial(item: Item): number {
  let serial = itemSerials.get(item);
  if (serial === undefined) {
    serial = nextItemSerial;
    nextItemSerial += 1;
    itemSerials.set(item, serial);
  }
  return serial;
}

function lookupFor(data: PathProvenance | null, assignment: Map<Item, DeliveredMessageProvenance>): ProvenanceLookup {
  if (!data) return NO_PROVENANCE;
  return {
    forItem: (item) => {
      if (item.kind === "sysmsg" && item.deliveredMessage?.engineMessageId) {
        const byId = data.messages[item.deliveredMessage.engineMessageId];
        if (byId) return byId;
      }
      return assignment.get(item) ?? null;
    },
    submissionFor: (dedup) => (dedup ? data.submissions[dedup] ?? null : null),
  };
}

/**
 * The lookup one path's evidence yields over the rows it may attribute — the
 * exact composition the hook renders with, for tests that drive the parser
 * and the renderer without a fetch.
 */
export function provenanceLookupFor(
  data: {
    messages?: ProvenanceMap;
    occurrences?: readonly DeliveredMessageOccurrence[];
    submissions?: Record<string, string>;
  },
  items: Iterable<Item>,
): ProvenanceLookup {
  const occurrences = [...(data.occurrences ?? [])];
  return lookupFor(
    { messages: data.messages ?? {}, occurrences, submissions: data.submissions ?? {} },
    assignDeliveredOccurrences(items, occurrences),
  );
}

const NO_OCCURRENCES: readonly DeliveredMessageOccurrence[] = [];
const NO_PENDING: readonly string[] = [];

/**
 * Fetches `/api/log/provenance` whenever the window shows a row the cache
 * cannot resolve yet, and revalidates on the bounded schedule above while a
 * row could still be racing its own receipt. Failures stay quiet — a row
 * without evidence renders exactly as it does today.
 */
export function useDeliveredMessageProvenance(
  path: string | null,
  items: readonly FeedEntry[],
  pending: readonly string[] = NO_PENDING,
): ProvenanceLookup {
  const pendingKey = pending.join("\n");
  const wanted = useMemo<WantedEvidence>(
    () => (path ? wantedEvidence(items, pending) : { drivers: [], candidates: [], pending: NO_PENDING }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `pending` is keyed by its content, so a same-content array keeps the evidence
    [path, items, pendingKey],
  );
  const wantedKey = useMemo(
    () => [
      ...wanted.drivers.map((driver) => driver.dedup ?? driver.engineMessageId ?? driver.token),
      ...wanted.pending,
    ].join("\n"),
    [wanted],
  );
  /* The fetch effect keys on the bounded `wantedKey` alone — `wanted` changes
     identity every poll tick and would kill the retry timer; the ref hands the
     effect the equivalent current evidence for the same key. */
  const wantedRef = useRef<WantedEvidence>(wanted);
  useEffect(() => {
    wantedRef.current = wanted;
  }, [wanted]);
  const [data, setData] = useState<PathProvenance | null>(() => (path ? provenanceCache.get(path) ?? null : null));
  useEffect(() => {
    if (!path) return;
    const cached = provenanceCache.get(path) ?? null;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync to the path's cache entry on path change
    setData(cached);
    if (!wantedKey) return;
    const wanted = wantedRef.current;
    if (!unresolvedDrivers(wanted, cached, false, Date.now())) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const attempt = async (retry: number): Promise<void> => {
      try {
        const res = await fetch(`/api/log/provenance?path=${encodeURIComponent(path)}`);
        if (!res.ok) return;
        const json = (await res.json()) as { messages?: unknown; occurrences?: unknown; submissions?: unknown };
        const previous = provenanceCache.get(path);
        const merged: PathProvenance = {
          messages: { ...(previous?.messages ?? {}), ...parseProvenanceMessages(json.messages) },
          occurrences: mergeOccurrences(previous?.occurrences ?? [], parseOccurrences(json.occurrences)),
          /* Only grows: a delivery's owner row is immutable once written, and
             the registry compacting it later must not unbind a row the
             operator is already looking at. */
          submissions: { ...(previous?.submissions ?? {}), ...parseSubmissions(json.submissions) },
        };
        provenanceCache.set(path, merged);
        if (!alive) return;
        setData(merged);
        if (retry < retryDelaysMs.length && unresolvedDrivers(wanted, merged, true, Date.now())) {
          timer = setTimeout(() => void attempt(retry + 1), retryDelaysMs[retry]);
        }
      } catch {
        /* quiet: absence renders as today's row */
      }
    };
    void attempt(0);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [path, wantedKey]);
  const assignment = useMemo(
    () => assignDeliveredOccurrences(items.map((entry) => entry.item), data?.occurrences ?? NO_OCCURRENCES),
    [data, items],
  );
  /* Every feed re-parse yields a new assignment map over the SAME row objects;
     the lookup only changes identity — re-rendering every memoized row — when
     a row's resolution actually changed. */
  const submissionsKey = useMemo(
    () => Object.keys(data?.submissions ?? {}).sort().join("\n"),
    [data],
  );
  const assignmentKey = useMemo(() => {
    const parts: string[] = [];
    for (const [item, provenance] of assignment) {
      const mandate = provenance.mandate
        ? `mandate:${provenance.mandate.kind === "version" ? provenance.mandate.version : provenance.mandate.kind}`
        : "";
      parts.push(`${itemSerial(item)}:${provenance.origin}:${provenance.senderRole ?? ""}:${provenance.selectedContext ? "ctx" : ""}:${mandate}`);
    }
    return parts.join("\n");
  }, [assignment]);
  return useMemo(
    () => lookupFor(data, assignment),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the assignment's CONTENT (assignmentKey) and the submissions it can resolve; a same-content map keeps the lookup
    [data, assignmentKey, submissionsKey],
  );
}
