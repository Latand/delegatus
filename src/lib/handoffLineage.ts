import fs from "node:fs";

import { statePath } from "@/lib/configDir";
import { pidAlive } from "@/lib/scanner/process";
import { agentRegistry, type ConversationLookup } from "@/lib/agent/registry";
import { forEachCooperatively } from "@/lib/cooperative";
import { KeyedRows, type KeyedRowsView } from "@/lib/state/keyedRows";
import type { DocumentRow } from "@/lib/state/legacyDocumentStore";
import { legacyDatabasePath } from "@/lib/state/legacyImport";
import { smallStore } from "@/lib/state/smallStore";

/**
 * Compatibility lineage for older handoffs. Viewer spawns now commit a durable
 * conversation edge in the agent registry at intent creation. This store keeps
 * historical transcript edges and live pane-pid evidence readable while those
 * sessions age out.
 *
 * The edges live in `state.sqlite`, collection `handoff_lineage` (#1870 slice
 * 8), imported once from `handoff-lineage.json`, one row per edge:
 *
 *   pane:<pid>                  source transcript of a live handoff pane
 *   child:<transcript>          source transcript of a handoff child
 *   conversation:<conversation> source conversation of a handoff child
 *
 * Every process reads the same rows, so an edge one process records is seen
 * by the others; the legacy file was loaded once per process and rewritten
 * whole from that process's copy, dropping what another process had added
 * since. `rememberHandoffChild` keeps an edge in this process until
 * `persistHandoffLineage` writes it, as before; a write that fails keeps it for
 * the next one.
 */

export const HANDOFF_LINEAGE_COLLECTION = "handoff_lineage";
export const HANDOFF_LINEAGE_FILE_NAME = "handoff-lineage.json";
const MAX_CHILDREN = 20_000;
const PANE_PREFIX = "pane:";
const CHILD_PREFIX = "child:";
const CONVERSATION_PREFIX = "conversation:";

export function handoffLineagePath(): string {
  return statePath(HANDOFF_LINEAGE_FILE_NAME);
}

export interface HandoffLineageStoreShape {
  panes?: Record<string, string>;
  children?: Record<string, string>;
  conversationChildren?: Record<string, string>;
}

interface HandoffLineageDocument {
  panes: Map<number, string>;
  children: Map<string, string>;
  conversationChildren: Map<string, string>;
}

export function normalizeHandoffLineageStore(
  stored: HandoffLineageStoreShape,
  pidIsAlive: (pid: number) => boolean = pidAlive,
): HandoffLineageDocument & { dirty: boolean } {
  const nextPanes = new Map<number, string>();
  const nextChildren = new Map<string, string>();
  const nextConversationChildren = new Map<string, string>();
  for (const [pidRaw, parent] of Object.entries(stored.panes ?? {})) {
    const pid = Number(pidRaw);
    /* A dead pane pid can only match again after the OS reuses it — drop it. */
    if (Number.isInteger(pid) && pid > 0 && typeof parent === "string" && pidIsAlive(pid)) nextPanes.set(pid, parent);
  }
  for (const [child, parent] of Object.entries(stored.children ?? {})) {
    if (typeof parent === "string") nextChildren.set(child, parent);
  }
  for (const [child, parent] of Object.entries(stored.conversationChildren ?? {})) {
    if (typeof parent === "string" && child.startsWith("conversation_") && parent.startsWith("conversation_")) nextConversationChildren.set(child, parent);
  }
  const storedSize = Object.keys(stored.panes ?? {}).length + Object.keys(stored.children ?? {}).length + Object.keys(stored.conversationChildren ?? {}).length;
  return { panes: nextPanes, children: nextChildren, conversationChildren: nextConversationChildren, dirty: nextPanes.size + nextChildren.size + nextConversationChildren.size !== storedSize };
}

function parseLineage(value: unknown): HandoffLineageDocument {
  const stored = value && typeof value === "object" && !Array.isArray(value) ? value as HandoffLineageStoreShape : {};
  const { panes, children, conversationChildren } = normalizeHandoffLineageStore(stored);
  return { panes, children, conversationChildren };
}

function lineageRows(document: HandoffLineageDocument): DocumentRow[] {
  return [
    ...[...document.panes].map(([pid, parent]) => ({ key: `${PANE_PREFIX}${pid}`, value: parent })),
    ...[...document.children].map(([child, parent]) => ({ key: `${CHILD_PREFIX}${child}`, value: parent })),
    ...[...document.conversationChildren].map(([child, parent]) => ({ key: `${CONVERSATION_PREFIX}${child}`, value: parent })),
  ];
}

