import { afterAll, beforeEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { NextRequest } from "next/server";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-copilot-route-"));
const previous = {
  state: process.env.LLV_STATE_DIR,
  home: process.env.COPILOT_HOME,
  bin: process.env.LLV_COPILOT_BIN,
};
let run = 0;
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
process.env.COPILOT_HOME = path.join(sandbox, "legacy-absent");
process.env.LLV_COPILOT_BIN = "/fixture/copilot";
const { createManagedCopilotAccount } = await import("@/lib/accounts/copilot");
const { CopilotLoginSupervisor, setCopilotLoginSupervisorForTests } = await import("@/lib/accounts/copilotLogin");
const { GET, POST } = await import("./route");
const { GET: getModels } = await import("./models/route");

class FakeChild extends EventEmitter {
  pid = 45678;
  stdout = new PassThrough();
  stderr = new PassThrough();
  signals: NodeJS.Signals[] = [];
  kill(): boolean { return true; }
}

let child: FakeChild;
let accountId: string;

beforeEach(() => {
  run += 1;
  process.env.LLV_STATE_DIR = path.join(sandbox, `run-${run}`, "state");
  process.env.COPILOT_HOME = path.join(sandbox, `run-${run}`, "legacy-absent");
  child = new FakeChild();
  const account = createManagedCopilotAccount("Local sign-in");
  accountId = account.id;
  fs.writeFileSync(path.join(account.home, "config.json"), '// comment\n{"lastLoggedInUser":{"host":"github.com","login":"fixture-user"},"loggedInUsers":[{"host":"github.com","login":"fixture-user"}]}');
  setCopilotLoginSupervisorForTests(new CopilotLoginSupervisor({
    spawn: () => child,
    signalGroup: (processChild, signal) => { if (processChild.pid !== child.pid) throw new Error("wrong child"); child.signals.push(signal); },
    now: Date.now,
    sleep: async () => undefined,
    setTimeout: () => ({ unref() {} } as NodeJS.Timeout),
    clearTimeout: () => undefined,
  }));
});

afterAll(() => {
  setCopilotLoginSupervisorForTests(null);
  if (previous.state === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous.state;
  if (previous.home === undefined) delete process.env.COPILOT_HOME; else process.env.COPILOT_HOME = previous.home;
  if (previous.bin === undefined) delete process.env.LLV_COPILOT_BIN; else process.env.LLV_COPILOT_BIN = previous.bin;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function post(body: Record<string, unknown>, origin = "http://127.0.0.1") {
  return new NextRequest("http://127.0.0.1/api/accounts/copilot", {
    method: "POST",
    headers: { host: "127.0.0.1", origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("GET reports config auth and the active login operation; POST starts device-code login", async () => {
  const before = await GET();
  const initial = await before.json();
  expect(initial.accounts[0]).toMatchObject({ id: accountId, auth: "signed_in", user: "fixture-user", login: null });

  const startedResponse = await POST(post({ action: "login", id: accountId }));
  expect(startedResponse.status).toBe(200);
  const started = await startedResponse.json();
  expect(started.accounts[0].login).toMatchObject({ phase: "starting", operationId: expect.any(String) });

  child.stdout.emit("data", "To authenticate, visit https://github.com/login/device and enter code XXXX-XXXX");
  const live = await (await GET()).json();
  expect(live.accounts[0].login).toMatchObject({ phase: "awaiting_browser", loginUrl: "https://github.com/login/device", userCode: "XXXX-XXXX" });
});

test("cross-origin POST is rejected", async () => {
  const response = await POST(post({ action: "login", id: accountId }, "https://other.invalid"));
  expect(response.status).toBe(403);
  expect(child.pid).toBe(45678);
});

test("cancel-login returns 404 for an id the Copilot supervisor does not own", async () => {
  const response = await POST(post({ action: "cancel-login", operationId: "foreign-operation" }));
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ error: "Copilot login operation was not found" });
});

test("the model endpoint returns the selected account catalogue with auto first", async () => {
  const request = new NextRequest(`http://127.0.0.1/api/accounts/copilot/models?account=${accountId}`, { headers: { host: "127.0.0.1" } });
  const response = await getModels(request);
  const catalog = await response.json();
  expect(response.status).toBe(200);
  expect(catalog).toMatchObject({ accountId, source: "static" });
  expect(catalog.models[0]).toMatchObject({ id: "auto", name: "Auto" });
});
