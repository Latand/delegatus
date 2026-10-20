import { afterEach, expect, test } from "bun:test";
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

for (const teardown of ["eof", "SIGTERM", "timeout"]) test(`stdio ${teardown} drains the actual receipt and logs process custody`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-stdio-drain-")); roots.push(root);
  const started = path.join(root, "started"), release = path.join(root, "release");
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
  const child = ownFixtureChild(Bun.spawn([process.execPath, "--eval", script], {
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
