import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "bun:test";
import {
  BROKEN_HOST, STUB_HOST, STUB_NEXT, availablePort, children, git, install, readRecord, registerSelfUpdateCleanup, release, request, served, socketAnswers, start, stateText, until,
} from "./__fixtures__/cli-self-update";

/*
 * #2007: the launcher's half of self-update, driven through the real
 * `bin/cli.mjs`. The install is a git checkout whose `next` and runtime host
 * are stubs committed into the repository, so every release worktree carries
 * them too: a stub answers with the directory it runs from, which is how the
 * test tells which release serves. Every child here is one the test started
 * (the CLI) or one the CLI started; the test signals only the CLI, by the
 * handle it spawned.
 */

registerSelfUpdateCleanup();

/* Where the key the Viewer gates on comes from. The first three reach it
   through the launcher's environment; the last three are a key the Viewer
   picks for itself from the key file, which the launcher never handed it. */
const KEY_SOURCES = ["LLV_TOKEN", "DELEGATUS_TOKEN", "generated", "links-grants", "links-public-address", "phone-access-after-start"] as const;

test("LLV_TOKEN web restart probes a protected page and its chunk while the supervisor and host stay up", async () => {
  const fixture = install();
  const token = randomBytes(16).toString("hex");
  fixture.env.LLV_TOKEN = token;
  delete fixture.env.DELEGATUS_TOKEN;
  fixture.env.LLV_VIEWER_CONTROL_URL = "http://127.0.0.1:1";
  const log = path.join(fixture.state, "fixture-readiness.jsonl");
  // Match the Viewer perimeter: GET / requires the key; static chunks are public.
  writeFileSync(path.join(fixture.checkout, "node_modules", ".bin", "next"), `
import { appendFileSync } from "node:fs";
import { join } from "node:path";
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT ?? process.argv[process.argv.indexOf("--port") + 1]),
  fetch(request) {
    const pathname = new URL(request.url).pathname;
    const authenticated = request.headers.get("authorization") === "Bearer " + process.env.LLV_TOKEN;
    appendFileSync(join(process.env.LLV_STATE_DIR, "fixture-readiness.jsonl"), JSON.stringify({ pathname, authenticated, pid: process.pid }) + "\\n");
    if (pathname === "/") {
      if (!authenticated) return new Response("Forbidden", { status: 403 });
      return new Response('<script src="/_next/static/chunks/app.js"></script>', { headers: { "content-type": "text/html" } });
    }
    if (pathname === "/_next/static/chunks/app.js") return new Response("// ready");
    return new Response("missing", { status: 404 });
  },
});
const stop = () => { server.stop(true); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
`);
  git(fixture.checkout, "add", "-f", ".");
  git(fixture.checkout, "commit", "--quiet", "-m", "protected page with a static chunk");
  fixture.first = git(fixture.checkout, "rev-parse", "HEAD");
  const running = await start(fixture);
  const before = await until(() => {
    const record = readRecord(fixture.state);
    return record.web.state === "healthy" && record.runtimeHost.state === "healthy" ? record : null;
  });
  expect((await fetch(`http://127.0.0.1:${running.port}/`)).status).toBe(403);
  const next = release(fixture, "protected-page-update");
  writeFileSync(log, "");
  writeFileSync(before.releasePointer, JSON.stringify({ ...next, checkoutHead: fixture.first }));
  request(before, "web", "restart-protected-page");
  const after = await until(() => {
    const record = readRecord(fixture.state);
    return record.web.requestId === "restart-protected-page" && record.web.pid !== before.web.pid
      && ["healthy", "failed"].includes(record.web.state) ? record : null;
  });
  expect(after.web).toMatchObject({ state: "healthy", revision: next.sha.slice(0, 7), error: null });
  const probes = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(probes).toContainEqual({ pathname: "/", authenticated: true, pid: after.web.pid });
  expect(probes).toContainEqual({ pathname: "/_next/static/chunks/app.js", authenticated: false, pid: after.web.pid });
  expect((await fetch(`http://127.0.0.1:${running.port}/`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
  expect(after.launcher.pid).toBe(before.launcher.pid);
  expect(after.runtimeHost).toMatchObject({ state: "healthy", pid: before.runtimeHost.pid });
  expect(await socketAnswers(before.socket)).toBe(true);
  expect(running.child.exitCode).toBeNull();
  expect(running.child.signalCode).toBeNull();
  expect(stateText(fixture.state)).not.toContain(token);
  expect(running.output()).not.toContain(token);
}, 60_000);

for (const tokenSource of KEY_SOURCES) {
  for (const { broken, automatic } of [
    { broken: false, automatic: false },
    { broken: true, automatic: false },
    { broken: false, automatic: true },
  ]) {
    test(`token-protected web restart uses ${tokenSource}, fallback=${broken}, automatic=${automatic}`, async () => {
      const fixture = install({ tokenProtected: true });
      const env = fixture.env as Record<string, string | undefined>;
      delete env.LLV_TOKEN;
      delete env.DELEGATUS_TOKEN;
      const fromEnvironment = tokenSource === "LLV_TOKEN" || tokenSource === "DELEGATUS_TOKEN";
      const fromKeyFile = !fromEnvironment && tokenSource !== "generated";
      const token = fromKeyFile ? randomBytes(16).toString("hex") : "fixture-update-access";
      const config = path.join(env.XDG_CONFIG_HOME as string, "delegatus");
      if (fromEnvironment) env[tokenSource] = token;
      if (fromKeyFile) {
        mkdirSync(path.join(fixture.state, "links"), { recursive: true });
        mkdirSync(config, { recursive: true });
        writeFileSync(path.join(config, "token"), `${token}\n`, { mode: 0o600 });
      }
      if (tokenSource === "links-grants") writeFileSync(path.join(fixture.state, "links", "grants.json"), "{}\n");
      if (tokenSource === "links-public-address") {
        writeFileSync(path.join(fixture.state, "links", "self.json"), JSON.stringify({ publicUrl: "https://board.example.test" }));
      }
      const running = await start(fixture, tokenSource === "generated" ? ["--hostname", "0.0.0.0"] : []);
      const before = await until(() => {
        const record = readRecord(fixture.state);
        return record.web.state === "healthy" && record.runtimeHost.state === "healthy" ? record : null;
      });
      const url = `http://127.0.0.1:${running.port}/`;
      if (tokenSource === "phone-access-after-start") {
        /* The phone-access button: the gate comes on in a Viewer whose
           launcher started before the choice was made. */
        expect((await fetch(url)).status).toBe(200);
        writeFileSync(path.join(config, "phone-access"), "tailscale\n");
      }
      expect((await fetch(url)).status).toBe(401);
      const next = release(fixture, "token-update", { broken });
      writeFileSync(before.releasePointer, JSON.stringify({ ...next, checkoutHead: fixture.first }));
      if (automatic) {
        writeFileSync(path.join(fixture.state, "self-update", "auto-admission.json"), JSON.stringify({
          id: "token-update-gate", until: Date.now() + 30_000,
        }));
        writeFileSync(before.requestFile, JSON.stringify({
          requestId: "restart-token-protected-web", role: "web", autoGateId: "token-update-gate",
        }));
      } else request(before, "web", "restart-token-protected-web");
      const after = await until(() => {
        const record = readRecord(fixture.state);
        return record.web.requestId === "restart-token-protected-web"
          && record.web.pid !== before.web.pid && ["healthy", "failed"].includes(record.web.state) ? record : null;
      });
      expect(after.web.state).toBe("healthy");
      expect(after.web.revision).toBe((broken ? fixture.first : next.sha).slice(0, 7));
      if (broken) expect(after.web.error).toMatchObject({ kind: "fell-back", revision: next.sha.slice(0, 7) });
      else expect(after.web.error).toBeNull();
      expect(after.runtimeHost.pid).toBe(before.runtimeHost.pid);
      expect(await socketAnswers(before.socket)).toBe(true);
      expect(running.child.exitCode).toBeNull();
      expect((await fetch(url)).status).toBe(401);
      if (tokenSource !== "generated") {
        const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
        expect(response.status).toBe(200);
        expect(await response.text()).toBe(broken ? fixture.checkout : next.dir);
      }
      if (fromKeyFile) {
        expect(stateText(fixture.state)).not.toContain(token);
        expect(running.output()).not.toContain(token);
      }
    }, 60_000);
  }
}

/* A key no header can carry: the probe goes out without it and is refused.
   The process that refused it is up and gating, so the restart ends with the
   release that served before still serving, never with no web. */
for (const invalidCharacter of ["\n", "\r", "\u0100", "\u0436", "\u00e9"] as const) {
  test(`a key the probe cannot send keeps the previous release serving and stays out of diagnostics (${JSON.stringify(invalidCharacter)})`, async () => {
    const fixture = install({ tokenProtected: true });
    const token = `fixture-prefix${invalidCharacter}fixture-suffix`;
    fixture.env.LLV_TOKEN = token;
    /* The dialog shows this record's text as written, so the launcher writes
       it in the operator's language. */
    const language = invalidCharacter === "\u0436" ? "uk" : "en";
    (fixture.env as Record<string, string | undefined>).LLV_LANG = language;
    const running = await start(fixture);
    const before = await until(() => {
      const record = readRecord(fixture.state);
      return record.web.state === "healthy" && record.runtimeHost.state === "healthy" ? record : null;
    });
    const url = `http://127.0.0.1:${running.port}/`;
    expect((await fetch(url)).status).toBe(401);
    const next = release(fixture, "malformed-token-update");
    writeFileSync(before.releasePointer, JSON.stringify({ ...next, checkoutHead: fixture.first }));
    request(before, "web", "restart-malformed-token");

    const after = await until(() => {
      const record = readRecord(fixture.state);
      return record.web.requestId === "restart-malformed-token" && record.web.pid !== before.web.pid && ["healthy", "failed"].includes(record.web.state) ? record : null;
    });
    expect(after.web.state).toBe("healthy");
    expect(after.web.revision).toBe(fixture.first.slice(0, 7));
    expect(after.web.error).toMatchObject({ kind: "fell-back", revision: next.sha.slice(0, 7) });
    expect(after.web.error?.detail).toContain("GET / answered 401");
    expect(after.web.pid).not.toBe(before.web.pid);
    expect(existsSync(`/proc/${after.web.pid}`)).toBe(true);
    /* Still up and still gating. */
    expect((await fetch(url)).status).toBe(401);
    expect(stateText(fixture.state)).not.toContain(token);
    expect(running.output()).not.toContain(token);
    expect(after.runtimeHost.pid).toBe(before.runtimeHost.pid);
    expect(await socketAnswers(before.socket)).toBe(true);
    expect(running.child.exitCode).toBeNull();

    /* With nothing new published the restarted release is the one that was
       serving, so a refusal keeps it without a second start. */
    writeFileSync(before.releasePointer, JSON.stringify({ sha: fixture.first, dir: fixture.checkout, checkoutHead: fixture.first }));
    request(after, "web", "restart-malformed-token-again");
    const again = await until(() => {
      const record = readRecord(fixture.state);
      return record.web.requestId === "restart-malformed-token-again" && record.web.pid !== after.web.pid && ["healthy", "failed"].includes(record.web.state) ? record : null;
    });
    expect(again.web.state).toBe("healthy");
    expect(again.web.error?.kind).toBe("message");
    expect(again.web.error?.text).toBe(language === "uk"
      ? "перевірка готовності не пройшла автентифікацію (GET / answered 401), тому лишився реліз, що працював до перезапуску"
      : "the readiness probe could not authenticate (GET / answered 401), so the release serving before the restart was kept");
    expect((await fetch(url)).status).toBe(401);
    expect(stateText(fixture.state)).not.toContain(token);
    expect(running.output()).not.toContain(token);
  }, 60_000);
}

test("a key with a tab inside is sent, and the restart moves onto the new release", async () => {
  const fixture = install({ tokenProtected: true });
  const token = "fixture-prefix\tfixture-suffix";
  fixture.env.LLV_TOKEN = token;
  const running = await start(fixture);
  const before = await until(() => {
    const record = readRecord(fixture.state);
    return record.web.state === "healthy" && record.runtimeHost.state === "healthy" ? record : null;
  });
  const next = release(fixture, "tab-token-update");
  writeFileSync(before.releasePointer, JSON.stringify({ ...next, checkoutHead: fixture.first }));
  request(before, "web", "restart-tab-token");
  const after = await until(() => {
    const record = readRecord(fixture.state);
    return record.web.requestId === "restart-tab-token" && record.web.pid !== before.web.pid && ["healthy", "failed"].includes(record.web.state) ? record : null;
  });
  expect(after.web.state).toBe("healthy");
  expect(after.web.error).toBeNull();
  expect(after.web.revision).toBe(next.sha.slice(0, 7));
  expect((await fetch(`http://127.0.0.1:${running.port}/`)).status).toBe(401);
  expect(stateText(fixture.state)).not.toContain(token);
  expect(running.output()).not.toContain(token);
}, 60_000);

test("a release whose web does not start gives way to the one it replaced, and says so", async () => {
  const fixture = install();
  const { port, child } = await start(fixture);
  const before = await until(() => { const record = readRecord(fixture.state); return record.web.state === "healthy" ? record : null; });
  const broken = release(fixture, "broken", { broken: true });
  writeFileSync(before.releasePointer, JSON.stringify({ sha: broken.sha, dir: broken.dir, checkoutHead: fixture.first }));

  request(before, "web", "restart-web-broken");
  const after = await until(() => {
    const record = readRecord(fixture.state);
    return record.web.requestId === "restart-web-broken" && record.web.state === "healthy" && record.web.error ? record : null;
  });
  expect(after.web.error).toMatchObject({ kind: "fell-back", revision: broken.sha.slice(0, 7) });
  expect(after.web.revision).toBe(fixture.first.slice(0, 7));
  expect(await served(port)).toBe(fixture.checkout);
  expect(child.exitCode).toBeNull();
}, 60_000);

for (const tokenProtected of [false, true]) {
test(`a web restart whose new and previous releases both fail leaves the web failed and the runtime host serving, LLV_TOKEN=${tokenProtected}`, async () => {
  const fixture = install({ tokenProtected });
  const token = randomBytes(16).toString("hex");
  delete fixture.env.DELEGATUS_TOKEN;
  if (tokenProtected) fixture.env.LLV_TOKEN = token;
  else delete fixture.env.LLV_TOKEN;
  fixture.env.LLV_VIEWER_CONTROL_URL = "http://127.0.0.1:1";
  const { port, child } = await start(fixture);
  const before = await until(() => { const record = readRecord(fixture.state); return record.web.state === "healthy" && record.runtimeHost.state === "healthy" ? record : null; });
  expect(await socketAnswers(before.socket)).toBe(true);
  const broken = release(fixture, "broken-web", { broken: true });
  const healthy = release(fixture, "healthy-web");
  writeFileSync(before.releasePointer, JSON.stringify({ sha: broken.sha, dir: broken.dir, checkoutHead: fixture.first }));
  /* The package root's own web fails too, so the fallback does not come up either. */
  const rootNext = path.join(fixture.checkout, "node_modules", ".bin", "next");
  writeFileSync(rootNext, STUB_NEXT(true));

  request(before, "web", "restart-web-both-broken");
  const failed = await until(() => {
    const record = readRecord(fixture.state);
    return record.web.requestId === "restart-web-both-broken" && record.web.state === "failed" ? record : null;
  });
  expect(failed.web.error?.kind).toBe("message");
  expect(existsSync(`/proc/${before.web.pid}`)).toBe(false);
  /* The launcher, the host process and its endpoint carried on, and stay up. */
  await Bun.sleep(1_500);
  expect(child.exitCode).toBeNull();
  expect(child.signalCode).toBeNull();
  const stillFailed = readRecord(fixture.state);
  expect(stillFailed.web.state).toBe("failed");
  expect(stillFailed.launcher.pid).toBe(before.launcher.pid);
  expect(stillFailed.runtimeHost).toMatchObject({ state: "healthy", pid: before.runtimeHost.pid });
  expect(existsSync(`/proc/${before.runtimeHost.pid}`)).toBe(true);
  expect(await socketAnswers(before.socket)).toBe(true);

  /* The next explicit web restart is still taken, and moves only the web. */
  writeFileSync(before.releasePointer, JSON.stringify({ sha: healthy.sha, dir: healthy.dir, checkoutHead: fixture.first }));
  request(stillFailed, "web", "restart-web-recovered");
  const recovered = await until(() => {
    const record = readRecord(fixture.state);
    return record.web.requestId === "restart-web-recovered" && record.web.state === "healthy" ? record : null;
  });
  expect(recovered.web.error).toBeNull();
  expect(recovered.web.revision).toBe(healthy.sha.slice(0, 7));
  const response = await fetch(`http://127.0.0.1:${port}/`, { headers: tokenProtected ? { authorization: `Bearer ${token}` } : {} });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(healthy.dir);
  expect(recovered.launcher.pid).toBe(before.launcher.pid);
  expect(recovered.runtimeHost.pid).toBe(before.runtimeHost.pid);
  expect(await socketAnswers(before.socket)).toBe(true);
  expect(child.exitCode).toBeNull();
  expect(child.signalCode).toBeNull();
  expect(stateText(fixture.state)).not.toContain(token);
}, 60_000);
}

test("the serving web is recovered with backoff after an unexpected exit", async () => {
  const fixture = install();
  const { port, child } = await start(fixture);
  const before = await until(() => { const record = readRecord(fixture.state); return record.web.state === "healthy" ? record : null; });
  // Signal exactly the child recorded by this test's own launcher.
  process.kill(before.web.pid!, "SIGTERM");
  const after = await until(() => {
    const record = readRecord(fixture.state);
    return record.web.state === "healthy" && record.web.pid !== before.web.pid ? record : null;
  });
  expect(after.launcher.pid).toBe(before.launcher.pid);
  expect(after.runtimeHost.pid).toBe(before.runtimeHost.pid);
  expect(await served(port)).toBe(fixture.checkout);
  expect(child.exitCode).toBeNull();
}, 30_000);

/* 2026-10-10: a process an old Viewer left in the service's cgroup made
   systemd start every replacement in that old cgroup path. Each Viewer here
   starts a helper that ignores SIGTERM and, once its Viewer is gone, forks a
   child that ignores it too and exits: nothing read while the Viewer ran can
   name that child. It also starts an agent, detached, which must live on. */
const GENERATION_STUCK = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n";
const GENERATION_HELPER = `
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
const viewer = process.ppid;
/* Ready once it knows its Viewer: stopped any earlier, it would never notice. */
writeFileSync(process.argv[4], String(viewer));
const timer = setInterval(() => {
  if (process.ppid === viewer) return;
  clearInterval(timer);
  const late = spawn(process.execPath, [process.argv[2]], { stdio: "ignore" });
  const stat = readFileSync("/proc/" + late.pid + "/stat", "utf8");
  writeFileSync(process.argv[3], late.pid + ":" + stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
  process.exit(0);
}, 25);
`;
const GENERATION_VIEWER = `
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const state = process.env.LLV_STATE_DIR;
const identity = (pid) => { const stat = readFileSync("/proc/" + pid + "/stat", "utf8"); return pid + ":" + stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]; };
const helper = spawn(process.execPath, [join(state, "generation-helper.mjs"), join(state, "generation-stuck.mjs"), join(state, "generation-late-" + process.pid), join(state, "generation-ready-" + process.pid)], { stdio: "ignore" });
const agent = spawn(process.execPath, [join(state, "generation-stuck.mjs")], { stdio: "ignore", detached: true });
agent.unref();
writeFileSync(join(state, "generation-" + process.pid + ".json"), JSON.stringify({ helper: identity(helper.pid), agent: identity(agent.pid) }));
`;

test.if(process.platform === "linux")("every Viewer generation's non-agent processes end before the next one starts, forks made after it stopped included", async () => {
  const fixture = install();
  writeFileSync(path.join(fixture.state, "generation-stuck.mjs"), GENERATION_STUCK);
  writeFileSync(path.join(fixture.state, "generation-helper.mjs"), GENERATION_HELPER);
  writeFileSync(path.join(fixture.state, "fixture-generation.mjs"), GENERATION_VIEWER);
  const { isAlive, readStartIdentity } = await import("../src/lib/selfUpdate/pid");
  const live = (recorded: string) => {
    const [pid, start] = recorded.split(":").map(Number);
    return isAlive(pid!) && readStartIdentity(pid!) === String(start);
  };
  /* Every helper, late child and agent this case's Viewers started. */
  const recordedProcesses: string[] = [];
  const generation = async (webPid: number) => {
    const report = await until(() => {
      try {
        if (readFileSync(path.join(fixture.state, `generation-ready-${webPid}`), "utf8") !== String(webPid)) return null;
        return JSON.parse(readFileSync(path.join(fixture.state, `generation-${webPid}.json`), "utf8")) as { helper: string; agent: string };
      } catch { return null; }
    });
    recordedProcesses.push(report.helper, report.agent);
    return report;
  };
  /* What the generation of `webPid` left: its helper, the child that helper
     forked after the Viewer was gone, and its agent. */
  const leftovers = (webPid: number, report: { helper: string; agent: string }) => {
    let late: string | null = null;
    try { late = readFileSync(path.join(fixture.state, `generation-late-${webPid}`), "utf8"); } catch { /* never forked */ }
    if (late) recordedProcesses.push(late);
    return { helper: live(report.helper), late: late === null ? null : live(late), agent: live(report.agent) };
  };
  let launcher: ReturnType<typeof spawn> | null = null;
  try {
    const { child } = await start(fixture);
    launcher = child;
    const first = await until(() => { const record = readRecord(fixture.state); return record.web.state === "healthy" ? record : null; });
    const firstReport = await generation(first.web.pid!);

    /* Replaced by a web restart: retired before its successor is started. */
    request(first, "web", "generation-restart");
    const second = await until(() => {
      const record = readRecord(fixture.state);
      return record.web.requestId === "generation-restart" && record.web.state === "healthy" && record.web.pid !== first.web.pid ? record : null;
    }, 30_000);
    expect(leftovers(first.web.pid!, firstReport)).toEqual({ helper: false, late: false, agent: true });
    const secondReport = await generation(second.web.pid!);

    /* Crashed: no shutdown of its own ran, and recovery starts the next one
       only once this generation is retired. */
    process.kill(second.web.pid!, "SIGKILL");
    const third = await until(() => {
      const record = readRecord(fixture.state);
      return record.web.state === "healthy" && record.web.pid !== second.web.pid ? record : null;
    }, 30_000);
    expect(leftovers(second.web.pid!, secondReport)).toEqual({ helper: false, late: false, agent: true });
    const thirdReport = await generation(third.web.pid!);

    /* Stopped with the service: retired before the launcher exits. */
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    expect(leftovers(third.web.pid!, thirdReport)).toEqual({ helper: false, late: false, agent: true });
    expect(third.launcher.pid).toBe(first.launcher.pid);
  } finally {
    /* On a launcher that retires nothing, a helper forks only once its Viewer
       is gone: stop the launcher first, then end everything recorded. */
    if (launcher && launcher.exitCode === null && launcher.signalCode === null) {
      const exited = new Promise<void>((resolve) => launcher!.once("exit", () => resolve()));
      launcher.kill("SIGTERM");
      await Promise.race([exited, Bun.sleep(15_000)]);
    }
    await Bun.sleep(300);
    for (const name of readdirSync(fixture.state)) {
      if (name.startsWith("generation-late-")) recordedProcesses.push(readFileSync(path.join(fixture.state, name), "utf8"));
      else if (/^generation-\d+\.json$/.test(name)) {
        const report = JSON.parse(readFileSync(path.join(fixture.state, name), "utf8")) as { helper: string; agent: string };
        recordedProcesses.push(report.helper, report.agent);
      }
    }
    for (const recorded of recordedProcesses) if (live(recorded)) process.kill(Number(recorded.split(":")[0]), "SIGKILL");
  }
}, 90_000);

for (const intervening of ["none", "runtime-host", "relaunch"] as const) {
test(`a foreign port owner is left alone and recovery survives ${intervening}`, async () => {
  const fixture = install();
  const { port, child } = await start(fixture);
  const before = await until(() => { const record = readRecord(fixture.state); return record.web.state === "healthy" ? record : null; });
  process.kill(before.web.pid!, "SIGTERM");
  await until(() => !existsSync(`/proc/${before.web.pid}`));
  const foreign = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("foreign") });
  try {
    request(before, "web", "foreign-port");
    const refused = await until(() => {
      const record = readRecord(fixture.state);
      return record.web.requestId === "foreign-port" && record.web.error?.kind === "port-in-use" ? record : null;
    });
    expect(refused.runtimeHost.pid).toBe(before.runtimeHost.pid);
    expect(await served(port)).toBe("foreign");
    expect(child.exitCode).toBeNull();
    if (intervening === "runtime-host") {
      request(before, "runtime-host", "intervening-host");
      await until(() => {
        const record = readRecord(fixture.state);
        return record.runtimeHost.requestId === "intervening-host" && record.runtimeHost.state === "healthy";
      });
    }
    if (intervening === "relaunch") {
      const next = release(fixture, "failed-preflight", { launcher: 'throw new Error("fixture preflight failure");' });
      writeFileSync(before.releasePointer, JSON.stringify({ ...next, checkoutHead: fixture.first }));
      writeFileSync(before.requestFile, JSON.stringify({ role: "relaunch", requestId: "intervening-relaunch", target: next.sha }));
      await until(() => {
        const record = readRecord(fixture.state);
        const launcher = record.launcher as typeof record.launcher & { requestId?: string; error?: { kind: string } };
        return launcher.requestId === "intervening-relaunch" && launcher.error?.kind === "fell-back";
      });
    }
  } finally { foreign.stop(true); }
  const after = await until(() => {
    const record = readRecord(fixture.state);
    return record.web.state === "healthy" && record.web.pid !== before.web.pid ? record : null;
  });
  if (intervening !== "runtime-host") expect(after.runtimeHost.pid).toBe(before.runtimeHost.pid);
  expect(await served(port)).toBe(fixture.checkout);
}, 30_000);
}

for (const source of ["argument", "environment"] as const) {
test(`web recovery consumes operator rotation once from ${source}`, async () => {
  const fixture = install();
  const log = path.join(fixture.root, "rotation-log");
  writeFileSync(path.join(fixture.checkout, "node_modules", ".bin", "next"),
    `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(log)}, String(process.env.LLV_ROTATE_OPERATOR_SPAWN_CAPABILITY) + "\\n");\n` + STUB_NEXT(false));
  const env = source === "environment" ? { ...fixture.env, LLV_ROTATE_OPERATOR_SPAWN_CAPABILITY: "1" } : fixture.env;
  const { port } = await start({ ...fixture, env }, source === "argument" ? ["--new-operator-token"] : []);
  const before = await until(() => { const record = readRecord(fixture.state); return record.web.state === "healthy" ? record : null; });
  process.kill(before.web.pid!, "SIGTERM");
  await until(() => { const record = readRecord(fixture.state); return record.web.state === "healthy" && record.web.pid !== before.web.pid ? record : null; });
  expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["1", "undefined"]);
  expect(await served(port)).toBe(fixture.checkout);
}, 30_000);
}

