"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { roleDescription, roleName, roleParamDescription, roleParamLabel, roleParamOptionLabel } from "@/components/builderCopy";
import {
  EngineRadioGroup,
  launchEngineLabel,
  openLaunchSignIn,
  useAgentLaunchDraft,
  useLaunchReadiness,
} from "@/components/draft/AgentLaunchControls";
import { DraftRuntimePill } from "@/components/draft/DraftRuntimePill";
import { FeedMessageRow } from "@/components/conversation/OutboxBubbles";
import { FeedSkeleton, SKELETON_BAR } from "@/components/skeletons";
import { Select } from "@/components/ui/Select";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useComposer } from "@/hooks/useComposer";
import { seedLaunchOutbox } from "@/components/conversation/outbox";
import { playCue } from "@/lib/audio/app";
import { effortScale } from "@/lib/agent/efforts";
import { codexModelSupportsImages } from "@/lib/agent/models";
import { useLocale } from "@/lib/i18n";
import { requestFilesRefresh } from "@/lib/filesEvents";
import { STREAM_RECONNECTED_EVENT } from "@/hooks/runtimeBus";
import { applySpawnedConversationSnapshot } from "@/hooks/useFiles";
import type { RoleDefinition } from "@/lib/roles/types";
import type { FileEntry } from "@/lib/types";
import { conversationIdentity } from "@/lib/accounts/identity";
import type { RuntimeImageCapability } from "@/lib/runtime/structuredContent";

import { ComposerBar } from "./ComposerBar";
import { markLaunchedConversation } from "./launchedConversations";
import { DraftLaunchStatus } from "./DraftLaunchStatus";
import {
  CONFIRM_ATTENTION_MS,
  SLOW_BOOT_MS,
  type SpawnAttempt,
  type SpawnResponseBody,
  admittedSpawn,
  applySpawnOutcome,
  applySpawnFailure,
  classifySpawnResponse,
  classifyTransportLoss,
  createSpawnAttempt,
  draftSpawnTitle,
  displayPhase,
  hasRecoverableRequest,
  matchSpawnedFile,
  provisionalSpawnFile,
  spawnRequestBody,
  upgradeLegacySpawnAttempt,
} from "./draftSpawn";
import { draftWorkingDirectory } from "./projectModel";

type Engine = "claude" | "codex" | "copilot";

/* The engine chips are SHARED with the orchestrator panel and the pipeline
   stage placeholder (PRD #976 slice A) — they live in
   `@/components/draft/AgentLaunchControls`. Re-exported here because the stage
   placeholder has always imported the chips from this module. */
export { EngineRadioGroup };

const STRUCTURED_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
type SpawnImageNegotiation = {
  spawnTransport: "tmux" | "structured";
  imageInput: Record<Engine, RuntimeImageCapability>;
};
type SpawnImageNegotiationState =
  | { status: "loading"; requestKey: string }
  | { status: "ready"; requestKey: string; value: SpawnImageNegotiation }
  | { status: "error"; requestKey: string };

function runtimeImageCapabilityValue(value: unknown): RuntimeImageCapability | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.supported !== "boolean") return null;
  if (candidate.reason !== null && typeof candidate.reason !== "string") return null;
  if (!Array.isArray(candidate.formats) || candidate.formats.length === 0
    || candidate.formats.some((format) => typeof format !== "string" || !STRUCTURED_IMAGE_MIMES.has(format))) return null;
  if (!Number.isSafeInteger(candidate.maxImages) || Number(candidate.maxImages) <= 0
    || !Number.isSafeInteger(candidate.maxRawBytesPerImage) || Number(candidate.maxRawBytesPerImage) <= 0
    || !Number.isSafeInteger(candidate.maxEncodedBytesPerRequest) || Number(candidate.maxEncodedBytesPerRequest) <= 0) return null;
  return candidate as unknown as RuntimeImageCapability;
}

function spawnImageNegotiationValue(value: unknown): SpawnImageNegotiation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.spawnTransport !== "tmux" && candidate.spawnTransport !== "structured") return null;
  if (!candidate.imageInput || typeof candidate.imageInput !== "object" || Array.isArray(candidate.imageInput)) return null;
  const imageInput = candidate.imageInput as Record<string, unknown>;
  const claude = runtimeImageCapabilityValue(imageInput.claude);
  const codex = runtimeImageCapabilityValue(imageInput.codex);
  if (!claude || !codex) return null;
  /* A server from before Copilot sends no section; nothing is claimed for it. */
  const copilot = runtimeImageCapabilityValue(imageInput.copilot) ?? { ...claude, supported: false };
  return { spawnTransport: candidate.spawnTransport, imageInput: { claude, codex, copilot } };
}

const field = (id: string, name: string) => `llvDraftPane:${id}:${name}`;

export type RoleCatalogItem = RoleDefinition & { promptPreview: string };

/* One /api/roles fetch per session, shared by every draft pane and stage
   placeholder — a draft pipeline mounts one placeholder per stage, and each
   used to fire its own catalog request on mount (issue #221 §3 mount cost). */
let roleCatalogCache: RoleCatalogItem[] | null = null;
let roleCatalogRequest: Promise<RoleCatalogItem[] | null> | null = null;

