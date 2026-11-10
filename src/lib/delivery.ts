import { orchestratorRecipientRefusal, orchestratorRecipientRefusalAsync } from "@/lib/orchestrator/seats";
import { DeliveryAdmissionRefusedError, type DeliveryAdmissionGuard } from "@/lib/deliveryAdmission";
import { registeredHostForPath } from "@/lib/conversation/registeredHost";
import { resumeEligibility, resumeSpecFor, type AgentEngine } from "@/lib/agent/cli";
import type { AgentReconfiguration } from "@/lib/agent/reconfigure";
import { agentRegistry, conversationIdsResolvingTo, resolveConversationAlias, REGISTRY_WRITER_BUSY, serviceTierForSpeed, type AgentRegistry, type AgentRegistryEntry, type RegistryConversation, type TmuxHostEvidence } from "@/lib/agent/registry";
import { conversationAgentRole } from "@/lib/agent/spawnAdmission";
import { accountManager, ProjectAccountRefusedError, resolveResumeAccountId } from "@/lib/accounts/manager";
import { AccountProjectBindingsUnreadableError } from "@/lib/accounts/projectBindings";
import { conversationProjectKey } from "@/lib/accounts/conversationProject";
import {
  attributeNamedAccountChoice,
  type AccountChoiceActor,
  type AccountOverrideNotice,
} from "@/lib/accounts/accountOverrides";
import { requestAccountMigrationTick } from "@/lib/accounts/migration/controllerSignal";
import { deliverToTranscriptHost, readTranscriptHosts, type HostDeliveryOutcome, type TranscriptHost } from "@/lib/agent/transcriptHost";
import { admitTranscriptConversationOffLoop } from "@/lib/conversation/transcriptAdmission";
import { listFiles } from "@/lib/scanner";
import { pathAllowed } from "@/lib/scanner/roots";
import { transcriptLiveOwnership, type TranscriptLiveOwnership } from "@/lib/scanner/transcripts";
import { procBackend } from "@/lib/proc";
import { recoverDeadStructuredConversation, StructuredResumeUnpublishedError } from "@/lib/runtime/structuredRecovery";
import type { MessageOrigin } from "@/lib/runtime/messageOrigin";
import type { ActuationLease } from "@/lib/deliveryActuation";
import { ownedDeliveryProgressStore } from "@/lib/runtime/deliveryProgress";
import type { DeliveryProgressPort } from "@/lib/runtime/recordWait";
import type { SendResendGuidance } from "@/lib/runtime/sendSettlement";
import type { RuntimeOperationReceipt } from "@/lib/runtime/contracts";
import { detectBlockingGate, parseScreenMenu, screenAtIdleComposer, screenWaitsForInput } from "@/lib/status";
import type { FileEntry } from "@/lib/types";
import {
  deleteInboxImages,
  forgetResumePane,
  killTmuxHostIfMatches,
  interruptTmuxHostIfMatches,
  knownLivePids,
  paneScreen,
  resolveTarget,
  sendKeys,
  sendText,
  operatorSafeTmuxDeliveryError,
  withPaneLock,
  type InboxImagePayload,
} from "@/lib/tmux";

/**
 * Conversation-level delivery for every action exposed by the tmux API.
 * Structured ownership resolves through its engine host. Legacy operations use
 * the live pane → resume window → root relay ladder and their per-action guards.
 * The route maps HTTP to these calls.
 */

export interface DeliveryFailure {
  code?: string;
  ok: false;
  outcome: "failed";
  error: string;
  status: number;
  actuation?: "started";
  /** #1131: the accepted send this refusal is about, so a caller holding it can
      ask `message_receipt` what became of it. */
  operationId?: string;
  /** #1131: set when the refusal is ABSORBING — an earlier attempt under this
      same request began actuating and nothing can say whether it arrived, so
      the instruction must be verified rather than repeated. */
  resend?: SendResendGuidance;
  /** Set on a superseded-round rejection (issue #383): the live chain end the
      caller should redirect to instead of forking retired work. */
  successorConversationId?: string;
  /** Set when the refusal came before anything was reserved or dispatched,
      so the send provably did not happen (#2020). */
  admission?: "refused";
}

async function legacySeatRefusal(registry: AgentRegistry, conversation: Pick<RegistryConversation, "id"> | null) {
  if (!conversation) return null;
  const snapshot = registry.conversationDeliverySnapshot({ conversationId: conversation.id });
  return orchestratorRecipientRefusalAsync(conversationIdsResolvingTo(snapshot, conversation.id),
    id => resolveConversationAlias(snapshot, id as `conversation_${string}`));
}

function legacySeatRefusalSync(conversation: Pick<RegistryConversation, "id"> | null) {
  if (!conversation) return null;
  // This guard runs inside registry admission's synchronous transaction. The
  // identity is already resolved at the async boundary; reading a registry
  // snapshot here can wait on the writer whose transaction is calling us.
  return orchestratorRecipientRefusal([conversation.id]);
}

function seatRefusalFailure(refusal: NonNullable<Awaited<ReturnType<typeof legacySeatRefusal>>>): DeliveryFailure {
  return { ok: false, outcome: "failed", admission: "refused", ...refusal };
}

/** A send or resume addressed to a terminally superseded round (issue #383)
    must never implicitly fork it through recovery — it answers with a
    redirectable pointer to the live chain end instead. Explicit "resume here"
    clears the edge first and never reaches this guard. */

function supersededRejection(
  registry: AgentRegistry,
  conversation: Pick<RegistryConversation, "id" | "supersededBy"> | null,
): DeliveryFailure | null {
  if (!conversation?.supersededBy) return null;
  return {
    ok: false,
    outcome: "failed",
    error: "superseded",
    status: 409,
    successorConversationId: registry.supersedenceChainTail(conversation.id),
    admission: "refused",
  };
}

