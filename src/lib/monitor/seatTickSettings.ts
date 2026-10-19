import { changeRelease, normalizeRelease, type ReleaseSetting, type ReleaseSettingChange } from "@/lib/release/settings";
import fs from "node:fs";
import { autonomyActive, changeAutonomy, endedAutonomy, type AutonomySetting, type AutonomyChange, type AutonomyDecisionInput } from "./autonomy";

import { statePath } from "@/lib/configDir";
import { ROTATION_THRESHOLD_FRACTION } from "@/lib/orchestrator/contextPolicy";
import { applyLineEdits, type LineEdits, type LineTarget } from "@/lib/lineEdits";
import type { LegacyImportHooks, LegacyImportOutcome } from "@/lib/state/legacyImport";
import { LegacyDocumentStore } from "@/lib/state/legacyDocumentStore";

import { seatTickInstructionLines, replaceSeatTickInstructions, type SeatTickInstructionLine } from "./seatTickInstructions";

import { redactMonitorText } from "./redact";

/**
 * Per-project seat tick settings (issue #1275).
 *
 * The tick arms a loop the seat could not reach. It was forbidden from
 * scheduling itself — correctly, because a session-scheduled monitor dies with
 * its session — and there was no lever anywhere to quiet, slow or stop the loop
 * the Viewer armed instead. A seat that had correctly concluded "there is
 * nothing here for me and the reason will still hold next hour" (see #1274,
 * where an undeletable draft woke a seat hourly for fourteen hours) had no way
 * to say so, and only the operator could intervene by hand.
 *
 * Three properties this file exists to keep:
 *
 * - **Nothing has to be configured for the tick to work.** A project with no
 *   row here reads {@link defaultSeatTickSettings} and behaves exactly as it
 *   did before this existed: enabled, on the default wake interval. "Works out
 *   of the box" was never a reason to deny anyone the controls.
 * - **The controls are real.** Off is off, for as long as the caller says —
 *   indefinitely, if that is the decision. An expiry is offered because it is
 *   convenient for whoever reads the board later, never as a leash that turns
 *   the tick back on under a seat that did not ask for it.
 * - **Every change is attributed.** Who changed which project's tick, in their
 *   own words, is recorded on the row, shown on the board and journaled. A
 *   change to another project's tick is allowed and is not hidden: attribution
 *   is the answer here, not a prohibition.
 *
 * The row also carries two standing instruction fields: the panel's text
 * (reason), delivered in full on every wake and shown as the cadence-change
 * explanation on the board, and the seat's own monitorPrompt (#1280).
 * Both survive schedule reset and expiry until explicitly cleared.
 */

export const SEAT_TICK_SETTINGS_SCHEMA_VERSION = 1;

/** Bound on the stored reason. Long enough for a real sentence, short enough
    that a board card stays a card. */
const REASON_LIMIT = 500;

/**
 * Bound on the agent-authored monitor prompt (#1280, widened by #1450).
 *
 * Wide enough to hold a working state note — a lane list, the traps, the next
 * step — because that is what an orchestrator seat actually writes here. A
 * prompt over the limit is REFUSED by {@link applySeatTickSettingsChange},
 * never cut: the first version of this cap sliced silently at a thousand
 * characters and a seat lost the tail of every note for hours without one
 * reply saying so. The wake keeps its own 4,000-character bound and shows a
 * marked preview of a long note; the full text is always the record.
 */
export const SEAT_TICK_PROMPT_LIMIT = 16_000;

/**
 * Ceiling on an explicit wake interval, in minutes: one year.
 *
 * It is not a policy limit on how quiet a project may be — `enabled: false` is
 * the indefinite off switch and nothing bounds it. It is what keeps a stored
 * number a number, so a typo cannot write an interval no clock can express.
 */
export const SEAT_TICK_MAX_WAKE_INTERVAL_MINUTES = 365 * 24 * 60;

/** Who changed a project's tick. Server-derived; never a caller's claim. */
export interface SeatTickSettingsActor {
  /** `manager` is a designated seat, `gateway` the operator's own session,
      `agent` any other identified session, `unidentified` a caller no evidence
      named. */
  kind: "manager" | "agent" | "gateway" | "unidentified";
  conversationId: string | null;
  /** The actor's own canonical project, when one is known — so a change made
      to another project's tick reads as exactly that. */
  project: string | null;
  seatEpoch: number | null;
  /** The seat's parallel self that made the change under the seat's id
      (docs/design/ghost-seat.md §4 rule 2); absent for anyone else. */
  via?: { deputy: string };
}

