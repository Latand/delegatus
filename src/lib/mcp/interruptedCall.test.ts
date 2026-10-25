import { withTaskDue } from "@/lib/tasks/taskDue.fixture";
import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { ownFixtureChild, reapFixtureChildren } from "./ownedFixtureChildren";

const roots: string[] = [];
afterEach(async () => { await reapFixtureChildren(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

for (const store of ["SqliteMcpReceiptStore", "FileMcpReceiptStore"]) {
  for (const tool of ["create_task", "update_task"]) {
    for (const cut of ["before-dispatch", "after-receipt", "during-binding"]) {
      test(`${store} ${tool}: process interruption ${cut} preserves original-key safety`, async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-interrupted-")); roots.push(root);
        const script = `
          import fs from "node:fs";
          import { ${store} as Store, MCP_TOOL_NAMES, createMcpToolService } from ${JSON.stringify(path.join(import.meta.dir, "server.ts"))};
          const cut = process.argv[1];
          class CutStore extends Store {
            async claim(...args) {
              const answer = await super.claim(...args);
              if (cut === "before-dispatch" && answer.kind === "fresh") process.exit(23);
              return answer;
            }
            async complete(...args) {
              await super.complete(...args);
              if (cut === "after-receipt") process.exit(23);
            }
          }
          const bindings = Object.fromEntries(MCP_TOOL_NAMES.map(name => [name, async () => ({})]));
          bindings[${JSON.stringify(tool)}] = async () => {
            fs.appendFileSync(${JSON.stringify(path.join(root, "effects"))}, "effect\\n");
            if (cut === "during-binding") process.exit(23);
            return { taskId: "task_fixture", revision: 1 };
          };
          const receipts = new CutStore(${JSON.stringify(path.join(root, "receipts"))});
          const result = await createMcpToolService(bindings, receipts).callTool(${JSON.stringify(tool)}, {
            ...${JSON.stringify(tool === "create_task" ? withTaskDue({}) : {})},
            clientRequestId: "interrupted-edit", project: "fixture", taskId: "task_fixture", text: "Edited task", full: true,
          });
          console.log(JSON.stringify(result));
          receipts.close?.();
        `;
        async function run(mode: string) {
          const child = ownFixtureChild(Bun.spawn([process.execPath, "--eval", script, mode], {
            cwd: path.resolve(import.meta.dir, "../../.."),
            env: { ...process.env, HOME: root, XDG_CONFIG_HOME: root, TMPDIR: root,
              LLV_STATE_DIR: path.join(root, "state"), LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" },
            stdout: "pipe", stderr: "pipe",
          }));
          const [exit, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
          if (exit !== 0 && exit !== 23) throw new Error(error);
          return { exit, answer: output.trim() ? JSON.parse(output) : null };
        }
        expect((await run(cut)).exit).toBe(23);
        const retries = cut === "before-dispatch" ? await Promise.all([run("retry"), run("retry")]) : [await run("retry")];
        const executed = retries.filter(result => result.answer?.ok && result.answer.replayed === false);
        if (cut === "before-dispatch") expect(executed).toHaveLength(1);
        const retry = executed[0] ?? retries[0]!;
        for (const result of retries) expect(result.answer.ok || result.answer.code === "outcome_unknown").toBe(true);
        if (cut === "during-binding") {
          expect(retry.answer).toMatchObject({ ok: false, code: "outcome_unknown", retryable: false,
            details: { outcome: "unknown", nextAction: tool === "create_task" ? "list_tasks" : "get_task" } });
          expect(retry.answer.error).toContain(tool === "create_task" ? "list_tasks" : "get_task");
        } else {
          expect(retry.answer).toMatchObject({ ok: true, taskId: "task_fixture", replayed: cut === "after-receipt" });
          expect((await run("retry")).answer).toMatchObject({ ok: true, replayed: true });
        }
        expect(fs.readFileSync(path.join(root, "effects"), "utf8")).toBe("effect\n");
      }, 20_000);
    }
  }
}

for (const StoreName of ["SqliteMcpReceiptStore", "FileMcpReceiptStore"] as const) {
  test(`${StoreName} cleanup is fenced to one claim generation`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-claim-generation-")); roots.push(root);
    const { MCP_TOOL_NAMES, createMcpToolService, FileMcpReceiptStore, SqliteMcpReceiptStore } = await import("./server");
    const Store = StoreName === "SqliteMcpReceiptStore" ? SqliteMcpReceiptStore : FileMcpReceiptStore;
    const file = path.join(root, StoreName === "SqliteMcpReceiptStore" ? "receipts.sqlite" : "receipts.json");
    const firstStore = new Store(file);
    const secondStore = new Store(file);
    const firstClaim = firstStore.claim.bind(firstStore);
    const secondClaim = secondStore.claim.bind(secondStore);
    const bindingsSeen: import("./server").McpRequestBinding[] = [];
    firstStore.claim = ((key: Parameters<typeof firstStore.claim>[0], digest: Parameters<typeof firstStore.claim>[1], retention: Parameters<typeof firstStore.claim>[2], binding: Parameters<typeof firstStore.claim>[3], beforeClaim: Parameters<typeof firstStore.claim>[4]) => {
      if (binding?.localDispatch) bindingsSeen.push(binding);
      return firstClaim(key, digest, retention, binding, beforeClaim);
    }) as typeof firstStore.claim;
    secondStore.claim = ((key: Parameters<typeof secondStore.claim>[0], digest: Parameters<typeof secondStore.claim>[1], retention: Parameters<typeof secondStore.claim>[2], binding: Parameters<typeof secondStore.claim>[3], beforeClaim: Parameters<typeof secondStore.claim>[4]) => {
      if (binding?.localDispatch) bindingsSeen.push(binding);
      return secondClaim(key, digest, retention, binding, beforeClaim);
    }) as typeof secondStore.claim;
    firstStore.markDispatching = (async () => {
      throw new Error("refused before dispatch marker write");
    }) as typeof firstStore.markDispatching;
    const originalRelease = firstStore.release.bind(firstStore);
    firstStore.release = (async (key: Parameters<typeof firstStore.release>[0], digest: Parameters<typeof firstStore.release>[1], binding: Parameters<typeof firstStore.release>[2]) => {
      await originalRelease(key, digest, binding);
      throw new Error("release acknowledgement lost");
    }) as typeof firstStore.release;
    const originalLookup = firstStore.lookup.bind(firstStore);
    let failLookup = true;
    firstStore.lookup = (async (key: Parameters<typeof firstStore.lookup>[0]) => {
      if (failLookup) { failLookup = false; throw new Error("confirmation read unavailable"); }
      return originalLookup(key);
    }) as typeof firstStore.lookup;

    let finishSecond!: () => void;
    let markSecondStarted!: () => void;
    const secondHeld = new Promise<void>(resolve => { finishSecond = resolve; });
    const secondStarted = new Promise<void>(resolve => { markSecondStarted = resolve; });
    let effects = 0;
    const args = { clientRequestId: "same-tick", taskId: "task_fixture", text: "same payload", full: true };
    const makeBindings = (hold: boolean) => {
      const result = Object.fromEntries(MCP_TOOL_NAMES.map(name => [name, async () => ({})])) as unknown as import("./server").McpToolBindings;
      result.update_task = async () => {
        effects += 1;
        if (hold) { markSecondStarted(); await secondHeld; }
        return { taskId: "task_fixture", revision: effects };
      };
      return result;
    };
    const fixedTimestamp = spyOn(Date.prototype, "toISOString").mockReturnValue("2026-10-20T00:00:00.001Z");
    try {
      const first = createMcpToolService(makeBindings(false), firstStore);
      const second = createMcpToolService(makeBindings(true), secondStore);
      expect((await first.callTool("update_task", args)).code).toBe("outcome_unknown");
      const inFlightSecond = second.callTool("update_task", args);
      await secondStarted;
      expect(bindingsSeen).toHaveLength(2);
      expect(bindingsSeen[0]?.claimedAt).toBe(bindingsSeen[1]?.claimedAt);
      expect(bindingsSeen[0]?.owner).toEqual(bindingsSeen[1]?.owner);
      expect(bindingsSeen[0]?.claimGeneration).toBeTruthy();
      expect(bindingsSeen[0]?.claimGeneration).not.toBe(bindingsSeen[1]?.claimGeneration);

      expect(await first.callTool("update_task", args)).toMatchObject({ ok: false, code: "outcome_unknown" });
      expect(effects).toBe(1);
      finishSecond();
      expect(await inFlightSecond).toMatchObject({ ok: true, revision: 1 });
      expect(effects).toBe(1);
    } finally {
      fixedTimestamp.mockRestore();
      if ("close" in firstStore) firstStore.close();
      if ("close" in secondStore) secondStore.close();
    }
  });

  test(`${StoreName} stale cleanup never replays a replacement digest`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cleanup-digest-")); roots.push(root);
    const { MCP_TOOL_NAMES, createMcpToolService, FileMcpReceiptStore, SqliteMcpReceiptStore } = await import("./server");
    const Store = StoreName === "SqliteMcpReceiptStore" ? SqliteMcpReceiptStore : FileMcpReceiptStore;
    const store = new Store(path.join(root, StoreName === "SqliteMcpReceiptStore" ? "receipts.sqlite" : "receipts.json"));
    const originalMark = store.markDispatching.bind(store);
    store.markDispatching = (async (key: Parameters<typeof store.markDispatching>[0], digest: Parameters<typeof store.markDispatching>[1]) => {
      if (failMarker) { failMarker = false; throw new Error("refused before dispatch marker write"); }
      return originalMark(key, digest);
    }) as typeof store.markDispatching;
    const originalRelease = store.release.bind(store);
    let failMarker = true, loseReleaseAck = true, effects = 0;
    store.release = (async (key: Parameters<typeof store.release>[0], digest: Parameters<typeof store.release>[1], binding: Parameters<typeof store.release>[2]) => {
      if (loseReleaseAck) {
        loseReleaseAck = false;
        await originalRelease(key, digest, binding);
        throw new Error("release acknowledgement lost");
      }
      return originalRelease(key, digest, binding);
    }) as typeof store.release;
    const originalLookup = store.lookup.bind(store);
    let failConfirmation = true;
    store.lookup = (async (key: Parameters<typeof store.lookup>[0]) => {
      if (failConfirmation) { failConfirmation = false; throw new Error("confirmation read unavailable"); }
      return originalLookup(key);
    }) as typeof store.lookup;
    const bindings = Object.fromEntries(MCP_TOOL_NAMES.map(name => [name, async () => ({})])) as unknown as import("./server").McpToolBindings;
    bindings.update_task = async args => ({ taskId: "task_fixture", revision: ++effects, text: args.text });
    const service = createMcpToolService(bindings, store);
    const originalArgs = { clientRequestId: "replacement-digest", taskId: "task_fixture", text: "original", full: true };
    const changedArgs = { ...originalArgs, text: "changed" };
    try {
      expect(await service.callTool("update_task", originalArgs)).toMatchObject({ ok: false, code: "outcome_unknown" });
      expect(await service.callTool("update_task", changedArgs)).toMatchObject({ ok: true, text: "changed", revision: 1 });
      expect(await service.callTool("update_task", originalArgs)).toMatchObject({
        ok: false, code: "idempotency_conflict", replayed: true,
      });
      expect(effects).toBe(1);
    } finally { if ("close" in store) store.close(); }
  });
}

for (const teardown of ["eof", "SIGTERM", "timeout"]) test(`stdio ${teardown} drains the actual receipt and logs process custody`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-stdio-drain-")); roots.push(root);
  const started = path.join(root, "started"), release = path.join(root, "release");
  const timerArmed = path.join(root, "shutdown-timer-armed"), timerAdvanced = path.join(root, "shutdown-timer-advanced");
  const preload = path.join(root, "controlled-timers.mjs");
  const script = `
    import fs from "node:fs";
    import { MCP_TOOL_NAMES, createMcpToolService, SqliteMcpReceiptStore, serveViewerMcpStdio } from ${JSON.stringify(path.join(import.meta.dir, "server.ts"))};
    const bindings = Object.fromEntries(MCP_TOOL_NAMES.map(name => [name, async () => ({})]));
    bindings.update_task = async () => {
      fs.writeFileSync(${JSON.stringify(started)}, "ready");
      while (!fs.existsSync(${JSON.stringify(release)})) await new Promise(resolve => setTimeout(resolve, 10));
      return { taskId: "task_fixture", revision: 1 };
    };
    await serveViewerMcpStdio(createMcpToolService(bindings, new SqliteMcpReceiptStore(${JSON.stringify(path.join(root, "receipts"))})));
  `;
  if (teardown === "timeout") fs.writeFileSync(preload, `
    import fs from "node:fs";
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const controlled = new Set();
    globalThis.setTimeout = (callback, delay, ...args) => {
      if (delay === 35000) {
        const timer = { callback, args, cancelled: false };
        controlled.add(timer);
        fs.writeFileSync(${JSON.stringify(timerArmed)}, String(delay));
        return timer;
      }
      return originalSetTimeout(callback, delay, ...args);
    };
    globalThis.clearTimeout = timer => {
      if (controlled.has(timer)) { timer.cancelled = true; controlled.delete(timer); return; }
      return originalClearTimeout(timer);
    };
    process.on("SIGUSR2", () => {
      fs.writeFileSync(${JSON.stringify(timerAdvanced)}, "advanced");
      for (const timer of controlled) if (!timer.cancelled) timer.callback(...timer.args);
      controlled.clear();
    });
  `);
  const child = ownFixtureChild(Bun.spawn([
    process.execPath, ...(teardown === "timeout" ? ["--preload", preload] : []), "--eval", script,
  ], {
    cwd: path.resolve(import.meta.dir, "../../.."),
    env: { ...process.env, HOME: root, XDG_CONFIG_HOME: root, TMPDIR: root,
      LLV_STATE_DIR: path.join(root, "state"), LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  }));
  let output = "", diagnostics = "";
  const read = async (stream: ReadableStream<Uint8Array>, add: (text: string) => void) => {
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        add(decoder.decode(next.value, { stream: true }));
      }
    } finally { reader.releaseLock(); }
  };
  const reading = Promise.all([read(child.stdout, text => { output += text; }), read(child.stderr, text => { diagnostics += text; })]);
  const until = async (ready: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!ready() && child.exitCode === null && Date.now() < deadline) await Bun.sleep(10);
    if (!ready()) throw new Error(`stdio readiness failed: ${diagnostics}`);
  };
  const send = (request: object) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...request }) + "\n");
  try {
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } });
    await until(() => output.includes('"id":1'));
    send({ method: "notifications/initialized" });
    send({ id: 2, method: "tools/call", params: { name: "update_task", arguments: {
      taskId: "task_fixture", text: "Private task text", clientRequestId: "stdio-drain", full: true,
    } } });
    await until(() => fs.existsSync(started));
    if (teardown !== "SIGTERM") child.stdin.end(); else child.kill("SIGTERM");
    await until(() => diagnostics.includes(teardown !== "SIGTERM" ? '"reason":"stdio-eof"' : '"reason":"signal"'));
    expect(child.exitCode).toBeNull();
    const fingerprint = createHash("sha256").update("update_task:stdio-drain").digest("hex");
    expect(diagnostics).toContain(fingerprint);
    expect(diagnostics).toContain('"role":"mcp-stdio"');
    expect(diagnostics).toContain(`"pid":${child.pid}`);
    expect(diagnostics).not.toContain("Private task text");
    expect(diagnostics).not.toContain("stdio-drain");
    if (teardown === "timeout") {
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(timerArmed) && child.exitCode === null && Date.now() < deadline) await Bun.sleep(10);
      expect(fs.readFileSync(timerArmed, "utf8")).toBe("35000");
      child.kill("SIGUSR2");
      const advancedDeadline = Date.now() + 5000;
      while (!fs.existsSync(timerAdvanced) && Date.now() < advancedDeadline) await Bun.sleep(10);
      expect(fs.existsSync(timerAdvanced)).toBe(true);
      expect(await child.exited).toBe(1);
      await reading;
      expect(diagnostics).toContain('"reason":"drain-deadline"');
      const { SqliteMcpReceiptStore } = await import("./server");
      const receipts = new SqliteMcpReceiptStore(path.join(root, "receipts"));
      try { expect(receipts.lookup("update_task:stdio-drain")).toMatchObject({ result: null, stage: "dispatching" }); }
      finally { receipts.close(); }
      return;
    }
    if (teardown === "SIGTERM") {
      send({ id: 3, method: "tools/call", params: { name: "update_task", arguments: {
        taskId: "task_fixture", text: "A later task", clientRequestId: "after-drain-start", full: true,
      } } });
      await until(() => output.includes('"id":3'));
    }
    fs.writeFileSync(release, "go");
    expect(await child.exited).toBe(0);
    await reading;
    const messages = output.trim().split("\n").map(line => JSON.parse(line));
    expect(messages.find(message => message.id === 2).result.structuredContent).toMatchObject({ ok: true, revision: 1 });
    if (teardown === "SIGTERM") expect(messages.find(message => message.id === 3).result.structuredContent)
      .toMatchObject({ ok: false, code: "not_executed", retryable: true });
    const { SqliteMcpReceiptStore } = await import("./server");
    const receipts = new SqliteMcpReceiptStore(path.join(root, "receipts"));
    try { expect(receipts.lookup("update_task:stdio-drain")?.result).toMatchObject({ ok: true, revision: 1 }); }
    finally { receipts.close(); }
  } finally {
    fs.writeFileSync(release, "go");
    child.stdin.end();
    if (child.exitCode === null) child.kill("SIGTERM");
    await child.exited; await reading;
  }
}, 45_000);

