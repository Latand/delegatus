import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, expect, setSystemTime, spyOn, test } from "bun:test";

import type { ProviderReceipt } from "@/lib/accounts/migration/contracts";

import { AgentRegistry, MIGRATION_STOP_SLICE_ROWS, type RegistryFile } from "./registry";
import {
  buildMigrationStopFixture,
  MIGRATION_STOP_SOURCE,
  MIGRATION_STOP_TARGET,
  type MigrationStopFixture,
} from "./registry.migrationStop.fixture";

/*
 * The table of orderings for the decision a send takes
 * (docs/design/viewer-stalls-root-cause.md, section 12.10). A send to a
 * conversation that is not on the account its engine is routed to follows
 * routing, unless the opt-out that stands for the conversation names that
 * account. One opt-out stands: the newest decision, written on the row already
 * or still on its way from the sweep of a stop.
 *
 * A row is a sequence of decisions: stops, manual and automatic migrations,
 * routing changes, conversations that start or move to another account, sends
 * and reseats. Each row names what a send then answers for a fixed cast of
 * conversations. The row is run once with every sweep finished inside its
 * stop, and then again for every way its sweeps can be left: each stop's
 * sweep finished at once or left unfinished, the unfinished ones resumed
 * before the send one at a time, oldest first or newest first, or left for
 * after it, and every stop made through the synchronous form. A sweep is left
 * unfinished in two ways: not started, or ended by a refused write after its
 * first transaction, which leaves the conversations of that transaction
 * written and the rest not. Every run has to give the answers the row names
 * and, once the sweeps that were left have finished, the rows of the first
 * run.
 *
 * Each of those runs reopens the registry between every two steps, so
 * everything a decision reads comes back from the store. The runs that resume
 * no sweep before the send are made a second time with the registry kept
 * open.
 *
 * Each row is run under three clocks. Under the clock that runs forward it is
 * run every way above. Under a clock frozen for the whole sequence and under
 * one set back before every step it is run with no sweep started at its stop,
 * in every order of resuming, reopened between every two steps.
 *
 * This module is the table and its runner. Two test files run it, one per
 * kind of clock, so that neither is long. Every registry is a private
 * temporary file.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-migration-stop-orderings-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
afterEach(() => { setSystemTime(); });

type ConversationId = Parameters<AgentRegistry["conversation"]>[0];
const LATER_TARGET = "account-later-target";
let copies = 0;

function fixtureCopy(of: MigrationStopFixture): MigrationStopFixture {
  const directory = path.join(root, `copy-${copies++}`);
  fs.cpSync(path.dirname(of.filename), directory, { recursive: true });
  return { ...of, filename: path.join(directory, "registry.json"), sqliteFilename: path.join(directory, "registry.sqlite") };
}

function open(fixture: MigrationStopFixture): AgentRegistry {
  return new AgentRegistry(fixture.filename, undefined, undefined, { sqliteMode: "sqlite" });
}

/** Stops the intent with its sweep never run: every write of the sweep refused, or the process gone. */
async function stopIntentWithoutSweep(registry: AgentRegistry, intentId: string): Promise<void> {
  const sweep = spyOn(registry, "continueMigrationStop").mockResolvedValueOnce(false);
  try {
    expect((await registry.stopMigrationIntent(intentId)).acquired).toBe(true);
  } finally {
    sweep.mockRestore();
  }
}

/** Stops the intent with its sweep ended by a refused write: its first transaction is written and nothing after it. */
async function stopIntentWithInterruptedSweep(registry: AgentRegistry, intentId: string): Promise<void> {
  const write = registry.deliveryWrite.bind(registry);
  let sweepWrites = 0;
  const refused = spyOn(registry, "deliveryWrite").mockImplementation(((correlation, operation, correlate) => {
    if (correlation.label === "migration.stop.sweep" && (sweepWrites += 1) > 1) return Promise.resolve({ acquired: false });
    return write(correlation, operation, correlate);
  }) as typeof registry.deliveryWrite);
  try {
    expect((await registry.stopMigrationIntent(intentId)).acquired).toBe(true);
  } finally {
    refused.mockRestore();
  }
}

/* A sweep is still two transactions, and a row is run dozens of times. */
const orderingsTemplate = (() => {
  const fixture = buildMigrationStopFixture(path.join(root, "orderings"), {
    sourceConversations: MIGRATION_STOP_SLICE_ROWS + 8, targetConversations: 3, otherEngineConversations: 2,
    deliveredDeliveries: 6, pinnedSourceConversations: 1,
  });
  const registry = open(fixture);
  try {
    registry.ensureConversation("codex", "/sessions/on-the-later-target.jsonl", LATER_TARGET);
  } finally {
    registry.close();
  }
  return fixture;
})();

