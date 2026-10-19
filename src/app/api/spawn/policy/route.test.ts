import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";
import { NextRequest } from "next/server";

const previousStateDir = process.env.LLV_STATE_DIR;
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-spawn-policy-route-"));
process.env.LLV_STATE_DIR = sandbox;

const { GET, PATCH } = await import("./route");

afterAll(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const OPERATOR_HEADERS = {
  host: "127.0.0.1:8898",
  origin: "http://127.0.0.1:8898",
  "sec-fetch-site": "same-origin",
  "content-type": "application/json",
};

function patchRequest(body: unknown, headers: Record<string, string> = OPERATOR_HEADERS): NextRequest {
  return new NextRequest("http://127.0.0.1:8898/api/spawn/policy", {
    method: "PATCH",
    headers,
    body: JSON.stringify(body),
  });
}

test("the effective policy defaults to depth 2 and an operator can change it within bounds", async () => {
  expect(await (await GET()).json()).toEqual({ maxAgentNestingDepth: 2 });

  const updated = await PATCH(patchRequest({ maxAgentNestingDepth: 3 }));
  expect(updated.status).toBe(200);
  expect(await updated.json()).toEqual({ maxAgentNestingDepth: 3 });
  expect(await (await GET()).json()).toEqual({ maxAgentNestingDepth: 3 });

  const outOfBounds = await PATCH(patchRequest({ maxAgentNestingDepth: 5 }));
  expect(outOfBounds.status).toBe(400);
  expect(await outOfBounds.json()).toEqual({ error: expect.stringContaining("between 1 and 4") });
  expect(await (await GET()).json()).toEqual({ maxAgentNestingDepth: 3 });
  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.mkdirSync(sandbox, { recursive: true });
});

test("agent-initiated callers can never raise their own ceiling", async () => {
  const response = await PATCH(patchRequest(
    { maxAgentNestingDepth: 4 },
    { host: "127.0.0.1:8898", "content-type": "application/json" },
  ));

  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: expect.stringContaining("operator") });
  expect(await (await GET()).json()).toEqual({ maxAgentNestingDepth: 2 });
});
