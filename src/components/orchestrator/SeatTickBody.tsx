"use client";

import { ArrowUpRight, LoaderCircle, RotateCcw } from "lucide-react";
import { useLayoutEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";

import { Select } from "@/components/ui/Select";
import { requestAccountPanel } from "@/lib/accounts/openPanel";
import type { CurationAnswer } from "@/lib/memory/curation/answer";
import type { BoardMaintenanceAnswer } from "@/lib/boardMaintenance/answer";
import { useLocale, type MessageKey } from "@/lib/i18n";
import { operatorInstructionText, seatTickInstructionLines } from "@/lib/monitor/seatTickInstructions";
import type { SeatTickSettingsAnswer } from "@/lib/monitor/seatTickSettingsAnswer";

import { autonomyActive, type AutonomySetting } from "@/lib/monitor/autonomy";
const AUTONOMY_HOURS = [8, 12, 24, Infinity];
type AutonomyView = { state: "off" | "timed" | "unlimited"; until: string | null; startedAt: string | null; episode: AutonomySetting | null };
function autonomyView(record: SeatTickSettingsAnswer | null): AutonomyView {
  const episode = record?.autonomy?.episode ?? null;
  return { state: !autonomyActive(episode, Date.now()) ? "off" : episode?.until ? "timed" : "unlimited", until: episode?.until ?? null, startedAt: episode?.startedAt ?? null, episode };
}
import { maintenanceReading, seatTickAge, seatTickLocalTime, seatTickReading, type MaintenanceReading, type SeatTickReading, type StatusSegment } from "./seatTickView";
import { runtimeForEngine, runtimeForModel, useMaintainerRole, type MaintainerRoleRead, type MaintainerRuntime } from "./useMaintainerRole";
import type { SeatTickChange, SeatTickSettingsRead } from "./useSeatTickSettings";

/*
 * What is inside the seat tick popover and inside the seat tick sheet — the
 * same content in the same order on both surfaces (#1681), because the desktop
 * and the phone are showing one record and there is no second thing to say
 * about it on a smaller screen:
 *
 *   1. the head: the project;
 *   2. STATUS, read only and first: one line for the wakes, one for board
 *      maintenance, so the panel answers «is it working» before it offers to
 *      change anything;
 *   3. ORCHESTRATOR WAKES, editable: the switch, and only the fields that
 *      matter for the draft in hand;
 *   4. BOARD MAINTENANCE (#2162), editable: its switch, its interval and the
 *      agent that runs it — one source of truth with Settings → agent mapping;
 *   5. AUTO-ROTATION: its switch and context threshold;
 *   6. one Save for all of it, shown only while something changed;
 *   7. Details, closed — the board card, who set it, the monitor prompt, the
 *      last delivery.
 *
 * Two things differ by surface and nothing else does. Control sizing: the
 * phone gives every hit target 44 px (mobile v2 §5), which the incumbent row
 * on the desktop cannot spend. And WHERE the Save goes: the popover renders it
 * under the form, the sheet parks it in its footer at the thumb — which is why
 * the draft lives in `useSeatTickDraft`, above both, rather than inside this
 * component where a footer could not reach it.
 *
 * Nothing here validates. Every rule about what a tick setting may be lives in
 * `applySeatTickSettingsChange`, and its refusal is shown verbatim next to
 * Save — a copy of the rule in this file is exactly how the two would drift.
 */

/** The expiries offered, in minutes. `""` is the setting that stands until
    someone changes it; `keep` appears only while the record already carries
    one, and sends nothing. */
const UNTIL_CHOICES = [
  { value: "", key: "seatTick.untilStands" },
  { value: "60", key: "seatTick.until1h" },
  { value: "240", key: "seatTick.until4h" },
  { value: "1440", key: "seatTick.until24h" },
  { value: "10080", key: "seatTick.until7d" },
] as const;

export interface SeatTickDraft {
  enabled: boolean;
  /** Minutes as typed. Empty means the default interval. */
  interval: string;
  until: string;
  reason: string;
}

function draftOf(record: SeatTickSettingsAnswer | null): SeatTickDraft {
  const settings = record?.settings;
  return {
    enabled: settings ? settings.enabled : true,
    interval: settings == null || settings.wakeIntervalMinutes === null ? "" : String(settings.wakeIntervalMinutes),
    until: settings?.until ? "keep" : "",
    reason: settings ? operatorInstructionText(settings) : "",
  };
}

/** The record the draft was adopted from. A new one means the record moved —
    a save landed, or another caller changed this project's tick — and the
    fields follow it. An optimistic overlay is NOT one of these, so a refused
    save rolls the display back without emptying the field being corrected.

    `updatedAt` is left out on purpose: the server moves it on EVERY write to
    the project's settings, a maintenance-only one included, so keeping it here
    would snap the tick's unsaved fields back to the stored values whenever a
    maintenance save settles. Every field a tick save can change is already
    in the signature (an expiry that is set again carries a new `until`). */
function signatureOf(record: SeatTickSettingsAnswer | null): string {
  const settings = record?.settings;
  if (!settings) return "";
  return [record?.project, settings.enabled, settings.wakeIntervalMinutes, operatorInstructionText(settings), settings.until].join("");
}

/** Only what CHANGED, so a save touches the fields the operator touched and
    the module's «a change needs at least one field» stays meaningful. */
function changeOf(draft: SeatTickDraft, record: SeatTickSettingsAnswer | null): SeatTickChange {
  const current = draftOf(record);
  const change: SeatTickChange = {};
  if (draft.enabled !== current.enabled) change.enabled = draft.enabled;
  if (draft.interval.trim() !== current.interval) {
    const raw = draft.interval.trim();
    const parsed = Number(raw);
    /* Empty is the DEFAULT interval, which the module spells `null`.
       Everything else is handed over for the module to judge — and a
       non-finite entry («abc», «1e400») is handed over AS TYPED rather than as
       `Number(raw)`: NaN and Infinity both serialise to JSON `null`, which the
       module reads as «restore the default», so coercing here would silently
       discard the operator's interval instead of showing them the refusal that
       names it. */
    change.wakeIntervalMinutes = raw === "" ? null : Number.isFinite(parsed) ? parsed : raw;
  }
  if (draft.reason.trim() !== current.reason.trim()) change.reason = draft.reason.trim() || null;
  if (draft.until !== current.until) change.untilMinutes = draft.until === "" ? null : Number(draft.until);
  return change;
}

/** The maintenance timer's fields as the operator has them in hand. The
    interval is the stored number as typed, so «3» is on screen when nothing was
    ever set — the default is the value, not a placeholder to read around. */
export interface MaintenanceDraft {
  enabled: boolean;
  hours: string;
}

function maintenanceDraftOf(maintenance: BoardMaintenanceAnswer | undefined): MaintenanceDraft {
  return { enabled: maintenance?.enabled ?? false, hours: String(maintenance?.intervalHours ?? 3) };
}

/** Moves when the stored timer does. `updatedAt` moves on every write, so a
    save the server clamped to the value already stored still resets the field
    to what the record holds. */
function maintenanceSignatureOf(record: SeatTickSettingsAnswer | null): string {
  const m = record?.maintenance;
  return m ? [record?.project, m.enabled, m.intervalHours, m.updatedAt].join("") : "";
}

function maintenanceChangeOf(draft: MaintenanceDraft, maintenance: Pick<BoardMaintenanceAnswer, "enabled" | "intervalHours"> | undefined): NonNullable<SeatTickChange["maintenance"]> {
  const change: NonNullable<SeatTickChange["maintenance"]> = {};
  if (!maintenance) return change;
  const current = { enabled: maintenance.enabled, hours: String(maintenance.intervalHours) };
  if (draft.enabled !== current.enabled) change.enabled = draft.enabled;
  if (draft.hours.trim() !== current.hours) {
    const raw = draft.hours.trim();
    const parsed = Number(raw);
    /* As for the tick's interval: empty is the default (`null`), a number goes
       as a number, and anything else goes AS TYPED so the server names it
       rather than a coerced NaN serialising to `null` and quietly restoring
       the default. The server clamps 1..168 and says so; no copy of that rule
       is kept here. */
    change.intervalHours = raw === "" ? null : Number.isFinite(parsed) ? parsed : raw;
  }
  return change;
}

export interface AutoRotateDraft { enabled: boolean; percent: string }
function autoRotateDraftOf(record: SeatTickSettingsAnswer | null): AutoRotateDraft {
  return { enabled: record?.autoRotate?.enabled ?? false, percent: String(record?.autoRotate?.thresholdPercent ?? 50) };
}
function autoRotateSignatureOf(record: SeatTickSettingsAnswer | null): string {
  const a = record?.autoRotate;
  return a ? [record?.project, a.enabled, a.thresholdPercent, a.updatedAt].join("") : "";
}
function autoRotateChangeOf(draft: AutoRotateDraft, record: SeatTickSettingsAnswer | null): NonNullable<SeatTickChange["autoRotate"]> {
  const current = autoRotateDraftOf(record);
  const change: NonNullable<SeatTickChange["autoRotate"]> = {};
  if (draft.enabled !== current.enabled) change.enabled = draft.enabled;
  if (draft.percent.trim() !== current.percent) {
    const raw = draft.percent.trim();
    const parsed = Number(raw);
    change.thresholdPercent = raw === "" ? null : Number.isFinite(parsed) ? parsed : raw;
  }
  return change;
}

interface ReleaseDraft { enabled: boolean; ask: boolean; changes: string; hours: string; clearHold: boolean }
function releaseDraftOf(record: SeatTickSettingsAnswer | null): ReleaseDraft {
  return { enabled: record?.release?.enabled ?? false, ask: record?.release?.askBeforePublish ?? true,
    changes: String(record?.release?.minChanges ?? 30), hours: String(record?.release?.minGapHours ?? 12), clearHold: false };
}
function releaseChangeOf(draft: ReleaseDraft, record: SeatTickSettingsAnswer | null): NonNullable<SeatTickChange["release"]> {
  const current = releaseDraftOf(record); const change: NonNullable<SeatTickChange["release"]> = {};
  if (draft.enabled !== current.enabled) change.enabled = draft.enabled;
  if (draft.ask !== current.ask) change.askBeforePublish = draft.ask;
  const number = (value: string) => !value.trim() ? null : Number.isFinite(Number(value)) ? Number(value) : value;
  if (draft.changes !== current.changes) change.minChanges = number(draft.changes);
  if (draft.hours !== current.hours) change.minGapHours = number(draft.hours);
  if (draft.clearHold) change.hold = null;
  return change;
}

/** (docs/design/full-autonomy-mode.md §2.3): the «Повна автономія»
    draft. `hours` is a value of the «Тривалість» select: `keep` the stored
    end, a number of hours from now, or `unlimited`. */
export interface AutonomyDraft { enabled: boolean; hours: string }
function autonomyDraftOf(stored: AutonomyView): AutonomyDraft {
  return stored.state === "off" ? { enabled: false, hours: "8" } : { enabled: true, hours: "keep" };
}

const sameRuntime = (left: MaintainerRuntime, right: MaintainerRuntime) =>
  left.engine === right.engine && left.model === right.model && left.effort === right.effort;

export interface SeatTickDraftState {
  release: ReleaseDraft;
  setRelease: Dispatch<SetStateAction<ReleaseDraft>>;
  draft: SeatTickDraft;
  setDraft: Dispatch<SetStateAction<SeatTickDraft>>;
  autoRotate: AutoRotateDraft;
  setAutoRotate: Dispatch<SetStateAction<AutoRotateDraft>>;
  autonomy: AutonomyDraft;
  setAutonomy: Dispatch<SetStateAction<AutonomyDraft>>;
  storedAutonomy: AutonomyView;
  curation: MaintenanceDraft;
  setCuration: Dispatch<SetStateAction<MaintenanceDraft>>;
  maintenance: MaintenanceDraft;
  setMaintenance: Dispatch<SetStateAction<MaintenanceDraft>>;
  /** The maintainer's runtime as drafted: the stored one until the operator
      picks another. Null until the agent mapping has been read. */
  runtime: MaintainerRuntime | null;
  setRuntime: (runtime: MaintainerRuntime) => void;
  maintainer: MaintainerRoleRead;
  /** A refusal of the maintainer's runtime write, shown beside the picker. */
  runtimeError: string | null;
  /** The tick and maintenance changes: one request. */
  change: SeatTickChange;
  /** Anything in the panel differs from what is stored. */
  dirty: boolean;
  saving: boolean;
  /** One Save for the panel. The tick settings and the agent mapping are two
      stores and so two writes; each lands or is refused on its own, a write
      that lands leaves the draft, and one that does not keeps it. */
  save: () => Promise<void>;
}

/**
 * The panel's drafts, bound to the STORED records (the issue: «a form bound to
 * the stored record, never to the echo of a send»).
 *
 * Held above the body so the phone can put Save in its sheet footer and the
 * desktop can put it under the form, without either surface holding a second
 * draft.
 */
export function useSeatTickDraft(read: SeatTickSettingsRead): SeatTickDraftState {
  const record = read.record;
  const [draft, setDraft] = useState<SeatTickDraft>(() => draftOf(record));
  const [adopted, setAdopted] = useState<string>(() => signatureOf(record));
  const signature = signatureOf(record);
  if (signature !== adopted) {
    /* Render-phase adoption: the record moved, so the fields move with it
       before this commit paints a form bound to a record nobody holds. */
    setAdopted(signature);
    setDraft(draftOf(record));
  }

  const [maintenance, setMaintenance] = useState<MaintenanceDraft>(() => maintenanceDraftOf(record?.maintenance));
  const [maintenanceAdopted, setMaintenanceAdopted] = useState(() => maintenanceSignatureOf(record));
  const maintenanceSignature = maintenanceSignatureOf(record);
  if (maintenanceSignature !== maintenanceAdopted) {
    setMaintenanceAdopted(maintenanceSignature);
    setMaintenance(maintenanceDraftOf(record?.maintenance));
  }

  const [curation, setCuration] = useState<MaintenanceDraft>(() => ({ enabled: record?.curation?.enabled ?? true, hours: String(record?.curation?.intervalHours ?? 6) }));
  const curationSignature = JSON.stringify([record?.project, record?.curation?.enabled, record?.curation?.intervalHours, record?.curation?.updatedAt]);
  const [curationAdopted, setCurationAdopted] = useState(curationSignature);
  if (curationSignature !== curationAdopted) {
    setCurationAdopted(curationSignature);
    setCuration({ enabled: record?.curation?.enabled ?? true, hours: String(record?.curation?.intervalHours ?? 6) });
  }
  const [autoRotate, setAutoRotate] = useState(() => autoRotateDraftOf(record));
  const [autoAdopted, setAutoAdopted] = useState(() => autoRotateSignatureOf(record));
  const autoSignature = autoRotateSignatureOf(record);
  if (autoSignature !== autoAdopted) { setAutoAdopted(autoSignature); setAutoRotate(autoRotateDraftOf(record)); }
  const storedAutonomy = autonomyView(record);
  const [autonomy, setAutonomy] = useState(() => autonomyDraftOf(storedAutonomy));
  const autonomyRevision = JSON.stringify([storedAutonomy.state, storedAutonomy.until, storedAutonomy.startedAt, storedAutonomy.episode?.updatedAt]);
  const [autonomyAdopted, setAutonomyAdopted] = useState(autonomyRevision);
  if (autonomyRevision !== autonomyAdopted) { setAutonomyAdopted(autonomyRevision); setAutonomy(autonomyDraftOf(storedAutonomy)); }
  const autonomyBase = autonomyDraftOf(storedAutonomy);
  const autonomyDirty = autonomy.enabled !== autonomyBase.enabled || (autonomy.enabled && autonomy.hours !== autonomyBase.hours);
  const [release, setRelease] = useState(() => releaseDraftOf(record));
  const releaseSignature = JSON.stringify([record?.release?.updatedAt, releaseDraftOf(record)]);
  const [releaseAdopted, setReleaseAdopted] = useState(releaseSignature);
  if (releaseSignature !== releaseAdopted) { setReleaseAdopted(releaseSignature); setRelease(releaseDraftOf(record)); }
  const maintainer = useMaintainerRole(true);
  const [runtimeDraft, setRuntimeDraft] = useState<MaintainerRuntime | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [roleSaving, setRoleSaving] = useState(false);
  const stored: MaintainerRuntime | null = maintainer.config
    ? { engine: maintainer.config.engine, model: maintainer.config.model, effort: maintainer.config.effort }
    : null;
  const runtime = runtimeDraft ?? stored;
  const roleDirty = !!runtimeDraft && !!stored && !sameRuntime(runtimeDraft, stored);

  const tickChange = changeOf(draft, record);
  const curationChange = maintenanceChangeOf(curation, record?.curation);
  const maintenanceChange = maintenanceChangeOf(maintenance, record?.maintenance);
  const maintenanceDirty = Object.keys(maintenanceChange).length > 0;
  const autoChange = autoRotateChangeOf(autoRotate, record);
  const releaseChange = releaseChangeOf(release, record);
  const change: SeatTickChange = { ...(autonomyDirty ? { autonomy: { enabled: autonomy.enabled, ...(autonomy.enabled && autonomy.hours !== "keep" ? { hours: autonomy.hours === "unlimited" ? null : Number(autonomy.hours) } : {}) } } : {}), ...(Object.keys(releaseChange).length ? { release: releaseChange } : {}), ...tickChange, ...(Object.keys(curationChange).length ? { curation: curationChange } : {}), ...(maintenanceDirty ? { maintenance: maintenanceChange } : {}), ...(Object.keys(autoChange).length ? { autoRotate: autoChange } : {}) };
  const requestDirty = Object.keys(change).length > 0;

  const save = async () => {
    if (read.saving || roleSaving) return;
    setRuntimeError(null);
    if (requestDirty) await read.save(change);
    if (roleDirty && runtimeDraft) {
      /* The picker shows the new runtime as stored at once; a refusal puts the
         operator's choice back as a draft beside the reason. A mapping that
         moved under the panel shows the current value instead. */
      const drafted = runtimeDraft;
      setRuntimeDraft(null);
      setRoleSaving(true);
      const result = await maintainer.save(drafted);
      setRoleSaving(false);
      if (!result.ok) setRuntimeError(result.error);
      if (!result.ok && !result.stale) setRuntimeDraft(drafted);
    }
  };

  return {
    release, setRelease,
    draft,
    setDraft,
    curation, setCuration,
    maintenance,
    setMaintenance,
    autoRotate,
    setAutoRotate,
    autonomy,
    setAutonomy,
    storedAutonomy,
    runtime,
    setRuntime: (next) => {
      setRuntimeError(null);
      setRuntimeDraft(next);
    },
    maintainer,
    runtimeError,
    change,
    dirty: requestDirty || roleDirty || autonomyDirty,
    saving: read.saving || roleSaving,
    save,
  };
}

const DOT: Record<SeatTickReading["tone"], string> = {
  ok: "bg-success",
  warn: "bg-warning",
  muted: "bg-muted",
  unknown: "border border-strong bg-transparent",
};

/** The tone dot: the ACTUAL state, and never the schedule. */
export function SeatTickDot({ tone, className = "" }: { tone: SeatTickReading["tone"]; className?: string }) {
  return <span aria-hidden data-seat-tick-dot={tone} className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[tone]} ${className}`} />;
}

/** The panel's one Save, and the refusal of the write it sent. Rendered by the
    popover under the form and by the sheet in its footer; it renders nothing
    while nothing changed and nothing was refused. */
export function SeatTickActions({ read, state, surface }: {
  read: SeatTickSettingsRead;
  state: SeatTickDraftState;
  surface: "desktop" | "mobile";
}) {
  const { t } = useLocale();
  const phone = surface === "mobile";
  if (!state.dirty && !read.error) return null;
  const overLimit = read.error?.match(/^instructions \(reason\) are (\d+) characters; the limit is 500\. Nothing was stored — shorten the instructions and send them again$/);
  const instructionsRequired = read.error === "instructions (reason) are required when the tick is disabled or its wake interval changes. Write what the seat should do and when it should stop; a quiet tick without instructions is indistinguishable from a broken one";
  const error = overLimit
    ? t("seatTick.instructionsOverLimitError", { count: Number(overLimit[1]) })
    : instructionsRequired
      ? t("seatTick.instructionsRequiredError")
      : read.error;
  /* Written out rather than interpolated: a Tailwind class assembled from a
     variable is a class Tailwind never sees and never emits. */
  const button = phone
    ? "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-control px-3 text-body font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50"
    : "inline-flex h-7 items-center justify-center gap-1.5 rounded-control px-3 text-ui font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50";
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      {read.error ? (
        <p role="alert" data-seat-tick-error className="rounded-control border border-danger/40 bg-danger/10 px-2 py-1.5 text-ui leading-4 text-danger">
          {error}
        </p>
      ) : null}
      {state.dirty ? (
        <button
          type="button"
          data-seat-tick-save
          disabled={!read.record || state.saving}
          onClick={() => void state.save()}
          className={`${button} min-w-0 border border-brand bg-brand text-on-brand shadow-1 active:opacity-90`}
        >
          {state.saving ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
          <span className="truncate">{t(state.saving ? "seatTick.saving" : "seatTick.save")}</span>
        </button>
      ) : null}
    </div>
  );
}

function Toggle({ on, label, phone, disabled, attr, onToggle }: {
  on: boolean;
  label: string;
  phone: boolean;
  disabled: boolean;
  attr: Record<string, string>;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      {...attr}
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
      className={`relative ${phone ? "h-7 w-12" : "h-5 w-9"} shrink-0 rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50 ${
        on ? "border-accent bg-accent" : "border-border bg-sunken"
      }`}
    >
      <span
        aria-hidden
        className={`absolute top-0.5 ${phone ? "h-5 w-5" : "h-3.5 w-3.5"} rounded-full bg-card shadow-1 transition-all ${
          on ? (phone ? "left-6" : "left-[18px]") : "left-0.5"
        }`}
      />
    </button>
  );
}

/** A line of status: its dot beside the FIRST line of the text, and an
    optional second line under it. */
function StatusLine({ tone, headline, attr, children, dot }: {
  tone: SeatTickReading["tone"];
  headline: string;
  attr: Record<string, string>;
  children?: ReactNode;
  /** A dot in a colour of its own, in place of the tone's. */
  dot?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <p {...attr} className="flex min-w-0 items-start gap-1.5 text-ui text-primary">
        {dot ?? <SeatTickDot tone={tone} className="mt-[5px]" />}
        <span className="min-w-0 break-words">{headline}</span>
      </p>
      {children}
    </div>
  );
}

const LINK = "inline-flex items-center gap-0.5 font-semibold text-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";

/** The segments of a status line, joined by a middle dot that stays on the
    line of the segment it follows, so a wrapped line never starts with one. A
    link segment opens what it names: the run's card, or the accounts surface.
    On the phone a link keeps its 44 px hit area through negative margins, so
    the hit area does not stretch the line it sits in. */
function Segments({ segments, phone, onOpened }: { segments: readonly StatusSegment[]; phone: boolean; onOpened?: (() => void) | undefined }) {
  if (segments.length === 0) return null;
  return (
    <p className="pl-3 text-caption leading-4 text-muted">
      {segments.map((segment, index) => (
        <span key={`${segment.kind}-${index}`}>
          {index > 0 ? " " : null}
          {segment.kind === "text" ? (
            <span>{segment.text}</span>
          ) : (
            <button
              type="button"
              data-seat-tick-status-link={segment.kind}
              onClick={() => {
                if (segment.kind === "card") openMaintenanceCard(segment.taskId);
                else requestAccountPanel(segment.engine, "");
                onOpened?.();
              }}
              className={`${LINK} ${phone ? "min-h-11 -my-3.5" : ""}`}
            >
              <span>{segment.text}</span>
              <ArrowUpRight className="h-3 w-3 shrink-0" aria-hidden />
            </button>
          )}
          {index < segments.length - 1 ? "\u00A0·" : null}
        </span>
      ))}
    </p>
  );
}

export function SeatTickBody({ project, projectName, read, state, surface, actions, onOpenedCard }: {
  project: string;
  projectName: string;
  read: SeatTickSettingsRead;
  state: SeatTickDraftState;
  surface: "desktop" | "mobile";
  /** Where this surface puts Save. Null on the phone, whose sheet footer
      renders the same node at the thumb. */
  actions: ReactNode;
  /** Called after a status link opened a card or the accounts: the popover
      closes itself so it does not sit over what it opened. */
  onOpenedCard?: () => void;
}) {
  const { t, locale } = useLocale();
  // eslint-disable-next-line react-hooks/purity -- this snapshot only formats the current status reading.
  const now = Date.now();
  const reading = seatTickReading(read, now, t);
  const record = read.record;
  const { draft, setDraft } = state;
  const maintenance = record?.maintenance;
  const maintenanceView = maintenanceReading(maintenance, now, locale, t, state.maintainer.config?.engine === "claude" ? "claude" : "codex");

  const instructionLines = record ? seatTickInstructionLines(record.settings) : [];
  const protectedLines = instructionLines.filter(line => line.author?.kind !== "gateway");
  const hasUnknownInstructions = instructionLines.some(line => !line.author || line.author.kind === "unidentified");
  const hasSeatInstructions = protectedLines.some(line => line.author?.kind === "manager" || line.author?.kind === "agent");
  const instructionLength = draft.reason.length + protectedLines.map(line => line.text).join("\n").length
    + (draft.reason && protectedLines.length ? 1 : 0);
  const phone = surface === "mobile";
  const reasonRef = useRef<HTMLTextAreaElement>(null);

  /* The field can contain a standing instruction. Grow it on every draft
     change, and when a saved value is loaded, so reopening the panel shows
     the whole note without making a long instruction take over the panel. */
  useLayoutEffect(() => {
    const field = reasonRef.current;
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${field.scrollHeight + 2}px`;
  }, [draft.reason]);
  const storedUntil = record?.settings.until ?? null;
  const row = phone ? "min-h-11" : "min-h-7";
  const control = phone
    ? "h-11 rounded-control border border-border bg-card px-2.5 text-body text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
    : "h-7 rounded-control border border-border bg-card px-2 text-ui text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";

  /* Until belongs to a tick that leaves the defaults. Instructions stand at
     every cadence. The interval is shown while wakes are enabled. */
  const leavesDefaults = !draft.enabled || draft.interval.trim() !== "";
  const typedInterval = Number(draft.interval);
  const checkEvery = record?.policy.checkIntervalMinutes ?? null;
  const intervalHint = !record
    ? null
    : checkEvery === null
      ? t("seatTick.intervalHintChecksOff")
      : draft.interval.trim() !== "" && Number.isFinite(typedInterval) && typedInterval < checkEvery
        ? t("seatTick.intervalHint", { every: checkEvery })
        : null;

  return (
    <div
      data-seat-tick-body={project}
      data-seat-tick-state={reading.state}
      className={`flex min-w-0 flex-col gap-3 ${phone ? "px-4 pb-3" : "p-3"}`}
    >
      {/* The phone's sheet header already says «Seat tick · <project>», so
          repeating it here is the same line twice in 44 px of vertical room.
          The desktop popover has no header of its own, so it keeps it. */}
      {phone ? null : (
        <p className="min-w-0 truncate text-label font-semibold text-secondary" title={projectName}>
          {t("seatTick.head", { project: projectName })}
        </p>
      )}

      {/* STATUS — read only, first, and each fact once. */}
      <div data-seat-tick-status className="flex min-w-0 flex-col gap-1.5">
        <StatusLine tone={reading.tone} headline={reading.status.headline} attr={{ "data-seat-tick-summary": "" }}>
          {reading.status.detail ? (
            <p data-seat-tick-status-detail className="pl-3 text-caption leading-4 text-muted">{reading.status.detail}</p>
          ) : null}
        </StatusLine>
        {/* THAT a store failed belongs here; WHAT it said does not. An
            `Error.message` off the state store carries the absolute path it
            failed to open, and the primary view is the one place this control
            promises to keep ids, keys and paths out of (#1681 acceptance 6).
            The message itself is in Details, with the rest of the raw record. */}
        {read.answer?.stateError ? (
          <p role="status" data-seat-tick-state-unreadable className="pl-3 text-caption leading-4 text-warning">{t("seatTick.stateUnreadable")}</p>
        ) : null}
        {read.answer?.journalError ? (
          <p role="status" data-seat-tick-journal-unreadable className="pl-3 text-caption leading-4 text-warning">{t("seatTick.journalUnreadable")}</p>
        ) : null}
        {state.storedAutonomy.state !== "off" ? <AutonomyStatus stored={state.storedAutonomy} now={now} locale={locale} /> : null}
        {maintenanceView ? (
          <StatusLine tone={maintenanceView.tone} headline={maintenanceView.status.headline} attr={{ "data-seat-tick-maintenance-summary": "", "data-seat-tick-maintenance-state": maintenanceView.state }}>
            <Segments segments={maintenanceView.status.segments} phone={phone} onOpened={onOpenedCard} />
          </StatusLine>
        ) : null}
      </div>

      {/* ORCHESTRATOR WAKES — the tick's own switch and the fields its draft needs. */}
      <div className="flex min-w-0 flex-col gap-2 border-t border-border pt-2.5">
        <div className={`flex min-w-0 items-center gap-2 ${row}`}>
          <p className="min-w-0 flex-1 text-label font-semibold uppercase tracking-wide text-muted">{t("seatTick.wakesHead")}</p>
          <Toggle
            on={draft.enabled}
            label={t(draft.enabled ? "seatTick.disableAria" : "seatTick.enableAria")}
            phone={phone}
            disabled={state.saving}
            attr={{ "data-seat-tick-enabled": String(draft.enabled) }}
            onToggle={() => { setDraft(previous => ({ ...previous, enabled: !previous.enabled })); if (draft.enabled) state.setAutonomy(previous => ({ ...previous, enabled: false })); }}
          />
        </div>

        {draft.enabled ? (
          <label className="flex min-w-0 flex-col gap-1">
            <span className="text-ui text-primary">{t("seatTick.intervalLabel")}</span>
            <input
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              data-seat-tick-interval
              value={draft.interval}
              disabled={state.saving}
              placeholder={t("seatTick.intervalPlaceholder", { minutes: record?.defaultWakeIntervalMinutes ?? 60 })}
              onChange={(event) => setDraft((previous) => ({ ...previous, interval: event.target.value }))}
              className={`${control} w-full tabular-nums disabled:opacity-50`}
            />
            {intervalHint ? <span data-seat-tick-interval-hint className="text-caption leading-4 text-muted">{intervalHint}</span> : null}
          </label>
        ) : null}

        {leavesDefaults ? (
          <>
            <label className="flex min-w-0 flex-col gap-1">
              <span className="text-ui text-primary">{t("seatTick.untilLabel")}</span>
              <Select
                roomy={phone}
                data-seat-tick-until
                value={draft.until}
                disabled={state.saving}
                onChange={(event) => setDraft((previous) => ({ ...previous, until: event.target.value }))}
                className={phone ? "h-11 w-full" : "w-full"}
              >
                {/* The expiry the record already carries, as a local time: every
                    choice below is «from now», and picking one of them would move
                    an expiry the operator never touched. */}
                {storedUntil ? (
                  <option value="keep">
                    {t("seatTick.untilKeep", { time: seatTickLocalTime(storedUntil, now, locale) ?? storedUntil })}
                  </option>
                ) : null}
                {UNTIL_CHOICES.map((choice) => (
                  <option key={choice.value || "stands"} value={choice.value}>{t(choice.key)}</option>
                ))}
              </Select>
            </label>
          </>
        ) : null}

        <label className="flex min-w-0 flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
            <span className="text-ui text-primary">{t("seatTick.reasonLabel")}</span>
            {instructionLength >= 450 ? (
              <span
                data-seat-tick-character-count={instructionLength}
                aria-live="polite"
                className={`text-caption leading-4 ${instructionLength > 500 ? "text-danger" : "text-muted"}`}
              >
                {t("seatTick.instructionsCharacterCount", { count: instructionLength })}
                {instructionLength > 500 ? (
                  <span data-seat-tick-over-limit> · {t("seatTick.instructionsOverLimit", { over: instructionLength - 500 })}</span>
                ) : null}
              </span>
            ) : null}
          </div>
          <textarea
            ref={reasonRef}
            aria-describedby={`seat-tick-instructions-${surface}`}
            rows={2}
            data-seat-tick-reason
            value={draft.reason}
            disabled={!record || state.saving}
            onChange={(event) => setDraft((previous) => ({ ...previous, reason: event.target.value }))}
            className={`min-h-0 w-full resize-none overflow-hidden rounded-control border border-border bg-card px-2 py-1.5 ${phone ? "text-body" : "text-ui"} text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50`}
          />
          <span id={`seat-tick-instructions-${surface}`} data-seat-tick-instructions-hint className="text-caption leading-4 text-muted">{t("seatTick.reasonHint")}</span>
        </label>

        {instructionLines.length > 0 ? (
          <ul data-seat-tick-instruction-lines className="flex min-w-0 flex-col gap-2 text-ui">
            {instructionLines.map((line, index) => (
              <li key={index} data-seat-tick-instruction-line className="min-w-0 break-words">
                <div className="text-caption text-muted">
                  <span>{line.author?.kind === "gateway" ? t("seatTick.instruction.operator")
                    : line.author?.kind === "manager" && line.author.seatEpoch !== null ? t("seatTick.instruction.seat", { epoch: line.author.seatEpoch })
                    : line.author?.kind === "agent" || line.author?.kind === "manager" ? t("seatTick.instruction.agent")
                    : t("seatTick.instruction.unknown")}</span>
                  {" · "}
                  {line.at ? <time dateTime={line.at}>{new Date(line.at).toLocaleString(locale)}</time> : t("seatTick.instruction.dateUnknown")}
                </div>
                <p className="whitespace-pre-wrap text-primary">{line.text}</p>
              </li>
            ))}
          </ul>
        ) : null}

        {hasUnknownInstructions ? (
          <button
            type="button"
            data-seat-tick-clear-unknown
            disabled={state.saving || !draft.reason.trim()}
            onClick={() => void read.save({ clearUnknownInstructions: true, reason: draft.reason.trim() })}
            className={`inline-flex ${phone ? "min-h-11" : "h-7"} items-center self-start rounded-control px-1 text-ui font-semibold text-secondary hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50`}
          >
            {t("seatTick.instruction.removeUnknown")}
          </button>
        ) : null}

        {hasSeatInstructions ? (
          <button
            type="button"
            data-seat-tick-replace-other
            disabled={state.saving || !draft.reason.trim()}
            onClick={() => void read.save({ replaceOtherInstructions: true, reason: draft.reason.trim() })}
            className={`inline-flex ${phone ? "min-h-11" : "h-7"} items-center self-start rounded-control px-1 text-ui font-semibold text-secondary hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50`}
          >
            {t("seatTick.instruction.replaceOther")}
          </button>
        ) : null}

        {reading.offDefault ? (
          <button
            type="button"
            data-seat-tick-restore
            disabled={state.saving}
            onClick={() => {
              /* Restore the cadence while keeping the standing instructions. */
              void read.save({ enabled: true, wakeIntervalMinutes: null, untilMinutes: null });
            }}
            className={`inline-flex ${phone ? "min-h-11" : "h-7"} items-center gap-1.5 self-start rounded-control px-1 text-ui font-semibold text-secondary hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50`}
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden />
            <span className="truncate">{t("seatTick.restore")}</span>
          </button>
        ) : null}
      </div>

      {/* FULL AUTONOMY — under the wakes it rides on. */}
      {record ? <SeatTickAutonomy state={state} row={row} phone={phone} now={now} locale={locale} wakesOn={record?.settings.enabled === true} /> : null}

      {/* BOARD MAINTENANCE — its own switch, interval and agent, saved with the rest. */}
      {record && maintenance && maintenanceView ? (
        <SeatTickMaintenance
          project={read.project}
          maintenance={maintenance}
          view={maintenanceView}
          state={state}
          control={control}
          row={row}
          phone={phone}
          onOpenedCard={onOpenedCard}
        />
      ) : null}

      {record?.curation ? <SeatTickCuration value={record.curation} state={state} control={control} row={row} phone={phone} now={now} locale={locale} onOpened={onOpenedCard} /> : null}

      {record?.autoRotate ? <SeatTickAutoRotate value={record.autoRotate} state={state} control={control} row={row} phone={phone} now={now} locale={locale} /> : null}

      {record?.release?.available ? <SeatTickRelease value={record.release} state={state} control={control} row={row} phone={phone} now={now} locale={locale} tickEnabled={record.effective.enabled} /> : null}

      {/* On the desktop the popover scrolls under its own cap, so the Save
          sticks to the bottom edge of what is visible; the phone's sits in
          the sheet's footer. */}
      {actions ? (
        <div className={`flex min-w-0 ${phone ? "" : "sticky bottom-0 z-10 -mx-3 -mb-1 border-t border-border bg-card px-3 py-2"}`}>{actions}</div>
      ) : null}

      {/* DETAILS — the only place an id, a path or journal text may appear. */}
      {record ? <SeatTickDetails record={record} autonomy={state.storedAutonomy} lastDelivery={reading.lastDelivery} now={now} locale={locale} phone={phone} /> : null}
    </div>
  );
}

