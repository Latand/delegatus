import { describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";
import { bunArchives, digest, validatePackage, verifiedBun } from "./manifest";
import { alive, appSessionData, commandFailure, comparablePath, end, exited, hasFinishedPageEvidence, hasRenderedEvidence, intelIsTranslated, processCensus, reapEvidenceFilters, runCommand, smokeEnvironment, smokeStdio, plainFailureMessage } from "./smoke-platform.mjs";

describe("launcher platform archives", () => {
  test("keeps Darwin as the default", () => {
    expect(bunArchives()).toEqual({ arm64: "bun-darwin-aarch64.zip", x86_64: "bun-darwin-x64-baseline.zip" });
    expect(bunArchives("darwin")).toEqual(bunArchives());
  });
  test("uses Linux arm64 and baseline Intel archives", () => {
    expect(bunArchives("linux")).toEqual({ arm64: "bun-linux-aarch64.zip", x86_64: "bun-linux-x64-baseline.zip" });
  });
  test.each(["", "windows", "../linux"])("refuses an unsupported platform %s", platform => {
    expect(() => bunArchives(platform)).toThrow("Unsupported launcher platform");
  });
});

describe("Mac runtime manifest", () => {
  const bytes = new TextEncoder().encode("archive fixture");
  const name = "bun-darwin-aarch64.zip";
  const hash = digest(bytes, "sha256");
  test("accepts the exact named Bun checksum", () => {
    expect(verifiedBun(bytes, `${hash}  ${name}\n`, name)).toBe(hash);
    expect(verifiedBun(bytes, `${hash} *${name}\n`, name)).toBe(hash);
  });
  test.each([`${"0".repeat(64)}  ${name}`, `${hash}  different.zip`, "bad checksum", `${hash}  ../${name}`])("rejects a mismatched archive or checksum: %s", sums => {
    expect(() => verifiedBun(bytes, sums, name)).toThrow();
  });
  const revision = "a".repeat(40);
  const integrity = `sha512-${digest(bytes, "sha512")}`;
  const valid = { name: "delegatus-cli", version: "2.0.0", gitHead: revision, dist: { tarball: "https://registry.npmjs.org/delegatus-cli/-/delegatus-cli-2.0.0.tgz", integrity } };
  test("pins package version, revision, URL and publisher integrity", () => {
    expect(validatePackage(valid, "2.0.0", revision, integrity)).toEqual({ version: "2.0.0", gitHead: revision, tarball: valid.dist.tarball, integrity });
  });
  test.each([
    { ...valid, name: "other" }, { ...valid, version: "1.0.0" }, { ...valid, gitHead: "b".repeat(40) },
    { ...valid, dist: { ...valid.dist, tarball: "http://registry.npmjs.org/delegatus-cli/-/archive.tgz" } },
    { ...valid, dist: { ...valid.dist, tarball: "https://registry.npmjs.org.evil.invalid/delegatus-cli/-/archive.tgz" } },
    { ...valid, dist: { ...valid.dist, integrity: "sha256-invalid" } },
    { ...valid, dist: { ...valid.dist, tarball: "https://registry.npmjs.org/delegatus-cli/-/delegatus-cli-1.11.0.tgz" } },
  ])("refuses changed registry identity %#", value => {
    expect(() => validatePackage(value, "2.0.0", revision, integrity)).toThrow();
  });
  test("refuses integrity different from the publisher", () => {
    expect(() => validatePackage(valid, "2.0.0", revision, "sha512-different")).toThrow();
  });
});

describe("Mac smoke rendered evidence", () => {
  const label = "reuse-en-Light-minimum";
  test("refuses the ready-only reuse evidence from the native run", () => {
    expect(hasRenderedEvidence([`${label}/001-ready.png`], label)).toBe(false);
  });
  test("accepts the completed post-navigation page frame", () => {
    expect(hasRenderedEvidence([`${label}/001-ready.png`, `${label}/002-page.png`], label)).toBe(true);
  });
  test.each([
    { frames: [] },
    { frames: ["reuse-uk-Light-minimum/002-page.png"] },
    { frames: [`${label}-other/002-page.png`] },
    { frames: [`${label}/002-page.png.partial`] },
    { frames: [`${label}/002-page-extra.png`] },
    { frames: [`${label}/nested/002-page.png`] },
  ])("refuses missing, unrelated or incomplete page evidence %#", ({ frames }) => {
    expect(hasRenderedEvidence(frames, label)).toBe(false);
  });
  test("keeps native dialog evidence without a web navigation", () => {
    expect(hasRenderedEvidence(["confirm-en-Light-minimum/001-needs-install.png"], "confirm-en-Light-minimum")).toBe(true);
    expect(hasRenderedEvidence(["confirm-en-light-minimum/001-needs-install.png"], "confirm-en-Light-minimum")).toBe(true);
    expect(hasRenderedEvidence(["other-confirm-en-Light-minimum/001-needs-install.png"], "confirm-en-Light-minimum")).toBe(false);
    for (const mode of ["missing-key", "wrong-key", "community-stopped"]) {
      expect(hasRenderedEvidence([`legacy-${mode}-en/001-access-unavailable.png`], `legacy-${mode}-en`)).toBe(true);
    }
  });
  test.each(["already-running", "app-started", "protected", "community-running"].flatMap(mode => ["en", "uk"].map(language => `legacy-${mode}-${language}`)))("requires a finished page for %s", label => {
    const frames = [`${label}/002-page.png`];
    expect(hasRenderedEvidence([`${label}/001-ready.png`, `${label}/002-page-loading.png`], label)).toBe(false);
    expect(hasFinishedPageEvidence(frames, label, "WEB language=en-US ready=complete\nCAPTURED page")).toBe(false);
    expect(hasFinishedPageEvidence(frames, label, "PAGE state=loading-shell\nCAPTURED page")).toBe(false);
    expect(hasFinishedPageEvidence(frames, label, "PAGE state=finished")).toBe(false);
    expect(hasFinishedPageEvidence(frames, label, "CAPTURED page\nPAGE state=finished")).toBe(false);
    expect(hasFinishedPageEvidence([], label, "PAGE state=finished\nCAPTURED page")).toBe(false);
    expect(hasFinishedPageEvidence(frames, label, "PAGE state=finished\nCAPTURED page\nPAGE failed: loading-shell")).toBe(false);
    expect(hasFinishedPageEvidence(frames, label, "PAGE state=loading-shell\nPAGE state=finished\nCAPTURED page\n")).toBe(true);
  });
  test("requires the same completion acknowledgment for own-installation reuse", () => {
    for (const reuse of [label, "protected-reuse-uk-dark"]) {
      const frames = [`${reuse}/002-page.png`];
      expect(hasRenderedEvidence([`${reuse}/001-ready.png`], reuse)).toBe(false);
      expect(hasFinishedPageEvidence(frames, reuse, "CAPTURED page")).toBe(false);
      expect(hasFinishedPageEvidence(frames, reuse, "PAGE state=finished\nCAPTURED page")).toBe(true);
    }
  });
});

describe("Mac page readiness probe", () => {
  const script = readFileSync(new URL("../../macos/Resources/page-readiness.js", import.meta.url), "utf8");
  function probe(html: string, ready = "complete") {
    const dom = new Window();
    dom.document.body.innerHTML = html;
    Object.defineProperty(dom.document, "readyState", { value: ready });
    // This DOM has no layout engine; provide a painted rectangle for visible
    // elements. The resource itself still parses and queries the real markup.
    const paintedRects = dom.document.body.getClientRects();
    paintedRects.length = 1;
    dom.HTMLElement.prototype.getClientRects = () => paintedRects;
    return { dom, state: () => dom.eval(script) as string };
  }
  test.each(["loading", "interactive"])("waits for document %s", ready => {
    const { dom, state } = probe("<main>Delegatus</main>", ready);
    try { expect(state()).toBe("document-loading"); } finally { dom.close(); }
  });
  test.each([
    '<div data-skeleton="board">Loading…</div>',
    '<div class="kb" data-kanban-skeleton><span>Завантаження…</span></div>',
    '<div data-kanban-columns-skeleton>In progress</div>',
    '<div aria-busy="true">Delegatus</div>',
    '<span class="skeleton-pulse">Loading…</span>',
  ])("rejects a completed document with a loading shell %#", html => {
    const { dom, state } = probe(html);
    try { expect(state()).toBe("loading-shell"); } finally { dom.close(); }
  });
  test("rejects an empty document", () => {
    const { dom, state } = probe("");
    try { expect(state()).toBe("empty"); } finally { dom.close(); }
  });
  test("observes delayed content replacing the retained legacy shell", () => {
    const { dom, state } = probe('<main><div data-skeleton="board">Loading…</div></main>');
    try {
      expect(state()).toBe("loading-shell");
      dom.document.querySelector("main")!.innerHTML = "<h1>Overview</h1><p>No tasks</p><span>reconnecting</span>";
      expect(state()).toBe("finished");
    } finally { dom.close(); }
  });
  test("keeps refusing a lasting loading shell", () => {
    const { dom, state } = probe('<main data-kanban-skeleton>Loading…</main>');
    try { for (let observation = 0; observation < 4; observation++) expect(state()).toBe("loading-shell"); }
    finally { dom.close(); }
  });
  test("ignores hidden loading placeholders on a painted page", () => {
    const { dom, state } = probe('<main>Налаштування Delegatus</main><div data-skeleton="board" style="display:none">Loading…</div>');
    try { expect(state()).toBe("finished"); } finally { dom.close(); }
  });
});

describe("Mac smoke fixture input", () => {
  test.each([undefined, "", "fixture input\n"])("preserves supplied stdin and closes absent stdin %#", input => {
    const result = execFileSync("/bin/cat", [], { encoding: "utf8", stdio: smokeStdio(input), input, timeout: 10_000 });
    expect(result).toBe(input ?? "");
  });
});

describe("Mac smoke session environment", () => {
  const session = { user: "runner-fixture", home: "/fixture/cases/h3" };
  test("keeps server settings while the case home and fixed session values win", () => {
    const environment = smokeEnvironment(session, { LLV_LANG: "uk", LLV_TOKEN: "fixture", HOME: "/foreign", PATH: "/foreign/bin", DELEGATUS_TELEMETRY: "1" });
    expect(environment).toEqual({
      LLV_LANG: "uk", LLV_TOKEN: "fixture",
      HOME: session.home, USER: session.user, LOGNAME: session.user,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin", DELEGATUS_TELEMETRY: "0",
    });
  });
  test("inherits nothing from the driver's own environment", () => {
    expect(Object.keys(smokeEnvironment(session)).sort()).toEqual(["DELEGATUS_TELEMETRY", "HOME", "LOGNAME", "PATH", "USER"]);
  });
  test.each([
    { user: "", home: "/fixture/home" },
    { user: "runner-fixture", home: "relative/home" },
    { user: "runner-fixture", home: undefined },
  ])("refuses a session without a user or an absolute home %#", context => {
    expect(() => smokeEnvironment(context)).toThrow("Invalid smoke session context");
  });
});

describe("Mac smoke app session data", () => {
  test("names only the bundle's own preferences, restored windows and web data under the runner home", () => {
    const paths = appSessionData("/fixture/runner", "org.delegatus.app");
    expect(paths).toEqual([
      "/fixture/runner/Library/Preferences/org.delegatus.app.plist",
      "/fixture/runner/Library/Saved Application State/org.delegatus.app.savedState",
      "/fixture/runner/Library/WebKit/org.delegatus.app",
      "/fixture/runner/Library/Caches/org.delegatus.app",
      "/fixture/runner/Library/HTTPStorages/org.delegatus.app",
      "/fixture/runner/Library/HTTPStorages/org.delegatus.app.binarycookies",
    ]);
  });
  test.each([
    ["relative", "org.delegatus.app"],
    ["/fixture/runner", ""],
    ["/fixture/runner", "../Library"],
    ["/fixture/runner", "org/delegatus"],
    ["/fixture/runner", "single"],
  ])("refuses an owner that could reach beyond the bundle's data %#", (runnerHome, bundle) => {
    expect(() => appSessionData(runnerHome, bundle)).toThrow("Invalid app session data owner");
  });
});

describe("Intel smoke architecture guard", () => {
  test.each([
    { status: 0, stdout: "0\n", stderr: "", translated: false },
    { status: 1, stdout: "", stderr: "sysctl: unknown oid 'sysctl.proc_translated'\n", translated: false },
    { status: 0, stdout: "1\n", stderr: "", translated: true },
  ])("classifies documented translation probe result %#", ({ status, stdout, stderr, translated }) => {
    expect(intelIsTranslated({ status, stdout, stderr })).toBe(translated);
  });
  test.each([
    { status: 2, stdout: "", stderr: "permission denied" },
    { status: 1, stdout: "", stderr: "sysctl: permission denied for sysctl.proc_translated" },
    { status: 0, stdout: "unexpected\n", stderr: "" },
  ])("refuses a genuine or malformed translation probe failure %#", result => {
    expect(() => intelIsTranslated(result)).toThrow();
  });
});

describe("Mac smoke process paths", () => {
  test("folds leading private aliases so ps rows match the run root", () => {
    expect(comparablePath("123 1 /private/tmp/dlg-a/h0/bun /private/var/f/cli.mjs")).toBe("123 1 /tmp/dlg-a/h0/bun /var/f/cli.mjs");
    expect(comparablePath("/private/etc/hosts")).toBe("/etc/hosts");
    expect(comparablePath("/tmp/dlg-a")).toBe("/tmp/dlg-a");
  });
  test("leaves a private segment inside another path alone", () => {
    expect(comparablePath("/fixture/private/tmp/bun")).toBe("/fixture/private/tmp/bun");
    expect(comparablePath("/private/Users/fixture")).toBe("/private/Users/fixture");
  });
});

describe("Mac smoke command failures", () => {
  test("keeps the exit, signal, Node code and both streams", () => {
    const text = commandFailure("/usr/bin/log", { status: null, signal: "SIGTERM", code: "ENOBUFS", stdout: "first\nlast line\n", stderr: "" });
    expect(text).toBe("/usr/bin/log exited 1 signal SIGTERM (ENOBUFS): stderr: (empty); stdout tail: first\nlast line");
  });
  test("keeps only the stdout tail of a large output", () => {
    const text = commandFailure("/usr/bin/log", { status: 1, stdout: `${"x".repeat(10_000)}END`, stderr: "bad predicate" });
    expect(text.startsWith("/usr/bin/log exited 1: stderr: bad predicate; stdout tail: ")).toBe(true);
    expect(text.endsWith("END")).toBe(true);
    expect(text.length).toBeLessThan(4200);
  });
  test("falls back to the error message when both streams are empty", () => {
    expect(commandFailure("/bin/ps", { status: 2, message: "spawn failed" })).toBe("/bin/ps exited 2: stderr: (empty); stdout tail: (empty); spawn failed");
  });
});

describe("Mac smoke commands that wait on the driver's own child", () => {
  // The shape of `stop --all` against a launcher the driver started: signal
  // the PID, then wait until kill -0 stops answering. A zombie still answers,
  // so this ends only when the caller's event loop reaps its child.
  const waitGone = 'kill "$1"; while kill -0 "$1" 2>/dev/null; do sleep 0.05; done; echo gone';
  test("finishes because the driver keeps reaping while it waits", async () => {
    const child = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
    const exited = new Promise(resolve => child.once("exit", (code, signal) => resolve(signal)));
    try {
      const output = await runCommand("/bin/sh", ["-c", waitGone, "sh", String(child.pid)], { timeout: 10_000 });
      expect(output.trim()).toBe("gone");
      expect(await exited).toBe("SIGTERM");
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
  });
  test("rejects with the exit status and both streams", async () => {
    const failure = await runCommand("/bin/sh", ["-c", "echo out; echo err >&2; exit 3"]).catch(error => error);
    expect(failure.status).toBe(3);
    expect(commandFailure("/bin/sh", failure)).toBe("/bin/sh exited 3: stderr: err; stdout tail: out");
  });
  test("rejects a command that outlives its deadline with the signal", async () => {
    const failure = await runCommand("/bin/sleep", ["5"], { timeout: 200 }).catch(error => error);
    expect(failure.status).toBe(null);
    expect(failure.signal).toBe("SIGTERM");
    expect(commandFailure("/bin/sleep", failure)).toStartWith("/bin/sleep exited 1 signal SIGTERM: stderr: (empty); stdout tail: (empty)");
  });
  test("gives a command that reads stdin an immediate end of input", async () => {
    expect(await runCommand("/bin/cat", [], { timeout: 5_000 })).toBe("");
  });
});

describe("Mac smoke plain failure verdict", () => {
  test.each([
    "Delegatus did not become ready in time. Open Logs, check the last error, then try again.",
    "Delegatus не запустився вчасно. Відкрийте журнали, перевірте останню помилку й повторіть спробу.",
  ])("accepts the localized failure without the earlier probe log: %s", message => {
    expect(plainFailureMessage(`PROBE busy HEAD 404\nSTATE failed ${message}\nCAPTURED frame`)).toBe(message);
  });
  test.each([
    "", "PROBE busy HEAD 404", "STATE failed\nCAPTURED frame", "STATE failed HEAD 404",
    "STATE failed Open Logs\nLISTENER refused fixture", "STATE failed Open Logs\nSTART timed out",
  ])("rejects missing or technical window text %#", log => {
    expect(() => plainFailureMessage(log)).toThrow();
  });
});

describe("Mac smoke process cleanup", () => {
  async function fixture(action: (context: ReturnType<typeof contextFor>) => Promise<void>) {
    const context = contextFor(mkdtempSync(join(tmpdir(), "mac-smoke-cleanup-")));
    try { await action(context); }
    finally {
      // Also reap children when testing a broken end(), so a red run leaks none.
      for (const { child } of context.children) if (!exited(child)) child.kill("SIGKILL");
      await Promise.all(context.children.map(({ closed }) => closed));
      for (const { child } of context.children) expect(alive(child.pid)).toBe(false);
      rmSync(context.home, { recursive: true, force: true });
    }
  }

  function contextFor(home: string) {
    const owned = new Map<number, ChildProcess>();
    const cleanupPIDs = new Set<number>();
    const evidenceFilters = new Map<number, number | undefined>();
    const children: { child: ChildProcess; closed: Promise<unknown> }[] = [];
    const options = {
      owned,
      cleanupPIDs,
      evidenceFilters,
      until: async (label: string, check: () => boolean) => {
        const deadline = Date.now() + 5_000;
        while (!check()) {
          assert(Date.now() < deadline, label);
          await new Promise(resolve => setTimeout(resolve, 5));
        }
      },
      run: (command: string, args: string[]) => execFileSync(command, args, { encoding: "utf8", timeout: 5_000 }),
    };
    return {
      home, owned, children, cleanupPIDs, evidenceFilters,
      async start(command = "/bin/sleep", args = ["30"], register = true, detached = false) {
        const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"], detached });
        children.push({ child, closed: new Promise(resolve => child.once("close", resolve)) });
        await once(child, "spawn");
        assert(child.pid && child.pid > 1, "fixture child started");
        if (register) { owned.set(child.pid, child); cleanupPIDs.add(child.pid); }
        return child;
      },
      app(child: ChildProcess, log = "") {
        const directory = join(home, "Library/Logs/Delegatus");
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, `app-fixture-${child.pid}.log`), log);
        return { process: child, pid: child.pid, home };
      },
      end: (entry: unknown) => end(entry, options),
      reapFilters: () => reapEvidenceFilters({ ...options, requireStopped: true }),
    };
  }

  test("final census keeps detached raw children visible after cleanup forgets them", async () => {
    await fixture(async context => {
      const child = await context.start(undefined, undefined, true, true);
      const pid = child.pid!;
      expect(processCensus(context.cleanupPIDs)).toEqual([{ pid, running: true }]);
      await context.end(child);
      expect(context.owned.size).toBe(0);
      expect(processCensus(context.cleanupPIDs)).toEqual([{ pid, running: false }]);
    });
  });

  for (const kind of ["raw child", "app record"]) {
    test(`smoke cleanup terminates and forgets a recorded ${kind}`, async () => {
      await fixture(async context => {
        const child = await context.start();
        const entry = kind === "raw child" ? child : context.app(child);
        await context.end(entry);
        expect(child.signalCode).toBe("SIGTERM");
        expect(alive(child.pid)).toBe(false);
        expect(context.owned.size).toBe(0);
        await context.end(entry);
      });
    });

    test(`smoke cleanup forgets an already exited ${kind}`, async () => {
      await fixture(async context => {
        const child = await context.start();
        const entry = kind === "raw child" ? child : context.app(child);
        const stopped = once(child, "exit");
        child.kill("SIGTERM");
        await stopped;
        await context.end(entry);
        expect(alive(child.pid)).toBe(false);
        expect(context.owned.size).toBe(0);
      });
    });
  }

  test("smoke assertion failure still cleans the app, raw replacement, launcher and server", async () => {
    await fixture(async context => {
      const app = context.app(await context.start());
      const replacement = await context.start(undefined, undefined, true, true);
      const launcher = await context.start(undefined, undefined, true, true);
      const server = await context.start(undefined, undefined, true, true);
      const failure = new assert.AssertionError({ message: "fixture readiness assertion" });
      let observed;
      try {
        try { throw failure; }
        finally {
          await context.end(app);
          await context.end(replacement);
          await context.end(launcher);
          await context.end(server);
        }
      } catch (error) { observed = error; }
      expect(observed).toBe(failure);
      expect(context.owned.size).toBe(0);
      expect(processCensus(context.cleanupPIDs).every(row => !row.running)).toBe(true);
      for (const { child } of context.children) {
        expect(child.signalCode).toBe("SIGTERM");
        expect(alive(child.pid)).toBe(false);
      }
    });
  });

  test("smoke app cleanup reaps its recorded evidence filter when no launcher started", async () => {
    await fixture(async context => {
      const child = await context.start();
      const filter = await context.start("/usr/bin/sed", process.platform === "darwin" ? ["-l", "-e", ""] : ["-l", "0", "-e", ""], false);
      const peer = await context.start(undefined, undefined, false);
      const app = context.app(child, `EVIDENCE-FILTER pid ${filter.pid}\n`);
      context.app(peer, `EVIDENCE-FILTER pid ${peer.pid}\n`);
      await context.end(app);
      expect(child.signalCode).toBe("SIGTERM");
      expect(filter.signalCode).toBe("SIGTERM");
      expect(alive(filter.pid)).toBe(false);
      expect(alive(peer.pid)).toBe(true);
      expect(context.owned.size).toBe(0);
      expect(processCensus(context.cleanupPIDs)).toEqual([child.pid!, filter.pid!].sort((a, b) => a - b).map(pid => ({ pid, running: false })));
    });
  });

  test("smoke app exit preserves the live launcher's filter until final teardown", async () => {
    await fixture(async context => {
      const child = await context.start();
      const filter = await context.start("/usr/bin/sed", process.platform === "darwin" ? ["-l", "-e", ""] : ["-l", "0", "-e", ""], false);
      const launcher = await context.start();
      const app = context.app(child, `EVIDENCE-FILTER pid ${filter.pid}\nAPP-LAUNCHER pid ${launcher.pid}\n`);
      await context.end(app);
      expect(alive(child.pid)).toBe(false);
      expect(alive(launcher.pid)).toBe(true);
      expect(alive(filter.pid)).toBe(true);
      expect(context.evidenceFilters.get(filter.pid!)).toBe(launcher.pid);
      await expect(context.reapFilters()).rejects.toThrow("must exit before evidence filter cleanup");
      expect(alive(filter.pid)).toBe(true);
      await context.end(launcher);
      await context.reapFilters();
      expect(filter.signalCode).toBe("SIGTERM");
      expect(context.evidenceFilters.size).toBe(0);
      expect(processCensus(context.cleanupPIDs).every(row => !row.running)).toBe(true);
    });
  });

  test("smoke filter cleanup accepts its natural exit after the launcher stops", async () => {
    await fixture(async context => {
      const child = await context.start();
      const filter = await context.start("/usr/bin/sed", process.platform === "darwin" ? ["-l", "-e", ""] : ["-l", "0", "-e", ""], false);
      const launcher = await context.start();
      await context.end(context.app(child, `EVIDENCE-FILTER pid ${filter.pid}\nAPP-LAUNCHER pid ${launcher.pid}\n`));
      expect(alive(filter.pid)).toBe(true);
      const closed = once(filter, "exit");
      filter.stdin!.end();
      await closed;
      await context.end(launcher);
      await context.reapFilters();
      expect(filter.exitCode).toBe(0);
      expect(filter.signalCode).toBe(null);
      expect(context.evidenceFilters.size).toBe(0);
    });
  });

  for (const kind of ["unrelated command", "sed argument decoy"]) test(`smoke app cleanup refuses a filter PID with ${kind}`, async () => {
    await fixture(async context => {
      const child = await context.start();
      const peer = kind === "sed argument decoy"
        ? await context.start("/bin/sh", ["-c", "read fixture", "/usr/bin/sed", "-l", "fixture"], false)
        : await context.start(undefined, undefined, false);
      await expect(context.end(context.app(child, `EVIDENCE-FILTER pid ${peer.pid}\n`))).rejects.toThrow("belongs to this app fixture");
      expect(alive(child.pid)).toBe(false);
      expect(alive(peer.pid)).toBe(true);
      expect(context.owned.size).toBe(0);
    });
  });

  test("smoke cleanup ignores an unowned raw child and absent entries", async () => {
    await fixture(async context => {
      const peer = await context.start(undefined, undefined, false);
      await context.end(peer);
      await context.end(undefined);
      expect(alive(peer.pid)).toBe(true);
      expect(context.owned.size).toBe(0);
    });
  });
});
