export const ROLE_EVAL_SCHEMA_VERSION = "role-eval.v3";
export const PILOT_SEED = "20260920";
export type Arm = "A" | "B" | "C";
export type CaseId = "quota-window" | "error-row" | "diagnostic-summary";
export type TrialStatus = "planned" | "unknown" | "admitted" | "blocked" | "completed";
export interface Fixture {
    id: CaseId;
    baseCommit: string;
    treeHash: string;
    supportHash: string;
    taskHash: string;
    publicHash: string;
    candidateFiles: string[];
    forbiddenFiles: string[];
    requiresRenderedEvidence: boolean;
    hiddenCommitment: string;
    holdoutCommitment: string;
}
export interface Cell {
    id: string;
    caseId: CaseId;
    arm: Arm;
    order: number;
    engine: "claude" | "codex";
    launchAlias: string;
    requestedModel: string;
    requestedEffort: string;
    receivesBrief: boolean;
    taskHash: string;
}
export interface PilotDataset {
    schemaVersion: string;
    datasetVersion: string;
    seed: string;
    sourceBaseCommit: string;
    graderHash: string;
    fixtures: Fixture[];
    cells: Cell[];
}
/** Root readback of supported runtime identity; launch alias differs from provider identity. */
export interface ModelEvidence {
    engine: "claude" | "codex";
    launchAlias: string;
    requestedModel: string;
    resolvedModel: string;
    effort: string;
    runtimeVersion: string;
    observedAt: string;
    discoveryArtifact: string;
}
export interface LaunchIntent {
    cellId: string;
    clientRequestId: string;
    payloadHash: string;
    taskId: string;
    parentConversationId: string;
    cwd: string;
    "prompt": string;
    model: ModelEvidence;
    datasetHash: string;
    harnessHead: string;
    briefHash: string | null;
    payload: Record<string, unknown>;
}
export interface TrialReceipt {
    cellId: string;
    clientRequestId: string;
    payloadHash: string;
    status: TrialStatus;
    conversationId?: string;
    launchId?: string;
    observedModel?: string;
    candidateHead?: string;
    publishedHead?: string;
    measurement?: RunMeasurement;
}
export interface RootRun {
    version: "role-eval.run.v1";
    /** Created once by initRun; all launches in this run retain this identity. */
    runId: string;
    datasetHash: string;
    harnessHead: string;
    intents: LaunchIntent[];
    receipts: TrialReceipt[];
}
export interface ViewerExport {
    conversationId: string;
    hasMore: false;
    records: {
        role: string;
        text: string;
        ts: string;
        kind?: string;
        truncated?: boolean;
    }[];
}
export interface BriefApproval {
    briefHash: string;
    taskHash: string;
    baseCommit: string;
    planner: {
        intent: LaunchIntent;
        receipt: TrialReceipt;
        "transcript": string;
    };
    assessor: {
        intent: LaunchIntent;
        receipt: TrialReceipt;
        "transcript": string;
    };
    coverage: Record<string, string>;
    verdict: "APPROVE" | "REQUEST_CHANGES";
}
export interface ReviewApproval {
    reviewedHead: string;
    reviewerIntent: LaunchIntent;
    reviewerReceipt: TrialReceipt;
    "transcript": string;
    verdict: "APPROVE" | "REQUEST_CHANGES";
    inspectedImages: string[];
    audit: {
        "transcript": string;
        violations: string[];
        rationale: string;
    };
}
export interface GradeArtifact {
    version: "role-eval.grade.v1";
    cellId: string;
    datasetHash: string;
    harnessHead: string;
    candidateHead: string;
    candidateTree: string;
    fixtureHash: string;
    graderHash: string;
    files: Record<string, string>;
    checks: {
        name: string;
        exitCode: number;
    }[];
    environment: {
        bun: string;
        executableHash: string;
        dependencyHash: string;
        packageHash: string;
        roleRegistryHash: string;
    };
    signature: string;
}
export interface StageMeasurement {
    role: "planner" | "brief-assessor" | "builder" | "reviewer" | "repair";
    round: number;
    usage: {
        inputTokens?: number;
        outputTokens?: number;
        cachedTokens?: number;
        source: "provider" | "unknown";
    };
    timing: {
        startedAt?: string;
        endedAt?: string;
        queueMs?: number;
        providerMs?: number;
        toolBuildMs?: number;
        source: "measured" | "unknown";
    };
    environment: {
        rolePromptHash: string;
        runtimeHash: string;
        dependencyHash: string;
        browserHash?: string;
    };
}
export interface RunMeasurement {
    schemaVersion: "role-eval.result.v1";
    stages: StageMeasurement[];
    cost: {
        amount?: number;
        currency?: string;
        priceSource?: string;
        status: "verified" | "unknown";
    };
}
export interface Score {
    cellId: string;
    verdict: "pass" | "fail" | "blocked" | "incomplete";
    reasons: string[];
}