export interface DeliverySuccess {
  ok: true;
  target: string | null;
  outcome?: "delivered-to-live" | "resumed" | "held" | "pending" | "reconfigured" | "queued" | "delivering" | "delivered";
  imagePaths?: string[];
  /** Set when delivery started a successor host for a finished conversation. */
  spawned?: boolean;
  structured?: true;
  operationId?: string;
  receipt?: RuntimeOperationReceipt;
  /** Set when an account switch named an account outside the project's pool:
      the switch was carried out and attributed, and the answer says so. */
  accountOverride?: AccountOverrideNotice;
}

interface ReconfigureConversationOverrides {
  /** Who is switching, for attribution. Absent means the operator: an agent is
      the only caller that can name itself, exactly as the operator authority
      gate reads a request. */
  actor?: AccountChoiceActor;
  attributeAccountChoice?: typeof attributeNamedAccountChoice;
  pathAllowed?: typeof pathAllowed;
  listFiles?: typeof listFiles;
  resumeSpecFor?: typeof resumeSpecFor;
  livePaneHost?: typeof livePaneHost;
  registry?: AgentRegistry;
  paneScreen?: typeof paneScreen;
  killHost?: typeof killTmuxHostIfMatches;
  deliver?: typeof deliverToTranscriptHost;
  resolveAccount?: typeof accountManager.resolveSpawn;
  validateAccount?: (engine: "claude" | "codex", accountId: string) => Promise<void>;
  requestMigrationTick?: typeof requestAccountMigrationTick;
}

async function validateAccountAuthentication(engine: "claude" | "codex", accountId: string): Promise<void> {
  const account = await accountManager.status(engine, accountId, true);
  if (account.auth.state !== "authenticated") throw new Error(`${engine} account requires authentication`);
}

export async function reconfigureConversation(
  filePath: string,
  config: AgentReconfiguration,
  overrides: ReconfigureConversationOverrides = {},
): Promise<DeliveryOutcome> {
  if (!filePath || !(overrides.pathAllowed ?? pathAllowed)(filePath)) return failure("the conversation path is required", 400);
  const entry = (await (overrides.listFiles ?? listFiles)({ pin: filePath })).find((item) => item.path === filePath);
  if (!entry || (entry.engine !== "claude" && entry.engine !== "codex")) return failure("conversation is unavailable", 403);
  const registry = overrides.registry ?? agentRegistry();
  const registered = registeredHostForPath(registry.readOnlySnapshot(), filePath);
  if (!registered?.host) return failure("no registered agent pane for this conversation", 404);
  const conversation = registry.conversationForPath(filePath);
  const generation = conversation?.generations.at(-1);
  if (config.accountId && (!conversation || !generation)) return failure("conversation identity is unavailable for an account switch", 409);
  if (config.accountId && conversation && generation && config.accountId !== generation.accountId) {
    /* #1279: switching a conversation's account names an account outright, so
       it asks the project's binding — to ATTRIBUTE the choice, not to veto it.
       The pool is what the Viewer selects from on its own (the reseat, and any
       account it would default to); a deliberate switch is a control, and a
       control the operator is entitled to use onto an account outside the pool.
       Inside the pool, and on an unbound project, nothing is recorded and the
       switch is exactly what it always was.

       Attribution follows ACCEPTANCE, below. Appended here — before
       authentication, before the reseat is reserved — it recorded ATTEMPTS: a
       switch onto an account that turned out to be signed out left the project
       view showing an out-of-pool choice that never happened, and there is no
       compensating delete for a journal that only appends. */
    const project = conversationProjectKey(conversation.projectOwnership, generation.launchProfile, {
      /* An adopted conversation carries no launch profile, and the scanner's
         project for this transcript is what the board already groups it under. */
      project: entry.project,
    });
    try {
      await (overrides.validateAccount ?? validateAccountAuthentication)(entry.engine, config.accountId);
      (overrides.resolveAccount ?? accountManager.resolveSpawn)(entry.engine, config.accountId);
      const targetId = config.accountId;
      const written = await registry.deliveryWrite({ label: "migration.reseat-request" },
        () => registry.requestConversationReseat(conversation.id, targetId, undefined, {
          model: config.model, effort: config.effort, fast: config.fast,
        }), requested => ({ label: "migration.reseat-request", operationId: requested.migration?.operationId }));
      if (!written.acquired) return { ...failure(REGISTRY_WRITER_BUSY, 503), code: "REGISTRY_WRITER_BUSY" };
      if (!written.value.migration) throw new Error("account switch could not be queued");
    } catch (error) {
      return failure(error, 409);
    }
    /* Accepted: the reseat is durably queued, so the record describes a switch
       that happened rather than one that was attempted. Attribution sits
       OUTSIDE the try for the same reason it sits after it — nothing about
       writing the record may turn an accepted switch back into a failure. */
    const accountOverride = (overrides.attributeAccountChoice ?? attributeNamedAccountChoice)({
      engine: entry.engine,
      project,
      accountId: config.accountId,
      conversationId: conversation.id,
      actor: overrides.actor ?? { kind: "operator" },
      via: "conversation-switch",
    }) ?? undefined;
    (overrides.requestMigrationTick ?? requestAccountMigrationTick)();
    return {
      ok: true,
      target: registered.host.paneId,
      outcome: "pending",
      ...(accountOverride ? { accountOverride } : {}),
    };
  }
  /* Resolved before the operation lock is taken, so a fenced or unreadable
     record refuses without ever holding it. `config.accountId` here is a switch
     the caller NAMED — the branch above already returned for a named switch to
     a different account — so it stands untouched. */
  let resumeAccount: string | null;
  try {
    resumeAccount = config.accountId ?? resumeAccountId(registry, entry);
  } catch (error) {
    return accountFenceFailure(error);
  }
  const buildSpec = (profile: AgentRegistryEntry["launchProfile"]) => (overrides.resumeSpecFor ?? resumeSpecFor)(entry.root, entry.path, {
    ...config,
    serviceTier: serviceTierForSpeed(profile?.serviceTier, config.fast),
    accountId: resumeAccount,
    readOnly: profile?.readOnly ?? null,
    permissionMode: profile?.permissionMode ?? null,
    sandbox: profile?.sandbox ?? null,
    allowSubagents: profile?.allowSubagents ?? false,
    plugins: profile?.plugins,
    /* Every relaunch carries the durable grant (#739); dropping it here rebuilt
       the command on the Viewer baseline while the profile still claimed it. */
    mcpServers: profile?.mcpServers,
  });
  const deliver = overrides.deliver ?? deliverToTranscriptHost;
  const observedHost = await (overrides.livePaneHost ?? livePaneHost)(filePath);
  const paneId = observedHost?.paneId ?? registered.host.paneId;
  const target = observedHost?.display ?? registered.host.paneId;
  const owner = { pid: process.pid, startIdentity: procBackend.processIdentity(process.pid) };
  try {
    const prepared = await registry.withOperationLock(registered.key, owner, async () => {
      const refreshed = registeredHostForPath(registry.readOnlySnapshot(), filePath);
      if (!refreshed?.host || refreshed.host.paneId !== paneId) {
        return failure("the registered pane changed", 409);
      }
      const spec = buildSpec(refreshed.launchProfile);
      if (!spec) return failure("this conversation cannot be resumed", 409);
      const refreshedHost = refreshed.host;
      return withPaneLock(paneId, async () => {
        if (!screenAtIdleComposer(await (overrides.paneScreen ?? paneScreen)(paneId))) {
          return "pending" as const;
        }
        if (!await (overrides.killHost ?? killTmuxHostIfMatches)(refreshedHost)) return failure("the registered pane changed or its process did not exit", 409);
        await registry.deliveryWriteOrBusy({ label: "registry.markUnhosted" }, () => {
          const current = registry.readOnlySnapshot().entries[`${refreshed.key.engine}:${refreshed.key.sessionId}`];
          if (current?.artifactPath === filePath && sameRegisteredHost(current.host, refreshedHost)) registry.markUnhosted(refreshed.key);
        });
        forgetResumePane(filePath);
        return { state: "prepared" as const, spec };
      });
    });
    if (prepared === "pending") return { ok: true, target, outcome: "pending" };
    if (!("state" in prepared)) return prepared;
    /* Resume acquires the same per-session serialization lock through the
       transcript-host adapter. The termination lock must be released first. */
    const resumed = await hostOutcome(deliver({ entry: { ...entry, pid: null, proc: "done" }, spec: prepared.spec, payload: "" }));
    return resumed.ok ? { ...resumed, outcome: "reconfigured" } : resumed;
  } catch (error) {
    return failure(error);
  }
}