for (const ownerState of ["alive", "unverified", "legacy"]) test(`${ownerState} custody never licenses a second local dispatch`, async () => {
  const { captureProcessIdentity } = await import("@/lib/processIdentity");
  const { MemoryMcpReceiptStore, MCP_TOOL_NAMES, createMcpToolService, requestDigest } = await import("./server");
  const store = new MemoryMcpReceiptStore();
  const args = { clientRequestId: "custody-edit", taskId: "task_fixture", text: "Task edit", full: true };
  const owner = captureProcessIdentity(process.pid);
  const binding = {
    version: 1 as const, toolName: "update_task" as const, clientRequestId: args.clientRequestId, localDispatch: true as const,
    caller: { kind: "unidentified" as const, conversationId: null, project: null }, target: { project: null, identity: null },
    downstreamKey: "update_task:custody-edit", claimedAt: "2026-10-01T00:00:00.000Z",
    owner: ownerState === "unverified" ? { ...owner, startIdentity: null } : owner,
  };
  store.claim("update_task:custody-edit", requestDigest("update_task", args), "durable", ownerState === "legacy" ? undefined : binding);
  let effects = 0;
  const bindings = Object.fromEntries(MCP_TOOL_NAMES.map(name => [name, async () => { effects++; return {}; }])) as unknown as import("./server").McpToolBindings;
  const service = createMcpToolService(bindings, store);
  expect(await service.callTool("update_task", args)).toMatchObject({ ok: false, code: "outcome_unknown", retryable: false });
  expect(await service.callTool("update_task", { ...args, text: "Conflicting edit" }))
    .toMatchObject({ ok: false, code: "idempotency_conflict", retryable: false });
  expect(effects).toBe(0);
});

