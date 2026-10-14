import { describe, expect, test } from "bun:test";
import { directJsonCaller, directProfileCaller, MEMORY_PROFILE_MODEL, MEMORY_PROFILE_FALLBACK_MODEL, prepareJsonCaller, prepareProfileCaller, type ProfileFetch } from "./profileModel";
import type { AccountContext } from "@/lib/accounts/contracts";
import { profileInputs } from "./profile";
import { sampleAnswer, sampleMemory } from "./profile.fixture";

describe("direct profile request", () => {
  for (const [model, ceilings] of [[MEMORY_PROFILE_MODEL, [8192, 4096]], [MEMORY_PROFILE_FALLBACK_MODEL, [4096, 2048]]] as const) {
    test(`${model}: overall and slice ceilings leave space for thinking and prose`, async () => {
      for (const [index, input] of profileInputs(sampleMemory()).slice(0, 2).entries()) {
        const call = directProfileCaller("sample", model, async (_, init) => {
          const body = JSON.parse(init.body as string);
          expect(body.max_tokens).toBe(ceilings[index]);
          expect(body.output_config.effort).toBe("low");
          return Response.json({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(sampleAnswer()) }] });
        });
        expect(await call(input, "en")).toEqual({ answer: sampleAnswer(), model });
      }
    });
  }
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
      await expect(call(input, "en")).resolves.toMatchObject({ answer: sampleAnswer(), model: MEMORY_PROFILE_MODEL });
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
    await expect(call(profileInputs(sampleMemory())[0]!, "en")).resolves.toMatchObject({ answer: sampleAnswer(), model: MEMORY_PROFILE_MODEL });
  });
  test("selects the catalogue's Opus 5.5 and forwards its pinned Messages id", async () => {
    expect(MEMORY_PROFILE_MODEL).toBe("claude-opus-5-5");
    const call = directProfileCaller("sample", MEMORY_PROFILE_MODEL, async (_, init) => {
      const payload = JSON.parse(init.body as string);
      expect(payload.model).toBe("claude-opus-5-5");
      expect(payload.output_config.effort).toBe("low");
      return Response.json({ stop_reason: "end_turn", content: [{ type: "thinking", thinking: "", signature: "sample" }, { type: "redacted_thinking", data: "sample" }, { type: "text", text: JSON.stringify(sampleAnswer()) }] });
    });
    await expect(call(profileInputs(sampleMemory())[0]!, "en")).resolves.toMatchObject({ answer: sampleAnswer(), model: MEMORY_PROFILE_MODEL });
  });
  test("keeps project admission when excluding provider and expired accounts", async () => {
    const requested: string[][] = [];
    const context = (accountId: string): AccountContext => ({ engine: "claude", accountId, kind: "managed", home: accountId, transcriptRoot: "sample", env: { NODE_ENV: "test" } });
    const accounts = [{ ...context("provider"), claudeProvider: { baseUrl: "https://provider.example", model: "sample", smallFastModel: null } }, context("expired"), context("ready")];
    const caller = await prepareProfileCaller("garden", {
      model: "haiku", request: async () => { throw new Error("fixture refusal"); }, manager: { resolveHeadlessSpawn: (_engine, _requested, _excluded, project, model, unavailable = []) => {
        expect(project).toBe("garden"); expect(model).toBe("haiku"); requested.push([...unavailable]);
        const account = accounts.find(account => !unavailable.includes(account.accountId));
        return account ? { kind: "available", account } : { kind: "unavailable" };
      } },
      credentials: home => ({ state: "present", source: "file", document: { claudeAiOauth: { accessToken: "sample", expiresAt: home === "expired" ? 0 : Date.now() + 60_000 } } }),
    });
    await expect(caller(profileInputs(sampleMemory())[0]!, "en")).rejects.toThrow();
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
    expect(answer).toMatchObject({ answer: sampleAnswer(), model: "another-model" });
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

const available: AccountContext = { engine: "claude", accountId: "sample-account", kind: "managed", home: "sample-home", transcriptRoot: "sample", env: { NODE_ENV: "test" } };
function profilePorts(request: ProfileFetch, admitted: (model: string) => boolean = () => true) {
  return { model: MEMORY_PROFILE_MODEL, request,
    manager: { resolveHeadlessSpawn: (_engine: unknown, _requested: unknown, _excluded: unknown, project: string | null | undefined, model: string | null | undefined) => {
      expect(project).toBe("garden");
      return admitted(model!) ? { kind: "available" as const, account: available } : { kind: "unavailable" as const };
    } },
    credentials: () => ({ state: "present" as const, source: "file" as const, document: { claudeAiOauth: { accessToken: "sample", expiresAt: Date.now() + 60_000 } } }),
  };
}
const success = () => Response.json({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(sampleAnswer()) }] });
describe("Opus profile fallback", () => {
  for (const failure of ["admission", "401", "403", "429", "provider", "refusal", "timeout", "body-timeout"] as const) {
    test(`${failure}: falls back once and attributes the answer to Haiku`, async () => {
      const models: string[] = [];
      const caller = await prepareProfileCaller("garden", profilePorts(async (_, init) => {
        const { model } = JSON.parse(init.body as string); models.push(model);
        if (model === MEMORY_PROFILE_FALLBACK_MODEL) return success();
        if (failure === "timeout") throw new DOMException("private response", "TimeoutError");
        if (failure === "body-timeout") {
          const response = success(); response.json = async () => { throw new DOMException("private response", "AbortError"); }; return response;
        }
        if (failure === "refusal") return Response.json({ stop_reason: "refusal", content: [] });
        return new Response("private response", { status: failure === "provider" ? 503 : Number(failure) });
      }, model => failure !== "admission" || model !== MEMORY_PROFILE_MODEL));
      expect(await caller(profileInputs(sampleMemory())[0]!, "en")).toMatchObject({ answer: sampleAnswer(), model: MEMORY_PROFILE_FALLBACK_MODEL });
      expect(models).toEqual(failure === "admission" ? [MEMORY_PROFILE_FALLBACK_MODEL] : [MEMORY_PROFILE_MODEL, MEMORY_PROFILE_FALLBACK_MODEL]);
    });
  }
  test("successful Opus never admits or requests Haiku", async () => {
    const models: string[] = [];
    const caller = await prepareProfileCaller("garden", profilePorts(async () => success(), model => { models.push(model); return true; }));
    expect((await caller(profileInputs(sampleMemory())[0]!, "en")).model).toBe(MEMORY_PROFILE_MODEL);
    expect(models).toEqual([MEMORY_PROFILE_MODEL]);
  });
  test("a failed fallback propagates without a third request", async () => {
    const models: string[] = [];
    const caller = await prepareProfileCaller("garden", profilePorts(async (_, init) => {
      models.push(JSON.parse(init.body as string).model); return new Response(null, { status: 429 });
    }));
    await expect(caller(profileInputs(sampleMemory())[0]!, "en")).rejects.toThrow("account");
    expect(models).toEqual([MEMORY_PROFILE_MODEL, MEMORY_PROFILE_FALLBACK_MODEL]);
  });
  test("invalid and truncated answers retain validation failure without fallback", async () => {
    for (const stop_reason of ["end_turn", "max_tokens"]) {
      let calls = 0;
      const caller = await prepareProfileCaller("garden", profilePorts(async () => {
        calls++; return Response.json({ stop_reason, content: [{ type: "text", text: "{" }] });
      }));
      await expect(caller(profileInputs(sampleMemory())[0]!, "en")).rejects.toThrow("invalid");
      expect(calls).toBe(1);
    }
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

test("call summaries exclude legacy homes while profile admission keeps its existing default", async () => {
  const legacy: AccountContext = { engine:"claude",accountId:"legacy-one",kind:"legacy",home:"legacy-home",transcriptRoot:"sample",env:{NODE_ENV:"test"} };
  const managed: AccountContext = { ...legacy,accountId:"managed-one",kind:"managed",home:"managed-home" };
  for (const managedOnly of [false,true]) {
    const read: string[] = [];
    await prepareJsonCaller("garden",{ model:MEMORY_PROFILE_MODEL,
      manager:{resolveHeadlessSpawn:(_engine,_requested,_excluded,_project,_model,unavailable=[]) => {
        const account = [legacy,managed].find(row => !unavailable.includes(row.accountId)); return account ? {kind:"available",account} : {kind:"unavailable"};
      }},credentials:home => { read.push(home); return {state:"present",source:"file",document:{claudeAiOauth:{accessToken:"sample",expiresAt:Date.now()+60000}}}; }
    },managedOnly);
    expect(read).toEqual([managedOnly ? "managed-home" : "legacy-home"]);
  }
});
