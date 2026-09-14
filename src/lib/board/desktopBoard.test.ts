import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { boardKeysChanged, DESKTOP_BOARD_KEY, mutationKeys, VIEW_MODE_KEY } from "./keys";
import { applyBoardMutations } from "./mutations";
import { boardFor, mutateBoard } from "./store";
import { validateBoardPatchPayload } from "./validation";

/* The desktop board face (#1695): one optional preference beside `viewMode`,
   written through the existing presentation mutation. Every write here goes to
   a temporary board file, never the operator's state directory. */

function temporaryFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "llv-desktop-board-")), "board.json");
}

const body = (mutation: Record<string, unknown>) => ({ schemaVersion: 1, project: "fixture", baseRevision: 0, mutations: [mutation] });

test("set-presentation accepts the kanban face, an explicit scheme, or the default, and refuses any other value", () => {
  const parsed = validateBoardPatchPayload(body({ kind: "set-presentation", desktopBoard: "kanban", viewMode: "scheme" }));
  expect(parsed.mutations).toEqual([{ kind: "set-presentation", viewMode: "scheme", desktopBoard: "kanban" }]);
  expect(validateBoardPatchPayload(body({ kind: "set-presentation", desktopBoard: "scheme" })).mutations).toEqual([{ kind: "set-presentation", desktopBoard: "scheme" }]);
  expect(validateBoardPatchPayload(body({ kind: "set-presentation", desktopBoard: null })).mutations).toEqual([{ kind: "set-presentation", desktopBoard: null }]);
  expect(() => validateBoardPatchPayload(body({ kind: "set-presentation", desktopBoard: "grid" }))).toThrow("desktopBoard");
});

test("the face is its own causal key, apart from the view mode", () => {
  expect(mutationKeys({ kind: "set-presentation", desktopBoard: "kanban" })).toEqual([DESKTOP_BOARD_KEY]);
  expect(mutationKeys({ kind: "set-presentation", desktopBoard: "kanban", viewMode: "scheme" }).sort()).toEqual([DESKTOP_BOARD_KEY, VIEW_MODE_KEY].sort());
  const file = temporaryFile();
  const before = boardFor("fixture", file);
  const after = applyBoardMutations(before, [{ kind: "set-presentation", desktopBoard: "kanban" }]);
  expect(after.prefs.desktopBoard).toBe("kanban");
  expect([...boardKeysChanged(before, after)]).toEqual([DESKTOP_BOARD_KEY]);
  const cleared = applyBoardMutations(after, [{ kind: "set-presentation", desktopBoard: null }]);
  expect(cleared.prefs.desktopBoard).toBeNull();
  expect([...boardKeysChanged(after, cleared)]).toEqual([DESKTOP_BOARD_KEY]);
});

test("the choice persists across a reload and leaves the phone's view mode alone", () => {
  const file = temporaryFile();
  const chosen = mutateBoard("fixture", 0, [{ kind: "set-presentation", desktopBoard: "kanban", viewMode: "scheme" }], file);
  expect(chosen).toMatchObject({ ok: true, board: { revision: 1 } });
  const reloaded = boardFor("fixture", file);
  expect(reloaded.prefs.desktopBoard).toBe("kanban");
  expect(reloaded.prefs.viewMode).toBe("scheme");
  const back = mutateBoard("fixture", 1, [{ kind: "set-presentation", desktopBoard: "scheme" }], file);
  expect(back).toMatchObject({ ok: true });
  expect(boardFor("fixture", file).prefs.desktopBoard).toBe("scheme");
  expect(boardFor("fixture", file).prefs.viewMode).toBe("scheme");
});

test("a board file without the key, and one with a key this build does not know, both load", () => {
  const file = temporaryFile();
  const legacy = { schemaVersion: 1, revision: 3, updatedAt: "2026-09-14T10:00:00.000Z", prefs: { manual: [], hidden: [], expanded: [], viewMode: "list", taskPanelOpen: false } };
  fs.writeFileSync(file, JSON.stringify({ projects: { fixture: legacy } }));
  expect(boardFor("fixture", file).prefs.desktopBoard ?? null).toBeNull();
  /* The rollback property: an unknown optional prefs key is carried, never a
     reason to refuse the whole file. The same validator shape shipped before
     the kanban key existed, which is what makes rolling back past it safe. */
  fs.writeFileSync(file, JSON.stringify({ projects: { fixture: { ...legacy, prefs: { ...legacy.prefs, desktopBoard: "kanban", someLaterKey: true } } } }));
  const loaded = boardFor("fixture", file);
  expect(loaded.revision).toBe(3);
  expect(loaded.prefs.viewMode).toBe("list");
  expect(loaded.prefs.desktopBoard).toBe("kanban");
});

test("a face a later build names loads here as data, and the rest of the board file with it", () => {
  const file = temporaryFile();
  const later = { schemaVersion: 1, revision: 7, updatedAt: "2026-09-14T10:00:00.000Z", prefs: { manual: ["/a.jsonl"], hidden: [], expanded: [], viewMode: "scheme", desktopBoard: "a-face-from-a-later-build", taskPanelOpen: false } };
  const other = { schemaVersion: 1, revision: 2, updatedAt: "2026-09-14T10:00:00.000Z", prefs: { manual: [], hidden: [], expanded: [], viewMode: "list", taskPanelOpen: true } };
  fs.writeFileSync(file, JSON.stringify({ projects: { fixture: later, neighbour: other } }));
  expect(boardFor("fixture", file)).toMatchObject({ revision: 7, prefs: { manual: ["/a.jsonl"], desktopBoard: "a-face-from-a-later-build" } });
  expect(boardFor("neighbour", file)).toMatchObject({ revision: 2, prefs: { viewMode: "list", taskPanelOpen: true } });
  /* A write in this build keeps the value it does not understand. */
  expect(mutateBoard("fixture", 7, [{ kind: "set-favorite", id: "conversation_x", favorite: true }], file)).toMatchObject({ ok: true });
  expect(boardFor("fixture", file).prefs.desktopBoard).toBe("a-face-from-a-later-build");
});
