import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { savePipelines } from "@/lib/pipelines/store";
import { FileTransactionAdmissionError, withFileTransaction } from "@/lib/state/fileTransaction";
import * as pipelineState from "@/lib/state/sqliteStateStore";
import { prepareStructuredStartupRecipient } from "./startup";
import { interruptionObligationDirectory, initializeRecipientInterruptionIndex } from "./interruptionObligations";
import { StructuredRecoveryHeldForUpdateError } from "./structuredRecovery";
import { structuredRestartFixture, recipientDispatchPipeline, addressedRecipientSocket } from "./startupRecipient.fixture";

setDefaultTimeout(60_000);

for (const [fault, category] of [
  ["lock", "journal lock busy"],
  ["pending journal symlink loop", "pending journal inspection failed"],
  ["lock queue path is a file", "journal lock setup failed"],
  ["missing marker", "source marker missing or mismatched"],
  ["mismatched marker", "source marker missing or mismatched"],
  ["journal", "pending journal changed"],
  ["index", "recipient index invalid or unavailable"],
] as const) {
  test(`recipient preparation reports redacted interruption evidence for ${fault}`, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "recipient-evidence-"));
    const oldState = process.env.LLV_STATE_DIR; process.env.LLV_STATE_DIR = directory;
    const { registry, conversation } = structuredRestartFixture(directory, "codex", "unhosted");
    const obligations = interruptionObligationDirectory(registry.filename);
    const pending = `${obligations}.pending.jsonl`;
    const diagnostic = spyOn(console, "error").mockImplementation(() => {});
    try {
      savePipelines([]);
      await initializeRecipientInterruptionIndex(obligations);
      if (fault === "missing marker") fs.unlinkSync(obligations);
      if (fault === "mismatched marker") fs.writeFileSync(obligations, "unreadable marker payload");
      if (fault === "journal") fs.appendFileSync(pending, "changed journal payload\n");
      if (fault === "pending journal symlink loop") {
        fs.unlinkSync(pending);
        fs.symlinkSync(path.basename(pending), pending);
      }
      if (fault === "lock queue path is a file") {
        fs.rmSync(`${pending}.write-locks`, { recursive: true, force: true });
        fs.writeFileSync(`${pending}.write-locks`, "not a directory");
      }
      if (fault === "index") {
        const db = new Database(path.join(directory, "state.sqlite"));
        try { db.exec("DROP INDEX state_rows_interruption_recipient_v3"); } finally { db.close(); }
      }
      const message = `recipient interruption evidence is unavailable or incomplete (${category})`;
      const check = async () => {
        for (let attempt = 0; attempt < 2; attempt++) {
          const result = await prepareStructuredStartupRecipient(registry, conversation.id, { orchestratorSeats: () => [] })
            .catch((error: unknown) => error);
          expect(result).toBeInstanceOf(StructuredRecoveryHeldForUpdateError);
          if (!(result instanceof Error)) throw new Error("unsafe recipient evidence was accepted");
          expect(result.message).toBe(message);
          expect(result.cause).toBeInstanceOf(Error);
          const cause = result.cause as Error;
          expect(cause.message).toBe(message);
          if (fault === "lock") expect(cause.cause).toBeInstanceOf(FileTransactionAdmissionError);
          if (fault === "pending journal symlink loop") expect((cause.cause as NodeJS.ErrnoException).code).toBe("ELOOP");
          if (fault === "lock queue path is a file") expect((cause.cause as NodeJS.ErrnoException).code).toBe("EEXIST");
          if (fault === "mismatched marker") expect(cause.cause).toBeInstanceOf(SyntaxError);
          if (fault === "index") expect((cause.cause as Error).message).toBe("interruption source index is incomplete or incompatible");
        }
      };
      if (fault === "lock") await withFileTransaction(pending, "fixture lock busy", check);
      else await check();
      expect(diagnostic.mock.calls).toEqual([[`[structured hosts] ${message}`]]);
    } finally {
      diagnostic.mockRestore(); registry.close();
      if (oldState === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = oldState;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}

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
