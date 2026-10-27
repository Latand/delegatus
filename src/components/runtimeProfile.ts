import { conversationIdentity } from "@/lib/accounts/identity";
import { clampEffortToScale, effortScale } from "@/lib/agent/efforts";
import { ENGINE_MODELS, claudeCatalogModelId, defaultModelFor } from "@/lib/agent/models";
import type { FileEntry } from "@/lib/types";

/** A concrete, fully-resolved runtime selection (model + effort + fast). Used by
    the pill face, the live-tmux draft and the resume/stage pickers. `serviceTier`
    names a Codex catalog tier the fast flag cannot say (ultrafast); absent or
    null, `fast` alone is the speed. */
export type RuntimeDraft = { model: string; effort: string; fast: boolean; serviceTier?: string | null };

/** The tier as a draft field: present only when one is named, so a draft that has
    none keeps the shape every earlier reader and stored record has. */
function tierField(tier: string | null | undefined): { serviceTier?: string } {
  return tier ? { serviceTier: tier } : {};
}

/** The tiers that are `fast` itself: a named tier beyond them only `serviceTier` can carry. */
function namedServiceTier(tier: string | null | undefined): string | null {
  return tier && !["default", "standard", "priority"].includes(tier) ? tier : null;
}

/** A *sparse* per-conversation runtime selection: only the fields the user has
    explicitly chosen. Persisted under the `:profile` key so a synthesized
    display default never becomes a silent override (issue #241 finding 4). */
export type RuntimeProfile = { model?: string; effort?: string; fast?: boolean };

/** Base identity-scoped storage key for a conversation's runtime state. */
export function storageKey(file: FileEntry): string {
  return `llvAgentRuntime:${conversationIdentity(file)}`;
}

/** The live-tmux reconfigure convergence phase marker key. */
export function phaseKey(file: FileEntry): string {
  return storageKey(file) + ":phase";
}

/** The operation that owns the persisted reconfigure phase across remounts. */
export function phaseOperationKey(file: FileEntry): string {
  return phaseKey(file) + ":operation";
}

/** Browser rollback snapshot for the operation that owns the persisted phase. */
export function phaseRollbackKey(file: FileEntry): string {
  return phaseKey(file) + ":rollback";
}

/** The "on resume" profile key (issue #241 §4). */
export function resumeKey(file: FileEntry): string {
  return storageKey(file) + ":resume";
}

/** The auto-apply per-conversation profile key (issue #390 §4.5). */
export function profileKey(file: FileEntry): string {
  return storageKey(file) + ":profile";
}

/** The observed/boot model id the running (or recorded) agent resolves to. */
export function observedModelId(file: FileEntry): string | null {
  const engine = file.engine as "claude" | "codex" | "copilot";
  return engine === "claude"
    ? claudeCatalogModelId(file.launchModel ?? file.model) ?? file.model ?? null
    : file.model ?? null;
}

/** Engine defaults for a conversation: the observed model when it is a known
    catalog entry, else the shipped launch fallback; the observed effort when it is
    in that model's scale, else the scale's lowest tier. */
export function defaults(file: FileEntry): RuntimeDraft {
  const engine = file.engine as "claude" | "codex" | "copilot";
  const models = ENGINE_MODELS[engine];
  const observed = observedModelId(file);
  const model = models.some((item) => item.id === observed) || (engine === "copilot" && !!observed && /^[a-z0-9][a-z0-9.-]{0,127}$/.test(observed)) ? observed! : defaultModelFor(engine);
  const efforts = effortScale(engine, model) ?? [];
  return { model, effort: efforts.includes(file.effort ?? "") ? file.effort! : efforts[0]!, fast: file.serviceTier ? !["default", "standard"].includes(file.serviceTier) : file.fast ?? false, ...tierField(file.serviceTier) };
}

/** The live-tmux persisted draft (full), or the conversation's defaults. */
export function readDraft(file: FileEntry): RuntimeDraft {
  const fallback = defaults(file);
  try {
    const value = JSON.parse(localStorage.getItem(storageKey(file)) ?? "null") as Partial<RuntimeDraft> | null;
    const engine = file.engine as "claude" | "codex" | "copilot";
    const model = ENGINE_MODELS[engine].some((item) => item.id === value?.model) || (engine === "copilot" && typeof value?.model === "string" && /^[a-z0-9][a-z0-9.-]{0,127}$/.test(value.model)) ? value!.model! : fallback.model;
    const efforts = effortScale(engine, model) ?? [];
    return {
      model,
      effort: efforts.includes(value?.effort ?? "") ? value!.effort! : fallback.effort,
      fast: engine === "codex" && typeof value?.fast === "boolean" ? value.fast : fallback.fast,
      ...tierField(storedServiceTier(engine, value, fallback)),
    };
  } catch {
    return fallback;
  }
}

