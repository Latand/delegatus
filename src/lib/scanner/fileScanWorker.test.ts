import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performanceSites, performanceSpans } from "@/lib/performanceSpans";

import { scheduleTranscriptIndex, waitForTranscriptIndexIdleForTests } from "@/lib/search/transcriptFeed";
import { searchTranscripts } from "@/lib/search/transcriptSearch";

import { conversationCatalogSnapshot, replaceConversationCatalog } from "./conversationCatalog";
import { collectFileScanInWorker, fileScanWorkerEnabled, fileScanWorkerLaunch } from "./fileScanWorker";

const directories: string[] = [];

for (const invalid of [false, true]) {
  test(`scanner diagnostics: ${invalid ? "decode refusal" : "successful publication"}`, async () => {
    const catalog = [{ path: "/sessions/fixture.jsonl", project: "repo-fixture", engine: "codex", size: 100, mtime: 100 }];
    const frame = invalid ? "invalid json" : JSON.stringify({ type: "complete",
      snapshot: { files: [], projectCatalog: [], conversationCatalog: catalog, complete: true } });
    const { directory, workerPath } = fixtureWorker(`process.stdin.resume(); process.stdin.on("end", () => console.log(${JSON.stringify(frame)}));`);
    performanceSpans.clear();
    try {
      const result = collectFileScanInWorker({ persist: false }, undefined, {
        launch: { executable: process.execPath, workerPath }, cwd: directory,
        transcriptIndexScheduler: () => {},
      });
      if (invalid) await expect(result).rejects.toThrow("invalid JSON");
      else await result;
      const rows = performanceSpans.snapshot().records.map(row => ({ ...row, name: performanceSites[row.site] }));
      expect(rows.some(row => row.name === "scanner.ipc-frame" && row.kind === "sync")).toBe(true);
      expect(rows.find(row => row.name === "scanner.ipc-decode")).toMatchObject({
        kind: "sync", failed: invalid, bytes: Buffer.byteLength(frame),
      });
      expect(rows.some(row => row.name === "scanner.publication")).toBe(!invalid);
      expect(rows.some(row => row.name === "transcript.feed")).toBe(!invalid);
    } finally { performanceSpans.clear(); }
  });
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function fixtureWorker(source: string): { directory: string; workerPath: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-file-scan-worker-"));
  directories.push(directory);
  const workerPath = path.join(directory, "worker.mjs");
  fs.writeFileSync(workerPath, source);
  return { directory, workerPath };
}

test("worker monitoring lines reach the journal on successful completion", async () => {
  const lines = ["[blocking-wait] {}", "[viewer loop-gap] {}", "[performance summary] {}"];
  const { directory, workerPath } = fixtureWorker(`
    process.stdin.resume();
    process.stdin.on("end", () => {
      process.stderr.write("[blocking-");
      setImmediate(() => {
        process.stderr.write(${JSON.stringify(`wait] {}\n${lines.slice(1).join("\n")}\nordinary stderr\n`)});
        console.log(JSON.stringify({ type: "complete", snapshot: { files: [], projectCatalog: [], complete: true } }));
      });
    });
  `);
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect((await collectFileScanInWorker({ persist: false }, undefined, {
      launch: { executable: process.execPath, workerPath }, cwd: directory,
    })).complete).toBe(true);
    expect(log.mock.calls.map(call => call[0])).toEqual(lines);
  } finally { log.mockRestore(); }
});

