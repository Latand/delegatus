import { accountManager } from "@/lib/accounts/manager";
import type { AccountManager } from "@/lib/accounts/contracts";
import { readClaudeCredentials } from "@/lib/accounts/claudeCredentials";
import { MemoryProfileError, OVERALL_SCOPE, profilePrompt, profileSchema, type ProfileInput } from "./profile";
import type { Locale } from "@/lib/i18n/core";

// The approved model is pinned; catalogue absence must never select an older model.
export const MEMORY_PROFILE_MODEL = "claude-opus-5-5";
export const MEMORY_PROFILE_FALLBACK_MODEL = "claude-haiku-5-5";
export type ProfileResult = Pick<JsonAnswer, "answer" | "model">;
export type ProfileCaller = (input: ProfileInput, locale: Locale) => Promise<ProfileResult>;
export type ProfileFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface JsonRequest { prompt: string; schema: object; maxTokens: number; deadlineMs?: number }
export interface JsonAnswer { answer: unknown; durationMs: number; inputTokens: number; outputTokens: number; model: string }
export type JsonCaller = (input: JsonRequest) => Promise<JsonAnswer>;
/** One Messages request, no tools or agent session. Secrets never leave this closure. */
export function directJsonCaller(oauthToken: string, model: string, request: ProfileFetch = fetch): JsonCaller {
  return async (input) => {
    const started = performance.now();
    let response: Response;
    try {
      response = await request("https://api.anthropic.com/v1/messages", {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(input.deadlineMs ?? 30_000),
        headers: { authorization: `Bearer ${oauthToken}`, "anthropic-version": "2023-06-01", "anthropic-beta": "oauth-2025-04-20", "content-type": "application/json" },
        body: JSON.stringify({ model,
          // Thinking shares the output ceiling; prose stays bounded by validation.
          max_tokens: input.maxTokens,
          // Subscription model admission requires this client identity, even without tools.
          system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }],
          messages: [{ role: "user", content: input.prompt }],
          output_config: { ...([MEMORY_PROFILE_MODEL, MEMORY_PROFILE_FALLBACK_MODEL].includes(model) ? { effort: "low" } : {}), format: { type: "json_schema", schema: input.schema } },
        }),
      });
    } catch (error) {
      throw new MemoryProfileError(error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name) ? "timeout" : "failed");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new MemoryProfileError([401, 403, 429].includes(response.status) ? "account" : "failed");
    }
    try {
      const body = await response.json() as { stop_reason?: string; content?: { type: string; text?: string }[]; usage?: Record<string, number> };
      if (body.stop_reason === "refusal") throw new MemoryProfileError("failed");
      if (body.stop_reason !== "end_turn" || !Array.isArray(body.content) || body.content.some(part => !["text", "thinking", "redacted_thinking"].includes(part.type))) throw new MemoryProfileError("invalid");
      return { answer: JSON.parse(body.content.filter(part => part.type === "text").map(part => part.text ?? "").join("")), durationMs: performance.now() - started, inputTokens: body.usage?.input_tokens ?? 0, outputTokens: body.usage?.output_tokens ?? 0, model };
    } catch (error) {
      if (error instanceof MemoryProfileError) throw error;
      throw new MemoryProfileError(error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name) ? "timeout" : "invalid");
    }
  };
}

export function directProfileCaller(oauthToken: string, model: string, request: ProfileFetch = fetch): ProfileCaller {
  const caller = directJsonCaller(oauthToken, model, request);
  return profileCaller(caller, model);
}

type AccountPorts = { manager?: Pick<AccountManager, "resolveHeadlessSpawn">; credentials?: typeof readClaudeCredentials; model: string; request?: ProfileFetch };
export async function prepareJsonCaller(project: string, ports: AccountPorts = { model: MEMORY_PROFILE_MODEL }, managedOnly = false): Promise<JsonCaller> {
  const manager = ports.manager ?? accountManager;
  const readCredentials = ports.credentials ?? readClaudeCredentials;
  const unavailable: string[] = [];
  while (true) {
    const selected = manager.resolveHeadlessSpawn("claude", null, [], project, ports.model, unavailable);
    if (selected.kind !== "available" || unavailable.includes(selected.account.accountId)) throw new MemoryProfileError("account");
    if (!selected.account.claudeProvider && (!managedOnly || selected.account.kind === "managed")) {
      const credentials = readCredentials(selected.account.home);
      const oauth = credentials.state === "present" ? credentials.document.claudeAiOauth : null;
      if (typeof oauth?.accessToken === "string" && oauth.accessToken && typeof oauth.expiresAt === "number" && oauth.expiresAt > Date.now()) return directJsonCaller(oauth.accessToken, ports.model, ports.request);
    }
    unavailable.push(selected.account.accountId);
  }
}

function profileCaller(caller: JsonCaller, model: string): ProfileCaller {
  return async (input, locale) => {
    const result = await caller({ prompt: profilePrompt(input, locale), schema: profileSchema(input.scope === OVERALL_SCOPE),
      maxTokens: model === MEMORY_PROFILE_MODEL ? (input.scope === OVERALL_SCOPE ? 8192 : 4096)
        : model === MEMORY_PROFILE_FALLBACK_MODEL ? (input.scope === OVERALL_SCOPE ? 4096 : 2048) : 650 });
    return { answer: result.answer, model: result.model };
  };
}

export async function prepareProfileCaller(project: string, ports: AccountPorts = { model: MEMORY_PROFILE_MODEL }): Promise<ProfileCaller> {
  // Share admission across parallel slices, but keep failure and attribution per request.
  let primary: Promise<JsonCaller> | undefined;
  let fallback: Promise<JsonCaller> | undefined;
  return async (input, locale) => {
    try {
      const caller = await (primary ??= prepareJsonCaller(project, ports));
      return await profileCaller(caller, ports.model)(input, locale);
    } catch (error) {
      if (ports.model !== MEMORY_PROFILE_MODEL || !(error instanceof MemoryProfileError) || !["account", "failed", "timeout"].includes(error.code)) throw error;
      const caller = await (fallback ??= prepareJsonCaller(project, { ...ports, model: MEMORY_PROFILE_FALLBACK_MODEL }));
      return profileCaller(caller, MEMORY_PROFILE_FALLBACK_MODEL)(input, locale);
    }
  };
}