export interface BoardMaintenanceSetting {
  enabled: boolean;
  intervalHours: number;
  updatedAt: string;
  setBy: SeatTickSettingsActor;
}
export const AUTO_ROTATE_DEFAULT_PERCENT = Math.round(ROTATION_THRESHOLD_FRACTION * 100);
export interface AutoRotateSetting {
  enabled: boolean;
  thresholdPercent: number;
  updatedAt: string;
  setBy: SeatTickSettingsActor;
  why: string | null;
}
export interface SeatTickSettings {
  autonomy?: AutonomySetting | null;
  autonomyHistory?: AutonomySetting[];
  release?: ReleaseSetting | null;
  autoRotate?: AutoRotateSetting | null;
  maintenance?: BoardMaintenanceSetting | null;
  curation?: BoardMaintenanceSetting | null;
  project: string;
  /** Whether the Viewer ticks this project at all. */
  enabled: boolean;
  /** Minutes between two wakes for this project; null keeps the default. */
  wakeIntervalMinutes: number | null;
  /** Panel instructions for every wake, also the board cadence explanation. */
  reason: string | null;
  instructionLines?: SeatTickInstructionLine[];
  /**
   * The seat's own additional prompt for its monitor (#1280): what it wants
   * every later wake to look at, in its own words.
   *
   * Null is not a state anything has to explain — it is the wake exactly as it
   * was before this field existed.
   */
  monitorPrompt: string | null;
  /** When the setting lapses back to the default. Null means it stands until
      someone changes it. */
  until: string | null;
  updatedAt: string | null;
  setBy: SeatTickSettingsActor | null;
}

/** The settings as one check should read them: the record with its expiry
    already applied. */
export interface EffectiveSeatTickSettings {
  autonomy?: AutonomySetting | null;
  autonomyHistory?: AutonomySetting[];
  release?: ReleaseSetting | null;
  autoRotate?: AutoRotateSetting | null;
  maintenance: { enabled: boolean; intervalHours: number; intervalMs: number };
  maintenanceSetting?: BoardMaintenanceSetting | null;
  curation?: { enabled: boolean; intervalHours: number; intervalMs: number };
  curationSetting?: BoardMaintenanceSetting | null;
  enabled: boolean;
  wakeIntervalMs: number;
  reason: string | null;
  instructionLines?: SeatTickInstructionLine[];
  /**
   * The agent-authored prompt this project's wakes carry, or null (#1280).
   *
   * Read off the row on both sides of the default, alongside the instructions: it
   * changes what a wake SAYS and never whether or when one is sent, so it is
   * owed identically to a project on the default tick and to one that has
   * quieted itself.
   */
  monitorPrompt: string | null;
  until: string | null;
  /** When the record this reading came from was written; null when nothing
      ever wrote one. It is what the board card is stamped with, so the card's
      text changes when the SETTING changes rather than at every check. */
  updatedAt: string | null;
  /** True while nothing departs from the defaults — nothing was ever set, or
      what was set has lapsed. */
  isDefault: boolean;
  /** Whether anyone has ever written this project's row. A project that never
      has costs the board nothing: there is no card to raise and none to
      resolve, so a check for it does exactly what it did before #1275. */
  configured: boolean;
  /** True when an expiry passed and this reading is the default again; the
      controller persists the reversion when it sees it. */
  lapsed: boolean;
  setBy: SeatTickSettingsActor | null;
}

export interface SeatTickSettingsChange {
  autonomy?: AutonomyChange;
  autonomyDecision?: AutonomyDecisionInput;
  release?: ReleaseSettingChange;
  autoRotate?: { enabled?: boolean; thresholdPercent?: number | string | null; why?: string | null };
  maintenance?: { enabled?: boolean; intervalHours?: number | string | null };
  curation?: { enabled?: boolean; intervalHours?: number | string | null };
  enabled?: boolean;
  /** `null` restores the default interval. */
  wakeIntervalMinutes?: number | null;
  /** Replace only the server-identified author’s lines; null removes them. */
  reason?: string | null;
  /** The seat's own additional prompt for its monitor; `null` clears it. */
  monitorPrompt?: string | null;
  /** ISO instant, or `null` for "until someone changes it". */
  until?: string | null;
}

export function seatTickSettingsPath(): string {
  return process.env.LLV_SEAT_TICK_SETTINGS_FILE?.trim() || statePath("seat-tick-settings.json");
}

export function defaultSeatTickSettings(project: string): SeatTickSettings {
  return { project, enabled: true, wakeIntervalMinutes: null, reason: null, monitorPrompt: null, until: null, updatedAt: null, setBy: null };
}

/**
 * Whether a record says anything about the SCHEDULE that the default does not.
 *
 * The instruction fields change what a wake says and stand independently of
 * the schedule. A project carrying only instructions remains on the default
 * cadence, with no cadence-change card; resetting the schedule preserves them.
 */
export function seatTickSettingsAreDefault(settings: SeatTickSettings): boolean {
  return settings.enabled && settings.wakeIntervalMinutes === null;
}

function isoOrNull(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function normalizeActor(value: unknown): SeatTickSettingsActor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const kind = raw.kind;
  if (kind !== "manager" && kind !== "agent" && kind !== "gateway" && kind !== "unidentified") return null;
  return {
    kind,
    conversationId: typeof raw.conversationId === "string" && raw.conversationId ? raw.conversationId.slice(0, 200) : null,
    project: typeof raw.project === "string" && raw.project ? raw.project.slice(0, 200) : null,
    seatEpoch: typeof raw.seatEpoch === "number" && Number.isSafeInteger(raw.seatEpoch) ? raw.seatEpoch : null,
    ...deputyVia(raw.via),
  };
}

