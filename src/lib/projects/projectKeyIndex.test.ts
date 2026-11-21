import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { savePipelines } from "@/lib/pipelines/store";
import { saveTasks } from "@/lib/tasks/store";
import { projectKeyIndexSnapshot } from "./projectKeyIndex";

const cacheKey = "__llvProjectKeyDatabase";
const cacheOwner = globalThis as typeof globalThis & Record<string, unknown>;
let root: string | undefined;
let previousState: string | undefined;

afterEach(() => {
  if (previousState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousState;
  previousState = undefined;
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
  delete cacheOwner[cacheKey];
});

test("hot revisions reuse archived membership until the archive revision advances", () => {
  previousState = process.env.LLV_STATE_DIR;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "project-key-index-"));
  process.env.LLV_STATE_DIR = root;
  delete cacheOwner[cacheKey];
  saveTasks([]);
  savePipelines([]);

  const filename = path.join(root, "state.sqlite");
  const db = new Database(filename);
  try {
    db.query(`INSERT INTO state_rows(collection,row_key,value_json,row_order,row_revision,controller_active)
      VALUES ('pipelines_archive','archive-lane','{"project":"archive-project-a"}',0,1,0)`).run();
    db.query("UPDATE state_collections SET revision=revision+1 WHERE collection='pipelines_archive'").run();
    expect(projectKeyIndexSnapshot().has("archive-project-a")).toBe(true);

    // Deliberately change stored membership without advancing its own revision.
    // A task write invalidates hot keys and must leave the archive cache alone.
    db.query("UPDATE state_rows SET value_json=? WHERE collection='pipelines_archive' AND row_key='archive-lane'")
      .run('{"project":"archive-project-b"}');
    saveTasks([{ id: "hot-task", project: "hot-project", text: "Hot task", status: "inbox", placement: "unplaced",
      assignments: [], createdAt: "2026-11-20T00:00:00.000Z", updatedAt: "2026-11-20T00:00:00.000Z" }]);
    const afterHotWrite = projectKeyIndexSnapshot();
    expect(afterHotWrite.has("hot-project")).toBe(true);
    expect(afterHotWrite.has("archive-project-a")).toBe(true);
    expect(afterHotWrite.has("archive-project-b")).toBe(false);

    db.query("UPDATE state_collections SET revision=revision+1 WHERE collection='pipelines_archive'").run();
    const afterArchiveWrite = projectKeyIndexSnapshot();
    expect(afterArchiveWrite.has("archive-project-a")).toBe(false);
    expect(afterArchiveWrite.has("archive-project-b")).toBe(true);
  } finally { db.close(); }
});
