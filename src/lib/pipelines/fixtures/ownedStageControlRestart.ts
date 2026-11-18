import { expect } from "bun:test";
import { ownedStageControl, withControllerAuditState } from "./ownedStageControl";

const restartPreparationMs = 30_000;
const restartOperationMs = 15_000;
// Dead and unhosted recovery can start five children in sequence. Allow a
// separate sender-exit or admission wait, plus time for fixture setup and cleanup.
export const restartFixtureMs = 5 * (restartPreparationMs + restartOperationMs) + restartOperationMs + 30_000;

async function until(promise: Promise<unknown>, timeout: number, message: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeout); })]); }
  finally { clearTimeout(timer); }
}

type WithdrawalRefusal = "none" | "stale" | "legacy" | "unclassified" | "dead" | "legacy-dead" | "unhosted";

export function auditOwnedStageControlRestart(mutation: "stop" | "withdrawal", holdBeforeAdmission: boolean, refusal: WithdrawalRefusal) {
  return withControllerAuditState(async () => {
    const withdrawalRefusal = refusal === "dead" || refusal === "unhosted" || refusal === "unclassified" ? "unclassified"
      : refusal === "legacy" || refusal === "legacy-dead" ? "legacy" : undefined;
    const fixture = await ownedStageControl(mutation, "2026-11-18T12:00:00.000Z", holdBeforeAdmission, { withdrawalRefusal });
    if (refusal === "legacy-dead") fixture.publish("dead", null);
    const target = {
      conversationId: fixture.conversationId, launchId: fixture.launchId, agentPath: fixture.transcriptPath,
      stageId: "build", attempt: 1, paneId: null,
    };
    const source = `
      import { defaultPipelinePorts, invalidateProviderContinuation } from "./src/lib/pipelines/engine.ts";
      import { terminalIdleStopKey } from "./src/lib/pipelines/stageControlCustody.ts";
      const { mutation, target } = JSON.parse(process.argv[1]);
      const ports = mutation === "stop" ? defaultPipelinePorts() : null;
      await new Promise(resolve => {
        process.once("message", resolve);
        process.send("ready");
      });
      try {
        const outcome = mutation === "stop"
          ? await ports.stopStageAgent(target, { onlyIfIdle: true, operationId: terminalIdleStopKey(target) })
          : (await invalidateProviderContinuation(target.conversationId, undefined, { key: "fixture-restart-withdrawal", artifactPath: target.agentPath }), { outcome: "confirmed" });
        console.log("owned-control-result", JSON.stringify(outcome));
      } catch (error) {
        console.log("owned-control-result", JSON.stringify({ outcome: "unknown", reason: String(error) }));
      } finally {
        process.disconnect();
      }
    `;
    const start = (role: string) => {
      const ready = Promise.withResolvers<void>();
      const child = Bun.spawn([process.execPath, "-e", source, JSON.stringify({ mutation, target })], {
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
        ipc(message) { if (message === "ready") ready.resolve(); },
      });
      const errors = new Response(child.stderr).text();
      const output = new Response(child.stdout).text();
      void child.exited.then(async code => ready.reject(new Error(
        `owned ${mutation} ${role} exited before readiness (${code}): ${await errors} ${await output}`)));
      const execute = async () => {
        await until(ready.promise, restartPreparationMs, `owned ${mutation} ${role} preparation exceeded ${restartPreparationMs} ms`);
        child.send("execute");
      };
      return { child, errors, output, execute };
    };
    const { child: incumbent, errors: initialError, output: initialOutput, execute } = start("sender");
    const finishSender = async () => {
      await until(incumbent.exited, restartOperationMs, `owned ${mutation} sender operation did not exit within ${restartOperationMs} ms`);
      expect(await incumbent.exited).toBe(0);
    };
    const observe = async () => {
      const observer = start("observer");
      try {
        await observer.execute();
        const result = Promise.all([observer.child.exited, observer.errors, observer.output]);
        await until(result, restartOperationMs, `owned ${mutation} observer operation exceeded ${restartOperationMs} ms`);
        const [code, errors, output] = await result;
        expect(code, errors).toBe(0);
        const observed = output.split("\n").find(line => line.startsWith("owned-control-result "));
        if (!observed) throw new Error("restarted mutation observer did not report an outcome");
        return JSON.parse(observed.slice("owned-control-result ".length));
      } finally {
        if (observer.child.exitCode === null && observer.child.signalCode === null) observer.child.kill();
        await observer.child.exited;
      }
    };
    try {
      const held = holdBeforeAdmission || withdrawalRefusal ? fixture.mutationEntered : fixture.mutationAccepted;
      await execute();
      await until(Promise.race([held, incumbent.exited.then(async code => {
        throw new Error(`owned mutation sender exited before it reached the held phase (${code}): ${await initialError} ${await initialOutput}`);
      })]), restartOperationMs, `owned ${mutation} sender operation did not reach the held phase within ${restartOperationMs} ms`);
      if (withdrawalRefusal) {
        await finishSender();
        expect(await initialOutput).toContain("requires a session-status event and its observed revision");
        expect(fixture.dispatches).toEqual(["append-session-fenced"]);
        expect(fixture.withdrawals).toHaveLength(0);
        const initialRevision = fixture.journal.readSession({ conversationId: fixture.conversationId })?.revision;
        expect(initialRevision).toBeDefined();
        fixture.upgradeRuntime();
        fixture.release();
        if (withdrawalRefusal === "unclassified") {
          const unknown = { outcome: "unknown", reason: expect.stringContaining("awaits a confirmed receipt") };
          expect(await observe()).toMatchObject(unknown);
          expect(await observe()).toMatchObject(unknown);
          expect(fixture.dispatches).toEqual(["append-session-fenced"]);
          expect(fixture.withdrawals).toHaveLength(0);
          if (refusal === "dead" || refusal === "unhosted") {
            const { claimWithdrawal, readWithdrawal } = await import("../stageControlCustody");
            const ownerKey = "fixture-restart-withdrawal";
            const old = await readWithdrawal(ownerKey);
            if (!old) throw new Error("the pending withdrawal has no durable owner");
            fixture.publish(refusal, null);
            expect(await observe()).toEqual({ outcome: "confirmed" });
            fixture.publish("idle", "fixture-writer-two");
            const revived = fixture.journal.readSession({ conversationId: fixture.conversationId })!;
            expect(await claimWithdrawal(ownerKey, { conversationId: old.conversationId, sessionKey: old.sessionKey,
              artifactPath: old.artifactPath, revision: revived.revision, writerClaim: revived.writerClaim ?? null }, old))
              .toEqual({ acquired: false, binding: old });
            expect(await observe()).toEqual({ outcome: "confirmed" });
            expect(fixture.dispatches).toEqual(["append-session-fenced"]);
            expect(fixture.withdrawals).toHaveLength(0);
          }
          return;
        }
        expect(await observe()).toEqual({ outcome: "confirmed" });
        expect(await observe()).toEqual({ outcome: "confirmed" });
        expect(fixture.dispatches).toEqual(["append-session-fenced", "append-session-fenced"]);
        expect(fixture.withdrawalKeys).toEqual([expect.any(String), fixture.withdrawalKeys[0]]);
        expect(fixture.withdrawals).toHaveLength(1);
        expect(fixture.withdrawals[0]?.expectedSessionRevision).toBe(initialRevision!);
        return;
      }
      if (refusal === "stale") {
        fixture.publish("running", "fixture-writer-two");
        fixture.release();
        await finishSender();
        expect(await initialOutput).toContain("the session row changed");
        expect(fixture.withdrawals).toHaveLength(0);
        const active = await observe();
        expect(active).toMatchObject({ outcome: "unknown", reason: expect.stringContaining("awaits a confirmed receipt") });
        expect(fixture.dispatches).toHaveLength(1);
        fixture.publish("idle", "fixture-writer-two");
        expect(await observe()).toEqual({ outcome: "confirmed" });
        expect(await observe()).toEqual({ outcome: "confirmed" });
        expect(fixture.withdrawals).toHaveLength(1);
        expect(fixture.dispatches).toEqual(["append-session-fenced", "append-session-fenced"]);
        return;
      }
      const { claimIdleStop, readIdleStop, terminalIdleStopKey } = await import("../stageControlCustody");
      const stopBinding = mutation === "stop" ? await readIdleStop(terminalIdleStopKey(target)) : null;
      if (mutation === "stop" && !stopBinding) throw new Error("the in-flight stop has no ownership binding");
      incumbent.kill();
      await incumbent.exited;
      const pending = await observe();
      expect(fixture.dispatches).toHaveLength(1);
      if (stopBinding) expect(pending).toMatchObject({ outcome: "unconfirmed", operationId: stopBinding.operationId });
      if (holdBeforeAdmission) {
        expect(fixture.stops).toHaveLength(0);
        expect(fixture.withdrawals).toHaveLength(0);
        expect(pending.outcome).toBe(mutation === "stop" ? "unconfirmed" : "unknown");
        if (mutation === "withdrawal") expect(pending.reason).toContain("awaits a confirmed receipt");
        fixture.release();
        await until(fixture.mutationAccepted, restartOperationMs,
          `owned ${mutation} did not reach admission after release within ${restartOperationMs} ms`);
      }
      const reconciled = holdBeforeAdmission ? await observe() : pending;
      expect(fixture.dispatches).toHaveLength(1);
      if (stopBinding) {
        expect(fixture.stops).toMatchObject([{ operationId: stopBinding.operationId,
          receipt: { idempotencyKey: stopBinding.operationId } }]);
        expect(reconciled).toMatchObject({ outcome: "unconfirmed", operationId: stopBinding.operationId });
        const binding = await readIdleStop(terminalIdleStopKey(target));
        expect(binding).toEqual(stopBinding);
        const alias = terminalIdleStopKey({ ...target, launchId: "another-attempt-for-the-same-host" });
        const { kind: _kind, operationId: _operationId, ...identity } = stopBinding;
        expect(await claimIdleStop(alias, identity)).toEqual({ acquired: false, binding: stopBinding });
        expect(await readIdleStop(alias)).toEqual(stopBinding);
      } else {
        expect(fixture.withdrawals).toHaveLength(1);
        expect(reconciled).toEqual({ outcome: "confirmed" });
        const { claimWithdrawal, readWithdrawal } = await import("../stageControlCustody");
        const binding = await readWithdrawal("fixture-restart-withdrawal");
        if (!binding) throw new Error("the accepted withdrawal has no ownership binding");
        const { kind: _kind, producerPrefix: _prefix, ...identity } = binding;
        const closeOwner = "fixture-close-withdrawal";
        expect(await claimWithdrawal(closeOwner, identity)).toEqual({ acquired: false, binding });
        expect(await readWithdrawal(closeOwner)).toEqual(binding);
      }
    } finally {
      if (incumbent.exitCode === null && incumbent.signalCode === null) incumbent.kill();
      await incumbent.exited;
      await fixture.dispose();
    }
  });
}
