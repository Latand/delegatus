import { expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { testEndpoint } from "./fixtures/testEndpoint";
import { RuntimeHostFence } from "./runtimeHostFence";

const fixture = path.join(import.meta.dir, "fixtures", "runtimeHostFenceContender.ts");
const legacyFixture = path.join(import.meta.dir, "fixtures", "runtimeHostFenceLegacyNullIdentity.ts");
const hostModule = path.join(import.meta.dir, "runtimeHostFence.ts");
const procModule = path.join(import.meta.dir, "..", "lib", "proc", "index.ts");

async function waitForFiles(filenames: string[]): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!filenames.every((filename) => fs.existsSync(filename))) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for runtime host fence contenders");
    await Bun.sleep(10);
  }
}

async function readListener(socketPath: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let response = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write("probe"));
    socket.on("data", (chunk) => { response += chunk; });
    socket.once("end", () => resolve(response));
    socket.once("error", reject);
  });
}

/* "Exactly one host is serving" is asked by connecting, not by looking for a
   file: a Windows endpoint is a named pipe, which has no directory entry to
   stat. Connecting is the stronger question anyway — a leftover socket inode
   that nothing listens on would pass an existence check.

   The outcome barrier is published after listen completes. Each live fixture
   waits for our connected probe before ending its response, so one connection
   settles whether it serves; an absent endpoint refuses that connection. */
async function answeringListeners(endpoints: string[]): Promise<string[]> {
  const answers: string[] = [];
  for (const endpoint of endpoints) {
    try {
      answers.push(await readListener(endpoint));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ECONNREFUSED") throw error;
    }
  }
  return answers;
}