function fetchRoleCatalog(): Promise<RoleCatalogItem[] | null> {
  roleCatalogRequest ??= fetch("/api/roles")
    .then(async (res) => {
      if (!res.ok) return null;
      const body = await res.json() as { roles?: RoleCatalogItem[] };
      return Array.isArray(body.roles) ? body.roles : null;
    })
    .catch(() => null)
    .then((roles) => {
      if (roles) roleCatalogCache = roles;
      else roleCatalogRequest = null; /* transient failure: allow a retry */
      return roles;
    });
  return roleCatalogRequest;
}

/** Replace the session's catalog with the one a mapping save answered (#1876),
    so the next draft opens on the runtime the install just chose. */
export function replaceRoleCatalog(roles: RoleCatalogItem[]): void {
  roleCatalogCache = roles;
  roleCatalogRequest = Promise.resolve(roles);
}

/** The shared /api/roles catalog (agent drafts + stage placeholders),
    session-cached: later mounts render the catalog synchronously. */
export function useRoleCatalog(): RoleCatalogItem[] {
  const [roles, setRoles] = useState<RoleCatalogItem[]>(() => roleCatalogCache ?? []);
  useEffect(() => {
    if (roleCatalogCache) return;
    let cancelled = false;
    void fetchRoleCatalog().then((fetched) => {
      if (!cancelled && fetched) setRoles(fetched);
    });
    return () => { cancelled = true; };
  }, []);
  return roles;
}

/**
 * The role block every draft-style window shares: role select, description,
 * typed parameters, and the scaffold + safety-fences preview. `allowedRoleIds`
 * narrows the catalog (a pipeline stage may not use deployer); `children`
 * renders extra fields between the params and the preview. `compactPreview` caps the scaffold preview's height for
 * fixed-height hosts (stage placeholder windows).
 */
export function RoleSection({
  idPrefix,
  roles,
  roleId,
  roleParams,
  disabled,
  allowedRoleIds,
  compactPreview,
  onSelectRole,
  onSetParam,
  children,
}: {
  idPrefix: string;
  roles: RoleCatalogItem[];
  roleId: string;
  roleParams: Record<string, string | number>;
  disabled?: boolean;
  allowedRoleIds?: ReadonlySet<string>;
  compactPreview?: boolean;
  onSelectRole: (roleId: string) => void;
  onSetParam: (key: string, value: string | number) => void;
  children?: React.ReactNode;
}) {
  const { t } = useLocale();
  const offered = allowedRoleIds ? roles.filter((role) => allowedRoleIds.has(role.id)) : roles;
  const selectedRole = offered.find((role) => role.id === roleId) ?? null;
  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-b border-border bg-sunken px-2.5 py-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <label className="shrink-0 text-caption font-semibold text-muted" htmlFor={`draft-role-${idPrefix}`}>{t("draft.role")}</label>
        <Select
          id={`draft-role-${idPrefix}`}
          value={roleId}
          disabled={disabled}
          onChange={(event) => onSelectRole(event.target.value)}
          aria-label={t("draft.roleAria")}
          className="flex-1"
        >
          <option value="">{t("draft.noRole")}</option>
          {offered.map((role) => <option key={role.id} value={role.id}>{roleName(t, role)}</option>)}
        </Select>
      </div>
      {selectedRole ? (
        <>
          <p className="text-caption leading-4 text-muted">{roleDescription(t, selectedRole)}</p>
          {selectedRole.parameters.length ? (
            <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("draft.roleParameters")}>
              {selectedRole.parameters.map((parameter) => {
                const label = roleParamLabel(t, selectedRole.id, parameter);
                return (
                  <label key={parameter.key} className="flex min-w-28 flex-1 flex-col gap-0.5 text-caption text-muted">
                    <span>{label}{parameter.required ? " *" : ""}</span>
                    {parameter.kind === "select" ? (
                      <Select value={String(roleParams[parameter.key] ?? "")} disabled={disabled} onChange={(event) => onSetParam(parameter.key, event.target.value)}>
                        {parameter.options?.map((option) => (
                          <option key={option} value={option}>{roleParamOptionLabel(t, selectedRole.id, parameter.key, option)}</option>
                        ))}
                      </Select>
                    ) : (
                      <input type={parameter.kind === "integer" ? "number" : "text"} min={parameter.kind === "integer" ? parameter.min : undefined} max={parameter.kind === "integer" ? parameter.max : undefined} value={String(roleParams[parameter.key] ?? "")} disabled={disabled} onChange={(event) => onSetParam(parameter.key, parameter.kind === "integer" && event.target.value ? Number(event.target.value) : event.target.value)} aria-label={label} className="h-7 min-w-0 rounded-control border border-border bg-card px-1.5 text-ui text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60" />
                    )}
                    <span className="leading-3">{roleParamDescription(t, selectedRole.id, parameter)}</span>
                  </label>
                );
              })}
            </div>
          ) : null}
          {children}
          {/* The full scaffold the agent will receive stays English (it IS the
              prompt) — folded behind a clearly-labeled collapsible so the uk UI
              never shows raw English copy uninvited (issue #221 §1/§5). */}
          <details className="rounded-control border border-border bg-card/60">
            <summary className="min-h-7 cursor-pointer select-none list-item px-2 py-1 text-caption font-semibold text-secondary marker:text-muted hover:text-primary">
              {t("draft.rolePromptToggle")}
            </summary>
            <div className="border-t border-border px-2 py-1.5 text-caption leading-4 text-muted">
              <pre className={`whitespace-pre-wrap font-sans ${compactPreview ? "max-h-24 overflow-y-auto" : ""}`}>{scaffoldPreview(selectedRole.promptPreview, roleParams)}</pre>
              <ul className={`mt-1 list-disc pl-4 ${compactPreview ? "max-h-16 overflow-y-auto" : ""}`} aria-label={t("draft.safetyFences")}>
                {selectedRole.safetyFences.map((fence) => <li key={fence}>{fence}</li>)}
              </ul>
            </div>
          </details>
        </>
      ) : null}
    </div>
  );
}

