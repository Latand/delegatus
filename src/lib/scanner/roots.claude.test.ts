import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-claude-roots-test-"));
const OLD_STATE = process.env.LLV_STATE_DIR; const OLD_HOME = process.env.LLV_CLAUDE_HOME;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state"); process.env.LLV_CLAUDE_HOME = path.join(SANDBOX, "legacy");
const { createManagedClaudeAccount } = await import("@/lib/accounts/claude");
const { claudeProjectRootFor, scanRootEntries, pathAllowed } = await import("./roots");

afterAll(() => { if (OLD_STATE === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = OLD_STATE; if (OLD_HOME === undefined) delete process.env.LLV_CLAUDE_HOME; else process.env.LLV_CLAUDE_HOME = OLD_HOME; fs.rmSync(SANDBOX, { recursive: true, force: true }); });

test("scanner adds every Claude account projects root once and preserves its root type", () => {
  const a = createManagedClaudeAccount("A"); const b = createManagedClaudeAccount("B");
  const pathA = path.join(a.projectsDir, "repo", "a.jsonl"); fs.mkdirSync(path.dirname(pathA), { recursive: true }); fs.writeFileSync(pathA, "{}");
  const roots = scanRootEntries().filter(([kind]) => kind === "claude-projects").map(([, root]) => root);
  expect(roots).toContain(a.projectsDir); expect(roots).toContain(b.projectsDir);
  expect(new Set(roots.map((root) => fs.existsSync(root) ? fs.realpathSync(root) : path.resolve(root))).size).toBe(roots.length);
  expect(claudeProjectRootFor(pathA)).toBe(a.projectsDir);
});

test("relay sessions are refused beside a readable ordinary Claude project", () => {
  const a = createManagedClaudeAccount("Relay fixture");
  const hidden = path.join(a.projectsDir, "-tmp-llv-relay-conv-00000000-0000-0000-0000-000000000000", "session.jsonl");
  const ordinary = path.join(a.projectsDir, "ordinary", "session.jsonl");
  for (const file of [hidden, ordinary]) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "{}"); }
  expect(pathAllowed(hidden)).toBe(false); expect(pathAllowed(ordinary)).toBe(true);
});


test("album root snapshots keep realpath and relay refusals current within a read", async () => {
  const { productionAlbumWorld } = await import("@/lib/taskAlbum/world");
  const account = createManagedClaudeAccount("Album fixture");
  const ordinary = path.join(account.projectsDir, "album", "ordinary.jsonl");
  const hidden = path.join(account.projectsDir, "-tmp-llv-relay-conv-00000000-0000-0000-0000-000000000000", "album.jsonl");
  const outside = path.join(SANDBOX, "outside.jsonl");
  const link = path.join(account.projectsDir, "album", "link.jsonl");
  for (const file of [ordinary, hidden, outside]) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "{}"); }
  fs.symlinkSync(ordinary, link);
  const album = productionAlbumWorld();
  for (const [file, allowed] of [[ordinary, true], [hidden, false], [outside, false], [link, true]] as const) {
    expect(pathAllowed(file)).toBe(allowed);
    expect(album.transcriptAllowed(file)).toBe(allowed);
  }
  await Promise.resolve();
  fs.unlinkSync(link); fs.symlinkSync(outside, link);
  expect(pathAllowed(link)).toBe(false);
  expect(album.transcriptAllowed(link)).toBe(false);
  fs.unlinkSync(ordinary);
  expect(album.transcriptAllowed(ordinary)).toBe(false);
  const added = createManagedClaudeAccount("Later album fixture");
  const addedPath = path.join(added.projectsDir, "album", "new.jsonl");
  fs.mkdirSync(path.dirname(addedPath), { recursive: true }); fs.writeFileSync(addedPath, "{}");
  expect(album.transcriptAllowed(addedPath)).toBe(false);
  expect(productionAlbumWorld().transcriptAllowed(addedPath)).toBe(true);
});
