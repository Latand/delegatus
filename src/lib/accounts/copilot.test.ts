import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeEach, expect, test } from "bun:test";

import {
  activeCopilotAccountId,
  copilotAccountForSpawn,
  copilotLoginCommand,
  copilotSessionRoots,
  createManagedCopilotAccount,
  listCopilotAccounts,
  NoCopilotAccountError,
  setActiveCopilotAccount,
} from "./copilot";

/* Every path here lives in a throw-away state directory (#1905). */
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-copilot-accounts-"));
const previous = { state: process.env.LLV_STATE_DIR, home: process.env.COPILOT_HOME };
afterAll(() => {
  if (previous.state === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous.state;
  if (previous.home === undefined) delete process.env.COPILOT_HOME; else process.env.COPILOT_HOME = previous.home;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

let run = 0;
beforeEach(() => {
  run += 1;
  process.env.LLV_STATE_DIR = path.join(sandbox, `run-${run}`, "agent-log-viewer", "state");
  process.env.COPILOT_HOME = path.join(sandbox, `run-${run}`, "legacy-copilot-absent");
});

test("with no account set up a launch is refused, never pointed at a guessed home", () => {
  expect(listCopilotAccounts()).toEqual([]);
  expect(activeCopilotAccountId()).toBeNull();
  expect(() => copilotAccountForSpawn(null)).toThrow(NoCopilotAccountError);
});

test("a managed account is its own 0700 COPILOT_HOME and becomes the default", () => {
  const account = createManagedCopilotAccount("Copilot Free");
  expect(account).toMatchObject({ id: "copilot-free", kind: "managed" });
  expect(account.home).toBe(path.join(path.dirname(process.env.LLV_STATE_DIR!), "accounts", "copilot", "copilot-free"));
  expect(fs.statSync(account.home).mode & 0o777).toBe(0o700);
  expect(account.sessionStateDir).toBe(path.join(account.home, "session-state"));
  expect(activeCopilotAccountId()).toBe("copilot-free");
  const context = copilotAccountForSpawn(null);
  expect(context).toMatchObject({ engine: "copilot", accountId: "copilot-free", kind: "managed", home: account.home, transcriptRoot: account.sessionStateDir });
  expect(copilotSessionRoots()).toEqual([account.sessionStateDir]);
});

test("a second account keeps a separate home; selection moves launches onto it", () => {
  const first = createManagedCopilotAccount("Work");
  const second = createManagedCopilotAccount("Work");
  expect(second.id).toBe("work-1");
  expect(second.home).not.toBe(first.home);
  setActiveCopilotAccount(second.id);
  expect(copilotAccountForSpawn(null).home).toBe(second.home);
  expect(copilotAccountForSpawn(first.id).home).toBe(first.home);
});

test("the legacy home is listed when it exists but never picked by default", () => {
  fs.mkdirSync(process.env.COPILOT_HOME!, { recursive: true });
  expect(listCopilotAccounts().map((account) => [account.id, account.kind])).toEqual([["default", "legacy"]]);
  expect(activeCopilotAccountId()).toBeNull();
  setActiveCopilotAccount("default");
  expect(copilotAccountForSpawn(null).home).toBe(path.resolve(process.env.COPILOT_HOME!));
});

test("the login command signs in exactly the account's own home", () => {
  expect(copilotLoginCommand("/srv/fixture/.config/agent-log-viewer/accounts/copilot/work", "/opt/copilot"))
    .toBe("COPILOT_HOME='/srv/fixture/.config/agent-log-viewer/accounts/copilot/work' '/opt/copilot' login --device-code");
});