function deputyVia(value: unknown): { via?: { deputy: string } } {
  const deputy = value && typeof value === "object" ? (value as { deputy?: unknown }).deputy : undefined;
  return typeof deputy === "string" && deputy ? { via: { deputy: deputy.slice(0, 200) } } : {};
}

function normalizeInterval(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.min(SEAT_TICK_MAX_WAKE_INTERVAL_MINUTES, value);
}

function normalizeMaintenance(value: unknown): BoardMaintenanceSetting | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Partial<BoardMaintenanceSetting>;
  const actor = normalizeActor(r.setBy);
  return typeof r.enabled === "boolean" && Number.isInteger(r.intervalHours) && r.intervalHours! >= 1 && r.intervalHours! <= 168 && isoOrNull(r.updatedAt) && actor
    ? { enabled: r.enabled, intervalHours: r.intervalHours!, updatedAt: r.updatedAt!, setBy: actor } : null;
}

function normalizeRow(project: string, value: unknown): SeatTickSettings {
  const empty = defaultSeatTickSettings(project);
  if (!value || typeof value !== "object" || Array.isArray(value)) return empty;
  const raw = value as Record<string, unknown>;
  return withInstructionLines({
    project,
    ...(normalizeAutonomy(raw.autonomy) ? { autonomy: normalizeAutonomy(raw.autonomy) } : {}),
    ...(Array.isArray(raw.autonomyHistory) ? { autonomyHistory: raw.autonomyHistory.map(normalizeAutonomy).filter((entry): entry is AutonomySetting => entry !== null) } : {}),
    ...(normalizeRelease(raw.release) ? { release: normalizeRelease(raw.release) } : {}),
    ...(normalizeAutoRotate(raw.autoRotate) ? { autoRotate: normalizeAutoRotate(raw.autoRotate) } : {}),
    ...(normalizeMaintenance(raw.curation) ? { curation: normalizeMaintenance(raw.curation) } : {}),
    ...(normalizeMaintenance(raw.maintenance) ? { maintenance: normalizeMaintenance(raw.maintenance) } : {}),
    enabled: raw.enabled !== false,
    wakeIntervalMinutes: normalizeInterval(raw.wakeIntervalMinutes),
    reason: typeof raw.reason === "string" && raw.reason.trim() ? raw.reason.slice(0, REASON_LIMIT) : null,
    /* A stored value over the limit is clamped here, not refused: a file
       written under a wider or older rule still has to load. Refusing is the
       writer's job, above, where the caller is there to hear it. */
    monitorPrompt: typeof raw.monitorPrompt === "string" && raw.monitorPrompt.trim()
      ? raw.monitorPrompt.slice(0, SEAT_TICK_PROMPT_LIMIT)
      : null,
    until: isoOrNull(raw.until),
    updatedAt: isoOrNull(raw.updatedAt),
    setBy: normalizeActor(raw.setBy),
    ...(Array.isArray(raw.instructionLines) ? { instructionLines: raw.instructionLines as SeatTickInstructionLine[] } : {}),
  });
}

function withInstructionLines(settings: SeatTickSettings): SeatTickSettings {
  const { instructionLines, ...rest } = settings;
  return { ...rest, ...(settings.reason || instructionLines ? { instructionLines: seatTickInstructionLines(settings) } : {}) };
}

function normalizeAutonomy(value: unknown): AutonomySetting | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as AutonomySetting;
  const actor = normalizeActor(raw.setBy);
  if (!actor || typeof raw.enabled !== "boolean" || !isoOrNull(raw.startedAt) || !isoOrNull(raw.updatedAt)
    || (raw.until !== null && !isoOrNull(raw.until))) return null;
  return { ...raw, setBy: actor, decisions: Array.isArray(raw.decisions) ? raw.decisions : [] };
}

function normalizeAutoRotate(value: unknown): AutoRotateSetting | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Partial<AutoRotateSetting>;
  const actor = normalizeActor(r.setBy);
  return typeof r.enabled === "boolean" && Number.isInteger(r.thresholdPercent)
    && r.thresholdPercent! >= 50 && r.thresholdPercent! <= 90 && isoOrNull(r.updatedAt) && actor
    ? { enabled: r.enabled, thresholdPercent: r.thresholdPercent!, updatedAt: r.updatedAt!, setBy: actor,
      why: typeof r.why === "string" ? redactMonitorText(r.why).trim().slice(0, 200) || null : null } : null;
}

interface SeatTickSettingsFile {
  version: number;
  projects: Record<string, SeatTickSettings>;
}

function emptySettingsFile(): SeatTickSettingsFile {
  return { version: SEAT_TICK_SETTINGS_SCHEMA_VERSION, projects: {} };
}

function parseSettingsBody(parsed: unknown): SeatTickSettingsFile {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptySettingsFile();
  const projects = ((parsed as Partial<SeatTickSettingsFile>).projects ?? {}) as Record<string, unknown>;
  return {
    version: SEAT_TICK_SETTINGS_SCHEMA_VERSION,
    projects: Object.fromEntries(Object.entries(projects).map(([project, row]) => [project, normalizeRow(project, row)])),
  };
}

/** `seat-tick-settings.json` as the store read it before #1870, for a release
    that may not import yet. */