/** Who a row sends to. The conversations a row starts are sent to as well, under the name it gives them. */
const ORDERING_CAST = {
  /* On the source account, inactive, in the last transaction of a sweep. */
  plain: (fixture: MigrationStopFixture) => fixture.sourceConversationIds.at(-1)!,
  /* The same, in the first transaction of a sweep. */
  early: (fixture: MigrationStopFixture) => fixture.sourceConversationIds[1]!,
  pinned: (fixture: MigrationStopFixture) => fixture.pinnedConversationIds[0]!,
  onStopped: (fixture: MigrationStopFixture) => fixture.targetConversationIds[0]!,
  onLater: (_fixture: MigrationStopFixture, registry: AgentRegistry) => registry.conversationForPath("/sessions/on-the-later-target.jsonl")!.id,
} as const;
type CastName = keyof typeof ORDERING_CAST;

type OrderingStep =
  /** Stops the intent a `migrate` or `send` step named; `"fixture"` is the fixture's own. */
  | { stop: string }
  | { migrate: string; target: string; origin?: "manual" | "auto"; scope?: "active" | "all" }
  | { route: string }
  /** A conversation that starts on the source account. */
  | { start: string }
  /** A send before the end of the row; `names` the intent of the migration it starts. */
  | { send: CastName; names: string }
  | { reseat: CastName; target: string }
  | { rollBack: CastName }
  /** A reseat carried through: the conversation runs on `target` from here on. */
  | { move: CastName; target: string };

interface OrderingRow {
  name: string;
  steps: OrderingStep[];
  /** The account each conversation is asked to move to by the send that ends the row; absent means none. */
  sent: Record<string, string>;
}

const STOPPED = MIGRATION_STOP_TARGET;
const stopFixture: OrderingStep = { stop: "fixture" };
const migrateActiveToLater: OrderingStep = { migrate: "later", target: LATER_TARGET, scope: "active" };

