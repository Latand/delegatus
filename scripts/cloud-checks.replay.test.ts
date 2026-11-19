import { expect, test } from "bun:test";
import { AppServerCloudTransport, isExactCommand, cloudCommand, cloudInputDigest, runCloudChecks, type CloudJob, type CloudRpc } from "./cloud-checks";
import captures from "./cloud-checks.replay.fixture.json";

// Two captured provider renderings and exit-127 outputs. Repository paths,
// account fields, upload identifiers and receipt bindings use fixture values;
// quoting, command structure and stderr retain the observed bytes.
const job: CloudJob = {
  head: "a".repeat(40), tree: "b".repeat(40), base: "c".repeat(40), bundle: "bundle", timeoutMs: 1000,
  inputs: { LANG: "en_US.UTF-8", LOGNAME: "fixture", NODE_OPTIONS: "--max-old-space-size=11264", SHELL: "/bin/bash", USER: "fixture" },
};
const config = {
  account: { engine: "codex" as const, accountId: "fixture", kind: "managed" as const,
    home: "/fixture/account", transcriptRoot: "/fixture/transcripts", env: { NODE_ENV: "test" as const } },
  environmentId: "asenvcfg_fixture",
};
const cwd = "/workspace/repository";
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const receipt = (code = 0) => `DELEGATUS_GATE ${job.head} ${job.tree} ${job.base} ${cloudInputDigest(job.inputs)} ${code}\n`;
type Capture = typeof captures[number];
type RecordChange = { command?: (command: string, submitted: string) => string; output?: string; code?: number; status?: string; turnId?: string };

function replay(capture: Capture, change: RecordChange = {}) {
  const taskId = "00000000-0000-0000-0000-000000000001";
  const taskUrl = `codex://threads/${taskId}?hostId=durable`;
  let command = "", submittedCommand = "", now = 0, connects = 0;
  const reports: string[] = [];
  const rpc: CloudRpc = {
    cwd,
    async call(method, params) {
      if (method === "thread/start") return { model: "gpt-6.2-sol", thread: { id: taskId,
        environments: [{ environmentId: "ccarenv_fixture", environmentConfigId: config.environmentId, cwd }] } };
      if (method === "command/exec") return { exitCode: 0 };
      if (method === "turn/start") {
        const input = (params.input as { text: string }[])[0]!.text;
        const submitted = input.slice(input.indexOf("\n") + 1);
        submittedCommand = submitted;
        const upload = submitted.match(/\nupload='([^']+)'\n/)![1]!;
        expect(submitted).toBe(cloudCommand(job, { directory: upload, source: cwd }));
        command = `/bin/bash -lc ${quote(submitted)}`;
        return { turn: { id: "turn-fixture" } };
      }
      if (method === "thread/turns/list") return { data: [{ id: "turn-fixture", status: "completed" }] };
      if (method === "thread/items/list") return { data: [{ turnId: change.turnId ?? "turn-fixture", item: {
        type: "commandExecution", status: change.status ?? ((change.code ?? capture.exitCode) === 0 ? "completed" : "failed"),
        command: change.command?.(command, submittedCommand) ?? command, aggregatedOutput: change.output ?? capture.output,
        exitCode: change.code ?? capture.exitCode,
      } }] };
      return {};
    },
    close() {},
  };
  const transport = new AppServerCloudTransport(config, async () => { connects++; return rpc; }, line => reports.push(line),
    { now: () => now, sleep: async ms => { now += ms; } });
  return { transport, reports, taskUrl, connects: () => connects };
}

