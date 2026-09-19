import type { FlowEngine, RoleConfig } from "@/lib/flows/types";
import type { PauseResumeActor } from "@/lib/pauseResumeActor";

export type PipelineAccess = "read-only" | "read-write";
export type PipelineSandbox = "full" | "restricted";

/** A write whose stated expectation (`expectedStageDigest`, `expectedStageId`,
    `expectedAttempt`) no longer holds: nothing was changed. */
export type PipelineGuardErrorCode = "STAGE_CHANGED";
export type PipelineGuardField = "expectedStageDigest" | "expectedStageId" | "expectedAttempt";

export type PipelineRepoPreflightErrorCode =
  | "missing"
  | "not_directory"
  | "repo_unreadable"
  | "repo_untraversable"
  | "not_git"
  /** A Git probe could not reach a verdict — a spawn/exec failure, a timeout, or
      a transient non-zero exit that is not the definitive "not a git repository"
      message. Kept distinct so a hiccup never masquerades as not_git (#353 AC3). */
  | "probe_failed"
  | "git_metadata_unwritable"
  | "worktree_parent_unwritable";

export type PipelineRepoPreflight =
  | { ok: true; repoDir: string; gitCommonDir: string; worktreeParent: string }
  /** `detail` carries the underlying stderr/reason for a probe_failed transient so
      the failure preserves fidelity instead of collapsing to a generic code. */
  | { ok: false; code: PipelineRepoPreflightErrorCode; path: string; detail?: string };

export type PipelineRoleId =
  | "orchestrator"
  | "reviewer"
  | "verifier"
  | "builder"
  | "architect"
  | "cleaner"
  | "prod-auditor"
  | "deployer";

/**
 * Roles a pipeline stage may not use. Deployer demands an explicit
 * `confirm: "deploy"` gate (resolveSpawnRole / DraftAgentPane) that a pipeline —
 * which spawns its stages automatically, without a per-stage confirmation — has
 * no way to honor, so it is excluded from the builder and rejected by the API.
 */
export const PIPELINE_DISALLOWED_ROLE_IDS: readonly PipelineRoleId[] = ["deployer"];

/** Durable reference to the shared role registry introduced by issue #35. */
export type PipelineRoleRef = {
  roleId: PipelineRoleId;
  /** Typed parameter values the operator chose; substituted into the role's
      prompt scaffold at create time (falling back to registry defaults). */
  params?: Record<string, string | number>;
};

export type EffectivePipelineRole = RoleConfig & {
  roleId: PipelineRoleId | null;
  access: PipelineAccess;
  promptScaffold: string | null;
};

export type PipelineStageKind = "run" | "review-loop";

export type PipelineEdgeKind = "pass" | "fail";

/** Verdict-keyed fail successor (#353): where a `fail` verdict routes next, and
    how many times this edge may fire before the pipeline parks for the
    operator. Cycles live exclusively on fail edges; the pass graph stays
    acyclic so every pass path terminates. */
export type PipelineFailEdge = { to: string; maxRounds: number };

export type PipelineStageInput = {
  id: string;
  kind: PipelineStageKind;
  role?: PipelineRoleRef;
  engine?: FlowEngine;
  model?: string | null;
  effort?: string | null;
  /** Repository mutation policy, enforced when the stage settles. It does not
      select the engine's tool/network sandbox. */
  access?: PipelineAccess;
  /** Tool/network boundary, independent from the repository policy in
      `access`. Omitted stages run with full host access. */
  sandbox?: PipelineSandbox;
  /** Repository-relative files or directories a read-only stage may produce.
      The controller alone records these paths in Git. */
  outputs?: string[];
  /** The account this stage runs on (#1279). Omitted, the stage resolves its
      account the way every unattended launch does — inside whatever set the
      pipeline's project allows. Named, it is honored only when the project
      allows it; otherwise the stage is refused, never quietly reseated. */
  account?: string | null;
  "prompt": string;
  /** Pass edge: the stage activated when this one passes. Schema v3 allows any
      stage id (direct links, merges), constrained to an acyclic pass graph. */
  next: string | null;
  /** Fail edge; absent/null parks a failed stage for the operator as before. */
  onFail?: PipelineFailEdge | null;
};