export type DeliveryOutcome = DeliverySuccess | DeliveryFailure;

export function migrationDeliveryOutcome(outcome: DeliveryOutcome): "delivered" | "failed" | "delivery-uncertain" | "held" {
  if (!outcome.ok) return outcome.actuation === "started" ? "delivery-uncertain" : "failed";
  return outcome.outcome === "held" ? "held" : "delivered";
}

function failure(error: unknown, status = 500, actuation?: "started"): DeliveryFailure {
  if (error instanceof DeliveryAdmissionRefusedError) return { ok: false, outcome: "failed", error: error.message, code: error.code, status: 409, admission: "refused" };
  if (error instanceof StructuredResumeUnpublishedError) return { ok: false, outcome: "failed", error: error.message, code: "structured_revival_impossible", status: 503 };
  return {
    ok: false,
    outcome: "failed",
    /* Transport diagnostics stay separate from liveness and internal tmux
       correlation ids never become operator-facing receipt text. */
    error: operatorSafeTmuxDeliveryError(error, actuation === "started"),
    status,
    ...(actuation ? { actuation } : {}),
  };
}

async function hostOutcome(result: Promise<HostDeliveryOutcome>): Promise<DeliveryOutcome> {
  const outcome = await result;
  if (!outcome.ok) return outcome;
  return { ...outcome, spawned: outcome.outcome === "resumed" };
}

/** A host failure happens after image payload construction. Keep the cleanup
    beside the returned outcome so direct and root-relayed delivery share the
    same no-orphan contract. */
export function cleanupFailedImageDelivery(outcome: DeliveryOutcome, imagePaths: string[]): DeliveryOutcome {
  if (!outcome.ok && outcome.actuation !== "started") deleteInboxImages(imagePaths);
  return outcome;
}

/** Resolves and revalidates a request pid against the scanner's live set. */
export async function targetForKnownPid(pid: number): Promise<string | null | "unknown"> {
  const live = await knownLivePids();
  if (!live.has(pid)) return "unknown";
  return resolveTarget(pid);
}

/**
 * Live pane of a conversation, for an interrupt or a kill. The pid comes from
 * the scanner's own entry for the path — a client-supplied pid is ignored
 * (like /api/proc), since resolving it directly would let any same-origin
 * caller reach an unrelated agent's pane. Never boots a fresh agent window:
 * both actions only make sense against a pane that already exists.
 */
