import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { savePipelines } from "@/lib/pipelines/store";
import * as pipelineState from "@/lib/state/sqliteStateStore";
import { prepareStructuredStartupRecipient } from "./startup";
import { interruptionObligationDirectory, initializeRecipientInterruptionIndex } from "./interruptionObligations";
import { structuredRestartFixture, recipientDispatchPipeline, addressedRecipientSocket } from "./startupRecipient.fixture";

setDefaultTimeout(60_000);

for (const identity of ["path", "session"] as const)
for (const archived of [false, true])
for (const mutation of ["incoming", "retarget"] as const)
  test(`recipient preparation refuses suspended ${identity} owner ${mutation} after await (${archived ? "archived" : "active"})`, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "recipient-owner-race-"));
    const oldState = process.env.LLV_STATE_DIR; process.env.LLV_STATE_DIR = directory;
    savePipelines([]);
    const { registry, conversation, sessionId, artifactPath } = structuredRestartFixture(directory, "codex", "unhosted");
    const owner = recipientDispatchPipeline(conversation.id);
    Object.assign(owner.runs[0]!.attempts[0]!, { conversationId: null,
      agentPath: identity === "path" ? "unrelated.jsonl" : null, sessionId: identity === "session" ? "unrelated-session" : null,
      suspension: { reason: "pause", detail: "retained pipeline custody", requestedAt: "2026-11-09T00:00:00.000Z" } });
    const persist = () => {
      if (archived) {
        const db = new Database(path.join(directory, "state.sqlite"));
        try {
          if (db.query("UPDATE state_rows SET value_json=? WHERE collection='pipelines_archive' AND row_key=?")
            .run(JSON.stringify(owner), owner.id).changes) return;
        } finally { db.close(); }
      }
      savePipelines([owner]);
      if (archived) {
        const db = new Database(path.join(directory, "state.sqlite"));
        try { db.query("UPDATE state_rows SET collection='pipelines_archive' WHERE collection='pipelines' AND row_key=?").run(owner.id); }
        finally { db.close(); }
      }
    };
    if (mutation === "retarget") persist(); else savePipelines([]);
    await initializeRecipientInterruptionIndex(interruptionObligationDirectory(registry.filename));
    const read = pipelineState.readRecipientPipelineEvidence;
    let changed = false;
    const reader = spyOn(pipelineState, "readRecipientPipelineEvidence").mockImplementation((...args) => {
      const result = read(...args);
      if (!changed) { changed = true; queueMicrotask(() => {
        Object.assign(owner.runs[0]!.attempts[0]!, identity === "path" ? { agentPath: artifactPath } : { sessionId });
        persist();
      }); }
      return result;
    });
    try {
      expect(registry.conversationMemberships(conversation.id)).toEqual([]);
      await expect(prepareStructuredStartupRecipient(registry, conversation.id, { orchestratorSeats: () => [] }, "original-owner-race"))
        .rejects.toThrow("recipient startup authority changed");
      expect(changed).toBe(true);
    } finally {
      reader.mockRestore(); registry.close();
      if (oldState === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = oldState;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

for (const kind of ["unhosted", "live"] as const)
for (const identity of ["path", "session"] as const)
for (const archived of [false, true])
for (const timing of ["initial", "publication", "dispatch"] as const)
  test.skipIf(process.platform === "win32")(`suspended ${identity} owner retains ${kind} HTTP operation (${archived ? "archived" : "active"}, ${timing})`,
    () => addressedRecipientSocket(kind, "census", "none", { identity, archived, timing }));

for (const kind of ["unhosted", "live"] as const)
for (const identity of ["path", "session"] as const)
  test.skipIf(process.platform === "win32")(`unrelated suspended ${identity} owner permits ${kind} HTTP operation`,
    () => addressedRecipientSocket(kind, "census", "none", { identity, archived: true, timing: "initial", unrelated: true }));

for (const identity of ["path", "session"] as const)
for (const archived of [false, true])
for (const timing of ["initial", "publication"] as const)
  test.skipIf(process.platform === "win32")(`native reconnect independently refuses suspended ${identity} owner (${archived ? "archived" : "active"}, ${timing})`,
    () => addressedRecipientSocket("live", "census", "none", { identity, archived, timing, directReconnect: true }));