function readField(id: string, name: string): string {
  if (typeof window === "undefined") return "";
  return sessionStorage.getItem(field(id, name)) ?? "";
}

function writeField(id: string, name: string, value: string) {
  if (value) sessionStorage.setItem(field(id, name), value);
  else sessionStorage.removeItem(field(id, name));
}

function scaffoldPreview(scaffold: string, params: Record<string, string | number>): string {
  return scaffold.replace(/\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g, (_match, key: string) => String(params[key] ?? ""));
}

/** Everything a draft keeps in sessionStorage; called when the draft leaves the board. The role fields are
    the ones the form had before it became the composer alone: a tab that still holds them is cleared too. */
export function clearDraftStorage(id: string) {
  for (const name of ["engine", "model", "cwd", "cwdSeed", "text", "boot", "src", "parentConversationId", "band", "effort", "speed", "accountId", "role", "roleParams", "reviews", "confirm"]) sessionStorage.removeItem(field(id, name));
}

/** Source transcript a handoff draft continues; empty for a plain draft. */
export function draftSrc(id: string): string {
  return readField(id, "src");
}

/** Persisted editable directory, used to restore a draft before its pane mounts. */
export function draftCwd(id: string): string {
  return readField(id, "cwd").trim();
}

export function draftParentConversationId(id: string): string {
  return readField(id, "parentConversationId");
}

/** Marks a fresh draft as a handoff of the given transcript, before it mounts. */
export function setDraftSrc(id: string, src: string, parentConversationId?: string) {
  writeField(id, "src", src);
  writeField(id, "parentConversationId", parentConversationId ?? "");
}

/** Board band a band-local «+ Agent» draft belongs to (#1586); empty for a
    global draft. The band layout places the draft inside that band, and a
    `task:<id>` band records the assignment on the task once the launched
    transcript exists. */
export function draftBand(id: string): string {
  return readField(id, "band");
}

export function setDraftBand(id: string, bandId: string) {
  writeField(id, "band", bandId);
}

/** Seeds a fresh draft's first prompt, before it mounts — the «send a task to
    a brand-new agent» path drops the task text here, launching nothing. */
export function setDraftText(id: string, text: string) {
  writeField(id, "text", text);
}

/** Seeds a draft's editable cwd before its first render, recording it as the
    system's own answer (see {@link draftCwdIsUntouched}). */
export function setDraftCwd(id: string, cwd: string) {
  const next = cwd.trim();
  writeField(id, "cwd", next);
  writeField(id, "cwdSeed", next);
}

/**
 * Whether the draft still holds the directory the system put there — nothing
 * empty, nothing the operator picked. Provenance, not doubt: a better system
 * answer arriving late (the project's canonical root, the source transcript's
 * own cwd) may replace an untouched seed, and must never overwrite a directory
 * the operator chose.
 */
export function draftCwdIsUntouched(id: string): boolean {
  const current = readField(id, "cwd").trim();
  return !current || current === readField(id, "cwdSeed").trim();
}

const DRAFT_CWD_RESOLVED_EVENT = "llv:draft-cwd-resolved";

/** Replaces an untouched seed once better metadata identifies the canonical
    root, and tells a mounted pane to redraw with it. */
export function resolveSystemDraftCwd(id: string, cwd: string): boolean {
  const next = cwd.trim();
  if (!next || !draftCwdIsUntouched(id) || readField(id, "cwd").trim() === next) return false;
  setDraftCwd(id, next);
  window.dispatchEvent(new window.CustomEvent(DRAFT_CWD_RESOLVED_EVENT, { detail: { id, cwd: next } }));
  return true;
}

/** Reads back the durable spawn attempt persisted across reload. Its presence
    means a worker may exist, so the composer stays frozen and send disabled. */
function readAttempt(id: string): SpawnAttempt | null {
  try {
    const raw = JSON.parse(readField(id, "boot") || "null") as SpawnAttempt | null;
  if (!raw || typeof raw.at !== "number" || typeof raw.prompt !== "string" || typeof raw.clientAttemptId !== "string") return null;
  if (raw.phase !== "booting" && raw.phase !== "confirming" && raw.phase !== "attention") return null;
  return { ...raw, request: raw.request && typeof raw.request === "object" ? raw.request : null };
  } catch {
    return null;
  }
}

/** A fresh idempotency key for one launch — a converging re-POST replays onto
    the same server receipt and prevents a duplicate worker. Matches the
    route's `^[A-Za-z0-9_-]{8,128}$` gate. */
function newAttemptId(): string {
  const raw = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12);
  return raw.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 128).padEnd(8, "0");
}

/**
 * What the launched conversation's card adds around its feed, held from the
 * press. The launch reply replaces this pane with the product's own card: the
 * task's title, status and description rows, then the conversation's window
 * with its head. These rows keep that room, in the board's own classes, so the
 * first message is drawn where the window will draw it and nothing the operator
 * is reading moves when the reply lands (kanbanBoard.css shows them on a card
 * that holds nothing but the draft; a task's card already has its own rows).
 */
