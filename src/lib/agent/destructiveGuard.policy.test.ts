// destructive-code: head-only; every executable target belongs to guardFixture.
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluate, inspectShell, checkCommand, readPolicy, stopMessage } from "../../../bin/destructive-guard.mjs";
import { guardFixture } from "./destructiveGuard.fixture";
import { computeDestructivePolicy } from "./destructiveGuard";
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
  const ownProject = { ...f.policy, sealed: [...f.policy.sealed, { path: f.cwd, kind: "another project" }] };
  expect(checkCommand("find", [f.cwd, "-type", "f", "-delete"], { ...context, policy: ownProject })).toBeNull();
  const policy = { ...f.policy, sealed: [...f.policy.sealed, { path: f.cwd, kind: "another project" }, { path: f.cwd + "/other-lane", kind: "another project" }] };
  expect(evaluate(f.cwd + "/output", { ...context, policy })).toBeNull();
  expect(evaluate(f.cwd + "/other-lane/output", { ...context, policy })).not.toBeNull();
  expect(checkCommand("rm", ["-f", f.cwd + "/output"], { ...context, policy })).toBeNull();
  expect(checkCommand("rm", ["-f", f.cwd + "/other-lane/output"], { ...context, policy })).not.toBeNull();
  expect(checkCommand("rm", ["-f", f.state + "/credentials"], { ...context, own: [f.home] })).not.toBeNull();
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
  expect(checkCommand("cp", [f.cwd + "/file", f.cwd + "/file-link"], context)).not.toBeNull();
  expect(checkCommand("dd", ["if=" + f.cwd + "/file", "of=" + f.cwd + "/file-link"], context)).not.toBeNull();
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
  for (const command of ['rm -rf "$1"/*', 'rm -rf "${10}"/*', 'rm -rf "$@"/*', 'rm -rf "${*}"/*']) {
    expect(inspectShell(command, context), command).not.toBeNull();
  }
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

test("a digest prefix in a corrupt stamp never admits a newly sealed file", () => {
  const f = fixture(), nested = f.cwd + "/new-project";
  fs.mkdirSync(nested); fs.writeFileSync(nested + "/keep", "owned"); f.assertOwned(nested);
  fs.writeFileSync(f.installed.policyFile, JSON.stringify({ ...f.policy, sealed: [...f.policy.sealed, { path: nested, kind: "another project" }] }));
  fs.writeFileSync(f.env.LLV_DESTRUCTIVE_GUARD_FAST_STAMP!, f.policy.digest + "corrupt");
  const result = Bun.spawnSync(["/bin/bash", "-c", 'rm -f "$1"', "fixture", nested + "/keep"], { cwd: f.cwd, env: f.env });
  expect(result.exitCode, result.stderr.toString()).toBe(1);
  expect(fs.readFileSync(nested + "/keep", "utf8")).toBe("owned");
});

