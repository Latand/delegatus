import { expect, test, fs, path } from "./engine.fixture";
import { current, fixture, isolatePublicationGit } from "./publicationRecovery.fixture";
import { settlePendingStageGit, tickPipelines } from "./engine";
import { acquirePublicationFileLock, releasePublicationFileLock } from "./git";
import { pipelineArtifactsDir } from "./store";
import { realExec } from "@/lib/workflows/provision";
isolatePublicationGit();

for (const restart of [false, true]) {
  test(`commit-hook refusal after abandonment resumes restoration (${restart ? "fresh controller" : "same controller"})`, async () => {
    const f = await fixture();
    try {
      const clock = f.h.ports.now(); f.h.ports.now = () => clock;
      f.h.ports.resumeSeveredTurn = async () => true;
      f.h.ports.stageRepairDelivery = async () => ({ operationId: "repair-delivery", state: "delivered", safeToReplace: false });
      const accepted = await f.commit("accepted implementation");
      const acceptedTree = await f.git(f.lane(), "write-tree");
      f.refuse(); await f.finish();
      const attempt = current().runs[0]!.attempts[0]!;
      f.h.durableTurns.set(attempt.agentPath!, { turn: "busy", message: null, lastRecordAt: Date.parse(clock) });
      f.h.ports.publicationRepairProducerState = async () => "gone";
      f.h.ports.publicationRepairProducerGone = async () => true;
      f.h.ports.conversationTurnInterrupted = async () => "dead";
      fs.writeFileSync(path.join(f.lane(), "file.txt"), "rejected staged repair\n");
      await f.agentGit(f.lane(), "add", "file.txt");
      fs.writeFileSync(path.join(f.hooks, "pre-commit"), '#!/bin/sh\necho "repair commit refused by policy" >&2\nexit 1\n', { mode: 0o700 });
      const execute = f.h.ports.exec;
      let interrupted = false;
      f.h.ports.exec = async (...args) => {
        if (!interrupted && args[0] === "git" && args[1][0] === "read-tree") {
          interrupted = true;
          return { code: 1, stdout: "", stderr: "cleanup snapshot interrupted" };
        }
        return execute(...args);
      };
      await settlePendingStageGit(f.h.ports);
      const before = current().runs[0]!.attempts[0]!;
      expect(interrupted).toBe(true);
      expect(before.publicationRepairAbandonment).toBeDefined();
      expect(before.publicationRepair?.outcome).toMatchObject({ status: "rejected", reason: expect.stringContaining("repair commit refused by policy") });
      expect(before.publicationRepair?.rollback).toBeUndefined();
      expect(before.publicationRepair?.committedSha).toBeUndefined();
      expect(current().state).toBe("running");
      const refusedOperation = structuredClone(current().delivery!.operation);
      f.h.ports.exec = execute;
      // Permit a second commit so a mistaken replay really would publish it.
      fs.unlinkSync(path.join(f.hooks, "pre-commit"));
      if (restart) {
        const child = await realExec(process.execPath, ["-e", `
          const { defaultPipelinePorts, settlePendingStageGit } = await import("./src/lib/pipelines/engine");
          await settlePendingStageGit({ ...defaultPipelinePorts(), now: () => ${JSON.stringify(clock)}, scheduleTick: () => {},
            stageRepairDelivery: async () => ({ operationId: "repair-delivery", state: "delivered", safeToReplace: false }),
            durableTurnEvidence: async () => ({ turn: "busy", message: null, lastRecordAt: ${Date.parse(clock)} }),
            conversationAgentActive: async () => false, publicationRepairProducerState: async () => "gone",
            publicationRepairProducerGone: async () => true, conversationTurnInterrupted: async () => "dead",
            conversationDeliveryOutstanding: () => false, resumeSeveredTurn: async () => true });
        `], process.cwd(), { ...process.env }, { timeoutMs: 30000 });
        expect(child.code, child.stderr).toBe(0);
      } else await settlePendingStageGit(f.h.ports);
      const after = current().runs[0]!.attempts[0]!;
      expect(after.publicationRepair?.committedSha).toBeUndefined();
      expect(after.publicationRepair?.republishQueued).not.toBe(true);
      expect(after.publicationRepair?.outcome).toEqual(before.publicationRepair?.outcome);
      expect(after.publicationRepair?.rollback?.phase).toBe("done");
      expect(current().delivery!.operation).toEqual(refusedOperation);
      expect(current().lastPassedCommit).toBe(accepted);
      expect(current().stateDetail).toContain("repair commit refused by policy");
      expect(current().state).toBe("needs_decision");
      expect(await f.git(f.lane(), "rev-list", "--count", "--all")).toBe("2");
      expect(await f.git(f.lane(), "rev-parse", "HEAD")).toBe(accepted);
      expect(await f.git(f.lane(), "write-tree")).toBe(acceptedTree);
      expect(await f.git(f.lane(), "status", "--porcelain")).toBe("");
      expect(fs.readFileSync(path.join(f.lane(), "file.txt"), "utf8")).toBe("accepted implementation\n");
    } finally { f.close(); }
  });
}