/** The status line while an episode stands. Its dot wears
    the ring's colour (`--tick-3`, the ramp's violet the ring's `--autonomy` names), so the line reads as
    the same mode the chip shows; green stays the health dot's. Who turned it
    on is in Details. */
function AutonomyStatus({ stored, now, locale }: { stored: AutonomyView; now: number; locale: string }) {
  const { t } = useLocale();
  const started = seatTickLocalTime(stored.startedAt, now, locale) ?? t("seatTick.unknown");
  const left = stored.until ? Math.max(0, Date.parse(stored.until) - now) : null;
  const headline = stored.until && left !== null
    ? t("seatTick.autonomy.status", {
      time: seatTickLocalTime(stored.until, now, locale) ?? t("seatTick.unknown"),
      left: t("seatTick.autonomy.left", { h: Math.floor(left / 3_600_000), m: Math.floor((left % 3_600_000) / 60_000) }),
    })
    : t("seatTick.autonomy.statusUnlimited", { time: started });
  return (
    <StatusLine tone="ok" headline={headline} attr={{ "data-seat-tick-autonomy-summary": "" }}
      dot={<span aria-hidden data-seat-tick-dot="autonomy" className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--tick-3)]" />} />
  );
}

/** (docs/design/full-autonomy-mode.md §2.3): the section, built
    from the panel's own Toggle, Select and caption. Turning it on turns the
    wakes on in the same draft, because the mode works through them; the hint
    that says so shows only while the stored wakes are off. */
