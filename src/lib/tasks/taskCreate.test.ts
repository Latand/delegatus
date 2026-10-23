import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import { readAttachment, storeAttachment, sweepAttachments } from "./attachments";
import { createTask, patchTask, type RecentCreate } from "./commands";
import { defaultTaskDue, formatDue, fromDueInput, isOverdue, toDueInputValue } from "./helpers";
import { isTask, loadTasksFile, saveTasksFile } from "./store";
import type { BoardTask, TaskAttachment } from "./types";

const deps = { now: () => "2026-07-05T10:00:00.000Z", id: () => "task-new" };

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-taskcreate-"));
  return path.join(dir, "tasks.json");
}

describe("createTask placement matrix", () => {
  test("pinned requires a position", () => {
    const missing = createTask([], { project: "p", text: "t", placement: "pinned" }, [], deps);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.status).toBe(400);

    const ok = createTask([], { project: "p", text: "t", placement: "pinned", pos: { x: 1, y: 2 } }, [], deps);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.task.placement).toBe("pinned");
      expect(ok.task.pos).toEqual({ x: 1, y: 2 });
    }
  });

  test("unplaced forbids a position and stores none", () => {
    const bad = createTask([], { project: "p", text: "t", placement: "unplaced", pos: { x: 1, y: 2 } }, [], deps);
    expect(bad.ok).toBe(false);

    const ok = createTask([], { project: "p", text: "t", placement: "unplaced" }, [], deps);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.task.placement).toBe("unplaced");
      expect(ok.task.pos).toBeUndefined();
    }
  });

  test("a legacy body (pos, no placement) still creates a pinned task", () => {
    const ok = createTask([], { project: "p", text: "t", pos: { x: 5, y: 6 } }, [], deps);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.task.placement).toBe("pinned");
  });

  test("text is still required; attachments alone never create", () => {
    const att: TaskAttachment = { id: "a", sha256: "a".repeat(64), ext: "png", mime: "image/png", bytes: 3, createdAt: "now" };
    const res = createTask([], { project: "p", text: "   ", placement: "unplaced", attachments: [att] }, [], deps, );
    expect(res.ok).toBe(false);
  });
});

describe("createTask deadline validation", () => {
  test("dueAt and dueTz are both-or-neither", () => {
    const onlyAt = createTask([], { project: "p", text: "t", placement: "unplaced", dueAt: "2026-07-06T09:00:00Z" }, [], deps);
    expect(onlyAt.ok).toBe(false);
    const onlyTz = createTask([], { project: "p", text: "t", placement: "unplaced", dueTz: "Europe/Kyiv" }, [], deps);
    expect(onlyTz.ok).toBe(false);
  });

  test("a garbage IANA zone is rejected", () => {
    const res = createTask([], { project: "p", text: "t", placement: "unplaced", dueAt: "2026-07-06T09:00:00Z", dueTz: "Mars/Phobos" }, [], deps);
    expect(res.ok).toBe(false);
  });

  test("a valid deadline is normalized to a UTC instant", () => {
    const res = createTask([], { project: "p", text: "t", placement: "unplaced", dueAt: "2026-07-06T12:00:00+03:00", dueTz: "Europe/Kyiv" }, [], deps);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.task.dueAt).toBe("2026-07-06T09:00:00.000Z");
      expect(res.task.dueTz).toBe("Europe/Kyiv");
    }
  });
});

describe("createTask attachment refs", () => {
  test("a ref whose bytes are absent from the store is rejected", () => {
    const att: TaskAttachment = { id: "a", sha256: "b".repeat(64), ext: "png", mime: "image/png", bytes: 3, createdAt: "now" };
    const res = createTask([], { project: "p", text: "t", placement: "unplaced", attachments: [att] }, [], { ...deps, attachmentExists: () => false });
    expect(res.ok).toBe(false);
  });

  test("a ref present in the store is attached", () => {
    const att: TaskAttachment = { id: "a", sha256: "c".repeat(64), ext: "png", mime: "image/png", bytes: 3, createdAt: "now" };
    const res = createTask([], { project: "p", text: "t", placement: "unplaced", attachments: [att] }, [], { ...deps, attachmentExists: () => true });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.task.attachments).toEqual([att]);
  });
});

