import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkoutAdmission } from "./deploymentAdmission";
import { saveCheckoutDeployment } from "./deployments";
import type { ViewerDeploymentStatus } from "@/lib/runtime/contracts";

const SHA = "a".repeat(40);
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
