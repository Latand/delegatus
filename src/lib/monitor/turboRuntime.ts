import { agentRegistry } from "@/lib/agent/registry";
import { ENGINE_MODELS } from "@/lib/agent/models";
import { listCodexAccounts } from "@/lib/accounts/codex";
import { fastestTier, raisesTier, type TurboTier } from "@/lib/accounts/codexServiceTiers";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { conversationProjectKey } from "@/lib/accounts/conversationProject";
import { allowedAccountIdsForProject, projectsForAccount } from "@/lib/accounts/projectBindings";
import { launchServiceTier } from "@/lib/runtime/codexTurnProfile";
import { tierCutState } from "@/lib/runtime/tierSwitch";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { canonicalOrchestratorProject, orchestratorSeatFor } from "@/lib/orchestrator/seats";
import { readTurboSettings, readSeatTickSettingsFile, updateTurboEpisode } from "./seatTickSettings";
import { waitForStateLock } from "@/lib/state/lockWait";
import { endedTurbo, turboAccountVerdict, turboActive, turboProgress, type TurboChangeContext, type TurboPlanAccount, type TurboSetting } from "./turbo";
import { TurboSweep, type TurboCandidate, type TurboSweepPorts } from "./turboSweep";

/**
 * Turbo's production wiring: what the confirmation shows, the live candidates,
 * the in-place switch ports and the background sweep (docs/design/turbo-mode.md).
 * Nothing here runs per request or per tick: candidates are read once per
 * episode change, and the sweep only wakes while an episode needs work.
 */

const CONTINUATION = "Delegatus changed this conversation's speed (Turbo). Continue the task from where you stopped.";

type Observation = ReturnType<ReturnType<typeof agentRegistry>["quotaObservations"]>[number];
const QUOTA_FRESH_MS = 5 * 60_000;

function staleObservation(observation: Observation): boolean {
  const observedAt = Date.parse(observation.observedAt);
  return observation.provenance.staleSince != null || !Number.isFinite(observedAt) || observedAt > Date.now() || Date.now() - observedAt > QUOTA_FRESH_MS;
}

/** A missing or stale reading counts as holding credits (§2.2). */
function holdsCredits(observation: Observation | undefined): boolean {
  const credits = observation?.limits?.credits;
  return !credits || credits.hasCredits || credits.unlimited || !!observation && staleObservation(observation);
}

/** The allowed Codex accounts and the tier each catalog model gets on each. */
export function turboChangeContext(project: string): TurboChangeContext {
  const allowed = allowedAccountIdsForProject(project, "codex");
  const accounts = listCodexAccounts().filter(account => allowed === null || allowed.includes(account.id));
  const observations = agentRegistry().quotaObservations("codex");
  const plan: TurboPlanAccount[] = accounts.map(account => {
    const tiers: Record<string, TurboTier> = {};
    for (const model of ENGINE_MODELS.codex) {
      const tier = fastestTier(account.home, model.id);
      if (tier) tiers[model.id] = tier;
    }
    const observation = observations.find(item => item.accountId === account.id);
    return { accountId: account.id, label: account.label, plan: observation?.limits?.plan ?? null, tiers, hadCredits: holdsCredits(observation) };
  });
  return { plan, allowedAccounts: allowed };
}

export interface TurboPreviewAccount {
  accountId: string;
  label: string;
  plan: string | null;
  /** model → tier, only models with a faster tier. */
  tiers: Record<string, TurboTier>;
  weeklyPercent: number | null;
  weeklyResetsAt: number | null;
  balance: string | null;
  holdsCredits: boolean;
  /** Other projects bound to this account. */
  otherProjects: number;
  unavailable: "signed-out" | "removed" | null;
}

export interface TurboAnswer {
  active: boolean;
  episode: TurboSetting | null;
  history: TurboSetting[];
  /** Whether Turbo can do anything here, and why not. */
  available: boolean;
  unavailableReason: "no-account" | "no-faster-tier" | "unreadable" | null;
  progress: ReturnType<typeof turboProgress> | null;
  /** conversation id → title, for the conversations the Details rows name. */
  titles?: Record<string, string>;
  preview?: { accounts: TurboPreviewAccount[]; conversations: { total: number; stages: number; agents: number } };
}