test.each(["state database initialization is busy", "state admission is busy at state.schema"])(
"a scanner bootstrap busy refusal before reading stdin retries within its generation: %s", async (refusal) => {
  const { directory, workerPath } = fixtureWorker(`
    import fs from "node:fs";
    const ledger = new URL("attempts", import.meta.url);
    if (!fs.existsSync(ledger)) {
      fs.writeFileSync(ledger, "refused");
      console.error(${JSON.stringify(refusal)});
      process.exitCode = 1;
    } else {
      process.stdin.resume();
      process.stdin.on("end", () => console.log(JSON.stringify({ type: "complete", snapshot: { files: [], projectCatalog: [], complete: true } })));
    }
  `);
  const delays: number[] = [];
  // Fill the request pipe so the early bootstrap exit also exercises EPIPE.
  const snapshot = await collectFileScanInWorker({ persist: false, pin: "x".repeat(256 * 1024) }, undefined, {
    launch: { executable: process.execPath, workerPath }, cwd: directory,
    scheduler: {
      setTimeout: (callback, ms) => {
        if (ms === 250 || ms === 1_000) { delays.push(ms); queueMicrotask(callback); return null; }
        return setTimeout(callback, ms);
      },
      clearTimeout: (timer) => { if (timer !== null) clearTimeout(timer as ReturnType<typeof setTimeout>); },
    },
  });
  expect(snapshot.complete).toBe(true);
  expect(delays).toEqual([250]);
});

test("registry admission receives only the remaining generation budget after a bootstrap retry", async () => {
  const { directory, workerPath } = fixtureWorker(`
    import fs from "node:fs";
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => { input += chunk; });
    process.stdin.on("end", () => {
      const ledger = new URL("budgets", import.meta.url);
      const retry = fs.existsSync(ledger);
      fs.appendFileSync(ledger, JSON.stringify(JSON.parse(input).lockWaitMs) + "\\n");
      if (!retry) {
        console.error("state database initialization is busy");
        process.exitCode = 1;
      } else console.log(JSON.stringify({ type: "complete", snapshot: { files: [], projectCatalog: [], complete: true } }));
    });
  `);
  let now = 1_000;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  const timers: { callback: () => void; ms: number; active: boolean }[] = [];
  try {
    const snapshot = await collectFileScanInWorker({ persist: false }, undefined, {
      launch: { executable: process.execPath, workerPath }, cwd: directory, timeoutMs: 10_000,
      scheduler: {
        setTimeout: (callback, ms) => {
          const timer = { callback, ms, active: true };
          timers.push(timer);
          if (ms === 250) queueMicrotask(() => { now += ms; timer.active = false; callback(); });
          return timer;
        },
        clearTimeout: timer => { (timer as typeof timers[number]).active = false; },
      },
    });
    expect(snapshot.complete).toBe(true);
    expect(fs.readFileSync(path.join(directory, "budgets"), "utf8").trim().split("\n").map(Number)).toEqual([10_000, 9_750]);
    expect(timers.map(timer => timer.ms)).toEqual([10_000, 250]);
    expect(timers.some(timer => timer.active)).toBe(false);
  } finally { clock.mockRestore(); }
});

test("bootstrap retry exhaustion is capped at three launches in each real process", async () => {
  const { directory, workerPath } = fixtureWorker(`
    import fs from "node:fs";
    fs.appendFileSync(new URL("attempts", import.meta.url), "attempt\\n");
    console.error("state admission is busy at state.schema");
    process.exitCode = 1;
  `);
  const parentPath = path.join(directory, "parent.ts");
  fs.writeFileSync(parentPath, `
    import { collectFileScanInWorker } from ${JSON.stringify(path.join(import.meta.dir, "fileScanWorker.ts"))};
    const delays = [];
    try {
      await collectFileScanInWorker({ persist: false }, undefined, {
        launch: { executable: process.execPath, workerPath: ${JSON.stringify(workerPath)} }, cwd: ${JSON.stringify(directory)},
        scheduler: {
          setTimeout(callback, ms) {
            if (ms === 250 || ms === 1000) { delays.push(ms); queueMicrotask(callback); return null; }
            return setTimeout(callback, ms);
          },
          clearTimeout(timer) { if (timer !== null) clearTimeout(timer); },
        },
      });
      throw new Error("expected bootstrap refusal");
    } catch (error) {
      if (!error.message.includes("file scanner worker exited before completion")) throw error;
      console.log(JSON.stringify(delays));
    }
  `);
  for (const launches of [3, 6]) {
    const parent = Bun.spawn([process.execPath, parentPath], {
      cwd: path.resolve(import.meta.dir, "../../.."), stdout: "pipe", stderr: "pipe",
    });
    const watchdog = setTimeout(() => parent.kill("SIGKILL"), 10_000);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(parent.stdout).text(), new Response(parent.stderr).text(), parent.exited,
      ]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(JSON.parse(stdout)).toEqual([250, 1_000]);
      expect(fs.readFileSync(path.join(directory, "attempts"), "utf8").trim().split("\n")).toHaveLength(launches);
    } finally {
      clearTimeout(watchdog);
      if (parent.exitCode === null) parent.kill("SIGKILL");
      await parent.exited;
    }
  }
}, 30_000);

