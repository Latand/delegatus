import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AccountContext } from "@/lib/accounts/contracts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-cloud-client-"));
const saved = { ...process.env };
beforeAll(() => { for (const name of ["HOME", "XDG_CONFIG_HOME", "TMPDIR", "LLV_STATE_DIR"]) { process.env[name] = path.join(root, name); fs.mkdirSync(process.env[name]!, { recursive: true }); } });
afterAll(() => { for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name]; Object.assign(process.env, saved); fs.rmSync(root, { recursive: true, force: true }); });

const { claudeCliSender, createClaudeCloudStageClient, sameClaudeModel } = await import("./cloudClaudeClient");
const { CloudSubmissionNotStartedError } = await import("./cloudHostedClient");
const { HostedCloudError } = await import("./cloudHostedErrors");
const { fakeClaudeCloud, sessionShellEnvironment } = await import("./claudeCloud.fixture");
const { setClaudeCloudTasks } = await import("@/lib/projects/settings");

const account: AccountContext = { engine: "claude", accountId: "account-a", kind: "managed", home: path.join(root, "account-a"), transcriptRoot: path.join(root, "account-a"), env: { NODE_ENV: "test" } };
const head = "a".repeat(40);
const controller = new AbortController();
const owned: ReturnType<typeof fakeClaudeCloud>[] = [];
afterEach(() => {
  for (const fake of owned.splice(0)) fake.stop();
  fs.rmSync(path.join(process.env.LLV_STATE_DIR!, "cloud", "claude-write-access.json"), { force: true });
});
const provider = (options: Parameters<typeof fakeClaudeCloud>[0] = {}) => { const fake = fakeClaudeCloud(options); owned.push(fake); return fake; };
const submitInput = (overrides: Record<string, unknown> = {}) => ({ environmentId: "task-1", environmentScope: { repository: "sample/project", ref: "main" }, branch: "pipeline/x", headSha: head,
  model: "opus", prompt: "Review the change.", reasoningEffort: "high", allowProviderModelFallback: false as const, account, signal: controller.signal, assertCurrent: () => undefined, ...overrides });
const access = (submitted: { taskId: string; thread?: { threadId: string; turnId: string } }) => ({ taskId: submitted.taskId, thread: submitted.thread, account, environmentId: "task-1", branch: "pipeline/x", headSha: head, signal: controller.signal, assertCurrent: () => undefined });
const prepare = (client: ReturnType<typeof createClaudeCloudStageClient>, project = "fixture-project") => client.prepareEnvironment!({ project, account, repository: "sample/project", ref: "main", signal: controller.signal, assertCurrent: () => undefined, model: "opus" });

test("a stage's input reaches the session after the write probe, on the login, in order, and its verdict is read back", async () => {
  const fake = provider();
  const client = createClaudeCloudStageClient(fake.dependencies);
  const parts = "x".repeat(70_000);
  const submitted = await client.submit(submitInput({ prompt: parts }));
  expect(submitted.taskId).toBe(fake.sessionId);
  expect(submitted.taskUrl).toBe("https://claude.ai/code/session_fixture0001");
  expect(fake.runCalls()).toBe(1);
  const run = fake.calls.find(call => call.path.endsWith("/run"))!;
  expect(run.path).toBe("/v1/code/triggers/task-1/run");
  expect(run.login).toBe("Bearer subscription-login-account-a");
  expect(run.organization).toBe("org-fixture");
  expect(fake.sent[0]).toStartWith("GitHub write probe");
  expect(fake.sent.slice(1, 3)).toEqual(["/model opus", "/effort high"]);
  const assignment = fake.sent.slice(3);
  expect(assignment).toHaveLength(1);
  expect(assignment.map(text => /^Input part (\d+)\/(\d+),/.exec(text)!.slice(1, 3).join("/"))).toEqual(assignment.map((_, index) => `${index + 1}/${assignment.length}`));
  expect(assignment.join("")).toContain("x".repeat(70_000));
  expect(assignment.at(-1)).toContain("git fetch origin pipeline/x && git checkout --detach " + head);
  const bound = access(submitted);
  expect(await client.poll(bound)).toEqual({ state: "completed", model: "claude-opus-5-5" });
  const final = await client.readFinalMessage(bound);
  expect(final.model).toBe("claude-opus-5-5");
  expect(final.message).toStartWith("All checked.");
  expect(final.message).not.toContain("Receipt");
  expect(sameClaudeModel(final.model, "opus")).toBe(true);
  expect(sameClaudeModel(final.model, "sonnet")).toBe(false);
  expect(sameClaudeModel("claude-opus-5-5", "claude-opus-5")).toBe(false);
});