export type PipelineStage = PipelineStageInput & {
  /** Immutable registry resolution captured when the pipeline is created. */
  effectiveRole: EffectivePipelineRole;
};

export type StageVerdictStatus = "pass" | "fail" | "needs_decision";

export const STAGE_FINDING_SEVERITIES = ["P0", "P1", "P2", "P3"] as const;
export type StageFindingSeverity = typeof STAGE_FINDING_SEVERITIES[number];

/** One finding with the rank its author gave it (graph slice 2). `severity:
    null` is a finding that arrived with no rank — every finding a fenced JSON
    verdict carried before ranking existed, which stays accepted. */
export type StageFinding = { severity: StageFindingSeverity | null; text: string };

export type StageVerdict = {
  status: StageVerdictStatus;
  /** Findings in severity order, most severe first, each rendered as
      `<severity> — <text>` when it carries one. This is what every reader of
      a verdict shows, and what the fail edge relays. */
  findings?: string[];
  /** The same findings as records, present when at least one carries a rank.
      Derived from `findings`, so a record round-trips through the store. */
  rankedFindings?: StageFinding[];
  confidence?: number;
};

export type PipelineAttemptState =
  | "pending"
  | "spawning"
  | "running"
  | "reviewing"
  | "committing"
  | "passed"
  | "failed"
  | "needs_decision"
  | "skipped";

/** Durable provenance for a cursor activation / attempt: which stage's attempt
    advanced here, along which verdict edge. Loop budgets are derived from these
    records (never a separate counter), so counts cannot drift from evidence. */
export type PipelineEdgeActivation = { stageId: string; attempt: number; edge: PipelineEdgeKind };

export type PipelineVerdictRecovery = {
  state: "pending" | "recovered" | "exhausted";
  checks: number;
  maxChecks: number;
  startedAt: string;
  lastCheckedAt: string;
  nextCheckAt: string | null;
  /** Content-free parser diagnostic for the latest rejected canonical turn. */
  reason: string;
  /** Identifies the selected assistant message without persisting its content. */
  messageTs: number | null;
};

/** What a pipeline's accepted revisions depend on (#1692).

    `internal` (the default, and every record without the field): the Viewer's
    own durable state is the authority. A stage passes on its attempt, its
    verdict and the exact clean local revision it was judged on; a review
    settles on the SHA the reviewer was fenced to, read from the local
    worktree. Nothing is pushed, fetched or read from a remote while the
    pipeline runs. Creating or starting one without `baseRef` still fetches
    `origin/<base>` once, time-bounded, so it starts from the current base;
    a pinned `baseRef` never touches the network.

    `remote-branch`: the caller asked for publication. Every accepted revision
    is pushed to `origin/<branch>`, reviewers launch only on a published head,
    an approval settles only when the remote carries the reviewed SHA, and a
    terminal stage completes only once its revision is remotely durable. A
    publication failure is its own state beside the verdict and never rewrites
    it. */
export type PipelinePublication = "internal" | "remote-branch";

export type PipelineBoundedWait = {
  startedAt: string;
  rounds: number;
  retryAfter: string;
  /** The largest budget any round of this wait asked for, and its backoff
      cap (#1678): a later round of a cheaper class keeps the wait's budget.
      Absent on waits persisted before these fields existed, which then read
      as the round's own class. */
  budgetMs?: number;
  retryMaxMs?: number;
};

/** The stage definition an attempt runs, bound in the record transaction that
    moves it out of `pending`, before its first spawn call (graph slice 1,
    ADR-0002 of automation-v2). Together with the attempt's `effectiveRole`,
    re-cloned at the same instant, it is everything the attempt reads about its
    stage: an edit accepted after it is bound applies from the next attempt. */
