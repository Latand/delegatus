import { expect, test } from "bun:test";
import { CodexHistory } from "./codexHistory";
import { createContextLedger, type ContextTokens } from "./contextTokens";

test("an older write invalidates a reader at the next write, and retracts its old contribution", () => {
  const history = new CodexHistory();
  const calls = history.map<number>("call"), rows = history.map<string>("row");
  history.record(10, () => {
    if (!calls.has("a")) rows.set("orphan", "waiting");
    else rows.set("attached", String(calls.get("a")));
    calls.set("a", 2);
  });
  history.record(20, () => rows.set("later", String(calls.get("a"))));
  history.record(-100, () => calls.set("a", 1));
  history.settle();
  expect(Object.fromEntries(rows)).toEqual({ attached: "1", later: "2" });
  expect(history.diagnostics().effectVisits).toBe(1);
});

test("an initial-state replacement retains the old read value until reconciliation", () => {
  const history = new CodexHistory();
  const state = history.fields("ledger", { fresh: true });
  const rows = history.map<boolean>("row");
  history.record(10, () => { rows.set("partial", state.fresh); state.fresh = false; });
  history.partial(false);
  history.settle();
  expect(rows.get("partial")).toBe(false);
});

test("source indexes and pending-effect ordering agree with fresh reduction over shuffled prepends", () => {
  let seed = 42;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let run = 0; run < 6; run += 1) {
    const facts = Array.from({ length: 120 }, (_, at) => ({ at: at - 60, key: String(random() % 9), value: random() % 100 }));
    const history = new CodexHistory();
    const calls = history.map<number>("call"), rows = history.map<number>("row");
    const admitted: typeof facts = [];
    const shuffled = facts.slice();
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const other = random() % (i + 1);
      [shuffled[i], shuffled[other]] = [shuffled[other], shuffled[i]];
    }
    for (const fact of shuffled) {
      admitted.push(fact);
      history.record(fact.at, () => {
        rows.set(String(fact.at), (calls.get(fact.key) ?? 0) + fact.value);
        calls.set(fact.key, fact.value);
      });
      history.settle();
      const expected = new Map<string, number>(), prior = new Map<string, number>();
      for (const source of admitted.toSorted((a, b) => a.at - b.at)) {
        expected.set(String(source.at), (prior.get(source.key) ?? 0) + source.value);
        prior.set(source.key, source.value);
      }
      expect(Object.fromEntries(rows)).toEqual(Object.fromEntries(expected));
    }
  }
});

test("ledger continuation keeps member order, repeat totals, size eviction and callback ownership", () => {
  const commands: ((ledger: ReturnType<typeof createContextLedger>) => void)[] = [];
  for (let i = 0; i < 260; i += 1) commands.push(ledger => { ledger.member(`c-${i}`); ledger.result(`c-${i}`, i + 20, 0); });
  commands.push(ledger => ledger.codexUsage(1000, 10, 100), ledger => ledger.codexUsage(1000, 10, 100),
    ledger => ledger.codexUsage(4000, 10, 200), ledger => ledger.result("outer", 120, 0),
    ledger => ledger.represent("outer", ["c-258", "c-259"]), ledger => ledger.estimate("outer"));
  const history = new CodexHistory();
  const paged = history.map<ContextTokens>("row");
  const ledger = createContextLedger("codex", (id, value) => paged.set(id, value), () => true, history);
  ledger.reset(false);
  for (let i = 120; i < commands.length; i += 1) history.record(i, () => commands[i](ledger));
  for (let i = 0; i < 120; i += 1) history.record(i, () => commands[i](ledger));
  history.settle();
  const full = new Map<string, ContextTokens>();
  const independent = createContextLedger("codex", (id, value) => full.set(id, value));
  independent.reset(false);
  commands.forEach(command => command(independent));
  expect(Object.fromEntries(paged)).toEqual(Object.fromEntries(full));
  const frozen = JSON.stringify(Object.fromEntries(full));
  history.record(commands.length, () => ledger.result("c-259", 10000, 0));
  history.settle();
  expect(JSON.stringify(Object.fromEntries(full))).toBe(frozen);
});