test.each([
  ["start limit", 429, "cloud-limit", "start limit"],
  ["refused login", 401, "account-limit", "login was refused"],
  ["task missing", 404, "cloud-limit", "missing, paused or turned off"],
  ["task paused", 403, "cloud-limit", "missing, paused or turned off"],
])("%s proves no session and keeps its cause, with one run call", async (_name, status, category, cause) => {
  const fake = provider({ runAnswer: () => new Response("{}", { status: status as number, headers: { "retry-after": "120" } }) });
  const client = createClaudeCloudStageClient(fake.dependencies);
  const error = await client.submit(submitInput()).catch(failure => failure);
  expect(error).toBeInstanceOf(CloudSubmissionNotStartedError);
  expect(error.category).toBe(category);
  expect(error.message).toContain(cause);
  expect(fake.runCalls()).toBe(1);
  expect(fake.sent).toEqual([]);
});

test("a run that never connected proves nothing started, and a retry may make a new call", async () => {
  const fake = provider();
  const refused = Object.assign(new Error("connect failed"), { code: "ConnectionRefused" });
  const client = createClaudeCloudStageClient({ ...fake.dependencies, fetch: ((target: string | URL | Request, init?: RequestInit) =>
    String(target).endsWith("/run") ? Promise.reject(refused) : fake.dependencies.fetch!(target as string, init)) as typeof fetch });
  const error = await client.submit(submitInput()).catch(failure => failure);
  expect(error).toBeInstanceOf(CloudSubmissionNotStartedError);
  expect(error.category).toBe("unavailable");
});

test.each(["5xx", "2xx without a session id"])("%s: its own run is adopted only by the nonce in its events, with one run call", async kind => {
  const fake = provider({ runAnswer: () => {
    const nonce = (fake.calls.find(call => call.path.endsWith("/run"))!.body!.text as string).split("nonce ")[1]!;
    fake.open("session_foreign", "Run now from claude.ai");
    fake.open("session_own", `<routine-fire-payload>Delegatus stage run, nonce ${nonce}</routine-fire-payload>`);
    return kind === "5xx" ? new Response("{}", { status: 502 }) : Response.json({ queued: true });
  } });
  const client = createClaudeCloudStageClient(fake.dependencies);
  const submitted = await client.submit(submitInput());
  expect(submitted.taskId).toBe("session_own");
  expect(fake.runCalls()).toBe(1);
  expect(fake.sessions.get("session_foreign")!.events.every(event => !JSON.stringify(event).includes("write probe"))).toBe(true);
});

test("a foreign run alone is never adopted: the outcome stays unknown and nothing is sent", async () => {
  const fake = provider({ runAnswer: () => { fake.open("session_foreign", "Run now from claude.ai"); return new Response("{}", { status: 500 }); } });
  const client = createClaudeCloudStageClient(fake.dependencies);
  const error = await client.submit(submitInput()).catch(failure => failure);
  expect(error).toBeInstanceOf(HostedCloudError);
  expect(error).not.toBeInstanceOf(CloudSubmissionNotStartedError);
  expect(error.message).toContain("outcome is unknown");
  expect(fake.runCalls()).toBe(1);
  expect(fake.sent).toEqual([]);
});

test("two runs carrying the nonce adopt none", async () => {
  const fake = provider({ runAnswer: () => {
    const nonce = (fake.calls.find(call => call.path.endsWith("/run"))!.body!.text as string).split("nonce ")[1]!;
    fake.open("session_one", `nonce ${nonce}`); fake.open("session_two", `nonce ${nonce}`);
    return new Response("{}", { status: 503 });
  } });
  const error = await createClaudeCloudStageClient(fake.dependencies).submit(submitInput()).catch(failure => failure);
  expect(error.message).toContain("outcome is unknown");
  expect(fake.sent).toEqual([]);
});

test("a run whose prompt appears on a later read is adopted on that read", async () => {
  let reads = 0;
  const fake = provider({ runAnswer: () => { fake.open("session_late"); return new Response("{}", { status: 500 }); } });
  const base = fake.dependencies.fetch!;
  const client = createClaudeCloudStageClient({ ...fake.dependencies, fetch: (async (target: string, init?: RequestInit) => {
    if (String(target).includes("/session_late/events") && ++reads === 2) {
      const nonce = (fake.calls.find(call => call.path.endsWith("/run"))!.body!.text as string).split("nonce ")[1]!;
      fake.push("session_late", { type: "user", uuid: "prompt", message: { role: "user", content: `nonce ${nonce}` } });
    }
    return base(target, init);
  }) as typeof fetch });
  expect((await client.submit(submitInput())).taskId).toBe("session_late");
  expect(reads).toBeGreaterThanOrEqual(2);
  expect(fake.runCalls()).toBe(1);
});

const pendingRuns = (fake: ReturnType<typeof fakeClaudeCloud>, count: number) => { for (let n = 1; n <= count; n++) fake.open(`session_pending_${n}`); };
const nonceOf = (fake: ReturnType<typeof fakeClaudeCloud>) => (fake.calls.find(call => call.path.endsWith("/run"))!.body!.text as string).split("nonce ")[1]!;

