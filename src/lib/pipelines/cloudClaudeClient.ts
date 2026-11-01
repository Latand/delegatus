import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AccountContext } from "@/lib/accounts/contracts";
import { claudeManagedEnvironment } from "@/lib/accounts/claude";
import { resolveBinary } from "@/lib/agent/cli";
import { claudeCloudTaskFingerprint, claudeCloudTasks } from "@/lib/projects/settings";
import type { CloudEnvironmentPreparation, PrepareCloudEnvironmentInput } from "@/lib/projects/codexCloudEnvironments";
import { cloudInputTurn, splitCloudInput } from "./cloudStageInput";
import { CloudSubmissionNotStartedError } from "./cloudHostedClient";
import { HostedCloudError } from "./cloudHostedErrors";
import type { CloudStageClient, CloudTaskAccess } from "./cloudStage";

/* A Claude Code cloud session on the account's subscription login. The login
 * is read into memory per operation, the way the installed CLI's own /schedule
 * tool sends it; no API key path exists. What was observed and what still waits
 * for a live run is listed in docs/design/claude-code-cloud.md §1.13. */

const API = "https://api.anthropic.com";
const TRIGGERS_BETA = "ccr-triggers-2026-01-30";
const EVENTS_PAGE = 500;
const EVENT_PAGES = 40;
const SEND_DEADLINE_MS = 25_000;
const OUTCOME_WINDOW_MS = 10 * 60_000;
const CLOCK_ALLOWANCE_MS = 60_000;
const READ_DEADLINE_MS = 20_000;
const CANDIDATES_PER_READ = 5;
const DIFF_BLOCK_BYTES = 2_000;
const DIFF_BLOCKS_PER_COMMAND = 10;
const DIFF_LIMIT_BYTES = 16 * 1024 * 1024;
const TERMINAL_STATUSES = new Set(["failed", "cancelled", "canceled", "archived"]);

type Row = Record<string, unknown>;
export type ClaudeLogin = { accessToken: string; organization: string; expiresAt: number };
export type ClaudeSendOutcome = { state: "queued" } | { state: "refused"; detail: string } | { state: "unknown" };
export type ClaudeCloudDependencies = {
  fetch: typeof fetch;
  readLogin: (account: AccountContext) => Promise<ClaudeLogin | null>;
  send: (input: { account: AccountContext; sessionId: string; text: string; signal: AbortSignal }) => Promise<ClaudeSendOutcome>;
  random: () => string;
  now: () => number;
  sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};
type Access = Pick<CloudTaskAccess, "account" | "signal" | "assertCurrent">;
type Event = { sequence: number; type: string; payload: Row };

const record = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const never = (message: string, category: HostedCloudError["category"]) => new CloudSubmissionNotStartedError(message, category);

export const CLAUDE_CLOUD_SEND_ARGS = (sessionId: string) => ["-p", "--cloud", sessionId, "--output-format", "json"];

/** The account's own login files. Anything else, an API key included, is no login here. */
async function readAccountLogin(account: AccountContext): Promise<ClaudeLogin | null> {
  try {
    const { accessToken, expiresAt } = record(record(JSON.parse(await fs.readFile(path.join(account.home, ".credentials.json"), "utf8"))).claudeAiOauth);
    const configFile = path.basename(account.home) === ".claude" ? path.join(path.dirname(account.home), ".claude.json") : path.join(account.home, ".claude.json");
    const organization = record(record(JSON.parse(await fs.readFile(configFile, "utf8"))).oauthAccount).organizationUuid;
    if (typeof accessToken !== "string" || !accessToken || typeof organization !== "string" || !organization) return null;
    return { accessToken, organization, expiresAt: Number(expiresAt) || 0 };
  } catch { return null; }
}

/** Text goes on stdin so stage input never reaches an argument list. D1 documents
 * `{ok}` JSON for a send and stderr without JSON for a configuration error. */
