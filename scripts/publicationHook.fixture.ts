import { expect } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHookFixture } from "./local-gate.fixture";

/** Each owned test file gets its own fixture roots and cleanup lifecycle. */
export function createPublicationFixtures(root: string, roots: string[]) {
function fixture() {
  const parent = fs.mkdtempSync(path.join(tmpdir(), "publication-http-")); roots.push(parent);
  const f = createHookFixture(root, roots, false, false, path.join(parent, "source-pipeline-p0000001"));
  f.git("branch", "-m", "pipeline/task-1-p0000001");
  // Hook-fixture helpers are tracked before the changed source is committed.
  f.git("config", "core.hooksPath", "/dev/null");
  fs.writeFileSync(path.join(f.dir, "example.ts"), "export const value = 2;\n");
  f.git("add", "example.ts"); f.git("commit", "-m", "checked work");
  f.git("config", "core.hooksPath", ".githooks");
  const head = f.git("rev-parse", "HEAD").toString().trim();
  const receipt = path.join(f.dir, ".git", "publication.json");
  const env: NodeJS.ProcessEnv = { ...f.env, LLV_GATE_PUBLICATION_RECEIPT: receipt, LLV_GATE_PUBLICATION_ID: "operation-one",
    LLV_GATE_PUBLICATION_EPOCH: "1", LLV_GATE_PUBLICATION_FENCE: "custody-one", LLV_GATE_PUSH_HEAD: head,
    LLV_GATE_PUBLICATION_REF: "refs/heads/main", LLV_GATE_PUBLICATION_REMOTE_HEAD: "0".repeat(40) };
  const run = (prepare: boolean, extra: Partial<NodeJS.ProcessEnv> = {}) => spawnSync(prepare ? "bun" : "bash", prepare
    ? ["scripts/local-gate.ts", "pre-push", "--publication-prepare"] : [".githooks/pre-push"], {
    cwd: f.dir, env: { ...env, ...(!prepare ? { PATH: `${f.git("--exec-path").toString().trim()}${path.delimiter}${env.PATH}` } : {}), ...extra }, encoding: "utf8", timeout: 45_000,
    input: prepare ? undefined : `HEAD ${env.LLV_GATE_PUSH_HEAD} refs/heads/main ${"0".repeat(40)}\n`,
  });
  return { ...f, head, receipt, env, run };
}

function nativeFixture(coldBun = false) {
  const f = fixture();
  const write = (file: string, source: string) => {
    const target = path.join(f.dir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
  };
  const smoke = 'import { test, expect } from "bun:test"; test("runtime fixture", () => expect(1).toBe(1));\n';
  write("scripts/runtime-smoke.test.ts", smoke);
  write("src/lib/mcp/answerSizes.test.ts", smoke);
  for (const name of ["audit-with-retry", "supply-chain-check"]) write(`scripts/${name}.test.ts`, smoke);
  for (const name of ["verify-viewer-runtime", "verify-runtime-host", "verify-bun-runtime-controls", "verify-native-codex-runtime"]) {
    write(`scripts/${name}.ts`, 'import fs from "node:fs"; fs.appendFileSync(process.env.HOOK_LOG!, JSON.stringify({ args: process.argv.slice(1), names: [] }) + "\\n");\n');
  }
  const bun = coldBun ? "0.0.2" : Bun.version;
  write("Dockerfile", `RUN npm install -g bun@${bun}\n`);
  write("package.json", JSON.stringify({ scripts: { build: "true" } }));
  write(".github/workflows/bun-runtime.yml", `jobs:
  bun-runtime:
    steps:
      - run: bun test ./scripts/runtime-smoke.test.ts
  native-codex-runtime:
    strategy:
      matrix:
        codex: ["0.0.1"]
`);
  f.env.XDG_CACHE_HOME = path.join(f.dir, ".git", "cold-cache");
  const target = `node_modules/@openai/codex-linux-${process.arch}/vendor/${process.arch === "x64" ? "x86_64" : "aarch64"}-unknown-linux-musl/bin/codex`;
  const codex = path.join(f.env.XDG_CACHE_HOME, "delegatus-gate/codex-0.0.1", target);
  const installer = path.join(f.dir, ".git", "install-native.ts");
  fs.writeFileSync(installer, `import fs from "node:fs"; import path from "node:path";
    if (process.env.HOOK_FAIL === "native-install") process.exit(1);
    const args = process.argv.slice(2), prefix = args[args.indexOf("--prefix") + 1]!;
    const bun = args.at(-1)!.startsWith("bun@");
    const binary = path.join(prefix, bun ? "node_modules/.bin/bun" : ${JSON.stringify(target)});
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, bun ? ${JSON.stringify(`#!/bin/sh\nif [ "$1" = --version ]; then\n  "${process.execPath}" -e 'if (Object.keys(process.env).some(name => name.startsWith("LLV_GATE_PUBLICATION_"))) process.exit(23)' || exit 23\n  echo ${bun}; exit 0\nfi\nexec "${process.execPath}" "$@"\n`)} : "#!/bin/sh\\nexit 0\\n", { mode: 0o755 });
    fs.appendFileSync(process.env.HOOK_LOG!, JSON.stringify({ args: ["native-install", bun ? "bun" : "codex"], names: [] }) + "\\n");`);
  write("shims/npm", `#!/bin/sh\nexec "${process.execPath}" "${installer}" "$@"\n`);
  fs.chmodSync(path.join(f.dir, "shims/npm"), 0o755);
  f.git("-c", "core.hooksPath=/dev/null", "add", ".");
  f.git("-c", "core.hooksPath=/dev/null", "commit", "-m", "selected native tools fixture");
  f.head = f.git("rev-parse", "HEAD").toString().trim(); f.env.LLV_GATE_PUSH_HEAD = f.head;
  return { ...f, codex, calls: () => fs.existsSync(f.env.HOOK_LOG!) ? f.calls() : [] };
}

const touchedChecks = (f: ReturnType<typeof nativeFixture>) => f.calls().filter(call =>
  call.args[0] === "scripts/local-gate-tests.ts" && call.args.includes("./example.test.ts"));

function commitFixtureInputs(f: ReturnType<typeof fixture>) {
  f.git("-c", "core.hooksPath=/dev/null", "add", ".");
  f.git("-c", "core.hooksPath=/dev/null", "commit", "-m", "publication input fixture");
  f.head = f.git("rev-parse", "HEAD").toString().trim();
  f.env.LLV_GATE_PUSH_HEAD = f.head;
}

/** Real smart HTTP Git, driven by a logical credential clock. Advancing that
 * clock in an expensive check reproduces an hour's admission without a sleep.
 * No credential value is stored or included in the evidence events. */
async function httpFixture(f: ReturnType<typeof fixture>, expireDuringChecks = true) {
  const bare = path.join(f.dir, ".git", "remote.git");
  f.git("init", "--bare", bare);
  const events = path.join(f.dir, ".git", "events.jsonl"), clock = path.join(f.dir, ".git", "clock");
  fs.writeFileSync(clock, "0"); fs.writeFileSync(events, "");
  const record = path.join(f.dir, "record.ts");
  fs.appendFileSync(record, `\nif (process.argv[2] === "tsc") { appendFileSync(process.env.CREDENTIAL_EVENTS!, JSON.stringify({kind:"checks",at:0}) + "\\n"); require("node:fs").writeFileSync(process.env.CREDENTIAL_CLOCK!, ${JSON.stringify(expireDuringChecks ? "7200000" : "0")}); }\n`);
  const helper = path.join(f.dir, "credential.ts");
  fs.writeFileSync(helper, `import fs from "node:fs"; if (process.argv[2] === "get") { const at = Number(fs.readFileSync(process.env.CREDENTIAL_CLOCK!, "utf8")); fs.appendFileSync(process.env.CREDENTIAL_EVENTS!, JSON.stringify({ kind: "mint", at }) + "\\n"); process.stdout.write("username=fixture\\n" + ["password", "fixture-" + at].join("=") + "\\n\\n"); }`);
  f.git("config", "core.hooksPath", "/dev/null"); f.git("add", "record.ts", "credential.ts"); f.git("commit", "-m", "HTTP fixture");
  f.git("config", "core.hooksPath", ".githooks");
  f.head = f.git("rev-parse", "HEAD").toString().trim(); f.env.LLV_GATE_PUSH_HEAD = f.head;
  Object.assign(f.env, { CREDENTIAL_CLOCK: clock, CREDENTIAL_EVENTS: events,
    LLV_GATE_CHECK_ENV: f.env.LLV_GATE_CHECK_ENV + ",CREDENTIAL_CLOCK,CREDENTIAL_EVENTS" });
  f.git("config", "http.receivepack", "true");
  const bareConfig = spawnSync("git", ["--git-dir", bare, "config", "http.receivepack", "true"], { env: f.env });
  expect(bareConfig.status).toBe(0);
  f.git("config", "credential.helper", `!${process.execPath} ${helper}`);
  let rpc = 0, rejected = 0, refuseRpc = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    const at = Number(fs.readFileSync(clock, "utf8"));
    const writing = url.searchParams.get("service") === "git-receive-pack" || url.pathname.endsWith("/git-receive-pack");
    if (writing) {
      const auth = request.headers.get("authorization");
      if (!auth) return new Response("authenticate", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="fixture"' } });
      const value = Buffer.from(auth.slice(6), "base64").toString();
      const mintedAt = Number(value.slice(value.lastIndexOf("-") + 1));
      if (!value.startsWith("fixture:fixture-") || at - mintedAt >= 3_600_000) {
        rejected++; return new Response("expired", { status: 401 });
      }
    }
    if (writing && request.method === "POST" && refuseRpc) { rejected++; return new Response("refused", { status: 401 }); }
    if (writing && request.method === "POST") {
      rpc++; fs.appendFileSync(events, JSON.stringify({ kind: "rpc", at }) + "\n");
    }
    const child = Bun.spawn(["git", "http-backend"], { env: { ...f.env, GIT_PROJECT_ROOT: path.dirname(bare), GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: request.method,
      CONTENT_TYPE: request.headers.get("content-type") ?? "", REMOTE_USER: "fixture", SERVER_PROTOCOL: "HTTP/1.1" },
      stdin: request.method === "POST" ? new Uint8Array(await request.arrayBuffer()) : undefined, stdout: "pipe", stderr: "pipe" });
    const [bytes, stderr, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(stderr);
    const output = Buffer.from(bytes), split = output.indexOf("\r\n\r\n");
    const headers = new Headers(); let status = 200;
    for (const line of output.subarray(0, split).toString().split("\r\n")) {
      const colon = line.indexOf(":");
      if (line.slice(0, colon).toLowerCase() === "status") status = Number(line.slice(colon + 1).trim().split(" ")[0]);
      else headers.set(line.slice(0, colon), line.slice(colon + 1).trim());
    }
    return new Response(output.subarray(split + 4), { status, headers });
  } });
  const remote = `http://127.0.0.1:${server.port}/remote.git`;
  f.git("remote", "add", "origin", remote);
  return { remote, bare, events: () => fs.readFileSync(events, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as {kind:string;at:number}),
    rpc: () => rpc, rejected: () => rejected, refuseRpc: () => { refuseRpc = true; }, close: () => server.stop(true) };
}

return { fixture, nativeFixture, touchedChecks, commitFixtureInputs, httpFixture };
}
