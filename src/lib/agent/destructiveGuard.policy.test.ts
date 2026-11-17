// destructive-code: head-only; every executable target belongs to guardFixture.
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { evaluate, inspectShell, checkCommand, readPolicy, stopMessage } from "../../../bin/destructive-guard.mjs";
import { guardFixture } from "./destructiveGuard.fixture";
const fixtures: ReturnType<typeof guardFixture>[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.cleanup(); });
function fixture() { const value = guardFixture(); fixtures.push(value); return value; }

test("structural roots, sealed descendants and their ancestors are refused; own files survive policy overhead", () => {
  const f = fixture(), context = { policy: f.policy, own: [f.cwd, f.tmp], cwd: f.cwd };
  for (const target of ["/", "/..", "/boot", f.home, path.join(f.home, ".config"), f.state, path.join(f.state, "credentials"), path.join(f.home, "Projects"), path.join(f.home, "Projects/a/file")]) expect(evaluate(target, context)).not.toBeNull();
  expect(evaluate(path.join(f.cwd, "output"), context)).toBeNull();
  expect(checkCommand("rm", ["-rf", "--no-preserve-root", f.cwd + "/file"], context)?.rule).toBe("no-preserve-root");
  fs.writeFileSync(f.cwd + "/--no-preserve-root", "owned"); f.assertOwned(f.cwd + "/--no-preserve-root");
  const disabledPreservation = f.run("rm", ["--", "--no-preserve-root"]);
  expect(disabledPreservation.exitCode).toBe(1); expect(disabledPreservation.stderr.toString()).toContain("Delegatus stopped");
  expect(fs.readFileSync(f.cwd + "/--no-preserve-root", "utf8")).toBe("owned");
  const nestedOwn = path.join(f.state, "scratch/own"); fs.mkdirSync(nestedOwn, { recursive: true });
  expect(evaluate(nestedOwn + "/file", { ...context, own: [nestedOwn] })).toBeNull();
  expect(evaluate(f.state, { ...context, own: [f.home] })).not.toBeNull();
  const policy = { ...f.policy, sealed: [...f.policy.sealed, { path: f.cwd, kind: "another project" }, { path: f.cwd + "/other-lane", kind: "another project" }] };
  expect(evaluate(f.cwd + "/output", { ...context, policy })).toBeNull();
  expect(evaluate(f.cwd + "/other-lane/output", { ...context, policy })).not.toBeNull();
});

test("symlinked parents and kernel ordering of symlink/.. are resolved; final unlink stays a link", () => {
  const f = fixture(), context = { policy: f.policy, own: [f.cwd], cwd: f.cwd };
  fs.symlinkSync(f.state, f.cwd + "/linked");
  expect(evaluate(f.cwd + "/linked/file", context)?.rule).toBe("sealed");
  expect(evaluate(f.cwd + "/linked/..", context)?.resolved).toBe(f.home + "/.config/delegatus");
  expect(evaluate(f.cwd + "/linked/..", context)).not.toBeNull();
  expect(evaluate(f.cwd + "/linked", context)).toBeNull();
  expect(evaluate(f.cwd + "/linked/", context)?.rule).toBe("sealed");
  expect(checkCommand("find", ["-L", f.cwd + "/linked", "-delete"], context)).not.toBeNull();
  expect(checkCommand("find", ["-O3", "-D", "tree", "--", f.state, "-delete"], context)).not.toBeNull();
  fs.writeFileSync(f.tmp + "/find-targets", f.state + "\0");
  expect(checkCommand("find", ["-files0-from", f.tmp + "/find-targets", "-delete"], context)).not.toBeNull();
  expect(checkCommand("find", ["-files0-from", "-", "-delete"], context)).not.toBeNull();
  expect(checkCommand("find", [f.state, "-printf", "-delete"], context)).toBeNull();
  expect(checkCommand("find", ["-L", "-P", f.cwd + "/linked", "-delete"], context)).toBeNull();
  expect(checkCommand("find", ["-f", f.state, "-delete"], context)).not.toBeNull();
  expect(checkCommand("find", [f.cwd, "-name", "file"], context)).toBeNull();
  expect(checkCommand("mv", [f.cwd + "/file", f.state + "/credentials"], context)).not.toBeNull();
  expect(checkCommand("mv", ["-t", f.state, f.cwd + "/file"], context)).not.toBeNull();
  for (const options of [["-vt" + f.state], ["-vt", f.state], ["--target-dir=" + f.state], ["--target-dir", f.state]]) {
    expect(checkCommand("mv", [...options, f.cwd + "/file"], context)).not.toBeNull();
  }
  fs.writeFileSync(f.state + "/credential", "protected"); fs.symlinkSync(f.state + "/credential", f.cwd + "/file-link");
  expect(checkCommand("mv", [f.cwd + "/file", f.cwd + "/file-link"], context)).toBeNull();
  expect(checkCommand("rsync", ["-a", "--delete-delay", f.cwd + "/", f.state + "/"], context)).not.toBeNull();
  expect(checkCommand("rsync", ["-a", "--delete", f.cwd + "/", "host:remote"], context)).toBeNull();
  expect(checkCommand("rsync", ["--exclude", "--delete", f.cwd + "/", f.state + "/"], context)).toBeNull();
  expect(checkCommand("rsync", ["--remove-source-f", f.state + "/", f.cwd + "/"], context)).not.toBeNull();
});