export type PipelineAttemptDefinition = {
  boundAt: string;
  /** `stageDigest` of the stage as it was bound. */
  stageDigest: string;
  "prompt": string;
  account: string | null;
  role: PipelineRoleRef | null;
  sandbox: PipelineSandbox | null;
  outputs: string[] | null;
};

export type PipelineGraphEditAction = "add-stage" | "remove-stage" | "reorder-stage" | "set-edge" | "override-stage";

/** One accepted graph edit, as the pipeline's own journal keeps it. */
export type PipelineGraphEdit = {
  /** Increments per pipeline, and keeps incrementing past trimmed entries. */
  seq: number;
  at: string;
  /** The operator, or the agent conversation that made the edit. */
  actor: PauseResumeActor;
  action: PipelineGraphEditAction;
  stageId: string | null;
  /** The pipeline state the edit was accepted in. */
  pipelineState: PipelineState;
  /** `applied`: nothing had bound the stage yet, so its next attempt runs the
      edit. `pending-next-attempt`: an attempt of the stage is already bound
      and keeps its definition; the edit applies from `appliesFromAttempt`. */
  effect: "applied" | "pending-next-attempt";
  /** The first attempt of `stageId` that runs under this edit; null for an
      edge or an order change, which apply at the next routing decision. */
  appliesFromAttempt: number | null;
  summary: string;
};

/** What the server itself observed about a stage attempt's work at the moment
    the attempt reported completion (graph slice 2). Never taken from the
    caller: the call carries a verdict, findings and a summary, and nothing
    else. A field the server could not read is `null`, which states what the
    read found and says nothing about the work itself. */
export type PipelineStageProvenance = {
  /** The worktree's checked-out commit, dirty tree included. */
  head: string | null;
  branch: string;
  /** Uncommitted paths the server saw, bounded; empty means a clean tree.
      `null` when the worktree could not be read at all. */
  uncommitted: string[] | null;
  /** The pull request the forge reports for `branch`, or null when there is
      none and when the forge could not be reached. */
  pullRequest: { url: string; number: number; state: string } | null;
  /** The stage's declared outputs, and whether the server found each in the
      worktree. Empty when the stage declares none. */
  outputs: Array<{ path: string; present: boolean }>;
};

/** A stage attempt's own completion report (graph slice 2): the intent the
    attempt stated through the MCP tool. The attempt settles when its turn
    completes, on this verdict; a second call before settlement replaces this
    record, and one after it is refused. */
export type PipelineStageReport = {
  /** Shared with the pipeline's attributed journal entry for this call. */
  seq: number;
  at: string;
  /** The calling conversation, resolved by the server from the call itself. */
  actor: PauseResumeActor;
  verdict: StageVerdict;
  summary: string | null;
  provenance: PipelineStageProvenance;
  /** Accepted calls this attempt has made, replacements included. */
  calls: number;
};

/** One accepted completion call, as the pipeline's own journal keeps it —
    the same attribution a graph edit carries in slice 1. */
export type PipelineStageReportEntry = {
  seq: number;
  at: string;
  actor: PauseResumeActor;
  stageId: string;
  attempt: number;
  status: StageVerdictStatus;
  /** How many findings the call carried, by severity, most severe first. */
  findings: number;
  /** The `seq` of the report this call replaced before settlement, or null. */
  replaces: number | null;
  summary: string | null;
};

