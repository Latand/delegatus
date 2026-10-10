import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentLivenessSources } from "@/lib/lifecycle/liveness";
import type { AgentRegistryEntry, RegistryFile } from "@/lib/agent/registry";
import type { FileEntry } from "@/lib/types";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-read-paths-"));
process.env.LLV_STATE_DIR = path.join(root, "state");
process.env.XDG_CONFIG_HOME = path.join(root, "config");
const { saveTasks } = await import("@/lib/tasks/store");
const { savePipelines, buildPipeline } = await import("@/lib/pipelines/store");
const { createCompanionBoardReadPaths } = await import("./readPaths");
const { CompanionBoardReads } = await import("./boardReads");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

test("ordinary pipeline reads retain the cursor verdict and stage kinds and roles without history", async () => {
  const { pipelineCorpus, CORPUS_BODY_MARKERS } = await import("@/lib/pipelines/fixtures/corpus");
  const pipeline = pipelineCorpus(1)[0];
  pipeline.state = "running"; pipeline.closedAt = null;
  pipeline.cursor = { stageId: "review", state: "reviewing", input: null, activatedBy: null };
  pipeline.runs[1].attempts.at(-1)!.verdict = { status: "fail", findings: ["P1 — Missing ownership fence"] };
  savePipelines([pipeline]);
  const reads = new CompanionBoardReads(createCompanionBoardReadPaths());
  const list = await reads.call(pipeline.project, "list_pipelines", { state: ["open"] });
  expect(list).toMatchObject({ total: 1, rows: [{ stage: "review", verdict: "fail" }] });
  const detail = await reads.call(pipeline.project, "get_pipeline", { pipelineId: pipeline.id });
  expect(detail).toMatchObject({ item: { stages: [
    { title: "build", kind: "run", role: "builder", verdict: "pass" },
    { title: "review", kind: "review-loop", role: "reviewer", verdict: "fail" },
  ] } });
  expect(Buffer.byteLength(JSON.stringify(detail))).toBeLessThanOrEqual(4000);
  for (const marker of Object.values(CORPUS_BODY_MARKERS)) expect(JSON.stringify(detail)).not.toContain(marker);
});

test("a historical lineage attempt does not replace the operational stage state", async () => {
  const { pipelineCorpus } = await import("@/lib/pipelines/fixtures/corpus");
  const pipeline = pipelineCorpus(1)[0];
  const run = pipeline.runs[0];
  run.attempts.push({ ...run.attempts.at(-1)!, n: 7, historical: true, state: "failed" });
  savePipelines([pipeline]);
  const reads = new CompanionBoardReads(createCompanionBoardReadPaths());
  const result = await reads.call(pipeline.project, "get_pipeline", { pipelineId: pipeline.id });
  expect(result.item).toMatchObject({ stages: [{ state: "passed" }, { state: "passed" }] });
  const stage = await reads.call(pipeline.project, "get_pipeline", { pipelineId: pipeline.id, stageId: "build" });
  expect(stage.item).toMatchObject({ title: pipeline.task, stageId: "build", stageDetail: { kind: "run", role: "builder", state: "passed" }, verdict: "pass" });
  expect(stage.speech).toContain("build: passed");
  pipeline.runs[1].attempts.at(-1)!.verdict = { status: "fail", findings: ["P1 — Missing ownership fence", "P2 — Missing error receipt"] };
  savePipelines([pipeline]);
  expect(await reads.call(pipeline.project, "get_pipeline", { pipelineId: pipeline.id, stageId: "review" })).toMatchObject({ item: {
    verdict: "fail", findings: ["P1 — Missing ownership fence", "P2 — Missing error receipt"] } });
  expect(await reads.call(pipeline.project, "list_pipelines", {})).toMatchObject({ total: 0 });
  expect(await reads.call(pipeline.project, "list_pipelines", { state: ["closed"], includeClosed: true })).toMatchObject({ total: 1, rows: [{ handle: pipeline.id, state: "closed" }] });
});

