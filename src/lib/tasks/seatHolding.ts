import { orchestratorSeatForOrUnknown } from "@/lib/orchestrator/seats";

import type { SeatHolding } from "./commands";
import { seatAssignment } from "./groupHide";
import type { BoardTask } from "./types";

type ProjectSeats = NonNullable<ReturnType<typeof orchestratorSeatForOrUnknown>>;

/** One lazy seat-store snapshot per project for a single task command. Create
    a fresh reader for each command so later seat changes remain visible. */
export function taskSeatHoldingSnapshot(
  seatsFor: (project: string) => ProjectSeats | null = orchestratorSeatForOrUnknown,
): (task: BoardTask) => SeatHolding {
  const snapshots = new Map<string, ProjectSeats | null>();
  return (task) => taskSeatHolding(task, (project) => {
    if (!snapshots.has(project)) {
      let seats: ProjectSeats | null;
      try {
        seats = seatsFor(project);
      } catch {
        seats = null;
      }
      snapshots.set(project, seats);
    }
    return snapshots.get(project)!;
  });
}

/**
 * Whether a task holds its project's orchestrator seat conversation (#1695):
 * the one group a hide must refuse, because the seat stays on the board.
 *
 * The task holds the seat when one of its assignments names the active seat's
 * conversation, or a pending seat's once it has one, by conversation id or by
 * path — the same rule the board applies when it renders a hidden group
 * (`groupHide.ts`). A seat record the store cannot establish (torn, a future
 * schema, an unreadable path) answers `unknown`, and the hide is refused; a
 * missing record is a project with no seat.
 */
export function taskSeatHolding(
  task: BoardTask,
  seatsFor: (project: string) => ProjectSeats | null = orchestratorSeatForOrUnknown,
): SeatHolding {
  let seats: ProjectSeats | null;
  try {
    seats = seatsFor(task.project);
  } catch {
    seats = null;
  }
  if (!seats) return "unknown";
  const refs = { conversationIds: [] as string[], paths: [] as string[] };
  for (const seat of [seats.active, seats.pending]) {
    if (seat?.conversationId) refs.conversationIds.push(seat.conversationId);
    if (seat?.path) refs.paths.push(seat.path);
  }
  return seatAssignment(task.assignments, refs) ? "holds" : "free";
}