function SeatTickAutonomy({ state, row, phone, now, locale, wakesOn }: { state: SeatTickDraftState; row: string; phone: boolean; now: number; locale: string; wakesOn: boolean }) {
  const { t } = useLocale();
  const { autonomy: draft, setAutonomy: setDraft, storedAutonomy: stored } = state;
  const unlimited = stored.state === "unlimited";
  const storedEnd = stored.state === "off" ? null : unlimited ? t("seatTick.autonomy.unlimited") : t("seatTick.autonomy.keep", { time: seatTickLocalTime(stored.until, now, locale) ?? t("seatTick.unknown") });
  return <div data-seat-tick-autonomy-section className="flex min-w-0 flex-col gap-2 border-t border-border pt-2.5">
    <div className={`flex min-w-0 items-center gap-2 ${row}`}>
      <p className="min-w-0 flex-1 text-label font-semibold uppercase tracking-wide text-muted">{t("seatTick.autonomy.head")}</p>
      <Toggle on={draft.enabled} label={t(draft.enabled ? "seatTick.autonomy.disableAria" : "seatTick.autonomy.enableAria")}
        phone={phone} disabled={state.saving} attr={{ "data-seat-tick-autonomy-enabled": String(draft.enabled) }}
        onToggle={() => {
          const next = !draft.enabled;
          setDraft(previous => ({ ...previous, enabled: next }));
          if (next) state.setDraft(previous => (previous.enabled ? previous : { ...previous, enabled: true }));
        }} />
    </div>
    <p data-seat-tick-autonomy-about className="text-caption leading-4 text-secondary">{t("seatTick.autonomy.about")}</p>
    {draft.enabled ? <label className="flex min-w-0 flex-col gap-1">
      <span className="text-ui text-primary">{t("seatTick.autonomy.durationLabel")}</span>
      <Select roomy={phone} data-seat-tick-autonomy-duration value={draft.hours} disabled={state.saving}
        onChange={event => setDraft(previous => ({ ...previous, hours: event.target.value }))}
        className={phone ? "h-11 w-full" : "w-full"}>
        {storedEnd ? <option value="keep">{storedEnd}</option> : null}
        {AUTONOMY_HOURS.map(hours => hours === Infinity
          ? unlimited ? null : <option key="unlimited" value="unlimited">{t("seatTick.autonomy.unlimited")}</option>
          : <option key={hours} value={String(hours)}>{t("seatTick.autonomy.hours", { n: hours })}</option>)}
      </Select>
    </label> : null}
    {draft.enabled && stored.state === "off" && !wakesOn ? <p data-seat-tick-autonomy-wakes className="text-caption leading-4 text-muted">{t("seatTick.autonomy.wakesToo")}</p> : null}
  </div>;
}

