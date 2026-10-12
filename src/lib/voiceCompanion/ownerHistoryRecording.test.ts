import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fixtureBoardReads } from "./boardReads.fixture";
import { FakeLiveProvider, backendResponse, functionCall, message, delegationCreated } from "./fakeProvider";
import { CompanionStorage } from "./storage";
import { CompanionAdmission } from "./admission";
import { CompanionLiveSessions } from "./liveSession";
import { OWNER_HISTORY_PRIVACY } from "@/lib/externalRelay/ownerHistory";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "history-voice-"));
process.env.LLV_STATE_DIR = path.join(root, "state");
process.env.XDG_CONFIG_HOME = path.join(root, "config");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
test("backend receives synthetic page; record, settings, events and send retain no title or content", async () => {
  const title = "Synthetic private group sentinel";
  const text = "Synthetic private message sentinel";
  const storage = new CompanionStorage(); storage.updateSettings({ enabled: true });
  const sent: unknown[] = [];
  const admission = new CompanionAdmission(storage, { recipient: () => null, reports: () => [], send: async input => { sent.push(input); throw new Error("unexpected send"); } });
  const reads = fixtureBoardReads({ tasks: () => [], pipelines: () => [], activity: async () => [], messages: async () => [] });
  const provider = new FakeLiveProvider();
  const service = new CompanionLiveSessions(storage, admission, reads, provider, { key: () => "synthetic-credential", closeTimeoutMs: 20, timers: false,
    ownerHistory: async () => ({ available: true, chat: "-101", title, timeZone: "Europe/Kyiv", start: "2026-10-12T00:00:00+03:00", end: "2026-10-13T00:00:00+03:00", oldestStoredAt: null,
      messages: [{ messageId: 1, sentAt: "2026-10-12T09:00:00Z", author: { name: "Synthetic member sentinel", username: null }, fromAssistant: false, topicId: null, replyToMessageId: null, text, media: null, truncated: false }],
      nextCursor: null, privacy: OWNER_HISTORY_PRIVACY }) });
  provider.responder = (request, index) => request.input.some(item => item.type === "function_call_output")
    ? backendResponse(`response_${index}`, [message("One group is available.")])
    : backendResponse(`response_${index}`, [functionCall("history-call", "relay_owner_history", { action: "messages", chat: "-101", from: null, to: null, cursor: null, limit: null })]);
  const session = await service.start({ project: "fixture", locale: "en", sdp: "v=0\r\n" });
  provider.replay(session.providerId, delegationCreated("history-delegation", 600));
  await service.drain(session.sessionId);
  expect(JSON.stringify(provider.requests)).toContain(title);
  expect(JSON.stringify(provider.requests)).toContain(text);
  const record = service.transcriptRecord(session.sessionId);
  const tool = record.entries.find(entry => entry.id === "tool-history-call")!;
  expect(JSON.parse(tool.data.result as string)).toEqual({ status: "done", speech: "1 messages, oldest first. That is the end of this range." });
  const projections = [JSON.stringify(record), JSON.stringify(admission.events(session.sessionId, 0)),
    fs.readFileSync(path.join(root, "state", "voice-companion.json"), "utf8"),
    fs.readFileSync(path.join(root, "state", "voice-companion", "transcripts", `${session.sessionId}.jsonl`), "utf8")];
  for (const projection of projections) for (const sentinel of [title, text, "Synthetic member sentinel"]) expect(projection).not.toContain(sentinel);
  expect(sent).toHaveLength(0);
  await service.close(session.sessionId);
});
