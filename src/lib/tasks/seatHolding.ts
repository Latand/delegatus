import { orchestratorSeatFor } from "@/lib/orchestrator/seats";

import type { SeatHolding } from "./commands";
import type { BoardTask } from "./types";

/**
 * Whether a task holds its project's orchestrator seat conversation (#1695):
 * the one group a hide must refuse, because the seat stays on the board.
 *
 * The task holds the seat when one of its assignments names the active seat's
 * conversation, or a pending seat's once it has one, by conversation id or by
 * path. A seat record that cannot be read answers `unknown`, and the hide is
 * refused. A malformed record reads as no seat, the same answer every other
 * seat authority takes from it.
 */
export function taskSeatHolding(
  task: BoardTask,
  seatsFor: (project: string) => Pick<ReturnType<typeof orchestratorSeatFor>, "active" | "pending"> = orchestratorSeatFor,
): SeatHolding {
  let seats: Pick<ReturnType<typeof orchestratorSeatFor>, "active" | "pending">;
  try {
    seats = seatsFor(task.project);
  } catch {
    return "unknown";
  }
  const refs = new Set<string>();
  for (const seat of [seats.active, seats.pending]) {
    if (seat?.conversationId) refs.add(seat.conversationId);
    if (seat?.path) refs.add(seat.path);
  }
  if (!refs.size) return "free";
  return task.assignments.some((assignment) => (assignment.conversationId && refs.has(assignment.conversationId)) || (assignment.path && refs.has(assignment.path)))
    ? "holds"
    : "free";
}