for (const { restart, checkpoint, unread } of [
  { restart: false, checkpoint: false, unread: true }, { restart: true, checkpoint: false, unread: true },
  { restart: false, checkpoint: false, unread: false }, { restart: false, checkpoint: true, unread: false },
  { restart: true, checkpoint: false, unread: false }, { restart: true, checkpoint: true, unread: false },
]) {
  test(`explicit refusal survives host loss (${restart ? "fresh controller" : "same controller"}, ${unread ? "unread answer" : checkpoint ? "restore checkpoint" : "before checkpoint"})`, async () => {
    const f = await fixture();
    try {
      let clock = f.h.ports.now(); f.h.ports.now = () => clock;
      f.h.ports.resumeSeveredTurn = async () => true;
      f.h.ports.stageRepairDelivery = async () => ({ operationId: "repair-delivery", state: "delivered", safeToReplace: false });
      f.h.ports.publicationRepairProducerState = async () => "idle";
      f.h.ports.publicationRepairProducerGone = async () => false;
      f.h.ports.conversationTurnInterrupted = async () => "idle";
      const accepted = await f.commit("accepted implementation");
      f.refuse(); await f.finish();
      const original = structuredClone(current().runs[0]!.attempts[0]!);
      fs.writeFileSync(path.join(f.lane(), "file.txt"), "declined staged repair\n");
      await f.agentGit(f.lane(), "add", "file.txt");
      clock = new Date(Date.parse(clock) + 1000).toISOString();
      const terminal = { turn: "terminal" as const, message: {
        text: '```json\n{"status":"fail","blocked":true,"blockedReason":"cannot safely complete repair"}\n```',
        ts: Date.parse(clock) }, lastRecordAt: Date.parse(clock) };
      f.h.durableTurns.set(original.agentPath!, terminal);
      const execute = f.h.ports.exec;
      let interrupted = false;
      f.h.ports.exec = async (...args) => {
        if (!interrupted && !checkpoint && args[0] === "git" && args[1][0] === "read-tree") {
          interrupted = true;
          return { code: 1, stdout: "", stderr: "snapshot interrupted" };
        }
        if (!interrupted && checkpoint && args[0] === process.execPath) {
          const intent = JSON.parse(fs.readFileSync(args[1][2]!, "utf8"));
          if (intent.args[0] === "restore") {
            interrupted = true;
            return { code: 1, stdout: "", stderr: "cleanup interrupted" };
          }
        }
        return execute(...args);
      };
      if (!unread) {
        await settlePendingStageGit(f.h.ports);
        expect(interrupted).toBe(true);
        expect(current().state).toBe("running");
        expect(current().runs[0]!.attempts[0]!.publicationRepair?.outcome).toMatchObject({ status: "rejected" });
        if (checkpoint) expect(current().runs[0]!.attempts[0]!.publicationRepair?.rollback?.phase).toBe("restore");
        else expect(current().runs[0]!.attempts[0]!.publicationRepair?.rollback).toBeUndefined();
      }
      f.h.ports.exec = execute;
      f.h.ports.publicationRepairProducerState = async () => "gone";
      f.h.ports.publicationRepairProducerGone = async () => true;
      f.h.ports.conversationTurnInterrupted = async () => "dead";
      if (restart) {
        const child = await realExec(process.execPath, ["-e", `
          const { defaultPipelinePorts, settlePendingStageGit } = await import("./src/lib/pipelines/engine");
          const ports = { ...defaultPipelinePorts(), now: () => ${JSON.stringify(clock)}, scheduleTick: () => {},
          stageRepairDelivery: async () => ({ operationId: "repair-delivery", state: "delivered", safeToReplace: false }),
            durableTurnEvidence: async () => (${JSON.stringify(terminal)}),
            conversationAgentActive: async () => false, publicationRepairProducerState: async () => "gone",
            publicationRepairProducerGone: async () => true, conversationTurnInterrupted: async () => "dead",
            conversationDeliveryOutstanding: () => false, resumeSeveredTurn: async () => true };
          await settlePendingStageGit(ports);
        `], process.cwd(), { ...process.env }, { timeoutMs: 30000 });
        expect(child.code, child.stderr).toBe(0);
      } else await settlePendingStageGit(f.h.ports);
      expect(current().runs[0]!.attempts[0]!.publicationRepair?.committedSha).toBeUndefined();
      expect(current().lastPassedCommit).toBe(accepted);
      expect(current().runs[0]!.attempts[0]!.publicationRepair).toMatchObject({
        outcome: { status: "rejected", reason: expect.stringContaining("cannot safely complete repair") },
        rollback: { phase: "done" },
      });
      expect(current().runs[0]!.attempts[0]!.publicationRepair?.republishQueued).not.toBe(true);
      expect(current().stateDetail).toContain("cannot safely complete repair");
      expect(await f.git(f.lane(), "rev-list", "--count", "--all")).toBe("2");
      expect(await f.git(f.lane(), "rev-parse", "HEAD")).toBe(accepted);
      expect(await f.git(f.lane(), "status", "--porcelain")).toBe("");
      expect(fs.readFileSync(path.join(f.lane(), "file.txt"), "utf8")).toBe("accepted implementation\n");
      expect(current().state).toBe("needs_decision");
    } finally { f.close(); }
  });
}