test.each(["cancel", "deadline"])("%s during bootstrap backoff prevents another worker launch and releases timers", async (stop) => {
  const { directory, workerPath } = fixtureWorker(`
    import fs from "node:fs";
    fs.appendFileSync(new URL("attempts", import.meta.url), "attempt\\n");
    console.error("state admission is busy at state.schema");
    process.exitCode = 1;
  `);
  const backoff = Promise.withResolvers<void>();
  const timers: { callback: () => void; ms: number; active: boolean }[] = [];
  const controller = new AbortController();
  const scan = collectFileScanInWorker({ persist: false }, undefined, {
    launch: { executable: process.execPath, workerPath }, cwd: directory, signal: controller.signal,
    scheduler: {
      setTimeout: (callback, ms) => {
        const timer = { callback, ms, active: true };
        timers.push(timer);
        if (ms === 250) backoff.resolve();
        return timer;
      },
      clearTimeout: (timer) => { (timer as typeof timers[number]).active = false; },
    },
  });
  const outcome = scan.catch(error => error);
  await backoff.promise;
  if (stop === "cancel") controller.abort();
  else {
    const deadline = timers.find(timer => timer.ms === 300_000)!;
    deadline.active = false;
    deadline.callback();
  }
  expect(await outcome).toMatchObject(stop === "cancel"
    ? { name: "AbortError" } : { name: "DeadlineExceededError", message: "file scanner worker timed out" });
  expect(timers.filter(timer => timer.active)).toEqual([]);
  expect(fs.readFileSync(path.join(directory, "attempts"), "utf8")).toBe("attempt\n");
});

test.each([undefined, "resource", "complete"])("a non-bootstrap worker failure is never retried (frame: %s)", async (frame) => {
  const { directory, workerPath } = fixtureWorker(`
    import fs from "node:fs";
    fs.appendFileSync(new URL("attempts", import.meta.url), "attempt\\n");
    process.stdin.resume();
    process.stdin.on("end", () => {
      ${frame ? `console.log(JSON.stringify({ type: ${JSON.stringify(frame)}, snapshot: { files: [], projectCatalog: [], complete: true } }));` : ""}
      console.error(${JSON.stringify(frame ? "state admission is busy at state.schema" : "fixture unexpected failure")});
      process.exitCode = 1;
    });
  `);
  await expect(collectFileScanInWorker({ persist: false }, undefined, {
    launch: { executable: process.execPath, workerPath }, cwd: directory,
  })).rejects.toThrow("file scanner worker exited before completion");
  expect(fs.readFileSync(path.join(directory, "attempts"), "utf8")).toBe("attempt\n");
});

test("production file scans use the worker boundary and test scans stay direct", () => {
  expect(fileScanWorkerEnabled({ NODE_ENV: "production" })).toBe(true);
  expect(fileScanWorkerEnabled({ NODE_ENV: "test" })).toBe(false);
  expect(fileScanWorkerEnabled({ NODE_ENV: "production", LLV_FILE_SCANNER_WORKER: "1" })).toBe(false);
  expect(fileScanWorkerEnabled({ NODE_ENV: "production", LLV_FILE_SCANNER_WORKER_DISABLED: "1" })).toBe(false);
});