function readLegacySettingsFile(filePath: string): SeatTickSettingsFile {
  try {
    return parseSettingsBody(JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown);
  } catch {
    /* An unreadable settings file reads as "nothing is configured", which is
       the tick as it shipped. Failing the check instead would let one corrupt
       row stop every project's seat from ever being woken again. This covers
       the legacy file only: a read of the SQLite collection that finds it busy
       throws the store's busy error, as the board and task reads the tick
       makes already do, and the tick's per-project handling bounds it. */
    return emptySettingsFile();
  }
}

const projectKey = (project: string) => `p:${project}`;

/**
 * The settings in `state.sqlite` (#1870 slice 5): one `p:<project>` row per
 * configured project. `seat_tick_settings` answers a revision derived from the
 * row itself, so the row is stored exactly as it was normalized from the file.
 */
const settingsStore = new LegacyDocumentStore<SeatTickSettingsFile>({
  collection: "seat_tick_settings",
  migrationId: "seat-tick-settings-json-v1",
  busyMessage: "seat tick settings are busy",
  parse: parseSettingsBody,
  toRows: (file) => Object.entries(file.projects).map(([project, row]) => ({ key: projectKey(project), value: row })),
  fromRows: (rows) => ({
    version: SEAT_TICK_SETTINGS_SCHEMA_VERSION,
    projects: Object.fromEntries(rows.map((row) => {
      const settings = row.value as SeatTickSettings;
      return [settings.project, settings] as const;
    })),
  }),
  toFile: (file) => ({ ...file, projects: Object.fromEntries(Object.entries(file.projects).map(([project, row]) => [project, withInstructionLines(row)])) }),
  readLegacy: readLegacySettingsFile,
  error: (message, cause) => new Error(message, { cause }),
});

/** The store's legacy import spec, for the import driver and its tests. */
export function seatTickSettingsLegacyCollection(filePath = seatTickSettingsPath()) {
  return settingsStore.legacyCollection(filePath);
}

/** Import `seat-tick-settings.json` into SQLite now (the Viewer's activation). */
export function importLegacySeatTickSettings(
  filePath = seatTickSettingsPath(),
  options: { reconcile: boolean; hooks?: LegacyImportHooks } = { reconcile: true },
): LegacyImportOutcome {
  return settingsStore.importLegacy(filePath, options);
}

/** Write `seat-tick-settings.json` from SQLite for a rollback release that predates #1870. */
export function checkpointSeatTickSettingsRollbackMirrorForDemotion(filePath = seatTickSettingsPath()): void {
  settingsStore.checkpointRollbackMirror(filePath);
}

export function readSeatTickSettings(project: string, filePath = seatTickSettingsPath()): SeatTickSettings {
  return withInstructionLines(settingsStore.read(filePath).projects[project] ?? defaultSeatTickSettings(project));
}

export function readSeatTickSettingsFile(filePath = seatTickSettingsPath()): Record<string, SeatTickSettings> {
  return Object.fromEntries(Object.entries(settingsStore.read(filePath).projects).map(([project, row]) => [project, withInstructionLines(row)]));
}

/** Serialized read-modify-write of one project's row. Only that row is
    written, so two writers of different projects cannot clobber each other. */
export function writeSeatTickSettings(project: string, settings: SeatTickSettings, filePath = seatTickSettingsPath()): void {
  settingsStore.mutate(filePath, (file) => ({
    next: { ...file, projects: { ...file.projects, [project]: withInstructionLines({ ...settings, project }) } },
    result: undefined,
  }));
}

export function effectiveCurationSetting(settings: Pick<SeatTickSettings, "curation">) {
  const intervalHours = settings.curation?.intervalHours ?? 6;
  return { enabled: settings.curation?.enabled ?? true, intervalHours, intervalMs: intervalHours * 3_600_000 };
}

/**
 * The settings one check decides on: the record with its own expiry applied.
 *
 * The expiry is evaluated at read time rather than by a timer, so a Viewer that
 * was not running when it passed still reads the default afterwards, and a
 * setting with no expiry is simply one this function never rewrites.
 */
export function effectiveSeatTickSettings(
  settings: SeatTickSettings,
  nowMs: number,
  defaultWakeIntervalMs: number,
): EffectiveSeatTickSettings {
  const intervalHours = settings.maintenance?.intervalHours ?? 3;
  const maintenance = { enabled: settings.maintenance?.enabled ?? false, intervalHours, intervalMs: intervalHours * 3_600_000 };
  const expiry = settings.until ? Date.parse(settings.until) : Number.NaN;
  const lapsed = Number.isFinite(expiry) && expiry <= nowMs && !seatTickSettingsAreDefault(settings);
  const configured = settings.updatedAt !== null;
  if (lapsed || seatTickSettingsAreDefault(settings)) {
    return {
      release: settings.release, curation: effectiveCurationSetting(settings), curationSetting: settings.curation, maintenance, maintenanceSetting: settings.maintenance, autoRotate: settings.autoRotate,
      autonomy: endedAutonomy(settings.autonomy, nowMs), autonomyHistory: settings.autonomyHistory,
      enabled: true,
      wakeIntervalMs: defaultWakeIntervalMs,
      reason: settings.reason,
      instructionLines: seatTickInstructionLines(settings),
      /* The prompt survives the branch that discards the schedule setting,
         because it was never part of it. */
      monitorPrompt: settings.monitorPrompt,
      until: null,
      updatedAt: settings.updatedAt,
      isDefault: true,
      configured,
      lapsed,
      setBy: lapsed ? settings.setBy : null,
    };
  }
  return {
    release: settings.release, curation: effectiveCurationSetting(settings), curationSetting: settings.curation, maintenance, maintenanceSetting: settings.maintenance, autoRotate: settings.autoRotate,
    autonomy: endedAutonomy(settings.autonomy, nowMs), autonomyHistory: settings.autonomyHistory,
    enabled: settings.enabled,
    wakeIntervalMs: settings.wakeIntervalMinutes === null
      ? defaultWakeIntervalMs
      : Math.round(settings.wakeIntervalMinutes * 60_000),
    reason: settings.reason,
    instructionLines: seatTickInstructionLines(settings),
    monitorPrompt: settings.monitorPrompt,
    until: settings.until,
    updatedAt: settings.updatedAt,
    isDefault: false,
    configured,
    lapsed: false,
    setBy: settings.setBy,
  };
}

