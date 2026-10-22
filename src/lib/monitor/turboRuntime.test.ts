import { afterEach, expect, test } from "bun:test";
import { kickTurbo } from "./turboRuntime";

const previousOwner = process.env.LLV_STATE_OWNER;
afterEach(() => {
  if (previousOwner === undefined) delete process.env.LLV_STATE_OWNER;
  else process.env.LLV_STATE_OWNER = previousOwner;
});

test("MCP-owned process without PORT cannot run the Viewer Turbo host sweep", async () => {
  process.env.LLV_STATE_OWNER = "mcp";
  delete process.env.PORT;
  await expect(kickTurbo("turbo-owner-fixture")).resolves.toBeUndefined();
});
