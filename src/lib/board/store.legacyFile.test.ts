import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { boardFor, mutateBoard } from "./store";

/* #1870 slice 3: what a legacy board.json does to the store, driven only
   through the store API that predates the move, so a case that fails on the
   old JSON store fails on its behaviour. Every case uses its own mkdtemp
   directory, never the live state directory. */

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function sandbox(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-board-legacy-"));
  dirs.push(dir);
  return { dir, file: path.join(dir, "board.json") };
}

function projectState(manual: string[]): Record<string, unknown> {
  return {
    schemaVersion: 1,
    revision: 3,
    updatedAt: "2026-09-01T00:00:00.000Z",
    pathAliases: {},
    prefs: { manual, hidden: [], expanded: [], viewMode: null, taskPanelOpen: false },
  };
}

function siblings(dir: string, prefix: string): string[] {
  return fs.readdirSync(dir).filter((name) => name.startsWith(prefix));
}

describe("a legacy board.json on the SQLite store", () => {
  test("(b) a NUL-filled file serves an empty board, is kept aside, and the store keeps accepting writes", () => {
    const { dir, file } = sandbox();
    fs.writeFileSync(file, Buffer.alloc(4096, 0));

    expect(boardFor("repo", file)).toMatchObject({ revision: 0, prefs: { manual: [] } });

    const unreadable = siblings(dir, "board.json.unreadable-");
    expect(unreadable).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, unreadable[0]!)).every((byte) => byte === 0)).toBe(true);
    expect(mutateBoard("repo", 0, [{ kind: "restore", path: "/after-gap", placement: "manual" }], file))
      .toMatchObject({ ok: true, applied: true });
    expect(boardFor("repo", file).prefs.manual).toEqual(["/after-gap"]);
  });

  test("(e) an old-release writer after the import fails with EISDIR and nothing is lost", () => {
    const { dir, file } = sandbox();
    fs.writeFileSync(file, JSON.stringify({ projects: { repo: projectState(["/kept"]) } }));
    expect(boardFor("repo", file).prefs.manual).toEqual(["/kept"]);

    // The pre-#1870 store read the file, then renamed a temp file over it.
    expect(() => fs.readFileSync(file, "utf8")).toThrow(/EISDIR/);
    const temp = path.join(dir, ".board.json.old-writer.tmp");
    fs.writeFileSync(temp, JSON.stringify({ projects: {} }));
    expect(() => fs.renameSync(temp, file)).toThrow(/EISDIR|ENOTEMPTY|EEXIST/);

    expect(boardFor("repo", file).prefs.manual).toEqual(["/kept"]);
  });
});