test("worker scan streams the resource scope, keeps the caller event loop live, and returns completion", async () => {
  const { directory, workerPath } = fixtureWorker(`
    process.stdin.resume();
    process.stdin.on("end", () => {
      const resource = { files: [], projectCatalog: [], complete: true };
      setTimeout(() => {
        process.stdout.write(JSON.stringify({ type: "resource", snapshot: resource }) + "\\n");
        setTimeout(() => {
          process.stdout.write(JSON.stringify({
            type: "complete",
            snapshot: { files: [], projectCatalog: [{ id: "project-one", name: "one", path: "/one" }], complete: true },
          }) + "\\n");
        }, 20);
      }, 20);
    });
  `);
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 1);
  const resources: unknown[] = [];
  try {
    const snapshot = await collectFileScanInWorker(
      { persist: false, persistIndex: false },
      (resource) => resources.push(resource),
      {
        launch: { executable: process.execPath, workerPath },
        cwd: directory,
        timeoutMs: 2_000,
      },
    );
    expect(resources).toEqual([{ files: [], projectCatalog: [], complete: true }]);
    expect(snapshot.projectCatalog).toHaveLength(1);
    expect(ticks).toBeGreaterThan(2);
  } finally {
    clearInterval(timer);
  }
});

test("a current incomplete worker scan schedules a non-deleting transcript feed", async () => {
  const transcript = {
    path: "/sessions/indexed.jsonl",
    root: "codex-sessions",
    name: "indexed.jsonl",
    project: "repo-indexed",
    title: "indexed",
    firstPrompt: "",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    mtime: 1_780_000_000,
    size: 100,
  };
  const completion = JSON.stringify({
    type: "complete",
    snapshot: { files: [], projectCatalog: [], conversationCatalog: [transcript], complete: false },
  });
  const { directory, workerPath } = fixtureWorker(`
    process.stdin.resume();
    process.stdin.on("end", () => process.stdout.write(${JSON.stringify(`${completion}\n`)}));
  `);
  const feeds: unknown[] = [];

  await collectFileScanInWorker(
    { persist: false, persistIndex: false },
    undefined,
    {
      launch: { executable: process.execPath, workerPath },
      cwd: directory,
      timeoutMs: 2_000,
      transcriptIndexScheduler: (feed) => { feeds.push(feed); },
    },
  );

  expect(feeds).toEqual([{
    complete: false,
    /* When the worker began listing: nothing created after it is in the feed. */
    listedAt: expect.any(Number),
    sources: [{
      path: transcript.path,
      project: transcript.project,
      engine: transcript.engine,
      size: transcript.size,
      mtimeMs: transcript.mtime * 1_000,
    }],
  }]);
});

test("the production worker publishes Copilot catalog entries through the shared transcript feed", async () => {
  const transcript = {
    path: "/sessions/copilot/events.jsonl",
    root: "copilot-sessions" as const,
    name: "events.jsonl",
    project: "repo-copilot",
    title: "Copilot session",
    firstPrompt: "",
    engine: "copilot" as const,
    kind: "session",
    fmt: "copilot" as const,
    mtime: 1_780_000_000,
    size: 321,
  };
  const completion = JSON.stringify({
    type: "complete",
    snapshot: { files: [], projectCatalog: [], conversationCatalog: [transcript], complete: true },
  });
  const { directory, workerPath } = fixtureWorker(`
    process.stdin.resume();
    process.stdin.on("end", () => process.stdout.write(${JSON.stringify(`${completion}\n`)}));
  `);
  const feeds: unknown[] = [];

  await collectFileScanInWorker(
    { persist: false, persistIndex: false },
    undefined,
    {
      launch: { executable: process.execPath, workerPath },
      cwd: directory,
      timeoutMs: 2_000,
      transcriptIndexScheduler: (feed) => { feeds.push(feed); },
    },
  );

  expect(feeds).toEqual([{
    complete: true,
    /* When the worker began listing: nothing created after it is in the feed. */
    listedAt: expect.any(Number),
    sources: [{
      path: transcript.path,
      project: transcript.project,
      engine: "copilot",
      size: transcript.size,
      mtimeMs: transcript.mtime * 1_000,
    }],
  }]);
});