describe("clientRequestId idempotency", () => {
  test("a replay returns the same task and mints no twin", () => {
    const first = createTask([], { project: "p", text: "t", placement: "unplaced", clientRequestId: "req-1" }, [], deps);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error);
    const replay = createTask(first.tasks, { project: "p", text: "t", placement: "unplaced", clientRequestId: "req-1" }, first.recentCreates, { now: () => "later", id: () => "task-twin" });
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error(replay.error);
    expect(replay.replay).toBe(true);
    expect(replay.task.id).toBe(first.task.id);
    expect(replay.tasks.length).toBe(1);
  });

  test("the receipt survives a persisted round-trip (simulated restart)", () => {
    const filePath = tmpFile();
    const first = createTask([], { project: "p", text: "t", placement: "unplaced", clientRequestId: "req-2" }, [], deps);
    if (!first.ok) throw new Error(first.error);
    saveTasksFile({ tasks: first.tasks, recentCreates: first.recentCreates }, filePath);

    const reloaded = loadTasksFile(filePath);
    expect(reloaded.recentCreates).toEqual([{ clientRequestId: "req-2", taskId: "task-new" }]);
    const replay = createTask(reloaded.tasks, { project: "p", text: "t", placement: "unplaced", clientRequestId: "req-2" }, reloaded.recentCreates, deps);
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.task.id).toBe("task-new");
  });

  test("a replay after the referenced task was deleted creates a fresh task", () => {
    const recent: RecentCreate[] = [{ clientRequestId: "req-3", taskId: "gone" }];
    const res = createTask([], { project: "p", text: "t", placement: "unplaced", clientRequestId: "req-3" }, recent, deps);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.replay).toBe(false);
      expect(res.task.id).toBe("task-new");
    }
  });
});

describe("patchTask place-on-map and deadline", () => {
  const base: BoardTask = {
    id: "t1",
    project: "p",
    status: "inbox",
    text: "t",
    placement: "unplaced",
    assignments: [],
    createdAt: "2026-07-05T10:00:00.000Z",
    updatedAt: "2026-07-05T10:00:00.000Z",
  };

  test("a pos pins an unplaced task", () => {
    const res = patchTask([base], "t1", { placement: "pinned", pos: { x: 3, y: 4 } }, "now");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.task.placement).toBe("pinned");
      expect(res.task.pos).toEqual({ x: 3, y: 4 });
    }
  });

  test("dueAt:null clears the deadline", () => {
    const withDue: BoardTask = { ...base, dueAt: "2026-07-06T09:00:00.000Z", dueTz: "Europe/Kyiv" };
    const res = patchTask([withDue], "t1", { dueAt: null }, "now");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.task.dueAt).toBeUndefined();
      expect(res.task.dueTz).toBeUndefined();
    }
  });
});

describe("store legacy load", () => {
  test("a row with pos and no placement loads as pinned with fields intact", () => {
    const legacy = {
      id: "old",
      project: "p",
      status: "inbox",
      text: "legacy",
      pos: { x: 7, y: 8 },
      assignments: [],
      createdAt: "2026-07-05T10:00:00.000Z",
      updatedAt: "2026-07-05T10:00:00.000Z",
    };
    expect(isTask(legacy)).toBe(true);
    const filePath = tmpFile();
    fs.writeFileSync(filePath, JSON.stringify({ tasks: [legacy] }));
    const loaded = loadTasksFile(filePath);
    expect(loaded.tasks[0]!.placement).toBe("pinned");
    expect(loaded.tasks[0]!.pos).toEqual({ x: 7, y: 8 });
    expect(loaded.tasks[0]!.dueAt).toBeUndefined(); expect(loaded.tasks[0]!.dueTz).toBeUndefined();
  });
});

