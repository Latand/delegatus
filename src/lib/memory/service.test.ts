import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { memoryIndex, refreshMemoryIndex } from "./service";

test("refresh builds only in Viewer state and a test with no explicit roots never discovers live memory", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-service-"));
  const previous = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(root, "state");
  const filename = path.join(root, "codex", "memories", "memory_summary.md");
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, "v1\n## User preferences\n- Keep widget reports brief.\n");
  const index = memoryIndex();
  try {
    expect(await refreshMemoryIndex()).toBeUndefined();
    expect(fs.existsSync(process.env.LLV_STATE_DIR)).toBe(false);
    const roots = { claudeHomes: [], codexHome: path.join(root, "codex"), skillRoots: [] };
    expect(await refreshMemoryIndex(roots)).toMatchObject({ filesRead: 1, entriesIndexed: 1 });
    expect((await index.search({ query: "widget" })).items).toHaveLength(1);
    expect(await refreshMemoryIndex(roots)).toMatchObject({ filesRead: 0 });
    expect(fs.readdirSync(path.dirname(filename))).toEqual(["memory_summary.md"]);
    for (const name of fs.readdirSync(process.env.LLV_STATE_DIR)) {
      expect(name).toMatch(/^memory-index\.sqlite(?:-wal|-shm)?$/);
      expect(fs.statSync(path.join(process.env.LLV_STATE_DIR, name)).mode & 0o777).toBe(0o600);
    }
  } finally {
    index.close();
    if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