test("a parent replaced above an owned root cannot redirect any rm fast path into sealed state", () => {
  const f = fixture(), parent = f.tmp + "/mutable", owned = parent + "/checkout", redirected = f.state + "/redirected";
  fs.mkdirSync(owned, { recursive: true }); fs.mkdirSync(redirected + "/checkout", { recursive: true });
  const protectedFile = redirected + "/checkout/keep"; fs.writeFileSync(protectedFile, "protected");
  f.assertOwned(parent); f.assertOwned(protectedFile);
  fs.renameSync(parent, f.tmp + "/original-parent"); fs.symlinkSync(redirected, parent);
  const recorder = f.tmp + "/recorder", log = f.tmp + "/unexpected-delete";
  fs.mkdirSync(recorder);
  fs.writeFileSync(recorder + "/rm", `#!/bin/sh\nprintf '%s\\n' "$@" >> '${log}'\n`, { mode: 0o700 });
  const boundPath = f.installed.directory + ":" + recorder + ":/usr/bin:/bin";
  const env = { ...f.env, PATH: boundPath, LLV_DESTRUCTIVE_GUARD_BOUND_PATH: boundPath, LLV_DESTRUCTIVE_GUARD_RM: recorder + "/rm",
    LLV_DESTRUCTIVE_GUARD_OWN: owned, LLV_DESTRUCTIVE_GUARD_FAST: owned };
  for (const argv of [[f.installed.directory + "/rm", "-rf", owned + "/keep"], [f.installed.directory + "/slow-rm", "-rf", owned + "/keep"], ["/bin/bash", "-c", 'rm -rf "$1"', "fixture", owned + "/keep"], ["/bin/bash", "-c", 'rm -f "$1"', "fixture", owned + "/keep"]]) {
    f.assertOwned(owned + "/keep");
    const result = Bun.spawnSync(argv, { cwd: f.cwd, env, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode, result.stderr.toString()).toBe(1);
    expect(result.stderr.toString()).toContain("Delegatus stopped");
    expect(fs.existsSync(log)).toBeFalse();
    expect(fs.readFileSync(protectedFile, "utf8")).toBe("protected");
  }
});

test("bytewise Bash checks preserve Unicode operands and the caller's locale", () => {
  const f = fixture(), recorder = f.tmp + "/record-only", log = f.tmp + "/received";
  fs.mkdirSync(recorder);
  fs.writeFileSync(recorder + "/rm", `#!/bin/sh\nprintf '%s\\n' "\${LC_ALL-}" "$@" >> '${log}'\n`, { mode: 0o700 });
  const target = f.cwd + "/дані з пробілами";
  fs.writeFileSync(target, "owned"); f.assertOwned(target);
  const env = { ...f.env, LC_ALL: "C.UTF-8", LLV_DESTRUCTIVE_GUARD_RM: recorder + "/rm" };
  const result = Bun.spawnSync(["/bin/bash", "-c", 'rm -f "$1" && test "$LC_ALL" = C.UTF-8', "fixture", target], { cwd: f.cwd, env });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(fs.readFileSync(log, "utf8")).toBe(`C.UTF-8\n-f\n${target}\n`);
  expect(fs.readFileSync(target, "utf8")).toBe("owned");
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

test("a reassigned PWD cannot admit a relative delete from a protected working directory", () => {
  const f = fixture(), recorder = f.tmp + "/record-only", log = f.tmp + "/unexpected-delete";
  fs.mkdirSync(recorder); fs.writeFileSync(f.state + "/keep", "protected");
  fs.writeFileSync(recorder + "/rm", `#!/bin/sh\nprintf '%s\\n' "$@" >> '${log}'\n`, { mode: 0o700 });
  f.assertOwned(f.state); f.assertOwned(recorder);
  const boundPath = f.installed.directory + ":" + recorder + ":/usr/bin:/bin";
  const env = { ...f.env, PATH: boundPath, LLV_DESTRUCTIVE_GUARD_BOUND_PATH: boundPath, LLV_DESTRUCTIVE_GUARD_RM: recorder + "/rm" };
  const result = Bun.spawnSync(["/bin/bash", "-c", 'PWD="$1"; rm -f keep', "fixture", f.cwd], { cwd: f.state, env });
  expect(result.exitCode, result.stderr.toString()).toBe(1);
  expect(result.stderr.toString()).toContain("Delegatus stopped");
  expect(fs.existsSync(log)).toBeFalse();
  expect(fs.readFileSync(f.state + "/keep", "utf8")).toBe("protected");
});

test("a container-only interpreter path falls back to the child's available runtime", () => {
  const f = fixture(), env = { LLV_DESTRUCTIVE_GUARD_BUN: f.tmp + "/container-only-bun", LLV_DESTRUCTIVE_GUARD_FAST: "" };
  expect(f.run("rm", ["-rf", f.state], env).exitCode).toBe(1);
  expect(fs.existsSync(f.state)).toBeTrue();
  fs.writeFileSync(f.cwd + "/output", "owned"); f.assertOwned(f.cwd + "/output");
  expect(f.run("rm", ["-f", "output"], env).exitCode).toBe(0);
  expect(fs.existsSync(f.cwd + "/output")).toBeFalse();
});

test("a catalogued home, its ancestors, top-level directories and temp roots are never sealed as projects", () => {
  const f = fixture();
  // The fixture's operator list seals the fake home itself; this case needs the catalog alone.
  fs.writeFileSync(path.join(f.state, "destructive-guard-protected.json"), "[]");
  const temporary = fs.realpathSync(os.tmpdir());
  const projects = [f.home, path.dirname(f.home), "/", "/home", "/tmp", temporary, path.join(f.home, "Projects/a")];
  const policy = computeDestructivePolicy(f.env, { home: f.home, accounts: [f.env.CODEX_HOME!, f.env.CLAUDE_CONFIG_DIR!], projects });
  const projectRoots = policy.sealed.filter(entry => entry.kind === "another project").map(entry => entry.path);
  expect(projectRoots).toEqual([path.join(f.home, "Projects/a")]);
  const context = { policy, own: [f.cwd, f.tmp], cwd: f.cwd };
  fs.mkdirSync(path.join(f.home, "notes")); fs.writeFileSync(path.join(f.home, "notes/x"), "owned"); f.assertOwned(path.join(f.home, "notes/x"));
  for (const command of [`rm '${f.home}/notes/x'`, `mv '${f.home}/notes/x' '${f.home}/notes/y'`, `echo hi > '${f.home}/notes/x'`, `rm -f '${f.home}/Downloads/f.zip'`]) {
    expect(inspectShell(command, context), command).toBeNull();
  }
  for (const target of [f.home, path.join(f.home, ".ssh/id"), path.join(f.home, ".claude/.credentials.json"), path.join(f.state, "state.sqlite"), path.join(f.home, "Projects/a/file"), path.join(f.home, "Projects")]) {
    expect(evaluate(target, context), target).not.toBeNull();
  }
  // A policy file written before the filter is narrowed when it is read.
  const stale = path.join(f.tmp, "stale-policy.json");
  fs.writeFileSync(stale, JSON.stringify({ ...policy, sealed: [...policy.sealed, { path: f.home, kind: "another project" }, { path: "/", kind: "another project" }, { path: temporary, kind: "another project" }] }));
  const narrowed = readPolicy({ LLV_DESTRUCTIVE_GUARD_POLICY: stale });
  expect(narrowed.sealed).toEqual(policy.sealed);
  expect(evaluate(path.join(f.home, "notes/x"), { ...context, policy: narrowed })).toBeNull();
});

test("cd, pushd and popd move the directory relative targets resolve against", () => {
  const f = fixture(), context = { policy: f.policy, own: [f.cwd, f.tmp], cwd: f.cwd };
  const claude = path.join(f.home, ".claude");
  for (const command of [`cd '${claude}' && : > .credentials.json`, `cd '${claude}' && unlink .credentials.json`, `cd '${claude}'; rm -f .credentials.json`,
    `cd '${f.home}' && cd .claude && cp '${f.cwd}/x' .credentials.json`, `pushd '${f.state}' && rm -f keep`, `cd -P '${f.state}' && truncate -s 0 data`,
    `builtin cd '${claude}' && shred -u .credentials.json`, `cd '${f.cwd}'; cd '${claude}' && dd if=/dev/zero of=.credentials.json`, `bash -c "cd '${claude}' && rmdir projects"`]) {
    expect(inspectShell(command, context), command).not.toBeNull();
  }
  for (const command of ["cd sub && rm -rf build", `cd '${f.cwd}/sub' && rm -rf ../build`, `(cd '${claude}' && ls) && rm -rf build`, `pushd '${f.state}' && popd && rm -f build`,
    `cd '${claude}' && cd '${f.cwd}' && rm -rf build`, `cd '${claude}' && cd - && rm -rf build`, `cd '${claude}' && rm -f '${f.cwd}/build'`, `cd '${claude}' && ls > '${f.tmp}/listing'`]) {
    expect(inspectShell(command, context), command).toBeNull();
  }
  // An unresolvable directory uses its empty-expansion form: unquoted empty is the home.
  const unknown = inspectShell("cd $UNKNOWN && rm -rf *", context, { HOME: f.home });
  expect(unknown?.rule).toBe("empty-expansion"); expect(unknown?.variables).toEqual(["$UNKNOWN"]);
  expect(stopMessage(unknown, "cd $UNKNOWN && rm -rf *")).toContain("$UNKNOWN");
  expect(inspectShell(`cd "$UNKNOWN" && rm -rf build`, context)).toBeNull();
  expect(inspectShell(`cd "$UNKNOWN"/.claude && : > .credentials.json`, { ...context, cwd: f.home })).toBeNull();
  expect(inspectShell(`cd "\${UNKNOWN:?}" && rm -rf build`, context)).toBeNull();
});

test("ANSI-C quoting is lexed with its escapes and never turns into a parse error", () => {
  const f = fixture(), context = { policy: f.policy, own: [f.cwd, f.tmp], cwd: f.cwd };
  const credentials = path.join(f.home, ".claude/.credentials.json");
  for (const command of [`echo $'it\\'s' > '${credentials}'`, `rm -rf '${f.state}'; echo $'it\\'s'`, `rm -rf $'${f.state.replaceAll("/", "\\x2f")}'`,
    `X=$'${f.state}\\101'; rm -rf "$X"/..`, `printf $'a\\tb\\n' > $"${credentials}"`]) {
    expect(inspectShell(command, context), command).not.toBeNull();
  }
  for (const command of [`printf $'a\\tb\\n'`, `printf $'\\u00e9\\cA\\0\\'"' > out`, `echo $"translated" > out`, `echo "$'" > out`]) {
    expect(inspectShell(command, context), command).toBeNull();
  }
  expect(() => inspectShell("echo $'unterminated", context)).toThrow("unterminated shell quote");
});
