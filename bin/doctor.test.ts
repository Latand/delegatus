import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm, copyFile, symlink } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { agentBinaryCandidates } from "./agent-binaries.mjs";
import { doctorHost, doctorWhisperPython, runDoctor } from "./doctor.mjs";
import { formatDoctor, runDoctorCommand } from "./doctor-command.mjs";
import { CAPABILITY_IDS, type CapabilityReport, type DoctorHost, type Inspection, type ViewerInspection } from "../src/lib/doctor/contracts";

const NOW = Date.UTC(2026, 9, 21, 12);

function fakeHost(platform: NodeJS.Platform = "linux") {
  const home = path.resolve("fixture-home");
  const entries = new Map<string, Inspection>();
  const inspected: string[] = [];
  const host: DoctorHost = {
    home, platform, arch: "arm64", env: { PATH: path.join(home, "commands") }, now: () => NOW,
    inspect: async file => { inspected.push(file); return entries.get(file) ?? "absent"; },
    viewer: async () => "reachable",
  };
  for (const engine of ["claude", "codex"] as const) {
    entries.set(agentBinaryCandidates(engine, { home, platform, envPath: host.env.PATH })[0], "present");
    entries.set(path.join(home, `.${engine}`, engine === "claude" ? "projects" : "sessions"), "present");
  }
  entries.set(path.join(home, ".codex", "auth.json"), "present");
  entries.set(path.join(home, ".cache", "delegatus"), "present");
  entries.set(path.join(home, ".cache", "delegatus", "whisper-venv"), "present");
  entries.set(path.join(home, ".cache", "delegatus", "whisper-venv", "bin", "python"), "present");
  return { host, entries, inspected };
}

function capability(report: CapabilityReport, id: typeof CAPABILITY_IDS[number]) {
  return report.capabilities.find(row => row.id === id)!;
}