test("the six voice reads use task/pipeline persistence, liveness projection, and bounded transcript parsing", async () => {
  const now = Date.parse("2026-10-06T12:00:00Z");
  const at = new Date(now).toISOString();
  saveTasks(["project-a", "project-b"].map(project => ({ id: `task-${project}`, project, text: project === "project-a" ? "Review export" : "Foreign task",
    status: "blocked", placement: "unplaced", assignments: [], createdAt: at, updatedAt: at,
    note: { text: "Waiting for review", updatedAt: at, author: { kind: "operator" } },
    hold: { kind: "worker", note: "Reviewer must finish", since: at, by: "operator" }, steps: [{ id: "step", text: "Read the plan", state: "open" }] })));
  savePipelines(["project-a", "project-b"].map(project => buildPipeline({ id: `pipeline-${project}`, task: project === "project-a" ? "Review export pipeline" : "Foreign pipeline",
    project, repoDir: root, srcPath: null, srcConversationId: null, now: at, stages: [{ id: "review", kind: "run", prompt: "Review", next: null,
      effectiveRole: { roleId: null, engine: "claude", model: null, effort: null, access: "read-only", promptScaffold: null } }] })));
  const transcriptPath = path.join(root, "agent.jsonl");
  fs.writeFileSync(transcriptPath, Array.from({ length: 8 }, (_, index) => JSON.stringify({ type: "assistant", uuid: `message-${index}`, timestamp: at,
    message: { role: "assistant", content: [{ type: "text", text: `Reply ${index} ${"x".repeat(500)}` }] } })).join("\n") + "\n");
  const entry: AgentRegistryEntry = { key: { engine: "claude", sessionId: "fixture-agent" }, artifactPath: transcriptPath, cwd: root, accountId: null,
    status: "live", host: null, claimEpoch: 1, claimOwner: null, pendingAction: null, updatedAt: at,
    structuredHost: { kind: "claude-broker", endpoint: "fixture", process: { pid: 4242, startIdentity: "fixture-process" }, eventCursor: 0,
      protocolVersion: null, writerClaimEpoch: 1, activeTurnRef: null, pendingAttention: [], activeFlags: [] } };
  const liveness: AgentLivenessSources = {
    now: () => now, probe: { now: () => now, pidAlive: () => true, processIdentity: () => "fixture-process" },
    listFiles: async () => [{ path: transcriptPath, project: "project-a", title: "Export reviewer", engine: "claude", root: "claude-projects", kind: "session",
      conversationId: "conversation_fixture", mtime: now / 1_000, size: fs.statSync(transcriptPath).size, activity: "live" } as FileEntry],
    describeTranscript: async () => null,
    registrySnapshot: () => ({ entries: { fixture: entry }, conversations: {} } as unknown as RegistryFile),
    pipelines: () => [], transcriptEvidence: async () => ({ turn: "busy", lastRecordTs: now }),
  };
  let opened = 0;
  const paths = createCompanionBoardReadPaths({ liveness, transcript: {
    selectedContext: { selectedConversation: () => ({ resolve: id => id === "conversation_fixture" ? { conversationId: id, engine: "claude", path: transcriptPath, project: "project-a" } : null,
      readTail: () => null }), pathAllowed: candidate => candidate === transcriptPath },
    pinnedTranscript: candidate => {
      expect(candidate).toBe(transcriptPath);
      opened++;
      const descriptor = fs.openSync(candidate, "r");
      return { descriptor, stat: fs.fstatSync(descriptor), rootName: "claude-projects", root, sameIdentity: () => true };
    },
  } });
  const reads = new CompanionBoardReads(paths);
  expect(await reads.call("project-a", "list_tasks", {})).toMatchObject({ total: 1, rows: [{ title: "Review export" }] });
  expect(await reads.call("project-a", "get_task", { taskId: "task-project-a" })).toMatchObject({ item: { note: "Waiting for review", hold: "Reviewer must finish", steps: [{ text: "Read the plan" }] } });
  expect(await reads.call("project-a", "list_pipelines", {})).toMatchObject({ total: 1, rows: [{ title: "Review export pipeline" }] });
  expect(await reads.call("project-a", "get_pipeline", { pipelineId: "pipeline-project-a" })).toMatchObject({ item: { stages: [{ state: "pending" }] } });
  expect(await reads.call("project-a", "agent_activity", {})).toMatchObject({ total: 1, rows: [{ state: "running", title: "Export reviewer" }] });
  const tail = await reads.call("project-a", "conversation_messages", { conversationId: "conversation_fixture", limit:4 });
  expect(tail.rows).toHaveLength(4);
  expect(JSON.stringify(tail)).toContain("Reply 7");
  expect(JSON.stringify(tail)).not.toContain("Reply 0");
  expect(tail.speech.length).toBeLessThanOrEqual(1_600);
  expect(opened).toBe(1);
  await expect(reads.call("project-a", "get_task", { taskId: "task-project-b" })).rejects.toThrow("PROJECT_REFUSED");
  await expect(reads.call("project-a", "get_pipeline", { pipelineId: "pipeline-project-b" })).rejects.toThrow("PROJECT_REFUSED");
  await expect(reads.call("project-a", "conversation_messages", { conversationId: "conversation_foreign" })).rejects.toThrow("PROJECT_REFUSED");
  await expect(reads.call("project-a", "send_message", {})).rejects.toThrow("TOOL_NOT_ALLOWED");
  expect(opened).toBe(1);
});