export function claudeCliSender(binary: string): ClaudeCloudDependencies["send"] {
  return ({ account, sessionId, text, signal }) => new Promise(resolve => {
    const child = spawn(binary, CLAUDE_CLOUD_SEND_ARGS(sessionId), { cwd: os.tmpdir(), detached: true, stdio: ["pipe", "pipe", "pipe"], env: claudeManagedEnvironment(account.home) });
    let out = "", err = "", finished = false, killed = false;
    const stop = () => {
      killed = true;
      try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    };
    const timer = setTimeout(stop, SEND_DEADLINE_MS);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    const settle = (outcome: ClaudeSendOutcome) => {
      if (finished) return;
      finished = true; clearTimeout(timer); signal.removeEventListener("abort", stop); resolve(outcome);
    };
    child.stdout.on("data", chunk => { if (out.length < 65_536) out += String(chunk); });
    child.stderr.on("data", chunk => { if (err.length < 4_096) err += String(chunk); });
    child.stdin.on("error", () => undefined);
    child.on("error", error => settle((error as NodeJS.ErrnoException).code === "ENOENT" ? { state: "refused", detail: "the claude CLI is not installed" } : { state: "unknown" }));
    child.on("close", code => {
      if (killed) return settle({ state: "unknown" });
      try {
        const reply = record(JSON.parse(out));
        if (reply.ok === true) return settle({ state: "queued" });
        if (reply.ok === false) return settle({ state: "refused", detail: typeof reply.error === "string" ? reply.error.slice(0, 500) : "the session refused the message" });
      } catch { /* no JSON: decided below */ }
      settle(code ? { state: "refused", detail: err.trim().split("\n")[0]?.slice(0, 500) || `the claude CLI exited ${code}` } : { state: "unknown" });
    });
    child.stdin.end(text);
  });
}

const defaultDependencies = (): ClaudeCloudDependencies => ({
  fetch, readLogin: readAccountLogin, send: input => claudeCliSender(resolveBinary("claude"))(input), random: () => randomBytes(16).toString("hex"), now: () => Date.now(),
  sleep: (milliseconds, signal) => new Promise(resolve => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  }),
});

/** Claude model aliases report the catalogue id they resolve to. */
export function sameClaudeModel(reported: string, requested: string): boolean {
  return reported === requested || (/^[a-z]+$/.test(requested) && reported.startsWith(`claude-${requested}-`));
}

function neverOpened(error: unknown): boolean {
  const code = String(record(error).code ?? record(record(error).cause).code ?? "");
  return ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "ConnectionRefused", "FailedToOpenSocket", "DNSException"].includes(code);
}

function normalizedGithubUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(value.trim());
  return match ? match[1]!.toLowerCase() : null;
}

function userText(event: Event): string | null {
  const content = record(event.payload.message).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const texts = content.filter(block => record(block).type === "text").map(block => String(record(block).text ?? ""));
  return texts.length ? texts.join("\n") : null;
}

function assistantText(event: Event): string | null {
  const content = record(event.payload.message).content;
  if (!Array.isArray(content)) return null;
  const texts = content.filter(block => record(block).type === "text").map(block => String(record(block).text ?? ""));
  return texts.length ? texts.join("\n") : null;
}

/** Binds a follow-up: the receipt token appears only in the header this client generated. */
const carriesPart = (event: Event, token: string) => event.type === "user" && (userText(event)?.slice(0, 400).includes(`token ${token},`) ?? false);

const partHeader = (lead: string, nonce: string, token: string, text: string) => `${lead}, nonce ${nonce}, token ${token}, sha256 ${sha256(text)}`;

/** The bound final turn of the part carrying `token`, in event order: its user
 * event, then an assistant message opening with its receipt, then the turn end. */