test.each(["executor", "git"] as const)("a cleanup %s child retains publication custody when its controller exits", async seam => {
  const f = await fixture();
  let childPid: number | undefined;
  let publication: number | null = null, settlement: number | null = null;
  try {
    let clock = f.h.ports.now(); f.h.ports.now = () => clock;
    f.h.ports.resumeSeveredTurn = async () => true;
    f.h.ports.stageRepairDelivery = async () => ({ operationId: "repair-delivery", state: "delivered", safeToReplace: false });
    const accepted = await f.commit("accepted implementation");
    f.refuse(); await f.finish();
    fs.writeFileSync(path.join(f.lane(), "file.txt"), "declined staged repair\n");
    await f.agentGit(f.lane(), "add", "file.txt");
    clock = new Date(Date.parse(clock) + 1000).toISOString();
    const evidence = { turn: "terminal", message: {
      text: '```json\n{"status":"fail","blocked":true,"blockedReason":"cannot safely complete repair"}\n```',
      ts: Date.parse(clock) }, lastRecordAt: Date.parse(clock) };
    const receipt = path.join(f.root, "owned-child.json");
    const delegatePath = process.env.PATH!;
    const delegateGit = Bun.which("git", { PATH: delegatePath })!;
    const shim = path.join(f.root, "git-shim");
    fs.mkdirSync(shim);
    fs.writeFileSync(path.join(shim, "git"), `#!${process.execPath}
      const fs = require("node:fs"), { spawn, spawnSync } = require("node:child_process");
      const fds = [];
      for (const fd of [3, 4]) { try { fs.fstatSync(fd); fds.push(fd); } catch {} }
      if (process.argv[2] !== "restore") {
        // Launcher wrappers can look Git up again. Exclude this interception
        // from their lookup while preserving the real command's descriptors.
        const git = spawnSync(${JSON.stringify(delegateGit)}, process.argv.slice(2), {
          stdio: ["ignore", "inherit", "inherit", ...fds],
          env: { ...process.env, PATH: ${JSON.stringify(delegatePath)} } });
        process.exit(git.status ?? 1);
      }
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        detached: true, stdio: ["ignore", "ignore", "ignore", ...fds], env: process.env });
      child.once("spawn", () => {
        fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ pid: child.pid, fds }));
        child.unref();
      });
    `, { mode: 0o700 });
    const controller = await realExec(process.execPath, ["-e", `
      import fs from "node:fs";
      import { spawn } from "node:child_process";
      const { defaultPipelinePorts, settlePendingStageGit } = await import("./src/lib/pipelines/engine");
      const { realExec } = await import("./src/lib/workflows/provision");
      const ports = { ...defaultPipelinePorts(), now: () => ${JSON.stringify(clock)}, scheduleTick: () => {},
          stageRepairDelivery: async () => ({ operationId: "repair-delivery", state: "delivered", safeToReplace: false }),
        durableTurnEvidence: async () => (${JSON.stringify(evidence)}),
        conversationAgentActive: async () => false, publicationRepairProducerState: async () => "idle",
        publicationRepairProducerGone: async () => false, conversationTurnInterrupted: async () => "idle",
        conversationDeliveryOutstanding: () => false, resumeSeveredTurn: async () => true };
      ports.exec = async (...args) => {
        if (args[0] === process.execPath && args[1][0] === "-e" && args[1][1].includes("repair-write-fenced")) {
          if (${JSON.stringify(seam)} === "git") {
            const result = await realExec(args[0], args[1], args[2], {
              ...args[3], PATH: ${JSON.stringify(shim)} + ":" + process.env.PATH,
            }, args[4]);
            if (result.code !== 0) throw new Error(JSON.stringify(result));
            process.exit(0);
          }
          // Use exactly the production executor's inherited descriptor list.
          const options = args[4];
          const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
            cwd: args[2], env: process.env, detached: true,
            stdio: ["ignore", "ignore", "ignore", ...(options.inheritFd === undefined ? [] : [options.inheritFd]),
              ...(options.additionalInheritedFds ?? [])] });
          await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
          fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ pid: child.pid,
            inheritFd: options.inheritFd, additionalInheritedFds: options.additionalInheritedFds ?? [] }));
          child.unref(); process.exit(0);
        }
        return realExec(...args);
      };
      await settlePendingStageGit(ports);
      throw new Error("cleanup write was not reached");
    `], process.cwd(), { ...process.env }, { timeoutMs: 30000 });
    expect(controller.code, controller.stderr).toBe(0);
    const child = JSON.parse(fs.readFileSync(receipt, "utf8")); childPid = child.pid;
    expect(process.kill(childPid!, 0)).toBe(true);
    const directory = pipelineArtifactsDir(current().id);
    publication = await acquirePublicationFileLock(path.join(directory, "publication.lock"));
    settlement = await acquirePublicationFileLock(path.join(directory, "remote-action.lock"));
    expect(settlement).toBeNull();
    expect(publication).toBeNull();
    if (seam === "executor") expect(child.additionalInheritedFds).toHaveLength(1);
    else expect(child.fds).toEqual([3, 4]);
    expect(current().runs[0]!.attempts[0]!.publicationRepair).toMatchObject({
      outcome: { status: "rejected", reason: expect.stringContaining("cannot safely complete repair") },
      rollback: { phase: "restore" },
    });
    const recover = () => realExec(process.execPath, ["-e", `
      const { defaultPipelinePorts, settlePendingStageGit } = await import("./src/lib/pipelines/engine");
      await settlePendingStageGit({ ...defaultPipelinePorts(), now: () => ${JSON.stringify(clock)}, scheduleTick: () => {},
          stageRepairDelivery: async () => ({ operationId: "repair-delivery", state: "delivered", safeToReplace: false }),
        conversationAgentActive: async () => false, publicationRepairProducerState: async () => "gone",
        publicationRepairProducerGone: async () => true, conversationTurnInterrupted: async () => "dead",
        conversationDeliveryOutstanding: () => false, resumeSeveredTurn: async () => true });
    `], process.cwd(), { ...process.env }, { timeoutMs: 30000 });
    const before = structuredClone(current().runs[0]!.attempts[0]!.publicationRepair);
    expect((await recover()).code).toBe(0);
    expect(current().runs[0]!.attempts[0]!.publicationRepair).toEqual(before);
    expect(fs.readFileSync(path.join(f.lane(), "file.txt"), "utf8")).toBe("declined staged repair\n");
    process.kill(childPid!, "SIGKILL");
    childPid = undefined;
    // The kernel releases the orphan's descriptors when it exits.
    for (let n = 0; n < 200 && publication === null; n++) {
      publication = await acquirePublicationFileLock(path.join(directory, "publication.lock"));
      if (publication === null) await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(publication).not.toBeNull();
    releasePublicationFileLock(publication!); publication = null;
    expect((await recover()).code).toBe(0);
    expect(current().runs[0]!.attempts[0]!.publicationRepair).toMatchObject({
      outcome: before!.outcome, rollback: { phase: "done" },
    });
    expect(current().lastPassedCommit).toBe(accepted);
    expect(await f.git(f.lane(), "rev-parse", "HEAD")).toBe(accepted);
    expect(await f.git(f.lane(), "status", "--porcelain")).toBe("");
  } finally {
    if (publication !== null) releasePublicationFileLock(publication);
    if (settlement !== null) releasePublicationFileLock(settlement);
    if (childPid) { try { process.kill(childPid, "SIGKILL"); } catch {} }
    f.close();
  }
});


test.each(["missing", "foreign"] as const)("cleanup refuses a %s publication descriptor", async shape => {
  const f = await fixture();
  let foreign: number | null = null;
  try {
    let clock = f.h.ports.now(); f.h.ports.now = () => clock;
    f.h.ports.resumeSeveredTurn = async () => true;
    f.h.ports.stageRepairDelivery = async () => ({ operationId: "repair-delivery", state: "delivered", safeToReplace: false });
    f.h.ports.publicationRepairProducerState = async () => "idle";
    const accepted = await f.commit("accepted implementation");
    f.refuse(); await f.finish();
    const original = current().runs[0]!.attempts[0]!;
    fs.writeFileSync(path.join(f.lane(), "file.txt"), "declined staged repair\n");
    await f.agentGit(f.lane(), "add", "file.txt");
    const tree = await f.git(f.lane(), "write-tree");
    clock = new Date(Date.parse(clock) + 1000).toISOString();
    f.h.durableTurns.set(original.agentPath!, { turn: "terminal", message: {
      text: '```json\n{"status":"fail","blocked":true,"blockedReason":"cannot safely complete repair"}\n```',
      ts: Date.parse(clock) }, lastRecordAt: Date.parse(clock) });
    if (shape === "foreign") {
      foreign = await acquirePublicationFileLock(path.join(f.root, "foreign.lock"));
      expect(foreign).not.toBeNull();
    }
    const execute = f.h.ports.exec;
    let refused: number | null | undefined;
    f.h.ports.exec = async (...args) => {
      if (args[0] === process.execPath) {
        const result = await execute(args[0], args[1], args[2], args[3], {
          ...args[4], additionalInheritedFds: foreign === null ? [] : [foreign],
        });
        refused = result.code;
        return result;
      }
      return execute(...args);
    };
    await settlePendingStageGit(f.h.ports);
    expect(refused).toBe(78);
    expect(current().runs[0]!.attempts[0]!.publicationRepair).toMatchObject({
      outcome: { status: "rejected", reason: expect.stringContaining("cannot safely complete repair") },
      rollback: { phase: "restore" },
    });
    expect(await f.git(f.lane(), "rev-parse", "HEAD")).toBe(accepted);
    expect(await f.git(f.lane(), "write-tree")).toBe(tree);
    expect(fs.readFileSync(path.join(f.lane(), "file.txt"), "utf8")).toBe("declined staged repair\n");
    expect(current().runs[0]!.attempts[0]!.publicationRepair?.committedSha).toBeUndefined();
  } finally {
    if (foreign !== null) releasePublicationFileLock(foreign);
    f.close();
  }
});

test("parked refusal keeps its reason when host loss is reconciled", async () => {
  const f = await fixture();
  try {
    let clock = f.h.ports.now(); f.h.ports.now = () => clock;
    f.h.ports.resumeSeveredTurn = async () => true;
    f.h.ports.stageRepairDelivery = async () => ({ operationId: "repair-delivery", state: "delivered", safeToReplace: false });
    f.h.ports.publicationRepairProducerState = async () => "idle";
    f.h.ports.publicationRepairProducerGone = async () => false;
    const accepted = await f.commit("accepted implementation");
    f.refuse(); await f.finish();
    const original = current().runs[0]!.attempts[0]!;
    fs.writeFileSync(path.join(f.lane(), "file.txt"), "declined staged repair\n");
    await f.agentGit(f.lane(), "add", "file.txt");
    clock = new Date(Date.parse(clock) + 1000).toISOString();
    f.h.durableTurns.set(original.agentPath!, { turn: "terminal", message: {
      text: '```json\n{"status":"fail","blocked":true,"blockedReason":"cannot safely complete repair"}\n```',
      ts: Date.parse(clock) }, lastRecordAt: Date.parse(clock) });
    const execute = f.h.ports.exec;
    f.h.ports.exec = async (...args) => args[0] === process.execPath
      ? { code: 1, stdout: "", stderr: "cleanup interrupted" } : execute(...args);
    await settlePendingStageGit(f.h.ports);
    const outcome = structuredClone(current().runs[0]!.attempts[0]!.publicationRepair?.outcome);
    expect(outcome).toMatchObject({ status: "rejected", reason: expect.stringContaining("cannot safely complete repair") });
    // A later foreign edit refuses destructive recovery and parks with the cause.
    fs.writeFileSync(path.join(f.lane(), "file.txt"), "foreign edit\n");
    f.h.ports.exec = execute;
    await settlePendingStageGit(f.h.ports);
    expect(current().state).toBe("needs_decision");
    f.h.ports.publicationRepairProducerState = async () => "gone";
    f.h.ports.publicationRepairProducerGone = async () => true;
    f.h.ports.conversationTurnInterrupted = async () => "dead";
    await tickPipelines([], f.h.ports);
    expect(current().runs[0]!.attempts[0]!.publicationRepair?.outcome).toEqual(outcome);
    expect(current().runs[0]!.attempts).toHaveLength(1);
    expect(current().lastPassedCommit).toBe(accepted);
    expect(fs.readFileSync(path.join(f.lane(), "file.txt"), "utf8")).toBe("foreign edit\n");
  } finally { f.close(); }
});
