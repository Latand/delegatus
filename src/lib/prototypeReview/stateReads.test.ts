import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { saveTasks, loadTasks, loadTasksForList, taskFeedSource } from "@/lib/tasks/store";
import { findPrototypeRound, mutatePrototypeRound, withPrototypeState } from "./store";
import { taskForPrototype } from "./world";
import { clearSeatRoundsForTests, insertSeatRound } from "./seatRounds";
import type { BoardTask } from "@/lib/tasks/types";
import type { PrototypeReviewRound } from "./types";
const state = process.env.LLV_STATE_DIR!;
const at = "2026-10-01T00:00:00.000Z";
const review = "pr_00000000000000000000000000000001";
function tasks(): BoardTask[] {
  return Array.from({ length: 1025 }, (_, n) => ({ id: `task-${n}`, project: "project-fixture", text: "Prototype fixture",
    status: "inbox", placement: "unplaced", createdAt: at, updatedAt: at, attachments: [], assignments: [], workLinks: [],
    ...(n === 1024 ? { prototypeReviews: [{ id: review, taskId: "task-1024", project: "project-fixture",
      title: "Review", createdAt: at, publicationKey: "fixture", inputDigest: "fixture", source: { conversationId: null }, variants: [] } as PrototypeReviewRound] } : {}) }));
}
afterEach(() => { saveTasks([]); clearSeatRoundsForTests(); });

test("prototype reads never decode unrelated tasks and retain project denial", async () => {
  saveTasks(tasks());
  // A malformed unrelated row catches a collection read even after its cache
  // was warmed; the selected row itself must still validate.
  const db = new Database(path.join(state, "state.sqlite"));
  db.query("UPDATE state_rows SET value_json=json_set(value_json,'$.status','broken') WHERE collection='tasks' AND row_key='t:task-0'").run();
  try {
    for (let n = 0; n < 20; n++) {
      const round = await withPrototypeState(() => findPrototypeRound("task-1024", review));
      expect(round?.id).toBe(review);
      expect(taskForPrototype("task-1024", { conversationId: "conversation_reader", project: "project-fixture" }).id).toBe("task-1024");
    }
    expect(() => taskForPrototype("task-1024", { conversationId: "conversation_reader", project: "other-project" })).toThrow("limited to the caller's project");
    expect(findPrototypeRound("absent", review)).toBeUndefined();
  } finally { db.query("UPDATE state_rows SET value_json=json_set(value_json,'$.status','inbox') WHERE collection='tasks' AND row_key='t:task-0'").run(); db.close(); }
});

test("prototype bookkeeping reads and writes just its row, preserves peers and rolls back refusals", () => {
  saveTasks(tasks());
  const peer = taskFeedSource()!.get("task-0");
  mutatePrototypeRound("task-1024", review, round => { round.telegramPost = { key: review, state: "sent", at }; });
  expect(findPrototypeRound("task-1024", review)?.telegramPost?.state).toBe("sent");
  expect(taskFeedSource()!.get("task-0")).toEqual(peer);
  const held = taskFeedSource()!.get("task-1024");
  expect(() => mutatePrototypeRound("task-1024", review, round => { round.title = "Discarded"; throw new Error("refused"); })).toThrow("refused");
  expect(taskFeedSource()!.get("task-1024")).toEqual(held);
  expect(() => mutatePrototypeRound("task-1024", "pr_missing", () => {})).toThrow("review not found");
  const before = fs.statSync(path.join(state, "state.sqlite")).size;
  mutatePrototypeRound("task-1024", review, () => {});
  expect(taskFeedSource()!.get("task-1024")).toEqual(held);
  expect(fs.statSync(path.join(state, "state.sqlite")).size).toBe(before);
  expect(loadTasks()).toHaveLength(1025);
});


test("duplicate module readers share one immutable task-list owner", async () => {
  saveTasks(tasks());
  const first = loadTasksForList();
  const moduleUrl = new URL("../tasks/store.ts?prototype-reader-copy", import.meta.url).href;
  const duplicate = await import(moduleUrl) as typeof import("@/lib/tasks/store");
  expect(duplicate.loadTasksForList()).toBe(first);
  mutatePrototypeRound("task-1024", review, round => { round.title = "Changed"; });
  expect(duplicate.loadTasksForList()).toBe(loadTasksForList());
  expect(duplicate.loadTasksForList().find(task => task.id === "task-1024")!.prototypeReviews![0]!.title).toBe("Changed");
});

test("a restarted reader observes committed prototype updates without an in-memory cache", () => {
  saveTasks(tasks());
  const read = () => {
    const source = `import { findPrototypeRound } from ${JSON.stringify(new URL("./store.ts", import.meta.url).pathname)}; console.log(findPrototypeRound("task-1024", ${JSON.stringify(review)})?.title);`;
    const child = Bun.spawnSync([process.execPath, "-e", source], { env: { ...process.env }, stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    expect(child.exitCode).toBe(0);
    return new TextDecoder().decode(child.stdout).trim();
  };
  expect(read()).toBe("Review");
  mutatePrototypeRound("task-1024", review, round => { round.title = "Committed"; });
  expect(read()).toBe("Committed");
});


test("the seat worker reads sixteen rounds per keyset page", async () => {
  const { seatRoundPage } = await import("./seatRounds");
  for (let n = 0; n < 33; n++) insertSeatRound({ id: `pr_${n.toString(16).padStart(32, "0")}`, taskId: null,
    project: "project-fixture", title: "Seat question", createdAt: at, publicationKey: `seat-${n}`, inputDigest: "fixture",
    source: { conversationId: null }, variants: [] });
  const first = seatRoundPage();
  const second = seatRoundPage(first.at(-1)!.id);
  const third = seatRoundPage(second.at(-1)!.id);
  expect(first).toHaveLength(16); expect(second).toHaveLength(16); expect(third).toHaveLength(1);
  expect(new Set([...first, ...second, ...third].map(round => round.id)).size).toBe(33);
  expect(seatRoundPage(third[0]!.id)).toHaveLength(0);
  expect(() => seatRoundPage("", 17)).toThrow("invalid seat round page limit");
});
