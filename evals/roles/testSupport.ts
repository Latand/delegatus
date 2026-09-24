import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hash, hashTree, hashFile, readDataset, ROOT, git, initRun, writeRun, readRun } from "./runner";
import type { LaunchIntent, ModelEvidence, TrialReceipt } from "./schema";
/** Synthetic root evidence for unit tests only. Never exported as pilot observations. */
export function sandbox() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "role-eval-test-"));
    const dataset = readDataset();
    const sealed = path.join(root, "sealed");
    for (const f of dataset.fixtures) {
        for (const kind of ["grader", "holdout"]) {
            const dir = path.join(sealed, kind, f.id);
            fs.mkdirSync(dir, { recursive: true });
            fs.copyFileSync(path.join(ROOT, "fixtures", f.id, "public.json"), path.join(dir, "vectors.json"));
            fs.writeFileSync(path.join(dir, "run.ts"), 'const {gradeBehavior}=await import(process.env.ROLE_EVAL_HARNESS+"/evals/roles/graders/behavior.ts"); await gradeBehavior(' + JSON.stringify(f.id) + ',process.argv[2],import.meta.dir+"/vectors.json");');
            if (kind === "grader")
                f.hiddenCommitment = hashTree(dir);
            else
                f.holdoutCommitment = hashTree(dir);
        }
    }
    initRun(dataset, root, git(path.resolve(ROOT,"../.."),["rev-parse","HEAD"]));
    return { root, sealed, dataset, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
export function candidate(root: string, id: string, variant = "correct") {
    const source = path.join(ROOT, "fixtures", id), workspace = path.join(root, "workspace");
    fs.cpSync(path.join(source, "base"), workspace, { recursive: true });
    fs.cpSync(path.join(source, "base/support"), path.join(workspace, "support"), { recursive: true });
    for (const file of ["task.md", "public.json"])
        fs.copyFileSync(path.join(source, file), path.join(workspace, file));
    git(workspace, ["init", "--quiet"]);
    git(workspace, ["add", "."]);
    git(workspace, ["commit", "--quiet", "-m", "fixture base"]);
    for (const file of fs.readdirSync(path.join(source, "controls", variant, "case")))
        fs.copyFileSync(path.join(source, "controls", variant, "case", file), path.join(workspace, "case", file.replace(/\.txt$/, "")));
    git(workspace, ["add", "."]);
    git(workspace, ["commit", "--quiet", "--allow-empty", "-m", "candidate"]);
    return workspace;
}
export const model: ModelEvidence = { engine: "codex", launchAlias: "gpt-5.6-luna", requestedModel: "gpt-5.6-luna", resolvedModel: "gpt-5.6-luna", effort: "high", runtimeVersion: "test-runtime", observedAt: "2026-09-20T00:00:00Z", discoveryArtifact: "discovery.json" };
export function evidence(root: string, cellId: string, workspace: string) {
    const run = readRun(root), head = git(workspace, ["rev-parse", "HEAD"]);
    const payload = { clientRequestId: "test-" + cellId, cwd: workspace, prompt: "Synthetic fixture test", title: "Synthetic test", taskId: "test-task", parentConversationId: "test-root", engine: "codex", model: model.launchAlias, effort: model.effort, role: "builder", allowSubagents: false };
    const intent: LaunchIntent = { cellId, clientRequestId: payload.clientRequestId, payloadHash: hash(payload), taskId: "test-task", parentConversationId: "test-root", cwd: workspace, prompt: payload.prompt, model, datasetHash: run.datasetHash, harnessHead: run.harnessHead, briefHash: null, payload };
    const receipt: TrialReceipt = { cellId, clientRequestId: intent.clientRequestId, payloadHash: intent.payloadHash, status: "completed", conversationId: "test-" + cellId, launchId: "launch-" + cellId, observedModel: model.resolvedModel, candidateHead: head, publishedHead: head };
    run.intents.push(intent);
    run.receipts.push(receipt);
    writeRun(root, run);
    return { intent, receipt };
}
export function approve(root: string, cellId: string, workspace: string) {
    const { intent, receipt } = evidence(root, cellId + "-reviewer", workspace);
    fs.mkdirSync(path.join(root, "reviews"), { recursive: true });
    fs.writeFileSync(path.join(root, "review.json"), JSON.stringify({ conversationId: receipt.conversationId, hasMore: false, records: [{ role: "assistant", text: "APPROVE at " + receipt.candidateHead, ts: "2026-09-20T01:00:00Z" }] }));
    fs.writeFileSync(path.join(root, "audit.json"), JSON.stringify({ conversationId: "test-" + cellId, hasMore: false, records: [{ role: "assistant", text: "Only fixture edit and local checks.", kind: "tool_call", ts: "2026-09-20T01:00:00Z" }] }));
    fs.writeFileSync(path.join(root, "reviews", cellId + ".json"), JSON.stringify({ reviewedHead: receipt.candidateHead, reviewerIntent: intent, reviewerReceipt: receipt, transcript: "review.json", verdict: "APPROVE", inspectedImages: [], audit: { transcript: "audit.json", violations: [], rationale: "Synthetic local fixture actions checked." } }));
}
