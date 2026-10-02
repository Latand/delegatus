import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { composeStructuredFirstMessage } from "./structuredFirstMessage";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-structured-first-message-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

test("externalizes the complete scaffold and brief with a repeatable readable reference", () => {
  const cwd = path.join(root, "repository");
  fs.mkdirSync(cwd);
  const scaffold = `You are a Builder in apply-fixes mode.\n${"Scaffold line. ".repeat(900)}`;
  const brief = `Fix the named issue.\n${"Повний контекст. 🙂 ".repeat(2_000)}`;
  const completeMessage = `${scaffold}\n\n${brief}`;

  const first = composeStructuredFirstMessage(completeMessage, cwd);
  const second = composeStructuredFirstMessage(completeMessage, cwd);
  expect(Buffer.byteLength(first, "utf8")).toBeLessThanOrEqual(32_000);
  expect(first).toBe(second);
  expect(first).toContain(scaffold.slice(0, 80));
  const file = first.match(/Full structured first message file: (.+)\n/)?.[1];
  expect(file).toBeDefined();
  expect(fs.readFileSync(file!, "utf8")).toBe(completeMessage);
  expect(fs.statSync(file!).mode & 0o777).toBe(0o600);
});

test("small first messages stay byte-identical", () => {
  const small = "Keep this complete first message inline.\n";
  expect(composeStructuredFirstMessage(small, root)).toBe(small);
});