test("runs still provisioning cannot hide the later run carrying the nonce: it is adopted with one run call and nothing reaches them", async () => {
  const fake = provider({ runAnswer: () => {
    pendingRuns(fake, 5);
    fake.open("session_own", `<routine-fire-payload>Delegatus stage run, nonce ${nonceOf(fake)}</routine-fire-payload>`);
    return new Response("{}", { status: 503 });
  } });
  const submitted = await createClaudeCloudStageClient(fake.dependencies).submit(submitInput());
  expect(submitted.taskId).toBe("session_own");
  expect(fake.runCalls()).toBe(1);
  for (let n = 1; n <= 5; n++) expect(fake.sessions.get(`session_pending_${n}`)!.events.some(event => JSON.stringify(event).includes("write probe"))).toBe(false);
});

test("a pending run stays a candidate after the window moves on, and is adopted once its prompt appears", async () => {
  const lateProof: { reads: number } = { reads: 0 };
  const fake = provider({ runAnswer: () => { pendingRuns(fake, 7); return new Response("{}", { status: 503 }); } });
  const base = fake.dependencies.fetch!;
  const client = createClaudeCloudStageClient({ ...fake.dependencies, fetch: (async (target: string, init?: RequestInit) => {
    /* The first run was read and passed over before its prompt arrived. */
    if (String(target).includes("/session_pending_1/events") && ++lateProof.reads === 2) fake.push("session_pending_1", { type: "user", uuid: "prompt", message: { role: "user", content: `nonce ${nonceOf(fake)}` } });
    return base(target, init);
  }) as typeof fetch });
  expect((await client.submit(submitInput())).taskId).toBe("session_pending_1");
  expect(lateProof.reads).toBeGreaterThanOrEqual(2);
  expect(fake.runCalls()).toBe(1);
});

test("two runs carrying the nonce in different windows adopt none", async () => {
  const fake = provider({ runAnswer: () => {
    fake.open("session_first", `nonce ${nonceOf(fake)}`);
    pendingRuns(fake, 5);
    fake.open("session_second", `nonce ${nonceOf(fake)}`);
    return new Response("{}", { status: 503 });
  } });
  const error = await createClaudeCloudStageClient(fake.dependencies).submit(submitInput()).catch(failure => failure);
  expect(error.message).toContain("outcome is unknown");
  expect(fake.sent).toEqual([]);
});

test("a lost list read adopts nothing until every listed run was read", async () => {
  let lists = 0;
  const fake = provider({ runAnswer: () => {
    fake.open("session_first", `nonce ${nonceOf(fake)}`);
    pendingRuns(fake, 5);
    fake.open("session_second", `nonce ${nonceOf(fake)}`);
    return new Response("{}", { status: 503 });
  } });
  const base = fake.dependencies.fetch!;
  const client = createClaudeCloudStageClient({ ...fake.dependencies, fetch: (async (target: string, init?: RequestInit) =>
    String(target).endsWith("/v1/code/sessions?trigger_id=task-1&limit=20") && ++lists === 2 ? new Response("{}", { status: 503 }) : base(target, init)) as typeof fetch });
  const error = await client.submit(submitInput()).catch(failure => failure);
  expect(lists).toBeGreaterThan(2);
  expect(error.message).toContain("outcome is unknown");
  expect(fake.sent).toEqual([]);
});

test("an assignment too big for one observed message is cut into ordered parts, each under the size seen to arrive whole", async () => {
  const fake = provider();
  const client = createClaudeCloudStageClient(fake.dependencies);
  await client.submit(submitInput({ prompt: "x".repeat(300_000) }));
  const assignment = fake.sent.slice(3);
  expect(assignment.length).toBeGreaterThan(2);
  expect(assignment.map(text => /^Input part (\d+)\/(\d+),/.exec(text)!.slice(1, 3).join("/"))).toEqual(assignment.map((_, index) => `${index + 1}/${assignment.length}`));
  expect(assignment.every(text => Buffer.byteLength(text) <= 129_939)).toBe(true);
});

test("a stage with no explicit effort sends only its model", async () => {
  const fake = provider();
  await createClaudeCloudStageClient(fake.dependencies).submit(submitInput({ reasoningEffort: null }));
  expect(fake.sent[1]).toBe("/model opus");
  expect(fake.sent[2]).toStartWith("Input part");
});

test.each([
  ["the empty comment reaches GitHub", { comment: "write" }],
  ["the push is allowed", { push: "write" }],
  ["both can write", { comment: "write", push: "write" }],
])("%s: no assignment is sent, the session is archived and the cause is kept", async (_name, probe) => {
  const fake = provider({ probe: probe as never });
  const error = await createClaudeCloudStageClient(fake.dependencies).submit(submitInput()).catch(failure => failure);
  expect(error).toBeInstanceOf(CloudSubmissionNotStartedError);
  expect(error.message).toContain("can write to GitHub");
  expect(error.message).toContain("setup step 2");
  expect(error.category).toBe("cloud-limit");
  expect(fake.sent).toHaveLength(1);
  expect(fake.sessions.get(fake.sessionId)!.status).toBe("archived");
});