/** Turbo as the panel and the tool read it. `preview` costs one registry read: asked for when the dialog opens. */
export async function turboAnswer(project: string, settings: { turbo?: TurboSetting | null; turboHistory?: TurboSetting[] }, now: number, withPreview = false): Promise<TurboAnswer> {
  const episode = endedTurbo(settings.turbo, now);
  let context: TurboChangeContext | null = null;
  try { context = turboChangeContext(project); } catch { /* an unreadable binding answers unavailable */ }
  const listed = listCodexAccounts();
  const unavailable = (accountId: string) => {
    const account = listed.find(item => item.id === accountId);
    return !account ? "removed" : account.authPresent ? null : "signed-out";
  };
  const usable = context?.plan.filter(account => !unavailable(account.accountId)) ?? [];
  const reason = !context ? "unreadable" as const : !usable.length ? "no-account" as const : usable.every(account => !Object.keys(account.tiers).length) ? "no-faster-tier" as const : null;
  const answer: TurboAnswer = {
    active: turboActive(episode, now), episode, history: settings.turboHistory ?? [],
    available: reason === null, unavailableReason: reason,
    progress: episode ? turboProgress(episode.switches) : null,
  };
  answer.titles = switchTitles([...answer.history, ...(episode ? [episode] : [])]);
  if (!withPreview || !context) return answer;
  const candidates = await liveCandidates(project);
  const raised = candidates.filter(candidate => {
    const tier = candidate.model ? context!.plan.find(account => account.accountId === candidate.accountId)?.tiers[candidate.model] : undefined;
    return !candidate.legacy && !candidate.stage?.switchOpen && !!tier && raisesTier(candidate.tier, tier);
  });
  const observations = agentRegistry().quotaObservations("codex");
  answer.preview = {
    accounts: context.plan.map(account => {
      const observation = observations.find(item => item.accountId === account.accountId);
      return { accountId: account.accountId, label: account.label, plan: account.plan, tiers: account.tiers,
        weeklyPercent: observation?.limits?.weekly?.usedPercent ?? null, weeklyResetsAt: observation?.limits?.weekly?.resetsAt ?? null,
        balance: observation?.limits?.credits?.balance ?? null, holdsCredits: account.hadCredits,
        otherProjects: projectsForAccount("codex", account.accountId).filter(other => canonicalOrchestratorProject(other) !== project).length,
        unavailable: unavailable(account.accountId) };
    }),
    conversations: { total: raised.length, stages: raised.filter(item => item.stage).length, agents: raised.filter(item => !item.stage).length },
  };
  return answer;
}

const TITLE_ROWS = 40;
const TITLE_CHARS = 120;

/** The titles of the conversations whose switch rows carry a reason (what Details lists), newest first, bounded. */
function switchTitles(episodes: TurboSetting[]): Record<string, string> {
  const titles: Record<string, string> = {};
  try {
    const registry = agentRegistry();
    const ids = episodes.flatMap(item => item.switches.filter(row => row.reason).map(row => row.conversationId)).reverse();
    for (const id of ids) {
      if (id in titles || Object.keys(titles).length >= TITLE_ROWS) continue;
      const title = registry.conversation(id as ViewerConversationId)?.generations.at(-1)?.launchProfile.title?.trim();
      if (title) titles[id] = title.length > TITLE_CHARS ? `${title.slice(0, TITLE_CHARS - 1)}…` : title;
    }
  } catch { /* an unreadable registry leaves the rows unnamed */ }
  return titles;
}

/** Live hosted Codex conversations of the project, read once per episode change. */
async function liveCandidates(project: string): Promise<TurboCandidate[]> {
  const { structuredDeliveryHeldHosts } = await import("@/lib/runtime/structuredDeliveryController");
  const registry = agentRegistry();
  const snapshot = registry.readOnlySnapshot();
  const held = structuredDeliveryHeldHosts();
  const seat = orchestratorSeatFor(project).active?.conversationId ?? null;
  const out: TurboCandidate[] = [];
  for (const conversation of Object.values(snapshot.conversations)) {
    if (conversation.engine !== "codex") continue;
    const generation = conversation.generations.at(-1);
    if (!generation || generation.archivedAt) continue;
    const key = `codex:${generation.id}`;
    const entry = snapshot.entries[key];
    const hosted = held.has(key);
    const legacy = !hosted && !!entry?.host && entry.status === "live";
    if (!hosted && !legacy) continue;
    if (conversationProjectKey(conversation.projectOwnership, generation.launchProfile) !== project) continue;
    const membership = (snapshot.memberships[conversation.id] ?? []).find(item => item.kind === "pipeline" && item.stageId);
    let stage: TurboCandidate["stage"];
    if (membership) {
      const { findControllerPipeline } = await import("@/lib/pipelines/store");
      const { openRuntimeSwitch } = await import("@/lib/pipelines/runtimeSwitch");
      const pipeline = await findControllerPipeline(membership.containerId);
      const run = pipeline?.runs.find(item => item.stageId === membership.stageId);
      const attempt = run?.attempts.findLast(item => item.conversationId === conversation.id && item.state === "running");
      if (!pipeline || !attempt) continue;
      stage = { pipelineId: pipeline.id, stageId: membership.stageId!, attempt: attempt.n,
        definitionTier: pipeline.stages.find(item => item.id === membership.stageId)?.serviceTier ?? null, switchOpen: !!openRuntimeSwitch(attempt) };
    }
    out.push({ conversationId: conversation.id, accountId: generation.accountId, model: generation.launchProfile.model,
      tier: launchServiceTier(generation.launchProfile) ?? null, ...(seat && registry.canonicalConversationId(seat as ViewerConversationId) === conversation.id ? { seat: true } : {}),
      ...(stage ? { stage } : {}), ...(legacy ? { legacy: true } : {}), busy: entry?.structuredHost?.activeTurnRef != null });
  }
  return out;
}