function SeatTickRelease({ value, state, control, row, phone, now, locale, tickEnabled }: {
  value: NonNullable<SeatTickSettingsAnswer["release"]>; state: SeatTickDraftState; control: string; row: string; phone: boolean; now: number; locale: "en" | "uk"; tickEnabled: boolean;
}) {
  const { t } = useLocale();
  const draft = state.release;
  const observation = value.status.observation;
  const reasons: Record<string, MessageKey> = { "releases-off": "seatTick.release.wait.off", "tick-off": "seatTick.release.wait.tick", "merge-off": "seatTick.release.wait.merge", "release-in-flight": "seatTick.release.wait.flight", "checks-red": "seatTick.release.wait.checks", "checks-pending": "seatTick.release.wait.checks", rollback: "seatTick.release.wait.rollback", hold: "seatTick.release.wait.hold", "no-cut": "seatTick.release.wait.cut", draining: "seatTick.release.wait.deploy", deploying: "seatTick.release.wait.deploy", gap: "seatTick.release.wait.gap", changes: "seatTick.release.wait.changes", "declined-cut": "seatTick.release.wait.declined" };
  const reason = !value.enabled && !value.status.request && !value.status.live ? "seatTick.release.wait.off" : !tickEnabled ? "seatTick.release.wait.tick" : observation?.reason.startsWith("capture-tools:") ? "seatTick.release.wait.tools" : observation?.reason ? reasons[observation.reason] : null;
  return <div data-seat-tick-release className="flex min-w-0 flex-col gap-2 border-t border-border pt-2.5">
    <div className={`flex items-center gap-2 ${row}`}>
      <p className="min-w-0 flex-1 text-label font-semibold uppercase tracking-wide text-muted">{t("seatTick.release.head")}</p>
      <Toggle on={draft.enabled} label={t("seatTick.release.head")} disabled={state.saving}
        onToggle={() => state.setRelease({ ...draft, enabled: !draft.enabled })} phone={phone} attr={{ "data-seat-tick-release-enabled": String(draft.enabled) }} />
    </div>
    <p className="text-caption leading-4 text-secondary">{t("seatTick.release.about")}</p>
    <label className={`flex items-center gap-2 ${row} cursor-pointer text-ui text-primary`}>
      <span className="min-w-0 flex-1">{t("seatTick.release.ask")}</span>
      <input data-seat-tick-release-ask type="checkbox" checked={draft.ask} disabled={state.saving} className={phone ? "size-6" : "size-4"}
        onChange={event => state.setRelease({ ...draft, ask: event.target.checked })} />
    </label>
    {([{ field: "changes", label: "changesLabel", min: 1, max: 500 }, { field: "hours", label: "hoursLabel", min: 1, max: 720 }] as const).map(({ field, label, min, max }) =>
      <label className={`flex items-center gap-2 ${row}`} key={field}><span className="min-w-0 flex-1 text-ui text-primary">{t(`seatTick.release.${label}`)}</span>
        <input type="number" min={min} max={max} data-seat-tick-release-field={field} value={draft[field]} disabled={state.saving}
          className={`${control} w-20 shrink-0 rounded border border-border bg-input px-2 text-ui text-primary`}
          onChange={event => state.setRelease({ ...draft, [field]: event.target.value })} /></label>)}
    {observation ? <p className="text-caption leading-4 text-secondary">{t("seatTick.release.count", { count: observation.count, target: value.minChanges })}</p> : null}
    {reason ? <p data-seat-tick-release-reason role="status" className="text-caption leading-4 text-muted">{t(reason)}</p> : null}
    {observation ? <p className="text-caption text-muted">{t("seatTick.release.last", { version: observation.lastTag })}</p> : null}
    {observation?.reason === "gap" ? <p className="text-caption text-muted">{t("seatTick.release.next", { time: seatTickLocalTime(new Date(observation.nextEligibleAt).toISOString(), now, locale) ?? t("seatTick.unknown") })}</p> : null}
    {value.status.hold && !draft.clearHold ? <div className={`flex items-center gap-2 ${row}`}>
      <p className="min-w-0 flex-1 text-caption text-warning [overflow-wrap:anywhere]">{value.status.hold.reason}</p>
      <button type="button" data-seat-tick-release-clear className={`${control} shrink-0 rounded border border-border px-2 text-caption`} disabled={state.saving}
        onClick={() => state.setRelease({ ...draft, clearHold: true })}>{t("seatTick.release.clear")}</button>
    </div> : null}
  </div>;
}