async function livePaneHost(filePath: string) {
  if (!filePath || !pathAllowed(filePath)) return null;
  return (await readTranscriptHosts(true)).canonicalFor(filePath);
}

/** Human-readable target of the shared canonical resolver for non-message
    actions that only operate on a presently live pane. */
export async function livePaneTarget(filePath: string): Promise<string | null> {
  return (await livePaneHost(filePath))?.display ?? null;
}

interface InterruptConversationOverrides {
  pathAllowed?: typeof pathAllowed;
  livePaneHost?: typeof livePaneHost;
  registry?: AgentRegistry;
  interruptHost?: typeof interruptTmuxHostIfMatches;
}

export async function interruptConversation(filePath: string, overrides: InterruptConversationOverrides = {}): Promise<DeliveryOutcome> {
  if (!filePath || !(overrides.pathAllowed ?? pathAllowed)(filePath)) {
    return failure("the conversation path is required to interrupt", 400);
  }
  const host = await (overrides.livePaneHost ?? livePaneHost)(filePath);
  if (host === null) {
    return failure("no active agent pane to interrupt", 409);
  }
  try {
    const registry = overrides.registry ?? agentRegistry();
    const registered = registeredOwnerForObservedHost(registry.readOnlySnapshot(), host);
    if (!registered?.host) {
      return failure("conversation host identity is unavailable or ambiguous", 409);
    }
    return await registry.withOperationLock(registered.key,
      { pid: process.pid, startIdentity: procBackend.processIdentity(process.pid) }, async () => {
        const current = registeredOwnerForObservedHost(registry.readOnlySnapshot(), host);
        if (!current?.host || current.key.engine !== registered.key.engine
          || current.key.sessionId !== registered.key.sessionId
          || current.artifactPath !== registered.artifactPath
          || !sameRegisteredHost(current.host, registered.host!)) {
          return failure("conversation host changed before interrupt", 409);
        }
        if (!await (overrides.interruptHost ?? interruptTmuxHostIfMatches)(current.host)) return failure("conversation host identity changed before interrupt", 409);
        return { ok: true, target: host.display };
      });
  } catch (error) {
    return failure(error);
  }
}

/* The /compact slash command typed into the live pane: both agent CLIs
   parse a submitted "/compact" and condense their context; the transcript
   then grows a compaction marker the feed renders as a band. Only makes
   sense against a pane that already exists — never boots a window. */
export async function compactConversation(filePath: string): Promise<DeliveryOutcome> {
  if (!filePath || !pathAllowed(filePath)) {
    return failure("the conversation path is required to compact", 400);
  }
  const host = await livePaneHost(filePath);
  if (host === null) {
    return failure("no active agent pane to compact", 409);
  }
  try {
    await sendText(host.paneId, "/compact");
    return { ok: true, target: host.display };
  } catch (error) {
    return failure(error);
  }
}

export type DialogStale = "blocked" | "closed" | "changed" | null;

/**
 * Stale-menu guard for a dialog key press, pure over the captured screen: the
 * dialog that advanced or closed since the client rendered must swallow
 * nothing. A digit must still point at the same option label under the same
 * question; a bare Tab/Enter/Escape only checks the question when a menu is
 * still on screen.
 */
export function dialogKeyStale(screen: string, key: string, label: unknown, question: unknown): DialogStale {
  const blocking = detectBlockingGate(screen);
  if (blocking !== null) return "blocked";
  if (!screenWaitsForInput(screen)) return "closed";
  const menu = parseScreenMenu(screen);
  if (/^[1-9]$/.test(key)) {
    const option = menu?.options.find((item) => String(item.value) === key);
    if (
      !option ||
      (typeof label === "string" && label !== option.label) ||
      (typeof question === "string" && question !== menu?.question)
    ) {
      return "changed";
    }
  } else if (menu && typeof question === "string" && question !== menu.question) {
    return "changed";
  }
  return null;
}

/* A key press into a live dialog the scrape fallback surfaced: the digit of
   a menu option, or Tab/Enter/Escape for screens the parser cannot read.
   The pane is re-read right before sending — see dialogKeyStale. */
export async function answerDialogKey(filePath: string, key: string, label: unknown, question: unknown): Promise<DeliveryOutcome> {
  if (!filePath || !pathAllowed(filePath)) {
    return failure("the conversation path is required to answer", 400);
  }
  if (!/^([1-9]|Tab|Enter|Escape)$/.test(key)) {
    return failure("invalid key", 400);
  }
  const host = await livePaneHost(filePath);
  if (host === null) {
    return failure("no active agent pane", 409);
  }
  try {
    const stale = await withPaneLock(host.paneId, async () => {
      const verdict = dialogKeyStale(await paneScreen(host.paneId), key, label, question);
      if (verdict === null) await sendKeys(host.paneId, [key]);
      return verdict;
    });
    if (stale === "blocked") return failure("pane is waiting for a confirmation that requires a manual decision", 409);
    if (stale === "closed") return failure("pane is no longer waiting for a response", 409);
    if (stale === "changed") return failure("the on-screen menu has changed", 409);
    return { ok: true, target: host.display };
  } catch (error) {
    return failure(error);
  }
}