const orderingRows: OrderingRow[] = [
  {
    name: "a stop, with routing left on the stopped target",
    steps: [stopFixture, { start: "after" }],
    sent: { after: STOPPED },
  },
  {
    name: "a stop, then routing moved to another account",
    steps: [stopFixture, { route: LATER_TARGET }],
    sent: { plain: LATER_TARGET, early: LATER_TARGET, onStopped: LATER_TARGET },
  },
  {
    name: "a stop, routing moved away and back",
    steps: [stopFixture, { route: LATER_TARGET }, { route: STOPPED }],
    sent: {},
  },
  {
    name: "a stop of each of two targets, with routing left on the second",
    steps: [stopFixture, migrateActiveToLater, { start: "between" }, { stop: "later" }],
    sent: {},
  },
  {
    name: "a stop of each of two targets, then routing set back to the first",
    steps: [stopFixture, migrateActiveToLater, { start: "between" }, { stop: "later" }, { route: STOPPED }],
    sent: { plain: STOPPED, early: STOPPED, between: STOPPED },
  },
  {
    name: "a stop of each of two targets, the second migration having enrolled every conversation, then routing set back to the first",
    steps: [stopFixture, { migrate: "later", target: LATER_TARGET, scope: "all" }, { stop: "later" }, { route: STOPPED }],
    sent: { plain: STOPPED, early: STOPPED },
  },
  {
    name: "a stop of each of two targets, then a conversation moved onto the first, with routing left on the second",
    steps: [stopFixture, migrateActiveToLater, { stop: "later" }, { move: "plain", target: STOPPED }],
    sent: {},
  },
  {
    name: "a stop of each of two targets, then a conversation moved onto the second and routing set back to the first",
    steps: [stopFixture, migrateActiveToLater, { stop: "later" }, { move: "plain", target: LATER_TARGET }, { route: STOPPED }],
    sent: { plain: STOPPED, early: STOPPED },
  },
  {
    name: "a stop of each of two targets, routing set back to the first and then on to the second again",
    steps: [stopFixture, migrateActiveToLater, { stop: "later" }, { route: STOPPED }, { route: LATER_TARGET }],
    sent: {},
  },
  {
    name: "a manual migration back to the stopped target, stopped in its turn",
    steps: [stopFixture, { migrate: "again", target: STOPPED, scope: "active" }, { start: "between" }, { stop: "again" }],
    sent: {},
  },
  {
    name: "the first target stopped again after the second, then routing set to the second",
    steps: [stopFixture, migrateActiveToLater, { stop: "later" },
      { migrate: "again", target: STOPPED, scope: "active" }, { start: "between" }, { stop: "again" }, { route: LATER_TARGET }],
    sent: { plain: LATER_TARGET, early: LATER_TARGET, between: LATER_TARGET },
  },
  {
    name: "a manual migration back to the stopped target that enrols no inactive conversation",
    steps: [stopFixture, { migrate: "again", target: STOPPED, scope: "active" }],
    sent: { plain: STOPPED, early: STOPPED, onLater: STOPPED },
  },
  {
    name: "an automatic migration back to the stopped target",
    steps: [stopFixture, { migrate: "auto", target: STOPPED, origin: "auto", scope: "all" }],
    sent: {},
  },
  {
    name: "an automatic migration to the first target after a stop of the second",
    steps: [stopFixture, migrateActiveToLater, { start: "between" }, { stop: "later" },
      { migrate: "auto", target: STOPPED, origin: "auto", scope: "all" }],
    sent: { plain: STOPPED, early: STOPPED, between: STOPPED },
  },
  {
    name: "the same intent stopped again after routing moved on, and routing set back",
    steps: [stopFixture, { route: LATER_TARGET }, stopFixture, { route: STOPPED }],
    sent: {},
  },
  {
    name: "the same intent stopped again while routing stays on its target",
    steps: [stopFixture, { start: "between" }, stopFixture],
    sent: {},
  },
  {
    name: "a send that follows routing to a second account, a stop of the migration it started, and routing set back",
    steps: [stopFixture, { route: LATER_TARGET }, { send: "plain", names: "lazy" }, { start: "between" }, { stop: "lazy" }, { route: STOPPED }],
    sent: { plain: STOPPED, early: STOPPED, between: STOPPED },
  },
  {
    name: "a reseat onto the stopped target rolled back at once",
    steps: [stopFixture, { reseat: "plain", target: STOPPED }, { rollBack: "plain" }],
    sent: {},
  },
  {
    name: "a reseat onto the stopped target rolled back after routing moved on, and routing set back",
    steps: [stopFixture, { reseat: "plain", target: STOPPED }, { route: LATER_TARGET }, { rollBack: "plain" }, { route: STOPPED }],
    sent: { plain: STOPPED },
  },
  {
    name: "a reseat onto the stopped target rolled back at once, a stop of a second target, and routing set back",
    steps: [stopFixture, { reseat: "plain", target: STOPPED }, { rollBack: "plain" }, migrateActiveToLater, { stop: "later" }, { route: STOPPED }],
    sent: { plain: STOPPED, early: STOPPED },
  },
];

type SweepMode = "at once" | "not started" | "refused after its first transaction" | "synchronous";
interface SweepPlan {
  /** One per stop of the row, in order. */
  sweeps: SweepMode[];
  /** The stops whose unfinished sweep is resumed before the send, in this order. */
  resumed: number[];
  /** The order in which the sweeps still left are finished after the send. */
  finish: "oldest first" | "newest first";
  reopen: "never" | "between every two steps";
}

function sweepPlans(stops: number): SweepPlan[] {
  const every = Array.from({ length: stops }, (_, index) => index);
  /* The run every other is held to: every sweep finished inside its stop, the registry kept open. */
  const plans: SweepPlan[] = [{ sweeps: every.map(() => "at once" as const), resumed: [], finish: "oldest first", reopen: "never" }];
  for (let mask = 0; mask < 1 << stops; mask += 1) {
    const unfinished = every.filter(index => mask & (1 << index));
    const resumes: number[][] = [[], ...unfinished.map(index => [index])];
    if (unfinished.length > 1) resumes.push(unfinished, [...unfinished].reverse());
    for (const left of unfinished.length ? ["not started", "refused after its first transaction"] as const : ["not started"] as const) {
      for (const resumed of resumes) {
        for (const finish of unfinished.length - resumed.length > 1 ? ["oldest first", "newest first"] as const : ["oldest first"] as const) {
          const sweeps = every.map(index => unfinished.includes(index) ? left : "at once");
          plans.push({ sweeps, resumed, finish, reopen: "between every two steps" });
          if (unfinished.length && !resumed.length) plans.push({ sweeps, resumed, finish, reopen: "never" });
        }
      }
    }
  }
  for (const reopen of ["never", "between every two steps"] as const) {
    plans.push({ sweeps: every.map(() => "synchronous" as const), resumed: [], finish: "oldest first", reopen });
  }
  return plans;
}

