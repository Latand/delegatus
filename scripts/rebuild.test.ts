import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sandboxes: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];
const rebuildScript = path.join(import.meta.dir, "rebuild.sh");
const previousState = process.env.LLV_STATE_DIR;
const { teamGate } = await import("@/lib/team/gate");
const { claimInstall } = await import("@/lib/team/members");
const { resetTeamStoreForTests, teamStore } = await import("@/lib/team/store");
const { NextRequest } = await import("next/server");
const CONTROL_KEY = "S".repeat(43);
const BEARER_KEY = "e7".repeat(16);
const { internalServiceTagFor } = await import("../bin/internalService.mjs");

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  resetTeamStoreForTests();
  if (previousState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousState;
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

function fixture(options: { team?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-rebuild-test-"));
  sandboxes.push(root);
  const bin = path.join(root, "bin"), home = path.join(root, "home"), state = path.join(root, "state");
  const capture = path.join(root, "request.json"), args = path.join(root, "request.args"), gitArgs = path.join(root, "git.args");
  fs.mkdirSync(bin);
  fs.mkdirSync(state);
  fs.mkdirSync(path.join(home, ".config", "agent-log-viewer"), { recursive: true });
  fs.writeFileSync(path.join(home, ".config", "agent-log-viewer", "service.env"), "");
  fs.writeFileSync(path.join(state, "operator-spawn-capability"), CONTROL_KEY, { mode: 0o600 });
  process.env.LLV_STATE_DIR = state;
  resetTeamStoreForTests();
  if (options.team) claimInstall(teamStore(), "Fixture owner", { surface: "desktop", browser: "chrome" });
  const gitStub = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" >> "$LLV_TEST_GIT_ARGS"
if [ -n "\${LLV_TEST_LS_REMOTE_FAILS:-}" ]; then exit 128; fi
printf '%s' "\${LLV_TEST_LS_REMOTE:-}"
`;
  fs.writeFileSync(path.join(bin, "git"), gitStub, { mode: 0o755 });
  // Capture the arguments of every Bun subprocess while retaining the real client.
  fs.writeFileSync(path.join(bin, "bun"), `#!/usr/bin/env bash
printf '%s\n' "$@" >> "$LLV_TEST_ARGS"
exec "$LLV_TEST_BUN" "$@"
`, { mode: 0o755 });
  const responses = { admissionStatus: 202, admissionBody: { state: "accepted", deploymentId: "deploy_test" } as unknown,
    phase: "succeeded", redirect: false, statusRedirect: false, admitted: 0, polls: 0, credentialed: 0,
    keys: new Set<string>(), phases: [] as string[], rawAdmission: null as string | null };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request): Promise<Response> {
    fs.appendFileSync(args, request.url + "\n");
    if (options.team) {
      const gate = teamGate(new NextRequest(request), { bearerAuthenticated: request.headers.get("authorization") === `Bearer ${BEARER_KEY}` });
      if (gate) return gate;
      if (request.headers.get("authorization") !== `Bearer ${BEARER_KEY}`) return Response.json({ error: "access key required" }, { status: 401 });
      expect(request.headers.get("x-llv-internal-service")).toStartWith("controller.");
      expect(request.headers.get("cookie")).toBeNull();
      expect(request.headers.get("x-llv-spawn-capability")).toBeNull();
      responses.credentialed++;
    }
    if (request.method === "POST") {
      const body = await request.text();
      fs.writeFileSync(capture, body);
      responses.keys.add(JSON.parse(body).idempotencyKey);
      responses.admitted++;
      if (responses.redirect) return Response.redirect(`http://127.0.0.1:${server.port}/credential-sink`, 307);
      if (responses.rawAdmission) return new Response(responses.rawAdmission, { status: responses.admissionStatus });
      return Response.json(responses.admissionBody, { status: responses.admissionStatus });
    }
    responses.polls++;
    if (responses.statusRedirect) return Response.redirect(`http://127.0.0.1:${server.port}/credential-sink`, 302);
    const phase = responses.phases.shift() ?? responses.phase;
    return Response.json({ phase, terminal: ["succeeded", "failed"].includes(phase), error: phase === "failed" ? "fixture failure" : null });
  } });
  servers.push(server);
  return { root, bin, home, state, capture, args, gitArgs, server, responses };
}

const CANONICAL_REMOTE = "https://canonical.invalid/live-log-viewer-next.git";
const MAIN_TIP = "b".repeat(40);

