import { pendingBackgroundTasks, readBackgroundTaskLedger, type BackgroundTaskLedger } from "@/lib/pipelines/backgroundTasks";
import { readRuntimeSession, runtimeHostClient } from "@/lib/runtime/client";
import type { RuntimeSession } from "@/lib/runtime/contracts";

import { canonicalOrchestratorProject, orchestratorSeatFor } from "./seats";

/** A turn can keep working without producing text. Monitor stall verdicts
 * decide whether to wake a seat; the runtime turn decides whether to fork it.
 * Claude also owns background commands/monitors after its turn ends. */
export function deputySeatBusy(session: Pick<RuntimeSession, "host" | "turn"> | null, ledger: BackgroundTaskLedger | null, now: number): boolean {
  if (!session || (session.host !== "hosted" && session.host !== "registering")) return false;
  return session.turn === "running" || session.turn === "interrupt_requested"
    || Boolean(ledger && pendingBackgroundTasks(ledger, now).some((task) => task.kind !== "wakeup"));
}

/** Both the composer's read and the command's admission use this reading. An
 * unavailable host is an unavailable reading, rather than evidence of idle. */
export interface DeputySeatBusySources {
  seat(project: string): { conversationId: string | null } | null;
  session(conversationId: string): Promise<RuntimeSession | null>;
  ledger(path: string): Promise<BackgroundTaskLedger | null>;
  now(): number;
}

const productionSources: DeputySeatBusySources = {
  seat: (project) => orchestratorSeatFor(project).active,
  session: async (conversationId) => {
    const client = runtimeHostClient();
    if (!client) throw new Error("seat activity is unavailable");
    return readRuntimeSession(client, { conversationId });
  },
  ledger: readBackgroundTaskLedger,
  now: Date.now,
};

export async function readDeputySeatBusy(project: string, sources: DeputySeatBusySources = productionSources): Promise<{ conversationId: string | null; busy: boolean }> {
  const seat = sources.seat(canonicalOrchestratorProject(project));
  if (!seat?.conversationId) return { conversationId: null, busy: false };
  const session = await sources.session(seat.conversationId);
  let ledger: BackgroundTaskLedger | null = null;
  if (session?.host === "hosted" && session.turn === "idle" && session.sessionKey.engine === "claude") {
    ledger = session.artifactPath ? await sources.ledger(session.artifactPath) : null;
    if (!ledger) throw new Error("seat background activity is unavailable");
  }
  return { conversationId: seat.conversationId, busy: deputySeatBusy(session, ledger, sources.now()) };
}