test("a persisted legacy interruption never advertises an executable retry", async () => {
  const { MemoryMcpReceiptStore, MCP_TOOL_NAMES, createMcpToolService, requestDigest } = await import("./server");
  const store = new MemoryMcpReceiptStore();
  const args = { clientRequestId: "legacy-interruption", taskId: "task_fixture", text: "Edited task", full: true };
  const digest = requestDigest("update_task", args), key = "update_task:legacy-interruption";
  store.claim(key, digest, "durable");
  store.complete(key, digest, { ok: false, toolName: "update_task", clientRequestId: args.clientRequestId,
    replayed: true, code: "call_interrupted", retryable: true, error: "Interrupted" });
  let effects = 0;
  const bindings = Object.fromEntries(MCP_TOOL_NAMES.map(name => [name, async () => { effects++; return {}; }])) as unknown as import("./server").McpToolBindings;
  expect(await createMcpToolService(bindings, store).callTool("update_task", args))
    .toMatchObject({ ok: false, code: "outcome_unknown", retryable: false, details: { nextAction: "get_task" } });
  expect(effects).toBe(0);
});

test("importing the shared service keeps stdio containment at its entry point", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-import-lifetime-")); roots.push(root);
  const child = ownFixtureChild(Bun.spawn([process.execPath, "--eval", `
    await import(${JSON.stringify(path.join(import.meta.dir, "server.ts"))});
    console.log(process.env.LLV_MCP_PARENT_IDENTITY);
    process.exit(0);
  `], {
    env: { ...process.env, HOME: root, XDG_CONFIG_HOME: root, TMPDIR: root,
      LLV_STATE_DIR: path.join(root, "state"), LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1",
      LLV_MCP_PARENT_IDENTITY: "entry-only-parent" }, stdout: "pipe", stderr: "pipe",
  }));
  const [exit, output, diagnostics] = await Promise.all([child.exited,
    new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(exit, diagnostics).toBe(0);
  expect(output.trim()).toBe("entry-only-parent");
});