function SeatTickAutoRotate({ value, state, control, row, phone, now, locale }: {
  value: NonNullable<SeatTickSettingsAnswer["autoRotate"]>; state: SeatTickDraftState;
  control: string; row: string; phone: boolean; now: number; locale: string;
}) {
  const { t } = useLocale();
  const { autoRotate: draft, setAutoRotate: setDraft } = state;
  return <div data-seat-tick-auto-rotate className="flex min-w-0 flex-col gap-2 border-t border-border pt-2.5">
    <div className={`flex min-w-0 items-center gap-2 ${row}`}>
      <p className="min-w-0 flex-1 text-label font-semibold uppercase tracking-wide text-muted">{t("seatTick.autoRotate.head")}</p>
      <Toggle on={draft.enabled} label={t(draft.enabled ? "seatTick.autoRotate.disableAria" : "seatTick.autoRotate.enableAria")}
        phone={phone} disabled={state.saving} attr={{ "data-seat-tick-auto-rotate-enabled": String(draft.enabled) }}
        onToggle={() => setDraft(previous => ({ ...previous, enabled: !previous.enabled }))} />
    </div>
    <p data-seat-tick-auto-rotate-about className="text-caption leading-4 text-secondary">{t("seatTick.autoRotate.about")}</p>
    {draft.enabled ? <label className={`flex min-w-0 items-center gap-2 ${row}`}>
      <span className="min-w-0 flex-1 text-ui text-primary">{t("seatTick.autoRotate.thresholdLabel")}</span>
      <input type="number" min={value.minPercent} max={value.maxPercent} step={1} inputMode="numeric" data-seat-tick-auto-rotate-threshold
        value={draft.percent} disabled={state.saving} placeholder={t("seatTick.autoRotate.thresholdPlaceholder", { percent: value.defaultPercent })}
        onChange={event => setDraft(previous => ({ ...previous, percent: event.target.value }))}
        className={`${control} ${phone ? "w-24" : "w-20"} shrink-0 text-right tabular-nums disabled:opacity-50`} />
    </label> : null}
    {value.lastAttempt ? <p data-seat-tick-auto-rotate-failed role="status" className="min-w-0 break-words text-caption leading-4 text-warning">
      {/* The engine's error is English and technical; the reply keeps it for agents. */}
      {t("seatTick.autoRotate.lastFailed", { time: seatTickLocalTime(value.lastAttempt.startedAt, now, locale) ?? t("seatTick.unknown"),
        next: seatTickLocalTime(value.lastAttempt.nextAttemptAt, now, locale) ?? t("seatTick.unknown") })}
    </p> : null}
    {value.windowKnown === false ? <p data-seat-tick-auto-rotate-window-unknown role="status" className="min-w-0 break-words text-caption leading-4 text-warning">{t("seatTick.autoRotate.windowUnknown")}</p> : null}
  </div>;
}