test("a second launcher preserves the live launcher's record and children", async () => {
  const fixture = install();
  const first = await start(fixture);
  const before = await until(() => { const record = readRecord(fixture.state); return record.web.state === "healthy" ? record : null; });
  const second = spawn(process.execPath, ["--bun", path.join(fixture.checkout, "bin", "cli.mjs"), "--no-open", "--port", String(await availablePort())], {
    cwd: fixture.checkout, env: fixture.env, stdio: "ignore",
  });
  children.add(second);
  await until(() => second.exitCode !== null);
  expect(second.exitCode).toBe(1);
  const after = readRecord(fixture.state);
  expect(after.launcher.pid).toBe(before.launcher.pid);
  expect(after.web.pid).toBe(before.web.pid);
  expect(after.runtimeHost.pid).toBe(before.runtimeHost.pid);
  expect(await served(first.port)).toBe(fixture.checkout);
}, 30_000);

test("a host restart whose new and previous releases both fail is retried by the backoff, never left down", async () => {
  const fixture = install();
  const { child } = await start(fixture);
  const before = await until(() => { const record = readRecord(fixture.state); return record.runtimeHost.state === "healthy" ? record : null; });
  const broken = release(fixture, "broken-host", { brokenHost: true });
  writeFileSync(before.releasePointer, JSON.stringify({ sha: broken.sha, dir: broken.dir, checkoutHead: fixture.first }));
  /* The package root's own host fails too, for as long as the restart takes. */
  const rootHost = path.join(fixture.checkout, "dist", "runtime-host.mjs");
  writeFileSync(rootHost, BROKEN_HOST);

  request(before, "runtime-host", "restart-host-both-broken");
  const failed = await until(() => {
    const record = readRecord(fixture.state);
    return record.runtimeHost.requestId === "restart-host-both-broken" && record.runtimeHost.state === "failed"
      && record.runtimeHost.error?.kind === "message" ? record : null;
  });
  /* The restart's own summary: both releases were tried. */
  expect(failed.runtimeHost.error?.kind).toBe("message");
  expect(existsSync(`/proc/${before.runtimeHost.pid}`)).toBe(false);

  /* A backoff attempt that fails before readiness is recorded as failed with
     its own exit, never left reading "starting" under a PID that is gone. */
  const retried = await until(() => {
    const record = readRecord(fixture.state);
    return record.runtimeHost.pid !== failed.runtimeHost.pid && record.runtimeHost.state === "failed" ? record : null;
  }, 15_000);
  expect(retried.runtimeHost.error).toMatchObject({ kind: "exit", code: 3 });
  expect(existsSync(`/proc/${retried.runtimeHost.pid}`)).toBe(false);

  /* The previous release can start again: the backoff finds it without anyone asking. */
  writeFileSync(rootHost, STUB_HOST);
  const back = await until(() => {
    const record = readRecord(fixture.state);
    return record.runtimeHost.state === "healthy" && record.runtimeHost.pid !== before.runtimeHost.pid ? record : null;
  }, 30_000);
  expect(back.runtimeHost.revision).toBe(fixture.first.slice(0, 7));
  expect(readlinkSync(`/proc/${back.runtimeHost.pid}/cwd`)).toBe(fixture.checkout);
  expect(child.exitCode).toBeNull();
}, 60_000);