test("proven write access holds later stages off a run across a restart, until the hold ends and a refusal clears it", async () => {
  const project = "write-hold-project";
  setClaudeCloudTasks(project, [{ accountId: account.accountId, taskId: "task-1" }]);
  const writer = provider({ probe: { comment: "write" } });
  await createClaudeCloudStageClient(writer.dependencies).submit(submitInput()).catch(failure => failure);

  /* A new client reads only what was written: nothing here lives in the first one. */
  const held = provider();
  const restarted = createClaudeCloudStageClient({ ...held.dependencies, now: writer.dependencies.now });
  expect(await prepare(restarted, project)).toMatchObject({ state: "unavailable", reason: expect.stringContaining("can write to GitHub") });
  expect(held.calls).toEqual([]);

  const later = provider();
  const afterHold = createClaudeCloudStageClient({ ...later.dependencies, now: () => writer.dependencies.now!() + 6 * 3_600_000 });
  expect(await prepare(afterHold, project)).toMatchObject({ state: "ready" });
  await afterHold.submit(submitInput());
  expect(await prepare(createClaudeCloudStageClient({ ...provider().dependencies, now: writer.dependencies.now }), project)).toMatchObject({ state: "ready" });
});

test.each([
  ["the session's permission check stops the comment", { comment: "blocked" }, "permission check"],
  ["the session's permission check stops the push", { push: "blocked" }, "permission check"],
  ["the session declines the comment and ends its turn", { comment: "silent" }, "without a usable result"],
  ["the session declines the push and ends its turn", { push: "silent" }, "without a usable result"],
])("%s: read-only access stays unproven, without a ten-minute wait", async (_name, probe, cause) => {
  const fake = provider({ probe: probe as never });
  const started = fake.dependencies.now!();
  const error = await createClaudeCloudStageClient(fake.dependencies).submit(submitInput()).catch(failure => failure);
  expect(error).toBeInstanceOf(CloudSubmissionNotStartedError);
  expect(error.message).toContain(cause);
  expect(error.message).not.toContain("can write");
  expect(fake.sent).toHaveLength(1);
  expect(fake.dependencies.now!() - started).toBeLessThan(60_000);
  expect(fake.sessions.get(fake.sessionId)!.status).toBe("archived");
});

test("a 5xx from the comment request proves neither answer", async () => {
  const fake = provider({ onSend: (text, id) => {
    if (!text.startsWith("GitHub write probe")) return null;
    const uuid = "probe-part", comment = text.split("\n").find(line => line.startsWith("gh api "))!;
    fake.push(id, { type: "user", uuid, message: { role: "user", content: text } });
    fake.assistant(id, [{ type: "tool_use", id: "c", name: "Bash", input: { command: comment } }]);
    fake.push(id, { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "c", content: "Exit code 1\nHTTP/1.1 502 Bad Gateway", is_error: true }] }, tool_use_result: "Error: Exit code 1\nHTTP/1.1 502 Bad Gateway" });
    fake.endTurn(id, uuid);
    return { state: "queued" };
  } });
  const error = await createClaudeCloudStageClient(fake.dependencies).submit(submitInput()).catch(failure => failure);
  expect(error.message).toContain("without a usable result");
});

test("no probe result within ten minutes is a cloud limit and sends no assignment", async () => {
  const fake = provider({ onSend: () => ({ state: "queued" }) });
  const error = await createClaudeCloudStageClient(fake.dependencies).submit(submitInput()).catch(failure => failure);
  expect(error).toBeInstanceOf(CloudSubmissionNotStartedError);
  expect(error.category).toBe("cloud-limit");
  expect(error.message).toContain("no GitHub write probe result");
  expect(fake.sent).toHaveLength(1);
});

test("a repository with no readable closed issue starts no run", async () => {
  const fake = provider({ closedIssue: null });
  const error = await createClaudeCloudStageClient(fake.dependencies).submit(submitInput()).catch(failure => failure);
  expect(error).toBeInstanceOf(CloudSubmissionNotStartedError);
  expect(fake.runCalls()).toBe(0);
});

test("a send whose answer was lost is settled by the part's own event, never sent twice", async () => {
  let lost = 0;
  const fake = provider({ onSend: (text, id) => { if (text.startsWith("Input part") && !lost++) { fake.deliver(text, id); return { state: "unknown" }; } return null; } });
  const submitted = await createClaudeCloudStageClient(fake.dependencies).submit(submitInput());
  expect(submitted.taskId).toBe(fake.sessionId);
  expect(fake.sent.filter(text => text.startsWith("Input part"))).toHaveLength(1);
});

