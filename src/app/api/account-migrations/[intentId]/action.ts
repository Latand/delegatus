import { NextRequest, NextResponse } from "next/server";

import { agentRegistry, type AgentRegistry } from "@/lib/agent/registry";
import { requestAccountMigrationTick } from "@/lib/accounts/migration/controllerSignal";
import { authorizeCodexForkRetry } from "@/lib/accounts/migration/provider";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

/** A write the registry lock refused: nothing changed, and asking again is safe. */
function busy(error: string): NextResponse {
  return NextResponse.json({ error, retryable: true }, { status: 503 });
}

export async function updateMigrationAction(
  req: NextRequest,
  { params }: { params: Promise<{ intentId: string }> },
  registry: AgentRegistry = agentRegistry(),
  requestTick: () => void = requestAccountMigrationTick,
  authorizeForkRetry: typeof authorizeCodexForkRetry = authorizeCodexForkRetry,
) {
  const rejected = rejectCrossOrigin(req); if (rejected) return rejected;
  let body: { action?: unknown; expectedRevision?: unknown }; try { body = await req.json() as typeof body; } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  if (body.action !== "stop" && body.action !== "retry-failed") return NextResponse.json({ error: "unsupported migration action" }, { status: 400 });
  if (body.expectedRevision !== undefined && (!Number.isInteger(body.expectedRevision) || (body.expectedRevision as number) < 0)) return NextResponse.json({ error: "expectedRevision must be a non-negative integer" }, { status: 400 });
  const { intentId } = await params;
  try {
    if (body.action === "stop") {
      /* Off the loop (docs/design/delivery-progress-and-drain.md, C2); a
         refusal changes nothing and the intent keeps draining. */
      const stopped = await registry.deliveryWrite({ label: "migration.stop" },
        () => registry.setMigrationIntentState(intentId, "stopped", body.expectedRevision as number | undefined));
      if (!stopped.acquired) return busy("the stop could not be recorded; nothing changed");
      return NextResponse.json(stopped.value);
    }
    const snapshot = registry.readOnlySnapshot();
    const intent = snapshot.migrationIntents[intentId];
    if (!intent) return NextResponse.json({ error: "migration intent is unknown" }, { status: 404 });
    if (body.expectedRevision !== undefined && intent.revision !== body.expectedRevision) return NextResponse.json({ error: "migration intent revision is stale" }, { status: 409 });
    const failed = Object.values(snapshot.conversations)
      .filter((conversation) => conversation.migration?.intentId === intentId && conversation.migration.phase === "failed-recoverable");
    const retried = [];
    for (const conversation of failed) {
      const migration = conversation.migration!;
      if (conversation.engine === "codex" && migration.errorCode === "codex-fork-outcome-unknown") {
        await authorizeForkRetry(migration.operationId, conversation.id);
      }
      const retry = await registry.deliveryWrite({ label: "migration.retry", operationId: migration.operationId },
        () => registry.retryConversationMigration(conversation.id, migration.revision));
      if (!retry.acquired) {
        if (retried.length > 0) requestTick();
        return busy("the retry could not be recorded; try again");
      }
      retried.push(retry.value);
    }
    if (retried.length > 0) requestTick();
    return NextResponse.json({ intent, retried: retried.length });
  }
  catch (error) {
    const conflict = error instanceof Error && error.message.includes("revision");
    return NextResponse.json({ error: conflict ? "migration intent revision is stale" : "migration action failed" }, { status: conflict ? 409 : 404 });
  }
}
