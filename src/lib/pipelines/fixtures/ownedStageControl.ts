import { spyOn } from "bun:test";
import crypto from "node:crypto";
import { createServer, type Socket } from "node:net";
import fs from "node:fs";
import path from "node:path";
import { agentRegistry } from "@/lib/agent/registry";
import { sessionKeyId } from "@/lib/agent/sessionKey";
import { beginLegacySpawnFixture, structuredHostFixture } from "@/lib/agent/registryTestFixtures";
import { captureProcessIdentity, processIdentityMayRun } from "@/lib/processIdentity";
import type { RuntimeEventInput, RuntimeOperationResult, RuntimeSocketRequest } from "@/lib/runtime/contracts";
import { RuntimeHost } from "@/runtime-host/host";
import { RuntimeJournal } from "@/runtime-host/journal";

/** Private journal and socket. The fixture answers the RPC after the journal
 * has recorded it, with an optional held acknowledgement. It runs no delivery
 * workers and the only process it stops is the child it created. */
export async function ownedStageControl(hold: "stop" | "withdrawal", now: string, holdBeforeAdmission = false) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR!, "stage-control-"));
  const socketPath = path.join(dir, "host.sock");
  const sessionId = ["00000000", "0000", "4000", "8000", "000000000001"].join("-");
  const key = { engine: "codex" as const, sessionId };
  const transcriptPath = path.join(dir, key.sessionId + ".jsonl");
  const registry = agentRegistry();
  const agent = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 60000)"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const sockets = new Set<Socket>();
  const pending = new Set<Promise<void>>();
  const journal = new RuntimeJournal(path.join(dir, "runtime.sqlite"), { structuredHosts: true, now: () => Date.parse(now) });
  const runtime = new RuntimeHost(journal, undefined, undefined, true);
  let release!: () => void;
  const acknowledgement = new Promise<void>(resolve => { release = resolve; });
  const stops: RuntimeOperationResult[] = [];
  const dispatches: RuntimeSocketRequest["method"][] = [];
  let entered!: () => void;
  const mutationEntered = new Promise<void>(resolve => { entered = resolve; });
  const withdrawals: RuntimeEventInput[] = [];
  let accepted!: () => void;
  const mutationAccepted = new Promise<void>(resolve => { accepted = resolve; });
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => { sockets.delete(socket); });
    let input = "";
    socket.on("data", function receive(chunk) {
      input += chunk.toString();
      const delimiter = input.indexOf("\n");
      if (delimiter < 0) return;
      socket.off("data", receive);
      const request = JSON.parse(input.slice(0, delimiter)) as RuntimeSocketRequest;
      const work = (async () => {
        const command = request.params?.command as { kind?: string } | undefined;
        const event = request.params?.event as RuntimeEventInput | undefined;
        const stop = request.method === "command" && command?.kind === "kill";
        const withdrawal = (request.method === "append-session-fenced" || request.method === "append")
          && event?.kind === "pipeline.provider-continuation-cancelled";
        const held = (hold === "stop" && stop) || (hold === "withdrawal" && withdrawal);
        if (held) {
          dispatches.push(request.method);
          entered();
          if (holdBeforeAdmission) await acknowledgement;
        }
        const response = await runtime.handle(request);
        if (response.ok && stop) stops.push(response.result as RuntimeOperationResult);
        if (response.ok && withdrawal) withdrawals.push(event!);
        if (held && response.ok) {
          accepted();
          if (!holdBeforeAdmission) await acknowledgement;
        }
        if (!socket.destroyed) socket.end(JSON.stringify(response) + "\n");
      })().catch(error => { socket.destroy(error); });
      pending.add(work);
      void work.then(() => pending.delete(work));
    });
  });
  const previousSocket = process.env.LLV_RUNTIME_HOST_SOCKET;
  const previousFlag = process.env.LLV_STRUCTURED_HOSTS;
  const dispose = async () => {
    if (previousSocket === undefined) delete process.env.LLV_RUNTIME_HOST_SOCKET;
    else process.env.LLV_RUNTIME_HOST_SOCKET = previousSocket;
    if (previousFlag === undefined) delete process.env.LLV_STRUCTURED_HOSTS;
    else process.env.LLV_STRUCTURED_HOSTS = previousFlag;
    release();
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await Promise.allSettled(pending);
    if (agent.exitCode === null) agent.kill();
    await agent.exited;
    journal.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  try {
    fs.writeFileSync(transcriptPath, "{}\n");
    let serial = 0;
    const ids = spyOn(crypto, "randomUUID").mockImplementation(() => `bcf00001-0000-4000-8000-${(++serial).toString(16).padStart(12, "0")}`);
    const spawn = (() => {
      try { return beginLegacySpawnFixture(registry, { engine: "codex", cwd: dir, transport: "structured" }); }
      finally { ids.mockRestore(); }
    })();
    if (spawn.kind !== "created") throw new Error("fixture host reservation unavailable");
    const { conversationId, launchId } = spawn.receipt;
    const settled = registry.settleSpawn(launchId, {
      key, artifactPath: transcriptPath, cwd: dir, accountId: null, status: "idle",
      host: null, structuredHost: structuredHostFixture(captureProcessIdentity(agent.pid), "codex-app-server"),
      claimEpoch: 1, claimOwner: "structured-host:fixture-stage-owner", pendingAction: null,
    });
    if (settled.kind !== "settled") throw new Error("fixture host binding unavailable");
    const entry = registry.readOnlySnapshot().entries[sessionKeyId(key)];
    if (settled.conversation.generations.at(-1)?.id !== key.sessionId
      || !entry?.structuredHost?.process || !processIdentityMayRun(entry.structuredHost.process)) {
      throw new Error("fixture registry did not record a resident stage process");
    }
    const publish = (turn: "idle" | "running", writerClaim: string) => journal.append({
      scope: { type: "session", id: conversationId }, kind: "session-status",
      payload: { sessionKey: key, artifactPath: transcriptPath, writerClaim, hostKind: "codex-app-server",
        host: "hosted", turn, activeTurnId: turn === "running" ? "fixture-new-turn" : null, nativeTurnClaims: [] },
    });
    publish("idle", "fixture-writer-one");
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    process.env.LLV_RUNTIME_HOST_SOCKET = socketPath;
    process.env.LLV_STRUCTURED_HOSTS = "1";
    return { journal, publish, conversationId, launchId, transcriptPath, key, stops, withdrawals, dispatches, mutationEntered, mutationAccepted, release, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