function SeatTickCuration({ value, state, control, row, phone, now, locale, onOpened }: {
  value: CurationAnswer; state: SeatTickDraftState; control: string; row: string; phone: boolean; now: number; locale: string; onOpened?: () => void;
}) {
  const { t } = useLocale();
  const { curation: draft, setCuration: setDraft } = state;
  const run = value.lastRun;
  const running = value.live;
  const endedAt = run ? seatTickLocalTime(run.endedAt ?? run.claimedAt, now, locale) ?? t("seatTick.unknown") : null;
  const startedAt = running ? seatTickLocalTime(running.claimedAt, now, locale) : null;
  const nextAt = seatTickLocalTime(value.nextRunAt, now, locale);
  const counts = run ? ([
    ["calls", "seatTick.curation.count.calls"],
    ["changed", "seatTick.curation.count.changed"],
    ["rewritten", "seatTick.curation.count.rewritten"],
    ["merged", "seatTick.curation.count.merged"],
    ["moved", "seatTick.curation.count.moved"],
    ["split", "seatTick.curation.count.split"],
    ["archived", "seatTick.curation.count.archived"],
    ["restored", "seatTick.curation.count.restored"],
  ] as const).flatMap(([key, label]) => {
    const count = run.counts[key];
    return count > 0 ? [t(label, { count })] : [];
  }).join(" · ") : "";
  const next = value.waitingOn
    ? t(`seatTick.curation.${value.waitingOn}`)
    : (nextAt
      ? t(run ? "seatTick.maintenance.next.at" : "seatTick.maintenance.next.firstRun", { time: nextAt })
      : t("seatTick.unknown"));
  return <div data-seat-tick-curation={value.live ? "running" : value.enabled ? "on" : "off"} className="flex min-w-0 flex-col gap-2 border-t border-border pt-2.5">
    <div className={`flex min-w-0 items-center gap-2 ${row}`}>
      <p className="min-w-0 flex-1 text-label font-semibold uppercase tracking-wide text-muted">{t("seatTick.curation.head")}</p>
      <Toggle on={draft.enabled} label={t(draft.enabled ? "seatTick.curation.disableAria" : "seatTick.curation.enableAria")} phone={phone} disabled={state.saving}
        attr={{ "data-seat-tick-curation-enabled": String(draft.enabled) }} onToggle={() => setDraft(previous => ({ ...previous, enabled: !previous.enabled }))} />
    </div>
    {draft.enabled ? <label className={`flex min-w-0 items-center gap-2 ${row}`}>
      <span className="min-w-0 flex-1 text-ui text-primary">{t("seatTick.maintenance.intervalLabel")}</span>
      <input type="number" min={value.minIntervalHours} max={value.maxIntervalHours} step={1} inputMode="numeric" data-seat-tick-curation-interval
        value={draft.hours} disabled={state.saving} onChange={event => setDraft(previous => ({ ...previous, hours: event.target.value }))}
        className={`${control} ${phone ? "w-24" : "w-20"} shrink-0 text-right tabular-nums disabled:opacity-50`} />
    </label> : null}
    <div data-seat-tick-curation-rows className="flex min-w-0 flex-col gap-1">
      {running ? <div data-seat-tick-curation-row="running" className="flex min-w-0 flex-col gap-0.5">
        <div className={`flex min-w-0 items-baseline gap-2 ${phone ? "min-h-6" : ""}`}>
          <span className="shrink-0 text-caption text-muted">{t(running.state === "running" ? "seatTick.curation.runningLabel" : "seatTick.curation.startingLabel")}</span>
          <span className="min-w-0 flex-1 break-words text-right text-ui text-primary">{t(running.state === "running" ? "seatTick.curation.runningSince" : "seatTick.curation.startingSince", { time: startedAt ?? t("seatTick.unknown") })}</span>
        </div>
        {running.conversationId ? <div className="flex min-w-0 flex-wrap justify-end gap-x-3">
          <a data-seat-tick-curation-live-conversation href={"#c=" + encodeURIComponent(running.conversationId)} onClick={onOpened}
            className={`${LINK} text-ui ${phone ? "min-h-11" : "h-7"}`}>{t("seatTick.curation.conversation")}<ArrowUpRight className="h-3.5 w-3.5 shrink-0" aria-hidden /></a>
        </div> : null}
      </div> : null}
      <div data-seat-tick-curation-row="last" className="flex min-w-0 flex-col gap-0.5">
        <div className={`flex min-w-0 items-baseline gap-2 ${phone ? "min-h-6" : ""}`}>
          <span className="shrink-0 text-caption text-muted">{t("seatTick.maintenance.row.last")}</span>
          <span className="min-w-0 flex-1 break-words text-right text-ui text-primary">{run
            ? t(run.state === "succeeded" ? "seatTick.maintenance.status.done" : "seatTick.maintenance.status.failed", { time: endedAt ?? t("seatTick.unknown") })
            : t("seatTick.curation.never")}</span>
        </div>
        {counts ? <span data-seat-tick-curation-counts className="break-words text-right text-caption text-secondary">{counts}</span> : null}
        {run?.failure ? <span role="status" className="break-words text-right text-caption text-warning">{run.failure}</span> : null}
        {run?.conversationId ? <div className="flex min-w-0 flex-wrap justify-end gap-x-3">
          <a data-seat-tick-curation-conversation href={"#c=" + encodeURIComponent(run.conversationId)} onClick={onOpened}
            className={`${LINK} text-ui ${phone ? "min-h-11" : "h-7"}`}>{t("seatTick.curation.conversation")}<ArrowUpRight className="h-3.5 w-3.5 shrink-0" aria-hidden /></a>
        </div> : null}
      </div>
      <div data-seat-tick-curation-row="next" className={`flex min-w-0 items-baseline gap-2 ${phone ? "min-h-6" : ""}`}>
        <span className="shrink-0 text-caption text-muted">{t("seatTick.maintenance.row.next")}</span><span className="min-w-0 flex-1 break-words text-right text-ui text-primary">{next}</span>
      </div>
    </div>
    {value.runsError ? <p role="status" className="break-words text-caption text-warning">{value.runsError}</p> : null}
  </div>;
}