/**
 * The row a lapsed setting is written back as (#1275, amended by #1280).
 *
 * An expiry ends the SCHEDULE its caller set, so that is what this restores.
 * The prompt is not part of that setting and stays, together with who wrote the
 * row and when, rather than disappearing at a deadline that was set for
 * something else — a seat that quieted itself until noon and separately left
 * words for its own wakes gets those words back at noon along with its tick.
 *
 * The panel instructions (stored as reason) also survive: expiry ends the
 * cadence setting, while both instruction fields stand until cleared.
 */
export function seatTickSettingsAfterLapse(
  project: string,
  lapsed: Pick<EffectiveSeatTickSettings, "reason" | "monitorPrompt" | "updatedAt" | "setBy"> & Partial<Pick<EffectiveSeatTickSettings, "instructionLines" | "maintenanceSetting" | "curationSetting" | "autoRotate" | "release" | "autonomy" | "autonomyHistory">>,
): SeatTickSettings {
  const restored = defaultSeatTickSettings(project);
  if (!lapsed.reason && !lapsed.monitorPrompt && !lapsed.maintenanceSetting && !lapsed.curationSetting && !lapsed.autoRotate && !lapsed.release && !lapsed.autonomy && !lapsed.autonomyHistory?.length) return restored;
  return { ...restored, ...(lapsed.curationSetting ? { curation: lapsed.curationSetting } : {}), ...(lapsed.autonomy ? { autonomy: lapsed.autonomy } : {}), ...(lapsed.autonomyHistory ? { autonomyHistory: lapsed.autonomyHistory } : {}), ...(lapsed.release ? { release: lapsed.release } : {}), ...(lapsed.maintenanceSetting ? { maintenance: lapsed.maintenanceSetting } : {}), ...(lapsed.autoRotate ? { autoRotate: lapsed.autoRotate } : {}), reason: lapsed.reason, ...(lapsed.instructionLines ? { instructionLines: lapsed.instructionLines } : {}), monitorPrompt: lapsed.monitorPrompt, updatedAt: lapsed.updatedAt, setBy: lapsed.setBy };
}

export type SeatTickSettingsChangeResult =
  | { ok: true; settings: SeatTickSettings; notes?: string[] }
  | { ok: false; error: string };

/**
 * Apply one change to a project's settings. Pure, so every refusal is testable
 * without a file.
 *
 * The one thing a change must carry is a REASON whenever it departs from the
 * default. That is not a limit on what may be decided — anything may be
 * decided, including off for ever — it is what keeps a deliberately quiet tick
 * distinguishable from a broken one. Restoring the default needs no reason:
 * the record it clears already said why the tick was quiet.
 */
