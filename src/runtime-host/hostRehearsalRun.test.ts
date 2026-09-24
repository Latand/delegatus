import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import {
  probeRuntimeSocket,
  runtimeHostRecoveryFailure,
  runtimeHostRehearsalEnvironment,
  runtimeHostRehearsalFiles,
  runtimeHostRehearsalGenerations,
} from "./hostRehearsalRun";

test("issue 1268: staged runtime-host generations keep NODE_ENV absent at the worker boundary", () => {
  const stateDir = path.join(os.tmpdir(), "llv-rehearsal-isolated-state");
  const environment = runtimeHostRehearsalEnvironment({
    runtimeBin: process.execPath,
    root: path.resolve(import.meta.dir, "../.."),
    stateDir,
    port: 19480,
  }, "successor");

  expect(environment.NODE_ENV).toBeUndefined();
  expect(Object.hasOwn(environment, "NODE_ENV")).toBe(false);
  expect(environment).toMatchObject({
    HOME: stateDir,
    LLV_STATE_DIR: stateDir,
    LLV_RUNTIME_HOST_SOCKET: path.join(stateDir, "runtime-host.sock"),
    LLV_RUNTIME_JOURNAL: path.join(stateDir, "runtime-events.sqlite"),
    LLV_VIEWER_PORT: "19480",
  });
});

/** A newline-framed stand-in for the runtime socket, driven per connection. */
async function serve(answer: (socket: net.Socket) => void): Promise<{ socketPath: string; close: () => Promise<void> }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "llv-rehearsal-probe-"));
  const socketPath = path.join(directory, "runtime-host.sock");
  const server = net.createServer((socket) => {
    socket.on("error", () => socket.destroy());
    socket.once("data", () => answer(socket));
  });
  server.listen(socketPath);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  return {
    socketPath,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
}

test("a caller that reads the answer needs a complete frame to count the poll", async () => {
  const answered = await serve((socket) => socket.end('{"id":"probe","ok":true,"result":{}}\n'));
  try {
    expect(await probeRuntimeSocket(answered.socketPath, { id: "probe", method: "snapshot" }, { abandon: false })).toBe(true);
  } finally {
    await answered.close();
  }

  const silent = await serve((socket) => socket.destroy());
  try {
    expect(await probeRuntimeSocket(silent.socketPath, { id: "probe", method: "snapshot" }, { abandon: false })).toBe(false);
  } finally {
    await silent.close();
  }
});

test("an abandoning caller counts the poll once its request is taken, however the host then ends the connection", async () => {
  /* The point of an abandoning caller is to leave the answer pending, so the
     endpoint is asked only to accept the request. Under Bun 1.3.3 a host drops
     the write it cannot finish and closes the connection itself; that is the
     runtime behaving as it always did, and reading it as a listener that
     stopped answering would fail the gate on the runtime it was written for. */
  const closes = await serve((socket) => socket.destroy());
  try {
    expect(await probeRuntimeSocket(closes.socketPath, { id: "probe", method: "snapshot" }, { abandon: true })).toBe(true);
  } finally {
    await closes.close();
  }
});

test("a socket nobody is listening on fails the poll either way", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "llv-rehearsal-probe-"));
  const socketPath = path.join(directory, "absent.sock");
  try {
    expect(await probeRuntimeSocket(socketPath, { id: "probe", method: "snapshot" }, { abandon: false })).toBe(false);
    expect(await probeRuntimeSocket(socketPath, { id: "probe", method: "snapshot" }, { abandon: true })).toBe(false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("rename slice 3: the failed generation is named the new way and the retained one runs from an agent-log-viewer image", () => {
  const stateDir = path.join(os.tmpdir(), "llv-rehearsal-isolated-state");
  const options = { runtimeBin: process.execPath, root: path.resolve(import.meta.dir, "../.."), stateDir, port: 19480 };
  const failed = runtimeHostRehearsalEnvironment(options, "predecessor");
  const retained = runtimeHostRehearsalEnvironment(options, "successor");
  const files = runtimeHostRehearsalFiles(stateDir);

  expect(failed.LLV_RUNTIME_HOST_IMAGE).toBe("delegatus:rehearsal-dddddddddddd");
  expect(failed.LLV_RUNTIME_HOST_CONTAINER).toMatch(/^delegatus-runtime-host-d{12}-[0-9a-f]{12}$/);
  expect(retained.LLV_RUNTIME_HOST_IMAGE).toBe("agent-log-viewer:rehearsal-aaaaaaaaaaaa");
  expect(retained.LLV_RUNTIME_HOST_CONTAINER).toMatch(/^llv-runtime-host-a{12}-[0-9a-f]{12}$/);
  /* Docker on the generations' PATH is the rehearsal's own stub, never a daemon. */
  expect(retained.PATH?.split(path.delimiter)[0]).toBe(files.tools);
  expect(retained).toMatchObject({
    LLV_RUNTIME_HOST_RELEASE_TARGET: files.release,
    LLV_RUNTIME_HOST_ROLLBACK_TARGET: files.rollbackTarget,
    LLV_RUNTIME_HOST_ROLLBACK_INTENT_TARGET: files.rollbackIntent,
    LLV_RUNTIME_HOST_HANDOFF_INTENT_TARGET: files.handoffIntent,
  });
});

describe("rename slice 3: the rehearsal's rollback check", () => {
  const { failed, retained } = runtimeHostRehearsalGenerations(19480);
  const identity = ({ image, revision, container }: typeof failed) => ({ image, revision, container });
  const done = {
    failed: identity(failed),
    retained: identity(retained),
    found: { version: 1 as const, active: failed, previous: retained, predecessorId: retained.container, recordedAt: failed.stagedAt },
    docker: [
      `container inspect ${failed.container}`,
      `container update --restart no ${failed.container}`,
      `container stop --time 40 ${failed.container}`,
      `container rm -f ${failed.container}`,
    ],
    release: identity(retained),
    rollbackIntentLeft: false,
    rollbackTargetLeft: false,
  };

  test("passes a rollback that found, stopped and removed the failed generation", () => {
    expect(runtimeHostRecoveryFailure(done)).toBeNull();
  });

  test("fails each thing the retained generation left undone", () => {
    expect(runtimeHostRecoveryFailure({ ...done, found: null })).toContain("never recorded");
    expect(runtimeHostRecoveryFailure({ ...done, docker: done.docker.slice(0, 3) }))
      .toStartWith(`no generation ran docker container rm … ${failed.container}`);
    expect(runtimeHostRecoveryFailure({ ...done, docker: [...done.docker, `container stop --time 40 ${retained.container}`] }))
      .toContain("turned on the generation it kept");
    expect(runtimeHostRecoveryFailure({ ...done, rollbackIntentLeft: true })).toContain("rollback intent");
    expect(runtimeHostRecoveryFailure({ ...done, rollbackTargetLeft: true })).toContain("rollback target");
    expect(runtimeHostRecoveryFailure({ ...done, release: identity(failed) })).toContain("durable release record");
  });
});