describe("deadline render helpers", () => {
  test("overdue derives from the instant only", () => {
    const now = Date.parse("2026-07-06T12:00:00Z");
    expect(isOverdue("2026-07-06T11:00:00Z", now)).toBe(true);
    expect(isOverdue("2026-07-06T13:00:00Z", now)).toBe(false);
    expect(isOverdue("not-a-date", now)).toBe(false);
  });

  test("the chip renders in dueTz, stable across viewer zones", () => {
    const instant = "2026-07-06T09:00:00Z"; // 12:00 in Kyiv (+03)
    const kyiv = formatDue(instant, "Europe/Kyiv", "en");
    const utc = formatDue(instant, "UTC", "en");
    expect(kyiv).toContain("12");
    expect(utc).toContain("09");
  });

  test("a datetime-local value round-trips to a UTC instant and back", () => {
    const parsed = fromDueInput("2026-07-06T12:00");
    expect(parsed).not.toBeNull();
    if (parsed) {
      expect(Number.isFinite(Date.parse(parsed.dueAt))).toBe(true);
      expect(toDueInputValue(parsed.dueAt)).toBe("2026-07-06T12:00");
    }
  });
});

describe("attachment store", () => {
  test("identical bytes upload to one content-addressed file (replay-safe)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-att-"));
    process.env.LLV_STATE_DIR = dir;
    try {
      const bytes = Buffer.from([137, 80, 78, 71, 1, 2, 3]);
      const a = storeAttachment(bytes, "image/png", "now");
      const b = storeAttachment(bytes, "image/png", "later");
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
      if (a.ok && b.ok) {
        expect(a.attachment.sha256).toBe(b.attachment.sha256);
        expect(fs.existsSync(path.join(dir, "attachments", "tasks", `${a.attachment.sha256}.png`))).toBe(true);
      }
    } finally {
      delete process.env.LLV_STATE_DIR;
    }
  });

  test("an unsupported mime is rejected", () => {
    const res = storeAttachment(Buffer.from([1, 2, 3]), "application/pdf", "now");
    expect(res.ok).toBe(false);
  });

  test("a stored attachment is readable by its content address (for reload thumbnails)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-read-"));
    process.env.LLV_STATE_DIR = dir;
    try {
      const bytes = Buffer.from([9, 8, 7, 6, 5]);
      const stored = storeAttachment(bytes, "image/webp", "now");
      if (!stored.ok) throw new Error("store failed");
      const read = readAttachment(stored.attachment.sha256, "webp");
      expect(read?.mime).toBe("image/webp");
      expect(read?.data.equals(bytes)).toBe(true);
      // A bad sha or a path-traversal ext returns null, never arbitrary bytes.
      expect(readAttachment("../etc/passwd", "webp")).toBeNull();
      expect(readAttachment(stored.attachment.sha256, "exe")).toBeNull();
    } finally {
      delete process.env.LLV_STATE_DIR;
    }
  });

  test("the sweep never deletes referenced or young files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-sweep-"));
    process.env.LLV_STATE_DIR = dir;
    try {
      const referenced = storeAttachment(Buffer.from([1, 2, 3, 4]), "image/png", "now");
      const orphan = storeAttachment(Buffer.from([5, 6, 7, 8]), "image/png", "now");
      if (!referenced.ok || !orphan.ok) throw new Error("store failed");
      const task: BoardTask = {
        id: "t",
        project: "p",
        status: "inbox",
        text: "t",
        placement: "unplaced",
        attachments: [referenced.attachment],
        assignments: [],
        createdAt: "now",
        updatedAt: "now",
      };
      const attDir = path.join(dir, "attachments", "tasks");
      const refFile = path.join(attDir, `${referenced.attachment.sha256}.png`);
      const orphanFile = path.join(attDir, `${orphan.attachment.sha256}.png`);
      // Age the orphan past the 7-day TTL; the referenced file stays referenced.
      const old = Date.now() - 8 * 24 * 60 * 60 * 1000;
      fs.utimesSync(orphanFile, old / 1000, old / 1000);
      fs.utimesSync(refFile, old / 1000, old / 1000);

      sweepAttachments([task], Date.now());
      expect(fs.existsSync(refFile)).toBe(true); // referenced: kept despite age
      expect(fs.existsSync(orphanFile)).toBe(false); // unreferenced + old: swept
    } finally {
      delete process.env.LLV_STATE_DIR;
    }
  });
});