export function applySeatTickSettingsChange(
  current: SeatTickSettings,
  change: SeatTickSettingsChange,
  context: { at: string; actor: SeatTickSettingsActor; instructionActor?: SeatTickSettingsActor },
): SeatTickSettingsChangeResult {
  if (change.autonomy !== undefined || change.autonomyDecision !== undefined) {
    const effective = effectiveSeatTickSettings(current, Date.parse(context.at), 60 * 60_000);
    if (effective.lapsed) current = seatTickSettingsAfterLapse(current.project, effective);
  }
  const touched = ["enabled", "wakeIntervalMinutes", "reason", "monitorPrompt", "until", "maintenance", "curation", "autoRotate", "release", "autonomy", "autonomyDecision"].filter((key) => Object.hasOwn(change, key));
  if (touched.length === 0) return { ok: false, error: "a tick settings change needs at least one field" };

  const enabled = Object.hasOwn(change, "enabled") ? change.enabled : current.enabled;
  if (typeof enabled !== "boolean") return { ok: false, error: "enabled must be a boolean" };

  let wakeIntervalMinutes = current.wakeIntervalMinutes;
  if (Object.hasOwn(change, "wakeIntervalMinutes")) {
    const raw = change.wakeIntervalMinutes;
    if (raw === null) wakeIntervalMinutes = null;
    else if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
      return { ok: false, error: "wakeIntervalMinutes must be a positive number of minutes, or null for the default" };
    } else if (raw > SEAT_TICK_MAX_WAKE_INTERVAL_MINUTES) {
      return { ok: false, error: `wakeIntervalMinutes must be at most ${SEAT_TICK_MAX_WAKE_INTERVAL_MINUTES}; disable the tick instead of setting a longer interval` };
    } else {
      wakeIntervalMinutes = raw;
    }
  }

  let until = current.until;
  if (Object.hasOwn(change, "until")) {
    const raw = change.until;
    if (raw === null) until = null;
    else if (typeof raw !== "string" || !Number.isFinite(Date.parse(raw))) {
      return { ok: false, error: "until must be an ISO instant, or null for a setting that stands until it is changed" };
    } else {
      until = new Date(Date.parse(raw)).toISOString();
    }
  }

  let reason = current.reason;
  let instructionLines = seatTickInstructionLines(current);
  if (Object.hasOwn(change, "reason")) {
    const author = context.instructionActor ?? context.actor;
    if (author.kind === "unidentified") return { ok: false, error: "instruction writes need an identified author" };
    const raw = change.reason;
    if (raw === null) reason = null;
    else if (typeof raw !== "string") return { ok: false, error: "reason must be a string" };
    else {
      const redacted = redactMonitorText(raw).trim();
      if (raw.length > REASON_LIMIT || redacted.length > REASON_LIMIT) {
        return { ok: false, error: `instructions (reason) are ${raw.length} characters; the limit is ${REASON_LIMIT}. Nothing was stored — shorten the instructions and send them again` };
      }
      reason = redacted || null;
    }
    instructionLines = replaceSeatTickInstructions(current, reason, author, context.at);
    reason = instructionLines.map(line => line.text).join("\n") || null;
    if ((reason?.length ?? 0) > REASON_LIMIT) return { ok: false, error: `instructions (reason) are ${reason!.length} characters; the limit is ${REASON_LIMIT}. Nothing was stored — shorten the instructions and send them again` };
  }

  /* Set, replaced and cleared through this one surface. Like the panel
     instructions it is refused, not clamped, when it runs long
     (#1450): a state note whose tail is dropped silently is a note the seat
     believes it still has. The error names the limit and the given length so
     the writer can shorten it; nothing is stored on a refusal. */
  let monitorPrompt = current.monitorPrompt ?? null;
  if (Object.hasOwn(change, "monitorPrompt")) {
    const raw = change.monitorPrompt;
    if (raw === null) monitorPrompt = null;
    else if (typeof raw !== "string") return { ok: false, error: "monitorPrompt must be a string, or null to clear it" };
    else {
      const redacted = redactMonitorText(raw).trim();
      if (raw.length > SEAT_TICK_PROMPT_LIMIT || redacted.length > SEAT_TICK_PROMPT_LIMIT) {
        return { ok: false, error: `monitorPrompt is ${raw.length} characters; the limit is ${SEAT_TICK_PROMPT_LIMIT}. Nothing was stored — shorten the note and send it again` };
      }
      monitorPrompt = redacted || null;
    }
  }

  let maintenance = current.maintenance;
  const notes: string[] = [];
  if (Object.hasOwn(change, "maintenance")) {
    const raw = change.maintenance;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "maintenance must be an object" };
    const on = Object.hasOwn(raw, "enabled") ? raw.enabled : maintenance?.enabled ?? false;
    if (typeof on !== "boolean") return { ok: false, error: "maintenance.enabled must be a boolean" };
    let hours = maintenance?.intervalHours ?? 3;
    if (Object.hasOwn(raw, "intervalHours")) {
      const given = raw.intervalHours;
      const number = typeof given === "number" ? given : typeof given === "string" && given.trim() ? Number(given) : NaN;
      if (given === null) hours = 3;
      else if (!Number.isFinite(number)) notes.push("maintenance.intervalHours was not a number; kept the stored interval");
      else {
        hours = Math.max(1, Math.min(168, Math.round(number)));
        if (hours !== given) notes.push(`maintenance.intervalHours normalized to ${hours}`);
      }
    }
    maintenance = { enabled: on, intervalHours: hours, updatedAt: context.at, setBy: context.actor };
  }
  let curation = current.curation;
  if (Object.hasOwn(change, "curation")) {
    const raw = change.curation;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "curation must be an object" };
    const on = Object.hasOwn(raw, "enabled") ? raw.enabled : curation?.enabled ?? true;
    if (typeof on !== "boolean") return { ok: false, error: "curation.enabled must be a boolean" };
    let hours = curation?.intervalHours ?? 6;
    if (Object.hasOwn(raw, "intervalHours")) {
      const given = raw.intervalHours;
      const number = typeof given === "number" ? given : typeof given === "string" && given.trim() ? Number(given) : NaN;
      if (given === null) hours = 6;
      else if (!Number.isFinite(number)) notes.push("curation.intervalHours was not a number; kept the stored interval");
      else {
        hours = Math.max(1, Math.min(168, Math.round(number)));
        if (hours !== given) notes.push(`curation.intervalHours normalized to ${hours}`);
      }
    }
    curation = { enabled: on, intervalHours: hours, updatedAt: context.at, setBy: context.actor };
  }
  let autoRotate = current.autoRotate;
  if (Object.hasOwn(change, "autoRotate")) {
    const raw = change.autoRotate;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "autoRotate must be an object" };
    const on = Object.hasOwn(raw, "enabled") ? raw.enabled : autoRotate?.enabled ?? false;
    if (typeof on !== "boolean") return { ok: false, error: "autoRotate.enabled must be a boolean" };
    const why = typeof raw.why === "string" ? redactMonitorText(raw.why).trim().slice(0, 200) || null : null;
    if (context.actor.kind !== "gateway" && !why) return { ok: false, error: "autoRotate.why is required: say why automatic rotation is being changed and on whose request" };
    let percent = autoRotate?.thresholdPercent ?? AUTO_ROTATE_DEFAULT_PERCENT;
    if (Object.hasOwn(raw, "thresholdPercent")) {
      const given = raw.thresholdPercent;
      const number = typeof given === "number" ? given : typeof given === "string" && given.trim() ? Number(given) : NaN;
      if (given === null) percent = AUTO_ROTATE_DEFAULT_PERCENT;
      else if (!Number.isFinite(number)) notes.push("autoRotate.thresholdPercent was not a number; kept the stored threshold");
      else {
        percent = Math.max(50, Math.min(90, Math.round(number)));
        if (percent !== given) notes.push(`autoRotate.thresholdPercent normalized to ${percent}`);
      }
    }
    autoRotate = { enabled: on, thresholdPercent: percent, updatedAt: context.at, setBy: context.actor, why };
  }
  let release = current.release;
  if (Object.hasOwn(change, "release")) {
    try { release = changeRelease(release, change.release!, context, current.project); }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : "invalid release change" }; }
  }
  let autonomy = endedAutonomy(current.autonomy, Date.parse(context.at));
  const autonomyHistory = [...(current.autonomyHistory ?? [])];
  if (Object.hasOwn(change, "autonomy")) {
    try {
      const next = changeAutonomy(autonomy, change.autonomy!, context, current.project, enabled);
      if (autonomy && next?.startedAt !== autonomy.startedAt) autonomyHistory.push(autonomy);
      autonomy = next;
    } catch (error) { return { ok: false, error: (error as Error).message }; }
  }
  if (autonomy?.enabled && !enabled) {
    try { autonomy = changeAutonomy(autonomy, { enabled: false, why: change.reason ?? current.reason ?? "Wakes turned off" }, context, current.project, false); }
    catch (error) { return { ok: false, error: (error as Error).message }; }
  }
  if (change.autonomyDecision !== undefined) {
    const d = change.autonomyDecision;
    if (context.actor.kind !== "manager" || context.actor.project !== current.project) return { ok: false, error: "only this project's seat records autonomous decisions" };
    if (!autonomy || !autonomyActive(autonomy, Date.parse(context.at)) || d?.startedAt !== autonomy.startedAt) return { ok: false, error: "this autonomy episode is no longer active" };
    if (!d || ["id", "decision", "why", "undo"].some(key => typeof d[key as keyof typeof d] !== "string" || !String(d[key as keyof typeof d]).trim() || String(d[key as keyof typeof d]).length > 2000)) return { ok: false, error: "autonomyDecision needs id, decision, why and undo (1–2000 characters each)" };
    if (d.taskId !== undefined && (typeof d.taskId !== "string" || !d.taskId || d.taskId.length > 200)) return { ok: false, error: "invalid autonomyDecision.taskId" };
    const decision = { id: d.id, decision: redactMonitorText(d.decision), why: redactMonitorText(d.why), undo: redactMonitorText(d.undo), ...(d.taskId ? { taskId: d.taskId } : {}), ...(d.review ? { review: d.review, reviewState: "pending" as const } : {}) };
    const prior = autonomy.decisions.find(entry => entry.id === d.id);
    if (prior && (["decision", "why", "undo", "taskId"].some(key => prior[key as keyof typeof prior] !== decision[key as keyof typeof decision]) || JSON.stringify(prior.review) !== JSON.stringify(d.review))) return { ok: false, error: "autonomous decision id already records different content" };
    if (!prior) autonomy = { ...autonomy, decisions: [...autonomy.decisions, { ...decision, at: context.at, by: context.actor }] };
  }
  /* Logging a decision is not an edit of the settings: the row keeps the
     operator's last real change as its editor, and the decision keeps its own author. */
  const decisionOnly = Object.keys(change).every(key => key === "autonomyDecision" || change[key as keyof SeatTickSettingsChange] === undefined);
  const next: SeatTickSettings = {
    ...(autonomy ? { autonomy } : {}),
    ...(autonomyHistory.length ? { autonomyHistory } : {}),
    ...(release ? { release } : {}),
    project: current.project,
    ...(maintenance ? { maintenance } : {}),
    ...(curation ? { curation } : {}),
    ...(autoRotate ? { autoRotate } : {}),
    enabled,
    wakeIntervalMinutes,
    reason,
    monitorPrompt,
    until,
    updatedAt: decisionOnly ? current.updatedAt : context.at,
    setBy: decisionOnly ? current.setBy : context.actor,
    ...(instructionLines.length || current.instructionLines ? { instructionLines } : {}),
  };
  if (!seatTickSettingsAreDefault(next) && !next.reason) {
    return { ok: false, error: "instructions (reason) are required when the tick is disabled or its wake interval changes. Write what the seat should do and when it should stop; a quiet tick without instructions is indistinguishable from a broken one" };
  }
  /* Restoring a schedule clears its interval and expiry. The panel's
     instructions and the seat's own note stand until explicitly cleared;
     both are delivered independently of the cadence. */
  if (seatTickSettingsAreDefault(next)) {
    return { ok: true, settings: { ...next, wakeIntervalMinutes: null, until: null }, ...(notes.length ? { notes } : {}) };
  }
  return { ok: true, settings: next, ...(notes.length ? { notes } : {}) };
}