async function runRebuild(
  idempotencyKey: string,
  setup: ReturnType<typeof fixture>,
  revision?: string,
  options: {
    lsRemote?: string | null;
    deployRevision?: string;
    admissionStatus?: number;
    admissionBody?: unknown;
    curlFails?: boolean;
    env?: Record<string, string>;
  } = {},
) {
  const lsRemote = options.lsRemote === undefined ? `${MAIN_TIP}\trefs/heads/main\n` : options.lsRemote;
  const port = setup.server.port;
  setup.responses.admissionStatus = options.admissionStatus ?? 202;
  setup.responses.admissionBody = options.admissionBody ?? { state: "accepted", deploymentId: "deploy_test" };
  if (options.curlFails) setup.server.stop(true);
  const child = Bun.spawn(["bash", rebuildScript, ...(revision === undefined ? [] : [revision])], {
    cwd: setup.root,
    env: {
      ...process.env,
      HOME: setup.home,
      PATH: `${setup.bin}:${process.env.PATH ?? ""}`,
      PORT: String(port),
      XDG_CONFIG_HOME: path.join(setup.home, ".config"), LLV_STATE_DIR: setup.state,
      LLV_TEST_BUN: process.execPath, LLV_TOKEN: BEARER_KEY,
      LLV_DEPLOY_IDEMPOTENCY_KEY: idempotencyKey,
      LLV_TEST_CAPTURE: setup.capture,
      LLV_TEST_ARGS: setup.args,
      LLV_TEST_GIT_ARGS: setup.gitArgs,
      LLV_TEST_ADMISSION_STATUS: String(options.admissionStatus ?? 202),
      LLV_TEST_ADMISSION_BODY: JSON.stringify(
        options.admissionBody ?? { state: "accepted", deploymentId: "deploy_test" },
      ),
      ...(options.curlFails ? { LLV_TEST_CURL_FAILS: "1" } : {}),
      LLV_VIEWER_CANONICAL_REMOTE: CANONICAL_REMOTE,
      ...(lsRemote === null ? { LLV_TEST_LS_REMOTE_FAILS: "1" } : { LLV_TEST_LS_REMOTE: lsRemote }),
      ...(options.deployRevision === undefined ? {} : { LLV_DEPLOY_REVISION: options.deployRevision }),
      ...options.env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exitCode };

}

test("rebuild accepts a mixed-case positional revision and posts it lowercase", async () => {
  const setup = fixture();
  const revision = "aB".repeat(20);
  const result = await runRebuild("exact-revision", setup, revision);

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(fs.readFileSync(setup.capture, "utf8"))).toEqual({
    revision: revision.toLowerCase(),
    idempotencyKey: "exact-revision",
  });
});

for (const [name, revision] of [
  ["an empty argument", ""],
  ["39 lowercase hex characters", "a".repeat(39)],
  ["41 lowercase hex characters", "a".repeat(41)],
  ["embedded whitespace", `${"a".repeat(20)} ${"b".repeat(19)}`],
  ["a ref-like value", "refs/heads/main"],
  ["the origin/main alias the endpoint refuses", "origin/main"],
  ["an embedded newline", `${"a".repeat(20)}\n${"b".repeat(20)}`],
  ["an embedded carriage return", `${"a".repeat(20)}\r${"b".repeat(20)}`],
] as const) {
  test(`rebuild rejects ${name} before deployment admission`, async () => {
    const setup = fixture();
    const result = await runRebuild("invalid-revision", setup, revision);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("invalid revision");
    expect(result.stdout.toString()).not.toContain("deployment key");
    expect(result.stdout.toString()).not.toContain("deployment admitted");
    expect(fs.existsSync(setup.capture)).toBe(false);
  });
}

test("rebuild serializes a quoted 200-character idempotency key as JSON", async () => {
  const setup = fixture();
  const prefix = 'release"1\\';
  const idempotencyKey = prefix + "x".repeat(200 - prefix.length);
  const result = await runRebuild(idempotencyKey, setup);

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(fs.readFileSync(setup.capture, "utf8"))).toEqual({
    revision: MAIN_TIP,
    idempotencyKey,
  });
});

test("a timed-out request prints a shell-safe idempotency-key retry", async () => {
  const setup = fixture();
  const idempotencyKey = `retry key 'quoted' $(touch should-not-run);`;
  const result = await runRebuild(idempotencyKey, setup, undefined, { curlFails: true });

  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain(
    `LLV_DEPLOY_IDEMPOTENCY_KEY=retry\\ key\\ \\'quoted\\'\\ \\$\\(touch\\ should-not-run\\)\\; scripts/rebuild.sh ${MAIN_TIP}`,
  );
  expect(result.stdout.toString()).not.toContain("deployment key");
});