const unrefSleep = (ms: number) => new Promise<void>(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); });

/** Rechecked by the host immediately before a Turbo RPC or an armed cut. */
export function authorizeTurboTier(project: string, episodeKey: string, conversationId: string): void {
  const setting = readTurboSettings(project).turbo;
  if (!setting || `turbo:${setting.startedAt}` !== episodeKey || !turboActive(setting, Date.now())) throw new Error("Turbo episode ended");
  const conversation = agentRegistry().conversation(conversationId as ViewerConversationId);
  const generation = conversation?.generations.at(-1);
  if (!conversation || conversation.engine !== "codex" || !generation
    || conversationProjectKey(conversation.projectOwnership, generation.launchProfile) !== project) throw new Error("conversation no longer belongs to Turbo's project");
  const row = setting.switches.find(item => item.conversationId === conversationId);
  if (!row || row.accountId !== generation.accountId || row.model !== generation.launchProfile.model) throw new Error("conversation runtime changed after Turbo planned it");
  const allowed = allowedAccountIdsForProject(project, "codex");
  if (!generation.accountId || allowed && !allowed.includes(generation.accountId)) throw new Error("Turbo account is no longer allowed");
  const observation = agentRegistry().quotaObservations("codex").find(item => item.accountId === generation.accountId);
  const verdict = turboAccountVerdict(setting, generation.accountId, observation ? { limits: observation.limits, stale: staleObservation(observation) } : null, Date.now());
  if (verdict.verdict === "hold") throw new Error(verdict.reason);
}

