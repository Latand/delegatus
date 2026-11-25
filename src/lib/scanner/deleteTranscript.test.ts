import { expect, test, spyOn } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as claudeAccounts from "@/lib/accounts/claude";
import { removeTranscriptFromDisk, removeProjectTranscriptsFromDisk } from "./deleteTranscript";

test("bulk transcript staging rolls every path back when the commit cannot complete", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "llv-project-delete-"));
  const present = path.join(dir, "present.jsonl");
  const missing = path.join(dir, "missing.jsonl");
  await fs.writeFile(present, "session\n");
  try {
    await expect(removeProjectTranscriptsFromDisk([present, missing])).rejects.toThrow();
    expect(await fs.readFile(present, "utf8")).toBe("session\n");
    expect((await fs.readdir(dir)).some((name) => name.includes(".llv-delete-"))).toBe(false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("bulk transcript cleanup restores a failed item and continues the remaining cleanup", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "llv-project-cleanup-"));
  const first = path.join(dir, "first.jsonl");
  const second = path.join(dir, "second.jsonl");
  await fs.writeFile(first, "first\n");
  await fs.writeFile(second, "second\n");
  let removals = 0;
  try {
    await expect(removeProjectTranscriptsFromDisk([first, second], {
      rename: fs.rename,
      rm: async (...args: Parameters<typeof fs.rm>) => {
        removals += 1;
        if (removals === 1) throw new Error("injected cleanup failure");
        return fs.rm(...args);
      },
    })).rejects.toThrow("project deletion cleanup failed");
    expect(await fs.readFile(first, "utf8")).toBe("first\n");
    expect(await fs.stat(second).then(() => true, () => false)).toBe(false);
    expect((await fs.readdir(dir)).some((name) => name.includes(".llv-delete-"))).toBe(false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});


for (const bulk of [false, true]) test(`deleting native context also removes its image artifacts (bulk=${bulk})`, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-context-delete-"));
  const project = path.join(root, "project");
  const transcript = path.join(project, "session.jsonl");
  const artifact = path.join(project, "session", "tool-results", "image.png");
  await fs.mkdir(path.dirname(artifact), { recursive: true, mode: 0o700 });
  await fs.writeFile(transcript, "context", { mode: 0o600 });
  await fs.writeFile(artifact, "fixture-image", { mode: 0o600 });
  const roots = spyOn(claudeAccounts, "claudeProjectRoots").mockReturnValue([root]);
  try {
    if (bulk) await removeProjectTranscriptsFromDisk([transcript]); else await removeTranscriptFromDisk(transcript);
    expect(await fs.stat(transcript).then(() => true, () => false)).toBe(false);
    expect(await fs.stat(artifact).then(() => true, () => false)).toBe(false);
  } finally { roots.mockRestore(); await fs.rm(root, { recursive: true, force: true }); }
});


test("context deletion can retry artifact cleanup after the transcript is already gone", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-context-retry-"));
  const transcript = path.join(root, "project", "session.jsonl");
  const companion = transcript.slice(0, -6);
  await fs.mkdir(path.join(companion, "tool-results"), { recursive: true });
  await fs.writeFile(path.join(companion, "tool-results", "image.png"), "fixture-image");
  const roots = spyOn(claudeAccounts, "claudeProjectRoots").mockReturnValue([root]);
  try {
    await removeTranscriptFromDisk(transcript);
    expect(await fs.stat(companion).then(() => true, () => false)).toBe(false);
  } finally { roots.mockRestore(); await fs.rm(root, { recursive: true, force: true }); }
});
