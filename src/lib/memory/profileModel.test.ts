import { describe, expect, test } from "bun:test";
import { directProfileCaller, MEMORY_PROFILE_MODEL, prepareProfileCaller, type ProfileFetch } from "./profileModel";
import type { AccountContext } from "@/lib/accounts/contracts";
import { profileInputs } from "./profile";
import { sampleAnswer, sampleMemory } from "./profile.fixture";

describe("direct profile request", () => {
  test("selects the catalogue's Haiku 5.5 and forwards its pinned Messages id", async () => {
    expect(MEMORY_PROFILE_MODEL).toBe("claude-haiku-5-5");
    const call = directProfileCaller("sample", MEMORY_PROFILE_MODEL, async (_, init) => {
      const payload = JSON.parse(init.body as string);
      expect(payload.model).toBe("claude-haiku-5-5");
      expect(payload.output_config.effort).toBe("low");
      return Response.json({ stop_reason: "end_turn", content: [{ type: "thinking", thinking: "", signature: "sample" }, { type: "redacted_thinking", data: "sample" }, { type: "text", text: JSON.stringify(sampleAnswer()) }] });
    });
    await expect(call(profileInputs(sampleMemory())[0]!, "en")).resolves.toEqual(sampleAnswer());
  });
  test("keeps project admission when excluding provider and expired accounts", async () => {
    const requested: string[][] = [];
    const context = (accountId: string): AccountContext => ({ engine: "claude", accountId, kind: "managed", home: accountId, transcriptRoot: "sample", env: { NODE_ENV: "test" } });
    const accounts = [{ ...context("provider"), claudeProvider: { baseUrl: "https://provider.example", model: "sample", smallFastModel: null } }, context("expired"), context("ready")];
    const caller = await prepareProfileCaller("garden", {
      model: "haiku", manager: { resolveHeadlessSpawn: (_engine, _requested, _excluded, project, model, unavailable = []) => {
        expect(project).toBe("garden"); expect(model).toBe("haiku"); requested.push([...unavailable]);
        const account = accounts.find(account => !unavailable.includes(account.accountId));
        return account ? { kind: "available", account } : { kind: "unavailable" };
      } },
      credentials: home => ({ state: "present", source: "file", document: { claudeAiOauth: { accessToken: "sample", expiresAt: home === "expired" ? 0 : Date.now() + 60_000 } } }),
    });
    expect(typeof caller).toBe("function"); expect(requested).toEqual([[], ["provider"], ["provider", "expired"]]);
  });
  test("uses structured output, a concrete alias target and no tools", async () => {
    let payload: Record<string, unknown> = {};
    const call = directProfileCaller("sample", "haiku", (async (_, init) => {
      payload = JSON.parse(init!.body as string);
      expect(init!.redirect).toBe("error"); expect(init!.signal).toBeDefined();
      return Response.json({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(sampleAnswer()) }] });
    }) as ProfileFetch);
    const answer = await call(profileInputs(sampleMemory())[1]!, "en");
    expect(answer).toEqual(sampleAnswer());
    expect(payload.model).toBe("claude-haiku-4-5-20251001");
    expect(payload.tools).toBeUndefined();
    expect(payload.max_tokens).toBe(650);
    expect(payload.output_config).toHaveProperty("format.type", "json_schema");
    expect(payload.output_config).not.toHaveProperty("effort");
  });
  test("never stores truncated or non-JSON output and sanitizes account failures", async () => {
    const input = profileInputs(sampleMemory())[0]!;
    const truncated = directProfileCaller("sample", "future-model", (async () => Response.json({ stop_reason: "max_tokens", content: [] })) as ProfileFetch);
    await expect(truncated(input, "uk")).rejects.toThrow("invalid");
    const tool = directProfileCaller("sample", "future-model", async () => Response.json({ stop_reason: "end_turn", content: [{ type: "tool_use" }, { type: "text", text: JSON.stringify(sampleAnswer()) }] }));
    await expect(tool(input, "en")).rejects.toThrow("invalid");
    const refused = directProfileCaller("sample", "haiku", (async () => new Response("private response", { status: 429 })) as ProfileFetch);
    await expect(refused(input, "uk")).rejects.toThrow("account");
    const timedOut = directProfileCaller("sample", "haiku", (async () => { throw new DOMException("private response", "TimeoutError"); }) as ProfileFetch);
    await expect(timedOut(input, "uk")).rejects.toThrow("timeout");
  });
});
