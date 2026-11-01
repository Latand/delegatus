import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
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
const { fakeClaudeCloud } = await import("./claudeCloud.fixture");
const { setClaudeCloudTasks } = await import("@/lib/projects/settings");

const account: AccountContext = { engine: "claude", accountId: "account-a", kind: "managed", home: path.join(root, "account-a"), transcriptRoot: path.join(root, "account-a"), env: { NODE_ENV: "test" } };
const head = "a".repeat(40);
const controller = new AbortController();
const owned: ReturnType<typeof fakeClaudeCloud>[] = [];
afterEach(() => { for (const fake of owned.splice(0)) fake.stop(); });
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
  expect(submitted.taskUrl).toBe(`https://claude.ai/code/${fake.sessionId}`);
  expect(fake.runCalls()).toBe(1);
  const run = fake.calls.find(call => call.path.endsWith("/run"))!;
  expect(run.path).toBe("/v1/code/triggers/task-1/run");
  expect(run.login).toBe("Bearer subscription-login-account-a");
  expect(run.organization).toBe("org-fixture");
  expect(fake.sent[0]).toStartWith("GitHub write probe");
  const assignment = fake.sent.slice(1);
  expect(assignment.length).toBeGreaterThan(2);
  expect(assignment.map(text => /^Input part (\d+)\/(\d+),/.exec(text)!.slice(1, 3).join("/"))).toEqual(assignment.map((_, index) => `${index + 1}/${assignment.length}`));
  expect(assignment.every(text => Buffer.byteLength(text) <= 32_000)).toBe(true);
  expect(assignment.join("")).toContain("x".repeat(20_000));
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

test.each([[422, 403], [403, 422], [201, 403]])("a write probe answering %i and %i sends no assignment", async (first, second) => {
  const fake = provider({ probeStatus: [first, second] });
  const error = await createClaudeCloudStageClient(fake.dependencies).submit(submitInput()).catch(failure => failure);
  expect(error).toBeInstanceOf(CloudSubmissionNotStartedError);
  expect(error.message).toContain("can write to GitHub");
  expect(error.category).toBe("cloud-limit");
  expect(fake.sent).toHaveLength(1);
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
  /* An earlier turn ends after the part was queued: it carries no receipt. */
  fake.assistant(fake.sessionId, [{ type: "text", text: '```json\n{"status":"pass","findings":[]}\n```' }]); fake.endTurn(fake.sessionId);
  expect(await client.poll(bound)).toEqual({ state: "pending", model: null });
  /* Another part's token is no receipt, and the message is never parsed as the verdict. */
  fake.assistant(fake.sessionId, [{ type: "text", text: `Receipt ${"f".repeat(32)}\n\`\`\`json\n{"status":"pass","findings":[]}\n\`\`\`` }]); fake.endTurn(fake.sessionId);
  expect(await client.poll(bound)).toEqual({ state: "pending", model: null });
  await expect(client.readFinalMessage(bound)).rejects.toThrow("not bound");
  /* The receipt without its turn end is not a result yet. */
  fake.assistant(fake.sessionId, [{ type: "text", text: `Receipt ${token}\nFound a defect.\n\n\`\`\`json\n{"status":"fail","findings":["P1 — a defect"]}\n\`\`\`` }]);
  expect(await client.poll(bound)).toEqual({ state: "pending", model: null });
  fake.endTurn(fake.sessionId);
  expect(await client.poll(bound)).toEqual({ state: "completed", model: "claude-opus-5-5" });
  expect((await client.readFinalMessage(bound)).message).toStartWith("Found a defect.");
});

test("an error result settles the stage only when it names the last part's own message", async () => {
  const fake = provider({ onSend: (text, id) => {
    if (!text.startsWith("Input part")) return null;
    fake.push(id, { type: "user", uuid: "last-part", message: { role: "user", content: text } });
    return { state: "queued" };
  } });
  const client = createClaudeCloudStageClient(fake.dependencies);
  const bound = access(await client.submit(submitInput()));
  fake.endTurn(fake.sessionId, { subtype: "error_during_execution", is_error: true, user_message_uuid: "earlier" });
  expect(await client.poll(bound)).toEqual({ state: "pending", model: null });
  fake.endTurn(fake.sessionId, { subtype: "error_during_execution", is_error: true, user_message_uuid: "last-part", result: "tool exploded" });
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
    [{ training: true }, "model training is on"],
    [{ task: { ...session(), enabled: false } }, "paused or turned off"],
    [{ task: { ...session(), mcp_connections: [{ name: "slack" }] } }, "connectors attached"],
    [{ task: session({ mcp_connector_ids: ["connector"] }) }, "connectors attached"],
    [{ task: session({ sources: [{ git_repository: { url: "https://github.com/other/project" } }] }) }, "different repository"],
    [{ task: session({ model: "claude-sonnet-5-5" }) }, "the stage needs opus"],
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
  ["ok:false JSON", `console.log(JSON.stringify({ ok: false, session_id: "s", error: "session is archived" }));`, { state: "refused", detail: "session is archived" }],
  ["configuration error on stderr", `console.error("cloud sessions are disabled for your organization"); process.exit(1);`, { state: "refused", detail: "cloud sessions are disabled for your organization" }],
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
