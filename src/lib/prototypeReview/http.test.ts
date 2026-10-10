import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { saveTasks, loadTasks } from "@/lib/tasks/store";
import { publishPOST, reviewGET, reviewPOST, reviewReadPOST } from "./http";
import { viewerMcpBindings } from "@/lib/mcp/bindings";
import { VIEWER_SPAWN_CAPABILITY_ENV, VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import { GET as imageGET } from "@/app/api/image/route";
import { prototypeMediaGET } from "./media";
import { PROTOTYPE_LIMITS } from "./input";
import { prototypeReviewNotices, prototypeReviewSummary, readPrototypeReviews, withPrototypeReviewSummaries } from "./read";
import { prototypeReviewReplica } from "./model";
import { isPrototypeReplica } from "./replica";
import { encodeTask, decodeWireRow, isWireTask } from "@/lib/links/taskWire";
import { injectStateWriteFaultForTests } from "@/lib/state/sqliteStateStore";
import { roundDirectory, roundMedia } from "./store";
import { buildPipeline, savePipelines } from "@/lib/pipelines/store";
import { prototypeWorld } from "./world";
import { GET as tasksGET } from "@/app/api/tasks/route";
import { PATCH as taskPATCH } from "@/app/api/tasks/[id]/route";
import { DELETE as assignmentDELETE, PATCH as assignmentPATCH } from "@/app/api/tasks/[id]/assignment/route";
import { taskAcknowledgement } from "@/lib/mcp/listAnswers";
import type { PrototypeWorld } from "./world";
import type { PublishPrototypeInput, PrototypeReviewRead } from "./types";
import { MCP_TOOL_NAMES, TOOL_INPUT_SCHEMAS, createMcpToolService, MemoryMcpReceiptStore } from "@/lib/mcp/server";

import { questions } from "./questionnaire.fixture";

const roots: string[] = [];
const PNG = Buffer.from([137,80,78,71,13,10,26,10]);
const MP4 = Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from("ftypisom"),Buffer.alloc(12)]);
const WEBM = Buffer.concat([Buffer.from([0x1a,0x45,0xdf,0xa3,0x42,0x82,0x84]),Buffer.from("webm")]);
beforeEach(() => saveTasks([task()]));
function task() { return { id: "task-prototype", project: "project-a", status: "inbox" as const, placement: "unplaced" as const, text: "Review layout", assignments: [], sources: [], createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" }; }
afterEach(async () => { injectStateWriteFaultForTests(null); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
function request(url: string, body?: unknown) {
  return new NextRequest(`http://localhost${url}`, { headers: { host: "localhost", "sec-fetch-site": "same-origin" }, ...(body ? { method: "POST", body: JSON.stringify(body) } : {}) });
}
async function source() { const root = await fs.mkdtemp(path.join(process.env.HOME!, "prototype-source-")); roots.push(root); return root; }
async function fullInput(key = "full"): Promise<PublishPrototypeInput & { variants: NonNullable<PublishPrototypeInput["variants"]> }> {
  const root = await source();
  await fs.writeFile(path.join(root,"new.png"),PNG); await fs.writeFile(path.join(root,"original.png"),Buffer.concat([PNG,Buffer.from("original")]));
  await fs.writeFile(path.join(root,"clip.mp4"),MP4); await fs.writeFile(path.join(root,"clip.webm"),WEBM);
  return { clientRequestId: key, taskId: "task-prototype", title: "Review layout", variants: [
    { number: 1, name: "Compact", description: "Keeps the controls together.", frames: [{ path: path.join(root,"new.png"), originalPath: path.join(root,"original.png"),caption: "Changed controls" }],videos: [{ path: path.join(root,"clip.mp4"),caption: "Transition" },{ path: path.join(root,"clip.webm"),caption: "Scroll" }] },
    { number: 2,name: "Roomy",description: "Leaves space around the controls.",frames: [{ path: path.join(root,"new.png"),caption: "New layout" }] },
  ] };
}
async function publish(input: PublishPrototypeInput,world?: PrototypeWorld) { const response = await publishPOST(request("/api/prototype-reviews",input),world); expect(response.status).toBe(200); return (await response.json()).reviewId as string; }
async function read() { return (await (await reviewGET(request("/api/tasks/task-prototype/prototypes"),"task-prototype")).json()) as PrototypeReviewRead; }
test("publication copies a task's prototype before its worktree disappears", async () => {
  saveTasks([task()]);
  const root = await fs.mkdtemp(path.join(process.env.HOME!, "prototype-source-")); roots.push(root);
  await fs.writeFile(path.join(root, "variant-1-desktop-1440-en-open.png"), Buffer.from([137,80,78,71,13,10,26,10]));
  const response = await publishPOST(request("/api/prototype-reviews", {
    clientRequestId: "publish-first", taskId: "task-prototype", title: "Review layout", dir: root,
    variants: [{ number: 1, name: "Compact", description: "Keeps the controls together." }],
  }));
  expect(response.status).toBe(200);
  await fs.rm(root, { recursive: true });
  const read = await reviewGET(request("/api/tasks/task-prototype/prototypes"), "task-prototype");
  const body = await read.json();
  expect(body.rounds[0].variants[0].frames[0].image.available).toBe(true);
  expect(body.waitingReviewId).toBe(body.rounds[0].id);
  expect(loadTasks()[0]!.prototypeReviews).toHaveLength(1);
});

test("the agent surface exposes a publishing tool and a decision read", () => {
  expect(MCP_TOOL_NAMES).toContain("publish_prototype_review");
  expect(MCP_TOOL_NAMES).toContain("read_prototype_review");
  expect(TOOL_INPUT_SCHEMAS.publish_prototype_review.safeParse({ clientRequestId: "agent",title: "Layout",dir: "/var/tmp/frames",variants: [{number: 1,name: "Compact",description: "Keeps controls together."}] }).success).toBe(true);
});
test("the full form keeps originals, captions and videos; safe routes serve copied bytes and ranges", async () => {
  const input = await fullInput(); const id = await publish(input); const review = (await read()).rounds[0]!;
  const frame = review.variants[0]!.frames[0]!;
  expect(frame.caption).toBe("Changed controls"); expect(frame.original?.available).toBe(true);
  const image = await imageGET(request(frame.image.url!)); expect(image.status).toBe(200); expect(Buffer.from(await image.arrayBuffer())).toEqual(PNG);
  const media = review.variants[0]!.videos[0]!.media;
  const rangeRequest = request(media.url!); rangeRequest.headers.set("range","bytes=4-11");
  const video = await prototypeMediaGET(rangeRequest,"task-prototype",id,media.id,"video");
  expect(video.status).toBe(206); expect(video.headers.get("content-range")).toBe(`bytes 4-11/${MP4.length}`); expect(Buffer.from(await video.arrayBuffer())).toEqual(Buffer.from("ftypisom"));
  rangeRequest.headers.set("range","bytes=999-"); expect((await prototypeMediaGET(rangeRequest,"task-prototype",id,media.id,"video")).status).toBe(416);
  rangeRequest.headers.set("range","bytes=-4"); const suffix = await prototypeMediaGET(rangeRequest,"task-prototype",id,media.id,"video"); expect(suffix.status).toBe(206); await suffix.arrayBuffer();
  expect((await prototypeMediaGET(request(media.url!),"task-prototype",id,"f".repeat(64),"video")).status).toBe(404);
  expect(JSON.stringify(review)).not.toContain(process.env.HOME!);
});
test("directory convention pairs original and changed pictures and skips subdirectories", async () => {
  const dir = await source(); await fs.mkdir(path.join(dir,"bundle"));
  await fs.writeFile(path.join(dir,"variant-1-layout-1440-en-original.png"),PNG);
  await fs.writeFile(path.join(dir,"variant-1-layout-1440-en-changed.png"),Buffer.concat([PNG,Buffer.from("changed")]));
  await fs.writeFile(path.join(dir,"bundle","variant-1-390-uk.png"),PNG);
  await publish({ clientRequestId: "directory-pair",taskId: "task-prototype",title: "Pair",dir,variants: [{ number: 1,name: "Compact",description: "A closer layout." }] });
  const variant = (await read()).rounds[0]!.variants[0]!;
  expect(variant.frames).toHaveLength(1); expect(variant.frames[0]!.original?.available).toBe(true);
  expect(variant.frames[0]!.width).toBe(1440); expect(variant.frames[0]!.lang).toBe("en");
});
test("unreadable directories, escaping links, spoofed types and count/size overflow publish nothing", async () => {
  const input = await fullInput("invalid");
  const badDir = await publishPOST(request("/api/prototype-reviews",{ ...input,dir: "/etc/absent-prototype-frames",variants: [{ number: 1,name: "One",description: "One." }] }));
  expect(badDir.status).toBe(403); const refusal = (await badDir.json()).error;
  expect(refusal).toContain("Nothing was published."); expect(refusal).toContain("cp -r");
  const frames = input.variants[0]!.frames!; frames[0]!.path = path.join(await source(),"escape.png"); await fs.symlink("/etc/passwd",frames[0]!.path);
  expect((await publishPOST(request("/api/prototype-reviews",input))).status).toBe(403);
  await fs.unlink(frames[0]!.path); await fs.writeFile(frames[0]!.path,"<html>pretending</html>");
  expect((await publishPOST(request("/api/prototype-reviews",input))).status).toBe(415);
  await fs.writeFile(frames[0]!.path,Buffer.alloc(PROTOTYPE_LIMITS.imageBytes+1));
  expect((await publishPOST(request("/api/prototype-reviews",input))).status).toBe(400);
  input.variants[0]!.frames = Array.from({ length: 121 },() => frames[0]!);
  expect((await publishPOST(request("/api/prototype-reviews",input))).status).toBe(400);
  expect(loadTasks()[0]!.prototypeReviews).toBeUndefined();
});
test("a pipeline caller inherits its task; another project's caller cannot read or publish; workers cannot decide", async () => {
  const world: PrototypeWorld = { caller: () => ({ conversationId: "conversation_worker",project: "project-a" }),
    stage: () => ({ taskIds: ["task-prototype"],project: "project-a",source: { conversationId: "conversation_worker",pipelineId: "pipeline-layout",stageId: "design",attempt: 2 } }),orchestrator: () => null };
  const input = await fullInput("pipeline"); delete input.taskId;
  const id = await publish(input,world); expect(loadTasks()[0]!.prototypeReviews![0]!.source.stageId).toBe("design");
  expect((await reviewPOST(request("/review",{ reviewId: id,chosen: [1],comment: "Choose" }),"task-prototype",world)).status).toBe(403);
  const foreign = { ...world,caller: () => ({ conversationId: "conversation_other",project: "project-b" }) };
  expect((await reviewGET(request("/review"),"task-prototype",foreign)).status).toBe(403);
  expect((await publishPOST(request("/publish",{ ...input,clientRequestId: "foreign" }),foreign)).status).toBe(403);
  expect((await publishPOST(request("/publish",{ ...input,taskId: "task-other",clientRequestId: "wrong-task" }),world)).status).toBe(403);
});
test("no orchestrator keeps the decision, combination, exact comment and history; a newer round waits", async () => {
  expect((await read()).rounds).toEqual([]);
  const id = await publish(await fullInput("round-one")); const comment = "  Keep 1 + 2.\nAdd a button.  ";
  expect(prototypeReviewNotices(loadTasks())).toHaveLength(1);
  const save = await reviewPOST(request("/review",{ reviewId: id,chosen: [2,1],comment }),"task-prototype");
  expect(save.status).toBe(200); expect((await read()).rounds[0]!.decision).toMatchObject({ chosen: [1,2],comment,delivery: { state: "no-orchestrator" } });
  expect(prototypeReviewNotices(loadTasks())).toHaveLength(0);
  expect(prototypeReviewSummary(loadTasks()[0]!.prototypeReviews!)?.decision?.chosen).toEqual([{number: 1,name: "Compact"},{number: 2,name: "Roomy"}]);
  const next = await publish(await fullInput("round-two")); expect((await read()).waitingReviewId).toBe(next); expect((await read()).rounds).toHaveLength(2);
  expect(prototypeReviewNotices(loadTasks())).toHaveLength(1);
  const conflict = await reviewPOST(request("/review",{ reviewId: id,chosen: [1],comment: "Changed decision" }),"task-prototype"); expect(conflict.status).toBe(409);
});

test("a decision on the newer of two rounds retires the older undecided one: nothing waits, history keeps it as superseded", async () => {
  const older = await publish(await fullInput("design-round")); const newer = await publish(await fullInput("revise-round"));
  expect((await read()).waitingReviewId).toBe(newer);
  const save = await reviewPOST(request("/review",{ reviewId: newer,chosen: [2],comment: "Two." }),"task-prototype"); expect(save.status).toBe(200);
  const body = await read();
  expect(body.waitingReviewId).toBeNull(); expect(body.summary?.waitingReviewId).toBeNull();
  expect(body.rounds.map(round => [round.id, round.supersededBy ?? null])).toEqual([[older, newer], [newer, null]]);
  expect(prototypeReviewNotices(loadTasks())).toEqual([]);
  expect(withPrototypeReviewSummaries(loadTasks())[0]!.prototypeReview?.waitingReviewId).toBeNull();
  const replica = prototypeReviewReplica(loadTasks()[0]!)!;
  expect(isPrototypeReplica(replica, "task-prototype", "project-a")).toBe(true); expect(replica.rounds[0]).not.toHaveProperty("supersededBy");
  /* The superseded round keeps its own history and can still be decided by hand. */
  expect((await reviewPOST(request("/review",{ reviewId: older,chosen: [1],comment: "" }),"task-prototype")).status).toBe(200);
});

test("publication replay survives source removal; changed payload refuses reuse", async () => {
  const input = await fullInput("replay"); const id = await publish(input);
  await fs.rm(path.dirname(input.variants[0]!.frames![0]!.path), { recursive: true });
  expect(await publish(input)).toBe(id);
  expect(loadTasks()[0]!.prototypeReviews).toHaveLength(1);
  expect((await publishPOST(request("/publish", { ...input, title: "Different" }))).status).toBe(409);
});

test("failed task commits leave no publication or decision and no dispatch", async () => {
  const input = await fullInput("commit-fault");
  injectStateWriteFaultForTests({ site: "commit", collection: "tasks", times: 1, error: new Error("write refused") });
  expect((await publishPOST(request("/publish", input))).status).toBe(503);
  expect(loadTasks()[0]!.prototypeReviews).toBeUndefined();
  injectStateWriteFaultForTests(null);
  const id = await publish(input);
  let sends = 0;
  const delivery = { recover: async () => null, send: async () => { sends++; return { state: "sent" as const }; }, retry: async () => ({ state: "sent" as const }) };
  injectStateWriteFaultForTests({ site: "commit", collection: "tasks", times: 1, error: new Error("write refused") });
  expect((await reviewPOST(request("/review", { reviewId: id, chosen: [1], comment: "Keep it" }), "task-prototype", undefined, delivery)).status).toBe(503);
  expect(loadTasks()[0]!.prototypeReviews![0]!.decision).toBeUndefined(); expect(sends).toBe(0);
});

test("retention removes old copies while decisions and round history remain", async () => {
  const id = await publish(await fullInput("retention-old"));
  await reviewPOST(request("/review", { reviewId: id, chosen: [1], comment: "Keep the compact layout" }), "task-prototype");
  const stored = loadTasks()[0]!;
  stored.status = "done"; stored.doneAt = "2020-01-01T00:00:00Z"; stored.updatedAt = stored.doneAt;
  saveTasks([stored]);
  await publish(await fullInput("retention-new"));
  expect(await fs.stat(roundDirectory(id)).then(() => true, () => false)).toBe(false);
  const review = await read(); expect(review.rounds).toHaveLength(2);
  expect(review.rounds[0]!.mediaRemovedAt).toBeDefined(); expect(review.rounds[0]!.variants[0]!.frames[0]!.image).toMatchObject({ available: false, url: null });
  expect(review.rounds[0]!.decision?.comment).toBe("Keep the compact layout");
});

test("linked metadata exposes variants and history without local bytes, URLs or delivery secrets", async () => {
  await publish(await fullInput("linked"));
  const stored = loadTasks()[0]!;
  const replica = prototypeReviewReplica(stored)!;
  expect(isPrototypeReplica(replica, stored.id, stored.project)).toBe(true);
  const remote = { ...task(), prototypeReviewReplica: replica };
  expect(readPrototypeReviews(remote)).toMatchObject({ unavailable: "another-installation", waitingReviewId: replica.summary.waitingReviewId });
  expect(readPrototypeReviews(remote).rounds[0]!.variants[0]!.frames[0]!.image).toMatchObject({ available: false, url: null });
  expect(withPrototypeReviewSummaries([remote])[0]!.prototypeReview?.waitingReviewId).toBe(replica.summary.waitingReviewId);
  const publicTask = withPrototypeReviewSummaries([stored])[0]!;
  expect(publicTask).not.toHaveProperty("prototypeReviews");
  expect(prototypeReviewNotices([remote])).toHaveLength(1);
  expect(JSON.stringify(replica)).not.toContain("publicationKey"); expect(JSON.stringify(replica)).not.toContain("clientMessageId");
  const wireTask = { ...stored, id: randomUUID(), project: `repo-${"a".repeat(32)}` };
  wireTask.prototypeReviews = wireTask.prototypeReviews!.map(r => ({ ...r, taskId: wireTask.id, project: wireTask.project }));
  const self = { id: randomUUID(), prefix: "aaaaaaaa" };
  const row = encodeTask(wireTask, self).row;
  expect(isWireTask(row)).toBe(true); expect(decodeWireRow(row)).toEqual(row);
  expect(encodeTask(wireTask, self, { includePrototypeReview: false }).row).not.toHaveProperty("prototypeReviewReplica");
  if (isWireTask(row)) {
    row.prototypeReviewReplica!.rounds[0]!.variants[0]!.frames[0]!.image.url = "/private";
    expect(() => decodeWireRow(row)).toThrow("prototypeReviewReplica");
  }
  const large = wireTask.prototypeReviews![0]!;
  large.variants[0]!.frames = Array.from({ length: 200 }, () => ({ caption: "View ".repeat(40), image: large.variants[0]!.frames[0]!.image }));
  large.variants[1]!.frames = [];
  wireTask.prototypeReviews = Array.from({ length: 3 }, (_, n) => ({ ...large, id: `pr_${String(n).repeat(32)}` }));
  const bounded = encodeTask(wireTask, self);
  expect(bounded.bytes).toBeLessThanOrEqual(170000); expect(isWireTask(bounded.row)).toBe(true);
  if (isWireTask(bounded.row)) {
    expect(bounded.row.prototypeReviewReplica?.historyTruncated).toBe(true);
    expect(bounded.row.prototypeReviewReplica?.summary.rounds).toBe(3);
    expect(decodeWireRow(bounded.row)).toEqual(bounded.row);
  }
});

test("cross-origin reads and writes and spoofed worker decisions are refused", async () => {
  const id = await publish(await fullInput("origin"));
  const req = request("/review", { reviewId: id, chosen: [1], comment: "Keep" }); req.headers.set("origin", "https://elsewhere.example.test");
  expect((await reviewPOST(req, "task-prototype")).status).toBe(403);
  expect((await reviewGET(req, "task-prototype")).status).toBe(403);
  const worker = request("/review", { reviewId: id, chosen: [1], comment: "Keep" }); worker.headers.set("x-llv-spawn-capability", "untrusted");
  expect((await reviewPOST(worker, "task-prototype")).status).toBe(403);
});

test("MCP publication and decision reads forward caller identity through the Viewer routes", async () => {
  const input = await fullInput("mcp-production"); delete input.taskId;
  const world: PrototypeWorld = { caller: req => {
    expect(req.headers.get(VIEWER_SPAWN_CAPABILITY_HEADER)).toBe("a".repeat(43));
    return { conversationId: "conversation_worker", project: "project-a" };
  }, stage: () => ({ taskIds: ["task-prototype"], project: "project-a", source: { conversationId: "conversation_worker", stageId: "design" } }), orchestrator: () => null };
  const prior = process.env[VIEWER_SPAWN_CAPABILITY_ENV];
  process.env[VIEWER_SPAWN_CAPABILITY_ENV] = "a".repeat(43);
  try {
    const control = { post: async (url: string, body: Record<string, unknown>, headers?: Record<string, string>) => {
      const req = request(url, body); for (const [key, value] of Object.entries(headers ?? {})) req.headers.set(key, value);
      const response = url.endsWith("/read") ? await reviewReadPOST(req, world) : await publishPOST(req, world);
      expect(response.status).toBe(200); return response.json();
    } };
    const bindings = viewerMcpBindings(undefined, control);
    const published = await bindings.publish_prototype_review(input as unknown as Record<string, unknown>);
    expect(published.taskId).toBe("task-prototype");
    const result = await bindings.read_prototype_review({});
    expect((result.rounds as unknown[])).toHaveLength(1);
  } finally {
    if (prior === undefined) delete process.env[VIEWER_SPAWN_CAPABILITY_ENV]; else process.env[VIEWER_SPAWN_CAPABILITY_ENV] = prior;
  }
});

test("publication resolves the caller's task from the production pipeline store", async () => {
  const role = { roleId: "builder" as const, engine: "codex" as const, model: null, effort: null, access: "read-write" as const, promptScaffold: "Build" };
  const pipeline = buildPipeline({ id: "prototype-binding", task: "Layout", taskIds: ["task-prototype"], project: "project-a", repoDir: "/repo",
    stages: [{ id: "design", kind: "run", role: { roleId: "builder" }, prompt: "Design", next: null, effectiveRole: role }], srcPath: null, srcConversationId: null, now: new Date().toISOString() });
  pipeline.runs[0]!.attempts.push({ n: 1, state: "running", conversationId: "conversation_bound", launchId: "launch_bound", effectiveRole: role,
    sessionId: null, agentPath: null, paneId: null, flowId: null, expectedReviewHeadSha: null, reviewHeadSha: null,
    startedAt: new Date().toISOString(), completedAt: null, input: null, activatedBy: null, output: null, verdict: null, error: null });
  savePipelines([pipeline]);
  try {
    const input = await fullInput("production-binding"); delete input.taskId;
    const world = { ...prototypeWorld, caller: () => ({ conversationId: "conversation_bound", project: "project-a" }) };
    const id = await publish(input, world);
    expect(loadTasks()[0]!.prototypeReviews![0]!.source).toMatchObject({ pipelineId: pipeline.id, stageId: "design", attempt: 1 });
    expect((await (await reviewReadPOST(request("/read", {}), world)).json()).waitingReviewId).toBe(id);
  } finally { savePipelines([]); }
});

test("forty pictures retain captions; video and aggregate image byte bounds refuse publication", async () => {
  const input = await fullInput("forty");
  const frame = input.variants[0]!.frames![0]!;
  input.variants = [{ number: 1, name: "Compact", description: "Compact layout", frames: Array.from({ length: 40 }, (_, n) => ({ path: frame.path, caption: `Picture ${n + 1}` })) }];
  await publish(input);
  expect((await read()).rounds[0]!.variants[0]!.frames).toHaveLength(40);
  expect((await read()).rounds[0]!.variants[0]!.frames[39]!.caption).toBe("Picture 40");
  const oversized = path.join(await source(), "oversized.mp4");
  const video = await fs.open(oversized, "w"); await video.write(MP4); await video.truncate(PROTOTYPE_LIMITS.videoBytes + 1); await video.close();
  const badVideo = { ...input, clientRequestId: "oversized-video", variants: [{ number: 1, name: "One", description: "Video", videos: [{ path: oversized, caption: "Video" }] }] };
  expect((await publishPOST(request("/publish", badVideo))).status).toBe(400);
  const image = await fs.open(frame.path, "w"); await image.write(PNG); await image.truncate(PROTOTYPE_LIMITS.imageBytes); await image.close();
  const bigImages = { ...input, clientRequestId: "aggregate-images", variants: [{ number: 1, name: "One", description: "Images", frames: Array.from({ length: 13 }, () => ({ path: frame.path, caption: "Image" })) }] };
  expect((await publishPOST(request("/publish", bigImages))).status).toBe(400);
  expect(loadTasks()[0]!.prototypeReviews).toHaveLength(1);
});

test("the next publication removes owned copies whose task was deleted", async () => {
  const old = await publish(await fullInput("deleted-task"));
  saveTasks([]); saveTasks([task()]);
  await publish(await fullInput("after-task-deletion"));
  expect(await fs.stat(roundDirectory(old)).then(() => true, () => false)).toBe(false);
});

test("the byte and round ceilings evict oldest owned copies and preserve history", async () => {
  const input = await fullInput("quota-first");
  const originalBytes = PROTOTYPE_LIMITS.storeBytes, originalRounds = PROTOTYPE_LIMITS.storedRounds;
  try {
    const first = await publish(input);
    const bytes = roundMedia(loadTasks()[0]!.prototypeReviews![0]!).reduce((n, m) => n + m.bytes, 0);
    // Exercise the production eviction path with small private fixture quotas.
    Reflect.set(PROTOTYPE_LIMITS, "storeBytes", bytes * 2);
    const second = await publish({ ...input, clientRequestId: "quota-second" });
    await publish({ ...input, clientRequestId: "quota-third" });
    expect(await fs.stat(roundDirectory(first)).then(() => true, () => false)).toBe(false);
    expect(await fs.stat(roundDirectory(second)).then(() => true, () => false)).toBe(true);
    Reflect.set(PROTOTYPE_LIMITS, "storeBytes", originalBytes);
    Reflect.set(PROTOTYPE_LIMITS, "storedRounds", 1);
    await publish({ ...input, clientRequestId: "quota-fourth" });
    expect(await fs.stat(roundDirectory(second)).then(() => true, () => false)).toBe(false);
    const rounds = loadTasks()[0]!.prototypeReviews!;
    expect(rounds).toHaveLength(4); expect(rounds.filter(r => !r.mediaRemovedAt)).toHaveLength(1);
  } finally {
    Reflect.set(PROTOTYPE_LIMITS, "storeBytes", originalBytes); Reflect.set(PROTOTYPE_LIMITS, "storedRounds", originalRounds);
  }
});

test("generic task reads and write acknowledgements do not bypass prototype access", async () => {
  const id = await publish(await fullInput("private-decision"));
  await reviewPOST(request("/review", { reviewId: id, chosen: [1], comment: "Private review comment" }), "task-prototype");
  const req = request("/api/tasks"); req.headers.set(VIEWER_SPAWN_CAPABILITY_HEADER, "a".repeat(43));
  const list = await (await tasksGET(req)).json(); expect(list.tasks[0]).not.toHaveProperty("prototypeReview");
  const patch = request("/api/tasks/task-prototype", { color: "teal" }); patch.headers.set(VIEWER_SPAWN_CAPABILITY_HEADER, "a".repeat(43));
  const result = await (await taskPATCH(patch, { params: Promise.resolve({ id: "task-prototype" }) })).json();
  expect(result).toMatchObject({ ok: true }); expect(result.task).not.toHaveProperty("prototypeReviews"); expect(result.task).not.toHaveProperty("prototypeReview");
  const acknowledgement = taskAcknowledgement(loadTasks()[0]!, { full: true }, ["color"]);
  expect(acknowledgement.task).not.toHaveProperty("prototypeReviews");
  expect(JSON.stringify(acknowledgement)).not.toContain("Private review comment");
  const service = createMcpToolService({ ...viewerMcpBindings(), board_snapshot: async () => ({ tasks: loadTasks() }) }, new MemoryMcpReceiptStore());
  const snapshot = await service.callTool("board_snapshot", { clientRequestId: "prototype-board-read" });
  expect(snapshot.ok).toBe(true); expect(JSON.stringify(snapshot)).not.toContain("Private review comment");
});

test("no task answer hands a review to a capability caller: an assignment that changes nothing and a dismissal", async () => {
  saveTasks([{ ...task(), assignments: [{ launchId: "launch-ghost", conversationId: "conversation_ghost", path: null, panePid: null, state: "linked" as const, error: null, at: "2026-10-01T00:00:00Z", engine: "codex" as const }] }]);
  const id = await publish(await fullInput("private-assignment"));
  await reviewPOST(request("/review", { reviewId: id, chosen: [1], comment: "Private review comment" }), "task-prototype");
  expect(JSON.stringify(loadTasks()[0])).toContain("Private review comment");
  const context = { params: Promise.resolve({ id: "task-prototype" }) };
  const call = (method: string, body: unknown, agent: boolean) => new NextRequest("http://localhost/api/tasks/task-prototype/assignment", { method, body: JSON.stringify(body),
    headers: { host: "localhost", "sec-fetch-site": "same-origin", ...(agent ? { [VIEWER_SPAWN_CAPABILITY_HEADER]: "a".repeat(43) } : {}) } });
  const answers = [
    await assignmentDELETE(call("DELETE", { launchId: "nothing-to-remove" }, true), context),
    await assignmentPATCH(call("PATCH", { launchId: "launch-ghost", conversationId: "conversation_ghost", dismiss: "launch-did-not-start" }, true), context),
  ];
  for (const answer of answers) {
    expect(answer.status).toBe(200);
    const body = await answer.json();
    for (const field of ["prototypeReviews", "prototypeReviewReplica", "prototypeReview"]) expect(body.task).not.toHaveProperty(field);
    expect(JSON.stringify(body)).not.toContain("Private review comment");
    expect(JSON.stringify(body)).not.toContain("prototype-decision:");
  }
  // The operator's interface redraws the card from the same answer: the summary, and no round.
  const operator = await (await assignmentDELETE(call("DELETE", { launchId: "nothing-to-remove" }, false), context)).json();
  expect(operator.task.prototypeReview).toMatchObject({ rounds: 1 });
  expect(operator.task).not.toHaveProperty("prototypeReviews");
  expect(JSON.stringify(operator)).not.toContain("prototype-decision:");
  // The review's own read is untouched.
  expect((await read()).rounds[0]!.decision!.comment).toBe("Private review comment");
});


test("questions-only publication and answers round trip through operator and agent reads", async () => {
  const input = { clientRequestId: "questions-roundtrip", taskId: "task-prototype", title: "Before work", questions };
  expect(TOOL_INPUT_SCHEMAS.publish_prototype_review.safeParse(input).success).toBe(true);
  const published = await publishPOST(request("/publish", input));
  expect(published.status).toBe(200);
  const body = await published.json();
  expect(body).toMatchObject({ questions: 3, variants: 0, frames: 0, videos: 0 });
  expect((await read()).rounds[0]!.questions).toEqual(questions);
  const agentRead = async () => (await (await reviewReadPOST(request("/read", { taskId: "task-prototype" }))).json()) as PrototypeReviewRead;
  expect((await agentRead()).rounds[0]!.questions).toEqual(questions);
  const answers = [{ questionId: "place", options: [1] }, { questionId: "scope", options: [1,0] }, { questionId: "timing", options: [], other: true }];
  const comment = "  Use the existing path.\nStart immediately.  ";
  const answer = { reviewId: body.reviewId, chosen: [], answers, comment };
  expect((await reviewPOST(request("/review", answer), "task-prototype")).status).toBe(200);
  const expected = [{ questionId: "place", options: [1] }, { questionId: "scope", options: [0,1] }, { questionId: "timing", options: [], other: true }];
  for (const result of [await read(), await agentRead()]) {
    expect(result.rounds[0]!.decision).toMatchObject({ answers: expected, chosen: [], comment });
    expect(result.rounds[0]!.decision).not.toHaveProperty("skipped");
    expect(result.waitingReviewId).toBeNull();
  }
  expect(prototypeReviewNotices(loadTasks())).toEqual([]);
  expect((await reviewPOST(request("/review", answer), "task-prototype")).status).toBe(200);
  expect((await reviewPOST(request("/review", { ...answer, answers: expected.map(a => a.questionId === "place" ? { ...a, options: [0] } : a) }), "task-prototype")).status).toBe(409);
});


test("question answer validation refuses incomplete and forged payloads without a save or send", async () => {
  const id = await publish({ clientRequestId: "validation", taskId: "task-prototype", title: "Before work", questions });
  let sends = 0;
  const delivery = { recover: async () => null, send: async () => { sends++; return { state: "sent" as const }; }, retry: async () => ({ state: "sent" as const }) };
  const answers = questions.map(q => ({ questionId: q.id, options: [0] }));
  const invalid = [
    { answers: answers.slice(0,2) },
    { answers: answers.map(a => a.questionId === "place" ? { ...a, options: [0,1] } : a) },
    { answers: answers.map(a => ({ ...a, options: [9] })) },
    { answers: [answers[0],answers[0],answers[2]] },
    { answers: answers.map(a => a.questionId === "place" ? { ...a, options: [], other: true } : a), comment: "Other" },
    { answers: answers.map(a => a.questionId === "timing" ? { ...a, options: [], other: true } : a) },
    { answers, skip: true }, { skip: false },
  ];
  for (const patch of invalid) {
    expect((await reviewPOST(request("/review", { reviewId: id, chosen: [], comment: "", ...patch }), "task-prototype", undefined, delivery)).status).toBe(400);
    expect(loadTasks()[0]!.prototypeReviews![0]!.decision).toBeUndefined();
  }
  const variantId = await publish(await fullInput("no-questions"));
  expect((await reviewPOST(request("/review", { reviewId: variantId, chosen: [1], comment: "", answers }), "task-prototype", undefined, delivery)).status).toBe(400);
  expect(sends).toBe(0);
});

test("skip takes server recommendations and delivers one durable answer message", async () => {
  const world = { ...prototypeWorld, orchestrator: () => "conversation_seat" };
  const id = await publish({ clientRequestId: "skip", taskId: "task-prototype", title: "Before work", questions }, world);
  const sent: string[] = [];
  const delivery = { recover: async () => null, send: async (_request: NextRequest, decision: import("./types").PrototypeDecision) => { sent.push(decision.delivery.text); return { state: "sent" as const }; }, retry: async () => ({ state: "sent" as const }) };
  const payload = { reviewId: id, chosen: [], comment: "", skip: true };
  expect((await reviewPOST(request("/review", payload), "task-prototype", world, delivery)).status).toBe(200);
  expect((await read()).rounds[0]!.decision).toMatchObject({ skipped: true, answers: questions.map(q => ({ questionId: q.id, options: [0] })), delivery: { state: "sent" } });
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain("Answers: skipped, use your recommendations.");
  for (const q of questions) expect(sent[0]).toContain(q.options[0]!.label + " (recommended)");
  expect((await reviewPOST(request("/review", payload), "task-prototype", world, delivery)).status).toBe(200);
  expect(sent).toHaveLength(1);
});

test("oversized questionnaire answers are refused before saving or dispatching", async () => {
  const longQuestions = Array.from({ length: 7 }, (_, i) => ({ id: `q${i}`, text: "П".repeat(300), options: [{ label: "А".repeat(120), recommended: true }, { label: "Б".repeat(120) }] }));
  const id = await publish({ clientRequestId: "oversized", taskId: "task-prototype", title: "Before work", questions: longQuestions });
  const result = await reviewPOST(request("/review", { reviewId: id, chosen: [], answers: longQuestions.map(q => ({ questionId: q.id, options: [0] })), comment: "Я".repeat(16000) }), "task-prototype");
  expect(result.status).toBe(400);
  expect((await result.json()).error).toContain("shorten the comment");
  expect(loadTasks()[0]!.prototypeReviews![0]!.decision).toBeUndefined();
});
