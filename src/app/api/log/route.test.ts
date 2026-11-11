import { afterAll, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

import type { FileEntry, LogChunk } from "@/lib/types";

import { soloBrowserSession } from "@/lib/agent/operatorSession";
import { ownerTranscriptMayExist, transcriptDeletionBlocker } from "@/lib/scanner/deleteSafety";
import { MAX_CHUNK } from "@/lib/scanner/roots";

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "log-route-"));
const previousCodexHome = process.env.LLV_CODEX_HOME;
process.env.LLV_CODEX_HOME = sandbox;
afterAll(async () => {
  if (previousCodexHome === undefined) delete process.env.LLV_CODEX_HOME;
  else process.env.LLV_CODEX_HOME = previousCodexHome;
  await fs.rm(sandbox, { recursive: true, force: true });
});
const { GET } = await import("./route");

async function history(file: string, before: number): Promise<LogChunk> {
  const origin = "http://127.0.0.1:8899";
  const response = await GET(new NextRequest(`${origin}/api/log?path=${encodeURIComponent(file)}&before=${before}`, {
    headers: { cookie: `llv_operator=${soloBrowserSession()}`, origin, host: "127.0.0.1:8899" },
  }));
  expect(response.status).toBe(200);
  return response.json();
}

for (const character of ["Ж", "€", "😀"]) {
  const width = Buffer.byteLength(character);
  for (let split = 1; split < width; split += 1) {
    test(`history preserves a ${width}-byte character split after byte ${split}`, async () => {
      const text = "head" + character + "z".repeat(MAX_CHUNK - (width - split));
      const file = path.join(sandbox, "sessions", `history-${width}-${split}.jsonl`);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, text);
      const last = await history(file, Buffer.byteLength(text));
      expect(last.data).toBe("z".repeat(MAX_CHUNK - (width - split)));
      expect(last.start).toBe(4 + width);
      expect(last.offset).toBe(last.start);
      const first = await history(file, last.offset);
      expect(first).toEqual({ start: 0, offset: 0, size: Buffer.byteLength(text), data: "head" + character });
      expect(first.data + last.data).toBe(text);
    });
  }
}

function entry(path: string, proc: FileEntry["proc"], activity: FileEntry["activity"]): FileEntry {
  return {
    path, root: "claude-projects", name: path, project: "project-a", title: "Session",
    engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: 1, size: 1,
    activity, proc, pid: null, model: null, pendingQuestion: null, waitingInput: null,
  };
}

test("deleting a Claude subagent is refused while its owning session is active", async () => {
  const child = "/projects/project-a/session-1/subagents/agent-child.jsonl";
  const owner = "/projects/project-a/session-1.jsonl";
  const blocker = await transcriptDeletionBlocker(child, {
    ownerPath: () => owner,
    ownerExists: async () => true,
    processMayBeRunning: () => false,
    list: async (pin) => pin === owner
      ? [entry(owner, "running", "live")]
      : [entry(child, null, "recent")],
  });

  expect(blocker).toBe("owning agent is still running — stop the process first");
});

test("deleting a live transcript is refused when PID attribution is absent", async () => {
  const target = "/projects/project-a/session-2.jsonl";
  const blocker = await transcriptDeletionBlocker(target, {
    ownerPath: () => null,
    ownerExists: async () => false,
    processMayBeRunning: () => false,
    list: async () => [entry(target, null, "live")],
  });

  expect(blocker).toBe("agent is still running — stop the process first");
});

test("deletion refuses an idle transcript with fresh process ownership evidence", async () => {
  const target = "/projects/project-a/session-3.jsonl";
  const blocker = await transcriptDeletionBlocker(target, {
    ownerPath: () => null,
    ownerExists: async () => false,
    processMayBeRunning: () => true,
    list: async () => [entry(target, null, "idle")],
  });

  expect(blocker).toBe("agent is still running — stop the process first");
});

test("owner lookup treats confirmed disappearance as absent and transient stat failures as present", async () => {
  const missing = async () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); };
  const uncertain = async () => { throw Object.assign(new Error("busy"), { code: "EMFILE" }); };

  expect(await ownerTranscriptMayExist("/owner.jsonl", missing)).toBe(false);
  expect(await ownerTranscriptMayExist("/owner.jsonl", uncertain)).toBe(true);
});
