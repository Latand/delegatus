/** Subprocess fixture: exit at durable write boundaries, then recover through the public session service. */
import fs from "node:fs";
import path from "node:path";
import { CompanionStorage, writePrivate } from "./storage";
import { CompanionAdmission } from "./admission";
import { CompanionLiveSessions } from "./liveSession";
import { FakeLiveProvider } from "./fakeProvider";
import { fixtureBoardReads } from "./boardReads.fixture";

const now = () => Date.UTC(2026, 10, 11, 12);
const storage = new CompanionStorage(now);
storage.updateSettings({ enabled: true, backend: process.env.RECOVERY_BACKEND === "codex" ? "codex" : "api" });
const ledger = path.join(process.env.LLV_STATE_DIR!, "relay.json");
const readLedger = (): { attempts: string[]; messages: string[] } => fs.existsSync(ledger) ? JSON.parse(fs.readFileSync(ledger, "utf8")) : { attempts: [], messages: [] };
let sessionId = "";
const provider = new FakeLiveProvider();
if (process.env.RECOVERY_BACKEND === "codex") Object.defineProperty(provider, "backend", { value: "codex" });
const reports: import("@/lib/bridge/types").BridgeReportV1[] = [];
const finish = () => {
  console.log(JSON.stringify({ id: sessionId, lines: provider.commands.filter(row => row.type === "session.commentary.append").map(row => row.content), ledger: readLedger() }));
  process.exit(0);
};
const admission = new CompanionAdmission(storage, { recipient: () => ({ project: "fixture", conversationId: "conversation_fixture", seatEpoch: 1, engine: "codex" }),
  reports: () => reports, send: async ({ delivery }) => {
    const rows = readLedger(); rows.attempts.push(delivery.clientMessageId);
    if (!rows.messages.includes(delivery.clientMessageId)) rows.messages.push(delivery.clientMessageId);
    writePrivate(ledger, JSON.stringify(rows));
    if (process.env.RECOVERY_FAULT === "send") finish();
    return { status: "delivered", operationId: "operation-restart" };
  } }, now);
const service = new CompanionLiveSessions(storage, admission, fixtureBoardReads({ tasks: () => [], pipelines: () => [], activity: async () => [], messages: async () => [] }), provider,
  { key: () => "synthetic-credential", now, timers: false });
const next = await service.start({ project: "fixture", locale: "en", sdp: "v=0", ...(process.env.RECOVERY_RESUME ? { resume: process.env.RECOVERY_RESUME, cursor: {} } : {}) });
sessionId = next.sessionId;
if (!process.env.RECOVERY_RESUME) {
  provider.replay(next.providerId, { type: "session.output_transcript.delta", event_id: "ready", delta: "Ready.", start_ms: 0, end_ms: 400 });
  provider.replay(next.providerId,
    { type: "session.input_transcript.delta", event_id: "operator", delta: "Check the result.", start_ms: 500, end_ms: 900 },
    { type: "session.output_transcript.delta", event_id: "answer", delta: "Checking.", start_ms: 3000, end_ms: 3400 });
  await service.drain(sessionId);
  if (process.env.RECOVERY_FAULT === "confirmation") {
    await admission.delegate(sessionId, "confirm-call", "confirm-turn", "Review the plan", { confirmation: "Send it?" });
    await service.close(sessionId, "transport");
    finish();
  }
  if (process.env.RECOVERY_FAULT === "send") await admission.delegate(sessionId, "crash-send", "crash-turn", "Review the plan");
  reports.push({ id: "restart-report", seq: 1, project: "fixture", at: new Date(now()).toISOString(), class: "completed", body: "RESTART_FACT",
    origin: { kind: "manager", conversationId: "conversation_fixture", role: "orchestrator" } });
  if (process.env.RECOVERY_FAULT === "handoff") {
    const record = admission.record.bind(admission);
    admission.record = (...args) => { record(...args); if (args[1].kind === "handoff") finish(); };
  }
  if (process.env.RECOVERY_FAULT === "queue") admission.speechHanded = () => finish();
}
await service.events(sessionId, 0);
if (process.env.RECOVERY_FAULT === "reply") admission.resumeReplied = () => finish();
let acknowledged = 0;
for (let round = 0; round < 4 && provider.commands.length > acknowledged; round++) {
  acknowledged = provider.commands.length;
  provider.replay(next.providerId, { type: "session.output_transcript.delta", event_id: `report-said-${round}`, delta: "RESTART_FACT", start_ms: 4000 + round * 3000, end_ms: 4500 + round * 3000 });
  await service.drain(sessionId);
}
await service.close(sessionId, "transport");
finish();