function boundTurn(events: Event[], token: string): { state: "pending" } | { state: "failed"; error: string } | { state: "completed"; message: string; model: string | null; after: Event[] } {
  const start = events.findIndex(event => carriesPart(event, token));
  if (start < 0) return { state: "pending" };
  const after = events.slice(start + 1);
  const lastResult = after.findLastIndex(event => event.type === "result");
  if (lastResult < 0) return { state: "pending" };
  const result = after[lastResult]!;
  if (after.slice(lastResult + 1).some(event => event.type === "assistant")) return { state: "pending" };
  const texts = after.slice(0, lastResult).filter(event => event.type === "assistant" && assistantText(event) !== null);
  /* A queued part's user event may precede an earlier turn's end, so an error
     settles the stage only when the result names this part's own message. */
  const own = [result.payload.user_message_uuid, ...(Array.isArray(result.payload.user_message_uuids) ? result.payload.user_message_uuids : [])];
  if ((result.payload.is_error === true || (result.payload.subtype !== undefined && result.payload.subtype !== "success")) && own.includes(events[start]!.payload.uuid)) {
    return { state: "failed", error: `Claude Cloud turn ended with ${String(result.payload.subtype ?? "an error")}: ${String(result.payload.result ?? "").slice(0, 500)}` };
  }
  const final = texts.at(-1);
  const text = final && assistantText(final);
  const [first, ...rest] = (text ?? "").split("\n");
  if (!final || first?.trim() !== `Receipt ${token}`) return { state: "pending" };
  const model = record(final.payload.message).model;
  return { state: "completed", message: rest.join("\n").trimStart(), model: typeof model === "string" ? model : null, after: after.slice(0, lastResult + 1) };
}