test("a bare rebuild reads the canonical main tip itself and posts the resolved SHA", async () => {
  const setup = fixture();
  const result = await runRebuild("refless-deploy", setup);

  expect(result.exitCode).toBe(0);
  expect(fs.readFileSync(setup.gitArgs, "utf8").split("\n").filter(Boolean)).toEqual([
    "ls-remote",
    CANONICAL_REMOTE,
    "refs/heads/main",
  ]);
  expect(JSON.parse(fs.readFileSync(setup.capture, "utf8"))).toEqual({
    revision: MAIN_TIP,
    idempotencyKey: "refless-deploy",
  });
  expect(result.stdout.toString()).toContain(`resolved refs/heads/main at ${CANONICAL_REMOTE}: ${MAIN_TIP}`);
});

test("a refused origin/main argument never reaches the remote or the endpoint", async () => {
  const setup = fixture();
  const result = await runRebuild("explicit-origin-main", setup, "origin/main");

  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("full 40-character hexadecimal commit SHA");
  expect(fs.existsSync(setup.gitArgs)).toBe(false);
  expect(fs.existsSync(setup.capture)).toBe(false);
});

test("a pinned SHA deploy never consults the remote", async () => {
  const setup = fixture();
  const revision = "c".repeat(40);
  const result = await runRebuild("pinned-sha", setup, revision);

  expect(result.exitCode).toBe(0);
  expect(fs.existsSync(setup.gitArgs)).toBe(false);
  expect(JSON.parse(fs.readFileSync(setup.capture, "utf8"))).toEqual({ revision, idempotencyKey: "pinned-sha" });
});

for (const [name, lsRemote] of [
  ["the remote is unreachable", null],
  ["the branch is absent", ""],
  ["the tip is not a full SHA", "not-a-sha\trefs/heads/main\n"],
] as const) {
  test(`rebuild refuses to deploy when ${name}`, async () => {
    const setup = fixture();
    const result = await runRebuild("unresolvable-main", setup, undefined, { lsRemote });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(CANONICAL_REMOTE);
    expect(fs.existsSync(setup.capture)).toBe(false);
  });
}

/* #1309 — `LLV_DEPLOY_REVISION` names the same thing the positional argument
   names, so it is held to the same case-insensitive contract and normalized
   before posting. Anything the endpoint would refuse is refused here first. */
test("LLV_DEPLOY_REVISION pins an uppercase SHA and posts it lowercase", async () => {
  const setup = fixture();
  const revision = "D4".repeat(20);
  const result = await runRebuild("env-pinned-sha", setup, undefined, { deployRevision: revision });

  expect(result.exitCode).toBe(0);
  expect(fs.existsSync(setup.gitArgs)).toBe(false);
  expect(JSON.parse(fs.readFileSync(setup.capture, "utf8"))).toEqual({
    revision: revision.toLowerCase(),
    idempotencyKey: "env-pinned-sha",
  });
});

test("LLV_DEPLOY_REVISION is validated like the argument", async () => {
  const setup = fixture();
  const result = await runRebuild("env-invalid-revision", setup, undefined, { deployRevision: "origin/main" });

  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("full 40-character hexadecimal commit SHA");
  expect(result.stdout.toString()).not.toContain("deployment key");
  expect(result.stdout.toString()).not.toContain("deployment admitted");
  expect(fs.existsSync(setup.gitArgs)).toBe(false);
  expect(fs.existsSync(setup.capture)).toBe(false);
});

test("rebuild rejects an idempotency key above the coordinator limit", async () => {
  const setup = fixture();
  const result = await runRebuild("x".repeat(201), setup);

  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("invalid deployment idempotency key");
  expect(fs.existsSync(setup.capture)).toBe(false);
});

test("rebuild keeps the Viewer credential out of loopback request arguments", async () => {
  const setup = fixture();
  const token = "viewer-secret?with&reserved=characters";
  fs.writeFileSync(path.join(setup.home, ".config", "agent-log-viewer", "service.env"), `LLV_TOKEN=${token}\n`);

  const result = await runRebuild("credential-free-request", setup);
  const args = fs.readFileSync(setup.args, "utf8");

  expect(result.exitCode).toBe(0);
  expect(args).not.toContain(token);
  expect(args).not.toContain("?k=");
  expect(args).toContain(`http://127.0.0.1:${setup.server.port}/api/runtime/deployments`);
  expect(args).toContain(`http://127.0.0.1:${setup.server.port}/api/runtime/deployments/deploy_test`);
});