describe("read-only diagnostics registry", () => {
  for (const platform of ["linux", "darwin"] as const) test(`${platform} presence report is versioned, ordered and conservative`, async () => {
    const { host } = fakeHost(platform);
    const report = await runDoctor({ host });
    expect(report.schemaVersion).toBe(1);
    expect(report.generatedAt).toBe("2026-10-21T12:00:00.000Z");
    expect(report.platform).toEqual({ os: platform, arch: "arm64" });
    expect(report.capabilities.map(row => row.id)).toEqual([...CAPABILITY_IDS]);
    for (const row of report.capabilities) {
      expect(row.state).toBe(row.id === "transcription.local" ? "degraded" : "available");
      expect(row.reason).toBe(row.id === "transcription.local" ? "WHISPER_RUNTIME_UNCHECKED" : null);
      expect(row.durationMs).toBe(0);
      expect(row.timedOut).toBe(false);
    }
    expect(JSON.stringify(report)).not.toContain(host.home);
  });

  test("a fresh host names missing prerequisites and leaves history independent", async () => {
    const { host, entries } = fakeHost();
    entries.clear();
    const report = await runDoctor({ host });
    expect(report.capabilities.map(row => row.reason)).toEqual([
      "CLI_MISSING", "CLI_MISSING", "AUTH_ABSENT", "TRANSCRIPT_ROOT_MISSING",
      "TRANSCRIPT_ROOT_MISSING", "WHISPER_VENV_MISSING", null,
    ]);
    expect(capability(report, "transcripts.claude").state).toBe("degraded");
  });

  for (const [id, source] of [
    ["auth.codex", [".codex", "auth.json"]],
    ["transcripts.claude", [".claude", "projects"]],
    ["transcription.local", [".cache", "delegatus", "whisper-venv", "bin", "python"]],
  ] as const) test(`${id} unreadable source is unknown and reveals no error text`, async () => {
    const { host, entries } = fakeHost();
    entries.set(path.join(host.home, ...source), "unreadable");
    const report = await runDoctor({ host });
    expect(capability(report, id)).toMatchObject({ state: "unknown", reason: "PROBE_ERROR" });
    expect(capability(report, "engine.claude").state).toBe("available");
  });

  test("an unreadable binary is unknown, even with a later readable candidate", async () => {
    const { host, entries } = fakeHost();
    const candidates = agentBinaryCandidates("codex", { home: host.home, envPath: host.env.PATH });
    entries.set(candidates[0], "unreadable");
    entries.set(candidates[1], "present");
    expect(capability(await runDoctor({ host }), "engine.codex").state).toBe("unknown");
  });

  test("binary overrides and container shims are inspected without executing them", async () => {
    const { host, entries, inspected } = fakeHost();
    host.env.LLV_DOCKER_NSENTER_SHIMS = "1";
    host.env.LLV_CODEX_BINARY = path.join(host.home, "quoted ; command");
    entries.set(host.env.LLV_CODEX_BINARY, "present");
    const report = await runDoctor({ host });
    expect(capability(report, "engine.codex").state).toBe("available");
    expect(inspected).toContain(host.env.LLV_CODEX_BINARY);
    expect(inspected).toContain("/usr/local/bin/claude");
    expect(JSON.stringify(report) + formatDoctor(report)).not.toContain("quoted ; command");
  });

  test("oversized search paths fail closed without unbounded filesystem work", async () => {
    const { host, inspected } = fakeHost();
    host.env.PATH = "x".repeat(32769);
    const report = await runDoctor({ host });
    expect(capability(report, "engine.codex").reason).toBe("PROBE_ERROR");
    expect(inspected.some(file => file.includes("x".repeat(100)))).toBe(false);
  });

  for (const [answer, state, reason] of [
    ["reachable", "available", null], ["auth-required", "degraded", "VIEWER_AUTH_REQUIRED"],
    ["unreachable", "blocked", "VIEWER_UNREACHABLE"], ["unrecognized", "unknown", "VIEWER_UNRECOGNIZED"],
  ] as const) test(`viewer ${answer}`, async () => {
    const { host } = fakeHost();
    host.viewer = async (port) => { expect(port).toBe(12345); return answer; };
    expect(capability(await runDoctor({ host, port: 12345 }), "viewer.server")).toMatchObject({ state, reason });
  });

  test("hung probes expire; late rejections are handled and start no later reads", async () => {
    const { host, inspected } = fakeHost();
    let release!: (value: Inspection) => void;
    let rejectViewer!: (error: Error) => void;
    const pending = new Promise<Inspection>(resolve => { release = resolve; });
    host.inspect = async file => { inspected.push(file); return pending; };
    host.viewer = () => new Promise<ViewerInspection>((_, reject) => { rejectViewer = reject; });
    const report = await runDoctor({ host });
    expect(report.capabilities.every(row => row.state === "unknown" && row.reason === "PROBE_TIMEOUT" && row.timedOut)).toBe(true);
    const count = inspected.length;
    release("absent");
    rejectViewer(new Error("synthetic private detail"));
    await new Promise(resolve => setImmediate(resolve));
    expect(inspected.length).toBe(count);
    expect(JSON.stringify(report)).not.toContain("synthetic private detail");
  });

  test("Whisper cache selection respects explicit, current, legacy and former roots", async () => {
    const { host, entries } = fakeHost();
    const root = path.join(host.home, ".cache");
    const python = (...parts: string[]) => path.join(root, ...parts, "whisper-venv", "bin", "python");
    expect(await doctorWhisperPython(host)).toBe(python("delegatus"));
    entries.clear();
    entries.set(path.join(root, "agent-log-viewer"), "present");
    entries.set(path.join(root, "agent-log-viewer", "whisper-venv"), "present");
    expect(await doctorWhisperPython(host)).toBe(python("agent-log-viewer"));
    entries.clear();
    entries.set(path.join(root, "live-log-viewer", "whisper-venv"), "present");
    expect(await doctorWhisperPython(host)).toBe(python("live-log-viewer"));
    host.env.LLV_WHISPER_VENV = path.join(host.home, "chosen venv");
    expect(await doctorWhisperPython(host)).toBe(path.join(host.env.LLV_WHISPER_VENV, "bin", "python"));
  });

  test("Whisper unreadable cache does not turn into an absent interpreter", async () => {
    const { host, entries } = fakeHost();
    entries.set(path.join(host.home, ".cache", "delegatus"), "unreadable");
    expect(capability(await runDoctor({ host }), "transcription.local").reason).toBe("PROBE_ERROR");
  });
});

describe("thin doctor command", () => {
  test("JSON and both human languages consume the same report", async () => {
    const report = await runDoctor({ host: fakeHost().host });
    for (const [args, lang] of [[["--json"], "en"], [[], "en"], [[], "uk"]] as const) {
      const output: string[] = [];
      const exit = await runDoctorCommand([...args], { lang, run: async () => report, log: line => output.push(line) });
      expect(exit).toBe(0);
      expect(output).toEqual([args.length ? JSON.stringify(report) : formatDoctor(report, lang)]);
    }
    expect(formatDoctor(report, "en")).toContain("Python is present");
    expect(formatDoctor(report, "uk")).toContain("Python наявний");
  });

  test("blocked yields 1; unknown remains advisory; internal failures yield 2 without raw errors", async () => {
    const { host, entries } = fakeHost(); entries.clear();
    expect(await runDoctorCommand([], { run: options => runDoctor({ ...options, host }), log: () => {} })).toBe(1);
    host.inspect = async () => { throw new Error("private content"); };
    expect(await runDoctorCommand([], { run: options => runDoctor({ ...options, host }), log: () => {} })).toBe(0);
    const output: string[] = [];
    expect(await runDoctorCommand([], { run: async () => { throw new Error("private content"); }, log: line => output.push(line) })).toBe(2);
    expect(output.join()).not.toContain("private content");
  });

  test("only supported flags and bounded ports reach a probe", async () => {
    let calls = 0;
    const run = async () => { calls++; return runDoctor({ host: fakeHost().host }); };
    for (const args of [["--port"], ["--port", "0"], ["--port", "65536"], ["--port", "1;command"], ["--origin", "elsewhere"], ["--new-token"], ["--json", "--json"], ["--port", "4", "--port", "5"]]) {
      expect(await runDoctorCommand(args, { run, log: () => {} })).toBe(2);
    }
    expect(await runDoctorCommand(["--help"], { run, log: () => {} })).toBe(0);
    expect(calls).toBe(0);
    const ports: number[] = [];
    expect(await runDoctorCommand(["--port", "65535"], { run: async options => { ports.push(options?.port ?? 0); return run(); }, log: () => {} })).toBe(0);
    expect(ports).toEqual([65535]);
  });
});