function productionPorts(): TurboSweepPorts {
  return {
    now: () => Date.now(),
    sleep: unrefSleep,
    authorize: authorizeTurboTier,
    read: project => {
      const row = readTurboSettings(project);
      return { turbo: endedTurbo(row.turbo, Date.now()), turboHistory: row.turboHistory?.map(episode => endedTurbo(episode, Date.now())!) };
    },
    update: (project, startedAt, update) => waitForStateLock("turbo.sweep.settle", () => updateTurboEpisode(project, startedAt, update), { subject: project }),
    candidates: project => withViewerOperation("turbo.sweep.read", () => liveCandidates(project)),
    liveTier: async (conversationId, expected) => {
      const { structuredDeliveryHostForConversation } = await import("@/lib/runtime/structuredDeliveryController");
      const conversation = agentRegistry().conversation(conversationId as ViewerConversationId);
      const profile = conversation?.generations.at(-1)?.launchProfile;
      const generation = conversation?.generations.at(-1);
      const same = !expected || generation?.accountId === expected.accountId && profile?.model === expected.model;
      return { live: same && !!generation && !generation.archivedAt, hosted: !!structuredDeliveryHostForConversation(conversationId), tier: profile ? launchServiceTier(profile) ?? null : null };
    },
    reading: accountId => {
      const observation = agentRegistry().quotaObservations("codex").find(item => item.accountId === accountId);
      return observation ? { limits: observation.limits, stale: staleObservation(observation) } : null;
    },
    setTier: async (conversationId, operationId, tier, cut, authorize, expected, beforeCut) => {
      const { switchConversationTier } = await import("@/lib/runtime/tierSwitch");
      return await withViewerOperation("turbo.sweep.apply", () => switchConversationTier(conversationId, operationId, tier, cut, {
        ...(authorize ? { authorizeDispatch: authorize } : {}),
        ...(expected ? { expected } : {}),
        ...(beforeCut ? { beforeCut } : {}),
      }));
    },
    cutState: async (operationId, conversationId, turnId) => {
      const { structuredDeliveryHostForConversation } = await import("@/lib/runtime/structuredDeliveryController");
      return tierCutState(operationId, conversationId ? structuredDeliveryHostForConversation(conversationId) : null, turnId);
    },
    cancelCut: async (conversationId, operationId) => {
      const { cancelTierCut } = await import("@/lib/runtime/tierSwitch");
      await cancelTierCut(conversationId, operationId);
    },
    continueConversation: async (conversationId, key) => {
      const { enqueueStructuredMessage } = await import("@/lib/runtime/structuredMessageDelivery");
      const { delegatusMessageOrigin } = await import("@/lib/runtime/agentMessageAuthor");
      const conversation = agentRegistry().conversation(conversationId as ViewerConversationId);
      const generation = conversation?.generations.at(-1);
      if (!conversation || !generation) throw new Error("the conversation is no longer registered");
      const result = await enqueueStructuredMessage({ conversationId, path: generation.path, text: CONTINUATION, clientMessageId: key.slice(0, 128), policy: "queue", images: [],
        origin: delegatusMessageOrigin("turbo", conversationProjectKey(conversation.projectOwnership, generation.launchProfile), generation.launchProfile.cwd) });
      if (!result?.ok) throw new Error(result && "error" in result ? String(result.error) : "the continuation was not accepted");
    },
    stageTier: async (stage, tier, cut, episode) => {
      const { patchPipeline, defaultPipelinePorts } = await import("@/lib/pipelines/engine");
      const { findControllerPipeline } = await import("@/lib/pipelines/store");
      if (cut === "none") {
        const pipeline = await findControllerPipeline(stage.pipelineId);
        const attempt = pipeline?.runs.find(item => item.stageId === stage.stageId)?.attempts.find(item => item.n === stage.attempt);
        const { openRuntimeSwitch, switchOperationKey } = await import("@/lib/pipelines/runtimeSwitch");
        const pending = attempt && openRuntimeSwitch(attempt);
        if (pending?.inPlace && pending.turbo === episode) {
          const { cancelTierCut } = await import("@/lib/runtime/tierSwitch");
          await cancelTierCut(stage.conversationId, switchOperationKey(pending, "tier"));
          if (pending.cut === "none" && pending.to.serviceTier === tier) return { ok: true };
          return { ok: false, reason: "the previous Turbo switch is settling without a cut" };
        }
        const definition = pipeline?.stages.find(item => item.id === stage.stageId)?.serviceTier ?? null;
        if (definition !== stage.definitionTier) return { ok: false, reason: "the stage's speed was changed since; that choice is kept" };
      }
      const result = await withViewerOperation("turbo.sweep.apply", () => patchPipeline(stage.pipelineId, { action: "override-stage", stageId: stage.stageId, serviceTier: tier,
        applyNow: true, applyNowCut: cut, expectedAttempt: stage.attempt, expectedConversationId: stage.conversationId, turbo: episode }, defaultPipelinePorts()));
      return result.error ? { ok: false, reason: result.error } : { ok: true, ...(result.appliedNow === "already-current" ? { settled: true as const } : {}) };
    },
    stageState: async (stage, conversationId, tier) => {
      const { findControllerPipeline } = await import("@/lib/pipelines/store");
      const pipeline = await withViewerOperation("turbo.sweep.settle", () => findControllerPipeline(stage.pipelineId));
      const attempt = pipeline?.runs.find(item => item.stageId === stage.stageId)?.attempts.find(item => item.n === stage.attempt);
      const record = attempt?.runtimeSwitches?.findLast(item => item.from.conversationId === conversationId && item.inPlace && (tier === undefined || item.to.serviceTier === tier));
      if (!record) return { state: "failed", reason: "the stage switch is not recorded" };
      if (record.phase === "committed") return { state: "committed", appliedTier: record.appliedServiceTier };
      if (["failed", "rolled-back", "superseded"].includes(record.phase)) return { state: "failed", reason: record.outcome ?? record.phase };
      return { state: record.phase === "switching" && record.tierCut === "armed" ? "armed" : "pending" };
    },
    restoreStageDefinition: async (stage, from, expected, episode) => {
      const { patchPipeline, defaultPipelinePorts } = await import("@/lib/pipelines/engine");
      const { findControllerPipeline } = await import("@/lib/pipelines/store");
      const pipeline = await findControllerPipeline(stage.pipelineId);
      const definition = pipeline?.stages.find(item => item.id === stage.stageId);
      if (!definition || (definition.serviceTier ?? null) !== expected) return;
      const { stageDigest } = await import("@/lib/pipelines/stageDigest");
      const result = await patchPipeline(stage.pipelineId, { action: "override-stage", stageId: stage.stageId, serviceTier: from, expectedStageDigest: stageDigest(definition), turbo: episode }, defaultPipelinePorts());
      if (result.error) throw new Error(result.error);
    },
    notify: (project, key, text) => deliverTurboSeatNotice(project, key, text),
  };
}