interface ResumeConversationOverrides {
  pathAllowed?: typeof pathAllowed;
  listFiles?: typeof listFiles;
  resumeSpecFor?: typeof resumeSpecFor;
  resumeEligibility?: typeof resumeEligibility;
  registry?: AgentRegistry;
  recover?: typeof recoverDeadStructuredConversation;
  admit?: (registry: Parameters<typeof admitTranscriptConversationOffLoop>[0], entry: Parameters<typeof admitTranscriptConversationOffLoop>[1], dependencies: Parameters<typeof admitTranscriptConversationOffLoop>[2]) => Awaited<ReturnType<typeof admitTranscriptConversationOffLoop>> | ReturnType<typeof admitTranscriptConversationOffLoop>;
  livePaneHost?: typeof livePaneHost;
  liveOwnership?: (entry: FileEntry) => TranscriptLiveOwnership | null;
  deliver?: typeof deliverToTranscriptHost;
}

/**
 * The account a legacy resume reopens under, for every seam in this file.
 *
 * Provenance first: inside the shared transcript store (#891) the path names no
 * owner, so the registry's recorded account is the only answer (#935). When
 * there is no record — an adopted conversation the Viewer never launched, or
 * one whose account has since been deleted — nobody has named an account and
 * the spec builder used to answer from the engine's ACTIVE one, which is a pick
 * made with neither the project's pool nor any quota read (#1279). That half
 * now goes through the shared automatic decision like every other pick, so this
 * function returns continuity or a fenced choice and never an unfenced one.
 */
function resumeAccountId(registry: AgentRegistry, entry: FileEntry): string | null {
  if (entry.engine !== "claude" && entry.engine !== "codex") return null;
  const conversation = registry.conversationForPath(entry.path);
  const project = conversationProjectKey(
    conversation?.projectOwnership,
    conversation?.generations?.at(-1)?.launchProfile,
    /* An adopted conversation carries an empty profile, and this is exactly the
       population whose account is unrecorded — the scanner's project for the
       transcript, and the cwd behind it, are what the fence has to read. */
    { project: entry.project, cwd: entry.cwd },
  );
  return resolveResumeAccountId(entry.engine, registry.transcriptAccountId(entry.engine, entry.path), project);
}

/**
 * A pool boundary, or a binding record nobody can read, answered as this
 * contract's own refusal rather than an unhandled failure: the resume has
 * started nothing, and 409 is the answer the reseat, the spawn route and the
 * task launch already give for the same two conditions.
 */
function accountFenceFailure(error: unknown): DeliveryFailure {
  if (error instanceof ProjectAccountRefusedError || error instanceof AccountProjectBindingsUnreadableError) {
    return failure(error, 409);
  }
  throw error;
}

/**
 * Reopens a conversation from the viewer, whatever its first host was.
 *
 * A registered conversation reaches its pane-less structured host through the
 * transcript-host bridge. A transcript the registry never inventoried — born
 * by typing `claude` in a plain terminal, or aged past the scan's recency cap —
 * is admitted from its own provenance first (issue #935), so birth mode no
 * longer decides whether continuation exists. Only then does the legacy ladder
 * run, and a refusal there names the one condition that failed.
 */
export async function resumeConversation(
  filePath: string,
  overrides: ResumeConversationOverrides = {},
): Promise<DeliveryOutcome> {
  if (!filePath || !(overrides.pathAllowed ?? pathAllowed)(filePath)) {
    return failure("the conversation path is required to open", 400);
  }
  const registry = overrides.registry ?? agentRegistry();
  const known = registry.conversationForPath(filePath);
  const seatRefusal = await legacySeatRefusal(registry, known);
  if (seatRefusal) return { ok: false, outcome: "failed", admission: "refused", ...seatRefusal };
  const rejected = supersededRejection(registry, known);
  if (rejected) return rejected;
  const recover = overrides.recover ?? recoverDeadStructuredConversation;
  const bridged = (recovered: NonNullable<Awaited<ReturnType<typeof recover>>>): DeliveryOutcome => ({
    ok: true,
    target: null,
    outcome: recovered.hold ? "held" : "resumed",
    spawned: recovered.spawned,
    structured: true,
  });
  try {
    const recovered = await recover({ path: filePath }, { registry });
    if (recovered) return bridged(recovered);
  } catch (error) {
    return failure(error);
  }
  if (known?.agentRole === "curator") {
    return failure("curator recovery is unavailable until its designated seat is admitted", 409);
  }
  /* Pinned: the resumable transcript may have aged past the scan's recency
     cap — a conversation the operator can still open must stay resumable. */
  const entry = (await (overrides.listFiles ?? listFiles)({ pin: filePath })).find((item) => item.path === filePath);
  if (!entry) return failure("the viewer knows no transcript at this path", 403);
  /* #935: a transcript the registry never inventoried — born by typing
     `claude` in a plain terminal, or aged past the scan's recency cap — holds
     no identity for the bridge to own, so continuation used to depend on how
     the first host was born. Admit it from its own provenance and let the
     bridge take it; a refusal the bridge can name does not consume the legacy
     ladder's turn, unless something outside the viewer owns the session. */
  let admissionRefusal: string | null = null;
  /* Liveness uses the uncapped destructive-operation probe the delete routes
     use: the scanner's `entry.proc` misses an idle or aged-out
     terminal owner, which is this population exactly. The evidence class
     travels with it — admission refuses differently for a process that names
     this session than for one merely sitting in its directory. */
  const ownership = !known
    ? entry.proc === "running" ? "session" : (overrides.liveOwnership ?? transcriptLiveOwnership)(entry)
    : null;
  /* A live tmux pane is a host the viewer CAN reach: the ladder below types
     into it. Only a live process with no pane and no registry host is the
     foreign terminal admission refuses. */
  const paneHosted = ownership !== null && await (overrides.livePaneHost ?? livePaneHost)(filePath) !== null;
  if (!known && !paneHosted) {
    const admitted = await (overrides.admit ?? admitTranscriptConversationOffLoop)(registry, entry, {
      liveOwnership: overrides.liveOwnership ?? transcriptLiveOwnership,
    });
    if (!admitted.ok && admitted.blocking) return failure(admitted.reason, 409);
    if (!admitted.ok) admissionRefusal = admitted.reason;
    else {
      try {
        const recovered = await recover({ path: filePath, conversationId: admitted.conversationId }, { registry });
        if (recovered) return bridged(recovered);
      } catch (error) {
        return failure(error);
      }
    }
  }
  const profile = registry.launchProfileForPath(entry.path);
  let resumeAccount: string | null;
  try {
    resumeAccount = resumeAccountId(registry, entry);
  } catch (error) {
    return accountFenceFailure(error);
  }
  const specOptions = {
    model: entry.launchModel ?? entry.model,
    effort: entry.effort,
    fast: profile?.fast,
    serviceTier: profile?.serviceTier,
    accountId: resumeAccount,
    readOnly: profile?.readOnly,
    permissionMode: profile?.permissionMode,
    sandbox: profile?.sandbox,
    allowSubagents: profile?.allowSubagents,
    plugins: profile?.plugins,
    /* The durable grant travels with the resume (#739). Omitting it silently
       relaunched the session on the Viewer baseline while the profile went on
       claiming the grant — durable state and running process disagreeing. The
       stored list is already origin-bounded when the registry reads it. */
    mcpServers: profile?.mcpServers,
  };
  const spec = (overrides.resumeSpecFor ?? resumeSpecFor)(entry.root, entry.path, specOptions);
  if (!spec) {
    const eligibility = (overrides.resumeEligibility ?? resumeEligibility)(entry.root, entry.path, specOptions);
    if (!eligibility.ok) return failure(eligibility.reason, 409);
    return failure(admissionRefusal ?? "this conversation cannot be resumed", 409);
  }
  try {
    return await hostOutcome((overrides.deliver ?? deliverToTranscriptHost)({ entry, spec, payload: "" }));
  } catch (error) {
    return failure(error);
  }
}

