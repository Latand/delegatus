import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { stubCloudBackend } from "@/lib/pipelines/cloudEnvironment.fixture";
import { prepareCloudEnvironment, cloudEnvironmentSelection } from "./codexCloudEnvironments";
import { setCodexCloudEnvironmentId } from "./settings";

import { cloudEnvironmentTestContext } from "./codexCloudEnvironments.fixture";

const { fixture, restart, cleanup } = cloudEnvironmentTestContext();
afterEach(cleanup);

for (const manual of ["ready", "missing", "mismatched"] as const) test(`legacy manual Cloud selection stays ${manual} through aliases and real restarts`, async () => {
  const f = fixture();
  if (manual !== "missing") f.backend.configs.set("asenvcfg_manual", { id: "asenvcfg_manual",
    repositories: [{ repository_id: "repo-fixture", ref: manual === "mismatched" ? "other" : "main" }],
    version_id: "version-manual", latest_ready_version_id: "version-manual", version_revision: 1, share_settings: "private" });
  expect(setCodexCloudEnvironmentId(f.input.project, "asenvcfg_manual")).toBe(true);
  const { persistProjectAliases } = await import("./aliases");
  expect(persistProjectAliases([{ source: f.input.project, target: "repo-successor", displayName: "Fixture" }])).toBe(true);
  const expected = manual === "ready" ? { state: "ready", environmentId: "asenvcfg_manual" }
    : { state: "unavailable", reason: expect.stringContaining(manual === "missing" ? "environment_missing" : "manual_environment_mismatched") };
  for (const project of [f.input.project, "repo-successor"]) {
    expect(cloudEnvironmentSelection(project, "account-a")).toMatchObject({ environmentId: "asenvcfg_manual", source: "project-override" });
    expect((await restart(f, "read-binding", project)).choice).toMatchObject({ environmentId: "asenvcfg_manual", source: "project-override" });
    expect(await prepareCloudEnvironment({ ...f.input, project }, f.backend.dependencies)).toMatchObject(expected);
    expect(await restart(f, "no-crash", project)).toMatchObject(expected);
  }
  expect(f.backend.calls.some(call => call.path === "/v1/environment-configs/asenvcfg_manual")).toBe(true);
  expect(f.backend.calls.some(call => call.path.startsWith("/v1/environment-configs?"))).toBe(false);
  expect(f.backend.calls.some(call => call.method === "POST")).toBe(false);
});

for (const runtimeStatus of ["missing", "error", "invalid", "foreign"] as const) {
  test(`terminal approval failure retires its receipt when runtime status is ${runtimeStatus} across restart`, async () => {
    const options: NonNullable<Parameters<typeof stubCloudBackend>[0]> = { create: true, failedApprovals: 1, runtimeStatus };
    const f = fixture(options);
    expect(await restart(f)).toMatchObject({ state: "unavailable", reason: expect.stringContaining("approval_failed") });
    expect(await restart(f)).toMatchObject({ state: "unavailable", reason: expect.stringContaining("approval_failed") });
    expect(f.backend.calls.filter(call => call.path.endsWith("approve/begin"))).toHaveLength(1);
    delete options.runtimeStatus;
    f.advance(2001);
    expect(await restart(f)).toMatchObject({ state: "ready" });
    expect(await restart(f)).toMatchObject({ state: "ready" });
    const begins = f.backend.calls.filter(call => call.path.endsWith("approve/begin"));
    expect(begins).toHaveLength(2);
    expect(new Set(begins.map(call => call.body.idempotency_key)).size).toBe(2);
    expect(f.backend.calls.filter(call => call.method === "POST" && call.path === "/v1/environment-configs")).toHaveLength(1);
    expect(f.backend.calls.filter(call => call.method === "POST" && call.path.endsWith("/drafts"))).toHaveLength(1);
  });

  test(`a RUNNING approval keeps its receipt when runtime status is ${runtimeStatus} across restart`, async () => {
    const options: NonNullable<Parameters<typeof stubCloudBackend>[0]> = { create: true, pending: true, runtimeStatus };
    const f = fixture(options);
    expect(await restart(f)).toMatchObject({ state: "unavailable" });
    delete options.runtimeStatus;
    f.advance(2001);
    expect(await restart(f)).toMatchObject({ state: "pending" });
    options.pending = false; f.advance(2001);
    expect(await restart(f)).toMatchObject({ state: "ready" });
    expect(f.backend.calls.filter(call => call.path.endsWith("approve/begin"))).toHaveLength(1);
  });
}

for (const field of ["id", "environment_id"] as const) test(`an unconfirmed FAILED operation with a foreign ${field} keeps its receipt across restart`, async () => {
  const options = { create: true, pending: true };
  const f = fixture(options), original = f.backend.dependencies.fetch;
  f.backend.dependencies.fetch = async (url, init) => {
    const response = await original(url, init);
    return new URL(url).pathname.includes("/environment-operations/")
      ? Response.json({ ...await response.json(), state: "FAILED", [field]: "foreign-instance" }) : response;
  };
  expect(await f.prepare()).toMatchObject({ state: "unavailable", reason: expect.stringContaining("configuration_invalid") });
  f.advance(2001);
  expect(await restart(f)).toMatchObject({ state: "pending" });
  options.pending = false; f.advance(2001);
  expect(await restart(f)).toMatchObject({ state: "ready" });
  expect(f.backend.calls.filter(call => call.path.endsWith("approve/begin"))).toHaveLength(1);
});

test("a terminal approval uses matching runtime diagnostics and retires the failed operation", async () => {
  const options = { create: true, failedApprovals: 1, missingConnector: true };
  const f = fixture(options);
  expect(await restart(f)).toMatchObject({ state: "unavailable", reason: expect.stringContaining("github_connector_not_configured") });
  options.missingConnector = false; f.advance(2001);
  expect(await restart(f)).toMatchObject({ state: "ready" });
  expect(f.backend.calls.filter(call => call.path.endsWith("approve/begin"))).toHaveLength(2);
});
