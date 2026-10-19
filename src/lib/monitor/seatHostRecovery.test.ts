import { expect, test, fs, path, SANDBOX, runSeatTickCheck, statePath, PROJECT, CONVERSATION, NOW, MINUTE, harness, OVERDUE, OPEN_LANE, writeSeatTickState, emptySeatTickState, createHash } from "./seatTickController.fixture";
import { loadTasks, saveTasksFile } from "@/lib/tasks/store";
import { buildPipeline, savePipelines } from "@/lib/pipelines/store";
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

test.each([
  ["edited", "inbox", { color: "slate" }],
  ["assigned", "assigned", {}],
  ["pipeline-linked", "inbox", {}],
] as const)("replaying a successful recovery preserves a legacy %s notice", async (kind, status, extra) => {
  const directory = fs.mkdtempSync(path.join(SANDBOX, `recovery-replay-${kind}-`));
  const previous = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = directory;
  try {
    const stateFile = path.join(directory, "seat-tick.json");
    const record: SeatHostRecovery = { id: `recovery-${kind}`, conversationId: CONVERSATION, seatEpoch: 7,
      at: new Date(NOW).toISOString(), state: "revived", detail: "shared composer recovery started a fresh host", told: false };
    writeSeatTickState(PROJECT, { ...emptySeatTickState(), seatEpoch: 7, hostRecovery: record }, stateFile);

    const legacyCard = seatHostRecoveryCard(record, "uk");
    const legacyRef = `seat-host-recovery-${createHash("sha256").update(record.id).digest("hex").slice(0, 32)}`;
    const taskId = `legacy-${kind}`;
    saveTasksFile({ tasks: [{ id: taskId, project: PROJECT, status, text: legacyCard.detail,
      details: `${legacyCard.record}\n\nmonitor-ref: ${legacyRef}`, placement: "unplaced", assignments: [],
      createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(), ...extra }], recentCreates: [] }, statePath("tasks.json"));
    if (kind === "pipeline-linked") {
      savePipelines([buildPipeline({ id: "recovery-replay-pipeline", task: "linked work", project: PROJECT,
        repoDir: directory, taskIds: [taskId], stages: [], srcPath: null, srcConversationId: null,
        now: new Date(NOW).toISOString(), state: "draft" })]);
    }

    const rig = harness({ stateFile });
    await runSeatTickCheck(PROJECT, { ...rig.deps, ensureCard: undefined });
    expect(loadTasks(statePath("tasks.json")).find(task => task.id === taskId)?.status).toBe(status);
    expect(rig.deps.readState!(PROJECT).hostRecovery).toMatchObject({ id: record.id, state: "revived", told: true });
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
