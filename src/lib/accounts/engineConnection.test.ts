import { expect, test } from "bun:test";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { cliDisplayPath, cliInstalls, cliReport, cliResolvable, engineCliPresence, engineConnectedFrom, engineNotConnectedMessage, probeCli, probeCliVersion, versionFromOutput, type CliReports } from "./engineConnection";

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

test("a version is the first dotted triple of the answer, whatever stands around it", () => {
  expect(versionFromOutput("2.1.4 (Claude Code)\n")).toBe("2.1.4");
  expect(versionFromOutput("codex-cli 0.170.0\n")).toBe("0.170.0");
  expect(versionFromOutput("GitHub Copilot CLI 1.0.87.\nRun 'copilot update' to check for updates.\n")).toBe("1.0.87");
  expect(versionFromOutput("agy 1.5.17-beta.2 (linux x64)")).toBe("1.5.17-beta.2");
  expect(versionFromOutput("")).toBeNull();
  expect(versionFromOutput("usage: tool [options]")).toBeNull();
  /* Two numbers are a date or a count, never quoted as a version. */
  expect(versionFromOutput("build 2026.11")).toBeNull();
});

test("a found command under the home reads from ~, one elsewhere keeps its path, and a bare name has no place", () => {
  const home = path.join(path.sep, "home", "operator");
  expect(cliDisplayPath(path.join(home, ".local", "bin", "claude"), home)).toBe(`~${path.sep}${path.join(".local", "bin", "claude")}`);
  expect(cliDisplayPath(path.join(path.sep, "usr", "local", "bin", "codex"), home)).toBe(path.join(path.sep, "usr", "local", "bin", "codex"));
  /* A sibling whose name only starts like the home is outside it. */
  expect(cliDisplayPath(path.join(path.sep, "home", "operator-two", "bin", "agy"), home)).toBe(path.join(path.sep, "home", "operator-two", "bin", "agy"));
  expect(cliDisplayPath("codex", home)).toBeNull();
  expect(cliDisplayPath(home, home)).toBe(home);
});

test.skipIf(process.platform === "win32")("one --version run answers presence and version; a failing run names no version", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-cli-version-"));
  try {
    const clean = path.join(dir, "clean");
    fs.writeFileSync(clean, "#!/bin/sh\necho 'atlas-cli 3.4.5'\n", { mode: 0o755 });
    expect(await probeCliVersion(clean)).toEqual({ presence: "found", version: "3.4.5" });
    const onStderr = path.join(dir, "stderr");
    fs.writeFileSync(onStderr, "#!/bin/sh\necho '7.8.9' >&2\n", { mode: 0o755 });
    expect(await probeCliVersion(onStderr)).toEqual({ presence: "found", version: "7.8.9" });
    const failing = path.join(dir, "failing");
    fs.writeFileSync(failing, "#!/bin/sh\necho 'runtime 9.9.9 crashed'\nexit 3\n", { mode: 0o755 });
    expect(await probeCliVersion(failing)).toEqual({ presence: "found", version: null });
    const silent = path.join(dir, "silent");
    fs.writeFileSync(silent, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    expect(await probeCliVersion(silent)).toEqual({ presence: "found", version: null });
    const slow = path.join(dir, "slow");
    fs.writeFileSync(slow, "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
    expect(await probeCliVersion(slow, 100)).toEqual({ presence: "found", version: null });
    expect(await probeCliVersion(path.join(dir, "absent"))).toEqual({ presence: "missing", version: null });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")("a program's check reports its path and version, holds them for a minute, and Check again reads anew", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-cli-report-"));
  const previous = { agy: process.env.LLV_ANTIGRAVITY_BIN, copilot: process.env.LLV_COPILOT_BIN, shims: process.env.LLV_DOCKER_NSENTER_SHIMS };
  try {
    const agy = path.join(dir, "agy");
    fs.writeFileSync(agy, "#!/bin/sh\necho 'agy 1.5.17'\n", { mode: 0o755 });
    process.env.LLV_ANTIGRAVITY_BIN = agy;
    process.env.LLV_COPILOT_BIN = path.join(dir, "absent-copilot");
    delete process.env.LLV_DOCKER_NSENTER_SHIMS;
    expect(await cliReport("antigravity", { fresh: true })).toEqual({ presence: "found", version: "1.5.17", path: cliDisplayPath(agy) });
    expect(await cliReport("copilot", { fresh: true })).toEqual({ presence: "missing", version: null, path: null });

    /* An upgrade inside the minute is not seen until the step's "Check again". */
    fs.writeFileSync(agy, "#!/bin/sh\necho 'agy 1.6.0'\n", { mode: 0o755 });
    expect((await cliReport("antigravity")).version).toBe("1.5.17");
    expect(await engineCliPresence("antigravity")).toBe("found");
    expect((await cliReport("antigravity", { fresh: true })).version).toBe("1.6.0");

    /* A removed command reads as missing on the next check and keeps no path or version of the old one. */
    fs.rmSync(agy);
    expect(await cliReport("antigravity", { fresh: true })).toEqual({ presence: "missing", version: null, path: null });
    expect(await engineCliPresence("antigravity")).toBe("missing");

    fs.writeFileSync(agy, "#!/bin/sh\necho 'agy 1.6.0'\n", { mode: 0o755 });
    /* The popovers' read keeps the path and the version of each program and drops nothing but the presence. */
    const absent = { presence: "missing", version: null, path: null } as const;
    const reports: CliReports = { claude: absent, codex: absent, antigravity: await cliReport("antigravity", { fresh: true }), copilot: await cliReport("copilot") };
    expect(cliInstalls(reports)).toEqual({
      claude: { path: null, version: null },
      codex: { path: null, version: null },
      antigravity: { path: cliDisplayPath(agy), version: "1.6.0" },
      copilot: { path: null, version: null },
    });
  } finally {
    for (const [name, value] of [["LLV_ANTIGRAVITY_BIN", previous.agy], ["LLV_COPILOT_BIN", previous.copilot], ["LLV_DOCKER_NSENTER_SHIMS", previous.shims]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
