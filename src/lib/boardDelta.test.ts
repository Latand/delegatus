import { expect, test } from "bun:test";
import { applyBoardDelta, diffBoard, type BoardDelta } from "./boardDelta";
import { BoardEncoder } from "./boardEncoding";
import { BoardHistory } from "./boardHistory";

const base = () => ({
  tasks: [{ id: "t", details: "retained".repeat(20_000), note: null, assignments: [{ id: "a", status: "running" }] }],
  pipelines: [{ id: "p", stages: [{ id: "s", effectiveRole: { promptScaffold: "scaffold".repeat(20_000) } }],
    runs: [{ stageId: "s", attempts: [{ n: 1, report: { summary: "history".repeat(20_000) }, state: "running" }] }] }],
  files: [{ path: "/first", active: true }, { path: "/second", active: false }],
  flows: [{ id: "f", state: "waiting" }], workflows: [{ id: "w", members: ["t"] }],
  seatDecisions: [{ id: "ask", state: "open" }], prototypeReviewNotices: [{ id: "review", dismissed: false }],
  aliases: JSON.parse('{"__proto__":"own value","constructor":"alias"}'),
});

test("nested updates preserve complete content, order, absence, null and untouched identities", () => {
  const a = base();
  const b = structuredClone(a);
  b.pipelines[0].runs[0].attempts[0].state = "complete";
  b.tasks[0].assignments[0].status = "complete";
  b.files = [b.files[1], { path: "/new", active: true }];
  b.flows = [];
  b.workflows[0].members = [];
  b.seatDecisions = [];
  b.prototypeReviewNotices[0].dismissed = true;
  delete b.aliases.constructor;
  b.aliases.__proto__ = "updated";
  const delta = JSON.parse(JSON.stringify(diffBoard(a, b, "a", "b")));
  expect(JSON.stringify(delta).length).toBeLessThan(2500);
  const applied = applyBoardDelta(a, delta) as typeof a;
  expect(applied).toEqual(b);
  expect(applied.pipelines[0].stages).toBe(a.pipelines[0].stages);
  expect(applied.pipelines[0].runs[0].attempts[0].report).toBe(a.pipelines[0].runs[0].attempts[0].report);
  expect(applied.files[0]).toBe(a.files[1]);
  expect(Object.hasOwn(applied.aliases, "__proto__")).toBe(true);
  expect(Object.getPrototypeOf(applied.aliases)).toBe(Object.prototype);
  expect(a.pipelines[0].runs[0].attempts[0].state).toBe("running");
});

test("duplicate or changed identities replace arrays; invalid bases refuse atomically", () => {
  const a = base();
  const b = structuredClone(a);
  b.pipelines[0].runs[0].attempts.push({ ...b.pipelines[0].runs[0].attempts[0], state: "failed" });
  expect(applyBoardDelta(a, diffBoard(a, b, "a", "b"))).toEqual(b);
  const delta = diffBoard(a, { ...a, files: [a.files[1]] }, "a", "b");
  const wrong = { ...a, files: [a.files[1]] };
  expect(() => applyBoardDelta(wrong, delta)).toThrow("identity mismatch");
  for (const change of [null, { object: [["files", null]], remove: [] }, { array: [], key: "id", baseKeys: [], order: [] }]) {
    expect(() => applyBoardDelta(a, { v: 2, base: "a", etag: "b", change } as unknown as BoardDelta)).toThrow();
  }
  expect(a.files[0].path).toBe("/first");
});

test("encoder owns the base, binds scope/epoch and normalizes JSON values", () => {
  const encoder = new BoardEncoder();
  const a = base();
  const first = encoder.encode("scope", "epoch", { ...a, absent: undefined, number: NaN, array: [undefined] }, 1);
  expect(JSON.parse(first.body)).toMatchObject({ number: null, array: [null], boardProtocol: 2 });
  a.tasks[0].assignments[0].status = "complete";
  const next = encoder.encode("scope", "epoch", a, 2);
  expect(applyBoardDelta(JSON.parse(first.body), JSON.parse(next.delta!.body))).toEqual(JSON.parse(next.body));
  expect(encoder.encode("scope", "epoch", a, 3).delta).toBeUndefined();
  expect(encoder.encode("other", "epoch", a, 4).etag).not.toBe(next.etag);
  expect(encoder.encode("scope", "restart", a, 5).delta).toBeUndefined();
  expect(encoder.encode("scope", "epoch", a, 120_010).delta).toBeUndefined();
  const small = new BoardEncoder({ scopes: 1, bytes: 2000, ageMs: 100 });
  small.encode("one", "epoch", { value: "one" }, 1);
  small.encode("two", "epoch", { value: "two" }, 2);
  expect(small.encode("one", "epoch", { value: "new" }, 3).delta).toBeUndefined();
  small.encode("one", "epoch", a, 4);
  expect(small.encode("one", "epoch", a, 5).delta).toBeUndefined();
});

test("history reuses identity/gzip answers and bounds scopes, links, UTF-8 bytes and age", async () => {
  const history = new BoardHistory({ scopes: 2, links: 2, path: 2, bytes: 3000, ageMs: 100 });
  history.record("s", "a", "b", '{"v":2}', 1);
  history.record("s", "b", "c", '{"v":2}', 2);
  const first = history.answer("s", "a", "c", 10000, 3).answer!;
  expect(first.body).toBe('{"deltas":[{"v":2},{"v":2}]}');
  expect(history.answer("s", "a", "c", 10000, 4).answer).toBe(first);
  expect(history.gzip(first)).toBe(history.gzip(first));
  await history.gzip(first);
  history.record("s", "c", "d", '{"v":2}', 5);
  expect(history.answer("s", "a", "d", 10000, 6).reason).toBe("expired");
  expect(history.answer("s", "b", "d", 10, 6).reason).toBe("delta-too-large");
  history.record("t", "a", "b", "字".repeat(500), 7);
  history.record("u", "a", "b", "字".repeat(500), 8);
  expect(history.stats().scopes).toBeLessThanOrEqual(2);
  expect(history.stats().bytes).toBeLessThanOrEqual(3000);
  expect(history.answer("s", "b", "d", 10000, 9).reason).toBe("expired");
  history.forget("t");
  expect(history.answer("u", "a", "b", 100000, 108).reason).toBe("expired");
  expect(history.stats()).toEqual({ scopes: 0, links: 0, bytes: 0 });
});
