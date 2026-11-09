import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { migrationDeliveryFixture } from "@/test-helpers/migrationDelivery";
import { assertPipelineTurnAllowed, pipelineRequiresDispatchGuard } from "./accountCreditGuard";
import { StructuredDispatchDeferredError, StructuredSendRefusedError, type EngineHost } from "./engineHost";
import { NativeCodexQueue } from "./nativeCodexQueue";
import { NativeQueueExecutor } from "./nativeQueueExecutor";
import type { NativeQueueCommand } from "./nativeQueueContracts";

afterEach(() => setSystemTime());

for (const { scope, boundary } of [
  { scope: "queue", boundary: "waiting" },
  { scope: "queue", boundary: "prepared" },
  { scope: "execution", boundary: "prepared" },
] as const) {
  for (const value of ["error", "string", "sensitive"] as const) {
    test(`${scope} authority retains ${value} cause and defers ${boundary} native delivery with a safe diagnostic`, async () => {
      setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      const f = migrationDeliveryFixture();
      // Assemble hostile diagnostics at runtime so no credential or private path
      // becomes a publication fixture. Put the secret across the output bound.
      const credential = ["sk", "fixture".repeat(8)].join("-");
      const privatePath = ["", "home", "fixture-user", "registry.sqlite"].join("/");
      const detail = value === "sensitive"
        ? `retained row rejected ${privatePath} ${"x".repeat(110)} ${credential} ${"y".repeat(400)}`
        : "retained row rejected";
      const cause = value === "string" ? detail : new Error(detail);
      let healthyReads = 0;
      const memberships = f.registry.conversationMemberships.bind(f.registry);
      const read = spyOn(f.registry, "conversationMemberships").mockImplementation((...args) => {
        if (healthyReads-- > 0) return memberships(...args);
        throw cause;
      });
      const command: NativeQueueCommand & { operationId: string } = {
        kind: "native-queue", action: "add", operationId: `authority-${scope}-${value}`,
        idempotencyKey: `authority-${scope}-${value}`, conversationId: f.conversation.id,
        binding: { threadId: f.key.sessionId, accountId: "account-a" }, text: "queued input",
      };
      f.journal.append({ scope: `session:${f.conversation.id}`, kind: "session-status", payload: {
        conversationId: f.conversation.id, sessionKey: f.key, hostKind: "codex-app-server",
        host: "hosted", turn: "running", activeTurnId: "fixture-turn", accountId: "account-a",
        capabilities: { steer: true, structuredAttention: true, nativeQueue: true },
      } });
      const guard = () => scope === "queue"
        ? pipelineRequiresDispatchGuard(f.conversation.id, f.registry)
        : assertPipelineTurnAllowed(f.conversation.id, f.registry, { operationId: command.operationId });
      const calls: string[] = [];
      const notes: Array<{ reason: string; detail: string | null | undefined }> = [];
      const host = {
        health: async () => ({ status: "active", activeTurnRef: "fixture-turn" }),
        nativeQueue: {
          queue: new NativeCodexQueue({ rpc: async (method, params) => {
            calls.push(method);
            if (method === "thread/queue/add") return { queuedSubmission: {
              id: "fixture-submission", clientUserMessageId: params.clientUserMessageId, input: params.input,
            } };
            throw new Error("unexpected native mutation");
          } }, f.key.sessionId),
          prepare: async () => [{ type: "text" as const, text: command.text! }],
          evidence: async () => null,
          sendWithdrawn: async () => { calls.push("turn/start"); return { turnId: "fixture-start" }; },
        },
      } as unknown as EngineHost;
      const executor = () => new NativeQueueExecutor({
        client: { ...f.client,
          nativeQueueRead: async id => f.journal.nativeQueueRead(id),
          nativeQueueTransition: async (id, change) => f.journal.nativeQueueTransition(id, change),
        },
        resolveHost: () => host, binding: () => command.binding,
        ...(scope === "queue" ? { requiresDispatchGuard: () => guard() === true }
          : { authorizeDispatch: () => { guard(); } }),
      });
      try {
        let failure: unknown;
        try { guard(); } catch (error) { failure = error; }
        expect(failure).toBeInstanceOf(StructuredDispatchDeferredError);
        if (!(failure instanceof StructuredDispatchDeferredError)) throw new Error("authority read did not defer");
        expect(failure.cause).toBe(cause);
        expect(failure.message).toStartWith(`pipeline ${scope} authority is temporarily unreadable:`);
        expect(failure.message).toContain("retained row rejected");
        expect(failure.message.length).toBeLessThanOrEqual(240);
        if (value === "sensitive") {
          expect(failure.message).not.toContain(credential);
          expect(failure.message).not.toContain(privatePath);
          expect(failure.message).not.toContain("fixture-user");
          expect(failure.message).not.toContain("sk-");
          expect(failure.message).toContain("[redacted]");
          expect(failure.message).toContain("…");
        }
        f.journal.executeOperation(command);
        // The queue guard runs both before preparation and immediately before
        // native actuation. Lose its read only at the selected boundary.
        healthyReads = scope === "queue" && boundary === "prepared" ? 1 : 0;
        expect(await executor().execute(command, undefined, (reason, detail) => notes.push({ reason, detail }))).toBe(false);
        expect(calls).toEqual([]);
        expect(notes.at(-1)).toEqual({ reason: "evidence-unreadable", detail: failure.message });
        expect(f.journal.operationResult(command.operationId)?.receipt.status).toBe("queued");
        expect(f.journal.nativeQueueRead(f.conversation.id)[0]?.state).toBe("admitted");
        if (boundary === "prepared") {
          expect(f.journal.operationResult(command.operationId)?.receipt.reason).toBe(failure.message);
          expect(f.journal.nativeQueueRead(f.conversation.id)[0]?.reason).toBe(failure.message);
        }
        read.mockRestore();
        // Reconstruct the executor with healthy authority. The same queued
        // operation must reach the native observer exactly once.
        await executor().execute(command);
        await executor().execute(command);
        expect(calls).toEqual(["thread/queue/add"]);
        expect(f.journal.operationResult(command.operationId)?.receipt.status).toBe("applied");
      } finally { read.mockRestore(); await f.cleanup(); }
    });
  }
}

for (const ErrorType of [StructuredDispatchDeferredError, StructuredSendRefusedError]) {
  test(`execution preserves an existing ${ErrorType.name}`, async () => {
    const f = migrationDeliveryFixture();
    const original = new ErrorType("existing authority refusal");
    const read = spyOn(f.registry, "conversationMemberships").mockImplementation(() => { throw original; });
    try {
      let failure: unknown;
      try { assertPipelineTurnAllowed(f.conversation.id, f.registry); } catch (error) { failure = error; }
      expect(failure).toBe(original);
    } finally { read.mockRestore(); await f.cleanup(); }
  });
}
