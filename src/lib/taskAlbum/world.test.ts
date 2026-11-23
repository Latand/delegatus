import { afterAll, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "album-world-"));
const savedState = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = root;
const { AgentRegistry } = await import("@/lib/agent/registry");
const { buildPipeline, savePipelines, archiveSettledPipelines } = await import("@/lib/pipelines/store");
const { saveTasks } = await import("@/lib/tasks/store");
const { productionAlbumWorld } = await import("./world");
const { taskAlbumTranscripts } = await import("./sources");
const { readTaskAlbum } = await import("./album");
const { fileAlbumSeenStore } = await import("./seen");
const { resetTranscriptIndex } = await import("./transcriptIndex");

const transcript = path.join(root, "selected.jsonl");
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
fs.writeFileSync(transcript, JSON.stringify({ type: "user", timestamp: "2026-10-01T00:00:00Z", message: { role: "user", content: [
  { type: "image", source: { type: "base64", media_type: "image/png", data: png } },
] } }) + "\n");
saveTasks([{ id: "selected", project: "fixture", status: "assigned", text: "Selected album", placement: "unplaced",
  assignments: [{ path: transcript, panePid: null, state: "linked", error: null, at: "2026-10-01T00:00:00Z" }],
  createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" }]);
const lane = (id: string, taskId: string) => buildPipeline({ id, task: "Album source", project: "fixture", repoDir: "/repo",
  stages: [], srcPath: null, srcConversationId: null, now: "2026-10-01T00:00:00Z", state: "draft", taskIds: [taskId] });
const archived = lane("archive-selected", "selected");
archived.state = "closed"; archived.closedAt = "2026-10-02T00:00:00Z"; archived.hiddenAt = archived.closedAt;
const seeded = [lane("active-selected", "selected"), archived,
  ...Array.from({ length: 20 }, (_, i) => ({ ...lane(`unrelated-${i}`, "another"), spec: "unrelated-album-history ".repeat(100) }))];
savePipelines(seeded);
await archiveSettledPipelines(Date.parse("2026-11-01T00:00:00Z"));
const peer = new Database(path.join(root, "state.sqlite"));

afterAll(() => {
  peer.close(); resetTranscriptIndex();
  if (savedState === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = savedState;
  fs.rmSync(root, { recursive: true, force: true });
});

test("a cold album reads its image without decoding unrelated history or building a registry snapshot", async () => {
  const snapshot = spyOn(AgentRegistry.prototype, "readOnlySnapshot");
  const parse = JSON.parse;
  let unrelated = 0;
  const decoding = spyOn(JSON, "parse").mockImplementation((text, reviver) => {
    if (typeof text === "string" && text.includes("unrelated-album-history")) unrelated++;
    return parse(text, reviver);
  });
  try {
    const world = productionAlbumWorld();
    // The fixture's private transcript stands in for an admitted scanner root.
    world.transcriptAllowed = p => p === transcript;
    const album = await readTaskAlbum("selected", {}, { world, seen: fileAlbumSeenStore(path.join(root, "seen.json")) });
    expect(album.total).toBe(1);
    expect(album.indexing).toBe(false);
    expect(taskAlbumTranscripts("selected", world).map(row => row.path)).toEqual([transcript]);
    expect(snapshot).not.toHaveBeenCalled();
    expect(unrelated).toBe(0);
  } finally { decoding.mockRestore(); snapshot.mockRestore(); }
});

test("task-local selection includes archived lanes and refreshes peer membership writes and deletes", () => {
  const ids = () => productionAlbumWorld().pipelines("selected").map(pipeline => pipeline.id);
  expect(ids()).toEqual(["active-selected", "archive-selected"]);
  // Raw peer writes intentionally leave collection revisions unchanged.
  peer.query("UPDATE state_rows SET value_json=json_set(value_json,'$.taskIds',json(?)) WHERE collection='pipelines' AND row_key=?")
    .run('["selected"]', "unrelated-0");
  expect(ids()).toEqual(["active-selected", "unrelated-0", "archive-selected"]);
  peer.query("UPDATE state_rows SET value_json=json_set(value_json,'$.taskIds',json(?)) WHERE collection='pipelines' AND row_key=?")
    .run('["another"]', "active-selected");
  peer.query("DELETE FROM state_rows WHERE collection='pipelines_archive' AND row_key=?").run("archive-selected");
  expect(ids()).toEqual(["unrelated-0"]);
});

test("missing tasks remain empty and requests retain their task-local view", () => {
  const world = productionAlbumWorld();
  expect(world.task("missing")).toBeNull();
  expect(taskAlbumTranscripts("missing", world)).toEqual([]);
  const before = world.pipelines("selected");
  peer.query("UPDATE state_rows SET value_json=json_set(value_json,'$.taskIds',json(?)) WHERE collection='pipelines' AND row_key=?")
    .run('["another"]', "unrelated-0");
  expect(world.pipelines("selected")).toBe(before);
  expect(productionAlbumWorld().pipelines("selected")).toEqual([]);
});


test("membership refresh falls back to database changes when evidence triggers are unavailable", () => {
  const ids = () => productionAlbumWorld().pipelines("selected").map(pipeline => pipeline.id);
  peer.exec("DROP TRIGGER pipeline_evidence_update");
  expect(ids()).toEqual([]);
  peer.query("UPDATE state_rows SET value_json=json_set(value_json,'$.taskIds',json(?)) WHERE collection='pipelines' AND row_key=?")
    .run('["selected"]', "active-selected");
  expect(ids()).toEqual(["active-selected"]);
});


test("one metadata pass serves a board batch without decoding unrelated pipelines", () => {
  // Force a fresh generation, then exercise as many task lookups as the route admits.
  peer.query("UPDATE state_rows SET value_json=json_set(value_json,'$.taskIds',json(?)) WHERE collection='pipelines' AND row_key=?")
    .run('["another"]', "active-selected");
  const query = spyOn(Database.prototype, "query");
  try {
    const world = productionAlbumWorld();
    for (let i = 0; i < 400; i++) expect(world.pipelines(`absent-${i}`)).toEqual([]);
    const passes = query.mock.calls.filter(([sql]) => sql.includes("END AS task_ids"));
    expect(passes).toHaveLength(1);
  } finally { query.mockRestore(); }
});
