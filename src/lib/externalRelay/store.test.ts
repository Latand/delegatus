import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  dropRun,
  putRun,
  readRunLedger,
  readRelayStore,
  updateRelayStore,
} from "./store";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-store-test-"));
process.env.LLV_STATE_DIR = root;
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
test("ledger records a request once and removes it", () => {
  const row = {
    requestId: "r1",
    leaseId: "lease1",
    relayId: "relay1",
    targetId: "target1",
    childPid: null,
    childIdentity: null,
    ownerPid: process.pid,
    ownerIdentity: "identity",
    runDir: root,
    startedAt: new Date().toISOString(),
  };
  expect(putRun(row)).toBe(true);
  expect(putRun(row)).toBe(false);
  expect(readRunLedger().runs).toHaveLength(1);
  dropRun(row.requestId);
  expect(readRunLedger().runs).toHaveLength(0);
  expect(
    fs.statSync(path.join(root, "external-relay", "runs.json")).mode & 0o777,
  ).toBe(0o600);
});
test("store mints one install ID and writes a private file", () => {
  const first = readRelayStore();
  updateRelayStore((store) => store);
  expect(readRelayStore().installId).toBe(first.installId);
  expect(fs.statSync(path.join(root, "external-relay")).mode & 0o777).toBe(
    0o700,
  );
});
test("two Viewer processes cannot reserve the same target slot", async () => {
  const childFile = path.join(root, "reserve-child.ts");
  const modulePath = path.join(process.cwd(), "src/lib/externalRelay/store.ts");
  fs.writeFileSync(
    childFile,
    `import { putRun } from ${JSON.stringify(modulePath)};\nconst id = process.env.RELAY_TEST_ID!;\nconsole.log(putRun({ requestId: id, leaseId: id, relayId: "shared", targetId: "target", childPid: null, childIdentity: null, ownerPid: process.pid, ownerIdentity: "child", runDir: "", startedAt: new Date().toISOString() }, 1));\n`,
  );
  const children = ["first", "second"].map((id) =>
    Bun.spawn([process.execPath, childFile], {
      env: { ...process.env, LLV_STATE_DIR: root, RELAY_TEST_ID: id },
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  const outputs = await Promise.all(
    children.map(async (child) => ({
      code: await child.exited,
      text: await new Response(child.stdout).text(),
      error: await new Response(child.stderr).text(),
    })),
  );
  expect(outputs.map((item) => item.code)).toEqual([0, 0]);
  expect(outputs.map((item) => item.text.trim()).sort()).toEqual([
    "false",
    "true",
  ]);
  expect(
    readRunLedger().runs.filter((run) => run.relayId === "shared"),
  ).toHaveLength(1);
  for (const run of readRunLedger().runs.filter(
    (item) => item.relayId === "shared",
  ))
    dropRun(run.requestId);
});