export type PipelineStageAttempt = {
  n: number;
  /** Lineage-adopted evidence. Historical attempts never drive the execution cursor. */
  historical?: boolean;
  state: PipelineAttemptState;
  effectiveRole: EffectivePipelineRole;
  /** Absent until the attempt leaves `pending`, and on attempts recorded
      before definitions were bound, which read the live stage. */
  definition?: PipelineAttemptDefinition | null;
  launchId: string | null;
  conversationId: string | null;
  sessionId: string | null;
  agentPath: string | null;
  paneId: string | null;
  /** Account that owns this launch. Optional for records written before #1371. */
  accountId?: string | null;
  /** Usage-limited accounts excluded from this activation, with their resets.
      `engine` names the engine the limit was hit on; account ids are unique
      only within an engine. Entries written before it was recorded omit it. */
  usageLimitedAccounts?: Array<{ accountId: string; engine?: FlowEngine; resetsAt: number | null }>;
  flowId: string | null;
  /** Clean pipeline SHA expected when the first reviewer launches. */
  expectedReviewHeadSha?: string | null;
  /** Exact clean SHA captured by the first launched reviewer round. */
  reviewHeadSha?: string | null;
  /** Authoritative projection of the embedded flow. The generation is a
      content digest, so reconciliation remains idempotent across processes and
      independently committed flow/pipeline writes. */
  reviewFlowSync?: {
    generation: string;
    sourceRevision?: number;
    roundCount: number;
    implementerHeadSha: string | null;
    reviewerHeadSha: string | null;
    verdict: import("@/lib/flows/types").ReviewVerdict | null;
    relayState: import("@/lib/flows/types").FlowState;
    terminalState: import("@/lib/flows/types").FlowState | null;
    hostClaim?: import("@/lib/flows/types").FlowHostClaim | null;
    synchronizedAt: string;
    sourceUpdatedAt: string | null;
    lagMs: number | null;
  };
  startedAt: string | null;
  completedAt: string | null;
  /** Bounded wait for a structured delivery controller that is between
      publications (#1191). `startedAt` is wall-clock from the first sighting,
      so the budget covers the time a failing spawn attempt spent inside
      `spawnAgent` as well as the backoff; `retryAfter` is when the next
      activation may run. Persisted because the wait is spent between ticks —
      sleeping through it would hold the pipeline mutation past the flow
      pipeline controller's phase deadline. */
  controllerWait?: PipelineBoundedWait;
  /** Bounded wait for the remote pipeline branch after an approved review
      whose final remote read the network failed (#1692). Same shape and
      arithmetic as `controllerWait`, kept apart because that wait ends the
      moment a reviewer launch is under way, which an approved flow always is.
      Left in place when the budget runs out, as the record of the retries the
      park counts. */
  remoteHeadWait?: PipelineBoundedWait;
  /** Runtime-host generation this attempt's agent was launched under (#1747).
      A release succession mints a new epoch and replaces every engine process
      it hosted, so an attempt still carrying the previous epoch is the only
      witness the controller has that a deploy cut its turn. Absent on attempts
      recorded before the field existed and on pane-hosted ones. */
  hostEpoch?: number;
  /** The succession this attempt's turn was open across, and the one
      continuation the controller owes it (#1747). `silentSince` is the newest
      transcript record at the moment the new epoch was first sighted: while it
      does not move, the transcript has been silent since the handover, and any
      later record — a resumed tool call, a prompt somebody else delivered —
      cancels the continuation. `resumedAt` is set once, so a replayed tick
      can never send a second one. */
  severedTurn?: {
    epoch: number;
    sightedAt: string;
    silentSince: number | null;
    resumedAt?: string;
    clientMessageId?: string;
  };
  /** The one verdict the controller asked this attempt for (#1756). Written
      when a completed turn carried no verdict the reader could accept:
      `messageTs` is the turn it was asked about, and a later completed turn
      still without one is the second silence that parks. `requestedAt` is set
      only once the delivery surface accepted the request, and `firstMissAt`
      bounds the whole wait, so a queue that never drains still parks the lane
      through the ordinary recovery checks. */
  verdictRequest?: {
    firstMissAt: string;
    messageTs: number;
    requestedAt?: string;
    clientMessageId?: string;
  };
  /** Spawn calls this attempt has made across its activations, immediate
      handshake retries included (#1678). Each consumed one client attempt id,
      so the next retry index starts here. Persisted before the call is made:
      a restart that interrupts a call still counts it, and the retry that
      follows cannot replay the interrupted call's id. An attempt an engine
      without this count left behind starts it past every id that engine
      could have spent (#1678 review 3). */
  spawnCalls?: number;
  /** Launches this attempt reserved and then retired because their receipt
      settled `failed` before any host ran them (#1678): the runtime host was
      unreachable or the account mutation lock was busy. The receipt's own
      terminal verdict is what permits re-dispatch; a launch whose fate the
      receipt cannot vouch for is never retired here. Bounded, oldest first. */
  retiredLaunches?: Array<{
    launchId: string;
    conversationId: string | null;
    error: string;
    retiredAt: string;
  }>;
  /** Exactly-once relay (#353): the `{{prev.output}}` payload persisted when the
      cursor advanced here. Null on pre-v3 attempts, which fall back to the
      legacy positional scan. */
  input: string | null;
  activatedBy: PipelineEdgeActivation | null;
  output: string | null;
  verdict: StageVerdict | null;
  /** The completion the attempt reported for itself (graph slice 2), standing
      until its turn completes and settlement reads it. Absent on an attempt
      that never called, which settles from its fenced JSON verdict. */
  report?: PipelineStageReport | null;
  error: string | null;
  /** Set when a `needs_decision` verdict that carried findings was routed along
      this stage's fail edge as a fail (#1785). The verdict keeps the status the
      reviewer reported; this is what says the reviewer asked for a decision and
      the lane kept going instead of parking on it. */
  decisionRequested?: boolean;
  /** Bounded, append-only reconciliation receipt for terminal parser misses. */
  verdictRecovery?: PipelineVerdictRecovery;
  /** What a close could prove it did not finish (#1501): the authorized host
      processes still unresolved across identity-bound stops, each with the
      kernel identity it carried. While one of them is still that process, no
      close may terminalize this attempt, however dead the registry row looks;
      the record is cleared once every one is proven gone. */
  unresolvedTermination?: PipelineUnresolvedTermination;
};