for (const broken of [false, true]) {
  test(`a packaged install relaunches all processes and rolls back=${broken}`, async () => {
    const fixture = install();
    const next = release(fixture, "npm-package", { broken });
    writeFileSync(path.join(next.dir, "package.json"), JSON.stringify({ name: "delegatus-cli", version: "0.0.1" }));
    mkdirSync(path.join(next.dir, "dist", "standalone"), { recursive: true });
    writeFileSync(path.join(next.dir, "dist", "standalone", "server.js"), STUB_NEXT(broken));
    renameSync(path.join(fixture.checkout, ".git"), path.join(fixture.root, "saved-git"));
    const running = await start(fixture);
    const before = await until(() => { const r = readRecord(fixture.state); return r.web.state === "healthy" ? r : null; });
    expect(before.checkout).toBeNull();
    writeFileSync(before.releasePointer, JSON.stringify({ kind: "package", version: "0.0.1", baseVersion: "0.0.0", dir: next.dir, sha: next.sha }));
    writeFileSync(before.requestFile, JSON.stringify({ requestId: "package-relaunch", role: "relaunch", target: next.sha, rollbackPointer: null }));
    const after = await until(() => { const r = readRecord(fixture.state);
      return r.launcher.requestId === "package-relaunch" && r.launcher.state === "healthy" && r.web.state === "healthy" && r.runtimeHost.state === "healthy" ? r : null;
    }, 100_000);
    expect(after.launcher.pid).toBe(before.launcher.pid);
    expect(after.web.pid).not.toBe(before.web.pid);
    expect(after.runtimeHost.pid).not.toBe(before.runtimeHost.pid);
    expect(await served(running.port)).toBe(broken ? fixture.checkout : next.dir + "/dist/standalone");
    if (broken) { expect(after.launcher.error?.kind).toBe("fell-back"); expect(existsSync(before.releasePointer)).toBe(false); }
    else expect(after.launcher.revision).toBe(next.sha);
  }, 120_000);
}
