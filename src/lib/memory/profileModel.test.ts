import { describe, expect, test } from "bun:test";
import { MEMORY_PROFILE_MODEL, MEMORY_PROFILE_FALLBACK_MODEL, prepareJsonCaller, prepareProfileCaller } from "./profileModel";
import type { AccountContext } from "@/lib/accounts/contracts";
import type { ClaudeHeadlessRequest, ClaudeHeadlessResult } from "@/lib/agent/claudeHeadless";
import { profileInputs, validateProfileAnswer } from "./profile";
import { sampleAnswer, sampleMemory } from "./profile.fixture";

const available: AccountContext = { engine: "claude", accountId: "sample-account", kind: "managed", home: "sample-home", transcriptRoot: "sample", env: { NODE_ENV: "test" } };
const success = (answer: unknown = sampleAnswer()): ClaudeHeadlessResult => ({ status: "done", records: [{ type: "result", subtype: "success", is_error: false, structured_output: answer, usage: { input_tokens: 2475, output_tokens: 566 } }] });
function profilePorts(run: (request: ClaudeHeadlessRequest) => Promise<ClaudeHeadlessResult>, admitted: (model: string) => boolean = () => true) {
  return { model: MEMORY_PROFILE_MODEL, run,
    manager: { resolveHeadlessSpawn: (_engine: unknown, _requested: unknown, _excluded: unknown, project: string | null | undefined, model: string | null | undefined) => {
      expect(project).toBe("garden");
      return admitted(model!) ? { kind: "available" as const, account: available } : { kind: "unavailable" as const };
    } },
  };
}
describe("headless memory profile", () => {
  for (const [model, ceilings] of [[MEMORY_PROFILE_MODEL, [8192, 4096]], [MEMORY_PROFILE_FALLBACK_MODEL, [4096, 2048]]] as const) {
    test(`${model}: fixture quality and schema validation remain equivalent in both languages`, async () => {
      for (const locale of ["en", "uk"] as const) for (const [index, input] of profileInputs(sampleMemory()).slice(0, 2).entries()) {
        const caller = await prepareProfileCaller("garden", { ...profilePorts(async request => {
          expect(request.model).toBe(model); expect(request.maxTokens).toBe(ceilings[index]);
          expect(request.timeoutMs).toBe(30000); expect(request.schema).toHaveProperty("type", "object");
          expect(request.authorized?.()).toBe(true);
          return success(sampleAnswer(locale === "uk"));
        }), model });
        const result = await caller(input, locale);
        expect(validateProfileAnswer(result.answer, input, locale)).toEqual(validateProfileAnswer(sampleAnswer(locale === "uk"), input, locale));
        expect(result.model).toBe(model);
      }
    });
  }
  for (const failure of ["admission", "exit", "refusal", "timeout"] as const) {
    test(`${failure}: falls back once and attributes the answer to Haiku`, async () => {
      const models: string[] = [];
      const caller = await prepareProfileCaller("garden", profilePorts(async request => {
        models.push(request.model!);
        if (request.model === MEMORY_PROFILE_FALLBACK_MODEL) return success();
        if (failure === "refusal") return { status: "done", records: [{ type: "result", subtype: "error_during_execution", is_error: true, result: "private provider detail" }] };
        return { status: failure === "timeout" ? "timeout" : "failed", records: [] };
      }, model => failure !== "admission" || model !== MEMORY_PROFILE_MODEL));
      expect(await caller(profileInputs(sampleMemory())[0]!, "en")).toMatchObject({ answer: sampleAnswer(), model: MEMORY_PROFILE_FALLBACK_MODEL });
      expect(models).toEqual(failure === "admission" ? [MEMORY_PROFILE_FALLBACK_MODEL] : [MEMORY_PROFILE_MODEL, MEMORY_PROFILE_FALLBACK_MODEL]);
    });
  }
  test("successful Opus never requests Haiku", async () => {
    const models: string[] = [];
    const caller = await prepareProfileCaller("garden", profilePorts(async request => { models.push(request.model!); return success(); }));
    expect((await caller(profileInputs(sampleMemory())[0]!, "en")).model).toBe(MEMORY_PROFILE_MODEL);
    expect(models).toEqual([MEMORY_PROFILE_MODEL]);
  });
  test("a failed fallback propagates without a third request or private output", async () => {
    const models: string[] = [];
    const caller = await prepareProfileCaller("garden", profilePorts(async request => { models.push(request.model!); throw Error("private provider detail"); }));
    await expect(caller(profileInputs(sampleMemory())[0]!, "en")).rejects.toThrow("failed");
    expect(models).toEqual([MEMORY_PROFILE_MODEL, MEMORY_PROFILE_FALLBACK_MODEL]);
  });
  test("truncated JSON is invalid and does not trigger a fallback", async () => {
    let calls = 0;
    const caller = await prepareProfileCaller("garden", profilePorts(async () => { calls++; return { status: "done", records: [{ type: "result", subtype: "success", result: "{" }] }; }));
    await expect(caller(profileInputs(sampleMemory())[0]!, "en")).rejects.toThrow("invalid");
    expect(calls).toBe(1);
  });
});

test("call summaries retain usage and their shorter deadline", async () => {
  const caller = await prepareJsonCaller("garden", profilePorts(async request => {
    expect(request.prompt).toBe("Summarize invented speech."); expect(request.timeoutMs).toBe(20000);
    expect(request.maxTokens).toBe(2048); return success({ asked: [] });
  }), true);
  expect(await caller({ prompt: "Summarize invented speech.", schema: { type: "object" }, maxTokens: 2048, deadlineMs: 20000 })).toMatchObject({ answer: { asked: [] }, inputTokens: 2475, outputTokens: 566 });
});
test("call summaries exclude legacy homes and both callers exclude providers", async () => {
  const legacy: AccountContext = { ...available, accountId: "legacy-one", kind: "legacy", home: "legacy-home" };
  const managed: AccountContext = { ...available, accountId: "managed-one" };
  const provider: AccountContext = { ...available, accountId: "provider-one", claudeProvider: { baseUrl: "https://example.invalid", model: "sample", smallFastModel: null } };
  for (const managedOnly of [false, true]) {
    let picked = "";
    const call = await prepareJsonCaller("garden", { model: MEMORY_PROFILE_MODEL,
      manager: { resolveHeadlessSpawn: (_engine, _requested, _excluded, _project, _model, unavailable = []) => {
        const account = [provider, legacy, managed].find(row => !unavailable.includes(row.accountId)); return account ? { kind: "available", account } : { kind: "unavailable" };
      } }, run: async request => { picked = request.account.home; return success(); },
    }, managedOnly);
    await call({ prompt: "Fixture", schema: {}, maxTokens: 2048 });
    expect(picked).toBe(managedOnly ? managed.home : legacy.home);
  }
});
test("account admission is checked again for every invocation and before dispatch", async () => {
  let allowed = true; let calls = 0;
  const ports = profilePorts(async request => { calls++; allowed = false; expect(request.authorized?.()).toBe(false); return { status: "failed", records: [] }; }, () => allowed);
  const call = await prepareJsonCaller("garden", ports);
  await expect(call({ prompt: "Fixture", schema: {}, maxTokens: 2048 })).rejects.toThrow("failed");
  await expect(call({ prompt: "Fixture", schema: {}, maxTokens: 2048 })).rejects.toThrow("account");
  expect(calls).toBe(1);
});