export function createClaudeCloudStageClient(overrides: Partial<ClaudeCloudDependencies> = {}): CloudStageClient {
  const dependencies = { ...defaultDependencies(), ...overrides };

  async function login(account: AccountContext): Promise<ClaudeLogin> {
    if (account.claudeProvider) throw new HostedCloudError("Claude Cloud needs a claude.ai subscription account; this one uses a third-party provider", "cloud-limit");
    const found = await dependencies.readLogin(account);
    if (!found) throw new HostedCloudError("Claude Cloud needs the account's claude.ai subscription login, which is missing", "cloud-limit");
    /* The refresh that is free of side effects is unsettled (U8). A local run of
       this account refreshes the login, so the fallback itself heals this. */
    if (found.expiresAt && found.expiresAt <= dependencies.now()) throw new HostedCloudError("Claude Cloud login has expired; it refreshes on the account's next local run", "cloud-limit");
    return found;
  }

  async function request(account: AccountContext, signal: AbortSignal, method: "GET" | "POST", target: string, body?: Row): Promise<Response> {
    const auth = await login(account);
    return dependencies.fetch(`${API}${target}`, {
      method, redirect: "error",
      headers: { Authorization: `Bearer ${auth.accessToken}`, "Content-Type": "application/json", "anthropic-version": "2023-06-01",
        "x-organization-uuid": auth.organization, "anthropic-beta": TRIGGERS_BETA },
      signal: AbortSignal.any([signal, AbortSignal.timeout(READ_DEADLINE_MS)]),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }

  async function read(account: AccountContext, signal: AbortSignal, target: string, what = "read"): Promise<Row> {
    let response: Response;
    try { response = await request(account, signal, "GET", target); }
    catch (error) {
      if (error instanceof HostedCloudError) throw error;
      throw new HostedCloudError("Claude Cloud read failed", "unavailable");
    }
    if (response.status === 401) throw new HostedCloudError("Claude Cloud login was refused", "account-limit");
    if (response.status === 429 || response.status >= 500) throw new HostedCloudError(`Claude Cloud ${what} answered ${response.status}`, "unavailable");
    if (!response.ok) throw new HostedCloudError(`Claude Cloud ${what} answered ${response.status}`, "invalid");
    const parsed = await response.json().catch(() => null) as unknown;
    if (!parsed || typeof parsed !== "object") throw new HostedCloudError("Claude Cloud read returned an unknown shape", "invalid");
    return parsed as Row;
  }

  /** Newest first on the wire; `until` stops the walk back once the page holds what is needed. */
  async function eventsBack(account: AccountContext, signal: AbortSignal, sessionId: string, until: (events: Event[]) => boolean): Promise<Event[]> {
    const seen: Event[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < EVENT_PAGES; page++) {
      const query = new URLSearchParams({ limit: String(EVENTS_PAGE), sort_order: "desc", ...(cursor ? { cursor } : {}) });
      const body = await read(account, signal, `/v1/code/sessions/${encodeURIComponent(sessionId)}/events?${query}`);
      if (!Array.isArray(body.data)) throw new HostedCloudError("Claude Cloud events returned an unknown shape", "invalid");
      for (const row of body.data) {
        const payload = record(record(row).payload);
        const sequence = Number(record(row).sequence_num);
        if (!Number.isFinite(sequence) || typeof payload.type !== "string") continue;
        seen.push({ sequence, type: payload.type, payload });
      }
      seen.sort((left, right) => left.sequence - right.sequence);
      cursor = typeof body.next_cursor === "string" && body.next_cursor ? body.next_cursor : null;
      if (!cursor || until(seen)) return seen;
    }
    return seen;
  }

  /** A run's prompt sits at its start, so a long foreign run costs one page here. */
  async function firstEvents(account: AccountContext, signal: AbortSignal, sessionId: string): Promise<Event[]> {
    const body = await read(account, signal, `/v1/code/sessions/${encodeURIComponent(sessionId)}/events?${new URLSearchParams({ limit: "50", sort_order: "asc" })}`);
    return (Array.isArray(body.data) ? body.data : []).flatMap(row => {
      const payload = record(record(row).payload);
      return typeof payload.type === "string" ? [{ sequence: Number(record(row).sequence_num), type: payload.type, payload }] : [];
    });
  }

  /** Only an answer or the run's own events bind a run to this attempt. */
  async function reconcile(input: { account: AccountContext; signal: AbortSignal; taskId: string; nonce: string; startedAt: number; assertCurrent: () => void }): Promise<string | null> {
    const deadline = dependencies.now() + OUTCOME_WINDOW_MS;
    const foreign = new Set<string>();
    for (let round = 0; dependencies.now() < deadline && !input.signal.aborted; round++) {
      input.assertCurrent();
      const list = await read(input.account, input.signal, `/v1/code/sessions?${new URLSearchParams({ trigger_id: input.taskId, limit: "20" })}`).catch(() => ({ data: [] as unknown[] }));
      const rows = (Array.isArray(list.data) ? list.data : []).map(record)
        .filter(row => typeof row.id === "string" && !foreign.has(row.id) && Date.parse(String(row.created_at)) >= input.startedAt - CLOCK_ALLOWANCE_MS)
        .slice(0, CANDIDATES_PER_READ);
      const own: string[] = [];
      for (const row of rows) {
        const events = await firstEvents(input.account, input.signal, row.id as string).catch(() => [] as Event[]);
        if (events.some(event => JSON.stringify(event.payload).includes(input.nonce))) own.push(row.id as string);
        else if (events.some(event => event.type === "user" && userText(event) !== null)) foreign.add(row.id as string);
      }
      if (own.length > 1) return null;
      if (own.length === 1) return own[0]!;
      await dependencies.sleep(Math.min(30_000, 2_000 * 2 ** Math.min(round, 4)), input.signal);
    }
    return null;
  }

  /** The account's run call happens once. A cause that proves no session lets
   * the engine retry or fall back; any other answer is reconciled by the nonce. */
  async function startRun(input: { account: AccountContext; signal: AbortSignal; taskId: string; nonce: string; assertCurrent: () => void }): Promise<string> {
    const startedAt = dependencies.now();
    let response: Response | null = null;
    input.assertCurrent();
    await login(input.account).catch((error: unknown) => {
      throw error instanceof HostedCloudError ? never(error.message, error.category) : never("Claude Cloud login could not be read", "cloud-limit");
    });
    try {
      response = await request(input.account, input.signal, "POST", `/v1/code/triggers/${encodeURIComponent(input.taskId)}/run`, { text: `Delegatus stage run, nonce ${input.nonce}` });
    } catch (error) {
      if (neverOpened(error)) throw never("Claude Cloud could not be reached", "unavailable");
    }
    if (response) {
      if (response.status === 429) {
        const wait = Number(response.headers.get("retry-after"));
        throw never(`Claude Cloud refused the run: the task's start limit was reached${Number.isFinite(wait) && wait > 0 ? `, retry after ${wait} seconds` : ""}`, "cloud-limit");
      }
      if (response.status === 401) throw never("Claude Cloud refused the run: the account's login was refused", "account-limit");
      if ([400, 403, 404].includes(response.status)) throw never(`Claude Cloud refused the run with ${response.status}: the task is missing, paused or turned off`, "cloud-limit");
      if (response.ok) {
        const body = record(await response.json().catch(() => null));
        const id = [body.session_id, body.claude_code_session_id, body.id, record(body.session).id]
          .find(value => typeof value === "string" && /^(?:session|cse)_[A-Za-z0-9_-]{1,150}$/.test(value));
        if (typeof id === "string") return id;
      }
    }
    const adopted = await reconcile({ ...input, startedAt });
    if (adopted) return adopted;
    throw new HostedCloudError("Claude Cloud run outcome is unknown; automatic resubmission refused", "invalid");
  }

  /** A follow-up is sent once. A lost answer is settled by the part's own event, never by resending. */
  async function deliver(input: { account: AccountContext; signal: AbortSignal; sessionId: string; text: string; token: string; assertCurrent: () => void }): Promise<void> {
    input.assertCurrent();
    const outcome = await dependencies.send({ account: input.account, sessionId: input.sessionId, text: input.text, signal: input.signal });
    if (outcome.state === "queued") return;
    if (outcome.state === "refused") throw never(`Claude Cloud refused the input: ${outcome.detail}`, "unavailable");
    const deadline = dependencies.now() + OUTCOME_WINDOW_MS;
    for (let round = 0; dependencies.now() < deadline && !input.signal.aborted; round++) {
      input.assertCurrent();
      const events = await eventsBack(input.account, input.signal, input.sessionId, found => found.some(event => carriesPart(event, input.token))).catch(() => [] as Event[]);
      if (events.some(event => carriesPart(event, input.token))) return;
      await dependencies.sleep(Math.min(30_000, 2_000 * 2 ** Math.min(round, 4)), input.signal);
    }
    throw new HostedCloudError("Claude Cloud input outcome is unknown; the part is not sent again", "invalid");
  }

  /** Each session proves its GitHub connection cannot write before it gets the assignment. */
  async function probe(input: { account: AccountContext; signal: AbortSignal; sessionId: string; repository: string; issue: number; nonce: string; assertCurrent: () => void }): Promise<void> {
    const refs = `gh api -i -X POST repos/${input.repository}/git/refs -f ref=refs/heads/delegatus-probe-${input.nonce} -f sha=${"0".repeat(40)}`;
    const comment = `gh api -i -X POST repos/${input.repository}/issues/${input.issue}/comments -f body=`;
    const token = dependencies.random();
    const body = `Run exactly these two commands, each in its own Bash call, and change nothing else. Then stop and wait for the next message.\n\n${refs}\n\n${comment}`;
    await deliver({ ...input, token, text: `${partHeader("GitHub write probe", input.nonce, token, body)}\n\n${body}` });
    const deadline = dependencies.now() + OUTCOME_WINDOW_MS;
    for (let round = 0; dependencies.now() < deadline && !input.signal.aborted; round++) {
      input.assertCurrent();
      const events = await eventsBack(input.account, input.signal, input.sessionId, found => found.some(event => carriesPart(event, token))).catch(() => [] as Event[]);
      const start = events.findIndex(event => carriesPart(event, token));
      if (start >= 0) {
        const results = [refs, comment].map(command => exactCommandStatus(events.slice(start + 1), command));
        if (results.some(status => status !== null && ![401, 403, 404].includes(status))) {
          throw never("Claude Cloud session can write to GitHub; read-only access was not proven, so no assignment was sent", "cloud-limit");
        }
        if (results.every(status => status !== null)) return;
      }
      await dependencies.sleep(Math.min(30_000, 2_000 * 2 ** Math.min(round, 4)), input.signal);
    }
    if (input.signal.aborted) throw new Error("Claude Cloud operation timed out");
    throw never("Claude Cloud session gave no GitHub write probe result within ten minutes", "cloud-limit");
  }

  /** A closed issue that stays valid for the probe's empty comment. */
  async function closedIssue(repository: string, signal: AbortSignal): Promise<number> {
    let body: unknown = null;
    try {
      const response = await dependencies.fetch(`https://api.github.com/repos/${repository}/issues?${new URLSearchParams({ state: "closed", per_page: "1" })}`,
        { headers: { Accept: "application/vnd.github+json" }, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(READ_DEADLINE_MS)]) });
      if (response.ok) body = await response.json();
    } catch { /* decided below */ }
    const number = Array.isArray(body) ? record(body[0]).number : null;
    if (typeof number !== "number") throw never("Claude Cloud write probe needs a closed issue on the repository; none could be read", "cloud-limit");
    return number;
  }

  return {
    supportsModel: model => /^[A-Za-z0-9._-]{1,128}$/.test(model),
    sameModel: sameClaudeModel,
    hasEnvironment: async input => !!input.environmentId,
    /** Read-only admission: nothing starts unless every operator condition holds. */
    prepareEnvironment: async (input: PrepareCloudEnvironmentInput): Promise<CloudEnvironmentPreparation> => {
      const unavailable = (reason: string): CloudEnvironmentPreparation => ({ state: "unavailable", reason });
      const taskId = claudeCloudTasks(input.project).find(task => task.accountId === input.account.accountId)?.taskId;
      if (!taskId) return unavailable("no Claude cloud scheduled task is set for this account");
      try {
        input.assertCurrent();
        const settings = await read(input.account, input.signal, "/api/oauth/account/settings");
        if (settings.grove_enabled !== false) return unavailable("model training is on for this Claude account; turn off \"Help improve our AI models\" at claude.ai/settings/data-privacy-controls");
        input.assertCurrent();
        const task = await read(input.account, input.signal, `/v1/code/triggers/${encodeURIComponent(taskId)}`, "task read");
        const context = record(record(record(task.job_config).ccr).session_context);
        const session = Object.keys(context).length ? context : record(record(task.session_request).session_context);
        if (!Object.keys(session).length) return unavailable("the Claude cloud task record has an unrecognised shape");
        if (task.enabled === false) return unavailable("the Claude cloud task is paused or turned off");
        const connectors = [task.mcp_connections, session.mcp_connector_ids].flatMap(value => Array.isArray(value) ? value : []);
        if (connectors.length) return unavailable("the Claude cloud task has connectors attached; remove every connector");
        const repositories = (Array.isArray(session.sources) ? session.sources : []).map(source => normalizedGithubUrl(record(record(source).git_repository).url ?? record(source).url));
        if (repositories.length !== 1 || repositories[0] !== input.repository.toLowerCase()) return unavailable("the Claude cloud task is set to a different repository");
        if (input.model && typeof session.model === "string" && !sameClaudeModel(session.model, input.model)) {
          return unavailable(`the Claude cloud task runs ${session.model}, the stage needs ${input.model}`);
        }
      } catch (error) {
        if (error instanceof HostedCloudError) return unavailable(error.message);
        throw error;
      }
      return { state: "ready", environmentId: taskId, selection: claudeCloudTaskFingerprint(input.project, input.account.accountId),
        revision: 1, principal: sha256(JSON.stringify([input.account.home, taskId])) };
    },
    submit: async input => {
      const repository = input.environmentScope?.repository;
      if (!repository) throw never("Claude Cloud requires a GitHub repository", "cloud-limit");
      const issue = await closedIssue(repository, input.signal);
      const nonce = dependencies.random();
      const shared = { account: input.account, signal: input.signal, assertCurrent: input.assertCurrent };
      const sessionId = await startRun({ ...shared, taskId: input.environmentId, nonce });
      await probe({ ...shared, sessionId, repository, issue, nonce });
      // Nothing was assigned yet: a composition failure proves no work started.
      const prompt = input.preparePrompt ? await input.preparePrompt(sessionId).catch((error: unknown) => {
        throw never(error instanceof Error ? error.message : "Claude Cloud input could not be composed", error instanceof HostedCloudError ? error.category : "invalid");
      }) : input.prompt;
      const framed = `${prompt}\n\n${claudeRuntimeLines(input.branch, input.headSha, nonce, input.writable === true)}`;
      const turns = splitCloudInput(framed);
      let lastToken = "";
      for (let index = 0; index < turns.length; index++) {
        const token = lastToken = dependencies.random();
        const text = cloudInputTurn(turns, index);
        await deliver({ ...shared, sessionId, token, text: `${partHeader(`Input part ${index + 1}/${turns.length}`, nonce, token, text)}\n\n${text}` });
      }
      return { taskId: sessionId, taskUrl: `https://claude.ai/code/${sessionId}`, thread: { threadId: sessionId, turnId: lastToken } };
    },
    poll: async input => {
      const { sessionId, token } = sessionOf(input);
      input.assertCurrent();
      const events = await eventsBack(input.account, input.signal, sessionId, found => !found.some(event => event.type === "result") || found.some(event => carriesPart(event, token)));
      const bound = events.some(event => event.type === "result") ? boundTurn(events, token) : { state: "pending" as const };
      if (bound.state === "completed") return { state: "completed", model: bound.model };
      if (bound.state === "failed") return { state: "failed", error: bound.error, model: null };
      input.assertCurrent();
      const answer = await read(input.account, input.signal, `/v1/code/sessions/${encodeURIComponent(sessionId)}`);
      const session = record(answer.response_shape ?? answer);
      if (TERMINAL_STATUSES.has(String(session.status).toLowerCase())) return { state: "failed", error: `Claude Cloud session ended as ${String(session.status)} before its result`, model: null };
      return { state: "pending", model: null };
    },
    readFinalMessage: async input => {
      const bound = await boundFinal(input);
      return { message: bound.message, model: bound.model ?? "" };
    },
    readDiff: async input => {
      const bound = await boundFinal(input);
      return readExportedDiff(bound.after);
    },
  };

  async function boundFinal(input: Access & CloudTaskAccess) {
    const { sessionId, token } = sessionOf(input);
    input.assertCurrent();
    const events = await eventsBack(input.account, input.signal, sessionId, found => found.some(event => carriesPart(event, token)));
    const bound = boundTurn(events, token);
    if (bound.state !== "completed") throw new HostedCloudError("Claude Cloud final message is not bound to the last input part", "invalid");
    return bound;
  }
}

