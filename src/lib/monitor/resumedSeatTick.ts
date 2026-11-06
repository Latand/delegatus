import { activeOrchestratorSeats } from "@/lib/orchestrator/seats";
import type { SeatTickControllerDependencies } from "./seatTickController";

type Seat = { state: string; conversationId: string | null; project: string };
type Dependencies = { seats?: () => readonly Seat[]; controller?: SeatTickControllerDependencies };
const globals = globalThis as typeof globalThis & { __llvResumedSeatTicks?: Map<string, Promise<void>> };
const pending = globals.__llvResumedSeatTicks ??= new Map<string, Promise<void>>();

/** Recheck owed work after an explicit resume, under the tick's normal fences. */
export function requestResumedSeatTick(conversationId: string, dependencies: Dependencies = {}): Promise<void> {
  const existing = pending.get(conversationId);
  if (existing) return existing;
  const work = Promise.resolve().then(async () => {
    const seat = (dependencies.seats ?? activeOrchestratorSeats)().find(row =>
      row.state === "active" && row.conversationId === conversationId);
    if (!seat) return;
    await (await import("./seatTickController")).reconcileSeatTick(dependencies.controller, [seat.project]);
  });
  pending.set(conversationId, work);
  void work.finally(() => { if (pending.get(conversationId) === work) pending.delete(conversationId); }).catch(() => {});
  return work;
}