test("with no receipt for a lost send the part is not sent again and the outcome stays unknown", async () => {
  const fake = provider({ onSend: text => text.startsWith("Input part") ? { state: "unknown" } : null });
  const error = await createClaudeCloudStageClient(fake.dependencies).submit(submitInput()).catch(failure => failure);
  expect(error).not.toBeInstanceOf(CloudSubmissionNotStartedError);
  expect(error.message).toContain("not sent again");
  expect(fake.sent.filter(text => text.startsWith("Input part"))).toHaveLength(1);
});

test("a send the CLI refused keeps its cause and allows a retry", async () => {
  const fake = provider({ onSend: text => text.startsWith("Input part") ? { state: "refused", detail: "session is archived" } : null });
  const error = await createClaudeCloudStageClient(fake.dependencies).submit(submitInput()).catch(failure => failure);
  expect(error).toBeInstanceOf(CloudSubmissionNotStartedError);
  expect(error.category).toBe("unavailable");
  expect(error.message).toContain("session is archived");
});

test("an idle session holding an older verdict settles nothing until the last part's bound turn", async () => {
  const fake = provider({ onSend: (text, id) => {
    if (!text.startsWith("Input part")) return null;
    fake.push(id, { type: "user", uuid: "queued", message: { role: "user", content: text } });
    return { state: "queued" };
  } });
  const client = createClaudeCloudStageClient(fake.dependencies);
  const submitted = await client.submit(submitInput());
  const bound = access(submitted), token = submitted.thread!.turnId;
  /* The probe turn ended with a valid-looking pass, and the last part is queued with its turn not started. */
  expect(await client.poll(bound)).toEqual({ state: "pending", model: null });
  /* An earlier turn ends after the part was queued: its result does not list the part. */
  fake.assistant(fake.sessionId, [{ type: "text", text: '```json\n{"status":"pass","findings":[]}\n```' }]); fake.endTurn(fake.sessionId, "earlier");
  expect(await client.poll(bound)).toEqual({ state: "pending", model: null });
  await expect(client.readFinalMessage(bound)).rejects.toThrow("not bound");
  /* The receipt without its turn end is not a result yet. */
  fake.assistant(fake.sessionId, [{ type: "text", text: `Receipt ${token}\nFound a defect.\n\n\`\`\`json\n{"status":"fail","findings":["P1 — a defect"]}\n\`\`\`` }]);
  expect(await client.poll(bound)).toEqual({ state: "pending", model: null });
  fake.endTurn(fake.sessionId, "queued");
  expect(await client.poll(bound)).toEqual({ state: "completed", model: "claude-opus-5-5" });
  expect((await client.readFinalMessage(bound)).message).toStartWith("Found a defect.");
});

test("a part that joined the running turn binds through the turn's result, which lists both messages", async () => {
  const fake = provider({ onSend: (text, id) => {
    if (!text.startsWith("Input part")) return null;
    fake.push(id, { type: "user", uuid: "joined", message: { role: "user", content: text } });
    return { state: "queued" };
  } });
  const client = createClaudeCloudStageClient(fake.dependencies);
  const submitted = await client.submit(submitInput()), bound = access(submitted);
  fake.assistant(fake.sessionId, [{ type: "text", text: `Receipt ${submitted.thread!.turnId}\nDone.` }]);
  fake.endTurn(fake.sessionId, "earlier", "joined");
  expect(await client.poll(bound)).toEqual({ state: "completed", model: "claude-opus-5-5" });
});

test.each([
  ["no receipt", (_token: string) => '```json\n{"status":"pass","findings":[]}\n```'],
  ["another part's token", (_token: string) => `Receipt ${"f".repeat(32)}\n\`\`\`json\n{"status":"pass","findings":[]}\n\`\`\``],
])("a turn that read the last part and ended with %s is a confirmed failure, never a verdict", async (_name, final) => {
  const fake = provider({ onSend: (text, id) => {
    if (!text.startsWith("Input part")) return null;
    fake.push(id, { type: "user", uuid: "last-part", message: { role: "user", content: text } });
    return { state: "queued" };
  } });
  const client = createClaudeCloudStageClient(fake.dependencies);
  const submitted = await client.submit(submitInput()), bound = access(submitted);
  fake.assistant(fake.sessionId, [{ type: "text", text: final(submitted.thread!.turnId) }]);
  fake.endTurn(fake.sessionId, "last-part");
  expect(await client.poll(bound)).toEqual({ state: "failed", model: null, error: expect.stringContaining("without the receipt") });
  await expect(client.readFinalMessage(bound)).rejects.toThrow("not bound");
});

