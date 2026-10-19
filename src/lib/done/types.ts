/*
 * «Готово» in «Чекають на вас» (docs/design/done-section.md): every finished
 * unit of work is one item the operator acknowledges. The shapes here cross to
 * the browser, so they hold no path, account name or address: an item names
 * its source by ids and the words Delegatus already shows on the board.
 */

export type DoneItemKind = "pr" | "pipeline" | "task" | "deploy" | "report" | "limit";

/** Where the row sits in the section and how it is drawn (§4.3). */
export type DoneItemLook = "visible" | "technical" | "closed" | "deploy" | "publication" | "incident" | "limit";

export interface DoneFrame {
  /** Where the bytes load from, relative to the Viewer's own origin. */
  src: string;
  /** The same picture before the change, when the lane published a pair. */
  before?: string;
  caption: string;
  /** No retained raster could be recovered. Draw the missing-frame label. */
  unavailable?: boolean;
}

export interface DoneItemRefs {
  pipelineId?: string;
  pr?: { repository: string; number: number; url: string };
  taskIds?: string[];
  deploymentId?: string;
  sha?: string;
  /** A deploy's terminal phase: `succeeded`, `failed` or `rolled-back`. */
  phase?: string;
  reportId?: string;
  /** A limit episode: the account's own label as the accounts list shows it. */
  account?: { engine: string; accountId: string; window: string; label?: string };
  /** When the window ran out, when a later sample showed it back, and how
      many lanes recorded that account as limited in between. */
  limit?: { from: string; to: string | null; lanes: number };
}

export interface DoneItemV1 {
  /** Deterministic from the source (§2): a repeated event finds this key. */
  key: string;
  kind: DoneItemKind;
  look: DoneItemLook;
  /** The board the item belongs to; null for deploys and limits, which every
      board shows. */
  project: string | null;
  /** The event's own time. */
  at: string;
  createdAt: string;
  /** The row's sentence (§4.1); empty where the dictionaries supply it. */
  title: string;
  /** A lucide name: the task's icon, when it has one. */
  icon: string | null;
  refs: DoneItemRefs;
  frame: DoneFrame | null;
  /** When the thumbnail lookup settled; null while it may still find one. */
  frameCheckedAt: string | null;
  acknowledgedAt: string | null;
  acknowledgedBy: { kind: "operator"; surface: "desktop" | "phone" } | null;
}

export interface DoneItemsAnswer {
  ok: true;
  /** Unacknowledged items, newest event first. */
  items: DoneItemV1[];
  revision: number;
}

export interface DoneAcknowledgeAnswer {
  ok: true;
  /** The rows the request changed. */
  changed: DoneItemV1[];
}

/** The most keys one acknowledgement may name. */
export const DONE_ACK_MAX_KEYS = 200;

/** What the store remembers of one limit episode (§2.4), in sample seconds:
    the first sample at no room left that the projector saw, the latest one,
    and the sample that showed the window back. The history trims its oldest
    samples, so an episode is recognised by these and keeps the key its start
    gave it. */
export interface DoneLimitEpisode {
  start: number;
  lastZero: number;
  close: number | null;
}

/** `<engine>|<accountId>|<window>` → the episodes remembered for it. */
export type DoneLimitEpisodes = Record<string, DoneLimitEpisode[]>;