test("literal shell forms, wrappers, expansions, globs and truncating redirects use the same policy", () => {
  const f = fixture(), context = { policy: f.policy, own: [f.cwd, f.tmp], cwd: f.cwd };
  for (const command of [`rm -rf '${f.home}/Projects/a/..'/*`, `bash -c "rm -rf '${f.state}'"`, `uv run --no-project sh -c "rm -r '${f.state}'"`, `rtk proxy rm -rf '${f.state}'`, `env X=y timeout 30 nice rm -rf '${f.state}'`, `X='${f.state}'; rm -rf "$X"`, 'rm -rf "$UNKNOWN"/*', `echo ok > '${f.state}/credentials'`, `echo $(rm -rf '${f.state}')`, `truncate -s 0 '${f.state}/credentials'`]) {
    expect(inspectShell(command, context), command).not.toBeNull();
  }
  expect(inspectShell(`rm -rf '${f.cwd}/build'`, context)).toBeNull();
  expect(inspectShell('rm -rf "${UNKNOWN:?required}"/*', context)).toBeNull();
  expect(stopMessage(inspectShell('rm -rf "$UNKNOWN"/*', context), 'rm')).toContain("$UNKNOWN");
  expect(stopMessage(inspectShell('X=$UNKNOWN; rm -rf "$X"/*', context), 'rm')).toContain("$UNKNOWN");
  expect(inspectShell(`printf '%s' 'rm -rf ${f.state}'`, context)).toBeNull();
  expect(inspectShell(`items=(rm -rf '${f.state}'); printf '%s' ok`, context)).toBeNull();
  expect(inspectShell(`cat <<'EOF'\nrm -rf '${f.state}'\nEOF\n`, context)).toBeNull();
  expect(inspectShell(`bash <<'EOF'\nrm -rf '${f.state}'\nEOF\n`, context)).not.toBeNull();
  expect(inspectShell(`cat <<EOF\n$(rm -rf '${f.state}')\nEOF\n`, context)).not.toBeNull();
  expect(inspectShell(`bash <<<"rm -rf '${f.state}'"`, context)).not.toBeNull();
  expect(inspectShell(`cat <<<"rm -rf '${f.state}'"; printf ok`, context)).toBeNull();
  expect(inspectShell(`rm -f output < '${f.state}/input'`, context)).toBeNull();
  expect(inspectShell(`printf ok 2>'${f.state}'/output`, context)).not.toBeNull();
  expect(inspectShell(`printf ok &>'${f.state}/output'`, context)).not.toBeNull();
  expect(inspectShell(`find '${f.cwd}' -exec /bin/rm -rf '${f.state}' \\;`, context)).not.toBeNull();
  expect(readPolicy({ LLV_DESTRUCTIVE_GUARD_POLICY: f.tmp + "/absent" }).digest).toBe("fallback");
});