test("an obsolete worker scan finishing last cannot delete newer transcript index results", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-file-scan-worker-overlap-"));
  directories.push(directory);
  const previousEnvironment = {
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    LLV_STATE_DIR: process.env.LLV_STATE_DIR,
    TMPDIR: process.env.TMPDIR,
  };
  process.env.HOME = path.join(directory, "home");
  process.env.XDG_CONFIG_HOME = path.join(directory, "config");
  process.env.LLV_STATE_DIR = path.join(directory, "state");
  process.env.TMPDIR = path.join(directory, "tmp");
  fs.mkdirSync(process.env.TMPDIR, { recursive: true });

  const transcript = (name: string, body: string) => {
    const pathname = path.join(directory, `${name}.jsonl`);
    fs.writeFileSync(pathname, `${JSON.stringify({
      type: "user",
      timestamp: "2026-08-20T09:00:00.000Z",
      message: { content: body },
    })}\n`);
    const stat = fs.statSync(pathname);
    return {
      path: pathname,
      root: "claude-projects",
      name: path.basename(pathname),
      project: "repo-overlap",
      title: name,
      firstPrompt: "",
      engine: "claude",
      kind: "session",
      fmt: "claude",
      mtime: stat.mtimeMs / 1_000,
      size: stat.size,
    };
  };
  const older = transcript("older", "obsoleteinventorymarker");
  const newer = transcript("newer", "newerinventorymarker");
  const completion = (entry: ReturnType<typeof transcript>) => `${JSON.stringify({
    type: "complete",
    snapshot: { files: [], projectCatalog: [], conversationCatalog: [entry], complete: true },
  })}\n`;
  const worker = (entry: ReturnType<typeof transcript>, delayMs: number) => fixtureWorker(`
    process.stdin.resume();
    process.stdin.on("end", () => setTimeout(() => {
      process.stdout.write(${JSON.stringify(completion(entry))});
    }, ${delayMs}));
  `);
  const olderWorker = worker(older, 250);
  const newerWorker = worker(newer, 0);
  const scheduledPaths: string[][] = [];
  const schedule = (feed: Parameters<typeof scheduleTranscriptIndex>[0]) => {
    scheduledPaths.push(feed.sources.map((entry) => entry.path));
    scheduleTranscriptIndex(feed, { force: true });
  };

  try {
    await waitForTranscriptIndexIdleForTests();
    const olderScan = collectFileScanInWorker(
      { persist: false, persistIndex: false },
      undefined,
      {
        launch: { executable: process.execPath, workerPath: olderWorker.workerPath },
        cwd: olderWorker.directory,
        timeoutMs: 2_000,
        transcriptIndexScheduler: schedule,
      },
    );
    const newerScan = collectFileScanInWorker(
      { persist: false, persistIndex: false },
      undefined,
      {
        launch: { executable: process.execPath, workerPath: newerWorker.workerPath },
        cwd: newerWorker.directory,
        timeoutMs: 2_000,
        transcriptIndexScheduler: schedule,
      },
    );

    await newerScan;
    await waitForTranscriptIndexIdleForTests();
    expect(searchTranscripts({ query: "newerinventorymarker" }).items).toHaveLength(1);

    await olderScan;
    await waitForTranscriptIndexIdleForTests();
    expect(scheduledPaths).toEqual([[newer.path]]);
    expect(searchTranscripts({ query: "newerinventorymarker" }).items).toHaveLength(1);
  } finally {
    await waitForTranscriptIndexIdleForTests();
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("worker scans publish a Claude transcript that appears in a previously sessionless project directory", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-file-scan-worker-late-session-"));
  directories.push(directory);
  const home = path.join(directory, "home");
  const stateDir = path.join(directory, "state");
  const temporaryDir = path.join(directory, "tmp");
  const repository = path.join(directory, "late-session-repository");
  const encodedCwd = repository.replaceAll(path.sep, "-");
  const projectDirectory = path.join(home, ".claude", "projects", encodedCwd);
  fs.mkdirSync(path.join(repository, ".git"), { recursive: true });
  fs.writeFileSync(path.join(repository, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(repository, ".git", "config"), [
    '[remote "origin"]',
    "\turl = https://example.invalid/team/late-session-repository.git",
    "",
  ].join("\n"));
  fs.mkdirSync(projectDirectory, { recursive: true });
  fs.mkdirSync(temporaryDir, { recursive: true });
  fs.mkdirSync(path.join(temporaryDir, `claude-${process.getuid?.() ?? 1000}`));
  fs.writeFileSync(path.join(projectDirectory, "historical.jsonl.bak"), "{}\n");
  replaceConversationCatalog([]);
  const runtime = {
    cwd: path.resolve(import.meta.dir, "../../.."),
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: path.join(directory, "config"),
      LLV_STATE_DIR: stateDir,
      TMPDIR: temporaryDir,
      LLV_CLAUDE_HOME: path.join(home, ".claude"),
      NODE_ENV: "production" as const,
      LLV_AGENT_REGISTRY_SQLITE: "off",
    },
    timeoutMs: 10_000,
  };

  const before = await collectFileScanInWorker({ persist: false, persistIndex: true }, undefined, runtime);
  expect(before.files).toEqual([]);

  const transcript = path.join(projectDirectory, "late-session.jsonl");
  fs.writeFileSync(
    transcript,
    `${JSON.stringify({ type: "user", cwd: repository, message: { content: "late session" } })}\n`,
  );
  const after = await collectFileScanInWorker({ persist: false, persistIndex: true }, undefined, runtime);

  expect(after.complete).toBe(true);
  expect(after.files.some((entry) => entry.path === transcript)).toBe(true);
  expect(conversationCatalogSnapshot()).toContainEqual(expect.objectContaining({
    path: transcript,
    project: expect.stringMatching(/^repo-[0-9a-f]{32}$/),
  }));
});

test("a completion frame followed by worker failure preserves the published conversation catalog", async () => {
  const retained = {
    path: "/sessions/retained.jsonl",
    root: "codex-sessions" as const,
    name: "retained.jsonl",
    project: "repo-retained",
    title: "retained",
    firstPrompt: "",
    engine: "codex" as const,
    kind: "session",
    fmt: "codex" as const,
    mtime: 1_780_000_000,
    size: 100,
  };
  const replacement = { ...retained, path: "/sessions/replacement.jsonl", name: "replacement.jsonl", title: "replacement" };
  const completion = JSON.stringify({
    type: "complete",
    snapshot: { files: [], projectCatalog: [], conversationCatalog: [replacement], complete: true },
  });
  const { directory, workerPath } = fixtureWorker(`
    process.stdin.resume();
    process.stdin.on("end", () => {
      process.stdout.write(${JSON.stringify(`${completion}\n`)}, () => {
        process.exitCode = 1;
      });
    });
  `);
  replaceConversationCatalog([retained]);
  let transcriptIndexFeeds = 0;

  await expect(collectFileScanInWorker(
    { persist: false, persistIndex: false },
    undefined,
    {
      launch: { executable: process.execPath, workerPath },
      cwd: directory,
      timeoutMs: 2_000,
      transcriptIndexScheduler: () => { transcriptIndexFeeds += 1; },
    },
  )).rejects.toThrow("file scanner worker exited before completion");

  expect(conversationCatalogSnapshot()).toEqual([retained]);
  expect(transcriptIndexFeeds).toBe(0);
});

test("aborting a worker scan kills the child and releases its timer and listener", async () => {
  const { directory, workerPath } = fixtureWorker(`
    import fs from "node:fs";
    fs.writeFileSync(new URL("worker.pid", import.meta.url), String(process.pid));
    process.stdin.resume();
    process.stdin.on("end", () => setInterval(() => {}, 1_000));
  `);
  const pidFile = path.join(directory, "worker.pid");
  const controller = new AbortController();
  const signal = controller.signal as AbortSignal & {
    addEventListener: AbortSignal["addEventListener"];
    removeEventListener: AbortSignal["removeEventListener"];
  };
  const addEventListener = signal.addEventListener.bind(signal);
  const removeEventListener = signal.removeEventListener.bind(signal);
  let listeners = 0;
  signal.addEventListener = ((...args: Parameters<AbortSignal["addEventListener"]>) => {
    listeners += 1;
    return addEventListener(...args);
  }) as AbortSignal["addEventListener"];
  signal.removeEventListener = ((...args: Parameters<AbortSignal["removeEventListener"]>) => {
    listeners -= 1;
    return removeEventListener(...args);
  }) as AbortSignal["removeEventListener"];
  let timers = 0;

  const scan = collectFileScanInWorker(
    { persist: false, persistIndex: false },
    undefined,
    {
      launch: { executable: process.execPath, workerPath },
      cwd: directory,
      timeoutMs: 30_000,
      signal,
      scheduler: {
        setTimeout: (handler, ms) => {
          timers += 1;
          return setTimeout(handler, ms);
        },
        clearTimeout: (handle) => {
          timers -= 1;
          clearTimeout(handle as ReturnType<typeof setTimeout>);
        },
      },
    },
  );

  for (let attempt = 0; attempt < 100 && !fs.existsSync(pidFile); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(fs.existsSync(pidFile)).toBe(true);
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  controller.abort();

  await expect(scan).rejects.toMatchObject({ name: "AbortError" });
  expect(() => process.kill(pid, 0)).toThrow();
  expect(timers).toBe(0);
  expect(listeners).toBe(0);
});


/* #790: the published MCP runtime release root is `dist/`, `node_modules/` and
   a manifest. The launcher used to answer with the source path it had just
   found missing, so every corpus read in that process died on a module that was
   never there - and took the deployment gate's `board_snapshot` with it. */
test("a root with no worker artifact reports none instead of naming one that is not there", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-file-scan-root-"));
  directories.push(root);
  fs.mkdirSync(path.join(root, "dist"));
  fs.mkdirSync(path.join(root, "node_modules"));

  expect(fileScanWorkerLaunch(root)).toBeNull();

  fs.mkdirSync(path.join(root, ".next", "server"), { recursive: true });
  fs.writeFileSync(path.join(root, ".next", "server", "file-scanner-worker.js"), "");
  expect(fileScanWorkerLaunch(root)).toMatchObject({
    workerPath: path.join(root, ".next", "server", "file-scanner-worker.js"),
  });
});

test("a checkout root still launches its source worker", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-file-scan-checkout-"));
  directories.push(root);
  fs.mkdirSync(path.join(root, "src", "lib"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "lib", "fileScanner.worker.ts"), "");

  expect(fileScanWorkerLaunch(root)).toMatchObject({
    workerPath: path.join(root, "src", "lib", "fileScanner.worker.ts"),
  });
});

test("a worker scan asked for from a root without one is refused, never spawned", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-file-scan-empty-"));
  directories.push(root);

  await expect(collectFileScanInWorker({ persist: false, persistIndex: false }, undefined, { cwd: root }))
    .rejects.toThrow("no file scanner worker artifact");
});
