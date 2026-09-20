import { NextRequest, NextResponse } from "next/server";

import { applyConversationMigration } from "@/lib/accounts/migration/conversationCommand";
import { callerConversationId } from "@/lib/agent/operatorAuthority";
import type { ConversationMigrationCommandDependencies } from "@/lib/accounts/migration/conversationCommand";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { agentRegistry, type AgentRegistry } from "@/lib/agent/registry";
import { runtimeHostClient, type RuntimeHostClient } from "@/lib/runtime/client";
import { structuredDeliveryHostForConversation } from "@/lib/runtime/structuredDeliveryController";
import type { EngineHost } from "@/lib/runtime/engineHost";
import { hardenedRedact } from "@/lib/view/compactText";

const boundedReference = (value: string | null | undefined) => value == null ? null : hardenedRedact(value).slice(0, 160);

interface MigrationReadDependencies {
  registry(): AgentRegistry;
  client(): RuntimeHostClient | null;
  host(conversationId: string): EngineHost | null;
}

/** A bounded observation, with no queue drain, recovery, retry or provider call.
 * Receipt bodies and provider diagnostics never leave this projection. */
export function createConversationMigrationGET(dependencies: MigrationReadDependencies = {
  registry: agentRegistry, client: runtimeHostClient, host: structuredDeliveryHostForConversation,
}) {
  return async function GET(req: NextRequest, { params }: { params: Promise<{ conversationId: string }> }) {
    const rejected = rejectCrossOrigin(req);
    if (rejected) return rejected;
    const { conversationId } = await params;
    if (!/^conversation_[a-zA-Z0-9_-]+$/.test(conversationId)) {
      return NextResponse.json({ error: "invalid conversation id" }, { status: 400 });
    }
    const requestedOperation = req.nextUrl.searchParams.get("operationId");
    if (requestedOperation !== null && !/^[a-zA-Z0-9_-]{1,160}$/.test(requestedOperation)) {
      return NextResponse.json({ error: "invalid operation id" }, { status: 400 });
    }
    const registry = dependencies.registry();
    const conversation = registry.conversation(conversationId as `conversation_${string}`);
    if (!conversation) return NextResponse.json({ error: "viewer conversation is unknown" }, { status: 404 });
    const generation = conversation.generations.at(-1);
    const entry = generation ? registry.readOnlySnapshot().entries[`${conversation.engine}:${generation.id}`] : null;
    const client = dependencies.client();
    const host = dependencies.host(conversation.id);
    // At most three keyed journal reads. No event scan or full runtime snapshot.
    const operations = [...new Set([requestedOperation, conversation.reconfigure?.operationId, conversation.migration?.operationId].filter((id): id is string => Boolean(id)))];
    const receipts = await Promise.all(operations.map(async operationId => {
      if (!client) return { operationId, read: "unavailable" };
      try {
        const result = await client.operationStatus(operationId);
        if (!result) return { operationId, read: "missing" };
        const receipt = result.receipt;
        if (registry.canonicalConversationId(receipt.conversationId as `conversation_${string}`) !== conversation.id) {
          return { operationId, read: "wrong-conversation" };
        }
        return { operationId, read: "observed", kind: receipt.kind, status: receipt.status,
          admittedAt: receipt.admittedAt ?? null, updatedAt: receipt.at, revision: receipt.revision, queuePosition: receipt.queuePosition ?? null };
      } catch { return { operationId, read: "unavailable" }; }
    }));
    let hostRead: Record<string, unknown> = { read: "not-owned-here" };
    if (host) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const health = await Promise.race([
          host.health(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("bounded host read")), 1_000); }),
        ]);
        hostRead = { read: "observed", status: health.status, activeTurnRef: boundedReference(health.activeTurnRef), observedAt: new Date().toISOString() };
      } catch { hostRead = { read: "unavailable" }; }
      finally { clearTimeout(timer); }
    }
    return NextResponse.json({
      conversationId: conversation.id, observedAt: new Date().toISOString(),
      controlChannel: client ? "configured" : "absent",
      host: hostRead,
      registry: { updatedAt: conversation.updatedAt, turn: conversation.turn.state,
        turnObservedAt: conversation.turn.observedAt, terminalAt: conversation.turn.terminalAt,
        hostStatus: entry?.status ?? null, activeTurnRef: boundedReference(entry?.structuredHost?.activeTurnRef),
        claimPresent: Boolean(entry?.claimOwner), claimEpoch: entry?.claimEpoch ?? null,
        writerClaimEpoch: entry?.structuredHost?.writerClaimEpoch ?? null,
        hostUpdatedAt: entry?.updatedAt ?? null },
      reconfigure: conversation.reconfigure ? { operationId: conversation.reconfigure.operationId, status: conversation.reconfigure.status, revision: conversation.reconfigure.revision } : null,
      migration: conversation.migration ? { operationId: conversation.migration.operationId, phase: conversation.migration.phase, revision: conversation.migration.revision, updatedAt: conversation.migration.updatedAt } : null,
      switchHold: conversation.switchHold ? { operationId: conversation.switchHold.operationId, at: conversation.switchHold.at } : null,
      receipts,
    }, { headers: { "cache-control": "no-store" } });
  };
}

export function createConversationMigrationPOST(dependencies: ConversationMigrationCommandDependencies = {}) {
  return async function POST(req: NextRequest, { params }: { params: Promise<{ conversationId: string }> }) {
    const rejected = rejectCrossOrigin(req);
    if (rejected) return rejected;
    let body: { action?: unknown; expectedRevision?: unknown; path?: unknown; operationId?: unknown; requestOperationId?: unknown; accountId?: unknown; targetAccountId?: unknown };
    try {
      body = await req.json() as typeof body;
    } catch {
      return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "body must be an object" }, { status: 400 });
    }
    if (body.requestOperationId !== undefined && (typeof body.requestOperationId !== "string" || !body.requestOperationId.trim())) {
      return NextResponse.json({ error: "requestOperationId must be a non-empty string" }, { status: 400 });
    }
    const { conversationId } = await params;
    const caller = callerConversationId(req);
    const result = await applyConversationMigration({
      conversationId,
      action: typeof body.action === "string" ? body.action : "",
      expectedRevision: typeof body.expectedRevision === "number" ? body.expectedRevision : undefined,
      path: body.path as string | undefined,
      operationId: body.operationId,
      requestOperationId: body.requestOperationId as string | undefined,
      accountId: body.accountId,
      targetAccountId: body.targetAccountId,
      actor: caller ? { kind: "agent", conversationId: caller } : { kind: "operator" },
    }, dependencies);
    return NextResponse.json(result.body, { status: result.status });
  };
}
