import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prototypeTask, storePrototypePictures } from "./prototypeRead.fixture";
import { backendResponse, delegationCreated, FakeLiveProvider, functionCall, message } from "./fakeProvider";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-prototype-flow-"));
process.env.LLV_STATE_DIR = path.join(root, "state");
const { saveTasks } = await import("@/lib/tasks/store");
const { CompanionBoardReads } = await import("./boardReads");
const { createCompanionBoardReadPaths } = await import("./readPaths");
const { CompanionStorage } = await import("./storage");
const { CompanionAdmission } = await import("./admission");
const { CompanionLiveSessions } = await import("./liveSession");
const { BACKEND_ROUNDS } = await import("./usage");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

for (const combined of [false, true]) test(`prototype discussion ${combined ? "in one turn leaves a tool round spare" : "across three turns uses one round per turn"}`, async () => {
  const task = prototypeTask(); await storePrototypePictures(task);
  const other = prototypeTask("other-task"); other.prototypeReviews![0].id = `pr_${"e".repeat(32)}`; other.prototypeReviews![0].title = "Other layout";
  saveTasks([task, other]);
  const storage = new CompanionStorage(); storage.updateSettings({ enabled: true });
  let sends = 0;
  const admission = new CompanionAdmission(storage, { recipient: () => null, reports: () => [], send: async () => { sends++; throw new Error("unexpected send"); } });
  const provider = new FakeLiveProvider();
  const service = new CompanionLiveSessions(storage, admission, new CompanionBoardReads(createCompanionBoardReadPaths()), provider, { key: () => "fixture-provider", timers: false, closeTimeoutMs: 20 });
  const selectors = [
    { name: "read_prototype_review", args: { taskId: null, reviewId: null, query: null, project: null, refresh: null } },
    { name: "read_prototype_review", args: { taskId: null, reviewId: null, query: "свіжа добірка", project: null, refresh: null } },
    { name: "view_prototype_frame", args: { taskId: null, reviewId: null, query: "свіжа добірка", variants: [1, 2, 3], view: "board dark", width: 1440, lang: "uk", original: false, project: null, refresh: null } },
  ];
  let turnIndex = 0;
  provider.responder = (request, index) => {
    const results = request.input.filter(item => item.type === "function_call_output");
    const next = combined ? results.length : results.length ? 3 : turnIndex;
    if (next < 3) return backendResponse(`response-${index}`, [functionCall(`call-${index}`, selectors[next].name, selectors[next].args)]);
    const output = JSON.parse(results.at(-1)!.output as string);
    expect(output.status).toBe(turnIndex === 0 && !combined ? "several" : "done");
    return backendResponse(`response-${index}`, [message(combined || turnIndex === 2
      ? "The review says variant 1 keeps details in the row, variant 2 uses a side panel, and variant 3 uses cards. I opened Board dark frames at 1440 px in Ukrainian."
      : output.speech)]);
  };
  const s = await service.start({ project: "fixture", locale: "uk", sdp: "v=0" });
  try {
    const questions = combined ? ["What prototypes wait? Read the fresh collection and compare the three variants."] : ["What prototypes wait?", "Read the fresh collection.", "How do the three variants differ?"];
    for (const [n, question] of questions.entries()) {
      turnIndex = n;
      const start = provider.requests.length;
      provider.replay(s.providerId, { type: "session.input_transcript.delta", event_id: `speech-${n}`, delta: question, start_ms: n * 1000, end_ms: n * 1000 + 400 }, delegationCreated(`review-turn-${n}`, n * 1000 + 500));
      await service.drain(s.sessionId);
      const requests = provider.requests.slice(start);
      expect(requests).toHaveLength(combined ? 4 : 2);
      expect(requests.length - 1).toBeLessThan(BACKEND_ROUNDS);
    }
    const answer = provider.requests.at(-1)!;
    const images = answer.input.flatMap(item => Array.isArray(item.content) ? item.content : []).filter(part => part.type === "input_image");
    expect(images).toHaveLength(3);
    expect(images.map(image => image.detail)).toEqual(["high", "high", "high"]);
    const frameResult = JSON.parse(answer.input.filter(item => item.type === "function_call_output").at(-1)!.output as string);
    expect(frameResult.item.attached.map((frame: { variant: number }) => frame.variant)).toEqual([1, 2, 3]);
    expect(JSON.stringify(service.transcriptRecord(s.sessionId))).not.toContain("base64");
    expect(provider.commands.some(row => row.type === "session.commentary.append" && String(row.content).includes("variant 1 keeps details in the row, variant 2 uses a side panel, and variant 3 uses cards"))).toBe(true);
    if (combined) {
      provider.responder = (request, index) => backendResponse(`reverse-${index}`, request.input.some(item => item.type === "function_call_output")
        ? [message("Compared the variants in the requested order.")]
        : [functionCall("reverse-call", "view_prototype_frame", { ...selectors[2].args, variants: [3, 2, 1] })]);
      provider.replay(s.providerId, delegationCreated("reverse-variants", 5000));
      await service.drain(s.sessionId);
      const reverse = JSON.parse(provider.requests.at(-1)!.input.find(item => item.type === "function_call_output")!.output as string);
      expect(reverse.item.attached.map((frame: { variant: number }) => frame.variant)).toEqual([3, 2, 1]);
    }
    expect(sends).toBe(0);
  } finally { await service.close(s.sessionId); }
});