/** Where a line edit lands in the note; see {@link LineTarget}. */
export type SeatTickNoteLineTarget = LineTarget;

/**
 * Edits to one line of the monitor note (#2030), so a seat keeping its lane
 * ledger there changes a lane line by sending that line, never the whole note:
 * rewriting a 2.3 KB note to change one line cost one seat 337 KB of input.
 * Applied in this order, each against the note as the previous one left it.
 */
export type SeatTickNoteLineEdits = LineEdits;

/** The note after its line edits, or why they were refused. Pure: the stored
    note is handed in, and the result is written through
    {@link applySeatTickSettingsChange} like a whole new note, under the same
    limit and redaction. An edit that leaves nothing clears the note. */
export function applySeatTickNoteLineEdits(
  note: string | null,
  edits: SeatTickNoteLineEdits,
): { ok: true; monitorPrompt: string | null } | { ok: false; error: string } {
  const edited = applyLineEdits(note, edits, "the note");
  return edited.ok ? { ok: true, monitorPrompt: edited.value } : { ok: false, error: edited.error };
}

/** A report acknowledgement merges into the latest row, preserving concurrent edits. */
export function markAutonomyReported(project: string, startedAt: string, at: string, filePath = seatTickSettingsPath()): void {
  settingsStore.mutate(filePath, file => {
    const current = file.projects[project];
    if (!current) throw new Error("autonomy episode not found");
    const mark = (episode: AutonomySetting) => episode.startedAt === startedAt ? { ...endedAutonomy(episode, Date.parse(at))!, reportAt: at } : episode;
    const next = { ...current, ...(current.autonomy ? { autonomy: mark(current.autonomy) } : {}),
      ...(current.autonomyHistory ? { autonomyHistory: current.autonomyHistory.map(mark) } : {}) };
    return { next: { ...file, projects: { ...file.projects, [project]: next } }, result: undefined };
  });
}