function OpeningCardRows({ title }: { title: string }) {
  return (
    <div aria-hidden data-draft-card-rows="" className="draft-card-rows hidden">
      <div className="head">
        <span className="h-4 w-4 shrink-0" />
        <h3 className="title"><span className="clamp">{title}</span></h3>
        <span className="h-6 w-[82px] shrink-0" />
      </div>
      <span className={`h-4 w-24 ${SKELETON_BAR}`} />
      <span className="h-7" />
    </div>
  );
}

/** The opening of the conversation: the window's head on the board (the phone names a conversation in its
    top bar instead), the first message as the feed's own row, and the loading shape where the answer will be. */
function OpeningFeed({ text, status, phone }: { text: string; status: React.ReactNode; phone: boolean }) {
  return (
    <>
      {phone ? null : (
        <div aria-hidden data-draft-opening-head="" className="draft-opening-head flex shrink-0 flex-col justify-center gap-2">
          <span className={`h-3 w-2/5 ${SKELETON_BAR}`} />
          <span className={`h-2.5 w-1/4 ${SKELETON_BAR}`} />
        </div>
      )}
      <div data-draft-opening="" className={`draft-opening flex min-h-0 flex-1 flex-col gap-3 overflow-hidden ${phone ? "pt-1" : ""}`}>
        <FeedMessageRow entry={null} canonical={{ text }} />
        <FeedSkeleton latestOnly className="!flex-none !justify-start !px-0 !pb-1 !pt-0" />
        {status}
      </div>
    </>
  );
}

/**
 * A conversation that does not exist yet: the conversation composer and
 * nothing else (docs/design/new-agent-redesign.md, variant 1). The prompt is
 * typed or dictated, the runtime pill picks the engine, model, tier and
 * account, and Send launches at once. The project and the working directory
 * come from where the draft was opened and are never shown. From the press the
 * pane is the conversation: the first message as the feed's own row above the
 * feed's loading shape, until the launched conversation takes the pane over.
 */
