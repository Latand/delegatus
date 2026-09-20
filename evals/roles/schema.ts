export const ROLE_EVAL_SCHEMA_VERSION = "role-eval.v1";
export const PILOT_SEED = "20260920";

export type Arm = "A" | "B" | "C";
export type CaseId = "quota-window" | "error-row" | "diagnostic-summary";
export type TrialStatus = "planned" | "blocked" | "admitted" | "completed" | "unknown";

export interface Fixture {
  id: CaseId;
  baseCommit: string;
  treeHash: string;
  supportHash: string;
  candidateFiles: string[];
  forbiddenFiles: string[];
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

export interface TrialReceipt {
  cellId: string;
  clientRequestId: string;
  payloadHash: string;
  taskId: string;
  parentConversationId: string;
  conversationId?: string;
  launchId?: string;
  status: TrialStatus;
  model: ModelEvidence;
  candidateHead?: string;
  reviewedHead?: string;
  publishedHead?: string;
  usage?: Record<string, number>;
  evidenceHashes?: string[];
}

export interface Score {
  cellId: string;
  verdict: "pass" | "fail" | "blocked" | "incomplete";
  reasons: string[];
}