interface KillConversationOverrides {
  pathAllowed?: typeof pathAllowed;
  listFiles?: typeof listFiles;
  registrySnapshot?: () => ReturnType<ReturnType<typeof agentRegistry>["snapshot"]>;
  registry?: Pick<AgentRegistry, "readOnlySnapshot" | "withOperationLock" | "markUnhosted"> & Partial<Pick<AgentRegistry, "deliveryWriteOrBusy">>;
  killHost?: typeof killTmuxHostIfMatches;
}

/** A native child can be the scanner's primary transcript while the Viewer
    launch remains registered under its root. Resolve that owner among the
    observed claims, retaining both the unique registry claim and host fence. */
function registeredOwnerForObservedHost(
  snapshot: ReturnType<AgentRegistry["snapshot"]>,
  host: TranscriptHost,
): AgentRegistryEntry | null {
  const candidates = Object.values(snapshot.entries).filter((candidate) =>
    candidate.key.engine === host.engine
    && candidate.artifactPath !== null && host.claimedPaths.includes(candidate.artifactPath)
    && candidate.host?.paneId === host.paneId
    && candidate.host.server.pid === host.tmuxServerPid
    && candidate.host.panePid.pid === host.panePid
    && candidate.host.agent.pid === host.agentPid
    && Boolean(host.agentIdentity) && candidate.host.agent.startIdentity === host.agentIdentity);
  return candidates.length === 1
    ? registeredHostForPath(snapshot, candidates[0]!.artifactPath!)
    : null;
}

function sameRegisteredHost(left: TmuxHostEvidence | null, right: TmuxHostEvidence): boolean {
  return Boolean(left
    && left.kind === right.kind
    && left.endpoint === right.endpoint
    && left.paneId === right.paneId
    && left.server.pid === right.server.pid
    && left.server.startIdentity === right.server.startIdentity
    && left.panePid.pid === right.panePid.pid
    && left.panePid.startIdentity === right.panePid.startIdentity
    && left.agent.pid === right.agent.pid
    && left.agent.startIdentity === right.agent.startIdentity
    && left.windowName === right.windowName
    && left.argv.length === right.argv.length
    && left.argv.every((argument, index) => argument === right.argv[index]));
}

/** Closes the registry-owned pane for one root conversation. The registry
    supplies the stable pane id and the complete process identity fence. */
export async function killConversation(filePath: string, overrides: KillConversationOverrides = {}): Promise<DeliveryOutcome> {
  if (!filePath || !(overrides.pathAllowed ?? pathAllowed)(filePath)) {
    return failure("the conversation path is required to close", 400);
  }
  const entry = (await (overrides.listFiles ?? listFiles)({ pin: filePath })).find((item) => item.path === filePath);
  // A viewer-spawned child can own its own pane. Shared branches have no
  // independent claim; the conversation action boundary also checks lineage.
  const registry = overrides.registry ?? agentRegistry();
  const readSnapshot = overrides.registry
    ? () => registry.readOnlySnapshot()
    : overrides.registrySnapshot ?? (() => registry.readOnlySnapshot());
  const registered = registeredHostForPath(readSnapshot(), filePath);
  if (entry?.parent && !registered?.host) {
    return failure("a branch shares its root conversation pane and cannot be closed independently", 409);
  }
  if (!registered?.host) return failure("no registered agent pane for this conversation", 404);
  const owner = { pid: process.pid, startIdentity: procBackend.processIdentity(process.pid) };
  const runLocked = overrides.registry || !overrides.registrySnapshot
    ? <T>(task: () => Promise<T>) => registry.withOperationLock(registered.key, owner, task)
    : <T>(task: () => Promise<T>) => task();
  try {
    return await runLocked(async () => {
      const refreshed = registeredHostForPath(readSnapshot(), filePath);
      if (!refreshed?.host) return failure("no registered agent pane for this conversation", 404);
      if (refreshed.key.engine !== registered.key.engine || refreshed.key.sessionId !== registered.key.sessionId
        || !sameRegisteredHost(refreshed.host, registered.host!)) return failure("conversation host changed before stop", 409);
      const killed = await (overrides.killHost ?? killTmuxHostIfMatches)(refreshed.host);
      if (!killed) return failure("the registered pane changed or its process did not exit", 409);
      if (overrides.registry || !overrides.registrySnapshot) {
        const write = () => {
          const current = registry.readOnlySnapshot().entries[`${refreshed.key.engine}:${refreshed.key.sessionId}`];
          if (current?.artifactPath === filePath && sameRegisteredHost(current.host, refreshed.host!)) registry.markUnhosted(refreshed.key);
        };
        if (registry.deliveryWriteOrBusy) await registry.deliveryWriteOrBusy({ label: "registry.markUnhosted" }, write);
        else write();
      }
      forgetResumePane(filePath);
      return { ok: true, target: refreshed.host.paneId };
    });
  } catch (error) {
    return failure(error);
  }
}

