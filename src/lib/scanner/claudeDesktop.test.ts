import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeDesktopChatForPath, loadClaudeDesktopChats, projectClaudeDesktopChats } from "./claudeDesktop";

const parentId = `local_${crypto.randomUUID()}`;
const childId = `local_${crypto.randomUUID()}`;
const parentCli = crypto.randomUUID();
const priorCli = crypto.randomUUID();
const childCli = crypto.randomUUID();

test("imports Desktop titles and recorded parentage, including a resumed parent", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "desktop-chats-"));
  try {
    const account = path.join(root, "org", "user");
    mkdirSync(account, { recursive: true });
    writeFileSync(path.join(account, parentId + ".json"), JSON.stringify({
      sessionId: parentId, cliSessionId: parentCli, priorCliSessionIds: [priorCli], title: "Main review",
    }));
    writeFileSync(path.join(account, childId + ".json"), JSON.stringify({
      sessionId: childId, cliSessionId: childCli, title: "Account trust",
      spawnedFrom: { sessionId: parentId, title: "Launch brief" },
    }));
    const parsed = new Map();
    const chats = loadClaudeDesktopChats(root, parsed);
    const row = (id: string, project = "app"): Parameters<typeof projectClaudeDesktopChats>[0][number] => ({
      path: `/projects/worktree/${id}.jsonl`, project, engine: "claude", kind: "session", mtime: 1,
    });
    const parent = row(parentCli);
    const previous = row(priorCli);
    const child = row(childCli);
    expect(claudeDesktopChatForPath(previous.path, chats)?.title).toBe("Main review");
    expect(projectClaudeDesktopChats([previous, child, parent], chats)).toEqual([
      { ...child, parent: parent.path }, parent,
    ]);
    expect(projectClaudeDesktopChats([child, previous], chats)).toEqual([
      { ...child, parent: previous.path }, previous,
    ]);
    expect(projectClaudeDesktopChats([child, { ...parent, project: "other" }], chats)[0]).toEqual(child);
    expect(loadClaudeDesktopChats(root, parsed).get(parentCli)).toBe(chats.get(parentCli));
    writeFileSync(path.join(account, parentId + ".json"), JSON.stringify({
      sessionId: parentId, cliSessionId: parentCli, title: "Updated main review",
    }));
    const refreshed = loadClaudeDesktopChats(root, parsed);
    expect(refreshed.get(parentCli)?.title).toBe("Updated main review");
    expect(refreshed.get(childCli)).toBe(chats.get(childCli));
    expect(refreshed.has(priorCli)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
