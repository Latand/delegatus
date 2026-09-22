import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";

import { NextRequest } from "next/server";

/*
 * `route.busy.test.ts` proves the route maps a busy error to a retryable 503,
 * with the service mocked. This case runs the real service and the real store
 * (#1870 slice 5): the attention record is a SQLite collection now, and a busy
 * collection has to reach the mapper as the busy class, not as the
 * unavailable-record error the mapper answers without a retry hint.
 */

const previousStateDir = process.env.LLV_STATE_DIR;
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-attention-route-store-busy-"));
process.env.LLV_STATE_DIR = sandbox;

const { GET } = await import("./route");
const { FileTransactionBusyError } = await import("@/lib/state/fileTransaction");
const { setLegacyDocumentWriteHookForTests } = await import("@/lib/state/legacyDocumentStore");

afterAll(() => {
  setLegacyDocumentWriteHookForTests(null);
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const headers = { host: "127.0.0.1:8898", origin: "http://127.0.0.1:8898" };

test("a busy attention collection answers ATTENTION_STATE_BUSY with Retry-After through the real store", async () => {
  setLegacyDocumentWriteHookForTests((collection) => {
    if (collection === "attention") throw new FileTransactionBusyError("attention state is busy");
  });

  const response = await GET(new NextRequest("http://127.0.0.1:8898/api/attention?deviceId=device-a", { headers }));

  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "ATTENTION_STATE_BUSY", message: "attention state is busy" });
  expect(response.headers.get("Retry-After")).toBe("1");
});