/** A stored draft's tier: its own, else the conversation's while the stored speed
    still agrees with it, since a draft written before tiers existed names none. */
function storedServiceTier(engine: string, value: Partial<RuntimeDraft> | null, fallback: RuntimeDraft): string | null {
  if (engine !== "codex") return null;
  if (typeof value?.serviceTier === "string") return value.serviceTier;
  return typeof value?.fast !== "boolean" || value.fast === fallback.fast ? fallback.serviceTier ?? null : null;
}

/** The persisted resume profile for a conversation, or its defaults — for
    *display* only (the picker always needs a concrete model/effort to show). */
export function readResumeDraft(file: FileEntry): RuntimeDraft {
  return savedResumeProfile(file) ?? defaults(file);
}

/**
 * The *explicitly saved* resume profile, or `null` when the user never applied
 * one. This is the send-path source of truth (issue #241 finding 4): a display
 * default must never become a silent model/effort override on resume, because
 * `defaults()` synthesizes a first-catalog model even for unknown legacy models.
 */
export function savedResumeProfile(file: FileEntry): RuntimeDraft | null {
  return readConcreteProfile(file, resumeKey(file));
}

function readConcreteProfile(file: FileEntry, key: string): RuntimeDraft | null {
  const fallback = defaults(file);
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null") as Partial<RuntimeDraft> | null;
    if (!value) return null;
    const engine = file.engine as "claude" | "codex" | "copilot";
    const model = ENGINE_MODELS[engine].some((item) => item.id === value.model) || (engine === "copilot" && typeof value.model === "string" && /^[a-z0-9][a-z0-9.-]{0,127}$/.test(value.model)) ? value.model! : fallback.model;
    const efforts = effortScale(engine, model) ?? [];
    return {
      model,
      effort: efforts.includes(value.effort ?? "") ? value.effort! : fallback.effort,
      fast: engine === "codex" && typeof value.fast === "boolean" ? value.fast : fallback.fast,
      ...tierField(storedServiceTier(engine, value, fallback)),
    };
  } catch {
    return null;
  }
}

/** The sparse auto-apply profile (only explicitly-selected fields), or null. */
export function readProfile(file: FileEntry): RuntimeProfile | null {
  try {
    const value = JSON.parse(localStorage.getItem(profileKey(file)) ?? "null") as RuntimeProfile | null;
    if (!value || typeof value !== "object") return null;
    const engine = file.engine as "claude" | "codex" | "copilot";
    const profile: RuntimeProfile = {};
    if (ENGINE_MODELS[engine].some((item) => item.id === value.model) || (engine === "copilot" && typeof value.model === "string" && /^[a-z0-9][a-z0-9.-]{0,127}$/.test(value.model))) profile.model = value.model;
    const scale = effortScale(engine, profile.model ?? readModelFor(file, value)) ?? [];
    if (typeof value.effort === "string" && scale.includes(value.effort)) profile.effort = value.effort;
    if (engine === "codex" && typeof value.fast === "boolean") profile.fast = value.fast;
    return Object.keys(profile).length ? profile : null;
  } catch {
    return null;
  }
}

function readModelFor(file: FileEntry, value: RuntimeProfile): string {
  const engine = file.engine as "claude" | "codex" | "copilot";
  return ENGINE_MODELS[engine].some((item) => item.id === value.model) || (engine === "copilot" && typeof value.model === "string" && /^[a-z0-9][a-z0-9.-]{0,127}$/.test(value.model)) ? value.model! : defaults(file).model;
}

/** Merge and persist explicitly-selected fields into the sparse profile.
    Writing only the chosen keys preserves finding 4 (a display default is never
    persisted); a model change clamps a now-out-of-scale effort. */
export function writeProfile(file: FileEntry, patch: RuntimeProfile): RuntimeProfile {
  const current = readProfile(file) ?? {};
  const next: RuntimeProfile = { ...current, ...patch };
  const engine = file.engine as "claude" | "codex" | "copilot";
  if (patch.model !== undefined && next.effort !== undefined) {
    next.effort = clampEffortToScale(engine, next.model, next.effort) ?? next.effort;
  }
  if (engine !== "codex") delete next.fast;
  try {
    localStorage.setItem(profileKey(file), JSON.stringify(next));
  } catch { /* quota/opaque-origin: the in-memory selection still rides the send */ }
  return next;
}