test("an error result settles the stage only when it names the last part's own message", async () => {
  const fake = provider({ onSend: (text, id) => {
    if (!text.startsWith("Input part")) return null;
    fake.push(id, { type: "user", uuid: "last-part", message: { role: "user", content: text } });
    return { state: "queued" };
  } });
  const client = createClaudeCloudStageClient(fake.dependencies);
  const bound = access(await client.submit(submitInput()));
  fake.endFailedTurn(fake.sessionId, "earlier", "unrelated");
  expect(await client.poll(bound)).toEqual({ state: "pending", model: null });
  fake.endFailedTurn(fake.sessionId, "last-part", "tool exploded");
  expect(await client.poll(bound)).toEqual({ state: "failed", model: null, error: expect.stringContaining("tool exploded") });
});

test("a session that ends before its result is a confirmed failure", async () => {
  const fake = provider({ onSend: text => text.startsWith("Input part") ? { state: "queued" } : null });
  const client = createClaudeCloudStageClient(fake.dependencies);
  const bound = access(await client.submit(submitInput()));
  fake.sessions.get(fake.sessionId)!.status = "archived";
  expect(await client.poll(bound)).toMatchObject({ state: "failed", error: expect.stringContaining("archived") });
});

test("a writer's diff comes back whole from harness output, and a tampered export is refused", async () => {
  const patch = `diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+${"new ".repeat(5_000)}\n`;
  const fake = provider({ exportDiff: patch });
  const client = createClaudeCloudStageClient(fake.dependencies);
  const bound = access(await client.submit(submitInput({ writable: true })));
  expect(fake.sent.at(-1)).toContain("git diff --cached --binary " + head);
  expect(await client.poll(bound)).toMatchObject({ state: "completed" });
  expect(await client.readDiff(bound)).toBe(patch);
  const events = fake.sessions.get(fake.sessionId)!.events;
  const row = events.find(event => String((event.payload as { tool_use_result?: { stdout?: string } }).tool_use_result?.stdout).includes("DELEGATUS-DIFF-BLOCK")) as { payload: { tool_use_result: { stdout: string } } };
  const original = row.payload.tool_use_result.stdout;
  row.payload.tool_use_result.stdout = original.split("\n").slice(1).join("\n");
  await expect(client.readDiff(bound)).rejects.toThrow("incomplete");
  row.payload.tool_use_result.stdout = original.replace(/.$/, "A");
  await expect(client.readDiff(bound)).rejects.toThrow("checksum");
});