/** No sweep started at its stop, reopened between every two steps: the plans the frozen clock and the clock set back are run under. */
const unstartedReopened = (plan: SweepPlan) =>
  plan.reopen === "between every two steps" && plan.sweeps.every(mode => mode === "not started");

const ORDERING_CLOCKS = {
  "running forward": (tick: number) => tick,
  "frozen": () => 0,
  "set back before every step": (tick: number) => 59 - tick,
} as const;
export type OrderingClock = keyof typeof ORDERING_CLOCKS;

const successorReceipt = (operationId: string, name: string): ProviderReceipt => ({
  operationId, nativeId: name, path: `/sessions/${name}.jsonl`, continuityPaths: [], historyHash: `${name}-history`,
  host: { kind: "codex-app-server", identity: `${name}-host`, epoch: 1, verifiedAt: "2030-01-01T00:00:00.000Z" },
});

const activeMigrationTarget = (conversation: { migration: RegistryFile["conversations"][string]["migration"] }) =>
  conversation.migration && conversation.migration.phase !== "committed" && conversation.migration.phase !== "rolled-back"
    ? conversation.migration.targetId : null;

/** One run of a row: the answers of the send that ends it, and what every conversation is left with once every sweep has finished. */
async function runOrdering(row: OrderingRow, clockName: OrderingClock, plan: SweepPlan): Promise<{ sent: Record<string, string>; rows: string }> {
  const fixture = fixtureCopy(orderingsTemplate);
  let registry = open(fixture);
  const intents = new Map([["fixture", fixture.intentId]]);
  const stopped: string[] = [];
  const started = new Map<string, string>();
  let tick = 0;
  let stops = 0;
  const step = () => {
    if (plan.reopen === "between every two steps" && tick > 0) {
      registry.close();
      registry = open(fixture);
    }
    setSystemTime(new Date(Date.UTC(2030, 0, 1, 0, 0, ORDERING_CLOCKS[clockName](tick))));
    tick += 1;
  };
  const cast = (name: string) => (name in ORDERING_CAST
    ? ORDERING_CAST[name as CastName](fixture, registry)
    : registry.conversationForPath(started.get(name)!)!.id) as ConversationId;
  try {
    for (const decision of row.steps) {
      step();
      if ("stop" in decision) {
        const id = intents.get(decision.stop)!;
        const mode = plan.sweeps[stops]!;
        stops += 1;
        if (mode === "synchronous") registry.setMigrationIntentState(id, "stopped");
        else if (mode === "not started") await stopIntentWithoutSweep(registry, id);
        else if (mode === "refused after its first transaction") await stopIntentWithInterruptedSweep(registry, id);
        else expect((await registry.stopMigrationIntent(id)).acquired).toBe(true);
        stopped.push(id);
      } else if ("migrate" in decision) {
        intents.set(decision.migrate, registry.commitMigrationIntent({
          engine: "codex", targetId: decision.target, origin: decision.origin ?? "manual", requestId: `ordering-${decision.migrate}`,
          expectedRevision: registry.engineRouting("codex").revision, scope: decision.scope ?? "all",
        }).id);
      } else if ("route" in decision) {
        registry.setEngineRouting("codex", decision.route);
      } else if ("start" in decision) {
        const pathname = `/sessions/started-${decision.start}.jsonl`;
        registry.ensureConversation("codex", pathname, MIGRATION_STOP_SOURCE);
        started.set(decision.start, pathname);
      } else if ("send" in decision) {
        intents.set(decision.names, registry.requestConversationMigrationToActiveAccount(cast(decision.send)).migration!.intentId);
      } else if ("reseat" in decision) {
        registry.requestConversationReseat(cast(decision.reseat), decision.target);
      } else if ("rollBack" in decision) {
        registry.rollbackConversationMigration(cast(decision.rollBack));
      } else {
        const id = cast(decision.move);
        const migration = registry.requestConversationReseat(id, decision.target).migration!;
        const receipt = successorReceipt(migration.operationId, `moved-${decision.move}`);
        registry.transitionConversationMigration(id, migration.revision, [migration.phase], { phase: "successor-starting" });
        registry.persistMigrationProviderReceipt(id, migration.revision, migration.operationId, receipt);
        registry.commitSuccessor(id, { id: receipt.nativeId, path: receipt.path, accountId: decision.target, historyHash: receipt.historyHash, host: receipt.host },
          migration.revision, migration.operationId, receipt);
      }
    }
    for (const index of plan.resumed) {
      step();
      expect(await registry.continueMigrationStop(stopped[index]!)).toBe(true);
    }

    step();
    const sent: Record<string, string> = {};
    for (const name of [...Object.keys(ORDERING_CAST), ...started.keys()]) {
      const target = activeMigrationTarget(registry.requestConversationMigrationToActiveAccount(cast(name)));
      if (target) sent[name] = target;
    }

    const left = [...new Set(stopped)].filter(id => registry.readOnlySnapshot().migrationIntents[id]!.stopSweep);
    for (const id of plan.finish === "newest first" ? left.reverse() : left) {
      step();
      expect(await registry.continueMigrationStop(id)).toBe(true);
    }
    const file = registry.snapshot();
    for (const intent of Object.values(file.migrationIntents)) expect(intent.stopSweep).toBeUndefined();
    /* Keyed by the path a conversation started under: a run mints the ids of the ones it starts. */
    const rows = Object.values(file.conversations).map((conversation) => {
      /* A withdrawal that kept its place stands for no opt-out. */
      const optOut = conversation.migrationOptOut?.targetId ? conversation.migrationOptOut : null;
      return [conversation.generations[0]!.path, optOut?.targetId ?? null, optOut?.updatedAt ?? null,
        conversation.migration?.targetId ?? null, conversation.migration?.phase ?? null];
    }).sort((left, right) => String(left[0]).localeCompare(String(right[0])));
    return { sent, rows: JSON.stringify(rows, null, 1) };
  } finally {
    registry.close();
  }
}

