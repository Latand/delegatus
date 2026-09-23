import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-copilot-manager-selection-"));
const previousState = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(root, "state");

const { copilotSignedInUser, createManagedCopilotAccount, listCopilotAccounts, setActiveCopilotAccount } = await import("./copilot");
const { accountManager, resolveContinuityAccount, resolveHealthySpawnAccount } = await import("./manager");
const { agentRegistry } = await import("@/lib/agent/registry");

afterAll(() => {
  if (previousState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousState;
  fs.rmSync(root, { recursive: true, force: true });
});

function signIn(home: string): void {
  fs.writeFileSync(path.join(home, "config.json"), `// Copilot config\n${JSON.stringify({
    lastLoggedInUser: { host: "github.com", login: "placeholder" },
    loggedInUsers: [{ host: "github.com", login: "placeholder" }],
  })}`);
}

test("Copilot config login parsing requires the last user to remain in loggedInUsers", () => {
  const home = path.join(root, "config-fixture");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "config.json"), `// Copilot config\n${JSON.stringify({
    lastLoggedInUser: { host: "github.com", login: "placeholder" },
    loggedInUsers: [{ host: "github.com", login: "placeholder" }],
  })}`);
  expect(copilotSignedInUser(home)).toBe("placeholder");
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({
    lastLoggedInUser: { host: "github.com", login: "placeholder" },
    loggedInUsers: [],
  }));
  expect(copilotSignedInUser(home)).toBeNull();
  fs.writeFileSync(path.join(home, "config.json"), "malformed");
  expect(copilotSignedInUser(home)).toBeNull();
  expect(copilotSignedInUser(path.join(root, "missing"))).toBeNull();
});

test("Copilot chooses its active authenticated account before quota observations exist", () => {
  const first = createManagedCopilotAccount("first");
  const second = createManagedCopilotAccount("second");
  signIn(first.home);
  signIn(second.home);
  setActiveCopilotAccount(first.id);
  expect(accountManager.resolveHeadlessSpawn("copilot", null, [], null).kind).toBe("available");
  expect(accountManager.resolveHeadlessSpawn("copilot", null, [], null)).toMatchObject({ account: { accountId: first.id } });
});

test("Copilot skips a fresh exhausted account and picks the account with headroom", async () => {
  const accounts = agentRegistry();
  const [first, second] = listCopilotAccounts().filter((account) => account.kind === "managed");
  const now = Date.now();
  const observation = (accountId: string, usedPercent: number) => ({
    engine: "copilot" as const,
    accountId,
    authenticated: true,
    authCheckedAt: new Date(now).toISOString(),
    observedAt: new Date(now).toISOString(),
    bootId: "quota-selection",
    limits: { session: null, weekly: { usedPercent, resetsAt: Math.floor(now / 1000) + 86_400, windowMinutes: 43_200 }, tiers: [], plan: null, capturedAt: Math.floor(now / 1000) },
    provenance: { source: "transcript" as const, reason: null, staleSince: null },
  });
  accounts.recordQuotaObservation(observation(first!.id, 100));
  accounts.recordQuotaObservation(observation(second!.id, 10));
  setActiveCopilotAccount(first!.id);
  expect(accountManager.resolveHeadlessSpawn("copilot", null, [], null)).toMatchObject({ account: { accountId: second!.id } });
  expect(accountManager.resolveProjectSpawn("copilot", { project: "unbound" })).toMatchObject({ kind: "available", account: { accountId: second!.id } });
  expect(await resolveHealthySpawnAccount("copilot", null, null)).toMatchObject({ accountId: second!.id });
  expect(resolveContinuityAccount("copilot", null, null)).toMatchObject({ accountId: second!.id });
});