export interface ConversationMessage {
  pid: number | null;
  path: string;
  conversationId?: string | null;
  clientMessageId?: string | null;
  reservedDeliveryId?: string | null;
  /** In-process fence checked after waits before a fresh local reservation. */
  admissionGuard?: DeliveryAdmissionGuard;
  /** Recheck autonomous seat authority while its replacement host is publishing. */
  recoveryAuthorityGuard?: () => void;
  text: string;
  images: InboxImagePayload[];
  /** The "on resume" profile chosen in the control strip (issue #241 §4): when a
      finished conversation is reopened, boot with these instead of the last
      generation's model/effort. Ignored on a live pane (nothing to reconfigure)
      and on the subagent relay (the root owns its own runtime). */
  resumeModel?: string | null;
  resumeEffort?: string | null;
  resumeFast?: boolean | null;
  /** Message authorship stamped by the admitting surface (#1117). Rides the
      structured enqueue when the conversation recovers structured, and persists
      on the legacy hold's command so the evidence survives even when the paste
      itself — engine input this path must not change — cannot carry it. */
  origin?: MessageOrigin;
  /** How a structured host treats a turn already running. Absent keeps the
      send default, which interrupts it; `queue` waits until the host is idle,
      and `context-or-queue` adds native context to a supported active host.
      Only the structured transport reads it. A conversation whose current owner is a legacy pane host is
      not recovered into a structured send, so its message takes the legacy
      ladder, which never reads the policy and types the text into the pane
      the way it types every other message. */
  policy?: "queue" | "context-or-queue" | "steer-or-queue";
}

export interface DeliveryOverrides {
  recover?: typeof recoverDeadStructuredConversation;
  enqueueStructured?: typeof import("@/lib/runtime/structuredMessageDelivery")["enqueueStructuredMessage"];
  /** The actuation section the migration drain holds for this conversation, when it delivers a reservation it claimed. */
  actuationLease?: ActuationLease;
  listFiles?: typeof listFiles;
  /** Where a drained reservation's ending is recorded; the Viewer's own store by default. */
  progress?: DeliveryProgressPort | null;
}

/** The answer a send gets when no structured host holds the conversation and
    recovery could not raise one. */
export const NO_DELIVERY_HOST_REASON = "this conversation has no host to deliver to";
export const NO_DELIVERY_HOST_CODE = "no_delivery_host";

/**
 * The transcript a request addresses when the registry knows no conversation
 * for it (docs/design/delivery-progress-and-drain.md, A9): its path, else the
 * scanner entry of its pid. A pid or path that names no agent transcript
 * (Claude, Codex or Copilot) is refused before anything is reserved or sent.
 */
async function addressedTranscript(
  message: ConversationMessage,
  overrides: DeliveryOverrides,
): Promise<{ entry: AgentTranscript } | { refused: DeliveryFailure } | null> {
  if (message.path) {
    const entry = (await (overrides.listFiles ?? listFiles)({ pin: message.path })).find((item) => item.path === message.path);
    if (!entry) return { refused: failure("file is unknown to the viewer", 403) };
    return agentTranscript(entry) ? { entry } : null;
  }
  if (message.pid === null) return null;
  const entry = (await (overrides.listFiles ?? listFiles)()).find((item) => item.pid === message.pid && item.proc === "running");
  if (!entry) return { refused: failure("process is unknown to the viewer", 403) };
  return agentTranscript(entry) ? { entry } : null;
}

type AgentTranscript = FileEntry & { engine: AgentEngine };

/** A transcript of an engine the registry keeps conversations for. */
function agentTranscript(entry: FileEntry): entry is AgentTranscript {
  return entry.engine === "claude" || entry.engine === "codex" || entry.engine === "copilot";
}

/**
 * A send resolves or recovers the conversation's structured host and enqueues
 * the message there. A conversation with no such host, and none that recovery
 * can raise, is refused with {@link NO_DELIVERY_HOST_REASON}.
 */
