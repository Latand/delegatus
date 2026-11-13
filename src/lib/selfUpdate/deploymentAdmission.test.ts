import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkoutAdmission } from "./deploymentAdmission";
import { saveCheckoutDeployment } from "./deployments";
import type { ViewerDeploymentStatus } from "@/lib/runtime/contracts";

const SHA = "a".repeat(40);
test("a callback that reaches the admission fence after its deadline closes the key without admitting", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "checkout-admission-deadline-"));
  const request = { revision: SHA, idempotencyKey: "expired-admission-deadline" };
  let effects = 0;
  try {
    await expect(checkoutAdmission(directory, request, undefined, () => ++effects, { deadlineAt: Date.now() - 1 }))
      .rejects.toMatchObject({ code: "deploy_not_admitted" });
    await expect(checkoutAdmission(directory, request, undefined, () => ++effects))
      .rejects.toMatchObject({ code: "deploy_not_admitted" });
    expect(effects).toBe(0);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("a retryable refusal fences older reads and their timeout across processes, while the same key retries", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "checkout-admission-generation-"));
  const request = { revision: SHA, idempotencyKey: "retryable-refusal-generation" };
  let oldAttempt = -1, effects = 0;
  try {
    await checkoutAdmission(directory, request, undefined, attempt => { oldAttempt = attempt; return null; });
    await checkoutAdmission(directory, request, undefined, () => ({ state: "refused" }), { attempt: oldAttempt, refuse: true });
    for (const reconcileOnly of [false, true]) {
      await expect(checkoutAdmission(directory, { ...request, reconcileOnly }, undefined, () => ++effects, { attempt: oldAttempt }))
        .rejects.toMatchObject({ code: "deploy_attempt_superseded" });
    }
    const child = Bun.spawn([process.execPath, "-e", `
      import { checkoutAdmission } from "./src/lib/selfUpdate/deploymentAdmission";
      const request = JSON.parse(process.argv[2]);
      const answers = [];
      for (const reconcileOnly of [false, true]) {
        try { await checkoutAdmission(process.argv[1], { ...request, reconcileOnly }, undefined, () => { throw Error("unexpected effect"); }, { attempt: Number(process.argv[3]) }); }
        catch (error) { answers.push(error.code); }
      }
      console.log(JSON.stringify(answers));
    `, directory, JSON.stringify(request), String(oldAttempt)], { cwd: process.cwd(), env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, stderr, answers: JSON.parse(stdout) }).toEqual({ code: 0, stderr: "", answers: ["deploy_attempt_superseded", "deploy_attempt_superseded"] });
    let nextAttempt = -1;
    await checkoutAdmission(directory, request, undefined, attempt => { nextAttempt = attempt; return null; });
    expect(nextAttempt).toBeGreaterThan(oldAttempt);
    expect(await checkoutAdmission(directory, request, undefined, () => ++effects, { attempt: nextAttempt })).toBe(1);
    await expect(checkoutAdmission(directory, { ...request, revision: "b".repeat(40) }, undefined, () => ++effects)).rejects.toThrow("idempotency-conflict");
    expect(effects).toBe(1);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}, 15_000);

test("a Node page-data worker can load admission and refuses execution without Bun", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "checkout-admission-node-"));
  try {
    const build = await Bun.build({
      entrypoints: [path.join(import.meta.dir, "deploymentAdmission.ts")],
      outdir: directory, target: "node", format: "cjs", naming: "admission.cjs",
      external: ["bun:sqlite"],
    });
    expect(build.success).toBe(true);
    const child = Bun.spawn(["node", "-e", `
      const { checkoutAdmission } = require(process.argv[1]);
      const fs = require("node:fs");
      (async () => {
        let effects = 0, error;
        try { await checkoutAdmission(process.argv[2], { revision: "a".repeat(40), idempotencyKey: "node-admission" }, undefined, () => ++effects); }
        catch (failure) { error = failure.message; }
        console.log(JSON.stringify({ loaded: typeof checkoutAdmission === "function", error, effects, created: fs.existsSync(process.argv[2]) }));
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `, build.outputs[0]!.path, path.join(directory, "state")], { stdout: "pipe", stderr: "pipe", env: { ...process.env } });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(stdout)).toEqual({ loaded: true, error: "Checkout deployment admission requires the Bun runtime", effects: 0, created: false });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}, 15_000);

test("checkout fence serializes with real admission writes and survives process restart", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "checkout-admission-"));
  const request = { revision: SHA, idempotencyKey: "closed-checkout-request" };
  let effects = 0;
  const admit = () => {
    effects++;
    const status: ViewerDeploymentStatus = { deploymentId: "checkout-admitted", idempotencyKey: request.idempotencyKey, requestedRevision: SHA, revision: SHA,
      phase: "succeeded", terminal: true, candidate: null, previous: null, health: [], error: null,
      mcpRuntime: { candidate: null, previous: null, publications: [], health: [] },
      owner: { pid: 10, startIdentity: "10:1" }, createdAt: "2026-10-19T12:00:00Z", updatedAt: "2026-10-19T12:00:00Z", revisionNumber: 1 };
    saveCheckoutDeployment(directory, status);
    return { state: "accepted" as const, deploymentId: status.deploymentId, revision: SHA, replayed: false };
  };
  try {
    // Every refusal has a positive writer that actually reaches the observer.
    expect(await checkoutAdmission(directory, request, undefined, admit)).toMatchObject({ state: "accepted", replayed: false });
    expect(await checkoutAdmission(directory, { ...request, reconcileOnly: true }, undefined, admit)).toMatchObject({ state: "accepted", replayed: true });
    expect(effects).toBe(1);
    const closed = { ...request, idempotencyKey: "never-admitted" };
    await expect(checkoutAdmission(directory, { ...closed, reconcileOnly: true }, undefined, admit)).rejects.toThrow("permanently closed");
    await expect(checkoutAdmission(directory, closed, undefined, admit)).rejects.toThrow("permanently closed");
    await expect(checkoutAdmission(directory, { ...closed, revision: "b".repeat(40), reconcileOnly: true }, undefined, admit)).rejects.toThrow("idempotency-conflict");
    expect(effects).toBe(1);
    const child = Bun.spawn([process.execPath, "-e", `
      import { checkoutAdmission } from "./src/lib/selfUpdate/deploymentAdmission";
      const request = JSON.parse(process.argv[2]);
      const results = [];
      for (const reconcileOnly of [false, true]) {
        try { await checkoutAdmission(process.argv[1], { ...request, reconcileOnly }, undefined, () => { throw Error("unexpected admission"); }); }
        catch (error) { results.push(error.code); }
      }
      console.log(JSON.stringify(results));
    `, directory, JSON.stringify(closed)], { cwd: process.cwd(), env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, stderr, answers: JSON.parse(stdout) }).toEqual({ code: 0, stderr: "", answers: ["deploy_not_admitted", "deploy_not_admitted"] });
    // Revoked authority cannot close another key, including after waiting for admission.
    const denied = { ...request, idempotencyKey: "denied-reconciliation", reconcileOnly: true };
    await expect(checkoutAdmission(directory, denied, () => { throw Error("revoked"); }, admit)).rejects.toThrow("revoked");
    expect(await checkoutAdmission(directory, { ...denied, reconcileOnly: false }, undefined, () => ++effects)).toBe(2);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}, 15_000);
