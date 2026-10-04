import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { composeStructuredFirstMessage } from "./structuredFirstMessage";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-structured-first-message-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

test("externalizes the complete scaffold and brief with a repeatable readable reference", async () => {
  const cwd = path.join(root, "repository");
  fs.mkdirSync(cwd);
  const scaffold = `You are a Builder in apply-fixes mode.\n${"Scaffold line. ".repeat(900)}`;
  const brief = `Fix the named issue.\n${"Повний контекст. 🙂 ".repeat(2_000)}`;
  const completeMessage = `${scaffold}\n\n${brief}`;

  const first = (await composeStructuredFirstMessage(completeMessage, cwd));
  const second = (await composeStructuredFirstMessage(completeMessage, cwd));
  expect(Buffer.byteLength(first, "utf8")).toBeLessThanOrEqual(32_000);
  expect(first).toBe(second);
  expect(first).toContain(scaffold.slice(0, 80));
  const file = first.match(/Full structured first message file: (.+)\n/)?.[1];
  expect(file).toBeDefined();
  expect(fs.readFileSync(file!, "utf8")).toBe(completeMessage);
  expect(fs.statSync(file!).mode & 0o777).toBe(0o600);
});

test("small first messages stay byte-identical", async () => {
  const small = "Keep this complete first message inline.\n";
  expect((await composeStructuredFirstMessage(small, root))).toBe(small);
});

test("recomposition repairs a digest-named first message whose contents changed", async () => {
  const cwd = path.join(root, "tampered");
  fs.mkdirSync(cwd);
  const original = "Original input.\n".repeat(3_000);
  const reference = (await composeStructuredFirstMessage(original, cwd));
  const file = reference.match(/Full structured first message file: (.+)\n/)?.[1];
  if (!file) throw new Error("expected the oversized first message to have a file reference");
  fs.writeFileSync(file, "modified after first composition");

  (await composeStructuredFirstMessage(original, cwd));

  expect(fs.readFileSync(file, "utf8")).toBe(original);
});

test.each(["artifact root", "handoff directory"] as const)("shared first-message composition rejects a symlinked %s", async (linkAt) => {
  const cwd = path.join(root, `symlinked-${linkAt.replaceAll(" ", "-")}`);
  const publish = path.join(cwd, "publish");
  fs.mkdirSync(publish, { recursive: true });
  fs.writeFileSync(path.join(publish, "tracked.txt"), "keep me\n");
  fs.mkdirSync(path.join(cwd, ".artifacts"), { recursive: true });
  if (linkAt === "artifact root") {
    fs.rmSync(path.join(cwd, ".artifacts"), { recursive: true });
    fs.symlinkSync("publish", path.join(cwd, ".artifacts"), "dir");
  } else {
    fs.symlinkSync("../publish", path.join(cwd, ".artifacts", "pipeline-stage-inputs"), "dir");
  }

  await expect((async () => (await composeStructuredFirstMessage("private message\n".repeat(3_000), cwd)))()).rejects.toThrow(/pipeline controller artifact path must be a real directory/);
  expect(fs.readdirSync(publish).sort()).toEqual(["tracked.txt"]);
  expect(fs.readFileSync(path.join(publish, "tracked.txt"), "utf8")).toBe("keep me\n");
});