function sessionOf(input: CloudTaskAccess): { sessionId: string; token: string } {
  if (!input.thread?.threadId || !input.thread.turnId) throw new HostedCloudError("Claude Cloud task receipt has no session binding", "invalid");
  return { sessionId: input.thread.threadId, token: input.thread.turnId };
}

/** The harness-recorded result of the session's own exact command, read from its status line. */
function exactCommandStatus(events: Event[], command: string): number | null {
  const uses = events.flatMap(event => event.type === "assistant"
    ? (Array.isArray(record(event.payload.message).content) ? record(event.payload.message).content as unknown[] : []).map(record).filter(block => block.type === "tool_use" && record(block.input).command === command)
    : []);
  for (const use of uses) {
    for (const event of events) {
      if (event.type !== "user" || !Array.isArray(record(event.payload.message).content)) continue;
      const answers = (record(event.payload.message).content as unknown[]).map(record).some(block => block.type === "tool_result" && block.tool_use_id === use.id);
      if (!answers) continue;
      const result = record(event.payload.tool_use_result);
      const status = /^HTTP\/[\d.]+ (\d{3})/m.exec(`${String(result.stdout ?? "")}\n${String(result.stderr ?? "")}`);
      if (status) return Number(status[1]);
    }
  }
  return null;
}

