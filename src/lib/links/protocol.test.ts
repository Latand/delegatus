import { afterEach, expect, setSystemTime, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { listCodes, pairIncoming, probePair } from "./protocol";
import { linkFile, readGrants, sha, writeGrants, type PairCode } from "./state";

const originalState = process.env.LLV_STATE_DIR;
const originalConfig = process.env.XDG_CONFIG_HOME;
const roots: string[] = [];
afterEach(() => {
  setSystemTime();
  if (originalState === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = originalState;
  if (originalConfig === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = originalConfig;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pair-codes-"));
  roots.push(root);
  process.env.LLV_STATE_DIR = path.join(root, "state");
  process.env.XDG_CONFIG_HOME = path.join(root, "config");
  setSystemTime(new Date("2026-09-28T00:00:00Z"));
  const make = (id: string, tail: string): PairCode => ({ id, hash: sha(tail), expires: Date.now() + 600_000, attempts: 20, failures: [], scopes: ["board:sync"], used: false });
  const first = make("ABCDEF", "0123456789");
  const second = make("GHJKMN", "0123456789");
  writeGrants({ v: 1, codes: [first, second], grants: [] });
  return { first, second, root };
}

const pair = (code: string) => pairIncoming({ code, install: "00000000-0000-0000-0000-000000000000", label: "A" });

test("unknown id and probe do not spend attempts; a second code survives the first code's rate limit", () => {
  setup();
  const before = fs.readFileSync(linkFile("grants"), "utf8");
  expect(pair("ZZZZZZ-00000-00000").status).toBe(401);
  expect(probePair("ZZZZZZ", null).status).toBe(401);
  expect(fs.readFileSync(linkFile("grants"), "utf8")).toBe(before);
  for (let i = 0; i < 5; i++) expect(pair("ABCDEF-00000-00001").status).toBe(401);
  expect(pair("ABCDEF-00000-00001").status).toBe(429);
  expect(pair("GHJKMN-00000-00001").status).toBe(401);
  expect(listCodes().find((code) => code.id === "ABCDEF")).toMatchObject({ wrongAttempts: 5, burned: false });
  expect(listCodes().find((code) => code.id === "GHJKMN")).toMatchObject({ wrongAttempts: 1, burned: false });
});

test("twenty wrong attempts burn a code across fake-timer windows, then exact code expires", () => {
  setup();
  const start = Date.now();
  for (let window = 0; window < 4; window++) {
    setSystemTime(new Date(start + window * 61_000));
    for (let i = 0; i < 5; i++) expect(pair("ABCDEF-00000-00001").status).toBe(401);
    if (window < 3) expect(pair("ABCDEF-00000-00001").status).toBe(429);
  }
  expect(listCodes().find((code) => code.id === "ABCDEF")).toMatchObject({ wrongAttempts: 20, attempts: 0, used: true, burned: true });
  expect(pair("ABCDEF-01234-56789")).toMatchObject({ status: 410, body: { error: "code-spent" } });
  setSystemTime(new Date(start + 600_001));
  expect(pair("GHJKMN-01234-56789")).toMatchObject({ status: 410, body: { error: "code-spent" } });
  expect(listCodes()).toEqual([]);
  expect(readGrants().codes).toHaveLength(2);
});