/* The exporter runs in a session on Linux, so its GNU tools are what this drives. */
const linuxTest = process.platform === "linux" ? test : test.skip;
linuxTest.each([
  ["no change", 0, 0],
  ["one short block", 200, 1],
  ["exactly one block", 1_500, 1],
  ["one byte past a block", 1_501, 2],
  ["exactly ten blocks, one print call", 15_000, 10],
  ["eleven blocks, a second print call", 15_001, 11],
])("the generated export run for real returns %s whole through the receiver", async (_name, bytes, blocks) => {
  const cwd = fs.mkdtempSync(path.join(root, "export-repo-")), home = fs.mkdtempSync(path.join(root, "export-home-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, env: sessionShellEnvironment(home), encoding: "utf8" });
  const write = (text: string) => fs.writeFileSync(path.join(cwd, "file.txt"), text);
  git("init", "--initial-branch=main"); write("before\n"); git("add", "."); git("-c", "user.name=fixture", "-c", "user.email=noreply@example.invalid", "commit", "-m", "base");
  const headSha = git("rev-parse", "HEAD").trim();
  if (bytes) {
    /* The patch's frame has a fixed length, so the file's size sets the patch's exactly. */
    write("x"); git("add", ".");
    write("x".repeat(bytes - (Buffer.byteLength(git("diff", "--cached", "--binary", headSha)) - 1))); git("reset", "--quiet");
  }
  const fake = provider({ exportFrom: { cwd, home } });
  const client = createClaudeCloudStageClient(fake.dependencies);
  const bound = { ...access(await client.submit(submitInput({ writable: true, headSha }))), headSha };
  const stdouts = fake.sessions.get(fake.sessionId)!.events.map(event => (event.payload as { tool_use_result?: { stdout?: string } }).tool_use_result?.stdout).filter((text): text is string => typeof text === "string");
  const exported = stdouts.find(text => text.startsWith("DELEGATUS-DIFF "))!;
  expect(Number(exported.trim().split("\n").at(-1))).toBe(blocks);
  expect(stdouts.filter(text => text.includes("DELEGATUS-DIFF-BLOCK"))).toHaveLength(Math.ceil(blocks / 10));
  /* §1.14 O22: a session's output is cut at 30,000 characters. */
  expect(stdouts.every(text => text.length < 30_000)).toBe(true);
  const patch = await client.readDiff(bound);
  expect(Buffer.byteLength(patch)).toBe(bytes);
  expect(patch).toBe(git("diff", "--cached", "--binary", headSha));
}, 30_000);

test("a read-only stage is told nothing about exporting a diff", async () => {
  const fake = provider();
  await createClaudeCloudStageClient(fake.dependencies).submit(submitInput());
  expect(fake.sent.at(-1)).not.toContain("git diff --cached");
});

test("admission reads only, and refuses each unmet condition with its reason", async () => {
  const project = "fixture-project";
  const none = provider();
  setClaudeCloudTasks(project, []);
  expect(await prepare(createClaudeCloudStageClient(none.dependencies))).toEqual({ state: "unavailable", reason: "no Claude cloud scheduled task is set for this account" });
  expect(none.calls).toEqual([]);
  expect(setClaudeCloudTasks(project, [{ accountId: account.accountId, taskId: "task-1" }])).toBe(true);
  const session = (extra: Record<string, unknown> = {}) => ({ id: "task-1", enabled: true, job_config: { ccr: { session_context: { model: "claude-opus-5-5", sources: [{ git_repository: { url: "https://github.com/sample/project" } }], ...extra } } } });
  for (const [options, reason] of [
    [{ task: { ...session(), enabled: false } }, "paused or turned off"],
    [{ task: { ...session(), mcp_connections: [{ name: "slack" }] } }, "connectors attached"],
    [{ task: session({ mcp_connector_ids: ["connector"] }) }, "connectors attached"],
    [{ task: session({ sources: [{ git_repository: { url: "https://github.com/other/project" } }] }) }, "different repository"],
    [{ task: { id: "task-1" } }, "unrecognised shape"],
    [{ task: null }, "task read answered 400"],
  ] as const) {
    const fake = provider(options as never);
    const answer = await prepare(createClaudeCloudStageClient(fake.dependencies));
    expect(answer).toMatchObject({ state: "unavailable", reason: expect.stringContaining(reason) });
    expect(fake.calls.every(call => call.method === "GET")).toBe(true);
  }
  const ready = provider();
  const prepared = await prepare(createClaudeCloudStageClient(ready.dependencies));
  expect(prepared).toMatchObject({ state: "ready", environmentId: "task-1" });
  expect(ready.calls.every(call => call.method === "GET")).toBe(true);
  /* The account's training choice is its own: nothing reads it, and a task on another model is switched per stage. */
  expect(ready.calls.map(call => call.path)).toEqual(["/v1/code/triggers/task-1"]);
  const otherModel = provider({ task: session({ model: "claude-sonnet-5-5" }) });
  expect(await prepare(createClaudeCloudStageClient(otherModel.dependencies))).toMatchObject({ state: "ready" });
});

test("admission reads the observed answer: the task sits inside `trigger`, in either of its forms", async () => {
  const project = "fixture-project";
  setClaudeCloudTasks(project, [{ accountId: account.accountId, taskId: "task-1" }]);
  const sources = [{ git_repository: { url: "https://github.com/sample/project" } }];
  const answering = (answer: unknown) => {
    const fake = provider();
    return createClaudeCloudStageClient({ ...fake.dependencies, fetch: (async () => Response.json(answer)) as unknown as typeof fetch });
  };
  expect(await prepare(answering({ trigger: { enabled: true, mcp_connections: [], job_config: { ccr: { session_context: { sources } } } } }))).toMatchObject({ state: "ready", environmentId: "task-1" });
  expect(await prepare(answering({ trigger: { enabled: true, session_request: { session_context: { sources } } } }))).toMatchObject({ state: "ready" });
  /* Conditions at the top of the answer are not the task's. */
  expect(await prepare(answering({ enabled: true, job_config: { ccr: { session_context: { sources } } } }))).toMatchObject({ state: "unavailable", reason: expect.stringContaining("unrecognised shape") });
});

test("an account with no subscription login, an expired one or a third-party provider is refused before any call", async () => {
  const project = "fixture-project";
  setClaudeCloudTasks(project, [{ accountId: account.accountId, taskId: "task-1" }]);
  for (const [overrides, reason] of [
    [{ readLogin: async () => null }, "login, which is missing"],
    [{ readLogin: async () => ({ accessToken: "t", organization: "o", expiresAt: 1 }) }, "login has expired"],
  ] as const) {
    const fake = provider();
    const answer = await prepare(createClaudeCloudStageClient({ ...fake.dependencies, ...overrides }));
    expect(answer).toMatchObject({ state: "unavailable", reason: expect.stringContaining(reason) });
    expect(fake.calls).toEqual([]);
  }
  const fake = provider();
  const answer = await createClaudeCloudStageClient(fake.dependencies).prepareEnvironment!({ project, account: { ...account, claudeProvider: { baseUrl: "https://gateway.example", model: "m", smallFastModel: null } },
    repository: "sample/project", ref: "main", signal: controller.signal, assertCurrent: () => undefined, model: "opus" });
  expect(answer).toMatchObject({ state: "unavailable", reason: expect.stringContaining("third-party provider") });
  expect(fake.calls).toEqual([]);
});

test("the real login files are read in memory; the login never reaches an error or an argument list", async () => {
  const home = fs.mkdtempSync(path.join(root, "login-"));
  const secret = ["fixture", "subscription", "login"].join("-");
  fs.writeFileSync(path.join(home, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: secret, expiresAt: Date.now() + 3_600_000 } }));
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { organizationUuid: "org-from-file" } }));
  const fake = provider({ runAnswer: () => new Response(secret, { status: 404 }) });
  const { readLogin: _ignored, ...withoutLogin } = fake.dependencies;
  const client = createClaudeCloudStageClient(withoutLogin);
  const error = await client.submit(submitInput({ account: { ...account, home } })).catch(failure => failure);
  const run = fake.calls.find(call => call.path.endsWith("/run"))!;
  expect(run.login).toBe(`Bearer ${secret}`);
  expect(run.organization).toBe("org-from-file");
  expect(`${error.message} ${JSON.stringify(error)}`).not.toContain(secret);
});