/** Added to the assignment, so its text is covered by the part digest. */
function claudeRuntimeLines(branch: string, head: string, nonce: string, writable: boolean): string {
  const file = `"$HOME/delegatus-${nonce}.patch"`, blocks = `"$HOME/delegatus-${nonce}.blocks"`;
  return [
    "Claude Code cloud session instructions:",
    `Work only after the last input part has arrived. First run: git fetch origin ${branch} && git checkout --detach ${head}`,
    "Never push, and open or comment on nothing on GitHub.",
    "Begin your final message with the line `Receipt <token>`, copying the token from the header of the last input part. The verdict follows it.",
    ...(writable ? [
      "As the last step before your final message, export your changes exactly like this, in one turn, and change nothing afterwards:",
      `git add -A && git diff --cached --binary ${head} > ${file} && printf 'DELEGATUS-DIFF ${nonce} %s %s\\n' "$(wc -c < ${file})" "$(sha256sum ${file} | cut -d' ' -f1)" && base64 -w 0 ${file} | fold -w ${DIFF_BLOCK_BYTES} > ${blocks} && wc -l < ${blocks}`,
      `Then print every block, ${DIFF_BLOCKS_PER_COMMAND} per Bash call, advancing FROM by ${DIFF_BLOCKS_PER_COMMAND} until all are printed: awk -v from=FROM 'NR>=from && NR<from+${DIFF_BLOCKS_PER_COMMAND} {print "DELEGATUS-DIFF-BLOCK ${nonce} " NR " " $0}' ${blocks}`,
    ] : []),
  ].join("\n\n");
}

