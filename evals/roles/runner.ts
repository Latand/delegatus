import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { validateLaunchModel } from "../../src/lib/agent/models";
import { reasoningFromBody } from "../../src/lib/agent/efforts";
import { reviewVerdict } from "../../src/lib/review";
import type { Cell, Fixture, LaunchIntent, ModelEvidence, PilotDataset, RootRun, Score, TrialReceipt, BriefApproval, ViewerExport, GradeArtifact, ReviewApproval } from "./schema";
import { PILOT_SEED, ROLE_EVAL_SCHEMA_VERSION } from "./schema";
export const ROOT = import.meta.dir;
const COMMIT = /^[a-f0-9]{40}$/;
const SHA = /^[a-f0-9]{64}$/;
export function hash(value: unknown): string { return crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex"); }
export function hashFile(file: string): string { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
export function files(directory: string): string[] {
    return fs.readdirSync(directory, { recursive: true, withFileTypes: true }).flatMap(e => {
        if (e.isSymbolicLink())
            throw new Error("artifact tree contains a symlink");
        return e.isFile() ? [path.relative(directory, path.join(e.parentPath, e.name))] : [];
    }).sort();
}
export function hashTree(directory: string): string { return hash(files(directory).map(f => f + "\0" + hashFile(path.join(directory, f))).join("\n")); }
export function readDataset(file = path.join(ROOT, "pilot.v1.json")): PilotDataset { return JSON.parse(fs.readFileSync(file, "utf8")); }
export function fixtureRoot(fixture: Fixture): string { return path.join(ROOT, "fixtures", fixture.id); }
export function git(directory: string, args: string[]): string {
    return execFileSync("git", args, { cwd: directory, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "noreply@example.invalid", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "noreply@example.invalid", GIT_AUTHOR_DATE: "2026-09-20T00:00:00Z", GIT_COMMITTER_DATE: "2026-09-20T00:00:00Z" } }).trim();
}
export function validate(dataset: PilotDataset): string[] {
    const errors: string[] = [];
    if (dataset.schemaVersion !== ROLE_EVAL_SCHEMA_VERSION || dataset.seed !== PILOT_SEED || !COMMIT.test(dataset.sourceBaseCommit))
        errors.push("dataset version, seed or source base invalid");
    if (dataset.fixtures.length !== 3 || dataset.cells.length !== 9 || new Set(dataset.cells.map(c => c.id)).size !== 9)
        errors.push("requires three cases and nine distinct cells");
    if (hashTree(path.join(ROOT, "graders")) !== dataset.graderHash)
        errors.push("grader bytes changed");
    for (const f of dataset.fixtures) {
        try {
            const r = fixtureRoot(f);
            if (!COMMIT.test(f.baseCommit) || ![f.hiddenCommitment, f.holdoutCommitment].every(x => SHA.test(x)))
                errors.push(f.id + ": invalid commitments");
            if (hashTree(path.join(r, "base")) !== f.treeHash || hashTree(path.join(r, "base/support")) !== f.supportHash || hashFile(path.join(r, "task.md")) !== f.taskHash || hashFile(path.join(r, "public.json")) !== f.publicHash)
                errors.push(f.id + ": fixture bytes changed");
            const provenance = JSON.parse(fs.readFileSync(path.join(r, "base/support/provenance.json"), "utf8")) as {
                source: string;
                sourceHash: string;
                export: string;
                exportHash: string;
            }[];
            for (const item of provenance) {
                const source = execFileSync("git", ["show", dataset.sourceBaseCommit + ":" + item.source], { cwd: path.resolve(ROOT, "../..") });
                if (crypto.createHash("sha256").update(source).digest("hex") !== item.sourceHash || hashFile(path.join(r, "base/support", item.export)) !== item.exportHash)
                    errors.push(f.id + ": pinned support provenance changed");
            }
            const cells = dataset.cells.filter(c => c.caseId === f.id);
            if (cells.length !== 3 || !["A","B","C"].every(arm=>cells.some(c=>c.arm===arm)))
                errors.push(f.id + ": missing arm");
            const a = cells.find(c => c.arm === "A"), b = cells.find(c => c.arm === "B");
            if (!a || !b || hash([a.engine, a.launchAlias, a.requestedModel, a.requestedEffort]) !== hash([b.engine, b.launchAlias, b.requestedModel, b.requestedEffort]))
                errors.push(f.id + ": A/B treatment drift");
        }
        catch {
            errors.push(f.id + ": fixture material absent");
        }
    }
    for (const c of dataset.cells) {
        if(c.id!==c.caseId+"-"+c.arm || !Number.isInteger(c.order) || c.order<1 || c.order>9)errors.push(c.id+": invalid cell identity/order");
        if (c.taskHash !== dataset.fixtures.find(f => f.id === c.caseId)?.taskHash || c.receivesBrief !== (c.arm === "B"))
            errors.push(c.id + ": task binding invalid");
        if ("error" in validateLaunchModel(c.engine, c.launchAlias) || reasoningFromBody(c.engine, { model: c.launchAlias, effort: c.requestedEffort }).error)
            errors.push(c.id + ": Viewer admission invalid");
    }
    if(new Set(dataset.cells.map(c=>c.order)).size!==9)errors.push("cell order must be unique");
    return errors;
}
function requireValid(dataset: PilotDataset) { const errors = validate(dataset); if (errors.length)
    throw new Error(errors.join("; ")); }
export function privateRoot(root: string, candidate?: string): string {
    const resolved = fs.realpathSync(root);
    const repo = path.resolve(ROOT, "../..");
    if (resolved === repo || resolved.startsWith(repo + path.sep) || (candidate && (resolved === path.resolve(candidate) || resolved.startsWith(path.resolve(candidate) + path.sep))))
        throw new Error("trusted root must be outside candidate and harness history");
    return resolved;
}
export function verifySealed(dataset: PilotDataset, sealedRoot: string) {
    privateRoot(sealedRoot);
    for (const f of dataset.fixtures)
        for (const [kind, expected] of [["grader", f.hiddenCommitment], ["holdout", f.holdoutCommitment]]) {
            if (hashTree(path.join(sealedRoot, kind, f.id)) !== expected)
                throw new Error(f.id + ": sealed " + kind + " changed");
        }
}
function materialize(f: Fixture, workspace: string) {
    fs.cpSync(path.join(fixtureRoot(f), "base"), workspace, { recursive: true, errorOnExist: true });
    fs.cpSync(path.join(fixtureRoot(f), "base/support"), path.join(workspace, "support"), { recursive: true });
    fs.copyFileSync(path.join(fixtureRoot(f), "task.md"), path.join(workspace, "task.md"));
    fs.copyFileSync(path.join(fixtureRoot(f), "public.json"), path.join(workspace, "public.json"));
    git(workspace, ["init", "--quiet"]);
    git(workspace, ["add", "."]);
    git(workspace, ["commit", "--quiet", "-m", "fixture base"]);
    if (git(workspace, ["rev-parse", "HEAD"]) !== f.baseCommit)
        throw new Error("materialized base differs");
    if(f.id==="error-row") for(const name of ["react","react-dom","scheduler"]) {
        fs.cpSync(fs.realpathSync(path.resolve("node_modules",name)),path.join(workspace,"node_modules",name),{recursive:true});
    }
}
/** Local behavioral controls never enter the real trial ledger. */
export function prepareControl(dataset:PilotDataset,caseId:string,variant:string,destination:string) {
    requireValid(dataset);
    const fixture=dataset.fixtures.find(f=>f.id===caseId);
    if(!fixture || !["correct","defective","seeded-bug"].includes(variant))throw new Error("unknown control");
    if(fs.existsSync(destination))throw new Error("control destination already exists");
    materialize(fixture,destination);
    const source=path.join(fixtureRoot(fixture),"controls",variant,"case");
    for(const file of fs.readdirSync(source))fs.copyFileSync(path.join(source,file),path.join(destination,"case",file.replace(/\.txt$/,"")));
    git(destination,["add","."]);git(destination,["commit","--quiet","--allow-empty","-m","behavioral control"]);
    return {caseId,variant,head:git(destination,["rev-parse","HEAD"])};
}
/** Root-only preparation; every arm and planner has its own clean history. */
export function prepare(dataset: PilotDataset, destination: string, sealedRoot: string) {
    requireValid(dataset);
    verifySealed(dataset, sealedRoot);
    fs.mkdirSync(destination, { recursive: true });
    privateRoot(sealedRoot, destination);
    for (const f of dataset.fixtures) {
        for (const arm of ["A", "B", "C", "planner"])
            materialize(f, path.join(destination, f.id + "-" + arm));
    }
    fs.writeFileSync(path.join(destination, "prepared.json"), JSON.stringify({ datasetHash: hash(dataset), sealedRoot: fs.realpathSync(sealedRoot) }, null, 2), { flag: "wx" });
}
export function initRun(dataset: PilotDataset, root: string, harnessHead: string): RootRun {
    requireValid(dataset);
    privateRoot(root);
    if (!COMMIT.test(harnessHead) || git(path.resolve(ROOT,"../.."),["rev-parse","HEAD"]) !== harnessHead)
        throw new Error("exact harness head required");
    const run: RootRun = { version: "role-eval.run.v1", runId: crypto.randomBytes(16).toString("hex"), datasetHash: hash(dataset), harnessHead, intents: [], receipts: [] };
    fs.writeFileSync(path.join(root, "run.json"), JSON.stringify(run, null, 2), { flag: "wx", mode: 0o600 });
    fs.writeFileSync(path.join(root, "artifact.key"), crypto.randomBytes(32), { flag: "wx", mode: 0o600 });
    return run;
}
export function readRun(root: string): RootRun { privateRoot(root); return JSON.parse(fs.readFileSync(path.join(root, "run.json"), "utf8")); }
export function writeRun(root: string, run: RootRun) { fs.writeFileSync(path.join(root, "run.next.json"), JSON.stringify(run, null, 2), { mode: 0o600 }); fs.renameSync(path.join(root, "run.next.json"), path.join(root, "run.json")); }
function withRunLock<T>(root:string,operation:()=>T):T {
    privateRoot(root);
    const lock=path.join(root,"run.lock");
    const fd=fs.openSync(lock,"wx",0o600);
    try {fs.writeFileSync(fd,String(process.pid));return operation();}
    finally {fs.closeSync(fd);fs.unlinkSync(lock);}
}
function sameRun(dataset: PilotDataset, run: RootRun) { requireValid(dataset); if (run.datasetHash !== hash(dataset))
    throw new Error("run dataset bytes changed"); if(git(path.resolve(ROOT,"../.."),["rev-parse","HEAD"])!==run.harnessHead)throw new Error("run harness head changed");
    if(!/^[a-f0-9]{32}$/.test(run.runId??""))throw new Error("run identity missing; preserve old receipts and initialize a separate run");
    if(run.intents.length!==run.receipts.length || run.intents.some(i=>!run.receipts.some(r=>r.cellId===i.cellId&&r.clientRequestId===i.clientRequestId&&r.payloadHash===i.payloadHash)))throw new Error("run contains an intent without its original receipt"); }
export function recover(prior: TrialReceipt[], receipt: TrialReceipt, intent: LaunchIntent): TrialReceipt[] {
    if(!["planned","unknown","admitted","blocked","completed"].includes(receipt.status))throw new Error("unknown receipt outcome");
    if (receipt.cellId !== intent.cellId || receipt.clientRequestId !== intent.clientRequestId || receipt.payloadHash !== intent.payloadHash || hash(intent.payload) !== intent.payloadHash)
        throw new Error("immutable launch changed");
    const old = prior.find(r => r.cellId === receipt.cellId);
    if (old && (old.clientRequestId !== receipt.clientRequestId || old.payloadHash !== receipt.payloadHash))
        throw new Error("cell already has an immutable request");
    const permitted: Record<TrialReceipt["status"], TrialReceipt["status"][]> = { planned: ["planned", "unknown", "admitted", "blocked"], unknown: ["unknown", "admitted", "blocked"], admitted: ["admitted", "completed"], completed: ["completed"], blocked: ["blocked"] };
    if (old && !permitted[old.status].includes(receipt.status))
        throw new Error("receipt outcome regression");
    for (const key of ["conversationId", "launchId", "observedModel", "candidateHead", "publishedHead"] as const)
        if (old?.[key] && old[key] !== receipt[key])
            throw new Error("receipt identity/head changed");
    if (["admitted", "completed"].includes(receipt.status) && (!receipt.conversationId || !receipt.launchId || receipt.observedModel !== intent.model.resolvedModel))
        throw new Error("actual Viewer/model identity missing");
    if (receipt.status === "completed" && (!COMMIT.test(receipt.candidateHead ?? "") || receipt.candidateHead !== receipt.publishedHead))
        throw new Error("completed head binding absent");
    return old ? prior.map(r => r.cellId === receipt.cellId ? structuredClone(receipt) : r) : [...prior, structuredClone(receipt)];
}
function readExport(root: string, relative: string, conversationId: string): ViewerExport {
    const file = artifactPath(root, relative);
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as ViewerExport;
    if (data.conversationId !== conversationId || data.hasMore!==false || data.records?.some(r=>r.truncated) || !data.records?.some(r => r.role === "assistant" && r.text && r.ts))
        throw new Error("Viewer transcript identity/evidence missing");
    return data;
}
export const briefCoverage = ["behavior", "diagnosis", "ownership", "symbols", "invariants", "edges", "files", "checks", "unknowns", "noCode"] as const;
/** Freeze the exact final planner bytes before any implementer is admitted. */
export function freezeBrief(dataset: PilotDataset, root: string, caseId: string, transcript: string) {
    const run = readRun(root);
    sameRun(dataset, run);
    if (run.intents.some(i => dataset.cells.some(c => c.id === i.cellId)))
        throw new Error("candidate exposure already started");
    const receipt = run.receipts.find(r => r.cellId === caseId + "-planner" && r.status === "completed");
    if (!receipt?.conversationId)
        throw new Error("completed root planner receipt required");
    const exported = readExport(root, transcript, receipt.conversationId);
    const text = exported.records.filter(r => r.role === "assistant")[0]!.text;
    const dir = path.join(root, "briefs", caseId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "brief.md"), text, { flag: "wx", mode: 0o600 });
    return { briefHash: hash(text), file: "briefs/" + caseId + "/brief.md" };
}
export function verifiedBrief(dataset: PilotDataset, f: Fixture, root: string): {
    text: string;
    digest: string;
} {
    const dir = path.join(root, "briefs", f.id), text = fs.readFileSync(path.join(dir, "brief.md"), "utf8"), digest = hash(text);
    const approval = JSON.parse(fs.readFileSync(path.join(dir, "approval.json"), "utf8")) as BriefApproval;
    if (approval.briefHash !== digest || approval.taskHash !== f.taskHash || approval.baseCommit !== f.baseCommit || approval.verdict !== "APPROVE" || briefCoverage.some(k => !approval.coverage[k]?.trim()))
        throw new Error("brief coverage/bytes not approved");
    const ids = [approval.planner.receipt.conversationId, approval.assessor.receipt.conversationId];
    if (!ids[0] || !ids[1] || ids[0] === ids[1])
        throw new Error("brief requires independent fresh assessor");
    for (const stage of [approval.planner, approval.assessor]) {
        const kind = stage === approval.planner ? "planner" : "brief-assessor";
        if (stage.intent.cellId !== f.id + "-" + kind || stage.intent.model.resolvedModel !== "gpt-6-astra" || stage.intent.datasetHash !== hash(dataset))
            throw new Error("brief stage provenance mismatch");
        const registered = readRun(root).intents.find(i => i.clientRequestId === stage.intent.clientRequestId);
        if (!registered || hash(registered) !== hash(stage.intent) || hash(readRun(root).receipts.find(r=>r.clientRequestId===registered.clientRequestId))!==hash(stage.receipt))
            throw new Error("planner/assessor intent not root-reserved");
        recover([], stage.receipt, stage.intent);
        if (stage.receipt.status !== "completed")
            throw new Error("brief stage unfinished");
        const transcript = readExport(root, stage.transcript, stage.receipt.conversationId!);
        if (stage === approval.planner && !transcript.records.some(r => r.role === "assistant" && r.text === text))
            throw new Error("brief bytes differ from planner output");
        if (stage === approval.assessor) {
            const final=transcript.records.find(r=>r.role==="assistant")?.text??"";
            if(reviewVerdict(final)!=="APPROVE" || !final.includes(digest))throw new Error("independent assessment not bound to brief");
        }
    }
    return { text, digest };
}
function admittedModel(models: ModelEvidence[], cell: Pick<Cell, "engine" | "launchAlias" | "requestedModel" | "requestedEffort">, root: string) {
    const m = models.find(m => m.engine === cell.engine && m.launchAlias === cell.launchAlias && m.requestedModel === cell.requestedModel && m.resolvedModel === cell.requestedModel && m.effort === cell.requestedEffort);
    if (!m || !m.runtimeVersion || !Number.isFinite(Date.parse(m.observedAt)))
        throw new Error("blocked: supported exact model evidence unavailable; no substitution");
    const discovery = JSON.parse(fs.readFileSync(artifactPath(root, m.discoveryArtifact), "utf8"));
    if (discovery.engine !== m.engine || discovery.runtimeVersion !== m.runtimeVersion || !discovery.models?.some((x: ModelEvidence) => x.launchAlias === m.launchAlias && x.resolvedModel === m.resolvedModel && x.effort === m.effort))
        throw new Error("model discovery artifact mismatch");
    return m;
}
const independent = "Use only this workspace and the supplied task. This overrides role scaffold history-search instructions: do not search transcripts, siblings, other candidates, reference solutions, hidden graders or holdouts. No production/network actions. Do not launch helpers. Implement independently.";
function planUnlocked(dataset: PilotDataset, root: string, models: ModelEvidence[], identity: {
    taskId: string;
    parentConversationId: string;
    cwd: string;
    src?: string;
}, stage?: {
    caseId: string;
    kind: "planner" | "brief-assessor" | "reviewer";
    briefFile?: string;
    candidateCellId?: string;
}) {
    const run = readRun(root);
    sameRun(dataset, run);
    if (!identity.taskId || !identity.parentConversationId || !identity.cwd)
        throw new Error("canonical Viewer identity required");
    const pending = run.receipts.find(r => ["planned", "unknown", "admitted"].includes(r.status));
    if (pending)
        return { blocked: "unresolved receipt", recovery: { ...run.intents.find(i => i.clientRequestId === pending.clientRequestId)!.payload, recoveryOnly: true } };
    // All planner outputs and assessments must precede the first candidate.
    const c = dataset.cells.slice().sort((a, b) => a.order - b.order).find(c => !run.receipts.some(r => r.cellId === c.id));
    if (!stage && !c)
        return null;
    const f = dataset.fixtures.find(f => f.id === (stage?.caseId ?? c!.caseId));
    if (!f)
        throw new Error("unknown case");
    let prompt = fs.readFileSync(path.join(fixtureRoot(f), "task.md"), "utf8") + "\n\n" + independent;
    let briefHash: string | null = null;
    const cellId = stage?.kind === "reviewer" ? stage.candidateCellId + "-reviewer" : stage ? f.id + "-" + stage.kind : c!.id;
    if (run.intents.some(i => i.cellId === cellId))
        throw new Error("stage already reserved; recover original key");
    if (stage && stage.kind !== "reviewer" && run.intents.some(i => dataset.cells.some(c => c.id === i.cellId)))
        throw new Error("planner exposure boundary already crossed");
    const model = admittedModel(models, stage ? { engine: "codex", launchAlias: "gpt-6-astra", requestedModel: "gpt-6-astra", requestedEffort: stage.kind === "planner" ? "high" : "medium" } : c!, root);
    if (stage?.kind === "planner")
        prompt += "\nProduce only a no-code brief covering " + briefCoverage.join(", ") + ". No patch, executable snippet, function body or algorithm-complete pseudocode. Read the base and support. Return the exact brief as your final message.";
    else if (stage?.kind === "reviewer") {
        const candidate = run.receipts.find(r => r.cellId === stage.candidateCellId && r.status === "completed");
        if (!candidate || !dataset.cells.some(c => c.id === stage.candidateCellId && c.caseId === f.id))
            throw new Error("completed candidate required for fresh review");
        prompt += "\\nReview this candidate as untrusted source. Required: inspect behavior and rendered pixels, verify all acceptance requirements. Return APPROVE or REQUEST_CHANGES with causal findings and exact reviewed head " + candidate.candidateHead + ". This fresh review must not inherit earlier conversations. Root supplies anonymized grading evidence separately.";
    }
    else if (stage?.kind === "brief-assessor") {
        if (!stage.briefFile)
            throw new Error("root frozen brief required");
        const brief = fs.readFileSync(artifactPath(root, stage.briefFile), "utf8");
        briefHash = hash(brief);
        prompt += "\nIndependently assess constraint coverage and absence of code handoff, including code expressed as prose. Return APPROVE or REQUEST_CHANGES, rationale for each coverage field, and brief hash " + briefHash + ".\nBrief:\n" + brief;
    }
    else {
        // Preparation is root-owned; task and support bytes must still be the pinned base.
        for (const fixture of dataset.fixtures)
            verifiedBrief(dataset, fixture, root);
        if (c!.arm === "B") {
            const brief = verifiedBrief(dataset, f, root);
            briefHash = brief.digest;
            prompt += "\nFrozen planner brief " + briefHash + ":\n" + brief.text;
        }
    }
    if (git(identity.cwd, ["rev-parse", "HEAD"]) !== (stage?.kind === "reviewer" ? run.receipts.find(r => r.cellId === stage.candidateCellId)!.candidateHead : f.baseCommit) || git(identity.cwd, ["status", "--porcelain"]))
        throw new Error("launch workspace differs from pinned base");
    const clientRequestId = "role-eval-" + hash([run.runId, run.datasetHash, run.harnessHead, cellId]).slice(0, 40);
    const role = stage?.kind === "planner" ? "architect" : stage ? "reviewer" : "builder";
    const roleParams = role === "reviewer" ? { mode: "fresh", parallelN: 1, lens: "correctness", diffSource: stage?.kind === "brief-assessor" ? "Frozen brief " + briefHash : "Committed candidate " + git(identity.cwd, ["rev-parse", "HEAD"]) } : role === "architect" ? { mode: "design" } : { mode: "plain" };
    const payload = { clientRequestId, cwd: identity.cwd, prompt, title: "Role evaluation " + cellId, taskId: identity.taskId, parentConversationId: identity.parentConversationId, ...(identity.src ? { src: identity.src } : {}), engine: model.engine, model: model.launchAlias, effort: model.effort, role, roleParams, ...(stage?.kind === "reviewer" ? { reviews: run.receipts.find(r => r.cellId === stage.candidateCellId)!.conversationId } : {}), allowSubagents: false };
    const intent: LaunchIntent = { cellId, clientRequestId, payloadHash: hash(payload), taskId: identity.taskId, parentConversationId: identity.parentConversationId, cwd: identity.cwd, prompt, model, datasetHash: run.datasetHash, harnessHead: run.harnessHead, briefHash, payload };
    run.intents.push(intent);
    run.receipts.push({ cellId, clientRequestId, payloadHash: intent.payloadHash, status: "planned" });
    writeRun(root, run);
    return { intent, payload };
}
export const plan: typeof planUnlocked = (...args) => withRunLock(args[1],()=>planUnlocked(...args));
function ingestUnlocked(dataset: PilotDataset, root: string, receipt: TrialReceipt) {
    const run = readRun(root);
    sameRun(dataset, run);
    const intent = run.intents.find(i => i.clientRequestId === receipt.clientRequestId);
    if (!intent)
        throw new Error("no root-reserved launch");
    if (receipt.conversationId && run.receipts.some(r => r.cellId !== receipt.cellId && r.conversationId === receipt.conversationId))
        throw new Error("each stage requires a fresh conversation");
    run.receipts = recover(run.receipts, receipt, intent);
    writeRun(root, run);
    return receipt;
}
export const ingest: typeof ingestUnlocked = (...args) => withRunLock(args[1],()=>ingestUnlocked(...args));
export function artifactPath(root: string, relative: string): string {
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes(".."))
        throw new Error("artifact must stay in trusted root");
    const file = path.join(root, relative), resolved = fs.realpathSync(file);
    if (!resolved.startsWith(fs.realpathSync(root) + path.sep) || fs.lstatSync(file).isSymbolicLink())
        throw new Error("artifact escaped trusted root");
    return file;
}
function sign(root: string, value: unknown): string { return crypto.createHmac("sha256", fs.readFileSync(path.join(root, "artifact.key"))).update(JSON.stringify(value)).digest("hex"); }
/** Root exports committed bytes; graders never execute from the mutable candidate checkout. */
export function grade(dataset: PilotDataset, root: string, sealedRoot: string, cellId: string, workspace: string) {
    requireValid(dataset);
    privateRoot(root, workspace);
    verifySealed(dataset, sealedRoot);
    const run = readRun(root);
    sameRun(dataset, run);
    const receipt = run.receipts.find(r => r.cellId === cellId), cell = dataset.cells.find(c => c.id === cellId), intent = run.intents.find(i => i.cellId === cellId);
    if (!receipt || !cell || !intent || receipt.status !== "completed")
        throw new Error("completed root receipt required");
    const f = dataset.fixtures.find(f => f.id === cell.caseId)!;
    if (git(workspace, ["rev-parse", "HEAD"]) !== receipt.candidateHead || git(workspace, ["status", "--porcelain"]))
        throw new Error("candidate head/working bytes changed");
    const changed = git(workspace, ["diff", "--name-only", f.baseCommit, receipt.candidateHead!]).split("\n").filter(Boolean);
    if (changed.some(file => !f.candidateFiles.includes(file)))
        throw new Error("forbidden-file change");
    const out = path.join(root, "grades", cellId, receipt.candidateHead!);
    fs.mkdirSync(out, { recursive: true });
    const exported = path.join(out, "candidate");
    fs.mkdirSync(exported);
    if (git(workspace, ["ls-tree", "-r", receipt.candidateHead!]).split("\n").some(line => !line.startsWith("100644 ") && !line.startsWith("100755 ")))
        throw new Error("candidate contains symlinks/submodules");
    const archive = execFileSync("git", ["archive", receipt.candidateHead!], { cwd: workspace });
    execFileSync("tar", ["-x", "-C", exported], { input: archive });
    const candidateTree = hashTree(exported);
    const checks: {
        name: string;
        exitCode: number;
    }[] = [];
    const invoke = (name: string, argv: string[], extra: Record<string, string> = {}) => {
        const result = spawnSync(process.execPath, argv, { cwd: path.resolve(ROOT, "../.."), env: { ...process.env, ...extra }, encoding: "utf8", timeout: 240000 });
        fs.writeFileSync(path.join(out, name + ".log"), (result.stdout ?? "") + (result.stderr ?? "") + (result.error?.message ?? ""));
        checks.push({ name, exitCode: result.status ?? 1 });
    };
    if (f.id === "error-row") {
        fs.symlinkSync(path.resolve("node_modules"), path.join(exported, "node_modules"), "dir");
        try {
            invoke("rendered", ["test", "src/components/kanban/kanbanBoard.browser.test.tsx", "-t", "role evaluation mounted candidate"], { LLV_KANBAN_BROWSER_TEST: "1", ROLE_EVAL_CANDIDATE: exported, ROLE_EVAL_OUTPUT: path.join(out, "rendered") });
            invoke("hidden", [path.join(sealedRoot, "grader", f.id, "run.ts"), exported], { ROLE_EVAL_HARNESS: path.resolve(ROOT, "../.."), ROLE_EVAL_HIDDEN_OUTPUT: path.join(out, "hidden-rendered") });
        }
        finally {
            fs.unlinkSync(path.join(exported, "node_modules"));
        }
    }
    else {
        invoke("public", [path.join(ROOT, "graders/behavior.ts"), f.id, exported, path.join(fixtureRoot(f), "public.json")]);
        invoke("hidden", [path.join(sealedRoot, "grader", f.id, "run.ts"), exported], { ROLE_EVAL_HARNESS: path.resolve(ROOT, "../..") });
    }
    // Private runner receives only this export, with package integrity verified above.
    const artifacts: Record<string, string> = {};
    for (const file of files(out).filter(x => !x.startsWith("candidate/") && x !== "grade.json"))
        artifacts[file] = hashFile(path.join(out, file));
    const environment = { bun: Bun.version, executableHash: hashFile(fs.realpathSync(process.execPath)), dependencyHash: hashFile(path.resolve(ROOT, "../../bun.lock")), packageHash: hashFile(path.resolve(ROOT, "../../package.json")), roleRegistryHash: hashFile(path.resolve(ROOT, "../../src/lib/roles/registry.ts")) };
    const unsigned = { version: "role-eval.grade.v1" as const, cellId, datasetHash: hash(dataset), harnessHead: run.harnessHead, candidateHead: receipt.candidateHead!, candidateTree, fixtureHash: hash(f), graderHash: dataset.graderHash, files: artifacts, checks, environment };
    const artifact: GradeArtifact = { ...unsigned, signature: sign(root, unsigned) };
    fs.writeFileSync(path.join(out, "grade.json"), JSON.stringify(artifact, null, 2), { flag: "wx" });
    return artifact;
}
export function score(dataset: PilotDataset, root: string, cellId: string): Score {
    const reasons: string[] = [];
    try {
        const run = readRun(root);
        sameRun(dataset, run);
        const receipt = run.receipts.find(r => r.cellId === cellId), cell = dataset.cells.find(c => c.id === cellId), intent = run.intents.find(i => i.cellId === cellId);
        if (!cell || !intent || !receipt)
            return { cellId, verdict: "incomplete", reasons: ["trial not reserved"] };
        if (receipt.status !== "completed")
            return { cellId, verdict: receipt.status === "blocked" ? "blocked" : "incomplete", reasons: ["trial " + receipt.status] };
        recover([], receipt, intent);
        const f = dataset.fixtures.find(f => f.id === cell.caseId)!;
        if (git(intent.cwd, ["rev-parse", "HEAD"]) !== receipt.candidateHead || git(intent.cwd, ["status", "--porcelain"]))
            throw new Error("candidate changed after grading/review");
        const directory = path.join(root, "grades", cellId, receipt.candidateHead!);
        const artifact: GradeArtifact = JSON.parse(fs.readFileSync(path.join(directory, "grade.json"), "utf8"));
        const { signature, ...unsigned } = artifact;
        if (signature !== sign(root, unsigned))
            throw new Error("untrusted/fabricated grading artifact");
        if (artifact.candidateHead !== receipt.candidateHead || artifact.datasetHash !== hash(dataset) || artifact.harnessHead !== run.harnessHead || artifact.fixtureHash !== hash(f) || artifact.graderHash !== dataset.graderHash)
            throw new Error("stale grading binding");
        if (hashTree(path.join(directory, "candidate")) !== artifact.candidateTree)
            throw new Error("graded candidate bytes changed");
        for (const [file, digest] of Object.entries(artifact.files))
            if (hashFile(artifactPath(root, path.relative(root, path.join(directory, file)))) !== digest)
                throw new Error("artifact bytes changed");
        if (artifact.checks.some(c => c.exitCode !== 0) || !["hidden", f.id === "error-row" ? "rendered" : "public"].every(name => artifact.checks.some(c => c.name === name && c.exitCode === 0)))
            reasons.push("behavioral grader failed/missing");
        const approval = JSON.parse(fs.readFileSync(path.join(root, "reviews", cellId + ".json"), "utf8")) as ReviewApproval;
        const reviewer = approval.reviewerReceipt;
        const reservedReviewer = run.intents.find(i => i.cellId === cellId + "-reviewer");
        if (!reservedReviewer || hash(reservedReviewer) !== hash(approval.reviewerIntent) || hash(run.receipts.find(r => r.cellId === reservedReviewer.cellId)) !== hash(reviewer))
            throw new Error("reviewer not reserved/observed through root run");
        recover([], reviewer, approval.reviewerIntent);
        if (approval.reviewedHead !== receipt.candidateHead || approval.verdict !== "APPROVE" || reviewer.status !== "completed" || reviewer.conversationId === receipt.conversationId || reviewer.candidateHead !== receipt.candidateHead)
            reasons.push("independent final-head approval missing");
        const transcript = readExport(root, approval.transcript, reviewer.conversationId!);
        const final = transcript.records.filter(r => r.role === "assistant")[0]?.text ?? "";
        if (reviewVerdict(final) !== "APPROVE" || !final.includes(receipt.candidateHead!))
            reasons.push("Viewer final review does not approve this head");
        const audit = readExport(root, approval.audit.transcript, receipt.conversationId!);
        if (!audit.records.some(r=>r.kind==="tool_call") || !approval.audit.rationale || approval.audit.violations.length)
            reasons.push("forbidden-action audit missing/failed");
        if (f.requiresRenderedEvidence) {
            const images = Object.keys(artifact.files).filter(f => f.endsWith(".png"));
            if (images.length !== 72 || images.some(file => !approval.inspectedImages.includes(artifact.files[file])))
                reasons.push("required pixels not independently inspected");
        }
        if (cell.arm === "B" && verifiedBrief(dataset, f, root).digest !== intent.briefHash)
            reasons.push("brief changed after launch");
    }
    catch (e) {
        reasons.push(e instanceof Error ? e.message : String(e));
    }
    return { cellId, verdict: reasons.length ? "fail" : "pass", reasons };
}
