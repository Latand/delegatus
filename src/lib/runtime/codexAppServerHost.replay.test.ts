// destructive-code: head-only; fixture-owned paths and recording process doubles.
import { agentPublicationIdentityEnv } from "@/lib/git/agentPublicationIdentity";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type SpawnOptionsWithoutStdio } from "node:child_process";
import { describe, expect, test } from "bun:test";
import { AgentRegistry } from "@/lib/agent/registry";
import { STRUCTURED_HOST_STAMP_ENV, structuredHostStamp } from "@/lib/scanner/process";
import { CodexAppServerHost, rolloutTurnsFromDisk } from "./codexAppServerHost";
import { encodeCodexStructuredUserText } from "./codexStructuredUserText.server";
import { decodeCodexStructuredUserText } from "./codexStructuredUserText";
import { persistCodexHost } from "./registry";
import { GATE_CHECK_ROOT_IDENTITY_ENV } from "./gateCheckTool";
import { GATE_CHECK_LAUNCH_ROOT_ENV, GATE_CHECK_ROOT_ENV, recorderGatePaths } from "./gateCheckRecord";
import { STRUCTURED_IMAGE_CAPABILITY, structuredContent, type StructuredImageRef } from "./structuredContent";
import { codexProcessCleanupArgs } from "@/lib/agent/processCleanupPolicy";
import { installCodexHostFixture, COMPACT_SELECTED, DENIED_FEATURE_ARGS, deliveryDedup, MemoryEventStore, FakeAppServer, fakeSpawn, waitForCondition, ownedFakeProcess, nextEvent, metadataState } from "./codexAppServerHost.fixture";

installCodexHostFixture();

