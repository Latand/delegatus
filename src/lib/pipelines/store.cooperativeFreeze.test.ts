import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  archiveSettledPipelines, buildPipeline, loadArchivedPipelinesForListAsync,
  loadPipelinesForListAsync, savePipelines,
} from "./store";

function lane(id: string, archived: boolean) {
  const value = buildPipeline({ id, task: id, project: "freeze-fixture", repoDir: "/repo",
    stages: [{ id: "build", kind: "run", prompt: "Build", next: null,
      effectiveRole: { roleId: null, engine: "codex", model: "gpt-6.1-sol", effort: "high", access: "read-only", promptScaffold: null } }],
    srcPath: null, srcConversationId: null, now: "2026-07-01T00:00:00.000Z" });
  if (archived) { value.state = "closed"; value.cursor = null; value.closedAt = "2026-07-02T00:00:00.000Z"; }
  return value;
}

for (const archived of [false, true]) {
  test(`a warm ${archived ? "archive" : "hot"} list yields for changed records without revisiting frozen history`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-freeze-incremental-"));
    const previous = process.env.LLV_STATE_DIR;
    process.env.LLV_STATE_DIR = root;
    let beat: ReturnType<typeof setImmediate> | undefined;
    try {
      savePipelines(Array.from({ length: 128 }, (_, index) => lane(`retained-${index}`, archived)));
      if (archived) await archiveSettledPipelines(Date.parse("2026-08-01T00:00:00Z"));
      const read = archived ? loadArchivedPipelinesForListAsync : loadPipelinesForListAsync;
      let coldTurns = 0;
      const coldHeartbeat = () => { coldTurns += 1; beat = setImmediate(coldHeartbeat); };
      beat = setImmediate(coldHeartbeat);
      const before = await read();
      clearImmediate(beat);
      beat = undefined;
      expect(before).toHaveLength(128);
      expect(before.every(row => Object.isFrozen(row.stages[0]!.effectiveRole))).toBe(true);
      expect(coldTurns).toBeGreaterThan(0);

      // A separate writer preserves this reader's frozen cache while changing
      // the real SQLite revision, as a Viewer and a worker do in production.
      const added = lane("new-record", archived);
      const program = `import { savePipelines, withPipelineMutation, archiveSettledPipelines } from ${JSON.stringify(pathToFileURL(path.join(import.meta.dir, "store.ts")).href)};
        const added = ${JSON.stringify(added)};
        if (${archived}) {
          savePipelines([added]);
          await archiveSettledPipelines(Date.parse("2026-08-01T00:00:00Z"));
        } else {
          await withPipelineMutation(async (rows, persist) => { rows.push(added); await persist(); });
        }`;
      const writer = Bun.spawn([process.execPath, "-e", program], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
      const [code, stderr] = await Promise.all([writer.exited, new Response(writer.stderr).text(), new Response(writer.stdout).text()]);
      expect(code, stderr).toBe(0);

      let turns = 0;
      const heartbeat = () => { turns += 1; beat = setImmediate(heartbeat); };
      beat = setImmediate(heartbeat);
      const after = await read();
      clearImmediate(beat);
      beat = undefined;

      expect(after).toHaveLength(129);
      expect(after.find(row => row.id === before[0]!.id)).toBe(before[0]);
      const fresh = after.find(row => row.id === added.id)!;
      expect(Object.isFrozen(after)).toBe(true);
      expect(Object.isFrozen(fresh.stages[0]!.effectiveRole)).toBe(true);
      expect(() => { fresh.stages[0]!.prompt = "changed by reader"; }).toThrow();
      // Each event-loop turn can contain unrelated server work. One changed
      // record must not wait through a turn for every unchanged history row.
      expect(turns).toBeLessThan(10);
    } finally {
      if (beat) clearImmediate(beat);
      if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