function lineageDocument(rows: Iterable<readonly [string, string]>): HandoffLineageDocument {
  const document: HandoffLineageDocument = { panes: new Map(), children: new Map(), conversationChildren: new Map() };
  for (const [key, parent] of rows) {
    if (key.startsWith(PANE_PREFIX)) document.panes.set(Number(key.slice(PANE_PREFIX.length)), parent);
    else if (key.startsWith(CHILD_PREFIX)) document.children.set(key.slice(CHILD_PREFIX.length), parent);
    else if (key.startsWith(CONVERSATION_PREFIX)) document.conversationChildren.set(key.slice(CONVERSATION_PREFIX.length), parent);
  }
  return document;
}

/** Import, reconcile and the rollback mirror. */
export const handoffLineageDocumentStore = smallStore<HandoffLineageDocument>({
  collection: HANDOFF_LINEAGE_COLLECTION,
  empty: () => ({ panes: new Map(), children: new Map(), conversationChildren: new Map() }),
  parse: parseLineage,
  toRows: lineageRows,
  fromRows: (rows) => lineageDocument(rows.flatMap((row) => typeof row.value === "string" ? [[row.key, row.value] as const] : [])),
  toFile: (document) => ({
    panes: Object.fromEntries([...document.panes].map(([pid, parent]) => [String(pid), parent])),
    children: Object.fromEntries(document.children),
    conversationChildren: Object.fromEntries(document.conversationChildren),
  }),
});

/* Constructed on first use: this module can be reached while the state
   modules are still initializing (an import cycle through the registry). */
let keyedRows: KeyedRows<string> | null = null;
const rows = (): KeyedRows<string> => keyedRows ??= new KeyedRows<string>({
  collection: HANDOFF_LINEAGE_COLLECTION,
  prefixes: [PANE_PREFIX, CHILD_PREFIX, CONVERSATION_PREFIX],
  busyMessage: "handoff lineage is busy",
  decode: (_key, value) => typeof value === "string" ? value : undefined,
  importLegacy: (filePath, options) => handoffLineageDocumentStore.importLegacy(filePath, options),
});

/** Edges this process recorded and has not written yet. */
const pending = new Map<string, string>();

/* ----------------------------------------------------------------- reads */

let legacyRead: { filePath: string; signature: string; rows: Map<string, string> } | null = null;