export function DraftAgentPane({
  draftId,
  project,
  files,
  onClose,
  onSpawned,
}: {
  draftId: string;
  project: string;
  files: FileEntry[];
  onClose: () => void;
  onSpawned: (file: FileEntry) => void;
}) {
  const { t } = useLocale();
  /* A handoff draft carries the transcript it continues; set by the opener
     before the draft lands on the scheme, immutable for the draft's life. */
  const [src] = useState(() => readField(draftId, "src"));
  const [parentConversationId] = useState(() => readField(draftId, "parentConversationId"));
  const srcFile = src ? (files.find((entry) => entry.path === src) ?? null) : null;
  const [initialCwd] = useState(() => readField(draftId, "cwd"));
  /* A handoff draft opens on a locally guessed directory; the spawn route
     answers with the source transcript's own cwd, which replaces the guess as
     long as the operator has not picked a directory of their own. */
  const awaitingInheritedCwdRef = useRef(Boolean(src && draftCwdIsUntouched(draftId)));
  const [cwd, setCwdState] = useState(() => initialCwd || draftWorkingDirectory(files, project, src));
  /* A handoff launches in its source's own checkout and nowhere else. The seed above is the board's guess
     for it, which nobody sees any more, so only a directory the source itself names counts: the one the
     spawn route reads from the source transcript, or, when the route could not read one, the one the files
     feed carries for it. A directory the route says is gone (a worktree removed after its merge) is not
     launched in, whatever the feed still remembers. */
  const [answeredSource, setAnsweredSource] = useState<{ cwd: string; exists: boolean } | null>(null);
  const sourceRemoved = Boolean(src && answeredSource && !answeredSource.exists);
  const isMobile = useIsMobile();
  /* The stored key is "" before the first negotiation and after an engine flip;
     the derived value below reads any mismatch as «loading», which is exactly
     what a not-yet-negotiated engine is. */
  const [storedSpawnImageNegotiation, setSpawnImageNegotiation] = useState<SpawnImageNegotiationState>({
    status: "loading",
    requestKey: "",
  });
  /* Engine, model, effort, codex speed and the stored account are the SHARED
     launch parameters (PRD #976 slice A): the state and its invariants live in
     one module, this pane keeps only its own persistence, and the runtime pill
     reads and writes this same object, so what it shows is what Send launches. */
  const launch = useAgentLaunchDraft({
    storage: {
      read: (name) => readField(draftId, name),
      write: (name, value) => writeField(draftId, name, value),
    },
    initialEngine: srcFile?.engine === "codex" || srcFile?.engine === "copilot" ? srcFile.engine : "claude",
    onEngineChange: (value) => setSpawnImageNegotiation({ status: "loading", requestKey: `${project}\n${src ?? ""}\n${value}` }),
  });
  const { engine, model, effort, speed } = launch;
  /* The engine readiness preflight (#2170): a launch on a signed-out account
     would only fail, so the action becomes that account's sign-in. */
  const readiness = useLaunchReadiness(launch);
  const signInFirst = readiness.kind === "signed-out" ? readiness : null;
  const spawnImageNegotiationKey = `${project}\n${src ?? ""}\n${engine}`;
  const [spawnNegotiationAttempt, setSpawnNegotiationAttempt] = useState(0);
  const spawnImageNegotiation: SpawnImageNegotiationState = storedSpawnImageNegotiation.requestKey === spawnImageNegotiationKey
    ? storedSpawnImageNegotiation
    : { status: "loading", requestKey: spawnImageNegotiationKey };
  const [attempt, setAttemptState] = useState<SpawnAttempt | null>(() => readAttempt(draftId));
  const [slowBoot, setSlowBoot] = useState(false);
  /* Watch-window base (issue #919): a stream re-subscribe resets it, because a
     reconnect means everything the tab failed to observe before it may simply
     have been missed — the timers restart instead of the watch giving up. */
  const [watchBase, setWatchBase] = useState<number | null>(null);
  const attentionRef = useRef<HTMLDivElement>(null);
  /* Records launched from this mount are already in flight. Reloaded records
     are replayed once with their own idempotency key to fetch the same receipt. */
  const replayedAttemptIds = useRef(new Set<string>());
  /* Held from the press until its POST answers. `attempt` and `busy` are read from the last render, and two
     presses can land before the next one: Enter and a click in one task each saw no attempt and each made
     its own idempotency key, which the server cannot join. */
  const launchingRef = useRef(false);

  useEffect(() => {
    const applyResolvedCwd = (event: Event) => {
      const detail = (event as CustomEvent<{ id?: string; cwd?: string }>).detail;
      if (detail?.id !== draftId || typeof detail.cwd !== "string") return;
      awaitingInheritedCwdRef.current = false;
      setCwdState(detail.cwd);
    };
    window.addEventListener(DRAFT_CWD_RESOLVED_EVENT, applyResolvedCwd);
    return () => window.removeEventListener(DRAFT_CWD_RESOLVED_EVENT, applyResolvedCwd);
  }, [draftId]);

  const setAttempt = useCallback((value: SpawnAttempt | null) => {
    setAttemptState(value);
    writeField(draftId, "boot", value ? JSON.stringify(value) : "");
  }, [draftId]);
  const readySpawnImageNegotiation = spawnImageNegotiation.status === "ready" ? spawnImageNegotiation.value : null;
  /* The composer host capability the draft already negotiates (issue #266): a
     structured (pane-less) spawn has no tmux window, so every launch-copy that
     names tmux drops it. The default `tmux` transport keeps the legacy wording,
     as does the pre-negotiation window (the server defaults to tmux too). */
  const structuredSpawn = readySpawnImageNegotiation?.spawnTransport === "structured";
  const negotiatedSpawnImageCapability = readySpawnImageNegotiation?.spawnTransport === "structured"
    ? readySpawnImageNegotiation.imageInput[engine]
    : null;
  const structuredSpawnImageCapability = negotiatedSpawnImageCapability && engine === "codex" && !codexModelSupportsImages(model)
    ? { ...negotiatedSpawnImageCapability, supported: false, reason: t("composer.codexImagesTextOnly") }
    : negotiatedSpawnImageCapability;

  /* While a spawn is in flight the whole draft is frozen (boot set), so the
     composer's fields lock alongside the send/voice flags. */
  const composer = useComposer({
    initialText: () => readField(draftId, "text") || (src ? t("draft.readPrompt", { src }) : ""),
    persistText: (value) => writeField(draftId, "text", value),
    submit: (overrideText) => send(overrideText),
    disabled: Boolean(attempt),
    imageCapability: structuredSpawnImageCapability,
  });
  const { text, setText, setStatus, busy, setBusy, voiceSending, attachments } = composer;

  /* What the engine takes as images, and for a handoff draft the source
     transcript's own cwd, which it inherits over everything else. */
  useEffect(() => {
    let cancelled = false;
    const requestKey = spawnImageNegotiationKey;
    fetch("/api/spawn?project=" + encodeURIComponent(project) + (src ? "&src=" + encodeURIComponent(src) : ""))
      .then(async (res) => {
        if (!res.ok) throw new Error("spawn capability request failed");
        return await res.json() as { dirs?: string[]; cwd?: string | null; cwdExists?: boolean; spawnTransport?: unknown; imageInput?: unknown };
      })
      .then((json) => {
        if (cancelled) return;
        const inherited = typeof json.cwd === "string" ? json.cwd.trim() : "";
        const shouldInherit = Boolean(awaitingInheritedCwdRef.current && inherited);
        if (shouldInherit) awaitingInheritedCwdRef.current = false;
        /* An older route answers no `cwdExists`; only an explicit `false` reads as a removed checkout. */
        if (src && inherited) setAnsweredSource({ cwd: inherited, exists: json.cwdExists !== false });
        setCwdState((prev) => {
          /* Only the source's own directory is inherited. The suggestions' other directories are guesses
             the operator used to see and correct; unseen, a guess is not launched in. */
          const next = (shouldInherit && inherited) || prev || inherited || "";
          if (next !== prev) setDraftCwd(draftId, next);
          return next;
        });
        const negotiation = spawnImageNegotiationValue(json);
        if (!negotiation) throw new Error("spawn capability response is invalid");
        setSpawnImageNegotiation({ status: "ready", requestKey, value: negotiation });
      })
      .catch(() => {
        if (!cancelled) setSpawnImageNegotiation({ status: "error", requestKey });
      });
    return () => {
      cancelled = true;
    };
  }, [project, draftId, src, engine, spawnImageNegotiationKey, spawnNegotiationAttempt]);

  /* The handover uses the exact receipt path, conversation id, or — when the
     accepted POST's response was lost — the durable projection's exact
     clientAttemptId (finding 3). A nearby transcript can be a simultaneous draft,
     so it cannot establish ownership. */
  useEffect(() => {
    if (!attempt) return;
    const hit = matchSpawnedFile(attempt, files);
    if (!hit) return;
    /* Lost-response recovery: with no response, submitAttempt never seeded the
       launch prompt. Seed it now under the canonical identity, keyed by the
       launch id so the success-path seed (or a reload replay) is a no-op — the
       queued canonical window shows the initial prompt exactly once. */
    const launchId = hit.spawn?.launchId ?? attempt.launchId;
    if (launchId && (attempt.prompt.trim() || attempt.hasImages)) {
      seedLaunchOutbox(conversationIdentity(hit), {
        id: launchId,
        text: attempt.prompt,
        images: attempt.request?.images.length ?? 0,
        at: attempt.at,
      });
    }
    onSpawned(hit);
  }, [files, attempt, onSpawned]);

  /* One bounded timer per attempt: a known-path boot only earns the slow hint
     (its file is deterministic and will still appear), and so does an ADMITTED
     confirming launch (issue #919: the receipt proved the worker, so the watch
     keeps going forever and only admits it is slow). Only a confirming attempt
     with no receipt at all — a genuinely unproven launch — escalates to
     `attention`, where the copy discourages a relaunch. Adoption above can
     still win afterward. */
  useEffect(() => {
    if (!attempt || attempt.phase === "attention") return;
    const bound = attempt.phase === "booting" ? SLOW_BOOT_MS : CONFIRM_ATTENTION_MS;
    const escalate = () => {
      if (attempt.phase === "booting" || admittedSpawn(attempt)) setSlowBoot(true);
      else setAttempt({ ...attempt, phase: "attention" });
    };
    const left = (watchBase ?? attempt.at) + bound - Date.now();
    if (left <= 0) {
      escalate();
      return;
    }
    const timer = window.setTimeout(escalate, left);
    return () => window.clearTimeout(timer);
  }, [attempt, setAttempt, watchBase]);

  /* A stream re-subscribe resets the watch window (issue #919): the tab's SSE /
     files feed reconnected, so the slow admission clears and the timers restart
     from now — the watch survives reconnects instead of aging through them. */
  useEffect(() => {
    const resetWatch = () => {
      setSlowBoot(false);
      setWatchBase(Date.now());
    };
    window.addEventListener(STREAM_RECONNECTED_EVENT, resetWatch);
    return () => window.removeEventListener(STREAM_RECONNECTED_EVENT, resetWatch);
  }, []);

  /* When recovery gives up, move focus to the assertive attention notice so a
     keyboard/screen-reader user lands on the "don't relaunch" guidance. */
  useEffect(() => {
    if (attempt?.phase === "attention") attentionRef.current?.focus();
  }, [attempt?.phase]);

  const submitAttempt = useCallback(async (candidate: SpawnAttempt & { request: NonNullable<SpawnAttempt["request"]> }) => {
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch("/api/spawn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(spawnRequestBody(candidate)),
      });
      let json: SpawnResponseBody | null = null;
      try {
        json = (await res.json()) as SpawnResponseBody;
      } catch {
        json = null;
      }
      const outcome = classifySpawnResponse(res.status, res.ok, json);
      /* The server's own launch receipt is the event, and its id is the event's
         identity: a reload that re-POSTs the identical idempotency key gets the
         same launchId back, so the replay is silent. `clientAttemptId` covers a
         receipt that named no launch — it is durable across the same reload. */
      const launchEventId = outcome.kind === "launched" || outcome.kind === "failed-launch"
        ? outcome.launchId ?? candidate.clientAttemptId
        : null;
      if (launchEventId) {
        playCue(
          outcome.kind === "launched"
            ? { cue: "launch", eventId: `launch:${launchEventId}` }
            : { cue: "failure", eventId: `launch-failed:${launchEventId}` },
        );
      }
      if (typeof json?.launchId === "string" && typeof json.conversationId === "string") requestFilesRefresh();
      if (outcome.kind === "launched") {
        /* Seed the operator's launch prompt as the conversation's first
           optimistic user bubble (round-1 P1#2): the SPAWN delivers it, so the
           queued launch window shows the message immediately instead of an empty
           feed under status chips. Keyed on the durable conversation identity
           (the same identity the spawn placeholder and the materialized
           transcript share) and by the launch id, so a reload-replay is a no-op.
           When only the launch id is known yet, seed under the `spawn:` route so
           the window's composer adopts it forward onto the conversation. */
        const outboxCardId = outcome.conversationId ?? (outcome.launchId ? `spawn:${outcome.launchId}` : null);
        if (outboxCardId && outcome.launchId) {
          seedLaunchOutbox(outboxCardId, {
            id: outcome.launchId,
            text: candidate.prompt,
            images: candidate.request.images.length,
            at: candidate.at,
          });
        }
        setAttempt(applySpawnOutcome(candidate, outcome));
        /* Instant receipt-keyed attach (issue #919): a structured receipt names
           the durable conversation id, which IS the identity the live window
           keys its stream subscription on — so the panel hands over to the
           conversation window now. The overlay makes every mounted board render
           the same `spawn:<launchId>` card the server projects; the files feed
           later confirms and replaces it, never gates the attach. */
        const provisional = provisionalSpawnFile(candidate, outcome, project);
        if (provisional) {
          markLaunchedConversation(provisional);
          applySpawnedConversationSnapshot(provisional);
          onSpawned(provisional);
        }
      } else if (outcome.kind === "failed-launch") {
        setAttempt(applySpawnFailure(candidate, outcome));
      } else if (outcome.kind === "failed-preflight") {
        const upgraded = upgradeLegacySpawnAttempt(candidate, outcome);
        if (upgraded) {
          replayedAttemptIds.current.delete(candidate.clientAttemptId);
          setAttempt(upgraded);
          return;
        }
        /* The server released worker ownership. Restore the exact durable
           payload so editing and retrying cannot lose an attachment. */
        setAttempt(null);
        setText(candidate.request.prompt);
        const restored = attachments.replace(candidate.request.images.map((image) => ({
          ...image,
          preview: `data:${image.mime};base64,${image.base64}`,
        })));
        if (restored) setStatus({ kind: "err", text: outcome.message ?? t("draft.launchFailed") });
      }
      /* Ambiguous outcomes keep the persisted request and frozen card. A
         future reload can re-POST the identical idempotency key. */
    } catch {
      classifyTransportLoss();
      /* Transport loss leaves the persisted attempt unchanged. */
    } finally {
      setBusy(false);
    }
  }, [attachments, onSpawned, project, setAttempt, setBusy, setStatus, setText, t]);

  /* A reload during POST has the original payload already in session storage.
     Replaying that exact body returns its server receipt and never starts a
     second worker because clientAttemptId is stable. */
  useEffect(() => {
    if (!attempt || !hasRecoverableRequest(attempt) || replayedAttemptIds.current.has(attempt.clientAttemptId)) return;
    replayedAttemptIds.current.add(attempt.clientAttemptId);
    void submitAttempt(attempt);
  }, [attempt, submitAttempt]);

  const spawnImagesDisabled = spawnImageNegotiation.status !== "ready"
    || (readySpawnImageNegotiation?.spawnTransport === "structured" && !structuredSpawnImageCapability?.supported);
  const spawnImagesReason = spawnImageNegotiation.status === "loading"
    ? t("composer.imageCapabilityLoading")
    : spawnImageNegotiation.status === "error"
      ? t("composer.imageCapabilityError")
      : readySpawnImageNegotiation?.spawnTransport === "structured" && engine === "codex" && !codexModelSupportsImages(model)
        ? t("composer.codexImagesTextOnly")
        : readySpawnImageNegotiation?.spawnTransport === "structured" && !structuredSpawnImageCapability?.supported
        ? t("composer.structuredImagesProtocol")
        : undefined;

  /* The directory the launch runs in, never shown and never asked: the one the board seeded from where the
     draft was opened, or a handoff's source directory. `/` is what the board seeds while the project's
     folder is still unresolved; it counts only when the project's own conversations say the root is `/`. */
  const seededCwd = cwd.trim();
  const sourceCwd = !src || sourceRemoved
    ? ""
    : answeredSource?.cwd || (spawnImageNegotiation.status === "loading" ? "" : srcFile?.cwd?.trim() || "");
  const launchCwd = src
    ? sourceCwd
    : seededCwd && seededCwd !== "/" ? seededCwd : draftWorkingDirectory(files, project);
  /* The level the launch carries is one the chosen model has; a stored level from another model is not sent. */
  const launchEffort = effort && (effortScale(engine, model) ?? []).includes(effort) ? effort : "";

  const send = async (overrideText?: string) => {
    const payloadText = overrideText ?? text;
    if (busy || voiceSending || attempt || launchingRef.current) return;
    if (signInFirst) {
      openLaunchSignIn(signInFirst);
      return;
    }
    if (attachments.images.length && spawnImagesDisabled) {
      setStatus({ kind: "err", text: spawnImagesReason ?? t("composer.structuredImagesUnavailable") });
      return;
    }
    if (attachments.images.length && !attachments.validate()) return;
    if (!launchCwd) return;
    if (!payloadText.trim() && !attachments.images.length) return;
    const candidate = createSpawnAttempt(newAttemptId(), Date.now(), {
      title: draftSpawnTitle(engine, "", payloadText, attachments.images.length),
      engine,
      model,
      cwd: launchCwd,
      effort: launchEffort,
      fast: engine === "codex" && speed ? speed === "fast" : null,
      accountId: launch.launchAccountId,
      "prompt": payloadText,
      images: attachments.images.map((image) => ({ base64: image.base64, mime: image.mime })),
      src,
      ...(parentConversationId ? { parentConversationId } : {}),
      ...(draftBand(draftId).startsWith("task:") ? { taskId: draftBand(draftId).slice("task:".length) } : {}),
    });
    /* Persist before POST: a navigation now has the launch id, timestamp, and
       exact recoverable payload needed to reconcile the original request. */
    launchingRef.current = true;
    replayedAttemptIds.current.add(candidate.clientAttemptId);
    setSlowBoot(false);
    setWatchBase(null);
    setAttempt(candidate);
    setText("");
    attachments.clear();
    try {
      await submitAttempt(candidate);
    } finally {
      /* A refused launch gives the field back, and the next press is a new attempt. */
      launchingRef.current = false;
    }
  };

  const fieldsDisabled = composer.fieldsDisabled;
  /* Display phase drives the status line. `busy` (POST in flight) shows as
     `launching`; a durable attempt shows booting/booting-slow/confirming/attention. */
  const phase = displayPhase(attempt, busy, slowBoot);
  const target = attempt?.target ?? "";
  const sent = Boolean(attempt);
  /* The launch speaks in words only once it needs the operator: it is slow, it
     could not be confirmed, or it failed. Until then the loading shape says it. */
  const launchStatus = attempt && (phase === "booting-slow" || phase === "confirming-slow" || phase === "attention" || attempt.error)
    ? <DraftLaunchStatus ref={attentionRef} phase={phase} target={target} structured={structuredSpawn} error={attempt.error ?? null} />
    : null;
  const blockedReason = attempt
    ? undefined
    : signInFirst
      ? t("launch.accountSignedOut", { label: signInFirst.label, engine: launchEngineLabel(signInFirst.engine) })
      : launchCwd
        ? undefined
        : !src
          ? t("draft.folderUnknown")
          : sourceRemoved
            ? t("draft.sourceFolderRemoved")
            : spawnImageNegotiation.status === "loading" ? t("draft.sourceFolderPending") : t("draft.sourceFolderUnknown");

  /* The title the launched card will carry: the launch's own title without the engine it leads with. */
  const openingTitle = (attempt?.request?.title ?? "").replace(/^[^·]*·\s*/, "") || attempt?.prompt.split("\n")[0] || "";
  const { inputRef } = composer;
  /* The cursor is in the field the moment the draft opens. */
  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, [inputRef]);

  const paneRef = useRef<HTMLElement>(null);
  /* On Send the card grows to a conversation's height. It is brought to the top of its column the way the
     board lands a launched card whose head is out of sight (`KanbanBoard`, the landing reveal), so that
     reveal finds the head in view when the launch answers and scrolls nothing. */
  useEffect(() => {
    if (sent) paneRef.current?.closest<HTMLElement>(".card")?.scrollIntoView?.({ block: "start", inline: "nearest", behavior: "auto" });
  }, [sent]);

  return (
    /* `reader-host` is the board's own opt-out from its button reset (kanbanBoard.css), the one a conversation uses. */
    <section
      ref={paneRef}
      data-pan-ignore
      data-draft-pane={sent ? "opening" : "composer"}
      aria-label={t("draft.paneAria")}
      className={`reader-host flex min-w-0 flex-col gap-2 ${sent || isMobile ? "h-full min-h-0 flex-1" : ""} ${isMobile ? "border border-transparent bg-card p-3" : ""}`}
    >
      {sent ? <OpeningCardRows key="card-rows" title={openingTitle} /> : null}
      <div key="window" data-draft-window="" className={`draft-window flex min-w-0 flex-col gap-2 ${sent || isMobile ? "min-h-0 flex-1" : ""}`}>
      {sent
        ? <OpeningFeed key="feed" text={attempt!.prompt || t("draft.imagesOnly")} status={launchStatus} phone={isMobile} />
        : isMobile ? <div key="room" className="min-h-0 flex-1" /> : null}
      <form
        key="form"
        data-draft-form=""
        className="flex min-w-0 shrink-0 flex-col gap-1.5"
        aria-label={t("draft.promptAria")}
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
        onKeyDown={(event) => {
          /* Escape on an empty field puts the draft away, as it does for a new task. */
          if (event.key !== "Escape" || event.defaultPrevented || sent || text || attachments.attachments.length) return;
          event.preventDefault();
          onClose();
        }}
      >
        {spawnImageNegotiation.status === "error" ? (
          <div role="alert" className="flex items-center justify-between gap-2 rounded-control bg-danger-soft px-2 py-1 text-caption text-danger">
            <span>{t("composer.imageCapabilityError")}</span>
            <button
              type="button"
              className="shrink-0 rounded-control border border-danger/30 bg-card px-2 py-1 font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/30"
              onClick={() => {
                setSpawnImageNegotiation({ status: "loading", requestKey: spawnImageNegotiationKey });
                setSpawnNegotiationAttempt((attempt) => attempt + 1);
              }}
            >
              {t("composer.imageCapabilityRetry")}
            </button>
          </div>
        ) : null}
        <ComposerBar
          composer={composer}
          placeholder={structuredSpawn ? t("draft.placeholderStructured") : t("draft.placeholder")}
          textareaAriaLabel={t("draft.promptTextAria")}
          imageAriaLabel={t("draft.addImages")}
          sendLabelIdle={t("composer.launchAgent")}
          sendLabelRecording={t("draft.stopAndLaunch")}
          sendIdleClassName="border-accent bg-accent hover:opacity-90"
          imageDisabled={spawnImagesDisabled}
          imageDisabledReason={spawnImagesReason}
          sendDisabledReason={blockedReason}
          onSendBlockedRecover={signInFirst && !attempt ? () => openLaunchSignIn(signInFirst) : undefined}
          sendBlockedRecoverLabel={signInFirst ? t("launch.signInFirst", { engine: launchEngineLabel(signInFirst.engine) }) : undefined}
          leftSlot={<DraftRuntimePill launch={launch} disabled={fieldsDisabled} />}
        />
      </form>
      </div>
    </section>
  );
}
