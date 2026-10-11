import { ENGINE_MODELS } from "@/lib/agent/models";
import { accountManager } from "@/lib/accounts/manager";
import type { AccountManager } from "@/lib/accounts/contracts";
import { readClaudeCredentials } from "@/lib/accounts/claudeCredentials";
import { MemoryProfileError, OVERALL_SCOPE, profilePrompt, profileSchema, type ProfileInput } from "./profile";
import type { Locale } from "@/lib/i18n/core";

// The catalogue lane owns the new model. This feature never changes that catalogue.
export const MEMORY_PROFILE_MODEL = ENGINE_MODELS.claude.find(model => model.id === "claude-haiku-5-5")?.id ?? "haiku";
// Messages rejected the bare `haiku` alias with a 404; use the verified concrete target.
const HAIKU_ALIAS_TARGET = "claude-haiku-4-5-20251001";
export type ProfileCaller = (input: ProfileInput, locale: Locale) => Promise<unknown>;
export type ProfileFetch = (url: string, init: RequestInit) => Promise<Response>;

/** One Messages request, no tools or agent session. Secrets never leave this closure. */
export function directProfileCaller(oauthToken: string, model: string, request: ProfileFetch = fetch): ProfileCaller {
  return async (input, locale) => {
    let response: Response;
    try {
      response = await request("https://api.anthropic.com/v1/messages", {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
        headers: { authorization: `Bearer ${oauthToken}`, "anthropic-version": "2023-06-01", "anthropic-beta": "oauth-2025-04-20", "content-type": "application/json" },
        body: JSON.stringify({ model: model === "haiku" ? HAIKU_ALIAS_TARGET : model,
          max_tokens: input.scope === OVERALL_SCOPE ? 1100 : 650,
          messages: [{ role: "user", content: profilePrompt(input, locale) }],
          output_config: { ...(model === "claude-haiku-5-5" ? { effort: "low" } : {}), format: { type: "json_schema", schema: profileSchema(input.scope === OVERALL_SCOPE) } },
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
      const body = await response.json() as { stop_reason?: string; content?: { type: string; text?: string }[] };
      if (body.stop_reason !== "end_turn" || !Array.isArray(body.content) || body.content.some(part => !["text", "thinking", "redacted_thinking"].includes(part.type))) throw new MemoryProfileError("invalid");
      return JSON.parse(body.content.filter(part => part.type === "text").map(part => part.text ?? "").join(""));
    } catch { throw new MemoryProfileError("invalid"); }
  };
}

type AccountPorts = { manager: Pick<AccountManager, "resolveHeadlessSpawn">; credentials: typeof readClaudeCredentials; model: string };
export async function prepareProfileCaller(project: string, ports: AccountPorts = { manager: accountManager, credentials: readClaudeCredentials, model: MEMORY_PROFILE_MODEL }): Promise<ProfileCaller> {
  const unavailable: string[] = [];
  while (true) {
    const selected = ports.manager.resolveHeadlessSpawn("claude", null, [], project, ports.model, unavailable);
    if (selected.kind !== "available" || unavailable.includes(selected.account.accountId)) throw new MemoryProfileError("account");
    if (!selected.account.claudeProvider) {
      const credentials = ports.credentials(selected.account.home);
      const oauth = credentials.state === "present" ? credentials.document.claudeAiOauth : null;
      if (typeof oauth?.accessToken === "string" && oauth.accessToken && typeof oauth.expiresAt === "number" && oauth.expiresAt > Date.now()) return directProfileCaller(oauth.accessToken, ports.model);
    }
    unavailable.push(selected.account.accountId);
  }
}