describe("new task date policy", () => {
  const input = { project: "p", text: "New work", placement: "unplaced", clientRequestId: "dated-create" };
  test("required missing and past dates leave rows and receipts unchanged", () => {
    const existing: BoardTask[] = [];
    const receipts: RecentCreate[] = [];
    for (const dueAt of [undefined, null, ""]) {
      expect(createTask(existing, { ...input, dueAt }, receipts, { ...deps, requireDue: true }))
        .toMatchObject({ ok: false, code: "TASK_DUE_REQUIRED", field: "dueAt" });
    }
    for (const dueAt of [deps.now(), "2026-07-04T10:00:00Z"]) {
      expect(createTask(existing, { ...input, dueAt }, receipts, { ...deps, requireDue: true }))
        .toMatchObject({ ok: false, code: "TASK_DUE_PAST", field: "dueAt" });
    }
    expect(existing).toEqual([]);
    expect(receipts).toEqual([]);
  });
  test("a date alone uses the transport zone and explicit zones are preserved", () => {
    for (const dueTz of [undefined, "Asia/Tokyo"]) {
      const result = createTask([], { ...input, dueAt: "2026-07-06T12:00:00+03:00", dueTz }, [],
        { ...deps, requireDue: true, dueTimeZone: "Europe/Kyiv" });
      expect(result).toMatchObject({ ok: true, task: { dueAt: "2026-07-06T09:00:00.000Z", dueTz: dueTz ?? "Europe/Kyiv" } });
    }
    expect(createTask([], { ...input, dueAt: "invalid" }, [], { ...deps, requireDue: true })).toMatchObject({ ok: false });
    expect(createTask([], { ...input, dueAt: "2026-07-06T09:00:00Z", dueTz: "invalid" }, [], { ...deps, requireDue: true })).toMatchObject({ ok: false });
  });
  test("the operator default rounds up, leaves an exact hour alone and uses elapsed hours across DST", () => {
    const now = "2026-10-23T10:12:34.567Z";
    expect(defaultTaskDue(Date.parse(now), "Europe/Kyiv")).toEqual({ dueAt: "2026-10-26T11:00:00.000Z", dueTz: "Europe/Kyiv" });
    expect(defaultTaskDue(Date.parse("2026-10-23T10:00:00Z"), "Europe/Kyiv").dueAt).toBe("2026-10-26T10:00:00.000Z");
    expect(createTask([], input, [], { ...deps, now: () => now, defaultDue: true, dueTimeZone: "Europe/Kyiv" }))
      .toMatchObject({ ok: true, task: { dueAt: "2026-10-26T11:00:00.000Z", dueTz: "Europe/Kyiv" } });
  });
  test("system and legacy undated records stay undated and never overdue", () => {
    const made = createTask([], input, [], deps);
    expect(made.ok).toBe(true);
    if (!made.ok) throw new Error(made.error);
    expect(made.task.dueAt).toBeUndefined();
    expect(made.task.dueTz).toBeUndefined();
    const restored = patchTask([made.task], made.task.id, { text: "Legacy work updated" }, deps.now());
    expect(restored.ok).toBe(true);
    if (!restored.ok) throw new Error(restored.error);
    expect(restored.task.dueAt).toBeUndefined();
    expect(isOverdue(restored.task.dueAt ?? "", Date.parse("2099-01-01T00:00:00Z"))).toBe(false);
  });
  test("matched findings retain their existing date and idempotent replays retain the first default", () => {
    const first = createTask([], { ...input, findingKey: "recurrence" }, [], { ...deps, defaultDue: true });
    if (!first.ok) throw new Error(first.error);
    const replay = createTask(first.tasks, input, first.recentCreates, { ...deps, now: () => "2026-08-01T00:00:00Z", defaultDue: true });
    expect(replay).toMatchObject({ ok: true, replay: true, task: { dueAt: first.task.dueAt } });
    const matched = createTask(first.tasks, { ...input, clientRequestId: "next-occurrence", findingKey: "recurrence", dueAt: "2099-01-01T00:00:00Z" }, first.recentCreates, { ...deps, requireDue: true });
    expect(matched).toMatchObject({ ok: true, matched: true, task: { id: first.task.id, dueAt: first.task.dueAt } });
  });
});