for (const [index, capture] of captures.entries()) {
  test(`capture ${index + 1}: historical shell rendering matches its submitted body`, () => {
    expect(isExactCommand(capture.command, capture.submittedCommand)).toBe(true);
    expect(capture.exitCode).toBe(127);
    expect(capture.output).toBe("env: ‘bun’: No such file or directory\n");
  });

  test(`capture ${index + 1}: the rendered wrapper accepts a bound receipt`, async () => {
    const { transport } = replay(capture, { output: receipt(), code: 0 });
    expect(await transport.run(job)).toEqual({ kind: "verdict", head: job.head, tree: job.tree, base: job.base,
      inputs: cloudInputDigest(job.inputs), code: 0 });
  });

  for (const bare of [false, true]) test(`capture ${index + 1}: missing Bun retains exit 127 and environment cause (bare ${bare})`, async () => {
    const fake = replay(capture, bare ? { command: (_command, submitted) => submitted } : {});
    const result = await fake.transport.run(job);
    expect(result).toMatchObject({ kind: "invalid", code: 127, diagnostic: { category: "environment", taskUrl: fake.taskUrl } });
    let local = 0;
    const reports: string[] = [];
    expect(await runCloudChecks(job, { run: async () => result }, async () => { local++; return 0; }, undefined, line => reports.push(line))).toBe(127);
    expect(local).toBe(0);
    expect(fake.connects()).toBe(1);
    for (const line of [reports[0]!, fake.reports[0]!]) {
      expect(line).toContain("[environment]");
      expect(line).toContain("exit 127");
      expect(line).toContain(fake.taskUrl);
    }
  });

  const mutations: Record<string, RecordChange> = {
    "changed body": { command: command => command.replace("set -eu", "set +e") },
    "second wrapper": { command: command => `/bin/bash -lc ${quote(command)}` },
    "another head": { output: receipt().replace(job.head, "d".repeat(40)) },
    "another tree": { output: receipt().replace(job.tree, "d".repeat(40)) },
    "another base": { output: receipt().replace(job.base, "d".repeat(40)) },
    "another input manifest": { output: receipt().replace(cloudInputDigest(job.inputs), "d".repeat(64)) },
    "another turn": { turnId: "other-turn" },
    "receipt exit mismatch": { output: receipt(1) },
    "failed status and zero exit": { status: "failed" },
    "declined status": { status: "declined" },
    "missing receipt": { output: "passed" },
    "extra argument": { command: command => command + " extra" },
    "extra command": { command: command => command + "; true" },
    "unclosed quote": { command: command => command + "'" },
    "dangling escape": { command: command => command + "\\" },
    "unsupported shell": { command: command => command.replace("/bin/bash", "/bin/sh") },
    "unsupported option": { command: command => command.replace("-lc", "-lic") },
    "command substitution": { command: command => `/bin/bash -lc "$(printf %s ${quote(command)})"` },
    "ANSI quoting": { command: command => `/bin/bash -lc $${quote(command)}` },
    "expansion": { command: command => command + '"$EXTRA"' },
    "redirection": { command: command => command + " > output" },
  };
  for (const [name, mutation] of Object.entries(mutations)) test(`capture ${index + 1}: refuses ${name}`, async () => {
    const fake = replay(capture, { code: 0, output: receipt(), ...mutation });
    let local = 0;
    expect(await runCloudChecks(job, fake.transport, async () => { local++; return 0; }, undefined, () => {})).toBe(1);
    expect(local).toBe(0);
    expect(fake.connects()).toBe(1);
    expect(fake.reports[0]).toContain(fake.taskUrl);
  });
}

const renderers = {
  single: quote,
  adjacent: (value: string) => "'" + value.replaceAll("'", `'"'"'`) + "'",
  double: (value: string) => '"' + value.replace(/[\\"$`]/g, char => "\\" + char) + '"',
};
for (const [name, render] of Object.entries(renderers)) for (const shell of ["bash", "/bin/bash"]) for (const option of ["-c", "-lc"]) {
  for (const tampered of [false, true]) test(`literal ${name} ${shell} ${option} wrapper (tampered ${tampered})`, async () => {
    const fake = replay(captures[0]!, { output: receipt(), code: 0,
      command: (_command, submitted) => ` ${shell}\t${option} ${render(tampered ? submitted + "\ntrue" : submitted)} ` });
    let local = 0;
    expect(await runCloudChecks(job, fake.transport, async () => { local++; return 0; }, undefined, () => {})).toBe(tampered ? 1 : 0);
    expect(local).toBe(0);
  });
}

for (const output of ["env: ‘node’: No such file or directory\n", "env: ‘bun’: Permission denied\n", "env: ‘bun': No such file or directory\n"]) {
  test(`a different environment error cannot claim the missing-Bun diagnosis: ${output.trim()}`, async () => {
    const fake = replay(captures[0]!, { output });
    expect(await fake.transport.run(job)).toMatchObject({ kind: "invalid", diagnostic: { category: "missing receipt" } });
  });
}

for (const code of [undefined, 0, -1, 256, 1.5, NaN, Infinity]) test(`invalid evidence cannot authorize a successful check: ${code}`, async () => {
  let local = 0;
  expect(await runCloudChecks(job, { run: async () => ({ kind: "invalid", code }) }, async () => { local++; return 0; }, undefined, () => {})).toBe(1);
  expect(local).toBe(0);
});