test("the CLI gets the text on stdin in a real process, on the account's home, without an API key in its environment", async () => {
  const dir = fs.mkdtempSync(path.join(root, "cli-"));
  const log = path.join(dir, "invocation.json"), script = path.join(dir, "claude");
  const shadowed = ["KEY", "TOKEN"].map(kind => (kind === "KEY" ? ["ANTHROPIC", "API", kind] : ["ANTHROPIC", "AUTH", kind]).join("_"));
  fs.writeFileSync(script, [
    "#!/usr/bin/env bun",
    "const stdin = await Bun.stdin.text();",
    `const shadowed = ${JSON.stringify(shadowed)}.filter(name => process.env[name]);`,
    `await Bun.write(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), stdin, config: process.env.CLAUDE_CONFIG_DIR, shadowed }));`,
    `console.log(JSON.stringify({ ok: true, session_id: "session_x", url: "https://claude.ai/code/session_x" }));`,
  ].join("\n"), { mode: 0o755 });
  const previous = shadowed.map(name => process.env[name]);
  for (const name of shadowed) process.env[name] = "fixture-value";
  try {
    const text = "Input part 1/1, nonce n, token t, sha256 s\n\nThe private stage input.";
    expect(await claudeCliSender(script)({ account, sessionId: "session_x", text, signal: controller.signal })).toEqual({ state: "queued" });
    expect(JSON.parse(fs.readFileSync(log, "utf8"))).toEqual({ args: ["-p", "--cloud", "session_x", "--output-format", "json"], stdin: text, config: account.home, shadowed: [] });
  } finally {
    shadowed.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
  }
});

test.each([
  ["a bad session id", `console.log(JSON.stringify({ ok: false, session_id: "s", error: "invalid session ID: must be a cse_… or session_… tagged ID" })); console.error("Error: failed to send"); process.exit(1);`, { state: "refused", detail: "invalid session ID: must be a cse_… or session_… tagged ID" }],
  ["a missing sign-in", `console.log(JSON.stringify({ ok: false, session_id: "s", error: "Cloud sessions need a claude.ai sign-in. Run \`claude auth login\`" })); process.exit(1);`, { state: "refused", detail: "Cloud sessions need a claude.ai sign-in. Run `claude auth login`" }],
  ["an argument error on stderr", `console.error('Error: --cloud "x" is not a cloud session ID or URL.'); process.exit(1);`, { state: "refused", detail: 'Error: --cloud "x" is not a cloud session ID or URL.' }],
  ["an unclassified ok:false, which may have landed", `console.log(JSON.stringify({ ok: false, session_id: "s", error: "upstream timed out" })); process.exit(1);`, { state: "unknown" }],
  ["an unclassified exit with no JSON", `console.error("something else"); process.exit(1);`, { state: "unknown" }],
  ["exit 0 with no JSON", `console.log("Sent to cloud session.");`, { state: "unknown" }],
])("the real CLI process classifies %s", async (_name, body, outcome) => {
  const dir = fs.mkdtempSync(path.join(root, "cli-"));
  const script = path.join(dir, "claude");
  fs.writeFileSync(script, `#!/usr/bin/env bun\n${body}\n`, { mode: 0o755 });
  expect(await claudeCliSender(script)({ account, sessionId: "session_x", text: "x", signal: controller.signal })).toEqual(outcome as never);
});

test("a hung CLI is ended by its abort as an unknown outcome, with its process group", async () => {
  const dir = fs.mkdtempSync(path.join(root, "cli-"));
  const script = path.join(dir, "claude");
  fs.writeFileSync(script, "#!/usr/bin/env bun\nsetInterval(() => undefined, 1000);\nawait Bun.stdin.text();\nawait new Promise(() => undefined);\n", { mode: 0o755 });
  const abort = new AbortController();
  const pending = claudeCliSender(script)({ account, sessionId: "session_x", text: "x", signal: abort.signal });
  abort.abort();
  expect(await pending).toEqual({ state: "unknown" });
});