test("a request the deployment endpoint refuses prints no started-deployment line", async () => {
  const setup = fixture();
  const result = await runRebuild("stub-refused", setup, undefined, {
    admissionStatus: 400,
    admissionBody: { error: "revision must be a full 40-character commit SHA", reason: "revision_invalid" },
  });

  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("deployment request failed (HTTP 400)");
  expect(result.stderr.toString()).toContain("revision_invalid");
  expect(result.stdout.toString()).not.toContain("deployment key");
  expect(result.stdout.toString()).not.toContain("deployment admitted");
  /* Everything the refusal left on stdout: the commit it would have deployed. */
  expect(result.stdout.toString().trim().split("\n")).toEqual([
    `resolved refs/heads/main at ${CANONICAL_REMOTE}: ${MAIN_TIP}`,
  ]);
});

test("a busy 409 receipt prints its deployment key and exits 2", async () => {
  const setup = fixture();
  const result = await runRebuild("stub-busy", setup, undefined, {
    admissionStatus: 409,
    admissionBody: { state: "busy", deploymentId: "deploy_busy" },
  });

  expect(result.exitCode).toBe(2);
  expect(result.stdout.toString()).toContain("deployment key: stub-busy");
  expect(result.stdout.toString()).toContain("deployment busy: deploy_busy");
  expect(result.stdout.toString()).not.toContain("deployment admitted");
});

test("an error 409 prints the server error without a started-deployment line", async () => {
  const setup = fixture();
  const result = await runRebuild("stub-conflict", setup, undefined, {
    admissionStatus: 409,
    admissionBody: { error: "idempotency key already belongs to another deployment" },
  });

  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("deployment request failed (HTTP 409)");
  expect(result.stderr.toString()).toContain("idempotency key already belongs to another deployment");
  expect(result.stdout.toString()).not.toContain("deployment key");
  expect(result.stdout.toString()).not.toContain("deployment admitted");
  expect(result.stdout.toString()).not.toContain("deployment busy");
});


test("actual host deploy CLI authenticates request and status through the team gate", async () => {
  const setup = fixture({ team: true });
  const result = await runRebuild("team-replay-key", setup, MAIN_TIP);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toContain("deployment admitted: deploy_test");
  expect(result.stdout).toContain("deployment phase: succeeded");
  expect(setup.responses.credentialed).toBe(2);
  const argv = fs.readFileSync(setup.args, "utf8");
  for (const secret of [CONTROL_KEY, BEARER_KEY, internalServiceTagFor(CONTROL_KEY, "controller")]) {
    expect(argv).not.toContain(secret);
    expect(result.stdout + result.stderr).not.toContain(secret);
  }
});

test("a team deploy without the existing control credential remains refused", async () => {
  const setup = fixture({ team: true });
  fs.rmSync(path.join(setup.state, "operator-spawn-capability"));
  const result = await runRebuild("uncredentialed-team", setup, MAIN_TIP);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("member_required");
  expect(result.stdout).not.toContain("deployment admitted");
  expect(setup.responses.admitted).toBe(0);
  expect(fs.existsSync(path.join(setup.state, "operator-spawn-capability"))).toBe(false);
});

test.each(["request", "status"] as const)("the actual deploy CLI refuses a %s redirect without forwarding credentials", async kind => {
  const setup = fixture({ team: true });
  setup.responses.redirect = kind === "request";
  setup.responses.statusRedirect = kind === "status";
  const result = await runRebuild("redirect-refused", setup, MAIN_TIP);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("redirect refused");
  expect(setup.responses.admitted).toBe(1);
  expect(setup.responses.polls).toBe(kind === "status" ? 1 : 0);
  expect(result.stdout).not.toContain("deployment phase: succeeded");
  const argv = fs.readFileSync(setup.args, "utf8");
  expect(argv).not.toContain("credential-sink");
  for (const secret of [CONTROL_KEY, BEARER_KEY, internalServiceTagFor(CONTROL_KEY, "controller")]) {
    expect(argv + result.stdout + result.stderr).not.toContain(secret);
  }
});