test("search stays project scoped and its opaque conversation handle can read an inactive transcript", async () => {
  const { indexTranscriptSources } = await import("@/lib/search/transcriptSearch");
  const at = "2026-10-10T12:00:00.000Z";
  const sources = ["search-a", "search-b"].map(project => {
    const filename = path.join(root, `${project}.jsonl`);
    fs.writeFileSync(filename, JSON.stringify({ type: "assistant", uuid: project, timestamp: at,
      message: { role: "assistant", content: [{ type: "text", text: `The cobalt release belongs to ${project}.` }] } }) + "\n");
    const stat = fs.statSync(filename);
    return { path: filename, project, engine: "claude" as const, size: stat.size, mtimeMs: stat.mtimeMs };
  });
  await indexTranscriptSources(sources, { complete: true });
  const reads = new CompanionBoardReads(createCompanionBoardReadPaths({ transcript: {
    selectedContext: { selectedConversation: () => ({ resolve: () => null, readTail: () => null }),
      pathAllowed: candidate => sources.some(source => source.path === candidate) },
    pinnedTranscript: candidate => {
      if (!sources.some(source => source.path === candidate)) return undefined;
      const descriptor = fs.openSync(candidate, "r");
      return { descriptor, stat: fs.fstatSync(descriptor), rootName: "claude-projects", root, sameIdentity: () => true };
    },
  } }));
  const result = await reads.call("search-a", "search_transcripts", { query: "cobalt", order: "newest" });
  expect(result).toMatchObject({ total: 1, shown: 1 });
  const handle = (result.rows![0] as { handle: string }).handle;
  expect(handle).toMatch(/^voice_transcript_[a-f0-9]+$/);
  expect(JSON.stringify(result)).not.toContain(root);
  expect(JSON.stringify(result)).not.toContain("search-b");
  expect(await reads.call("search-a", "conversation_messages", { conversationId: handle })).toMatchObject({ rows: [{ excerpt: "The cobalt release belongs to search-a." }] });
  await expect(reads.call("search-b", "conversation_messages", { conversationId: handle })).rejects.toThrow("PROJECT_REFUSED");
  await expect(reads.call("unknown", "search_transcripts", { query: "cobalt" })).rejects.toThrow("PROJECT_REFUSED");
});

test("a path in a stored note or hold reaches neither the structured read nor its speech", async () => {
  const at = "2026-10-06T12:00:00.000Z";
  const home = ["", "home", "fixture-operator", ".config", "delegatus"].join("/");
  saveTasks([{ id: "task-path", project: "project-a", text: "Review export", status: "blocked", placement: "unplaced", assignments: [], createdAt: at, updatedAt: at,
    note: { text: `State is in ${home}/state now`, updatedAt: at, author: { kind: "operator" } },
    hold: { kind: "worker", note: `Waiting on ${home}/accounts`, since: at, by: "operator" }, steps: [] }]);
  const result = await new CompanionBoardReads(createCompanionBoardReadPaths()).call("project-a", "get_task", { taskId: "task-path" });
  expect(JSON.stringify(result)).not.toContain("fixture-operator");
  expect(result.item).toMatchObject({ note: "State is in [path] now", hold: "Waiting on [path]" });
  expect(result.speech).toContain("State is in [path] now");
});


