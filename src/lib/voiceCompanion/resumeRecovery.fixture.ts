/** Separate process per reconnect; stop after the durable reply and before its queue acknowledgement. */
import fs from "node:fs";
import path from "node:path";
import { CompanionStorage } from "./storage";
import { CompanionAdmission } from "./admission";
import { CompanionLiveSessions } from "./liveSession";
import { CodexLiveProvider } from "./codexProvider";
import { FakeLiveProvider } from "./fakeProvider";
import { fixtureBoardReads } from "./boardReads.fixture";
import type { ResumeCursor } from "./contract";

const now = () => Date.UTC(2026, 10, 11, 12);
const backend = process.env.RECOVERY_BACKEND === "codex" ? "codex" : "api";
const mode = process.env.RECOVERY_MODE!;
const storage = new CompanionStorage(now);
storage.updateSettings({ enabled: true, backend });
const admission = new CompanionAdmission(storage, {
  recipient: () => null, reports: () => [], send: async () => { throw new Error("unexpected send"); },
}, now);
const stub = fs.mkdtempSync(path.join(process.env.TMPDIR!, "resume-provider-"));
const binary = path.join(stub, "codex");
fs.writeFileSync(binary, `#!/bin/sh\nexec '${process.execPath}' '${path.join(import.meta.dir, "codexProvider.fixture.mjs")}' "$@"\n`, { mode: 0o700 });
fs.writeFileSync(path.join(stub, "sdp"), "ready");
const fake = new FakeLiveProvider();
const provider = backend === "codex" ? new CodexLiveProvider({
  accounts: () => [{ id: "account-a", kind: "managed", authPresent: true, home: stub }],
  observations: () => [], bindings: () => [], recordObservation: () => {}, now,
  environment: { ...process.env, LLV_CODEX_BINARY: binary, VOICE_STUB_ROOT: stub, VOICE_STUB_MODE: "sdp" },
}) : fake;
const service = new CompanionLiveSessions(storage, admission,
  fixtureBoardReads({ tasks: () => [], pipelines: () => [], activity: async () => [], messages: async () => [] }),
  provider, { now, timers: false, key: () => "synthetic-credential" });
const cursor: ResumeCursor = process.env.RECOVERY_ITEM ? { operatorOpen: process.env.RECOVERY_ITEM } : {};
const next = await service.start({ project: "fixture", locale: "en", sdp: "v=0",
  ...(process.env.RECOVERY_RESUME ? { resume: process.env.RECOVERY_RESUME, cursor } : {}) });
const entries = () => admission.transcriptRecord(next.sessionId).entries;
const until = async (check: () => boolean) => {
  const deadline = performance.now() + 5000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error("resume recovery fixture deadline");
    await Bun.sleep(10);
  }
};
const emit = async (speaker: "operator" | "companion", text: string) => {
  if (backend === "codex") {
    fs.writeFileSync(path.join(stub, "notify-0001.json"), JSON.stringify({ method: "thread/realtime/transcript/delta",
      params: { threadId: next.providerId, role: speaker === "operator" ? "user" : "assistant", delta: text } }));
  } else fake.replay(next.providerId, { type: `session.${speaker === "operator" ? "input" : "output"}_transcript.delta`,
    event_id: "fixture-speech", delta: text, start_ms: 0, end_ms: 500 });
  await until(() => entries().some(row => row.kind === (speaker === "operator" ? "utterance" : "reply") && row.data.text === text));
  await service.drain(next.sessionId);
};
const finish = async (code: number, before = admission.reportSpeech(next.sessionId)) => {
  const snapshot = { id: next.sessionId, before, owed: admission.reportSpeech(next.sessionId), rows: entries() };
  // Reap only this process's local app-server; leave the session's durable state at the crash boundary.
  await provider.hangup(next.providerId, "");
  console.log(JSON.stringify(snapshot));
  process.exit(code);
};
try {
  if (mode === "seed") {
    await emit("operator", "Please review the silver bridge");
    await service.close(next.sessionId, "transport");
    await finish(0);
  }
  const before = admission.reportSpeech(next.sessionId);
  await service.events(next.sessionId, 0);
  if (before.length) await until(() => entries().some(row => row.kind === "handoff"));
  if (mode === "reply") {
    admission.resumeReplied = () => { void finish(73, before); };
    await emit("companion", "The connection dropped after silver bridge. Go on.");
    await new Promise(() => {});
  }
  await finish(mode === "handoff" ? 73 : 0, before);
} finally {
  await provider.hangup(next.providerId, "");
}