export type PipelineUnresolvedTermination = {
  survivors: Array<{ pid: number; startIdentity: string | null; bootEpoch?: string | null }>;
  error: string;
  recordedAt: string;
};

export type PipelineStageRun = {
  stageId: string;
  attempts: PipelineStageAttempt[];
};

export type PipelineCursorState = "pending" | "spawning" | "running" | "reviewing" | "committing";

export type PipelineState = "draft" | "provisioning" | "running" | "needs_decision" | "paused" | "completed" | "closed";

/** A stage host a close asked the runtime to kill without confirming that it
    died (#670). Durable, so the possible survivor stays addressable: the board
    keeps showing the closed lane until a later close settles it. */
export type PipelineUnconfirmedHost = {
  stageId: string;
  attempt: number;
  conversationId: string | null;
  agentPath: string | null;
  paneId: string | null;
  operationId: string | null;
  detail: string;
  at: string;
};

export type PipelineCreationIntent = {
  kind: "task-spawn";
  taskId: string;
  launchId: string;
};

/** Durable receipt of finished-attempt host reaping (#574, #1123). Each stage
    attempt is settled independently, so an idle host can be retired while the
    rest of its pipeline runs or waits for a decision. */
export type PipelineTerminalReap = {
  /** Sweeps in the current unsettled batch that dispatched at least one kill,
      or were cut off by the budget. Reset when a later attempt becomes eligible. */
  rounds: number;
  /** Hosts whose termination this reap evidenced, across all batches. */
  stopped: number;
  lastAt: string;
  /** Stage-attempt keys already proved absent, stopped, or handed to the idle
      lifecycle after the runtime reported a later active turn. */
  settledAttempts: string[];
  /** Set once the current batch has no unfinished host, or the round ceiling is
      reached. A later finished attempt opens a new batch. */
  settledAt: string | null;
};

