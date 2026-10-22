import { accountManager } from "@/lib/accounts/manager";
import type { AccountManager } from "@/lib/accounts/contracts";
import { runHeadlessClaudeOnce } from "@/lib/agent/claudeHeadless";
import { MemoryProfileError, OVERALL_SCOPE, profilePrompt, profileSchema, type ProfileInput } from "./profile";
import type { Locale } from "@/lib/i18n/core";

// The approved model is pinned; catalogue absence must never select an older model.
export const MEMORY_PROFILE_MODEL = "claude-opus-5-5";
export const MEMORY_PROFILE_FALLBACK_MODEL = "claude-haiku-5-5";
export type ProfileResult = Pick<JsonAnswer, "answer" | "model">;
export type ProfileCaller = (input: ProfileInput, locale: Locale) => Promise<ProfileResult>;

export interface JsonRequest { prompt: string; schema: object; maxTokens: number; deadlineMs?: number }
export interface JsonAnswer { answer: unknown; durationMs: number; inputTokens: number; outputTokens: number; model: string }
export type JsonCaller = (input: JsonRequest) => Promise<JsonAnswer>;
type AccountPorts = { manager?: Pick<AccountManager, "resolveHeadlessSpawn">; model: string; run?: typeof runHeadlessClaudeOnce };
export async function prepareJsonCaller(project: string, ports: AccountPorts = { model: MEMORY_PROFILE_MODEL }, managedOnly = false): Promise<JsonCaller> {
  const manager = ports.manager ?? accountManager;
  return async input => {
    const started = performance.now();
    const unavailable: string[] = [];
    let account;
    while (true) {
      const selected = manager.resolveHeadlessSpawn("claude", null, [], project, ports.model, unavailable);
      if (selected.kind !== "available" || unavailable.includes(selected.account.accountId)) throw new MemoryProfileError("account");
      if (!selected.account.claudeProvider && (!managedOnly || selected.account.kind === "managed")) { account = selected.account; break; }
      unavailable.push(selected.account.accountId);
    }
    const selectedAccount = account;
    try {
      const result = await (ports.run ?? runHeadlessClaudeOnce)({ account, model: ports.model, prompt: input.prompt,
        schema: input.schema, maxTokens: input.maxTokens, timeoutMs: input.deadlineMs ?? 30_000,
        authorized: () => {
          const current = manager.resolveHeadlessSpawn("claude", selectedAccount.accountId, [], project, ports.model);
          return current.kind === "available" && current.account.home === selectedAccount.home && current.account.accountId === selectedAccount.accountId && !current.account.claudeProvider && (!managedOnly || current.account.kind === "managed");
        } });
      if (result.status !== "done") throw new MemoryProfileError(result.status === "timeout" ? "timeout" : "failed");
      const answer = result.records.filter(row => row.type === "result").at(-1);
      if (!answer || answer.is_error === true || answer.subtype !== "success") throw new MemoryProfileError("failed");
      // CLI schemas validate at generation; profile and call-memory consumers
      // retain their stricter language, length and content validation.
      const value = answer.structured_output ?? (typeof answer.result === "string" ? JSON.parse(answer.result) : undefined);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new MemoryProfileError("invalid");
      const usage = answer.usage as Record<string, number> | undefined;
      return { answer: value, durationMs: performance.now() - started, inputTokens: usage?.input_tokens ?? 0, outputTokens: usage?.output_tokens ?? 0, model: ports.model };
    } catch (error) {
      if (error instanceof MemoryProfileError) throw error;
      throw new MemoryProfileError(error instanceof SyntaxError ? "invalid" : "failed");
    }
  };
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
