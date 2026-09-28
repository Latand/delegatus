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