function SeatTickMaintenance({ maintenance, view, state, control, row, phone, onOpenedCard }: {
  project: string;
  maintenance: BoardMaintenanceAnswer;
  view: MaintenanceReading;
  state: SeatTickDraftState;
  control: string;
  row: string;
  phone: boolean;
  onOpenedCard?: (() => void) | undefined;
}) {
  const { t } = useLocale();
  const { maintenance: draft, setMaintenance: setDraft, runtime, maintainer } = state;
  const taskId = view.cardTaskId;
  const hasNeedYou = view.last.links.some((link) => link.kind === "card");

  return (
    <div data-seat-tick-maintenance={view.state} className="flex min-w-0 flex-col gap-2 border-t border-border pt-2.5">
      <div className={`flex min-w-0 items-center gap-2 ${row}`}>
        <p className="min-w-0 flex-1 text-label font-semibold uppercase tracking-wide text-muted">{t("seatTick.maintenance.head")}</p>
        <Toggle
          on={draft.enabled}
          label={t(draft.enabled ? "seatTick.maintenance.disableAria" : "seatTick.maintenance.enableAria")}
          phone={phone}
          disabled={state.saving}
          attr={{ "data-seat-tick-maintenance-enabled": String(draft.enabled) }}
          onToggle={() => setDraft((previous) => ({ ...previous, enabled: !previous.enabled }))}
        />
      </div>

      {/* What the switch starts, with the agent it runs on: the current value
          of the `maintainer` role row. */}
      <p data-seat-tick-maintenance-about className="text-caption leading-4 text-secondary">
        {runtime
          ? t("seatTick.maintenance.about", { engine: ENGINE_NAME[runtime.engine], runtime: `${modelName(maintainer, runtime)}, ${runtime.effort}` })
          : t("seatTick.maintenance.aboutNoAgent")}
      </p>
      <p className="text-caption leading-4 text-muted">{t("seatTick.maintenance.clause")}</p>

      {runtime && maintainer.choices.length > 0 ? (
        <AgentPicker runtime={runtime} maintainer={maintainer} state={state} phone={phone} />
      ) : maintainer.failed ? (
        <p role="status" data-seat-tick-agent-unreadable className="text-caption leading-4 text-warning">{t("seatTick.maintenance.agentUnreadable")}</p>
      ) : null}
      {state.runtimeError ? (
        <p role="alert" data-seat-tick-agent-error className="rounded-control border border-danger/40 bg-danger/10 px-2 py-1.5 text-ui leading-4 text-danger">
          {state.runtimeError}
        </p>
      ) : null}

      {draft.enabled ? (
        <label className={`flex min-w-0 items-center gap-2 ${row}`}>
          <span className="min-w-0 flex-1 text-ui text-primary">{t("seatTick.maintenance.intervalLabel")}</span>
          <input
            type="number"
            min={maintenance.minIntervalHours}
            max={maintenance.maxIntervalHours}
            step={1}
            inputMode="numeric"
            data-seat-tick-maintenance-interval
            value={draft.hours}
            disabled={state.saving}
            placeholder={t("seatTick.maintenance.intervalPlaceholder", { hours: maintenance.defaultIntervalHours })}
            onChange={(event) => setDraft((previous) => ({ ...previous, hours: event.target.value }))}
            className={`${control} ${phone ? "w-24" : "w-20"} shrink-0 text-right tabular-nums disabled:opacity-50`}
          />
        </label>
      ) : null}

      <div data-seat-tick-maintenance-rows className="flex min-w-0 flex-col gap-1">
        <div data-seat-tick-maintenance-row="last" className="flex min-w-0 flex-col gap-0.5">
          <div className={`flex min-w-0 items-baseline gap-2 ${phone ? "min-h-6" : ""}`}>
            <span className="shrink-0 text-caption text-muted">{t("seatTick.maintenance.row.last")}</span>
            <span className="min-w-0 flex-1 break-words text-right text-ui text-primary">{view.last.text}</span>
          </div>
          {view.last.links.length > 0 ? (
            <div className="flex min-w-0 flex-wrap justify-end gap-x-3">
              {view.last.links.map((link) => (
                <button
                  key={link.kind}
                  type="button"
                  data-seat-tick-maintenance-link={link.kind}
                  onClick={() => {
                    if (link.kind === "card") openMaintenanceCard(link.taskId);
                    else if (link.kind === "accounts") requestAccountPanel(link.engine, "");
                    onOpenedCard?.();
                  }}
                  className={`${LINK} text-ui ${phone ? "min-h-11" : "h-7"}`}
                >
                  <span className="truncate">{link.text}</span>
                  <ArrowUpRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <div data-seat-tick-maintenance-row="next" className={`flex min-w-0 items-baseline gap-2 ${phone ? "min-h-6" : ""}`}>
          <span className="shrink-0 text-caption text-muted">{t("seatTick.maintenance.row.next")}</span>
          <span className="min-w-0 flex-1 break-words text-right text-ui text-primary">{view.next}</span>
        </div>
      </div>
      {view.warning ? (
        <p role="status" data-seat-tick-maintenance-unreadable className="text-caption leading-4 text-warning">{view.warning}</p>
      ) : null}
      {taskId && !hasNeedYou ? (
        <button
          type="button"
          data-seat-tick-maintenance-card
          onClick={() => {
            openMaintenanceCard(taskId);
            onOpenedCard?.();
          }}
          className={`${LINK} ${phone ? "min-h-11" : "h-7"} self-start text-ui`}
        >
          <span className="truncate">{t("seatTick.maintenance.openRun")}</span>
          <ArrowUpRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

const ENGINE_NAME = { claude: "Claude", codex: "Codex" } as const;

function modelName(maintainer: MaintainerRoleRead, runtime: MaintainerRuntime): string {
  const model = maintainer.choices.find((choice) => choice.engine === runtime.engine)?.models.find((candidate) => candidate.id === runtime.model);
  return model?.label ?? runtime.model;
}

/** Engine, model and effort of the maintainer, each offering only what the
    launch catalogue lists. A pick of an engine or a model moves the others to a
    combination that catalogue offers, so no invalid triple can be composed. */
function AgentPicker({ runtime, maintainer, state, phone }: {
  runtime: MaintainerRuntime;
  maintainer: MaintainerRoleRead;
  state: SeatTickDraftState;
  phone: boolean;
}) {
  const { t } = useLocale();
  const models = maintainer.choices.find((choice) => choice.engine === runtime.engine)?.models ?? [];
  const efforts = models.find((model) => model.id === runtime.model)?.efforts ?? [];
  const select = phone ? "h-11 w-full" : "w-full";
  return (
    <div data-seat-tick-agent className="flex min-w-0 flex-col gap-1">
      <span className="text-ui text-primary">{t("seatTick.maintenance.agentLabel")}</span>
      {/* One row on the desktop; on the phone the effort takes a row of its
          own, so a 16 px «medium» is never cut to «mediu». */}
      <div className={`grid min-w-0 gap-1.5 ${phone ? "grid-cols-[6rem_minmax(0,1fr)]" : "grid-cols-[minmax(0,5.5rem)_minmax(0,1fr)_minmax(0,5rem)]"}`}>
        <Select
          roomy={phone}
          data-seat-tick-agent-engine
          aria-label={t("seatTick.maintenance.engineAria")}
          value={runtime.engine}
          disabled={state.saving}
          onChange={(event) => state.setRuntime(runtimeForEngine(maintainer.choices, runtime, event.target.value as MaintainerRuntime["engine"]))}
          className={select}
        >
          {maintainer.choices.map((choice) => (
            <option key={choice.engine} value={choice.engine}>{ENGINE_NAME[choice.engine]}</option>
          ))}
        </Select>
        <Select
          roomy={phone}
          data-seat-tick-agent-model
          aria-label={t("seatTick.maintenance.modelAria")}
          value={runtime.model}
          disabled={state.saving}
          onChange={(event) => state.setRuntime(runtimeForModel(maintainer.choices, runtime, event.target.value))}
          className={select}
        >
          {models.map((model) => (
            <option key={model.id} value={model.id}>{model.label}</option>
          ))}
        </Select>
        <Select
          roomy={phone}
          data-seat-tick-agent-effort
          aria-label={t("seatTick.maintenance.effortAria")}
          value={runtime.effort}
          disabled={state.saving}
          onChange={(event) => state.setRuntime({ ...runtime, effort: event.target.value })}
          className={`${select} ${phone ? "col-span-2" : ""}`}
        >
          {efforts.map((effort) => (
            <option key={effort} value={effort}>{effort}</option>
          ))}
        </Select>
      </div>
    </div>
  );
}

/** The board's own task-open path: the event the call cards and the report log
    already send. It resolves the task by id among the project's tasks, so a
    done card that is off the board opens like any other. On the phone a screen
    pushed from a sheet takes the sheet's place. */
function openMaintenanceCard(taskId: string): void {
  window.dispatchEvent(new CustomEvent("llv:mcp-navigate", { detail: { kind: "task", id: taskId } }));
}

const ACTORS = {
  gateway: "seatTick.actor.gateway",
  manager: "seatTick.actor.manager",
  agent: "seatTick.actor.agent",
  unidentified: "seatTick.actor.unidentified",
} as const;

function SeatTickDetails({ record, autonomy, lastDelivery, now, locale, phone }: {
  record: SeatTickSettingsAnswer;
  autonomy: AutonomyView;
  lastDelivery: string;
  now: number;
  locale: string;
  phone: boolean;
}) {
  const { t } = useLocale();
  const setBy = record.settings.setBy;
  const stamp = seatTickLocalTime(record.settings.updatedAt, now, locale);
  const prompt = record.settings.monitorPrompt;
  return (
    <details data-seat-tick-details className="min-w-0 border-t border-border pt-2">
      <summary className={`cursor-pointer list-none ${phone ? "min-h-11 py-2.5" : ""} text-ui font-semibold text-secondary hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40`}>
        {t("seatTick.details")}
      </summary>
      <div className="flex min-w-0 flex-col gap-2 pt-2">
        <p data-seat-tick-last-delivery className="min-w-0 break-words text-caption leading-4 text-muted">
          {t("seatTick.lastDeliveryLine", { value: lastDelivery })}
        </p>
        {record.cardText ? (
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-caption font-semibold text-muted">{t("seatTick.cardHead")}</p>
            <pre className="max-h-40 min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-control border border-border bg-sunken p-2 font-mono text-caption leading-4 text-secondary">{record.cardText}</pre>
          </div>
        ) : (
          <p className="text-caption leading-4 text-muted">{t("seatTick.cardNone")}</p>
        )}
        <p className="min-w-0 break-words text-caption leading-4 text-muted">
          {setBy
            ? t("seatTick.setBy", {
              who: t(ACTORS[setBy.kind]),
              at: stamp ?? t("seatTick.unknown"),
              conversation: setBy.conversationId ?? t("seatTick.noConversation"),
            })
            : t("seatTick.setByNobody")}
        </p>
        {record.autoRotate?.setBy ? <p data-seat-tick-auto-rotate-set-by className="min-w-0 break-words text-caption leading-4 text-muted">
          {t("seatTick.autoRotate.setBy", { who: t(ACTORS[record.autoRotate.setBy.kind]), at: seatTickLocalTime(record.autoRotate.updatedAt, now, locale) ?? t("seatTick.unknown"),
            why: record.autoRotate.why ? `: «${record.autoRotate.why}»` : "" })}
        </p> : null}
        {autonomy.state !== "off" ? <p data-seat-tick-autonomy-set-by className="min-w-0 break-words text-caption leading-4 text-muted">
          {t("seatTick.autonomy.setBy", { who: t(ACTORS[autonomy.episode?.setBy.kind ?? "gateway"]), time: seatTickLocalTime(autonomy.episode?.updatedAt ?? null, now, locale) ?? t("seatTick.unknown") })}
        </p> : null}
        {[...(record.settings.autonomyHistory ?? []), ...(record.settings.autonomy ? [record.settings.autonomy] : [])].some(episode => episode.decisions.length > 0) ? <div data-seat-tick-autonomy-log className="flex min-w-0 flex-col gap-2">
          <p className="text-caption font-semibold text-muted">{t("seatTick.autonomy.decisions")}</p>
          {[...(record.settings.autonomyHistory ?? []), ...(record.settings.autonomy ? [record.settings.autonomy] : [])].flatMap(episode => episode.decisions.map(decision => <div key={`${episode.startedAt}:${decision.id}`} className="min-w-0 break-words text-caption leading-4 text-secondary">
            <p className="font-semibold text-primary">{decision.decision}</p>{decision.reviewState ? <p className="font-medium text-secondary">{t(`seatTick.autonomy.review.${decision.reviewState}`)}</p> : null}<p>{decision.why}</p><p><span className="font-semibold text-primary">{t("seatTick.autonomy.undo")}:</span> {decision.undo}</p>
          </div>))}
        </div> : null}
        {prompt ? (
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-caption font-semibold text-muted">{t("seatTick.promptHead", { chars: record.monitorPromptLength })}</p>
            {/* The seat's own words, read only: editing them from the browser
                is a stated non-goal — they are the agent's record (#1280). */}
            <pre className="max-h-40 min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-control border border-border bg-sunken p-2 font-mono text-caption leading-4 text-secondary">{prompt}</pre>
          </div>
        ) : (
          <p className="text-caption leading-4 text-muted">{t("seatTick.promptNone")}</p>
        )}
        {record.lastRun ? (
          <p className="min-w-0 break-words text-caption leading-4 text-muted">
            {t("seatTick.lastRun", {
              verdict: record.lastRun.verdict,
              age: seatTickAge(record.lastRun.at, now, t) ?? t("seatTick.unknown"),
              detail: record.lastRun.detail ?? t("seatTick.none"),
            })}
          </p>
        ) : null}
        {/* Why a store could not be read, in its own words. It lands here
            because a filesystem error names the path it failed on. */}
        {record.stateError ? (
          <p data-seat-tick-state-error className="min-w-0 break-words text-caption leading-4 text-warning">
            {t("seatTick.stateErrorDetail", { error: record.stateError })}
          </p>
        ) : null}
        {record.journalError ? (
          <p data-seat-tick-journal-error className="min-w-0 break-words text-caption leading-4 text-warning">
            {t("seatTick.journalErrorDetail", { error: record.journalError })}
          </p>
        ) : null}
        <a
          href={`/api/monitor/seat-tick?project=${encodeURIComponent(record.project)}`}
          target="_blank"
          rel="noreferrer"
          data-seat-tick-diagnostics
          className={`inline-flex ${phone ? "min-h-11" : ""} items-center text-ui font-semibold text-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40`}
        >
          {t("seatTick.diagnostics")}
        </a>
      </div>
    </details>
  );
}
