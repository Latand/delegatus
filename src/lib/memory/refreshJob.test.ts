import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryIndex } from "./index";
import { refreshMemoryInHelper } from "./refreshJob";

const previous = { state: process.env.LLV_STATE_DIR, lease: process.env.LLV_HELPER_LEASE_ENTRY };
const directories: string[] = [];
afterEach(() => {
  if (previous.state === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous.state;
  if (previous.lease === undefined) delete process.env.LLV_HELPER_LEASE_ENTRY; else process.env.LLV_HELPER_LEASE_ENTRY = previous.lease;
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "memory-refresh-helper-"));
  directories.push(directory);
  process.env.LLV_STATE_DIR = path.join(directory, "state");
  const roots = { claudeHomes: [], codexHome: path.join(directory, "codex"), skillRoots: [] };
  const file = path.join(roots.codexHome, "memories", "memory_summary.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "v1\n## User preferences\n- Preserve widget evidence.\n");
  return { directory, roots, file };
}

test("a leased refresh joins concurrent requests, survives helper restart and exposes committed changes to a held reader", async () => {
  const { roots, file } = fixture();
  const first = refreshMemoryInHelper(roots);
  expect(refreshMemoryInHelper(roots)).toBe(first);
  await expect(refreshMemoryInHelper({ ...roots, codexHome: roots.codexHome + "-other" })).rejects.toThrow("already running");
  expect(await first).toEqual({ filesRead: 1, entriesIndexed: 1, filesSkipped: 0, filesFailed: 0 });
  const reader = new MemoryIndex();
  try {
    expect((await reader.search({ query: "widget" })).items).toHaveLength(1);
    // Each call starts a real new helper. Its persisted identity skips unchanged input.
    expect(await refreshMemoryInHelper(roots)).toMatchObject({ filesRead: 0, filesSkipped: 1 });
    fs.writeFileSync(file, "v1\n## User preferences\n- Preserve replacement evidence.\n");
    expect(await refreshMemoryInHelper(roots)).toMatchObject({ filesRead: 1, entriesIndexed: 1 });
    expect((await reader.search({ query: "widget" })).items).toEqual([]);
    expect((await reader.search({ query: "replacement" })).items).toHaveLength(1);
  } finally { reader.close(); }
}, 30_000);

test("helper launch refusal evicts the failed request and permits the same roots to retry", async () => {
  const { directory, roots } = fixture();
  process.env.LLV_HELPER_LEASE_ENTRY = path.join(directory, "missing-lease.mjs");
  await expect(refreshMemoryInHelper(roots)).rejects.toThrow();
  if (previous.lease === undefined) delete process.env.LLV_HELPER_LEASE_ENTRY; else process.env.LLV_HELPER_LEASE_ENTRY = previous.lease;
  expect(await refreshMemoryInHelper(roots)).toMatchObject({ filesRead: 1, entriesIndexed: 1 });
  await expect(refreshMemoryInHelper({ ...roots, projectForSlug: value => value })).rejects.toThrow("serializable roots");
}, 30_000);