/** Only harness-recorded output counts, and the session's own digest must agree. */
function readExportedDiff(events: Event[]): string {
  const outputs = events.filter(event => event.type === "user").map(event => record(event.payload.tool_use_result).stdout).filter((value): value is string => typeof value === "string");
  let declared: { nonce: string; bytes: number; digest: string } | null = null;
  for (const output of outputs) {
    const match = /^DELEGATUS-DIFF ([a-f0-9]{32}) (\d+) ([a-f0-9]{64})$/m.exec(output);
    if (match) declared = { nonce: match[1]!, bytes: Number(match[2]), digest: match[3]! };
  }
  if (!declared) throw new HostedCloudError("Claude Cloud diff export is missing from the session", "invalid");
  if (declared.bytes > DIFF_LIMIT_BYTES) throw new HostedCloudError("Claude Cloud diff exceeded its byte limit", "invalid");
  const blocks = new Map<number, string>();
  for (const output of outputs) {
    for (const match of output.matchAll(new RegExp(`^DELEGATUS-DIFF-BLOCK ${declared.nonce} (\\d+) ([A-Za-z0-9+/=]+)$`, "gm"))) blocks.set(Number(match[1]), match[2]!);
  }
  const joined = [...blocks.keys()].sort((left, right) => left - right).map((key, index) => {
    if (key !== index + 1) throw new HostedCloudError("Claude Cloud diff blocks are incomplete", "invalid");
    return blocks.get(key)!;
  }).join("");
  const patch = Buffer.from(joined, "base64");
  if (patch.length !== declared.bytes || sha256(patch) !== declared.digest) throw new HostedCloudError("Claude Cloud diff checksum does not match", "invalid");
  return patch.toString("utf8");
}

export const claudeCloudStageClient = createClaudeCloudStageClient();