describe("CodexAppServerHost", () => {
  test("fresh structured threads enable only granted servers and disable the rest", async () => {
    const server = new FakeAppServer("custom-mcp-thread");
    server.mcpServers = {
      viewer: { command: "agent-log-viewer-mcp", enabled: true, default_tools_approval_mode: "prompt" },
      "agent-browser": { command: "browser-mcp", enabled: true, default_tools_approval_mode: "writes" },
      "telegram-readonly": { command: "telegram-mcp", enabled: true, default_tools_approval_mode: "prompt" },
    };
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      mcpServers: ["agent-browser"],
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });

    expect(server.requests.find((request) => request.method === "thread/start")?.params).toMatchObject({
      config: {
        mcp_servers: {
          viewer: { enabled: true, default_tools_approval_mode: "approve" },
          "agent-browser": { enabled: false, default_tools_approval_mode: "writes" },
          "telegram-readonly": { enabled: false, default_tools_approval_mode: "prompt" },
        },
      },
    });
    await host.release();
  });

  test("round-trips image blocks through turn start and image-only steering", async () => {
    const server = new FakeAppServer("image-thread");
    server.modelList = [
      { id: "gpt-5.6-sol", isDefault: true, inputModalities: ["text", "image"] },
      { id: "gpt-5.3-codex-spark", isDefault: false, inputModalities: ["text"] },
    ];
    const resolved: StructuredImageRef[] = [];
    const first = {
      sha256: "1".repeat(64),
      mime: "image/png" as const,
      bytes: 67,
    };
    const second = {
      sha256: "2".repeat(64),
      mime: "image/webp" as const,
      bytes: 44,
    };
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      model: "gpt-5.6-sol",
      eventStore: new MemoryEventStore(),
      resolveImagePath: (ref) => {
        resolved.push(ref);
        return `/runtime-images/${ref.sha256}`;
      },
      spawnProcess: fakeSpawn(server),
    });

    expect((await host.health()).activeFlags).toContain(STRUCTURED_IMAGE_CAPABILITY);
    const firstContent = structuredContent("inspect", [first]);
    expect(await host.send({ id: "image-start", ...firstContent, selectedContext: COMPACT_SELECTED, origin: { kind: "operator" } })).toEqual({
      outcome: "turn-started",
      turnId: "turn-1",
    });
    expect(server.requests.find((request) => request.method === "turn/start")?.params).toMatchObject({
      input: [
        { type: "localImage", path: `/runtime-images/${first.sha256}` },
        { type: "text", text: await encodeCodexStructuredUserText("inspect", firstContent.contentDigest, COMPACT_SELECTED, { kind: "operator" }, deliveryDedup("image-start")) },
      ],
      clientUserMessageId: "image-start",
    });

    const secondContent = structuredContent("", [second]);
    expect(await host.send({ id: "image-steer", expectedTurnId: "turn-1", ...secondContent, selectedContext: COMPACT_SELECTED, origin: { kind: "operator" } })).toEqual({
      outcome: "steered",
      turnId: "turn-1",
    });
    expect(server.requests.find((request) => request.method === "turn/steer")?.params).toMatchObject({
      expectedTurnId: "turn-1",
      input: [
        { type: "localImage", path: `/runtime-images/${second.sha256}` },
        { type: "text", text: await encodeCodexStructuredUserText("", secondContent.contentDigest, COMPACT_SELECTED, { kind: "operator" }, deliveryDedup("image-steer")) },
      ],
      clientUserMessageId: "image-steer",
    });
    expect(resolved).toEqual([first, second]);
    for (const method of ["turn/start", "turn/steer"]) {
      const params = server.requests.find((request) => request.method === method)!.params as { input: Array<{ type: string; text?: string }> };
      const wire = params.input.find((part) => part.type === "text")!.text!;
      expect(wire.split("\n")[0]!.length).toBeLessThanOrEqual(96);
      expect(decodeCodexStructuredUserText(wire).metadataRef).toBeDefined();
    }
    await host.release();
  });

  test("an image echo past the old line bound no longer kills the host, and reaches storage bounded", async () => {
    const server = new FakeAppServer("oversized-thread");
    server.modelList = [{ id: "gpt-5.6-sol", isDefault: true, inputModalities: ["text", "image"] }];
    const store = new MemoryEventStore();
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      model: "gpt-5.6-sol",
      eventStore: store,
      resolveImagePath: (ref) => `/runtime-images/${ref.sha256}`,
      spawnProcess: fakeSpawn(server),
    });

    const body = Buffer.alloc(18 * 1024 * 1024, 9).toString("base64");
    expect(body.length).toBeGreaterThan(16 * 1024 * 1024);
    server.notify("item/completed", {
      threadId: "oversized-thread",
      turnId: "turn-1",
      item: {
        type: "userMessage",
        clientId: "oversized-image",
        content: [
          { type: "input_image", image_url: `data:image/png;base64,${body}` },
          { type: "text", text: "look at this" },
        ],
      },
    });
    await Bun.sleep(50);

    expect((await host.health()).status).not.toBe("dead");
    const items = store.load("oversized-thread").filter((event) => event.kind === "item");
    expect(items).not.toHaveLength(0);
    const serialized = JSON.stringify(items);
    expect(serialized).not.toContain(body.slice(0, 256));
    expect(serialized.length).toBeLessThan(64 * 1024);
    expect(serialized).toContain("localImage");
    await host.release();
  });

  test("keeps image affordance disabled for a text-only selected model", async () => {
    const server = new FakeAppServer("spark-thread");
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      model: "gpt-5.3-codex-spark",
      eventStore: new MemoryEventStore(),
      resolveImagePath: () => { throw new Error("image path must stay unresolved"); },
      spawnProcess: fakeSpawn(server),
    });
    expect((await host.health()).activeFlags).not.toContain(STRUCTURED_IMAGE_CAPABILITY);
    await expect(host.send({
      id: "spark-image",
      content: { text: "inspect", images: [{ sha256: "3".repeat(64), mime: "image/png", bytes: 67 }] },
    })).rejects.toThrow("does not advertise image input");
    expect(server.requests.some((request) => request.method === "turn/start" || request.method === "turn/steer")).toBeFalse();
    await host.release();
  });

  test("a transient capability probe fault stays fail-closed and recovers on the next image send", async () => {
    const server = new FakeAppServer("probe-thread");
    server.modelList = [{ id: "gpt-5.6-sol", isDefault: true, inputModalities: ["text", "image"] }];
    /* Startup probe and the first on-demand retry both fault. */
    server.modelListFailuresRemaining = 2;
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      model: "gpt-5.6-sol",
      eventStore: new MemoryEventStore(),
      resolveImagePath: (ref) => `/runtime-images/${ref.sha256}`,
      spawnProcess: fakeSpawn(server),
    });
    const imageEntry = (id: string) => ({
      id,
      content: { text: "inspect", images: [{ sha256: "4".repeat(64), mime: "image/png" as const, bytes: 67 }] },
    });

    /* Probe-unavailable: fail closed with a retryable reason, never the
       model-incompatible verdict, and never actuate the turn. */
    expect((await host.health()).activeFlags).not.toContain(STRUCTURED_IMAGE_CAPABILITY);
    await expect(host.send(imageEntry("probe-image-one"))).rejects.toThrow("temporarily unavailable");
    expect(server.requests.some((request) => request.method === "turn/start")).toBeFalse();

    /* The probe recovers: the next image send re-discovers capability inside
       the same host lifetime and delivers. */
    expect(await host.send(imageEntry("probe-image-two"))).toEqual({ outcome: "turn-started", turnId: "turn-1" });
    expect((await host.health()).activeFlags).toContain(STRUCTURED_IMAGE_CAPABILITY);

    /* A genuine text-only verdict still rejects with the model reason. */
    await host.release();
    const textOnlyServer = new FakeAppServer("probe-verdict-thread");
    textOnlyServer.modelListFailuresRemaining = 1;
    const textOnlyHost = await CodexAppServerHost.start({
      cwd: "/repo",
      model: "gpt-5.3-codex-spark",
      eventStore: new MemoryEventStore(),
      resolveImagePath: () => { throw new Error("image path must stay unresolved"); },
      spawnProcess: fakeSpawn(textOnlyServer),
    });
    await expect(textOnlyHost.send(imageEntry("probe-image-three"))).rejects.toThrow("does not advertise image input");
    await textOnlyHost.release();
  });

  test.each([false, true])("Codex launches carry publication settings through the child allowlist (keyed filters: %s)", async (keyedFilters) => {
    const captured: { options?: SpawnOptionsWithoutStdio } = {};
    const email = ["no-reply", "build.example.invalid"].join("@");
    const prioritySource = JSON.stringify({ database: path.join(metadataState, "tasks.sqlite"), taskIds: ["stage-task"] });
    const root = fs.mkdtempSync(path.join(metadataState, "shell-policy-"));
    const physicalRoot = fs.realpathSync(root);
    const { dev, ino } = fs.statSync(physicalRoot);
    const gate = { [GATE_CHECK_LAUNCH_ROOT_ENV]: root, [GATE_CHECK_ROOT_ENV]: physicalRoot, [GATE_CHECK_ROOT_IDENTITY_ENV]: `${dev}:${ino}` };
    const server = new FakeAppServer();
    server.shellPolicy = {
      inherit: "core", set: { GIT_AUTHOR_EMAIL: "unsafe", GIT_COMMITTER_EMAIL: "unsafe", OTHER: "kept" },
      ...(keyedFilters ? { filters: { PATH: "include", HOME: "include", "PRIVATE_*": "exclude" } } : { include_only: ["PATH", "HOME"] }),
    };
    const host = await CodexAppServerHost.start({
      cwd: "/repo", env: { NODE_ENV: "test", LLV_PUBLICATION_NAME: "Build Agent", LLV_PUBLICATION_EMAIL: email,
        LLV_GATE_CPU_PRIORITY_SOURCE: prioritySource, TMPDIR: root, PRIVATE_SETTING: "excluded",
        [GATE_CHECK_LAUNCH_ROOT_ENV]: "unverified", [GATE_CHECK_ROOT_ENV]: "unverified", [GATE_CHECK_ROOT_IDENTITY_ENV]: "unverified" },
      eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(server, captured),
    });
    try {
      expect(captured.options?.env).toMatchObject({
        GIT_AUTHOR_NAME: "Build Agent", GIT_COMMITTER_NAME: "Build Agent",
        GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email,
        LLV_GATE_CPU_PRIORITY_SOURCE: prioritySource,
        ...gate,
      });
      const git = agentPublicationIdentityEnv({ LLV_PUBLICATION_NAME: "Build Agent", LLV_PUBLICATION_EMAIL: email }, "/repo");
      const set = { ...git, LLV_GATE_CPU_PRIORITY_SOURCE: prioritySource, TMPDIR: root, ...gate };
      const params = server.requests.find((request) => request.method === "thread/start")?.params as { config: Record<string, unknown> };
      expect(params.config.shell_environment_policy).toEqual({ set, ...(keyedFilters
        ? { filters: Object.fromEntries(Object.keys(set).map((key) => [key, "include"])) }
        : { include_only: ["PATH", "HOME", ...Object.keys(set)] }) });
    } finally { await host.release(); }
  });

  test("the recorder validates the host's complete initial TMPDIR alias binding", async () => {
    const root = path.join(metadataState, "gate-launch"), foreign = path.join(metadataState, "foreign-launch");
    const alias = path.join(metadataState, "launch-tmp");
    fs.mkdirSync(root); fs.mkdirSync(foreign); fs.symlinkSync(root, alias, "dir");
    const captured: { options?: SpawnOptionsWithoutStdio } = {};
    const host = await CodexAppServerHost.start({
      cwd: "/repo", env: { NODE_ENV: "test", TMPDIR: alias },
      eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(new FakeAppServer(), captured),
    });
    try {
      const env = captured.options!.env!;
      const log = path.join(root, "check.log");
      expect(env[GATE_CHECK_LAUNCH_ROOT_ENV]).toBe(alias);
      expect(env[GATE_CHECK_ROOT_ENV]).toBe(fs.realpathSync(root));
      expect(recorderGatePaths(log, root, env).root).toBe(fs.realpathSync(root));
      fs.unlinkSync(alias); fs.symlinkSync(foreign, alias, "dir");
      expect(() => recorderGatePaths(log, root, env)).toThrow("gate launch root identity changed");
    } finally { await host.release(); }
  });

  test("fans out replay, fences steering, answers attention, and persists host columns", async () => {
    const server = new FakeAppServer();
    const captured: { options?: SpawnOptionsWithoutStdio } = {};
    const blockedCredential = ["must", "stay", "private"].join("-");
    const codexHome = path.join(metadataState, "codex-home");
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      codexHome,
      env: {
        NODE_ENV: "test",
        PATH: process.env.PATH,
        [["OPENAI", "API", "KEY"].join("_")]: blockedCredential,
        [["LLV", "TOKEN"].join("_")]: blockedCredential,
        [["ANTHROPIC", "AUTH", "TOKEN"].join("_")]: blockedCredential,
        [["AWS", "SESSION", "TOKEN"].join("_")]: blockedCredential,
        [["PRIVATE", "SERVICE", "API", "KEY"].join("_")]: blockedCredential,
      },
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server, captured),
    });
    /* The allowlisted env, plus the provenance stamp the resources rail needs
       to tell this host from any other process wearing the same argv (#1199),
       plus the agent's own config and state root (#1905): the commands it runs
       resolve those, never the operator's, and `gh` is pinned to the
       operator's configuration because it used to read XDG_CONFIG_HOME. */
    const sandboxConfig = path.join(os.tmpdir(), "llv-spawn-sandbox", "codex-home", "config");
    const temporaryRootStat = fs.statSync(fs.realpathSync(os.tmpdir()));
    expect(captured.options?.env).toEqual({
      NODE_ENV: "test",
      PATH: process.env.PATH,
      CODEX_HOME: codexHome,
      ...agentPublicationIdentityEnv({}),
      GIT_AUTHOR_NAME: "Delegatus",
      GIT_AUTHOR_EMAIL: ["noreply", "delegatus.invalid"].join("@"),
      GIT_COMMITTER_NAME: "Delegatus",
      GIT_COMMITTER_EMAIL: ["noreply", "delegatus.invalid"].join("@"),
      XDG_CONFIG_HOME: sandboxConfig,
      LLV_STATE_DIR: path.join(sandboxConfig, "agent-log-viewer", "state"),
      GH_CONFIG_DIR: path.join(os.homedir(), ".config", "gh"),
      [GATE_CHECK_ROOT_ENV]: fs.realpathSync(os.tmpdir()),
      [GATE_CHECK_LAUNCH_ROOT_ENV]: os.tmpdir(),
      [GATE_CHECK_ROOT_IDENTITY_ENV]: `${temporaryRootStat.dev}:${temporaryRootStat.ino}`,
      [STRUCTURED_HOST_STAMP_ENV]: structuredHostStamp(),
    });
    expect(host.identity).toEqual({ threadId: "thread-149", path: "/sessions/thread-149.jsonl" });

    const first = host.attach(0);
    const second = host.attach(0);
    expect(await nextEvent(first)).toEqual({ kind: "session-status", status: "idle", seq: 1 });
    expect(await nextEvent(second)).toEqual({ kind: "session-status", status: "idle", seq: 1 });

    const started = await host.send({ id: "delivery-one", text: "begin" });
    expect(started).toEqual({ outcome: "turn-started", turnId: "turn-1" });
    expect(await host.send({ id: "stale", text: "wrong", expectedTurnId: "turn-old" })).toEqual({ outcome: "rejected", reason: "stale-turn" });
    expect(await host.send({ id: "delivery-two", text: "steer", expectedTurnId: "turn-1" })).toEqual({ outcome: "steered", turnId: "turn-1" });
    const steer = server.requests.find((request) => request.method === "turn/steer")!;
    expect(steer.params).toMatchObject({
      expectedTurnId: "turn-1",
      clientUserMessageId: "delivery-two",
      input: [{ type: "text", text: await encodeCodexStructuredUserText("steer", undefined, null, null, deliveryDedup("delivery-two")) }],
    });

    server.request("approval-1", "item/commandExecution/requestApproval", { command: "touch allowed" });
    await Bun.sleep(0);
    const attention = (await host.health()).pendingAttention[0]!;
    expect(attention).toStartWith("item/commandExecution/requestApproval:approval-1:");
    await host.answer(attention, { decision: "accept" });
    expect(server.requests.at(-1)).toMatchObject({ id: "approval-1", result: { decision: "accept" } });
    server.request("approval-2", "item/commandExecution/requestApproval", { command: "echo resolved" });
    await Bun.sleep(0);
    const resolvedStream = host.attach((await host.health()).eventCursor)[Symbol.asyncIterator]();
    server.notify("serverRequest/resolved", { threadId: "thread-149", requestId: "approval-2" });
    expect((await resolvedStream.next()).value).toMatchObject({
      kind: "attention-resolved",
      id: expect.stringContaining("item/commandExecution/requestApproval:approval-2:"),
      resolution: "server-resolved",
    });
    expect((await host.health()).pendingAttention).toEqual([]);

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-structured-registry-"));
    const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
    const key = { engine: "codex" as const, sessionId: host.identity.threadId };
    registry.upsert({
      key,
      artifactPath: host.identity.path!,
      cwd: "/repo",
      accountId: null,
      status: "live",
      host: null,
      structuredHost: {
        kind: "codex-app-server",
        endpoint: "stdio:pending",
        process: null,
        eventCursor: 0,
        protocolVersion: null,
        writerClaimEpoch: 7,
        activeTurnRef: null,
        pendingAttention: [],
        activeFlags: [],
      },
      claimEpoch: 7,
      claimOwner: "viewer",
      pendingAction: null,
    });
    await persistCodexHost(registry, key, host, "viewer", 7);
    expect(registry.snapshot().entries["codex:thread-149"]?.structuredHost).toMatchObject({
      kind: "codex-app-server",
      endpoint: "stdio:4242",
      eventCursor: 9, // Includes the durable answer-dispatch receipt.
      protocolVersion: "0.162.1",
      writerClaimEpoch: 7,
      activeTurnRef: "turn-1",
      pendingAttention: [],
    });
    await host.release();
  });

  test("a per-turn effort snapshot on the queue entry outranks the host default on turn/start (issue #390)", async () => {
    const overrideServer = new FakeAppServer("per-turn-effort");
    const overrideHost = await CodexAppServerHost.start({
      cwd: "/repo", effort: "medium", eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(overrideServer),
    });
    await overrideHost.send({ id: "with-override", text: "run hot", runtime: { effort: "xhigh", fast: true } });
    expect(overrideServer.requests.find((request) => request.method === "turn/start")?.params).toMatchObject({ effort: "xhigh" });
    await overrideHost.release();

    // Invalid explicit selections fail before the native write.
    const invalidServer = new FakeAppServer("per-turn-invalid");
    const invalidHost = await CodexAppServerHost.start({
      cwd: "/repo", effort: "medium", eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(invalidServer),
    });
    await expect(invalidHost.send({ id: "with-blemish", text: "stay safe", runtime: { effort: "warp9" } })).rejects.toThrow("effort is invalid");
    expect(invalidServer.requests.some((request) => request.method === "turn/start")).toBeFalse();
    await invalidHost.release();
  });

  test("resumes the same engine thread after a host-process replacement", async () => {
    const eventStore = new MemoryEventStore();
    const firstServer = new FakeAppServer("durable-thread");
    const first = await CodexAppServerHost.start({ cwd: "/repo", effort: "xhigh", eventStore, spawnProcess: fakeSpawn(firstServer) });
    await first.send({ id: "before-restart", text: "remember" });
    expect(firstServer.requests.find((request) => request.method === "turn/start")?.params).toMatchObject({ effort: "xhigh" });
    await first.release();
    const replacementServer = new FakeAppServer("durable-thread");
    const replacement = await CodexAppServerHost.adopt("durable-thread", {
      cwd: "/repo",
      effort: "xhigh",
      eventStore,
      initialEventCursor: 3,
      spawnProcess: fakeSpawn(replacementServer),
    });
    expect(replacement.identity.threadId).toBe("durable-thread");
    expect(replacementServer.requests.some((request) => request.method === "thread/resume")).toBeTrue();
    const replay = replacement.attach(1)[Symbol.asyncIterator]();
    expect((await replay.next()).value).toEqual({ kind: "turn-started", turnId: "turn-1", seq: 2, accountingAt: expect.any(String) });
    expect((await replay.next()).value).toMatchObject({ kind: "item", phase: "completed", seq: 3 });
    expect((await replay.next()).value).toEqual({ kind: "session-status", status: "unhosted", seq: 4 });
    expect((await replay.next()).value).toEqual({ kind: "session-status", status: "idle", seq: 5 });
    await replacement.send({ id: "after-restart", text: "recall" });
    expect(replacementServer.requests.find((request) => request.method === "turn/start")?.params).toMatchObject({ effort: "xhigh" });
    await replacement.release();
  });

  test("accepts a legal resume response above the legacy frame guard", async () => {
    const threadId = "long-durable-thread";
    const eventStore = new MemoryEventStore();
    eventStore.append(threadId, { kind: "session-status", status: "idle", seq: 1 });
    const server = new FakeAppServer(threadId, threadId, false, [{
      id: "historical-turn",
      status: "completed",
      items: [{ type: "agentMessage", text: "x".repeat(5 * 1024 * 1024) }],
    }]);

    const host = await CodexAppServerHost.adopt(threadId, {
      cwd: "/repo",
      eventStore,
      initialEventCursor: 1,
      spawnProcess: fakeSpawn(server),
    });

    expect(server.requests.find((request) => request.method === "thread/resume")?.params)
      .toMatchObject({ threadId });
    expect(await host.health()).toMatchObject({ status: "idle", eventCursor: 5 });
    await host.release();
  });

  /* An mcpToolCall replay item shaped like the production frame: one turn of
     Viewer tool calls whose result text dominates the envelope's byte count. */
  const fatReplayTurn = (turnId: string, itemPrefix: string, count: number, text: string) => ({
    id: turnId,
    status: "completed",
    items: Array.from({ length: count }, (_, index) => ({
      id: `${itemPrefix}-${index}`,
      type: "mcpToolCall",
      status: "completed",
      result: { Ok: { content: [{ type: "text", text }] } },
    })),
  });

  test("recovery survives an oversized thread/resume replay envelope with a bounded ledger", async () => {
    const threadId = "oversized-resume-thread";
    const fatText = "x".repeat(1024 * 1024);
    const server = new FakeAppServer(threadId, threadId, false, [fatReplayTurn("fat-turn", "fat-call", 26, fatText)]);
    const eventStore = new MemoryEventStore();
    const host = await CodexAppServerHost.adopt(threadId, {
      cwd: "/repo",
      eventStore,
      spawnProcess: fakeSpawn(server),
    });

    expect((await host.health()).status).not.toBe("dead");
    const items = eventStore.load(threadId).filter((event) => event.kind === "item");
    expect(items).toHaveLength(26);
    const serialized = JSON.stringify(items);
    expect(serialized).toContain("truncated");
    expect(serialized.length).toBeLessThan(2 * 1024 * 1024);
    expect(await host.send({ id: "post-recovery", text: "ping" })).toMatchObject({ outcome: "turn-started" });
    await host.release();
  });

  test("the oversized replay envelope survives arriving in stream chunks", async () => {
    const threadId = "chunked-resume-thread";
    const fatText = "x".repeat(1024 * 1024);
    const server = new FakeAppServer(threadId, threadId, false, [fatReplayTurn("chunk-turn", "chunk-call", 26, fatText)]);
    server.responseChunkBytes = 64 * 1024;
    const eventStore = new MemoryEventStore();
    const host = await CodexAppServerHost.adopt(threadId, {
      cwd: "/repo",
      eventStore,
      spawnProcess: fakeSpawn(server),
    });

    expect((await host.health()).status).not.toBe("dead");
    expect(eventStore.load(threadId).filter((event) => event.kind === "item")).toHaveLength(26);
    await host.release();
  });

  /* Production 2026-08-04: a 49 MB thread/resume envelope over a Cyrillic-heavy
     thread stayed above the frame guard even with every string capped, so the
     resume — and with it every account switch for the conversation — failed
     with "oversized JSONL frame". The finished frame now shrinks its string
     caps until it fits instead. */
  test("a replay envelope still oversized after string reduction shrinks instead of failing the resume", async () => {
    const threadId = "shrink-resume-thread";
    /* Every text part sits exactly at the string cap, so the first reduction
       pass keeps all ~25 MB and only the shrink passes can fit the frame. */
    const content = Array.from({ length: 1550 }, () => ({ type: "text", text: "z".repeat(16 * 1024) }));
    const server = new FakeAppServer(threadId, threadId, false, [{
      id: "shrink-turn",
      status: "completed",
      items: [{
        id: "shrink-call-0",
        type: "mcpToolCall",
        status: "completed",
        result: { Ok: { content } },
      }],
    }]);
    const eventStore = new MemoryEventStore();
    const host = await CodexAppServerHost.adopt(threadId, {
      cwd: "/repo",
      eventStore,
      spawnProcess: fakeSpawn(server),
    });

    expect((await host.health()).status).not.toBe("dead");
    const items = eventStore.load(threadId).filter((event) => event.kind === "item");
    expect(items).toHaveLength(1);
    expect(JSON.stringify(items)).toContain("truncated");
    expect(await host.send({ id: "post-shrink", text: "ping" })).toMatchObject({ outcome: "turn-started" });
    await host.release();
  });

  test("inline image history in the replay envelope reaches the ledger only as a bounded reference", async () => {
    const threadId = "image-replay-thread";
    const body = Buffer.alloc(1024 * 1024, 5).toString("base64");
    const server = new FakeAppServer(threadId, threadId, false, [{
      id: "image-turn",
      status: "completed",
      items: [{
        id: "image-echo",
        type: "userMessage",
        clientId: "image-echo",
        content: [
          { type: "input_image", image_url: `data:image/png;base64,${body}` },
          { type: "text", text: "replayed screenshot" },
        ],
      }],
    }]);
    const eventStore = new MemoryEventStore();
    const host = await CodexAppServerHost.adopt(threadId, {
      cwd: "/repo",
      eventStore,
      resolveImagePath: (ref) => `/runtime-images/${ref.sha256}`,
      spawnProcess: fakeSpawn(server),
    });

    expect((await host.health()).status).not.toBe("dead");
    const serialized = JSON.stringify(eventStore.load(threadId).filter((event) => event.kind === "item"));
    expect(serialized).toContain("localImage");
    expect(serialized).not.toContain(body.slice(0, 256));
    expect(serialized.length).toBeLessThan(64 * 1024);
    await host.release();
  });

  test("a queued send settles exactly once across an oversized thread/read confirmation replay", async () => {
    const threadId = "oversized-read-thread";
    const fatText = "y".repeat(1024 * 1024);
    const server = new FakeAppServer(threadId, threadId);
    const fatTurn = fatReplayTurn("persisted-turn", "read-call", 26, fatText);
    server.readTurns = [{
      ...fatTurn,
      items: [
        ...fatTurn.items,
        { type: "userMessage", clientId: "operation-recovered", content: [{ type: "text", text: "hello" }] },
      ],
    }];
    const host = await CodexAppServerHost.adopt(threadId, {
      cwd: "/repo",
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });

    expect(await host.send({ id: "operation-recovered", text: "hello" })).toEqual({
      outcome: "turn-started",
      turnId: "persisted-turn",
    });
    expect(server.requests.some((request) => request.method === "turn/start" || request.method === "turn/steer")).toBeFalse();
    expect((await host.health()).status).not.toBe("dead");
    await host.release();
  });

  test("delivery confirmation survives a paginated thread that refuses hydration (#1332)", async () => {
    const threadId = "paginated-confirmation-thread";
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-paginated-confirm-"));
    const rollout = path.join(directory, `${threadId}.jsonl`);
    fs.writeFileSync(rollout, `${JSON.stringify({
      timestamp: "t1",
      type: "event_msg",
      payload: {
        type: "item_completed",
        turn_id: "persisted-turn",
        item: { type: "UserMessage", id: "item-1", client_id: "operation-paginated-confirm", content: [{ type: "text", text: "hello" }] },
      },
    })}\n${JSON.stringify({
      timestamp: "t2",
      type: "event_msg",
      payload: { type: "turn_completed", turn_id: "persisted-turn" },
    })}\n`);
    const server = new FakeAppServer(threadId, threadId);
    server.threadPath = rollout;
    server.hydratedReadError = "list_turns is not supported yet";
    const host = await CodexAppServerHost.adopt(threadId, {
      cwd: "/repo",
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });

    expect(await host.send({ id: "operation-paginated-confirm", text: "hello" })).toEqual({
      outcome: "turn-started",
      turnId: "persisted-turn",
    });
    expect(server.requests.some((request) => request.method === "turn/start" || request.method === "turn/steer")).toBeFalse();
    expect(server.requests.filter((request) => request.method === "thread/turns/list")).toHaveLength(1);
    expect((await host.health()).status).not.toBe("dead");
    await host.release();
  });

  test("an oversized frame that is not the awaited replay envelope still fails closed", async () => {
    const server = new FakeAppServer("oversized-notification-thread");
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      shutdownGraceMs: 2,
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
      ...ownedFakeProcess,
      signalProcess: (_pid, signal) => {
        if (signal === "SIGKILL") queueMicrotask(() => server.emit("close", 0, signal));
      },
    });

    server.notify("item/completed", {
      threadId: "oversized-notification-thread",
      turnId: "turn-9",
      item: { type: "agentMessage", text: "z".repeat(26 * 1024 * 1024) },
    });
    await Bun.sleep(20);
    expect(await host.health()).toMatchObject({ status: "dead" });
  });

  test("an oversized response to a pending non-replay request still fails closed", async () => {
    const server = new FakeAppServer("oversized-turn-start-thread");
    server.oversizedTurnStartResult = true;
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      shutdownGraceMs: 2,
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
      ...ownedFakeProcess,
      signalProcess: (_pid, signal) => {
        if (signal === "SIGKILL") queueMicrotask(() => server.emit("close", 0, signal));
      },
    });

    await expect(host.send({ id: "oversized-turn-start", text: "hi" })).rejects.toThrow();
    expect(await host.health()).toMatchObject({ status: "dead" });
  });

  test("an oversized response that no replay read is awaiting still fails closed", async () => {
    const server = new FakeAppServer("oversized-response-thread");
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      shutdownGraceMs: 2,
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
      ...ownedFakeProcess,
      signalProcess: (_pid, signal) => {
        if (signal === "SIGKILL") queueMicrotask(() => server.emit("close", 0, signal));
      },
    });

    server.stdout.write(`{"id":777,"result":{"blob":"${"w".repeat(26 * 1024 * 1024)}"}}\n`);
    await Bun.sleep(20);
    expect(await host.health()).toMatchObject({ status: "dead" });
  });

  test("managed-home adoption discovers Viewer and resumes with every unrelated MCP server disabled", async () => {
    const server = new FakeAppServer("managed-thread");
    server.mcpServers = {
      viewer: { command: "agent-log-viewer-mcp", enabled: true, default_tools_approval_mode: "prompt" },
      playwright: { command: "npx", enabled: true },
      "telegram-readonly": { command: "uv", enabled: true },
    };
    const captured: { args?: string[]; options?: SpawnOptionsWithoutStdio } = {};
    const codexHome = path.join(metadataState, "managed-codex-home");
    const host = await CodexAppServerHost.adopt("managed-thread", {
      cwd: "/repo",
      codexHome,
      env: { ...process.env, LLV_SPAWN_CAPABILITY: undefined },
      fileAuthCredentials: true,
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server, captured),
    });
    expect(captured.args).toEqual([
      ...DENIED_FEATURE_ARGS,
      ...codexProcessCleanupArgs(codexHome),
      "-c",
      "cli_auth_credentials_store=file",
      "app-server",
      "--enable",
      "realtime_conversation",
    ]);
    expect(captured.options?.env?.CODEX_HOME).toBe(codexHome);
    expect(captured.options?.detached).toBeTrue();
    expect(server.requests.some((request) => request.method === "thread/resume")).toBeTrue();
    const resume = server.requests.find((request) => request.method === "thread/resume");
    expect(resume?.params).toMatchObject({
      config: {
        mcp_servers: {
          viewer: { enabled: true, default_tools_approval_mode: "approve" },
          playwright: { enabled: false },
          "telegram-readonly": { enabled: false },
        },
        features: { apps: false, plugins: false },
        include_apps_instructions: false,
      },
    });
    await host.release();
  });

  test("a Codex re-host reconstructs the full Viewer stdio MCP connector", async () => {
    const server = new FakeAppServer("viewer-rehost-thread");
    const captured: { options?: SpawnOptionsWithoutStdio } = {};
    server.mcpServers = {
      viewer: {
        command: "bun",
        args: ["bin/mcp-server.mjs"],
        env: { LLV_STATE_DIR: "fixture-state" },
        enabled: true,
        default_tools_approval_mode: "prompt",
      },
      unrelated: { command: "unrelated-mcp", enabled: true },
    };
    const host = await CodexAppServerHost.adopt("viewer-rehost-thread", {
      cwd: "/repo",
      mcpServers: ["viewer"],
      env: {
        NODE_ENV: "test",
        LLV_STATE_DIR: "fixture-state",
        LLV_VIEWER_DEPLOY_TARGET: "fixture-target",
        LLV_VIEWER_PORT: "8898",
      },
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server, captured),
    });

    /* The re-hosted agent runs under its own state root; the Viewer MCP
       connector below is what keeps the real one, so the link still resolves
       this machine's release (#1905). */
    expect(captured.options?.env).toMatchObject({
      XDG_CONFIG_HOME: path.join(os.tmpdir(), "llv-spawn-sandbox", "default", "config"),
      LLV_STATE_DIR: path.join(os.tmpdir(), "llv-spawn-sandbox", "default", "config", "agent-log-viewer", "state"),
      LLV_VIEWER_DEPLOY_TARGET: "fixture-target",
      LLV_VIEWER_PORT: "8898",
    });
    expect(server.requests.find((request) => request.method === "thread/resume")?.params).toMatchObject({
      config: {
        mcp_servers: {
          viewer: {
            command: "bun",
            args: ["bin/mcp-server.mjs"],
            env: { LLV_STATE_DIR: process.env.LLV_STATE_DIR },
            enabled: true,
            default_tools_approval_mode: "approve",
          },
          unrelated: { enabled: false },
        },
      },
    });
    await host.release();
  });

  test("rejects a resume response for a different durable thread", async () => {
    const server = new FakeAppServer("server-default", "different-thread");
    const eventStore = new MemoryEventStore();
    eventStore.append("requested-thread", { kind: "session-status", status: "idle", seq: 1 });
    await expect(CodexAppServerHost.adopt("requested-thread", {
      cwd: "/repo",
      eventStore,
      initialEventCursor: 1,
      spawnProcess: fakeSpawn(server),
      ...ownedFakeProcess,
    })).rejects.toThrow("thread/resume returned a different thread id");
    expect(server.signals).toContain("SIGTERM");
    expect(eventStore.load("requested-thread")).toEqual([
      { kind: "session-status", status: "idle", seq: 1 },
    ]);
  });

  test("cold cleaner resume binds the old thread to a fresh workspace after old scratch cleanup", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "llv-cleaner-resume-"));
    const oldScratch = path.join(parent, "old-scratch");
    const newCwd = path.join(parent, "new-scratch", "cwd");
    fs.mkdirSync(oldScratch, { recursive: true });
    fs.mkdirSync(newCwd, { recursive: true });
    fs.rmSync(oldScratch, { recursive: true });
    const server = new FakeAppServer("cleaner-cold-thread");
    const host = await CodexAppServerHost.adopt("cleaner-cold-thread", {
      cwd: newCwd, cleanerDiskWorkspace: true, eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(server),
    });
    try {
      const request = server.requests.find(row => row.method === "thread/resume")!;
      expect(request.params).toMatchObject({ cwd: newCwd });
      expect(fs.existsSync(oldScratch)).toBeFalse();
      expect(fs.existsSync(newCwd)).toBeTrue();
    } finally { await host.release(); fs.rmSync(parent, { recursive: true, force: true }); }
  });

  test("rejects a cleaner resume when Codex reports the previous workspace", async () => {
    const server = new FakeAppServer("cleaner-stale-thread");
    server.threadCwdOverride = "/retired/cleaner/scratch";
    await expect(CodexAppServerHost.adopt("cleaner-stale-thread", {
      cwd: "/current/cleaner/scratch/cwd", cleanerDiskWorkspace: true,
      eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(server),
    })).rejects.toThrow("thread/resume did not adopt the cleaner workspace cwd");
  });

  test("rebuilds replay from resume history when a legacy host has no event ledger", async () => {
    const server = new FakeAppServer("history-thread", "history-thread", false, [{
      id: "history-turn",
      status: "completed",
      items: [{ type: "agentMessage", text: "persisted" }],
    }]);
    const host = await CodexAppServerHost.adopt("history-thread", {
      cwd: "/repo",
      initialEventCursor: 5,
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });
    const replay = host.attach(5)[Symbol.asyncIterator]();
    expect((await replay.next()).value).toEqual({ kind: "turn-started", turnId: "history-turn", seq: 6 });
    expect((await replay.next()).value).toEqual({
      kind: "item",
      turnId: "history-turn",
      item: { type: "agentMessage", text: "persisted" },
      phase: "completed",
      seq: 7,
    });
    expect((await replay.next()).value).toEqual({ kind: "turn-ended", turnId: "history-turn", status: "completed", seq: 8 });
    expect(() => host.attach(0)).toThrow("runtime replay begins at sequence 6");
    await host.release();
  });

  test.each([false, true])("overlapping first-delivery retries start one Codex turn per launch (first dispatch: %s)", async (firstDispatch) => {
    const server = new FakeAppServer("launch-retry-thread");
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });
    const entry = { id: "spawn_launch_retry", text: "apply the approved change" };
    const evidence = firstDispatch ? { operationId: entry.id, writerClaim: "launch-writer", firstDispatch: true as const } : undefined;
    try {
      const receipts = await Promise.all([host.send(entry, evidence), host.send(entry, evidence), host.send(entry, evidence)]);
      expect(server.requests.filter(request => request.method === "turn/start" || request.method === "turn/steer"))
        .toHaveLength(1);
      for (const receipt of receipts) expect(receipt).toEqual({ outcome: "turn-started", turnId: "turn-1" });
      expect(await host.send(entry)).toEqual(receipts[0]);
    } finally {
      await host.release();
    }
  });

  test("a launch retry awaiting its first user echo neither steers nor accepts another payload", async () => {
    const server = new FakeAppServer("launch-echo-thread");
    server.autoCompleteUserMessage = false;
    const host = await CodexAppServerHost.start({
      cwd: "/repo", eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(server),
    });
    const entry = { id: "spawn_launch_echo", text: "apply the approved change" };
    const first = host.send(entry);
    const requests = () => server.requests.filter(request => request.method === "turn/start" || request.method === "turn/steer");
    try {
      await waitForCondition(() => requests().length > 0, "first turn never started");
      const retry = host.send(entry);
      await expect(host.send({ ...entry, text: "another instruction" })).rejects.toThrow("different payload");
      await Bun.sleep(10);
      server.notify("item/completed", {
        threadId: "launch-echo-thread", turnId: "turn-1",
        item: { type: "userMessage", clientId: entry.id, content: (requests()[0].params as { input: unknown }).input },
      });
      expect(await first).toEqual({ outcome: "turn-started", turnId: "turn-1" });
      expect(await retry).toEqual(await first);
      expect(requests()).toHaveLength(1);
    } finally {
      await host.release();
      await first.catch(() => {});
    }
  });

  test("an uncertain first turn start refuses launch retries without a second engine write", async () => {
    const server = new FakeAppServer("launch-timeout-thread", "launch-timeout-thread", false, [], undefined, null, ["turn/start"]);
    const host = await CodexAppServerHost.start({
      cwd: "/repo", eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(server), requestTimeoutMs: 10,
    });
    const entry = { id: "spawn_launch_timeout", text: "apply the approved change" };
    try {
      const results = await Promise.allSettled([host.send(entry), host.send(entry)]);
      expect(results.map(result => result.status)).toEqual(["rejected", "rejected"]);
      for (const result of results) {
        if (result.status === "rejected") expect(String(result.reason)).toContain("outcome is uncertain");
      }
      expect(await host.send(entry)).toEqual({ outcome: "rejected", reason: "dead-host" });
      expect(server.requests.filter(request => request.method === "turn/start" || request.method === "turn/steer"))
        .toHaveLength(1);
    } finally {
      await host.release();
    }
  });

  test("confirms a retried queue entry from its persisted client id", async () => {
    const server = new FakeAppServer("delivery-thread", "delivery-thread");
    server.readTurns = [{
      id: "persisted-turn",
      status: "completed",
      items: [{ type: "userMessage", clientId: "operation-recovered", content: [{ type: "text", text: "hello" }] }],
    }];
    const host = await CodexAppServerHost.adopt("delivery-thread", {
      cwd: "/repo",
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });

    expect(await host.send({ id: "operation-recovered", text: "hello" })).toEqual({
      outcome: "turn-started",
      turnId: "persisted-turn",
    });
    expect(server.requests.some((request) => request.method === "turn/start" || request.method === "turn/steer")).toBeFalse();
    await host.release();
  });

  test("delivery success with a lost confirmation and repeated respawns writes one recipient user record (#1366)", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-recipient-dedup-"));
    const transcriptPath = path.join(directory, "delivery-thread.jsonl");
    fs.writeFileSync(transcriptPath, "");
    const entry = { id: "operation-recipient-dedup", text: "apply the approved change" };
    const servers: FakeAppServer[] = [];
    let confirmationTimeouts = 0;
    const deliver = async (start: boolean): Promise<void> => {
      const server = new FakeAppServer("delivery-thread", "delivery-thread");
      server.threadPath = transcriptPath;
      server.persistUserMessages = true;
      server.autoCompleteUserMessage = false;
      servers.push(server);
      const options = {
        cwd: "/repo",
        eventStore: new MemoryEventStore(),
        spawnProcess: fakeSpawn(server),
        deliveryConfirmationTimeoutMs: 5,
        shutdownGraceMs: 1,
      };
      const host = start
        ? await CodexAppServerHost.start(options)
        : await CodexAppServerHost.adopt("delivery-thread", options);
      try {
        await host.send(entry);
      } catch (error) {
        expect(String(error)).toContain("delivery confirmation timed out");
        confirmationTimeouts += 1;
      } finally {
        await host.release();
      }
    };

    try {
      await deliver(true);
      for (let retry = 0; retry < 3; retry += 1) await deliver(false);
      const userRecords = fs.readFileSync(transcriptPath, "utf8").trim().split("\n")
        .map((line) => JSON.parse(line) as { payload?: { type?: string } })
        .filter((record) => record.payload?.type === "user_message");
      expect(userRecords).toHaveLength(1);
      expect(confirmationTimeouts).toBe(1);
      expect(servers.flatMap((server) => server.requests)
        .filter((request) => request.method === "turn/start" || request.method === "turn/steer"))
        .toHaveLength(1);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("an unreadable recipient transcript cannot authorize a redelivery (#1366)", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-recipient-dedup-unreadable-"));
    const transcriptPath = path.join(directory, "delivery-thread.jsonl");
    fs.symlinkSync(path.basename(transcriptPath), transcriptPath);
    const server = new FakeAppServer("delivery-thread");
    server.threadPath = transcriptPath;
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });
    try {
      await expect(host.send({ id: "operation-unreadable-dedup", text: "deliver once" }))
        .rejects.toThrow("recipient transcript is unavailable for delivery deduplication");
      expect(server.requests.some((request) => request.method === "turn/start" || request.method === "turn/steer"))
        .toBeFalse();
    } finally {
      await host.release();
      fs.unlinkSync(transcriptPath);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a malformed recipient dedup record cannot authorize a redelivery (#1366)", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-recipient-dedup-malformed-"));
    const transcriptPath = path.join(directory, "delivery-thread.jsonl");
    const operationId = "operation-malformed-dedup";
    fs.writeFileSync(
      transcriptPath,
      `{"payload":{"type":"user_message","message":"<!-- llv:structured-user dedup=${deliveryDedup(operationId)} -->\\n`,
    );
    const server = new FakeAppServer("delivery-thread");
    server.threadPath = transcriptPath;
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });
    try {
      await expect(host.send({ id: operationId, text: "deliver once" }))
        .rejects.toThrow("recipient transcript is unavailable for delivery deduplication");
      expect(server.requests.some((request) => request.method === "turn/start" || request.method === "turn/steer"))
        .toBeFalse();
    } finally {
      await host.release();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("recipient dedup finds a delivered operation before the bounded turn tail (#1366)", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-recipient-dedup-prefix-"));
    const transcriptPath = path.join(directory, "delivery-thread.jsonl");
    const operationId = "operation-before-rollout-tail";
    const text = "already delivered before a large transcript tail";
    const delivered = JSON.stringify({
      timestamp: "t1",
      type: "event_msg",
      payload: {
        type: "user_message",
        message: await encodeCodexStructuredUserText(text, undefined, null, null, deliveryDedup(operationId)),
      },
    });
    const filler = JSON.stringify({
      timestamp: "t2",
      type: "event_msg",
      payload: { type: "agent_message", message: "x".repeat(16 * 1024 * 1024 + 1024) },
    });
    fs.writeFileSync(transcriptPath, `${delivered}\n${filler}\n`);
    const server = new FakeAppServer("delivery-thread", "delivery-thread");
    server.threadPath = transcriptPath;
    server.hydratedReadError = "list_turns is not supported yet";
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });
    try {
      expect(await host.send({ id: operationId, text })).toEqual({
        outcome: "turn-started",
        turnId: operationId,
      });
      expect(server.requests.some((request) => request.method === "turn/start" || request.method === "turn/steer"))
        .toBeFalse();
    } finally {
      await host.release();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a compact record whose metadata is gone costs only that record, never the rollout", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-recipient-dedup-lost-metadata-"));
    const transcriptPath = path.join(directory, "delivery-thread.jsonl");
    const metadataDirectory = path.join(metadataState, "structured-user-metadata");
    const userRecord = (message: string) => JSON.stringify({ timestamp: "t1", type: "event_msg", payload: { type: "user_message", message } });
    const lost = { id: "operation-lost-metadata", text: "delivered under another state directory" };
    const kept = { id: "operation-kept-metadata", text: "delivered under this state directory" };
    const lostWire = await encodeCodexStructuredUserText(lost.text, undefined, COMPACT_SELECTED, { kind: "operator" }, deliveryDedup(lost.id));
    for (const file of fs.readdirSync(metadataDirectory)) fs.unlinkSync(path.join(metadataDirectory, file));
    const keptWire = await encodeCodexStructuredUserText(kept.text, undefined, COMPACT_SELECTED, { kind: "operator" }, deliveryDedup(kept.id));
    fs.writeFileSync(transcriptPath, `${userRecord(lostWire)}\n${userRecord(keptWire)}\n`);
    const server = new FakeAppServer("delivery-thread", "delivery-thread");
    server.threadPath = transcriptPath;
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });
    const writes = () => server.requests.filter((request) => request.method === "turn/start" || request.method === "turn/steer");
    try {
      expect(() => rolloutTurnsFromDisk(transcriptPath)).not.toThrow();
      expect(await host.send(kept)).toEqual({ outcome: "turn-started", turnId: kept.id });
      expect(writes()).toHaveLength(0);
      /* Its payload cannot be proven, so it cannot authorize a second write. */
      await expect(host.send(lost)).rejects.toThrow("belongs to a different payload");
      expect(writes()).toHaveLength(0);
      expect(await host.send({ id: "operation-after-lost-metadata", text: "a new message" }))
        .toMatchObject({ outcome: "turn-started" });
      expect(writes()).toHaveLength(1);
    } finally {
      await host.release();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a rollout written under state directory A still reads from state directory B", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-rollout-state-ab-"));
    const transcriptPath = path.join(directory, "rollout.jsonl");
    const wire = await encodeCodexStructuredUserText("hello from A", undefined, COMPACT_SELECTED, { kind: "agent", role: "orchestrator" }, deliveryDedup("operation-state-a"));
    const item = { type: "userMessage", id: "user-a", content: [{ type: "text", text: wire }] };
    fs.writeFileSync(transcriptPath, [
      { payload: { type: "user_message", message: wire } },
      { payload: { type: "item_completed", turn_id: "turn-a", item } },
      { payload: { type: "task_complete", turn_id: "turn-a" } },
    ].map((line) => JSON.stringify(line)).join("\n") + "\n");
    const stateB = fs.mkdtempSync(path.join(os.tmpdir(), "llv-host-metadata-b-"));
    process.env.LLV_STATE_DIR = stateB;
    try {
      expect(rolloutTurnsFromDisk(transcriptPath)).toMatchObject([{ id: "turn-a", items: [{ id: "user-a" }] }]);
    } finally {
      process.env.LLV_STATE_DIR = metadataState;
      fs.rmSync(stateB, { recursive: true, force: true });
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test.each([false, true])("a bounded tail starting inside a marker-bearing record preserves send dedup (already delivered: %s)", async (alreadyDelivered) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-tail-boundary-"));
    const transcriptPath = path.join(directory, "delivery-thread.jsonl");
    const operationId = "operation-tail-boundary";
    const text = "retain exact recipient ownership";
    const delivered = JSON.stringify({ type: "event_msg", payload: {
      type: "user_message",
      message: await encodeCodexStructuredUserText(text, undefined, null, null, deliveryDedup(operationId)),
    } });
    // The 16 MiB tail starts inside this complete, valid tool record. Its
    // quoted marker is ordinary tool output, not a corrupt recipient message.
    const tool = JSON.stringify({ type: "response_item", payload: {
      type: "function_call_output", output: "x".repeat(2 * 1024 * 1024) + " llv:structured-user quoted source",
    } });
    const filler = JSON.stringify({ type: "event_msg", payload: {
      type: "agent_message", message: "x".repeat(15 * 1024 * 1024),
    } });
    fs.writeFileSync(transcriptPath, `${alreadyDelivered ? delivered + "\n" : ""}${tool}\n${filler}\n`);
    const server = new FakeAppServer("delivery-thread", "delivery-thread");
    server.threadPath = transcriptPath;
    server.hydratedReadError = "list_turns is not supported yet";
    const host = await CodexAppServerHost.start({
      cwd: "/repo", eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(server),
    });
    try {
      expect(await host.send({ id: operationId, text })).toEqual({
        outcome: "turn-started", turnId: alreadyDelivered ? operationId : "turn-1",
      });
      expect(server.requests.filter((request) => request.method === "turn/start" || request.method === "turn/steer"))
        .toHaveLength(alreadyDelivered ? 0 : 1);
    } finally {
      await host.release();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a malformed marker-bearing record crossing the tail boundary still refuses delivery", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-tail-corrupt-"));
    const transcriptPath = path.join(directory, "delivery-thread.jsonl");
    const corrupt = "x".repeat(2 * 1024 * 1024) + " llv:structured-user malformed record";
    const filler = JSON.stringify({ type: "event_msg", payload: {
      type: "agent_message", message: "x".repeat(15 * 1024 * 1024),
    } });
    fs.writeFileSync(transcriptPath, `${corrupt}\n${filler}\n`);
    const server = new FakeAppServer("delivery-thread", "delivery-thread");
    server.threadPath = transcriptPath;
    const host = await CodexAppServerHost.start({
      cwd: "/repo", eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(server),
    });
    try {
      await expect(host.send({ id: "operation-corrupt-tail", text: "deliver once" }))
        .rejects.toThrow("recipient transcript is unavailable for delivery deduplication");
      expect(server.requests.some((request) => request.method === "turn/start" || request.method === "turn/steer"))
        .toBeFalse();
    } finally {
      await host.release();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("keeps a send pending until the matching user item is persisted", async () => {
    const server = new FakeAppServer("confirm-after-rpc");
    server.autoCompleteUserMessage = false;
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });

    let settled = false;
    let started!: () => void;
    const requestStarted = new Promise<void>(resolve => { started = resolve; });
    const onRequest = (message: Record<string, unknown>) => { if (message.method === "turn/start") started(); };
    server.on("client-request", onRequest);
    const delivery = host.send({ id: "operation-confirmed", text: "hello" })
      .finally(() => { settled = true; });
    try {
      await Promise.race([requestStarted, delivery.then(() => { throw new Error("delivery settled before its native request"); })]);
      expect(server.requests.some((request) => request.method === "turn/start")).toBeTrue();
      expect(settled).toBeFalse();

      server.notify("item/completed", {
        threadId: "confirm-after-rpc",
        turnId: "turn-1",
        item: {
          type: "userMessage",
          clientId: "operation-confirmed",
          content: [{ type: "text", text: "hello" }],
        },
      });

      expect(await delivery).toEqual({ outcome: "turn-started", turnId: "turn-1" });
    } finally {
      server.off("client-request", onRequest);
      await host.release();
      await delivery.catch(() => undefined);
    }
  });

  test("rejects a persisted client id whose user-message text differs", async () => {
    const server = new FakeAppServer("delivery-collision-thread", "delivery-collision-thread");
    server.readTurns = [{
      id: "persisted-turn",
      status: "completed",
      items: [{ type: "userMessage", clientId: "operation-collision", content: [{ type: "text", text: "original" }] }],
    }];
    const host = await CodexAppServerHost.adopt("delivery-collision-thread", {
      cwd: "/repo",
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });

    await expect(host.send({ id: "operation-collision", text: "changed" }))
      .rejects.toThrow("Codex queue entry id belongs to a different payload");
    expect(server.requests.some((request) => request.method === "turn/start" || request.method === "turn/steer")).toBeFalse();
    await host.release();
  });

  test.each(["0.144.1", "0.154.0"])("starts the first delivery when Codex %s reports an unmaterialized thread", async (version) => {
    const server = new FakeAppServer("fresh-delivery-thread");
    server.userAgent = `codex_desktop_app/${version} (Linux)`;
    server.readError = "thread fresh-delivery-thread is not materialized yet; includeTurns is unavailable before first user message";
    if (version === "0.154.0") {
      server.turnsError = server.readError.replace("includeTurns", "thread/turns/list");
      server.readError = null;
    }
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });

    expect(await host.send({ id: "operation-first", text: "hello" })).toEqual({
      outcome: "turn-started",
      turnId: "turn-1",
    });
    await host.release();
  });
});