/** The premises of the table: what each way of leaving a sweep unfinished stores. */
export function declareSweepStateTest(): void {
  test("the two ways the table leaves a sweep unfinished leave the rows it reads them for", async () => {
    const stored = async (stop: (registry: AgentRegistry, intentId: string) => Promise<void>) => {
      const fixture = fixtureCopy(orderingsTemplate);
      const registry = open(fixture);
      try {
        await stop(registry, fixture.intentId);
        const file = registry.readOnlySnapshot();
        return {
          marker: Boolean(file.migrationIntents[fixture.intentId]!.stopSweep?.optOut),
          early: file.conversations[ORDERING_CAST.early(fixture)]!.migrationOptOut?.targetId ?? null,
          plain: file.conversations[ORDERING_CAST.plain(fixture)]!.migrationOptOut?.targetId ?? null,
        };
      } finally {
        registry.close();
      }
    };
    expect(await stored(stopIntentWithoutSweep)).toEqual({ marker: true, early: null, plain: null });
    expect(await stored(stopIntentWithInterruptedSweep)).toEqual({ marker: true, early: STOPPED, plain: null });
  });
}

/* The longest row is run about a hundred times; its limit leaves room for a loaded machine. */
const ORDERING_ROW_TIMEOUT_MS = 240_000;

/** One test per row and clock: every plan of the row against its run with every sweep finished. */
export function declareOrderingTests(clocks: readonly OrderingClock[]): void {
  for (const row of orderingRows) {
    const every = sweepPlans(row.steps.filter(decision => "stop" in decision).length);
    for (const clockName of clocks) {
      const plans = clockName === "running forward" ? every.slice(1) : every.filter(unstartedReopened);
      test(`after ${row.name}, a send answers as it does with every sweep finished (${plans.length + 1} runs, clock ${clockName})`, async () => {
        const whole = await runOrdering(row, clockName, every[0]!);
        expect(whole.sent).toEqual(row.sent);
        const differing: Array<{ plan: SweepPlan; sent?: Record<string, string>; rows?: string }> = [];
        for (const plan of plans) {
          const run = await runOrdering(row, clockName, plan);
          const sentDiffers = JSON.stringify(run.sent) !== JSON.stringify(whole.sent);
          if (sentDiffers || run.rows !== whole.rows) {
            differing.push({ plan, ...(sentDiffers ? { sent: run.sent } : {}), ...(run.rows !== whole.rows ? { rows: "differ from the rows of the run with every sweep finished" } : {}) });
          }
        }
        expect(differing).toEqual([]);
      }, ORDERING_ROW_TIMEOUT_MS);
    }
  }
}