/** One seat notice through the project-addressed channel; the key makes a retry the same message. */
export async function deliverTurboSeatNotice(project: string, key: string, text: string): Promise<{ delivered: boolean; error?: string }> {
  const { resolveOrchestratorRelay } = await import("@/lib/orchestrator/relay");
  const { enqueueStructuredMessage } = await import("@/lib/runtime/structuredMessageDelivery");
  const { delegatusMessageOrigin } = await import("@/lib/runtime/agentMessageAuthor");
  const payload = { text, origin: delegatusMessageOrigin("turbo", project) };
  const admitted = resolveOrchestratorRelay(project, undefined, payload, text, key);
  if (!admitted.ok) return { delivered: false, error: admitted.error };
  if (admitted.operationId) return { delivered: true };
  const conversation = agentRegistry().conversation(admitted.recipient as ViewerConversationId);
  const path = conversation?.generations.at(-1)?.path ?? "";
  const result = await enqueueStructuredMessage({ conversationId: admitted.recipient, path, text: admitted.text, origin: admitted.origin,
    clientMessageId: key, policy: "steer-or-queue", images: [] });
  return result?.ok ? { delivered: true } : { delivered: false, error: result && "error" in result ? String(result.error) : "no structured seat" };
}

const shared = globalThis as typeof globalThis & { __delegatusTurbo?: { sweep: TurboSweep; projects: Set<string>; timer: ReturnType<typeof setTimeout> | null } };

function state() {
  return shared.__delegatusTurbo ??= { sweep: new TurboSweep(productionPorts()), projects: new Set(), timer: null };
}

const PASS_INTERVAL_MS = 30_000;

function schedule(): void {
  const current = state();
  if (current.timer || !current.projects.size) return;
  /* Only while an episode needs work: the credit rule, expiry and armed cuts. */
  current.timer = setTimeout(() => {
    current.timer = null;
    for (const project of [...current.projects]) void kickTurbo(project);
  }, PASS_INTERVAL_MS);
  current.timer.unref?.();
}

/** Run a pass for the project now (after a settings change) and keep it scheduled while it has work. */
export async function kickTurbo(project: string): Promise<void> {
  /* Tool processes can update settings, but only the active Viewer owns the
     hosted conversations that the sweep must change. */
  if (process.env.LLV_STATE_OWNER !== "viewer") return;
  const current = state();
  current.projects.add(project);
  try {
    /* Only the release that owns traffic holds the hosts; a demoted one would
       plan an episode with nothing to switch. */
    const { viewerReleaseOwnsTraffic } = await import("@/lib/viewerReleaseTraffic");
    if (!viewerReleaseOwnsTraffic()) { current.projects.delete(project); return; }
    await withViewerOperation("turbo.sweep", () => current.sweep.kick(project));
  } catch (error) {
    console.error(`[turbo] sweep for ${project} failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    try { if (!current.sweep.pending(project)) current.projects.delete(project); }
    catch (error) { console.error(`[turbo] pending work is unreadable for ${project}: ${error instanceof Error ? error.name : "unknown"}`); }
    finally { schedule(); }
  }
}

/** Viewer startup: resume every project whose episode is on, or ended and not yet reverted. */
export function startTurboSweep(): void {
  let projects: string[] = [];
  try { projects = Object.entries(readSeatTickSettingsFile()).filter(([, row]) => row.turbo && (row.turbo.enabled || !row.turbo.revertedAt)
    || row.turboHistory?.some(episode => !episode.revertedAt)).map(([project]) => project); }
  catch (error) { console.error(`[turbo] settings unreadable at startup: ${error instanceof Error ? error.message : String(error)}`); }
  for (const project of projects) void kickTurbo(project);
}
