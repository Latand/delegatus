import { expect, test, fs, path, SANDBOX, runSeatTickCheck, statePath, PROJECT, CONVERSATION, NOW, MINUTE, harness, OVERDUE, OPEN_LANE, writeSeatTickState, emptySeatTickState } from "./seatTickController.fixture";
import { loadTasks } from "@/lib/tasks/store";
import { seatHostRecoveryCard, type SeatHostRecovery } from "./seatHostRecovery";

test("twenty distinct revivals through the controller create zero board tasks", async () => {
  const directory = fs.mkdtempSync(path.join(SANDBOX, "successful-revivals-"));
  const previous = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = directory;
  try {
    const stateFile = path.join(directory, "seat-tick.json");
    writeSeatTickState(PROJECT, { ...emptySeatTickState(), seatEpoch: 7, ...OVERDUE }, stateFile);
    const keys = new Set<string>();
    for (let index = 0; index < 20; index++) {
      const rig = harness({ pipelines: OPEN_LANE, stateFile, now: NOW + index * 61 * MINUTE,
        seatActivity: { conversationId: CONVERSATION, lifecycle: "gone", reason: "host_gone_turn_settled", host: { state: "gone", kind: "structured", pid: null } },
        delivery: { ok: true, target: null, outcome: "delivered", structured: true, spawned: true },
      });
      await runSeatTickCheck(PROJECT, { ...rig.deps, ensureCard: undefined,
        mcpHealth: () => ({ status: "healthy", detail: "fresh MCP is live" }),
      });
      expect(rig.sent).toHaveLength(1);
      keys.add(rig.sent[0]!.clientMessageId!);
      expect(rig.deps.readState!(PROJECT).hostRecovery).toMatchObject({ state: "revived", told: true });
      expect(loadTasks(statePath("tasks.json"))).toEqual([]);
    }
    expect(keys.size).toBe(20);
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
  }
}, 30_000);

test.each(["uk", "en"] as const)("%s recovery failures retain their open notices", locale => {
  const record: SeatHostRecovery = { id: "recovery", conversationId: "seat", seatEpoch: 7, at: new Date(NOW).toISOString(), state: "revived", detail: "fixture", told: false };
  expect(seatHostRecoveryCard(record, locale).state).toBe("resolved");
  for (const state of ["pending", "rotated", "failed", "superseded"] as const) {
    expect(seatHostRecoveryCard({ ...record, state }, locale).state).toBe("open");
  }
});