test("packaged CLI runs offline from another cwd without custody, updates or writes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "doctor-package-"));
  const server = http.createServer((_req, res) => { res.writeHead(204, { "x-delegatus-diagnostics": "1" }); res.end(); });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const bin = path.join(root, "package", "bin");
    const home = path.join(root, "home");
    await mkdir(bin, { recursive: true }); await mkdir(home);
    for (const name of ["cli.mjs", "doctor.mjs", "doctor-command.mjs", "agent-binaries.mjs"]) {
      await copyFile(path.resolve("bin", name), path.join(bin, name));
    }
    // These modules would fail if doctor entered any launcher path.
    for (const name of ["launcher-credentials.mjs", "cli-checkout.mjs", "tailscale.mjs"]) {
      await writeFile(path.join(bin, name), 'throw new Error("launcher path entered");');
    }
    const config = path.join(home, "config");
    await mkdir(config);
    await mkdir(path.join(home, ".codex"));
    const credential = path.join(home, ".codex", "auth.json");
    const fixtureContent = "synthetic credential contents";
    await writeFile(credential, fixtureContent);
    const before = (await readdir(home, { recursive: true })).sort();
    for (const [lang, json, broken] of [["en", true, false], ["uk", false, false], ["en", true, true]] as const) {
      if (broken) await writeFile(path.join(bin, "doctor-command.mjs"), 'throw new Error("synthetic private detail");');
      const child = Bun.spawn([process.execPath, path.join(bin, "cli.mjs"), "doctor", ...(json ? ["--json"] : []), "--port", String(port)], {
        cwd: home, env: { PATH: "", HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: config,
          XDG_CACHE_HOME: path.join(home, "cache"), TMPDIR: tmpdir(), LLV_STATE_DIR: path.join(config, "state"),
          BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
          LLV_VIEWER_CONTROL_URL: `http://127.0.0.1:${port}`, LLV_LANG: lang,
          LLV_LAUNCHER_CREDENTIAL_HANDOFF: "1" }, stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      if (broken) {
        expect(exit).toBe(2);
        expect(stdout).toBe("");
        expect(stderr.trim()).toBe("Diagnostics could not complete.");
        continue;
      }
      expect(exit).toBe(1); // Engine and local-transcription executables are absent.
      expect(stderr).toBe("");
      if (json) {
        const report: CapabilityReport = JSON.parse(stdout);
        expect(report.schemaVersion).toBe(1);
        expect(capability(report, "auth.codex").state).toBe("available");
        expect(capability(report, "viewer.server").state).toBe("available");
      } else expect(stdout).toContain("Діагностика Delegatus");
      expect(stdout).not.toContain(fixtureContent); expect(stdout).not.toContain(home);
    }
    expect((await readdir(home, { recursive: true })).sort()).toEqual(before);
    expect(await readFile(credential, "utf8")).toBe(fixtureContent);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("real host recognizes only its endpoint and never follows redirects", async () => {
  let hits = 0;
  const target = http.createServer((_req, res) => { hits++; res.end(); });
  const source = http.createServer((_req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${(target.address() as { port: number }).port}` }); res.end();
  });
  try {
    await new Promise<void>(resolve => target.listen(0, "127.0.0.1", resolve));
    await new Promise<void>(resolve => source.listen(0, "127.0.0.1", resolve));
    expect(await doctorHost().viewer((source.address() as { port: number }).port, new AbortController().signal)).toBe("unrecognized");
    expect(hits).toBe(0);
  } finally {
    await Promise.all([source, target].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  }
});

test.skipIf(process.platform === "win32")("real cache resolver honors an existing rename symlink without creating one", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "doctor-cache-"));
  try {
    const legacy = path.join(root, "agent-log-viewer");
    await mkdir(path.join(legacy, "whisper-venv"), { recursive: true });
    await symlink(legacy, path.join(root, "delegatus"), "dir");
    const host = doctorHost(); host.env = { XDG_CACHE_HOME: root };
    expect(await doctorWhisperPython(host)).toBe(path.join(legacy, "whisper-venv", "bin", "python"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
