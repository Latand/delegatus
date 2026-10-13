import { describe, expect, test } from "bun:test";
import { directJsonCaller, directProfileCaller, MEMORY_PROFILE_MODEL, prepareProfileCaller, type ProfileFetch } from "./profileModel";
import type { AccountContext } from "@/lib/accounts/contracts";
import { profileInputs } from "./profile";
import { sampleAnswer, sampleMemory } from "./profile.fixture";

describe("direct profile request", () => {
  test("leaves room for thinking before a complete structured answer", async () => {
    for (const input of profileInputs(sampleMemory()).slice(0, 2)) {
      const call = directProfileCaller("sample", MEMORY_PROFILE_MODEL, async (_, init) => {
        const payload = JSON.parse(init.body as string);
        const complete = payload.max_tokens >= 1200 + 256;
        return Response.json({ stop_reason: complete ? "end_turn" : "max_tokens", content: [
          { type: "thinking", thinking: "", signature: "sample" },
          { type: "text", text: complete ? JSON.stringify(sampleAnswer()) : "{" },
        ] });
      });
      await expect(call(input, "en")).resolves.toEqual(sampleAnswer());
    }
  });
  test("subscription requests carry the client identity required for model admission", async () => {
    const call = directProfileCaller("sample", MEMORY_PROFILE_MODEL, async (url, init) => {
      expect(url).toBe("https://api.anthropic.com/v1/messages");
      const headers = new Headers(init.headers);
      expect(headers.get("authorization")).toBe("Bearer sample");
      expect(headers.has("x-api-key")).toBe(false);
      expect(headers.get("anthropic-beta")?.split(",")).toContain("oauth-2025-04-20");
      const payload = JSON.parse(init.body as string);
      // The live provider refused the same OAuth request without this identity.
      if (payload.system?.[0]?.text !== "You are Claude Code, Anthropic's official CLI for Claude.") {
        return new Response(null, { status: 429 });
      }
      expect(payload.tools).toBeUndefined();
      return Response.json({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(sampleAnswer()) }] });
    });
    await expect(call(profileInputs(sampleMemory())[0]!, "en")).resolves.toEqual(sampleAnswer());
  });
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
  test("uses structured output and no tools without rewriting the requested model", async () => {
    let payload: Record<string, unknown> = {};
    const call = directProfileCaller("sample", "another-model", (async (_, init) => {
      payload = JSON.parse(init!.body as string);
      expect(init!.redirect).toBe("error"); expect(init!.signal).toBeDefined();
      return Response.json({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(sampleAnswer()) }] });
    }) as ProfileFetch);
    const answer = await call(profileInputs(sampleMemory())[1]!, "en");
    expect(answer).toEqual(sampleAnswer());
    expect(payload.model).toBe("another-model");
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

test("the shared direct caller returns provider usage and a bounded deadline without exposing auth", async () => {
  const caller = directJsonCaller("sample",MEMORY_PROFILE_MODEL,async (_,init) => {
    const payload = JSON.parse(init.body as string);
    expect(payload.max_tokens).toBe(2048); expect(init.signal).toBeDefined();
    expect(payload.messages[0].content).toBe("Summarize invented speech.");
    expect(payload.output_config.format.schema).toEqual({ type:"object" });
    return Response.json({ stop_reason:"end_turn",content:[{ type:"text",text:'{"asked":[]}' }],usage:{ input_tokens:2475,output_tokens:566 } });
  });
  const result = await caller({ prompt:"Summarize invented speech.",schema:{type:"object"},maxTokens:2048,deadlineMs:20000 });
  expect(result).toMatchObject({ answer:{asked:[]},inputTokens:2475,outputTokens:566,model:MEMORY_PROFILE_MODEL });
  expect(result.durationMs).toBeGreaterThanOrEqual(0); expect(JSON.stringify(result)).not.toContain("sample");
});