test("wrappers refuse whole operations and a prepended recording double receives no protected call", () => {
  const f = fixture();
  const recorder = path.join(f.tmp, "recorders"); fs.mkdirSync(recorder);
  const log = path.join(f.tmp, "argv");
  for (const tool of ["rm", "find", "mv", "rsync"]) fs.writeFileSync(path.join(recorder, tool), `#!/bin/sh\nprintf '%s\\n' "$@" >> '${log}'\n`, { mode: 0o700 });
  const env = { PATH: f.installed.directory + ":" + recorder + ":/usr/bin:/bin" };
  for (const [tool, args] of [["rm", ["-rf", f.state]], ["find", [f.state, "-delete"]], ["mv", [f.cwd + "/out", f.state + "/credentials"]], ["mv", ["-vt" + f.state, f.cwd + "/out"]], ["mv", ["--target-dir=" + f.state, f.cwd + "/out"]], ["rsync", ["--delete", f.cwd + "/", f.state + "/"]]] as [string, string[]][]) {
    const result = f.run(tool, args, env); expect(result.exitCode).toBe(1); expect(result.stderr.toString()).toContain("Stop and ask");
  }
  expect(fs.existsSync(log)).toBeFalse();
  fs.writeFileSync(f.cwd + "/output", "owned"); f.assertOwned(f.cwd + "/output");
  expect(f.run("rm", ["-f", "output"]).exitCode).toBe(0);
  expect(fs.existsSync(f.cwd + "/output")).toBeFalse();
  fs.symlinkSync(f.state, f.cwd + "/parent");
  expect(f.run("rm", ["-rf", f.cwd + "/parent/file"], env).exitCode).toBe(1);
  fs.writeFileSync(f.state + "/keep", "protected");
  expect(f.run("rm", ["-rf", f.cwd + "/parent"]).exitCode).toBe(0);
  expect(fs.lstatSync(f.cwd + "/parent", { throwIfNoEntry: false })).toBeUndefined();
  expect(fs.readFileSync(f.state + "/keep", "utf8")).toBe("protected");
});

test("a new sealed project invalidates a running launch's shell fast path", () => {
  const f = fixture(), nested = f.cwd + "/new-project";
  fs.mkdirSync(nested); fs.writeFileSync(nested + "/keep", "owned"); f.assertOwned(nested);
  fs.writeFileSync(f.installed.policyFile, JSON.stringify({ ...f.policy, sealed: [...f.policy.sealed, { path: nested, kind: "another project" }] }));
  fs.utimesSync(f.env.LLV_DESTRUCTIVE_GUARD_FAST_STAMP!, new Date("2020-01-01"), new Date("2020-01-01"));
  fs.utimesSync(f.installed.policyFile, new Date("2021-01-01"), new Date("2021-01-01"));
  expect(f.run("rm", ["-rf", nested + "/keep"]).exitCode).toBe(1);
  expect(fs.readFileSync(nested + "/keep", "utf8")).toBe("owned");
});

test("the Bash fast path preserves caller variables and glob options on admission and refusal", () => {
  const f = fixture();
  for (const glob of ["on", "off"]) {
    fs.writeFileSync(f.cwd + "/output", "owned"); f.assertOwned(f.cwd + "/output");
    const script = `fast=caller; arg=caller; ${glob === "off" ? "set -f;" : ""} before=$-; rm -f output; first=$?; rm -rf "$1"; denied=$?; test "$fast" = caller && test "$arg" = caller && test "$before" = "$-" && test "$first" = 0 && test "$denied" = 1`;
    const result = Bun.spawnSync(["/bin/bash", "-c", script, "fixture", f.state], { cwd: f.cwd, env: f.env });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(fs.existsSync(f.cwd + "/output")).toBeFalse(); expect(fs.existsSync(f.state)).toBeTrue();
  }
});

test("a container-only interpreter path falls back to the child's available runtime", () => {
  const f = fixture(), env = { LLV_DESTRUCTIVE_GUARD_BUN: f.tmp + "/container-only-bun", LLV_DESTRUCTIVE_GUARD_FAST: "" };
  expect(f.run("rm", ["-rf", f.state], env).exitCode).toBe(1);
  expect(fs.existsSync(f.state)).toBeTrue();
  fs.writeFileSync(f.cwd + "/output", "owned"); f.assertOwned(f.cwd + "/output");
  expect(f.run("rm", ["-f", "output"], env).exitCode).toBe(0);
  expect(fs.existsSync(f.cwd + "/output")).toBeFalse();
});
