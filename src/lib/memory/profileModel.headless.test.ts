import { expect, test } from "bun:test";
import { prepareJsonCaller, MEMORY_PROFILE_MODEL } from "./profileModel";
import type { AccountContext } from "@/lib/accounts/contracts";

test("memory JSON uses the admitted headless account without reading its subscription token", async () => {
  const account: AccountContext = { engine: "claude", accountId: "sample", kind: "managed", home: "sample-home", transcriptRoot: "sample-projects", env: { NODE_ENV: "test" } };
  let invoked = false;
  const ports = {
    model: MEMORY_PROFILE_MODEL,
    manager: { resolveHeadlessSpawn: () => ({ kind: "available" as const, account }) },
    credentials: () => { throw Error("subscription token must stay inside Claude Code"); },
    run: async () => { invoked = true; return { status: "done" as const, records: [{ type: "result", subtype: "success", is_error: false, structured_output: { summary: "A complete sentence." }, usage: { input_tokens: 12, output_tokens: 7 } }] }; },
  };
  const call = await prepareJsonCaller("sample-project", ports);
  expect(await call({ prompt: "Summarize fixture", schema: { type: "object" }, maxTokens: 2048 })).toMatchObject({ answer: { summary: "A complete sentence." }, model: MEMORY_PROFILE_MODEL, inputTokens: 12, outputTokens: 7 });
  expect(invoked).toBe(true);
});