test("credentialed deployment replay preserves its key and receipt", async () => {
  const setup = fixture({ team: true });
  const first = await runRebuild("same-team-request", setup, MAIN_TIP);
  const body = fs.readFileSync(setup.capture, "utf8");
  const second = await runRebuild("same-team-request", setup, MAIN_TIP);
  expect(first.exitCode).toBe(0);
  expect(second.exitCode).toBe(0);
  expect(second.stdout).toBe(first.stdout);
  expect(fs.readFileSync(setup.capture, "utf8")).toBe(body);
  expect(setup.responses.keys.size).toBe(1);
  expect(setup.responses.credentialed).toBe(4);
});

test("a credentialed deploy reports progress before its terminal phase", async () => {
  const setup = fixture({ team: true });
  setup.responses.phases = ["building", "succeeded"];
  const result = await runRebuild("team-progress", setup, MAIN_TIP);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("deployment phase: building\ndeployment phase: succeeded");
  expect(setup.responses.polls).toBe(2);
  expect(setup.responses.credentialed).toBe(3);
});

test.each(["busy", "failed"] as const)("team deployment preserves the %s exit contract", async state => {
  const setup = fixture({ team: true });
  setup.responses.phase = "failed";
  const result = await runRebuild("team-terminal", setup, MAIN_TIP, state === "busy"
    ? { admissionStatus: 409, admissionBody: { state: "busy", deploymentId: "deploy_busy" } } : {});
  expect(result.exitCode).toBe(state === "busy" ? 2 : 1);
  expect(result.stdout).toContain(state === "busy" ? "deployment busy: deploy_busy" : "deployment phase: failed");
});

test("a server echo cannot copy a control credential into output or later process arguments", async () => {
  const setup = fixture({ team: true });
  const tag = internalServiceTagFor(CONTROL_KEY, "controller");
  const result = await runRebuild("echo-refused", setup, MAIN_TIP, {
    admissionStatus: 400, admissionBody: { error: `${CONTROL_KEY} ${BEARER_KEY} controller.${tag}` },
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("credential withheld");
  for (const secret of [CONTROL_KEY, BEARER_KEY, tag]) {
    expect(fs.readFileSync(setup.args, "utf8") + result.stdout + result.stderr).not.toContain(secret);
  }
});

test("JSON-escaped credential echoes are scrubbed before the shell parses receipts", async () => {
  const setup = fixture({ team: true });
  const tag = internalServiceTagFor(CONTROL_KEY, "controller");
  const encode = (text: string) => [...text].map(char => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0")).join("");
  setup.responses.rawAdmission = `{"error":"${encode(CONTROL_KEY)} ${encode(BEARER_KEY)} ${encode(tag)}"}`;
  const result = await runRebuild("escaped-echo", setup, MAIN_TIP, { admissionStatus: 400 });
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("credential withheld");
  for (const secret of [CONTROL_KEY, BEARER_KEY, tag]) {
    expect(fs.readFileSync(setup.args, "utf8") + result.stdout + result.stderr).not.toContain(secret);
  }
});

test("the deploy client validates every resolved address and pins the loopback destination", async () => {
  const { loopbackDeploymentUrl } = await import("./rebuild-http");
  const url = "http://localhost:12345/api/runtime/deployments";
  expect((await loopbackDeploymentUrl(url, async () => [{ address: "127.0.0.1", family: 4 }])).hostname).toBe("127.0.0.1");
  await expect(loopbackDeploymentUrl(url, async () => [{ address: "127.0.0.1", family: 4 }, { address: "198.51.100.1", family: 4 }])).rejects.toThrow("loopback");
  const embeddedUser = new URL("http://198.51.100.1/api/runtime/deployments");
  embeddedUser.username = "fixture-user";
  await expect(loopbackDeploymentUrl(embeddedUser.href)).rejects.toThrow("invalid");
  await expect(loopbackDeploymentUrl("http://198.51.100.1/api/runtime/deployments")).rejects.toThrow("loopback");
});

test("ambient HTTP proxy settings cannot receive host control credentials", async () => {
  const setup = fixture({ team: true });
  let proxyCalls = 0;
  const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { proxyCalls++; return new Response("unexpected proxy", { status: 502 }); } });
  servers.push(proxy);
  const result = await runRebuild("direct-loopback", setup, MAIN_TIP, {
    env: { HTTP_PROXY: `http://127.0.0.1:${proxy.port}`, http_proxy: `http://127.0.0.1:${proxy.port}`, NO_PROXY: "", no_proxy: "" },
  });
  expect(result.exitCode).toBe(0);
  expect(proxyCalls).toBe(0);
  expect(setup.responses.credentialed).toBe(2);
});