export type Pipeline = {
  id: string;
  task: string;
  /** Durable board-task membership. The legacy `task` field remains the title. */
  taskIds: string[];
  /** Launch-correlated creation evidence reserved before task-spawn actuation. */
  creationIntent?: PipelineCreationIntent;
  /** Pinned specification and acceptance criteria, matching Flow.spec from #85. */
  spec?: string;
  project: string;
  repoDir: string;
  worktreeDir: string;
  branch: string;
  baseBranch: string;
  baseRef: string;
  lastPassedCommit: string;
  /** Absent reads as `internal`. See {@link PipelinePublication}. */
  publication?: PipelinePublication;
  /** The revision the orchestrator last published to `origin/<branch>` under
      the `remote-branch` policy. Under that policy the review layer fences
      every round on the published head, so publication is the pipeline's job,
      not a stage's; recording what landed lets a steady state skip the remote
      probe entirely. Null while nothing is published. */
  publishedCommit?: string | null;
  stages: PipelineStage[];
  runs: PipelineStageRun[];
  /** The cursor carries the durable relay record (#353): the forwarded input and
      the activating edge are persisted in the same atomic write as the verdict
      that advanced here, so a crash between advance and spawn replays the
      identical prompt. */
  cursor: { stageId: string; state: PipelineCursorState; input: string | null; activatedBy: PipelineEdgeActivation | null } | null;
  state: PipelineState;
  pausedState: Exclude<PipelineState, "paused" | "draft"> | null;
  /** When the pipeline was last paused, and when it was last resumed. Durable
      because they are the only record a pause/resume transition leaves: the
      lifecycle journal (#686) derives its `stage_paused`/`stage_resumed` events
      from them, and a key built on the timestamp is what lets a second pause
      after a resume be a genuinely new event instead of a replay of the first. */
  pausedAt?: string | null;
  resumedAt?: string | null;
  stateDetail: string | null;
  srcPath: string | null;
  srcConversationId: string | null;
  createdAt: string;
  closedAt: string | null;
  hiddenAt?: string | null;
  /** When the operator took this lane off the phone board's queue (#1671).
      Presentation only and reversible: the lane's state, hosts, worktree and
      transcripts are untouched, and `undismiss` clears it. `hiddenAt` cannot
      carry this, because every reader takes it to mean closed or discarded. */
  dismissedAt?: string | null;
  /** Hosts the last close could not confirm terminated. Present only while one
      is outstanding; a close that confirms every kill clears it. */
  unconfirmedHosts?: PipelineUnconfirmedHost[];
  /** Receipt of the finished-host sweep completion triggers (#574). Absent
      until the pipeline first settles terminally with launched hosts to check. */
  terminalReap?: PipelineTerminalReap;
  /** Read-model marker set when a hidden container is projected for a pinned
      member, or for a closed lane still holding an unconfirmed host. */
  restored?: boolean;
  /** Durable user pin for the desktop board's world-space pipeline group. */
  pos?: { x: number; y: number };
  /** Accepted graph edits, oldest first, at most MAX_PIPELINE_GRAPH_EDITS. */
  graphEdits?: PipelineGraphEdit[];
  /** Accepted stage completion calls, oldest first, at most
      MAX_PIPELINE_STAGE_REPORTS (graph slice 2). */
  stageReports?: PipelineStageReportEntry[];
};

export type CreatePipelineRequest = {
  task: string;
  taskIds?: string[];
  spec?: string;
  repoDir: string;
  /** Merge target branch; defaults to main when the pipeline starts. */
  baseBranch?: string;
  /** Explicit git commit-ish to pin; defaults to the fetched origin branch. */
  baseRef?: string;
  stages: PipelineStageInput[];
  /** Creator transcript. API callers may omit it only when caller authentication can derive it. */
  src?: string;
  autoStart?: boolean;
  /** Defaults to `internal`; see {@link PipelinePublication}. */
  publication?: PipelinePublication;
};

/* The accepted actions, declared once (#774). The MCP tool schema publishes
   these to callers and the PATCH route admits exactly this set; an action added
   to one and forgotten in the other is the defect this constant prevents. */