function legacySignature(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath, { bigint: true, throwIfNoEntry: false });
    return stat ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}` : "missing";
  } catch {
    return null;
  }
}

/** The legacy file, before the import; first run or unreadable reads empty. */
function legacyRows(filePath: string): Map<string, string> {
  const signature = legacySignature(filePath);
  if (signature !== null && legacyRead?.filePath === filePath && legacyRead.signature === signature) return legacyRead.rows;
  let document: HandoffLineageDocument = { panes: new Map(), children: new Map(), conversationChildren: new Map() };
  try {
    document = parseLineage(JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown);
  } catch { /* first run, a tombstone or an unreadable file */ }
  const held = new Map(lineageRows(document).map((row) => [row.key, row.value as string] as const));
  if (signature !== null) legacyRead = { filePath, signature, rows: held };
  return held;
}

function lineageView(): KeyedRowsView<string> | null {
  try {
    return rows().view(legacyDatabasePath(handoffLineagePath()));
  } catch (error) {
    console.warn("[handoff lineage] unavailable", error instanceof Error ? error.message : String(error));
    return null;
  }
}

/** One edge: this process's unwritten one, else the stored one. A scan asks
    for every transcript it sees, so the edges (about a thousand on a busy
    installation) are loaded once and followed through the change log. */
function edge(key: string): string | null {
  const held = pending.get(key);
  if (held !== undefined) return held;
  const view = lineageView();
  try {
    return (view ? view.rows() : legacyRows(handoffLineagePath())).get(key) ?? null;
  } catch (error) {
    console.warn("[handoff lineage] unavailable", error instanceof Error ? error.message : String(error));
    return null;
  }
}

/** Every edge under one prefix, with this process's unwritten ones. */
function edges(prefix: string): Map<string, string> {
  const view = lineageView();
  const all = view ? view.rows() : legacyRows(handoffLineagePath());
  const result = new Map<string, string>();
  for (const [key, parent] of all) if (key.startsWith(prefix)) result.set(key.slice(prefix.length), parent);
  for (const [key, parent] of pending) if (key.startsWith(prefix)) result.set(key.slice(prefix.length), parent);
  return result;
}

/* ---------------------------------------------------------------- writes */

/** Records that the pane just booted for a handoff descends from `parent`. */
export function rememberHandoffPane(panePid: number, parent: string): void {
  if (!Number.isInteger(panePid) || panePid <= 0) return;
  if (edge(`${PANE_PREFIX}${panePid}`) === parent) return;
  pending.set(`${PANE_PREFIX}${panePid}`, parent);
  persistHandoffLineage();
}

/** Source transcript of the handoff pane `pid` belongs to, if any. */
export function handoffParentForPid(pid: number): string | null {
  return edge(`${PANE_PREFIX}${pid}`);
}

export function rememberHandoffChild(child: string, parent: string): void {
  const key = `${CHILD_PREFIX}${child}`;
  if (edge(key) === parent) return;
  pending.set(key, parent);
}

/** Previously proven handoff source of the `child` transcript, if any. */
export function handoffParentForChild(child: string): string | null {
  return edge(`${CHILD_PREFIX}${child}`);
}

export function handoffParentConversation(childConversationId: string): string | null {
  return edge(`${CONVERSATION_PREFIX}${childConversationId}`);
}

function conversationEdges(registry: ConversationLookup, childPath: string, parentPath: string, known: Map<string, string>): void {
  const child = registry.conversationForPath(childPath);
  const parent = registry.conversationForPath(parentPath);
  if (!child || !parent || known.get(child.id) === parent.id) return;
  known.set(child.id, parent.id);
  pending.set(`${CONVERSATION_PREFIX}${child.id}`, parent.id);
}

export function reconcileHandoffConversationOwnership(registry: ConversationLookup = agentRegistry()): void {
  const known = edges(CONVERSATION_PREFIX);
  for (const [childPath, parentPath] of edges(CHILD_PREFIX)) conversationEdges(registry, childPath, parentPath, known);
  persistHandoffLineage();
}

export async function reconcileHandoffConversationOwnershipCooperatively(registry: ConversationLookup = agentRegistry()): Promise<void> {
  const known = edges(CONVERSATION_PREFIX);
  await forEachCooperatively([...edges(CHILD_PREFIX)], ([childPath, parentPath]) => conversationEdges(registry, childPath, parentPath, known));
  persistHandoffLineage();
}

/**
 * Write the edges this process recorded, in one transaction. Child edges
 * beyond the cap drop the oldest first, and pane edges whose process has
 * exited go with them: a dead pane pid can only match again after the OS
 * reuses it. Best-effort, as it always was: a lost edge only costs one
 * unlinked handoff, and an edge that could not be written is kept for the
 * next call.
 */
export function persistHandoffLineage(): void {
  if (pending.size === 0) return;
  const written = new Map(pending);
  try {
    rows().write(handoffLineagePath(), (read) => {
      const records: DocumentRow[] = [];
      for (const [key, parent] of written) if (read(key) !== parent) records.push({ key, value: parent });
      const deleteKeys: string[] = [];
      const view = lineageView();
      if (view) {
        const stored = view.rows();
        let children = 0;
        for (const key of stored.keys()) if (key.startsWith(CHILD_PREFIX)) children += 1;
        for (const key of written.keys()) if (key.startsWith(CHILD_PREFIX) && !stored.has(key)) children += 1;
        for (const key of stored.keys()) {
          if (key.startsWith(PANE_PREFIX) && !written.has(key) && !pidAlive(Number(key.slice(PANE_PREFIX.length)))) deleteKeys.push(key);
          else if (children > MAX_CHILDREN && key.startsWith(CHILD_PREFIX) && !written.has(key)) {
            deleteKeys.push(key);
            children -= 1;
          }
        }
      }
      return { records, deleteKeys };
    });
    for (const [key, parent] of written) if (pending.get(key) === parent) pending.delete(key);
  } catch (error) {
    console.warn("[handoff lineage] edges kept for the next write:", error instanceof Error ? error.message : String(error));
  }
}

/* ------------------------------------------------------- import, rollback */

/** Import `handoff-lineage.json` now. The Viewer's activation calls this with
    `reconcile: true`. */
export function importLegacyHandoffLineage(filePath = handoffLineagePath(), options: { reconcile: boolean } = { reconcile: true }) {
  return handoffLineageDocumentStore.importLegacy(filePath, options);
}

/** Write `handoff-lineage.json` from SQLite for a rollback release that
    predates the move. */
export function checkpointHandoffLineageRollbackMirrorForDemotion(filePath = handoffLineagePath()): void {
  handoffLineageDocumentStore.checkpointRollbackMirror(filePath);
}

/** Test seam: forget every held row and unwritten edge, the way a restarted
    process would. */
export function resetHandoffLineageForTests(): void {
  rows().resetForTests();
  pending.clear();
  legacyRead = null;
}