test("open work is answered by two real filtered reads and paged without finished history", async () => {
  const at = "2026-10-10T12:00:00.000Z";
  const tasks = Array.from({length: 303}, (_, i) => ({id: `task-${i}`, project: "fixture", text: `Work ${i}`, status: i < 300 ? "done" as const : ["inbox", "assigned", "blocked"][i-300] as "inbox" | "assigned" | "blocked", placement: "unplaced" as const, assignments: [], createdAt: at, updatedAt: at}));
  saveTasks(tasks);
  const pipelines = Array.from({length: 123}, (_, i) => ({...buildPipeline({id: `lane-${i}`, task: `Lane ${i}`, project: "fixture", repoDir: root, srcPath: null, srcConversationId: null, now: at, stages: [{id: "build", kind: "run" as const, prompt: "Build", next: null, effectiveRole: {roleId: null, engine: "claude" as const, model: null, effort: null, access: "read-only" as const, promptScaffold: null}}]}), ...(i < 120 ? {cursor: null} : {}), state: i < 120 ? "completed" as const : ["running", "needs_review", "needs_decision"][i-120] as "running" | "needs_review" | "needs_decision"}));
  savePipelines(pipelines);
  const reads = new CompanionBoardReads(createCompanionBoardReadPaths());
  const work = await reads.call("fixture", "list_tasks", {openOnly: true});
  const lanes = await reads.call("fixture", "list_pipelines", {state: ["open"]});
  expect(work).toMatchObject({total: 3, shown: 3, more: 0, nextCursor: null});
  expect(lanes).toMatchObject({total: 3, shown: 3, more: 0, nextCursor: null});
  for (const result of [work, lanes]) {expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(4000); expect(JSON.stringify(result)).not.toContain('"done"');expect(JSON.stringify(result)).not.toContain('"completed"');}
  const page = await reads.call("fixture", "list_tasks", {openOnly: true, limit: 2});
  expect(page).toMatchObject({total: 3, shown: 2, more: 1});
  const nextCursor = (page as unknown as {nextCursor:string}).nextCursor;
  const next = await reads.call("fixture", "list_tasks", {openOnly: true, limit: 2, cursor: nextCursor});
  expect(next).toMatchObject({total:3,shown:1,more:0});
});