export async function deliverConversationMessage(message: ConversationMessage, overrides: DeliveryOverrides = {}): Promise<DeliveryOutcome> {
  const { images } = message;
  const text = message.text.trim();
  const registry = agentRegistry();
  let conversation = message.conversationId?.startsWith("conversation_")
    ? registry.conversation(message.conversationId as `conversation_${string}`)
    : registry.conversationForPath(message.path);
  /* A9: a request the registry knows no conversation for (a pid only, a
     transcript nothing registered, or a conversation id the registry does not
     hold) resolves the transcript it addresses and registers its conversation
     the way a resume of it would, so recovery below can raise its host. */
  if (!conversation && !message.reservedDeliveryId) {
    const addressed = await addressedTranscript(message, overrides);
    if (addressed && "refused" in addressed) return addressed.refused;
    if (addressed) {
      const { entry } = addressed;
      conversation = registry.conversationForPath(entry.path);
      if (!conversation) {
        const ensured = await registry.deliveryWrite({ label: "conversation.ensure" },
          () => registry.ensureConversation(entry.engine, entry.path, null));
        /* Nothing is reserved yet, and the answer says so: the sender's
           request closes as not executed instead of unknown for ever (#3782). */
        if (!ensured.acquired) return { ...failure(REGISTRY_WRITER_BUSY, 503), admission: "refused" };
        conversation = ensured.value;
      }
    }
    /* A request that addresses nothing the registry can hold a conversation
       for is refused before anything is sent. */
    if (!conversation) return failure(message.conversationId ? "conversation is unknown to the viewer" : "delivery target is unavailable", 404);
  }
  const seatRefusal = await legacySeatRefusal(registry, conversation);
  if (seatRefusal) return { ok: false, outcome: "failed", admission: "refused", ...seatRefusal };
  const seatAdmissionGuard: DeliveryAdmissionGuard = () => {
    const refusal = legacySeatRefusalSync(conversation);
    if (refusal) throw new DeliveryAdmissionRefusedError(refusal.error);
  };
  const admissionGuard: DeliveryAdmissionGuard = reconciledDeadHost => {
    seatAdmissionGuard();
    message.admissionGuard?.(reconciledDeadHost);
  };
  const recoveryAuthorityGuard = () => {
    seatAdmissionGuard();
    message.recoveryAuthorityGuard?.();
  };
  const rejected = supersededRejection(registry, conversation);
  if (rejected) return rejected;
  if (conversation) {
    try {
      admissionGuard();
      const recovered = await (overrides.recover ?? recoverDeadStructuredConversation)(
        { path: message.path, conversationId: conversation.id, admissionGuard,
          authorityGuard: recoveryAuthorityGuard, origin: message.origin },
        { registry },
      );
      const afterRecoveryRefusal = await legacySeatRefusal(registry, conversation);
      if (afterRecoveryRefusal) return seatRefusalFailure(afterRecoveryRefusal);
      if (!recovered && conversationAgentRole(registry.readOnlySnapshot(), conversation.id) === "curator") {
        return failure("curator recovery is unavailable until its designated seat is admitted", 409);
      }
      if (recovered) {
        const enqueue = overrides.enqueueStructured
          ?? (await import("@/lib/runtime/structuredMessageDelivery")).enqueueStructuredMessage;
        const structured = await enqueue({
          path: recovered.path,
          conversationId: recovered.conversationId,
          clientMessageId: message.clientMessageId,
          // Our admitted successor changes the receipt and host identity. Seat
          // authority still applies when reserving its original-key message.
          admissionGuard: recovered.admissionGuard ?? (recovered.spawned ? recoveryAuthorityGuard : admissionGuard),
          recoveryAuthorityGuard,
          text,
          hasImages: images.length > 0,
          ...(message.origin ? { origin: message.origin } : {}),
          ...(message.policy ? { policy: message.policy } : {}),
        }, {
          registry: () => registry,
          /* Handed down by the migration drain that holds this conversation's section, never inherited. */
          ...(overrides.actuationLease ? { actuationLease: overrides.actuationLease } : {}),
        });
        if (!structured) return failure("structured delivery ownership is unavailable", 503);
        if (!structured.ok) {
          /* An accepted send keeps its handle on a refusal, and one whose fate
             is unknown says so: the caller can ask what became of it, and
             never reads it as refused before anything was reserved. */
          const uncertain = structured.transportUncertain && structured.operationId;
          return {
            ...failure(structured.error, structured.status, uncertain ? "started" : undefined),
            ...(structured.code ? { code: structured.code } : {}),
            ...(structured.operationId ? { operationId: structured.operationId } : {}),
            ...(uncertain ? { resend: "verify-first" as const } : {}),
          };
        }
        if (structured.outcome === "held") {
          return {
            ok: true,
            target: recovered.spawned ? null : structured.target,
            outcome: "held",
            spawned: recovered.spawned,
            structured: true,
            operationId: structured.operationId,
          };
        }
        return {
          ok: true,
          target: recovered.spawned ? null : structured.target,
          outcome: structured.outcome,
          spawned: recovered.spawned,
          structured: true,
          operationId: structured.operationId,
          receipt: structured.receipt,
        };
      }
    } catch (error) {
      return failure(error);
    }
  }
  /* No structured host holds this conversation and recovery could not raise
     one, so there is nothing to deliver to. Nothing was reserved by this call.
     A reservation the migration drain already claimed keeps its registry
     ending with the drain; its progress record ends here. */
  const drained = message.reservedDeliveryId ? registry.readOnlySnapshot().heldDeliveries[message.reservedDeliveryId] ?? null : null;
  if (drained) {
    const progress = overrides.progress === undefined ? ownedDeliveryProgressStore() : overrides.progress;
    try { progress?.settle?.(drained.command.operationId, "failed", NO_DELIVERY_HOST_REASON); }
    catch { /* A progress record never fails an answer. */ }
    return failure(NO_DELIVERY_HOST_REASON, 409);
  }
  return { ...failure(NO_DELIVERY_HOST_REASON, 409), code: NO_DELIVERY_HOST_CODE, admission: "refused" };
}