export const PIPELINE_ACTIONS = [
  "start",
  "update-draft",
  "set-position",
  "add-stage",
  "remove-stage",
  "reorder-stage",
  "set-edge",
  "pause",
  "resume",
  "retry-stage",
  "skip-stage",
  "override-stage",
  "link-task",
  "unlink-task",
  "set-src",
  "delete",
  "close",
  "dismiss",
  "undismiss",
] as const;

export type PipelineAction = (typeof PIPELINE_ACTIONS)[number];

export type PatchPipelineRequest = {
  action: PipelineAction;
  /** Board task used by link-task and unlink-task. */
  taskId?: string;
  /** Creator transcript used by set-src. */
  srcPath?: string;
  /** Explicit authorization to replace existing creator lineage. */
  overwrite?: boolean;
  /** for override-stage: the not-yet-started stage to re-configure (issue #118
      on-canvas stage controls). Only fields present are changed; a stage that
      already ran an attempt is rejected so the override always targets the future.
      `role` swaps the canonical role (resolved through the registry like create,
      with the same param + disallowed-role validation); `null` clears it back to
      the Builder default. Changing the role resets any unpinned engine/model/
      effort to the new role's defaults; an explicit engine/model/effort still wins. */
  stageId?: string;
  /** retry-stage identity fence for a retry initiated from a launch receipt. */
  launchId?: string;
  /** The read a graph edit was made against (#1695 C7, graph slice 1). On
      override-stage and set-edge it is the `stageDigest` of `stageId`, which
      covers the stage's edges; on add-stage, remove-stage and reorder-stage it
      is the `graphDigest` of the whole ordered plan. `GET /api/pipelines/:id`
      and `get_pipeline` answer both. A plan that no longer has it answers 409
      `STAGE_CHANGED` and is left unchanged. */
  expectedStageDigest?: string;
  /** for retry-stage and skip-stage: the stage the caller saw the pipeline
      waiting on. A pipeline no longer waiting on it answers 409 `STAGE_CHANGED`
      before anything is closed, reset or started. Deliberately not `stageId`,
      which on retry-stage names a launch-receipt retry. */
  expectedStageId?: string;
  /** with `expectedStageId`: the `n` of that stage's latest own (non-historical)
      attempt the caller saw, or `0` when it saw none yet (a provisioning park).
      A different latest attempt answers 409 `STAGE_CHANGED`; `null` and other
      non-integers are malformed. */
  expectedAttempt?: number;
  role?: PipelineRoleRef | null;
  engine?: FlowEngine;
  model?: string | null;
  effort?: string | null;
  /** for override-stage: the not-yet-started run stage's access. Review-loop
      stages stay read-only (the resolver rejects read-write there). */
  access?: PipelineAccess;
  /** for override-stage: the account the stage runs on (#1279); `null` clears
      the pin back to the project's ordinary selection. Refused when the
      project's binding does not allow the named account. */
  account?: string | null;
  prompt?: string;
  task?: string;
  spec?: string;
  repoDir?: string;
  /** for set-position: exact world coordinates selected by a user drag. */
  pos?: { x: number; y: number };
  stage?: PipelineStageInput;
  index?: number;
  stageIds?: string[];
  toIndex?: number;
  /** for close: dismiss the hosts a previous close could not confirm, once the
      operator has judged them (a recycled pane id can look alive forever, so an
      unidentifiable host would otherwise pin the closed lane to the board).
      Only unconfirmed hosts are dismissed; one proven to be still running still
      refuses the close. */
  acknowledgeHosts?: boolean;
  /** for set-edge (#353): rewires `stageId`'s pass or fail edge. `to: null`
      clears it (a cleared pass edge makes the stage terminal). A stage that has
      already run keeps its pass edge frozen (history names its successor); a
      fail edge freezes once traversed. `maxRounds` bounds fail-edge cycles. */
  edge?: PipelineEdgeKind;
  to?: string | null;
  maxRounds?: number;
};

export type PipelinesResponse = {
  pipelines: Pipeline[];
};