test("one prototype read retains every choice and exact decision, and frame reads use only stored pinned copies", async () => {
  const { createHash } = await import("node:crypto");
  const { prototypeRoot, storedMediaPath } = await import("@/lib/prototypeReview/store");
  const { loadTasksForList } = await import("@/lib/tasks/store");
  const { questions } = await import("@/lib/prototypeReview/questionnaire.fixture");
  const { VOICE_IMAGES } = await import("./boardReads");
  const at = "2026-10-10T12:00:00.000Z";
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
  const media = {id:createHash("sha256").update(bytes).digest("hex"),mime:"image/png" as const,bytes:bytes.length};
  const reviewId = `pr_${"a".repeat(32)}`;
  const original = {id:createHash("sha256").update(Buffer.concat([bytes,Buffer.from("original")])).digest("hex"),mime:"image/png" as const,bytes:bytes.length+8};
  const round = {id:reviewId,taskId:"task-review",project:"fixture",title:"Review the prototype",createdAt:at,source:{conversationId:null},publicationKey:"fixture-publication",inputDigest:"b".repeat(64),questions,
    variants:[{number:1,name:"Header line",description:"Keep the costs beside the transcript title.",frames:[{caption:"Desktop",width:1440,lang:"en" as const,image:media,original}],videos:[]},{number:2,name:"Footer meter",description:"Show a meter at the foot of the panel.",frames:[{caption:"Phone",width:390,lang:"uk" as const,image:media}],videos:[]}],
    decision:{chosen:[1],answers:[{questionId:"place",options:[0]},{questionId:"scope",options:[0,1]},{questionId:"timing",options:[],other:true as const}],comment:"Keep both descriptions. Start after review.",at,delivery:{state:"sent" as const,clientMessageId:"fixture-choice",conversationId:null,text:"Internal delivery must stay private."}}};
  saveTasks([{id:round.taskId,project:"fixture",text:"Prototype task",status:"blocked",placement:"unplaced",assignments:[],createdAt:at,updatedAt:at,prototypeReviews:[round]}]);
  fs.mkdirSync(path.join(prototypeRoot(),reviewId),{recursive:true});
  const filename = storedMediaPath(fs.realpathSync(prototypeRoot()),reviewId,media);
  fs.writeFileSync(filename,bytes);
  fs.writeFileSync(storedMediaPath(fs.realpathSync(prototypeRoot()),reviewId,original),Buffer.concat([bytes,Buffer.from("original")]));
  const reads = new CompanionBoardReads(createCompanionBoardReadPaths());
  const before = JSON.stringify(loadTasksForList());
  const review = await reads.call("fixture","read_prototype_review",{taskId:round.taskId});
  expect(review.item).toMatchObject({rounds:[{variants:[{number:1,name:"Header line",description:round.variants[0].description},{number:2,name:"Footer meter",description:round.variants[1].description}],questions,decision:{chosen:[1],answers:round.decision.answers,comment:round.decision.comment}}]});
  expect(JSON.stringify(review)).not.toContain(round.decision.delivery.text);
  const frame = await reads.call("fixture","view_prototype_frame",{taskId:round.taskId,reviewId,mediaId:media.id});
  expect(Reflect.get(frame, VOICE_IMAGES)).toEqual([{mime:"image/png",data:bytes.toString("base64")}]);
  expect(JSON.stringify(frame)).not.toContain(bytes.toString("base64"));
  expect(JSON.stringify(loadTasksForList())).toBe(before);
  await expect(reads.call("foreign","read_prototype_review",{taskId:round.taskId})).rejects.toThrow("PROJECT_REFUSED");
  await expect(reads.call("fixture","view_prototype_frame",{taskId:round.taskId,reviewId,mediaId:"f".repeat(64)})).rejects.toThrow("FRAME_UNAVAILABLE");
  // A copied frame replaced by a link no longer names stored prototype bytes.
  const outside = path.join(root,"outside.png");fs.writeFileSync(outside,bytes);fs.unlinkSync(filename);fs.symlinkSync(outside,filename);
  await expect(reads.call("fixture","view_prototype_frame",{taskId:round.taskId,reviewId,mediaId:media.id})).rejects.toThrow("FRAME_UNAVAILABLE");
});

test("project names resolve from the real catalog and ambiguity never widens a voice read", async () => {
  const { replaceConversationCatalog } = await import("@/lib/scanner/conversationCatalog");
  const catalog = (project:string,projectName:string) => ({path:path.join(root,`${project}.jsonl`),root:"claude-projects" as const,name:"fixture",project,projectName,title:"Fixture",firstPrompt:"",engine:"claude" as const,kind:"session",fmt:"claude" as const,mtime:0,size:0});
  replaceConversationCatalog([catalog("project-a","Alpha"),catalog("project-b","Beta")]);
  const reads = new CompanionBoardReads(createCompanionBoardReadPaths());
  expect(reads.resolveProject("project-a","Beta")).toBe("project-b");
  expect(reads.resolveProject(null,"Alpha")).toBe("project-a");
  expect(()=>reads.resolveProject(null)).toThrow("PROJECT_REQUIRED");
  expect(()=>reads.resolveProject("project-a","Unknown")).toThrow("PROJECT_REFUSED");
  replaceConversationCatalog([catalog("project-a","Duplicate"),catalog("project-b","Duplicate")]);
  expect(()=>reads.resolveProject("project-a","Duplicate")).toThrow("PROJECT_AMBIGUOUS");
  replaceConversationCatalog([]);
});