/** Merge and persist a selection into the *resume* profile (issue #241 §4):
    unlike the sparse `:profile`, the resume key stores a concrete draft (what
    `savedResumeProfile` reads and `resumeProfileBody` rides on the spawn), so
    the first explicit selection materializes the current display draft and
    edits it — auto-apply IS the save (issue #390 §5). */
export function writeResumeProfile(file: FileEntry, patch: RuntimeProfile): RuntimeDraft {
  const engine = file.engine as "claude" | "codex" | "copilot";
  const current = savedResumeProfile(file) ?? defaults(file);
  const next: RuntimeDraft = { ...current, ...patch };
  if (patch.model !== undefined) {
    next.effort = clampEffortToScale(engine, next.model, next.effort) ?? next.effort;
  }
  if (engine !== "codex") next.fast = false;
  /* A speed choice replaces the tier along with `fast`; the tier names only what `fast` cannot. */
  if (patch.fast !== undefined) next.serviceTier = (patch as Partial<RuntimeDraft>).serviceTier ?? null;
  if (engine !== "codex" || !next.serviceTier) delete next.serviceTier;
  try {
    localStorage.setItem(resumeKey(file), JSON.stringify(next));
  } catch { /* quota/opaque-origin: the in-memory selection still rides the send */ }
  return next;
}

/** Forget the stored draft and sparse profile: a structured face that shows the
    observed runtime must not leave an older selection riding the next send. */
export function dropStoredSelection(file: FileEntry): void {
  try {
    localStorage.removeItem(storageKey(file));
    localStorage.removeItem(profileKey(file));
  } catch { /* opaque origin: nothing was stored */ }
}

/** The concrete profile the next message resolves to: the user's persisted
    selection where present, otherwise the observed/boot runtime, otherwise
    engine defaults (issue #390 §3.1 "the face is the truth about the next
    message"). */
export function effectiveProfile(file: FileEntry): RuntimeDraft {
  const base = defaults(file);
  const profile = readProfile(file);
  if (!profile) return base;
  const engine = file.engine as "claude" | "codex" | "copilot";
  const model = profile.model ?? base.model;
  const efforts = effortScale(engine, model) ?? [];
  const effort = profile.effort && efforts.includes(profile.effort)
    ? profile.effort
    : clampEffortToScale(engine, model, profile.effort ?? base.effort) ?? base.effort;
  const fast = engine === "codex" ? profile.fast ?? base.fast : false;
  return { model, effort, fast, ...tierField(fast === base.fast ? base.serviceTier : null) };
}

/** The subset of a concrete draft to ride a structured send as `runtime`: only
    the fields the user explicitly selected (from the sparse profile), so an
    unselected display default never overrides the host's own runtime. */
export function sendRuntimeFrom(file: FileEntry): RuntimeProfile | undefined {
  const profile = readProfile(file);
  if (!profile) return undefined;
  const engine = file.engine as "claude" | "codex" | "copilot";
  const runtime: RuntimeProfile = {};
  if (profile.model) runtime.model = profile.model;
  if (profile.effort) runtime.effort = profile.effort;
  /* A per-turn `fast` is priority: on a thread running a named tier beyond it
     (ultrafast) it would slow every turn down to Fast. */
  if (engine === "codex" && typeof profile.fast === "boolean" && profile.fast !== (file.fast ?? null)
    && !(profile.fast && namedServiceTier(file.serviceTier))) runtime.fast = profile.fast;
  return Object.keys(runtime).length ? runtime : undefined;
}

/** Move the `:profile` record across a conversation identity rotation, mirroring
    the composer draft's `adoptComposerState`: a provisional→canonical id swap
    (or a migration path flap) must carry the selection along, or a poll that
    fills in the canonical id would silently drop the user's chosen runtime.
    `:phase` rides too — a live-tmux reconfigure that is pending/confirming when
    the identity rotates must keep converging under the canonical id. */
export function adoptRuntimeProfile(fromIdentity: string, toIdentity: string): void {
  if (!fromIdentity || fromIdentity === toIdentity) return;
  try {
    for (const suffix of [":profile", ":resume", ":phase", ":phase:operation", ":phase:rollback", ""]) {
      const legacy = localStorage.getItem(`llvAgentRuntime:${fromIdentity}${suffix}`);
      if (legacy === null) continue;
      if (localStorage.getItem(`llvAgentRuntime:${toIdentity}${suffix}`) === null) {
        localStorage.setItem(`llvAgentRuntime:${toIdentity}${suffix}`, legacy);
      }
      localStorage.removeItem(`llvAgentRuntime:${fromIdentity}${suffix}`);
    }
  } catch { /* quota/opaque-origin: the in-memory selection still rides the send */ }
}
