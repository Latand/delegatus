import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { Cell, EvidenceBundle, Fixture, LaunchIntent, PilotDataset, Score, TrialReceipt } from "./schema";
import { PILOT_SEED, ROLE_EVAL_SCHEMA_VERSION } from "./schema";

const SHA = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const ROOT = import.meta.dir;

export function hash(value: unknown): string { return crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex"); }
export function hashFile(file: string): string { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
export function hashTree(directory: string): string {
  const entries = fs.readdirSync(directory, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => {
    const relative = path.relative(directory, path.join(entry.parentPath, entry.name)); return `${relative}\0${hashFile(path.join(directory, relative))}`;
  }).sort();
  return hash(entries.join("\n"));
}
export function readDataset(file = path.join(ROOT, "pilot.v1.json")): PilotDataset { return JSON.parse(fs.readFileSync(file, "utf8")) as PilotDataset; }
function fixtureRoot(fixture: Fixture): string { return path.join(ROOT, "fixtures", fixture.id); }
function taskFile(fixture: Fixture): string { return path.join(fixtureRoot(fixture), "task.md"); }
function briefFile(fixture: Fixture): string { return path.join(fixtureRoot(fixture), "brief.md"); }

export function validate(dataset: PilotDataset): string[] {
  const errors: string[] = [];
  if (dataset.schemaVersion !== ROLE_EVAL_SCHEMA_VERSION || dataset.seed !== PILOT_SEED) errors.push("dataset version or seed is not pinned");
  if (!COMMIT.test(dataset.sourceBaseCommit)) errors.push("source base commit must be an exact commit");
  if (dataset.fixtures.length !== 3 || dataset.cells.length !== 9) errors.push("pilot requires exactly three fixtures and nine cells");
  const ids = new Set(dataset.fixtures.map((fixture) => fixture.id));
  for (const fixture of dataset.fixtures) {
    if (!COMMIT.test(fixture.baseCommit)) errors.push(`${fixture.id}: fixture base is not pinned`);
    if (![fixture.treeHash, fixture.supportHash, fixture.taskHash, fixture.hiddenCommitment, fixture.holdoutCommitment].every((value) => SHA.test(value))) errors.push(`${fixture.id}: commitment is invalid`);
    if (!fixture.candidateFiles.length || !fixture.forbiddenFiles.length) errors.push(`${fixture.id}: file fence is incomplete`);
    if (!fs.existsSync(taskFile(fixture)) || !fs.existsSync(path.join(fixtureRoot(fixture), "base"))) errors.push(`${fixture.id}: fixture material is absent`);
    else if (hashTree(path.join(fixtureRoot(fixture), "base")) !== fixture.treeHash || hashTree(path.join(fixtureRoot(fixture), "support")) !== fixture.supportHash || hashFile(taskFile(fixture)) !== fixture.taskHash) errors.push(`${fixture.id}: fixture bytes do not match commitments`);
  }
  for (const cell of dataset.cells) {
    const fixture = dataset.fixtures.find((candidate) => candidate.id === cell.caseId);
    if (!ids.has(cell.caseId) || cell.taskHash !== fixture?.taskHash || !SHA.test(cell.taskHash)) errors.push(`${cell.id}: invalid task binding`);
    if (cell.receivesBrief !== (cell.arm === "B")) errors.push(`${cell.id}: only B receives a brief`);
    if ((cell.arm === "B") !== Boolean(cell.briefHash) || (cell.briefHash && (!SHA.test(cell.briefHash) || hashFile(briefFile(fixture!)) !== cell.briefHash))) errors.push(`${cell.id}: brief hash contract is invalid`);
  }
  for (const id of ids) { const cells = dataset.cells.filter((cell) => cell.caseId === id); const cheap = cells.filter((cell) => cell.arm !== "C"); if (new Set(cells.map((cell) => cell.arm)).size !== 3) errors.push(`${id}: missing arm`); if (cheap.length === 2 && (cheap[0].requestedModel !== cheap[1].requestedModel || cheap[0].requestedEffort !== cheap[1].requestedEffort)) errors.push(`${id}: A/B model or effort mismatch`); }
  return errors;
}

function copyDirectory(source: string, destination: string): void { fs.cpSync(source, destination, { recursive: true, errorOnExist: true }); }
function git(directory: string, args: string[]): string { return execFileSync("git", args, { cwd: directory, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "noreply@example.invalid", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "noreply@example.invalid", GIT_AUTHOR_DATE: "2026-09-20T00:00:00Z", GIT_COMMITTER_DATE: "2026-09-20T00:00:00Z" } }).trim(); }

/** Candidate directories contain only base/support/task material. Sealed data is only hashed in its external root. */
export function prepare(dataset: PilotDataset, destination: string, sealedRoot?: string): void {
  const errors = validate(dataset); if (errors.length) throw new Error(errors.join("; "));
  fs.mkdirSync(destination, { recursive: true }); const prepared: Array<{ id: string; baseCommit: string; workspace: string }> = [];
  for (const fixture of dataset.fixtures) {
    const root = path.join(destination, fixture.id); fs.mkdirSync(root); const workspace = path.join(root, "workspace");
    copyDirectory(path.join(fixtureRoot(fixture), "base"), workspace); fs.copyFileSync(taskFile(fixture), path.join(root, "task.md"));
    git(workspace, ["init", "--quiet"]); git(workspace, ["add", "."]); git(workspace, ["commit", "--quiet", "-m", "fixture base"]);
    const baseCommit = git(workspace, ["rev-parse", "HEAD"]); if (baseCommit !== fixture.baseCommit) throw new Error(`${fixture.id}: materialized base commit does not match manifest`); copyDirectory(path.join(fixtureRoot(fixture), "support"), path.join(workspace, "support"));
    for (const variant of ["defective", "correct", "seeded-bug"]) { const control = path.join(root, "controls", variant); fs.mkdirSync(path.dirname(control), { recursive: true }); copyDirectory(path.join(fixtureRoot(fixture), "controls", variant), control); }
    if (sealedRoot) for (const [kind, expected] of [["grader", fixture.hiddenCommitment], ["holdout", fixture.holdoutCommitment]] as const) { const sealed = path.join(sealedRoot, kind, fixture.id); if (!fs.existsSync(sealed) || hashTree(sealed) !== expected) throw new Error(`${fixture.id}: sealed ${kind} commitment mismatch`); }
    prepared.push({ id: fixture.id, baseCommit, workspace });
  }
  fs.writeFileSync(path.join(destination, "prepared.json"), JSON.stringify({ datasetVersion: dataset.datasetVersion, seed: dataset.seed, prepared, sealedVerified: Boolean(sealedRoot) }, null, 2));
}

function workerPrompt(cell: Cell, fixture: Fixture): string { const shared = fs.readFileSync(taskFile(fixture), "utf8"); const brief = cell.receivesBrief ? `\n\nAccepted planner brief (frozen ${cell.briefHash}):\n${fs.readFileSync(briefFile(fixture), "utf8")}` : ""; return `${shared}${brief}\n\nUse only this workspace. Do not search history, siblings, hidden graders, holdouts, or other candidate outputs. Implement independently.`; }
/** Conservative admission screen: a brief carries decisions and checks, never implementation transfer. */
export function assessBrief(brief: string): string[] {
  const errors: string[] = [];
  for (const requirement of ["Behavior", "Diagnosis", "Files", "Check", "Escalate"]) if (!brief.includes(requirement)) errors.push(`brief lacks ${requirement.toLowerCase()} coverage`);
  if (/```|\bfunction\s+\w+\s*\(|=>|\breturn\s+[^.;]+;/.test(brief)) errors.push("brief contains executable handoff material");
  if (/\bfirst\b.{0,80}\bthen\b.{0,80}\bthen\b/i.test(brief)) errors.push("brief contains algorithm-complete pseudocode");
  return errors;
}
export function plan(dataset: PilotDataset, receipts: TrialReceipt[], models: TrialReceipt["model"][], harnessHead: string, identity: { taskId: string; parentConversationId: string; cwd: string }): { cell: Cell; intent: LaunchIntent; payload: Record<string, unknown> } | null {
  if (!COMMIT.test(harnessHead)) throw new Error("plan requires the exact harness head"); if (!identity.taskId || !identity.parentConversationId || !identity.cwd) throw new Error("plan requires canonical Viewer task, lineage, and workspace");
  const cell = dataset.cells.find((candidate) => !receipts.some((receipt) => receipt.cellId === candidate.id)); if (!cell) return null;
  const model = models.find((candidate) => candidate.requestedModel === cell.requestedModel && candidate.effort === cell.requestedEffort && candidate.admitted && candidate.resolvedModel === candidate.requestedModel && candidate.runtimeVersion); if (!model) return null;
  const fixture = dataset.fixtures.find((candidate) => candidate.id === cell.caseId)!; if (cell.receivesBrief) { const errors = assessBrief(fs.readFileSync(briefFile(fixture), "utf8")); if (errors.length) throw new Error(`B brief admission failed: ${errors.join("; ")}`); } const clientRequestId = `role-eval-${dataset.datasetVersion}-${cell.id}-${harnessHead.slice(0, 12)}`;
  const payload = { clientRequestId, cwd: identity.cwd, prompt: workerPrompt(cell, fixture), title: `Role evaluation ${cell.id}`, taskId: identity.taskId, parentConversationId: identity.parentConversationId, engine: "codex", model: cell.requestedModel, effort: cell.requestedEffort, role: "builder", allowSubagents: false };
  return { cell, intent: { cellId: cell.id, clientRequestId, payloadHash: hash(payload), taskId: identity.taskId, parentConversationId: identity.parentConversationId, cwd: identity.cwd, prompt: payload.prompt, model }, payload };
}
export function ingest(dataset: PilotDataset, receipt: TrialReceipt, intent: LaunchIntent): TrialReceipt {
  const cell = dataset.cells.find((candidate) => candidate.id === receipt.cellId); if (!cell) throw new Error("unknown evaluation cell");
  for (const key of ["cellId", "clientRequestId", "payloadHash", "taskId", "parentConversationId", "cwd", "prompt"] as const) if (receipt[key] !== intent[key]) throw new Error(`receipt changed immutable launch ${key}`);
  if (receipt.model.requestedModel !== cell.requestedModel || receipt.model.effort !== cell.requestedEffort || receipt.model.resolvedModel !== cell.requestedModel || !receipt.model.admitted || !receipt.model.runtimeVersion) throw new Error("receipt changed or lacks admitted runtime identity");
  if (receipt.status === "completed" && (!receipt.conversationId || !receipt.launchId || !receipt.candidateHead)) throw new Error("completed receipt lacks Viewer evidence"); return structuredClone(receipt);
}
function immutable(receipt: TrialReceipt) { const { cellId, clientRequestId, payloadHash, taskId, parentConversationId, cwd, prompt, model } = receipt; return { cellId, clientRequestId, payloadHash, taskId, parentConversationId, cwd, prompt, model }; }
export function recover(dataset: PilotDataset, prior: TrialReceipt[], receipt: TrialReceipt, intent: LaunchIntent): TrialReceipt[] { const validated = ingest(dataset, receipt, intent); const sameKey = prior.find((candidate) => candidate.clientRequestId === validated.clientRequestId); if (sameKey && hash(immutable(sameKey)) !== hash(immutable(validated))) throw new Error("receipt recovery changed original request"); const sameCell = prior.find((candidate) => candidate.cellId === validated.cellId); if (sameCell && sameCell.clientRequestId !== validated.clientRequestId) throw new Error("cell already has a dispatch identity"); return sameKey ? prior.map((candidate) => candidate.clientRequestId === validated.clientRequestId ? validated : candidate) : [...prior, validated]; }
function evidenceFailures(fixture: Fixture, evidence: EvidenceBundle | undefined, receipt: TrialReceipt): string[] {
  if (!evidence) return ["deterministic evidence bundle missing"]; const reasons: string[] = [];
  for (const [name, record] of Object.entries({ public: evidence.publicGrader, hidden: evidence.hiddenGrader, forbiddenAction: evidence.forbiddenAction })) if (!record?.passed || !SHA.test(record?.digest ?? "")) reasons.push(`${name} evidence is absent or failed`);
  if (fixture.requiresRenderedEvidence) { const viewports = new Set(evidence.rendered?.map((item) => item.viewport)); if (!viewports.has("desktop") || !viewports.has("phone") || evidence.rendered?.some((item) => !SHA.test(item.geometryDigest) || !SHA.test(item.pixelDigest) || !item.inspectedBy)) reasons.push("every required UI viewport lacks inspected pixels and geometry"); }
  const assessment = evidence.assessment; if (!assessment || assessment.verdict !== "APPROVE" || !assessment.reviewerId || !SHA.test(assessment.evidenceDigest) || assessment.reviewedHead !== receipt.candidateHead) reasons.push("independent final-head approval missing"); return reasons;
}
export function score(dataset: PilotDataset, receipt: TrialReceipt, intent: LaunchIntent): Score { const fixture = dataset.fixtures.find((candidate) => candidate.id === receipt.cellId.replace(/-[ABC]$/, "")); if (!fixture) throw new Error("receipt has no fixture"); ingest(dataset, receipt, intent); if (receipt.status === "blocked") return { cellId: receipt.cellId, verdict: "blocked", reasons: ["model admission blocked"] }; if (receipt.status !== "completed") return { cellId: receipt.cellId, verdict: "incomplete", reasons: ["trial was not completed"] }; const reasons = evidenceFailures(fixture, receipt.evidence, receipt); if (!receipt.reviewedHead || receipt.reviewedHead !== receipt.publishedHead || receipt.reviewedHead !== receipt.candidateHead) reasons.push("reviewed head does not equal candidate and published head"); return { cellId: receipt.cellId, verdict: reasons.length ? "fail" : "pass", reasons }; }
