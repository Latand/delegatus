import { expect, test } from "bun:test";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { cliResolvable, engineConnectedFrom, engineNotConnectedMessage, probeCli } from "./engineConnection";

test("an engine is connected when an account holds credentials inside the project's allowed set", () => {
  expect(engineConnectedFrom([], null)).toBe(false);
  expect(engineConnectedFrom([{ id: "a", authPresent: false }], null)).toBe(false);
  expect(engineConnectedFrom([{ id: "a", authPresent: true }], null)).toBe(true);
  /* A credential store that could not be read cannot prove absence. */
  expect(engineConnectedFrom([{ id: "a", authPresent: false, credentialState: "unknown" }], null)).toBe(true);
  expect(engineConnectedFrom([{ id: "a", authPresent: true }], ["b"])).toBe(false);
  expect(engineConnectedFrom([{ id: "a", authPresent: true }, { id: "b", authPresent: true }], ["b"])).toBe(true);
});

test("the refusal names the stage, the engine and the three ways out", () => {
  expect(engineNotConnectedMessage({ stageId: "review", role: "reviewer", engine: "codex" })).toBe(
    'Stage "review" runs on Codex, and no Codex account is signed in on this machine. Connect Codex (menu → Accounts), or point the reviewer role at another engine (menu → Agent mapping), or set engine and model on this stage.',
  );
  expect(engineNotConnectedMessage({ role: "builder", engine: "claude" })).toBe(
    "This launch runs on Claude, and no Claude account is signed in on this machine. Connect Claude (menu → Accounts), or point the builder role at another engine (menu → Agent mapping), or set engine and model on this launch.",
  );
});

test("the refusal for a missing command names the command instead of the sign-in", () => {
  expect(engineNotConnectedMessage({ stageId: "review", role: "reviewer", engine: "codex", reason: "cli-missing" })).toBe(
    'Stage "review" runs on Codex, and the codex command was not found on this machine. Install it or start the Viewer from a shell where `codex` runs, or point the reviewer role at another engine (menu → Agent mapping), or set engine and model on this stage.',
  );
});

test.skipIf(process.platform === "win32")("a command resolves only as an executable file, by path or on PATH", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-cli-resolvable-"));
  try {
    const bin = path.join(dir, "atlas-cli");
    fs.writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 });
    fs.writeFileSync(path.join(dir, "plain"), "", { mode: 0o644 });
    expect(cliResolvable(bin)).toBe(true);
    expect(cliResolvable("atlas-cli", dir)).toBe(true);
    expect(cliResolvable("atlas-cli", "")).toBe(false);
    expect(cliResolvable("plain", dir)).toBe(false);
    expect(cliResolvable(path.join(dir, "absent"))).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a command the OS cannot start is missing; one that runs is found", async () => {
  expect(await probeCli("/nonexistent/llv-probe-binary")).toBe("missing");
  expect(await probeCli(process.execPath)).toBe("found");
});