test("stale fence reclamation activates exactly one process after both observe the stale owner", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-fence-race-"));
  const fenceFilename = path.join(sandbox, "runtime-host.lock");
  fs.writeFileSync(fenceFilename, JSON.stringify({ pid: 42, startIdentity: "stale" }), { mode: 0o600 });
  const contenders = ["A", "B"].map((contender) => Bun.spawn(
    [process.execPath, fixture, hostModule, fenceFilename, sandbox, contender],
    { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" },
  ));
  const outcomeFilenames = ["A", "B"].map((contender) => path.join(sandbox, `outcome-${contender}`));

  try {
    await waitForFiles(outcomeFilenames);
    const outcomes = outcomeFilenames.map((filename) => fs.readFileSync(filename, "utf8"));
    expect(outcomes.filter((outcome) => outcome === "active")).toHaveLength(1);
    const active = outcomes[0] === "active" ? "A" : "B";
    expect(await readListener(testEndpoint(sandbox, `listener-${active}`))).toBe(active);
  } finally {
    fs.writeFileSync(path.join(sandbox, "release"), "");
    await Promise.all(contenders.map((contender) => contender.exited));
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("predecessor release preserves a successor fence generation", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-fence-release-"));
  const fenceFilename = path.join(sandbox, "runtime-host.lock");
  const predecessor = new RuntimeHostFence(fenceFilename);
  predecessor.acquire();
  fs.rmSync(fenceFilename);
  const successor = JSON.stringify({ pid: 73, startIdentity: "successor", acquisitionId: "successor-generation" });
  fs.writeFileSync(fenceFilename, successor, { mode: 0o600 });

  try {
    predecessor.release();
    expect(fs.readFileSync(fenceFilename, "utf8")).toBe(successor);
  } finally {
    predecessor.release();
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("legacy live-owner metadata remains a rolling-upgrade fence", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-fence-legacy-"));
  const fenceFilename = path.join(sandbox, "runtime-host.lock");
  const metadata = JSON.stringify({ pid: 42, startIdentity: "live-predecessor" });
  fs.writeFileSync(fenceFilename, metadata, { mode: 0o600 });

  try {
    expect(() => new RuntimeHostFence(fenceFilename, () => true).acquire()).toThrow("singleton fence is held");
    expect(fs.readFileSync(fenceFilename, "utf8")).toBe(metadata);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

for (const pauseWrite of [false, true]) test(pauseWrite
  ? "a legacy refusal is invisible until its paused outcome write completes"
  : "a live legacy owner remains the only listener when its start identity is temporarily unreadable", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-fence-legacy-null-"));
  const fenceFilename = path.join(sandbox, "runtime-host.lock");
  const releaseFilename = path.join(sandbox, "release");
  const resumeWrite = path.join(sandbox, "resume-write");
  const owner = Bun.spawn(
    [process.execPath, legacyFixture, "owner", hostModule, procModule, fenceFilename, sandbox],
    { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" },
  );
  let contender: ReturnType<typeof Bun.spawn> | null = null;

  try {
    await waitForFiles([path.join(sandbox, "owner-ready")]);
    const ownerMetadata = fs.readFileSync(fenceFilename, "utf8");
    const args = ["contender", hostModule, procModule, fenceFilename, sandbox];
    // Hold the actual fixture between open and write. The parent can inspect
    // publication while the writer cannot make any further progress.
    const pausedProgram = `
      import fs from "node:fs";
      const { processIdentityStatus, systemBootEpoch } = await import(${JSON.stringify(path.join(import.meta.dir, "../lib/processIdentity.ts"))});
      const { procBackend } = await import(${JSON.stringify(procModule)});
      const parent = JSON.parse(process.env.LLV_FIXTURE_PARENT_IDENTITY);
      // The contender replaces the shared start-token probe with null. Keep
      // real kernel readers for the paused writer's parent-lifetime check.
      const probe = {
        pidAlive: procBackend.pidAlive.bind(procBackend),
        processIdentity: procBackend.processIdentity.bind(procBackend),
        processExited: procBackend.processExited.bind(procBackend),
        bootEpoch: systemBootEpoch,
      };
      const write = fs.writeFileSync;
      fs.writeFileSync = (filename, data, ...args) => {
        if (!String(filename).startsWith(${JSON.stringify(path.join(sandbox, "contender-outcome"))})) {
          return write(filename, data, ...args);
        }
        const fd = fs.openSync(filename, "w");
        try {
          write(${JSON.stringify(path.join(sandbox, "write-open"))}, "");
          const deadline = Date.now() + 10_000;
          while (!fs.existsSync(${JSON.stringify(resumeWrite)})) {
            if (processIdentityStatus(parent, probe) !== "alive" || probe.processExited(parent.pid)) process.exit(86);
            if (Date.now() >= deadline) throw new Error("outcome writer was not resumed");
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          }
          return write(fd, data, ...args);
        } finally {
          fs.closeSync(fd);
        }
      };
      process.argv = [process.execPath, ${JSON.stringify(legacyFixture)}, ...${JSON.stringify(args)}];
      await import(${JSON.stringify(legacyFixture)});
    `;
    const started = Bun.spawn(
      pauseWrite ? [process.execPath, "-e", pausedProgram] : [process.execPath, legacyFixture, ...args],
      { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" },
    );
    contender = started;
    const stderr = new Response(started.stderr).text();
    const waitForContenderFiles = async (filenames: string[]) => {
      try { await waitForFiles(filenames); }
      catch (error) {
        throw new Error(`${String(error)}; contender ${started.exitCode ?? "still running"}: ${started.exitCode === null ? "" : await stderr}`);
      }
    };
    const outcomeFilename = path.join(sandbox, "contender-outcome");
    if (pauseWrite) {
      await waitForContenderFiles([path.join(sandbox, "write-open")]);
      expect(fs.existsSync(outcomeFilename)).toBe(false);
      fs.writeFileSync(resumeWrite, "");
    }
    await waitForContenderFiles([outcomeFilename]);

    expect(fs.readFileSync(outcomeFilename, "utf8")).toStartWith("blocked:");
    expect(await answeringListeners([
      testEndpoint(sandbox, "listener-owner"),
      testEndpoint(sandbox, "listener-contender"),
    ])).toEqual(["owner"]);
    expect(fs.readFileSync(fenceFilename, "utf8")).toBe(ownerMetadata);
  } finally {
    fs.writeFileSync(resumeWrite, "");
    fs.writeFileSync(releaseFilename, "");
    await Promise.all([
      owner.exited,
      ...(contender ? [contender.exited] : []),
    ]);
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("malformed existing fence metadata fails closed", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-fence-malformed-"));
  const fenceFilename = path.join(sandbox, "runtime-host.lock");
  fs.writeFileSync(fenceFilename, "{broken", { mode: 0o600 });

  try {
    expect(() => new RuntimeHostFence(fenceFilename, () => false).acquire()).toThrow("singleton fence is held");
    expect(fs.readFileSync(fenceFilename, "utf8")).toBe("{broken");
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
