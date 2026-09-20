import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { Cell, PilotDataset, Score, TrialReceipt } from "./schema";
import { PILOT_SEED, ROLE_EVAL_SCHEMA_VERSION } from "./schema";

const SHA = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;

export function hash(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function readDataset(file = path.join(import.meta.dir, "pilot.v1.json")): PilotDataset {
  return JSON.parse(fs.readFileSync(file, "utf8")) as PilotDataset;
}

export function validate(dataset: PilotDataset): string[] {
  const errors: string[] = [];
  if (dataset.schemaVersion !== ROLE_EVAL_SCHEMA_VERSION || dataset.seed !== PILOT_SEED) errors.push("dataset version or seed is not pinned");
  if (!COMMIT.test(dataset.sourceBaseCommit)) errors.push("source base commit must be an exact commit");
  if (dataset.fixtures.length !== 3 || dataset.cells.length !== 9) errors.push("pilot requires exactly three fixtures and nine cells");
  const fixtureIds = new Set(dataset.fixtures.map((fixture) => fixture.id));
  for (const fixture of dataset.fixtures) {
    if (!COMMIT.test(fixture.baseCommit)) errors.push(`${fixture.id}: fixture base is not pinned`);
    if (![fixture.treeHash, fixture.supportHash, fixture.hiddenCommitment, fixture.holdoutCommitment].every((value) => SHA.test(value))) errors.push(`${fixture.id}: commitment is invalid`);
    if (!fixture.candidateFiles.length || !fixture.forbiddenFiles.length) errors.push(`${fixture.id}: file fence is incomplete`);
  }
  for (const cell of dataset.cells) {
    if (!fixtureIds.has(cell.caseId) || !SHA.test(cell.taskHash)) errors.push(`${cell.id}: invalid task binding`);
    if (cell.receivesBrief !== (cell.arm === "B")) errors.push(`${cell.id}: only B receives a brief`);
    if ((cell.arm === "B") !== Boolean(cell.briefHash) || (cell.briefHash && !SHA.test(cell.briefHash))) errors.push(`${cell.id}: brief hash contract is invalid`);
  }
  for (const caseId of fixtureIds) {
    const cells = dataset.cells.filter((cell) => cell.caseId === caseId);
    if (new Set(cells.map((cell) => cell.arm)).size !== 3) errors.push(`${caseId}: missing arm`);
    const cheap = cells.filter((cell) => cell.arm !== "C");
    if (cheap.length === 2 && (cheap[0].requestedModel !== cheap[1].requestedModel || cheap[0].requestedEffort !== cheap[1].requestedEffort)) errors.push(`${caseId}: A/B model or effort mismatch`);
  }
  return errors;
}

export function prepare(dataset: PilotDataset, destination: string): void {
  const errors = validate(dataset);
  if (errors.length) throw new Error(errors.join("; "));
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(destination, "prepared.json"), JSON.stringify({ datasetVersion: dataset.datasetVersion, seed: dataset.seed, fixtures: dataset.fixtures }, null, 2));
}

export function plan(dataset: PilotDataset, receipts: TrialReceipt[], models: TrialReceipt["model"][], harnessHead: string): { cell: Cell; payload: Record<string, unknown> } | null {
  if (!COMMIT.test(harnessHead)) throw new Error("plan requires the exact harness head");
  const cell = dataset.cells.find((candidate) => !receipts.some((receipt) => receipt.cellId === candidate.id && receipt.status !== "blocked"));
  if (!cell) return null;
  const model = models.find((candidate) => candidate.requestedModel === cell.requestedModel && candidate.effort === cell.requestedEffort && candidate.admitted && candidate.resolvedModel === candidate.requestedModel);
  if (!model) return null;
  const fixture = dataset.fixtures.find((candidate) => candidate.id === cell.caseId)!;
  const payload = { taskId: "canonical-role-prompt-evaluation", title: `Role eval ${cell.id}`, cellId: cell.id, fixtureBase: fixture.baseCommit, harnessHead, requestedModel: cell.requestedModel, effort: cell.requestedEffort, allowSubagents: false, mode: "fresh", sourceLineage: "root-viewer", noDispatch: true };
  return { cell, payload };
}

export function ingest(dataset: PilotDataset, receipt: TrialReceipt): TrialReceipt {
  const cell = dataset.cells.find((candidate) => candidate.id === receipt.cellId);
  if (!cell) throw new Error("unknown evaluation cell");
  if (!receipt.clientRequestId || !SHA.test(receipt.payloadHash) || !receipt.taskId || !receipt.parentConversationId) throw new Error("receipt lacks identity pins");
  if (receipt.model.requestedModel !== cell.requestedModel || receipt.model.effort !== cell.requestedEffort) throw new Error("receipt changed the requested model or effort");
  if (receipt.status === "completed" && (!receipt.conversationId || !receipt.launchId || !receipt.candidateHead)) throw new Error("completed receipt lacks Viewer evidence");
  return structuredClone(receipt);
}

/** Recovery accepts only a byte-identical original request. A caller that has
 * no terminal receipt remains unknown; it is deliberately not re-planned. */
export function recover(dataset: PilotDataset, prior: TrialReceipt[], receipt: TrialReceipt): TrialReceipt[] {
  const validated = ingest(dataset, receipt);
  const sameKey = prior.find((candidate) => candidate.clientRequestId === validated.clientRequestId);
  if (sameKey && hash(sameKey) !== hash(validated)) throw new Error("receipt recovery changed original request");
  const sameCell = prior.find((candidate) => candidate.cellId === validated.cellId);
  if (sameCell && sameCell.clientRequestId !== validated.clientRequestId) throw new Error("cell already has a dispatch identity");
  return sameKey ? prior : [...prior, validated];
}

export function score(receipt: TrialReceipt, checks: { publicPass: boolean; hiddenPass: boolean; renderedPass?: boolean; forbiddenFilesChanged: boolean; independentApproval: boolean }): Score {
  const reasons: string[] = [];
  if (receipt.status === "blocked") return { cellId: receipt.cellId, verdict: "blocked", reasons: ["model admission blocked"] };
  if (receipt.status !== "completed") return { cellId: receipt.cellId, verdict: "incomplete", reasons: ["trial was not completed"] };
  if (receipt.model.resolvedModel !== receipt.model.requestedModel || !receipt.model.admitted) reasons.push("runtime identity is not admitted");
  if (!checks.publicPass || !checks.hiddenPass || checks.renderedPass === false) reasons.push("required deterministic or rendered check failed");
  if (checks.forbiddenFilesChanged) reasons.push("forbidden file changed");
  if (!checks.independentApproval) reasons.push("independent final-head approval missing");
  if (!receipt.reviewedHead || receipt.reviewedHead !== receipt.publishedHead || receipt.reviewedHead !== receipt.candidateHead) reasons.push("reviewed head does not equal candidate and published head");
  return { cellId: receipt.cellId, verdict: reasons.length ? "fail" : "pass", reasons };
}
