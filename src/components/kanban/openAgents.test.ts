import { expect, test } from "bun:test";
import type { FileEntry } from "@/lib/types";
import { rowStateWord } from "@/components/mobile/mobileBoardModel";
import { openAgents } from "./openAgents";
import type { ReaderView } from "./KanbanReaders";

/*
 * The seat's open-agents entry reads the state the seat's head reads. A seat
 * idle between turns is «waiting» there, a decision form open makes it wait on
 * the operator, and a conversation that is not the seat keeps its own reading.
 */

const NOW_S = 1_800_000_000;
const AGE_S = 1_044;
const t = ((key: string) => key) as never;

const idleFile = {
  path: "/repo/atlas/seat.jsonl", root: "claude-projects", name: "seat.jsonl", project: "atlas", title: "Atlas orchestrator",
  engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: NOW_S - AGE_S, size: 1, activity: "idle",
  proc: "running", pid: 4242, conversationId: "conversation_seat", model: "opus", renamable: true,
  lastTurn: { startedAt: (NOW_S - AGE_S - 400) * 1000, endedAt: (NOW_S - AGE_S) * 1000 },
  authoritativeTurn: { state: "terminal", source: "lifecycle", terminalAt: new Date((NOW_S - AGE_S) * 1000).toISOString(), terminalKind: "completed" },
} as unknown as FileEntry;

const view = (over: Partial<ReaderView>): ReaderView => ({ readerKey: "seat", file: idleFile, owner: null, ...over });
const stateOf = (reader: ReaderView) => openAgents(t, [reader], [{ key: "seat" }], NOW_S)[0]!;

test("an idle seat is waiting in the open agents, in the quiet tone, and never done", () => {
  const entry = stateOf(view({ seat: true, seatWaiting: true }));
  expect(entry.state).toBe("waiting");
  expect(entry.tone).toBe("neutral");
  expect(entry.live).toBe(false);
});

test("the open-agents word for the idle seat is the seat head's word, not «needs you»", () => {
  const word = (entry: ReturnType<typeof stateOf>) => rowStateWord(t, { key: entry.state, activity: entry.activity, badge: entry.badge });
  expect(word(stateOf(view({ seat: true, seatWaiting: true })))).toBe("orchPanel.badgeWaiting");
  expect(word(stateOf(view({ seat: true })))).toBe("kanban.memberState.done");
});

test("the flags change nothing for an agent that is not the seat", () => {
  expect(stateOf(view({ seat: false, seatWaiting: true })).state).toBe("done");
  expect(stateOf(view({ seat: true })).state).toBe("done");
});

test("a running seat stays working whatever the flag says", () => {
  const running = { ...idleFile, activity: "live", mtime: NOW_S - 20, lastTurn: { startedAt: (NOW_S - 400) * 1000, endedAt: null }, authoritativeTurn: { state: "busy", source: "lifecycle", terminalAt: null } } as unknown as FileEntry;
  const entry = stateOf(view({ file: running, seat: true, seatWaiting: true }));
  expect(entry.state).toBe("working");
  expect(entry.live).toBe(true);
});
