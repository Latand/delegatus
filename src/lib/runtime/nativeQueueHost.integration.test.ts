import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexAppServerHost } from "./codexAppServerHost";
import { FileRuntimeEventStore } from "./eventStore";
import { RuntimeJournal } from "@/runtime-host/journal";
import type { RuntimeHostClient } from "./client";
import type { NativeQueueCommand } from "./nativeQueueContracts";
import { NativeQueueExecutor } from "./nativeQueueExecutor";
import { StructuredDeliveryQueue } from "./structuredDeliveryQueue";
import { parseRuntimeCommand } from "./commands";

const binary = process.env.NATIVE_CODEX_QUEUE_TEST_BINARY;

for (const scenario of ["small", "large", "two-image-turns"]) test.skipIf(!binary)(`native runtime: queue edits, canonical dispatch, lost reply and cold recovery (${scenario})`, async () => {
  const largeImages = scenario !== "small";
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "nh-"));
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", NODE_ENV: "test" };
  for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "GEMINI_CLI_HOME", "LLV_STATE_DIR", "TMPDIR"]) {
    env[key] = path.join(base, key.toLowerCase()); fs.mkdirSync(env[key]!);
  }
  const cwd = path.join(base, "workspace"); fs.mkdirSync(cwd);
  const smallPng = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63f8cfc0f01f00050001ff89993d1d0000000049454e44ae426082", "hex");
  const png = largeImages ? Buffer.concat([smallPng, Buffer.alloc(3 * 1024 * 1024 - smallPng.length)]) : smallPng;
  const imagePath = path.join(base, "fixture.png"); fs.writeFileSync(imagePath, png);
  const imageRef = { sha256: createHash("sha256").update(png).digest("hex"), mime: "image/png" as const, bytes: png.length };
  const imagePaths = new Map([[imageRef.sha256, imagePath]]);
  const imageRefs = largeImages ? Array.from({length: 4}, (_, index) => {
    const bytes = Buffer.concat([smallPng, Buffer.alloc(3 * 1024 * 1024 - smallPng.length, index)]);
    const ref = {sha256: createHash("sha256").update(bytes).digest("hex"), mime: "image/png" as const, bytes: bytes.length};
    const filename = path.join(base, `fixture-${index}.png`);
    fs.writeFileSync(filename, bytes);
    imagePaths.set(ref.sha256, filename);
    return ref;
  }) : [imageRef];
  const responses: ServerResponse[] = [];
  const backend = createServer((request, response) => {
    request.resume(); response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write('event: response.created\ndata: {"type":"response.created","response":{"id":"fixture-response"}}\n\n');
    responses.push(response);
  });
  await new Promise<void>(resolve => backend.listen(0, "127.0.0.1", resolve));
  const address = backend.address(); if (!address || typeof address === "string") throw new Error("fixture bind failed");
  fs.writeFileSync(path.join(env.CODEX_HOME!, "config.toml"), `model = "fixture-model"
model_provider = "fixture"
approval_policy = "never"
sandbox_mode = "danger-full-access"
web_search = "disabled"
[model_providers.fixture]
name = "Runtime integration fixture"
base_url = "http://127.0.0.1:${address.port}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
[analytics]
enabled = false
[features]
apps = false
plugins = false
`);
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  /** What each spawned CLI did when it went away, for the wait that outlived it. */
  const exits: string[] = [];
  /** The tail of what each CLI said on the way out. Unread, this pipe fills at
   *  64 KiB and the child blocks inside a write — which is a fixture that stops
   *  the process it is testing, and a child exit with no reason to report. */
  const diagnostics: string[] = [];
  let liveChildren = 0;
  let dropAdd = false;
  let hideCanonicalClient: string | null = null;
  // Only authentication/catalog projection is synthetic. Queue, history,
  // native IDs, dispatch and persistence execute in the real installed CLI.
  const spawnProcess = (_command: string, args: string[]) => {
    const child = spawn(binary!, args, { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    liveChildren++;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      diagnostics.push(chunk);
      while (diagnostics.length > 64) diagnostics.shift();
    });
    const input = new PassThrough(); const output = new PassThrough();
    const methods = new Map<number, string>();
    const inbound = createInterface({ input });
    inbound.on("line", line => {
      const message = JSON.parse(line); if (typeof message.id === "number") methods.set(message.id, message.method);
      if (message.method) requests.push({ method: message.method, params: message.params ?? {} });
      child.stdin.write(line + "\n");
    });
    input.on("finish", () => child.stdin.end());
    const outbound = createInterface({ input: child.stdout });
    outbound.on("line", line => {
      const message = JSON.parse(line); const method = methods.get(message.id);
      if (method === "account/read") message.result = { account: { type: "chatgpt", planType: "fixture" }, requiresOpenaiAuth: false };
      if (method === "model/list") message.result = { data: [{ id: "fixture-model", model: "fixture-model", isDefault: true, inputModalities: ["text", "image"], supportedReasoningEfforts: [{ reasoningEffort: "high" }] }] };
      if (method === "thread/queue/add" && dropAdd) return;
      if (method === "thread/items/list" && hideCanonicalClient && Array.isArray(message.result?.data)) {
        message.result.data = message.result.data.filter((entry: { item?: { clientId?: string } }) => entry.item?.clientId !== hideCanonicalClient);
      }
      if (method === "thread/turns/list" && hideCanonicalClient && Array.isArray(message.result?.data)) {
        for (const turn of message.result.data) {
          if (Array.isArray(turn.items)) turn.items = turn.items.filter((item: {clientId?: string}) => item.clientId !== hideCanonicalClient);
        }
      }
      output.write(JSON.stringify(message) + "\n");
    });
    child.once("close", (code, signal) => {
      liveChildren--;
      exits.push(`pid ${child.pid ?? "?"} code=${code} signal=${signal}`);
      inbound.close(); outbound.close(); output.end();
    });
    return new Proxy(child, { get(target, property) {
      if (property === "stdin") return input;
      if (property === "stdout") return output;
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } }) as ChildProcessWithoutNullStreams;
  };
  /* The fixture CLI never runs a command: its model backend answers with a
     message and nothing else. Asking for a sandboxed thread anyway makes this
     case depend on a Linux sandbox helper the runner does not install, and the
     child exits when a path reaches for it (#1715) — a failure that has
     nothing to do with the contracts under test. The dependency is removed
     rather than satisfied, and the mode named here is the one the Viewer's own
     spawn path already asks for in production. */
  const options = { cwd, binary, codexHome: env.CODEX_HOME, env, model: "fixture-model", sandbox: "danger-full-access",
    /* The background-history case uses the production timeout. The other two
       inject a lost acknowledgement, and the host's request budget is what
       ends that one deliberately unanswered request — it is spent exactly
       once per case. It has to be wide, because every other request under it
       is a legitimate reply from the real CLI: a 3 MiB queue add and a cold
       `thread/resume` come back in a small fraction of this budget on an idle
       machine and in a large multiple of that fraction on a contended one,
       and the old one second was near enough to the CLI's own cost that a
       slow runner could turn a delivered add into the injected fault. Nothing
       asserts how long any of this took; only a genuinely unanswered request
       reaches the budget below. */
    ...(scenario === "two-image-turns" ? {} : {requestTimeoutMs: 15_000}),
    eventStore: new FileRuntimeEventStore(path.join(base, "events")), resolveImagePath: (image: {sha256: string}) => imagePaths.get(image.sha256)!, spawnProcess };
  let host: CodexAppServerHost | undefined;
  const journal = new RuntimeJournal(path.join(base, "journal.sqlite"), { structuredHosts: true });
  /* Every wait below is on a real Codex CLI doing real work in another
     process, so this budget is real time and cannot be anything else. It is
     generous on purpose: nothing in this case asserts how long the CLI took,
     and the budget exists only so a wedge fails readably instead of hanging
     the job. The old five seconds was small enough that a loaded runner
     decided the verdict; this one names the wait and what the child did, so a
     failure here is a diagnosis rather than another unattributable red round. */
  const nativeWaitMs = 60_000;
  const cliSaid = () => diagnostics.length ? `\nwhat the CLI said:\n${diagnostics.join("")}` : "";
  async function until(predicate: () => boolean | Promise<boolean>) {
    /* The budget bounds the wait, not the gap between two polls. A predicate
       that drains the delivery queue against a host whose child has gone can
       hang inside a single call, and a deadline checked between calls is then
       never reached at all — which is how this case used to spend its whole
       test budget and report nothing about why. */
    let expire: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      expire = setTimeout(() => reject(new Error(
        `native fixture deadline: ${nativeWaitMs} ms waiting for ${predicate}`
        + (exits.length ? `; CLI exits: ${exits.join("; ")}` : "; no CLI has exited")
        + cliSaid())), nativeWaitMs);
    });
    const poll = (async () => {
      while (!await predicate()) {
        /* Every wait here is driven by a running CLI, and each one is entered
           with a generation started or adopted. None left alive means nothing
           can still move this predicate, so the budget is not worth spending. */
        if (liveChildren === 0) {
          throw new Error(`no Codex CLI is running under this fixture; exits: ${exits.join("; ") || "none recorded"}`
            + cliSaid());
        }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    })();
    try {
      await Promise.race([poll, deadline]);
    } finally {
      clearTimeout(expire);
      poll.catch(() => { /* a poll abandoned at the deadline reports through it */ });
    }
  }
  try {
    host = await CodexAppServerHost.start(options);
    expect(host.nativeQueue).toBeDefined();
    const threadId = host.identity.threadId;
    const binding = { threadId, accountId: "fixture-account" };
    const conversationId = "conversation_fixture";
    const publish = async () => {
      const health = await host!.health();
      journal.append({ scope: `session:${conversationId}`, kind: "session-status", payload: { conversationId,
        sessionKey: { engine: "codex", sessionId: threadId }, hostKind: "codex-app-server", host: "hosted",
        turn: health.activeTurnRef ? "running" : "idle", activeTurnId: health.activeTurnRef, accountId: binding.accountId,
        capabilities: { steer: true, nativeQueue: true, structuredAttention: true } } });
    };
    const client = { operationStatus: async (id: string) => journal.operationResult(id),
      nativeQueueRead: async (id: string) => journal.nativeQueueRead(id),
      nativeQueueTransition: async (id: string, t: Parameters<RuntimeJournal["nativeQueueTransition"]>[1]) => journal.nativeQueueTransition(id, t),
    } as RuntimeHostClient;
    const executor = new NativeQueueExecutor({ client, binding: () => binding, resolveHost: () => host! });
    const admit = async (id: string, extra: Partial<NativeQueueCommand>) => {
      await publish();
      const command = parseRuntimeCommand("native-queue", { conversationId, operationId: id, idempotencyKey: id, binding, action: "add", text: "queued native input", ...extra }) as NativeQueueCommand & { operationId: string };
      expect(journal.executeOperation(command).receipt.status).toBe("queued");
      await executor.execute(command); return journal.nativeQueueRead(conversationId).find(e => e.entryId === (extra.entryId ?? id))!;
    };
    if (scenario === "two-image-turns") {
      for (const [index, id] of ["image-one", "image-two"].entries()) {
        await admit(id, {images: imageRefs});
        if (index === 1) await admit(`start-${id}`, {action: "start", entryId: id, expectedRevision: 1, turnId: null});
        await until(() => responses.length === index + 1);
        await host.interrupt((await host.health()).activeTurnRef!);
        await until(async () => (await host!.health()).activeTurnRef === null);
      }
      // Both accepted image turns exist before the first background read.
      // A full turns page would aggregate them into an oversized host frame.
      await until(async () => {
        await executor.reconcile(conversationId);
        return journal.nativeQueueRead(conversationId).every(entry => entry.state === "delivered");
      });
      expect((await host.health()).status).toBe("idle");
      expect(journal.nativeQueueRead(conversationId)).toHaveLength(2);
      expect(responses).toHaveLength(2);
      return;
    }
    // Idle add auto-dispatches under the native owner.
    const active = await admit("active-native", {});
    expect(active.state).toBe("queued");
    await until(() => responses.length === 1);
    await until(async () => { await executor.reconcile(conversationId); return journal.nativeQueueRead(conversationId)[0]?.state === "delivered"; });
    expect(active.proof).toBeNull(); // The mutation acknowledgement itself proves no delivery.
    const a = await admit("queued-native", { images: imageRefs });
    expect(a.reason).toBeNull();
    expect(a.nativeSubmissionId).toBeTruthy();
    if (largeImages) {
      await admit("second-large-native", {images: imageRefs});
      const inventory = await host.nativeQueue!.queue.refresh();
      expect(inventory.items).toHaveLength(2);
      expect((await host.health()).status).toBe("active");
      await admit("remove-second-large", {action: "delete", entryId: "second-large-native", expectedRevision: 1});
    }
    const edited = await admit("edit-native", { action: "update", entryId: a.entryId, expectedRevision: 1, text: "edited Привіт 🌍", images: imageRefs });
    expect(edited.versions.map(v => v.text)).toEqual(["queued native input", "edited Привіт 🌍"]);
    expect((await host.nativeQueue!.queue.refresh()).items?.find(i => i.id === a.nativeSubmissionId)?.input).toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("edited Привіт") })]));
    const turn = (await host.health()).activeTurnRef!;
    await host.interrupt(turn); await until(async () => (await host!.health()).activeTurnRef === null);
    hideCanonicalClient = a.clientUserMessageId;
    await admit("start-native", { action: "start", entryId: a.entryId, expectedRevision: 2, turnId: null });
    await executor.reconcile(conversationId);
    expect(journal.nativeQueueRead(conversationId).find(e => e.entryId === a.entryId)?.state).toBe("dispatching");
    expect(journal.nativeQueueRead(conversationId).find(e => e.entryId === a.entryId)?.proof).toBeNull();
    hideCanonicalClient = null;
    await until(async () => { await executor.reconcile(conversationId); return journal.nativeQueueRead(conversationId).find(e => e.entryId === a.entryId)?.state === "delivered"; });
    expect(journal.nativeQueueRead(conversationId).find(e => e.entryId === a.entryId)?.dispatchedRevision).toBe(2);
    dropAdd = true;
    const lost = await admit("lost-native", largeImages ? {images: imageRefs} : {});
    expect(lost.state).toBe("uncertain");
    expect((await host.health()).status).toBe("active");
    const adds = requests.filter(r => r.method === "thread/queue/add").length;
    await host.release(); dropAdd = false;
    host = await CodexAppServerHost.adopt(threadId, options);
    await executor.reconcile(conversationId);
    expect(requests.filter(r => r.method === "thread/queue/add")).toHaveLength(adds);
    // A cold resume may dispatch the queued entry. A complete canonical read
    // must retain the original identity and never add it again.
    await until(async () => { await executor.reconcile(conversationId); return journal.nativeQueueRead(conversationId).find(e => e.entryId === lost.entryId)?.state === "delivered"; });
    const proof = journal.nativeQueueRead(conversationId).find(e => e.entryId === lost.entryId)?.proof;
    expect(proof?.clientUserMessageId).toBe("lost-native");
    expect(requests.some(r => r.method === "thread/turns/list")).toBeTrue();
    expect(requests.some(r => r.method === "thread/turns/list" && r.params.itemsView === "notLoaded")).toBeTrue();
    const recoveredState = await host.health();
    const recoveredTurn = recoveredState.activeTurnRef;
    if (!recoveredTurn) expect(recoveredState.status).toBe("idle");
    if (recoveredTurn) await host.interrupt(recoveredTurn);
    await until(async () => (await host!.health()).activeTurnRef === null);
    const delivery = new StructuredDeliveryQueue({
      effects: async () => journal.effectBatch(100, ["runtime.send"]),
      status: async id => journal.operationResult(id)?.receipt ?? null,
      hostClaim: async () => "fixture-owner:1",
      transition: async (id, status, details) => { journal.transitionOperation(id, status, details); },
    }, () => host!);
    const sendManaged = async (id: string, images = imageRefs, runtime?: NativeQueueCommand["runtime"]) => {
      await publish();
      const command = parseRuntimeCommand("send", {conversationId, operationId: id, idempotencyKey: id,
        text: "ordinary managed delivery", images, policy: "interrupt-active", ...(runtime ? {runtime} : {})});
      expect(journal.executeOperation(command).receipt.status).toBe("queued");
      const before = responses.length;
      await until(async () => {
        await delivery.drain();
        const receipt = journal.operationResult(id)?.receipt;
        if (receipt?.status === "failed" || receipt?.status === "uncertain") throw new Error(receipt.reason ?? receipt.status);
        return receipt?.status === "delivered";
      });
      expect(journal.operationResult(id)?.receipt.status).toBe("delivered");
      await until(() => responses.length === before + 1);
      await delivery.drain();
      expect(responses).toHaveLength(before + 1);
    };
    await sendManaged("profile-send", [], {model: "fixture-model", effort: "high", serviceTier: "default", serviceTierForTurn: "priority"});
    expect(requests.find(r => r.method === "turn/start" && r.params.clientUserMessageId === "profile-send")?.params).toMatchObject({ model: "fixture-model", effort: "high", serviceTier: "default", serviceTierForTurn: "priority" });
    if (largeImages) {
      await sendManaged("ordinary-images");
      expect(await host.sessionMaterializationEvidence("ordinary-images")).toEqual({state: "materialized"});
      // A new text send remains usable beyond the recovery read byte budget:
      // three distinct image turns now hold approximately 48 MiB of input.
      await sendManaged("fresh-after-images", []);
      expect((await host.health()).status).toBe("active");
    }
  } finally {
    await host?.release(); journal.close();
    for (const response of responses) response.end();
    backend.closeAllConnections(); await new Promise<void>(resolve => backend.close(() => resolve()));
  }
/* Three real Codex CLI generations, a real HTTP backend and up to 48 MiB of
   image input crossing them. The budget is explicit and generous for the same
   reason the wait above is: no assertion in this case is about elapsed time. */
}, 180_000);