test("activity pages retain every observed agent and disclose pending evidence without claiming a complete total", async () => {
  const { selectConversationEntries } = await import("@/lib/lifecycle/inventorySelection");
  const now = Date.parse("2026-10-10T12:00:00Z");
  const at = new Date(now).toISOString();
  const files = Array.from({ length: 12 }, (_, index) => {
    const filename = path.join(root, `live-${index}.jsonl`);
    fs.writeFileSync(filename, "{}\n");
    return { path: filename, project: "activity", title: `Agent ${index}`, engine: "claude", root: "claude-projects", kind: "session",
      conversationId: `conversation_live_${index}`, mtime: now / 1_000, size: 3, activity: "live" } as FileEntry;
  });
  const entries = Object.fromEntries(files.map((file, index) => [String(index), {
    key: { engine: "claude", sessionId: `fixture-live-${index}` }, artifactPath: file.path, cwd: root, accountId: null,
    status: "live", host: null, claimEpoch: 1, claimOwner: null, pendingAction: null, updatedAt: at,
    structuredHost: { kind: "claude-broker", endpoint: "fixture", process: { pid: 4242, startIdentity: "fixture-process" }, eventCursor: 0,
      protocolVersion: null, writerClaimEpoch: 1, activeTurnRef: null, pendingAttention: [], activeFlags: [] },
  } as AgentRegistryEntry]));
  let pending = false;
  const liveness: AgentLivenessSources = {
    now: () => now, probe: { now: () => now, pidAlive: () => true, processIdentity: () => "fixture-process" },
    listFiles: async () => files, describeTranscript: async () => null,
    selectInventory: async request => ({ ...selectConversationEntries(files, request), generation: 1, cacheStatus: pending ? "stale" : "hit", freshScan: false, selectionMs: 0 }),
    registrySnapshot: () => ({ entries, conversations: {} } as unknown as RegistryFile), pipelines: () => [],
    transcriptEvidence: async () => pending ? null : { turn: "busy", lastRecordTs: now },
  };
  const reads = new CompanionBoardReads(createCompanionBoardReadPaths({ liveness }));
  const first = await reads.call("activity", "agent_activity", { liveOnly: true });
  expect(first).toMatchObject({ total: 12, shown: 10, more: 2, truncated: true });
  expect(first.nextCursor).toBeString();
  const second = await reads.call("activity", "agent_activity", { liveOnly: true, cursor: first.nextCursor });
  expect(second).toMatchObject({ total: 12, shown: 2, more: 0 });
  expect(new Set([...first.rows!, ...second.rows!].map(row => (row as { handle: string }).handle)).size).toBe(12);
  await expect(reads.call("foreign", "agent_activity", { liveOnly: true, cursor: first.nextCursor })).rejects.toThrow("filters changed");
  pending = true;
  const degraded = await reads.call("activity", "agent_activity", { liveOnly: true });
  expect(degraded).toMatchObject({ truncated: true, coverage: { catalog: "stale" } });
  expect(degraded.speech).toContain("counts are partial");
  for (const page of [first, second, degraded]) expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(4000);
});


test("pipeline titles are masked before the shared compact cutoff and newline split without changing selection", async () => {
  const key = ["Zr9QvB","pipeline","private","0123456789abcdef"].join("-");
  const at = "2026-10-10T12:00:00.000Z";
  const pipelines = ["clip","newline"].map((boundary,index) => ({...buildPipeline({id:`lane-boundary-${index}`,task:"x".repeat(114)+(boundary === "clip" ? key : key.slice(0,6)+"\n"+key.slice(6))+" tail",project:"mask-pipeline",repoDir:root,srcPath:null,srcConversationId:null,now:at,
    stages:[{id:"build",kind:"run" as const,prompt:"Build",next:null,effectiveRole:{roleId:null,engine:"claude" as const,model:null,effort:null,access:"read-only" as const,promptScaffold:null}}]}),state:"running" as const}));
  savePipelines(pipelines);
  const reads = new CompanionBoardReads(createCompanionBoardReadPaths());
  const args = reads.normalize("mask-pipeline","list_pipelines",{state:["open"],query:"tail",ids:pipelines.map(row=>row.id),limit:1});
  const first = await reads.read("mask-pipeline","list_pipelines",args,[key]);
  const cursor = first.nextCursor;
  expect(typeof cursor).toBe("string");
  expect(first).toMatchObject({total:2,shown:1,more:1});
  const next = await reads.read("mask-pipeline","list_pipelines",{...args,cursor},[key]);
  expect(next).toMatchObject({total:2,shown:1,more:0});
  for (const result of [first,next,...await Promise.all(pipelines.map(row=>reads.read("mask-pipeline","get_pipeline",{project:"mask-pipeline",pipelineId:row.id},[key])))]) {
    expect(JSON.stringify(result)).not.toContain(key.slice(0,6));
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(4000);
  }
});
