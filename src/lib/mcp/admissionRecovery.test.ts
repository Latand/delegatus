import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, spyOn, test } from "bun:test";
import { SqliteMcpReceiptStore, requestDigest, type McpRequestBinding } from "./server";
import { reconcileLaunchAdmissions } from "./admissionRecovery";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

function fixture(count: number, future = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-admission-pass-"));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const previous = process.env.LLV_STATE_DIR; process.env.LLV_STATE_DIR = root;
  cleanup.push(() => { if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous; });
  const filename = path.join(root, "mcp-receipts.sqlite");
  const store = new SqliteMcpReceiptStore(filename); cleanup.push(() => store.close());
  for (let n = 0; n < count; n++) {
    const key = `admission-pass-${n}`;
    const binding: McpRequestBinding = { version: 1, toolName: "spawn_agent", clientRequestId: key,
      caller: { kind: "worker", conversationId: "conversation_fixture", project: "fixture-project" },
      target: { project: "fixture-project", identity: root }, downstreamKey: `fixture-downstream-${n}`,
      claimedAt: "2020-01-01T00:00:00Z", owner: { pid: process.pid, startIdentity: null },
      launchAdmission: { version: 1, settleAfter: future ? Date.parse("2090-01-01T00:02:00Z") : Date.parse("2020-01-01T00:02:00Z"),
        envelopeDigest: "a".repeat(64), adaptations: {}, registryIdentity: null } };
    store.claim(`spawn_agent:${key}`, requestDigest("spawn_agent", { clientRequestId: key }), "durable", binding);
  }
  return { root, store };
}

test("bounded due traversal resumes its persisted position across real process restarts", async () => {
  const f = fixture(101);
  const child = async () => {
    const source = path.join(import.meta.dir, "admissionRecovery.ts");
    const child = Bun.spawn([process.execPath, "-e", `
      const { reconcileLaunchAdmissions } = await import(${JSON.stringify(source)});
      console.log(JSON.stringify(await reconcileLaunchAdmissions(() => {})));
    `], { env: process.env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, stderr).toBe(0); return JSON.parse(stdout) as { visited: number; resolved: number; failed: number };
  };
  expect(await child()).toEqual({ visited: 50, resolved: 50, failed: 0 });
  expect(await child()).toEqual({ visited: 50, resolved: 50, failed: 0 });
  expect(await child()).toEqual({ visited: 1, resolved: 1, failed: 0 });
  for (let n = 0; n < 101; n++) expect(f.store.lookup(`spawn_agent:admission-pass-${n}`)?.stage).toBe("not-executed");
});

test("future-only history spends at most fifty scalar candidate visits and decodes no receipt", async () => {
  const f = fixture(101, true);
  let reads = 0;
  const lookup = SqliteMcpReceiptStore.prototype.lookup;
  const observer = spyOn(SqliteMcpReceiptStore.prototype, "lookup").mockImplementation(function (this: SqliteMcpReceiptStore, ...args) {
    reads++; return lookup.apply(this, args);
  });
  try {
    expect(await reconcileLaunchAdmissions(() => {})).toEqual({ visited: 50, resolved: 0, failed: 0 });
    expect(reads).toBe(0);
    f.store.lookup("spawn_agent:admission-pass-0");
    expect(reads).toBe(1);
  } finally { observer.mockRestore(); }
});

test("demotion inside the receipt writer refuses the pass, then a fresh serving pass resolves it", async () => {
  const f = fixture(1); let current = true;
  const fence = SqliteMcpReceiptStore.prototype.fenceUndispatched;
  const replace = spyOn(SqliteMcpReceiptStore.prototype, "fenceUndispatched").mockImplementation(function (this: SqliteMcpReceiptStore, ...args) {
    current = false; return fence.apply(this, args);
  });
  try {
    await expect(reconcileLaunchAdmissions(() => { if (!current) throw new Error("fixture release demoted"); })).rejects.toThrow("fixture release demoted");
    expect(f.store.lookup("spawn_agent:admission-pass-0")?.result).toBeNull();
  } finally { replace.mockRestore(); }
  expect(await reconcileLaunchAdmissions(() => {})).toEqual({ visited: 1, resolved: 1, failed: 0 });
});

for (const seam of ["preparation", "cursor"] as const) test(`demotion inside ${seam} metadata refuses its native write`, async () => {
  const f = fixture(1, true); let current = true;
  const db = new (await import("bun:sqlite")).Database(f.store.filename);
  if (seam === "preparation") db.exec("UPDATE mcp_receipts SET launch_indexed=0");
  const prepare = SqliteMcpReceiptStore.prototype.prepareLaunchClaims;
  const position = SqliteMcpReceiptStore.prototype.recoveryPosition;
  const held = seam === "preparation"
    ? spyOn(SqliteMcpReceiptStore.prototype, "prepareLaunchClaims").mockImplementation(function (this: SqliteMcpReceiptStore, ...args) {
      current = false; return prepare.apply(this, args);
    })
    : spyOn(SqliteMcpReceiptStore.prototype, "recoveryPosition").mockImplementation(function (this: SqliteMcpReceiptStore, ...args) {
      if (args[0] !== undefined) current = false; return position.apply(this, args);
    });
  try {
    await expect(reconcileLaunchAdmissions(() => { if (!current) throw new Error("fixture release demoted"); })).rejects.toThrow("fixture release demoted");
    if (seam === "preparation") expect(db.query<{ launch_indexed: number }, []>("SELECT launch_indexed FROM mcp_receipts").get()?.launch_indexed).toBe(0);
    else expect(position.call(f.store)).toBe(0);
  } finally { held.mockRestore(); db.close(); }
  expect(await reconcileLaunchAdmissions(() => {})).toEqual({ visited: 1, resolved: 0, failed: 0 });
  expect(position.call(f.store)).toBe(1);
  expect(f.store.launchWatermark()).toBe(1);
});
