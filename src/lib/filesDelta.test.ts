import { expect, test } from "bun:test";

import { applyFilesDelta, diffFilesRepresentations, type FilesDelta } from "./filesDelta";

type Json = Record<string, unknown>;

const row = (path: string, extra: Json = {}) => ({ path, title: path, ...extra });
const base = (): Json => ({
  files: [row("a"), row("b"), row("c"), row("d"), row("e")],
  tasks: [{ id: "t1", text: "one" }, { id: "t2", text: "two" }],
  pipelines: [],
  launchRoutes: { "spawn:1": "c1", "spawn:2": "c2" },
  crownedProjects: ["p"],
  readProjection: "board-summary",
});

function roundTrip(previous: Json, next: Json): { delta: FilesDelta; applied: Json } {
  const delta = JSON.parse(JSON.stringify(diffFilesRepresentations(previous, next, "\"base\"", "\"next\""))) as FilesDelta;
  const applied = applyFilesDelta(JSON.parse(JSON.stringify(previous)) as Json, delta);
  expect(JSON.stringify(applied)).toBe(JSON.stringify(next));
  return { delta, applied };
}

test("an unchanged representation diffs to an empty delta", () => {
  const { delta } = roundTrip(base(), base());
  expect(delta).toEqual({ v: 1, base: "\"base\"", etag: "\"next\"" });
});

test("one changed row travels alone and the others keep their identity", () => {
  const previous = base();
  const next = base();
  (next.files as Json[])[2] = row("c", { mtime: 5 });
  const delta = diffFilesRepresentations(previous, next, "\"base\"", "\"next\"");
  expect(delta.rows).toEqual([["files", { count: 5, upsert: [["c", row("c", { mtime: 5 })]] }]]);
  const applied = applyFilesDelta(previous, delta);
  const files = applied.files as Json[];
  expect(files[0]).toBe((previous.files as Json[])[0]);
  expect(files[2]).toEqual(row("c", { mtime: 5 }));
  expect(applied.tasks).toBe(previous.tasks);
});

test("moves, insertions and removals encode as runs of the base order", () => {
  const next = base();
  next.files = [row("d", { mtime: 9 }), row("new"), row("a"), row("b"), row("e")];
  const { delta } = roundTrip(base(), next);
  const files = delta.rows!.find(([field]) => field === "files")![1];
  expect(files.order).toEqual([[3, 1], "new", [0, 2], [4, 1]]);
  expect(files.upsert!.map(([key]) => key)).toEqual(["d", "new"]);
});

test("records diff by entry, other fields whole, and removed fields unset", () => {
  const next = base();
  next.launchRoutes = { "spawn:2": "c2", "spawn:3": "c3" };
  next.crownedProjects = ["p", "q"];
  delete next.readProjection;
  next.pipelinesError = "store failed closed";
  const { delta } = roundTrip(base(), next);
  expect(delta.entries).toEqual([["launchRoutes", { upsert: [["spawn:3", "c3"]], remove: ["spawn:1"] }]]);
  expect(delta.unset).toEqual(["readProjection"]);
  expect(delta.set).toEqual([["crownedProjects", ["p", "q"]], ["pipelinesError", "store failed closed"]]);
});

test("emptied and duplicate-keyed collections still reproduce the next representation", () => {
  const emptied = base();
  emptied.files = [];
  roundTrip(base(), emptied);
  const duplicated = base();
  duplicated.tasks = [{ id: "t1", text: "one" }, { id: "t1", text: "again" }];
  const { delta } = roundTrip(base(), duplicated);
  expect(delta.set?.map(([field]) => field)).toEqual(["tasks"]);
});

test("a prototype-named key stays data", () => {
  const next = base();
  next.launchRoutes = JSON.parse("{\"__proto__\":\"polluted\"}") as Json;
  const { applied } = roundTrip(base(), next);
  expect(Object.hasOwn(applied.launchRoutes as Json, "__proto__")).toBe(true);
  expect(({} as Json).polluted).toBeUndefined();
});

test("a delta that does not fit its base throws instead of guessing", () => {
  const next = base();
  next.files = [row("e"), row("a")];
  const delta = diffFilesRepresentations(base(), next, "\"base\"", "\"next\"");
  expect(() => applyFilesDelta({ ...base(), files: [row("a")] }, delta)).toThrow();
  expect(() => applyFilesDelta({ ...base(), files: undefined }, delta)).toThrow();
  expect(() => applyFilesDelta(base(), { ...delta, v: 2 } as unknown as FilesDelta)).toThrow();
});