/** Apply against the locked row so an extension cannot overwrite a decision or an end report. */
export function changeSeatTickSettings(project: string, change: SeatTickSettingsChange, context: { at: string; actor: SeatTickSettingsActor; instructionActor?: SeatTickSettingsActor }, filePath = seatTickSettingsPath()): SeatTickSettingsChangeResult {
  return settingsStore.mutate(filePath, file => {
    const result = applySeatTickSettingsChange(file.projects[project] ?? defaultSeatTickSettings(project), change, context);
    return { next: result.ok ? { ...file, projects: { ...file.projects, [project]: result.settings } } : file, result };
  });
}

export function expireSeatAutonomy(project: string, now: number, filePath = seatTickSettingsPath()): void {
  settingsStore.mutate(filePath, file => {
    const current = file.projects[project];
    if (!current?.autonomy?.enabled || autonomyActive(current.autonomy, now)) return { next: file, result: undefined };
    return { next: { ...file, projects: { ...file.projects, [project]: { ...current, autonomy: endedAutonomy(current.autonomy, now) } } }, result: undefined };
  });
}

/** Re-read under the store lock: schedule expiry must preserve intervening autonomy edits. */
export function expireSeatSchedule(project: string, now: number, interval: number, filePath = seatTickSettingsPath()): void {
  settingsStore.mutate(filePath, file => {
    const current = file.projects[project];
    if (!current) return { next: file, result: undefined };
    const effective = effectiveSeatTickSettings(current, now, interval);
    if (!effective.lapsed) return { next: file, result: undefined };
    return { next: { ...file, projects: { ...file.projects, [project]: seatTickSettingsAfterLapse(project, effective) } }, result: undefined };
  });
}

/** Form settlement is independently durable; retain failed attempts and allow the same id to retry. */
export function markAutonomyDecisionReview(project: string, startedAt: string, id: string, reviewState: "decided" | "refused", filePath = seatTickSettingsPath()): void {
  settingsStore.mutate(filePath, file => {
    const current = file.projects[project];
    if (!current) throw new Error("autonomy episode not found");
    const mark = (episode: AutonomySetting) => episode.startedAt === startedAt ? { ...episode, decisions: episode.decisions.map(d => d.id === id ? { ...d, reviewState } : d) } : episode;
    const next = { ...current, ...(current.autonomy ? { autonomy: mark(current.autonomy) } : {}), ...(current.autonomyHistory ? { autonomyHistory: current.autonomyHistory.map(mark) } : {}) };
    return { next: { ...file, projects: { ...file.projects, [project]: next } }, result: undefined };
  });
}
