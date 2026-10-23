import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";

import { usesLinkedLegacyState } from "./legacyState";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "delegatus-linked-state-"));
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

test("only a link to the active earlier state is reported, without changing data", () => {
  const root = path.join(sandbox, "linked");
  const legacy = path.join(root, "agent-log-viewer");
  const active = path.join(legacy, "state");
  fs.mkdirSync(active, { recursive: true });
  fs.writeFileSync(path.join(active, "fixture.json"), "preserved");
  expect(usesLinkedLegacyState(root, active)).toBe(false);
  fs.symlinkSync("agent-log-viewer", path.join(root, "delegatus"), "dir");
  expect(usesLinkedLegacyState(root, active)).toBe(true);
  expect(usesLinkedLegacyState(root, path.join(root, "delegatus", "state"))).toBe(true);
  const isolated = path.join(sandbox, "isolated");
  fs.mkdirSync(isolated);
  expect(usesLinkedLegacyState(root, isolated)).toBe(false);
  expect(usesLinkedLegacyState(root, path.join(legacy, "state-staging"))).toBe(false);
  expect(fs.readlinkSync(path.join(root, "delegatus"))).toBe("agent-log-viewer");
  expect(fs.readFileSync(path.join(active, "fixture.json"), "utf8")).toBe("preserved");
});

test("a separate new install, missing paths and unrelated links are not inherited state", () => {
  const root = path.join(sandbox, "separate");
  const active = path.join(root, "agent-log-viewer", "state");
  fs.mkdirSync(active, { recursive: true });
  fs.mkdirSync(path.join(root, "delegatus"));
  expect(usesLinkedLegacyState(root, active)).toBe(false);
  fs.rmdirSync(path.join(root, "delegatus"));
  fs.symlinkSync("missing", path.join(root, "delegatus"), "dir");
  expect(usesLinkedLegacyState(root, active)).toBe(false);
  fs.unlinkSync(path.join(root, "delegatus"));
  fs.mkdirSync(path.join(root, "other"));
  fs.symlinkSync("other", path.join(root, "delegatus"), "dir");
  expect(usesLinkedLegacyState(root, active)).toBe(false);
});
