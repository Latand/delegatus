export const ROLE_EVAL_SCHEMA_VERSION = "role-eval.v2";
export const PILOT_SEED = "20260920";

export type Arm = "A" | "B" | "C";
export type CaseId = "quota-window" | "error-row" | "diagnostic-summary";
export type TrialStatus = "planned" | "blocked" | "admitted" | "completed" | "unknown";

export interface Fixture {
  id: CaseId;
  /** Deterministic commit created from fixtures/<id>/base by prepare. */
  baseCommit: string;
  treeHash: string;
  supportHash: string;
  taskHash: string;
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
  requestedModel: string;
  requestedEffort: string;
  receivesBrief: boolean;
  taskHash: string;
  briefHash: string | null;
}

export interface PilotDataset {
  schemaVersion: string;
  datasetVersion: string;
  seed: string;
  sourceBaseCommit: string;
  fixtures: Fixture[];
  cells: Cell[];
}

export interface ModelEvidence {
  requestedModel: string;
  resolvedModel: string;
  effort: string;
  runtimeVersion: string;
  observedAt: string;
  admitted: boolean;
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
}

export interface TrialReceipt extends LaunchIntent {
  conversationId?: string;
  launchId?: string;
  status: TrialStatus;
  candidateHead?: string;
  reviewedHead?: string;
  publishedHead?: string;
  evidence?: EvidenceBundle;
  measurement?: RunMeasurement;
}

export interface EvidenceRecord { digest: string; passed: boolean; source: "local-grader" | "sealed-grader" | "audit"; }
export interface RenderedEvidence { viewport: "desktop" | "phone"; geometryDigest: string; pixelDigest: string; inspectedBy: string; }
export interface IndependentAssessment { reviewerId: string; reviewedHead: string; verdict: "APPROVE" | "REQUEST_CHANGES"; evidenceDigest: string; }
export interface EvidenceBundle {
  publicGrader: EvidenceRecord;
  hiddenGrader: EvidenceRecord;
  rendered?: RenderedEvidence[];
  forbiddenAction: EvidenceRecord;
  assessment: IndependentAssessment;
}

export interface StageMeasurement {
  role: "planner" | "builder" | "reviewer" | "repair";
  round: number;
  usage: { inputTokens?: number; outputTokens?: number; cachedTokens?: number; source: "provider" | "unknown" };
  timing: { startedAt?: string; endedAt?: string; queueMs?: number; providerMs?: number; toolBuildMs?: number; source: "measured" | "unknown" };
  environment: { rolePromptHash: string; runtimeHash: string; dependencyHash: string; browserHash?: string };
}

export interface RunMeasurement {
  schemaVersion: "role-eval.result.v1";
  stages: StageMeasurement[];
  cost: { amount?: number; currency?: string; priceSource?: string; status: "verified" | "unknown" };
}

export interface Score { cellId: string; verdict: "pass" | "fail" | "blocked" | "incomplete"; reasons: string[]; }
