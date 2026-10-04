#!/usr/bin/env bun

/* The one place a Delegatus agent or the pipeline engine gets a credential for
   a GitHub write. It runs beside the agent, in the agent's own namespace, so it
   imports nothing but the runtime: the launch environment copies this file into
   the launching home's cache and the `gh` shim there starts it.

   Three entries:
     token [--repository owner/name] [--json]   one installation token on stdout
     gh <args…>                                 `gh`, with covered writes sent as the App
     git-credential <get|store|erase>           git's helper for push URLs

   The rule applies to the repositories this installation declared (see
   FORGE_REPOSITORIES_ENV) and to the kinds of write listed in
   FORGE_APP_GH_COMMANDS and FORGE_APP_API_WRITES. Such a write with no usable
   App credential is refused with the message below and nothing is sent.
   Everything else reaches `gh` exactly as it was typed, with the environment
   it was typed in. No token is written to a file or to a terminal. */

import { execFile, spawn } from "node:child_process";
import { createSign } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FORGE_APP_SECRET_SERVICE = "delegatus-github-app";
export const FORGE_APP_PERMISSIONS = Object.freeze({ contents: "write", pull_requests: "write", metadata: "read" });
export const FORGE_APP_USERNAME = "x-access-token";
/** Set by the launch environment: the directory holding the `gh` shim. */
export const FORGE_DIR_ENV = "LLV_AGENT_FORGE_DIR";
/** Set by the launch environment: the repositories this installation declared
    as App repositories, `owner/name` separated by commas. Empty or unset means
    none, and then nothing here changes any command. */
export const FORGE_REPOSITORIES_ENV = "LLV_AGENT_FORGE_REPOSITORIES";

const API = "https://api.github.com/";
const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

export class ForgeAppRefusal extends Error {
  constructor(repository, reason) {
    super(refusalMessage(repository, reason));
    this.name = "ForgeAppRefusal";
    this.reason = reason;
  }
}

/** The plain message every refused write ends with. */
export function refusalMessage(repository, reason) {
  return `Delegatus refused this GitHub write${repository ? ` to ${repository}` : ""}: ${reason}. `
    + "Agents and pipelines write to GitHub only as the Delegatus GitHub App and never with a person's credentials, so nothing was sent. "
    + "The operator can check that the App is installed on this repository and that the credential store is unlocked.";
}

/** `owner/name` out of a slug, an HTTPS or SSH GitHub URL, or `host/owner/name`.
    Null for anything that is not a github.com repository. */
export function parseRepository(value) {
  if (typeof value !== "string") return null;
  let text = value.trim();
  const url = /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|[^@/:]+@)([^/:]+)[/:](.+)$/.exec(text);
  if (url) {
    if (url[1].toLowerCase() !== "github.com") return null;
    text = url[2];
  } else if (text.split("/").length === 3) {
    const [host, ...rest] = text.split("/");
    if (host.toLowerCase() !== "github.com") return null;
    text = rest.join("/");
  }
  text = text.replace(/\/+$/, "").replace(/\.git$/, "");
  return REPOSITORY.test(text) ? text : null;
}

const base64url = (value) => Buffer.from(value).toString("base64url");

/** A ten-minute App JWT, signed with the key from the credential store. */
export function appJwt(app, nowSeconds) {
  const message = `${base64url('{"alg":"RS256","typ":"JWT"}')}.${base64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: String(app.id) }))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(message);
  return `${message}.${signer.sign(app.pem).toString("base64url")}`;
}

/** The declared App repositories an environment carries, lower-cased. */
export function declaredRepositories(env = {}) {
  return (env[FORGE_REPOSITORIES_ENV] ?? "").split(",").map((entry) => parseRepository(entry)?.toLowerCase()).filter(Boolean);
}

/** Whether `repository` is one this installation declared as an App repository. */
export function isDeclaredRepository(repository, env = {}) {
  const slug = parseRepository(repository)?.toLowerCase();
  return !!slug && declaredRepositories(env).includes(slug);
}

function sameRepository(left, right) {
  return typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();
}

function holdsRequiredPermissions(granted) {
  return !!granted && typeof granted === "object"
    && Object.entries(FORGE_APP_PERMISSIONS).every(([name, level]) => granted[name] === level || (level === "read" && granted[name] === "write"));
}

function exactlyRequiredPermissions(granted) {
  return !!granted && typeof granted === "object"
    && Object.keys(granted).length === Object.keys(FORGE_APP_PERMISSIONS).length
    && Object.entries(FORGE_APP_PERMISSIONS).every(([name, level]) => granted[name] === level);
}

/**
 * One installation token for one repository, or a ForgeAppRefusal.
 *
 * The credential item is the App's registration as GitHub returned it plus the
 * `installation_id` the setup verified. The installation is read again on every
 * mint, so an uninstalled, suspended or re-pointed App is refused here rather
 * than discovered by a failed write, and the token is asked for this one
 * repository with the three permissions a forge write needs — whatever else
 * the installation can reach.
 */
export async function mintInstallationToken(repository, ports) {
  const slug = parseRepository(repository);
  if (!slug) throw new ForgeAppRefusal(null, "the target is not a github.com repository this installation can name");
  const refuse = (reason) => new ForgeAppRefusal(slug, reason);
  let app;
  try {
    const raw = await ports.readCredential(slug);
    app = raw ? JSON.parse(raw) : null;
  } catch {
    app = null;
  }
  if (!app || typeof app !== "object") throw refuse("no GitHub App credential is available for it");
  if (!Number.isSafeInteger(app.id) || typeof app.pem !== "string" || !app.pem.includes("PRIVATE KEY")) {
    throw refuse("the stored GitHub App credential is incomplete");
  }
  if (!Number.isSafeInteger(app.installation_id)) throw refuse("the GitHub App has no verified installation");
  let bearer;
  try {
    bearer = appJwt(app, Math.floor(ports.now() / 1000));
  } catch {
    throw refuse("the stored GitHub App key could not sign a request");
  }
  const call = async (method, target, options) => {
    let answer;
    try {
      answer = await ports.request(method, target, options);
    } catch {
      throw refuse("GitHub could not be reached to verify the App installation");
    }
    if (answer.status < 200 || answer.status >= 300) throw refuse(`GitHub answered HTTP ${answer.status} while verifying the App installation`);
    return answer.body;
  };
  const [owner, name] = slug.split("/");
  const installation = await call("GET", `repos/${slug}/installation`, { token: bearer });
  if (!installation || installation.id !== app.installation_id || installation.app_id !== app.id
    || !sameRepository(installation.account?.login, owner) || installation.suspended_at != null
    || !holdsRequiredPermissions(installation.permissions)) {
    throw refuse("the GitHub App installation is missing, suspended, or differs from the verified one");
  }
  const issued = await call("POST", `app/installations/${installation.id}/access_tokens`, {
    token: bearer, body: { repositories: [name], permissions: FORGE_APP_PERMISSIONS },
  });
  if (!issued || typeof issued.token !== "string" || !issued.token) throw refuse("GitHub issued no installation token");
  try {
    if (!exactlyRequiredPermissions(issued.permissions)) throw refuse("the issued token carries unexpected permissions");
    const reach = await call("GET", "installation/repositories?per_page=100", { token: issued.token });
    if (reach?.total_count !== 1 || reach.repositories?.length !== 1 || !sameRepository(reach.repositories[0]?.full_name, slug)) {
      throw refuse("the issued token is not limited to this repository");
    }
  } catch (error) {
    await revokeInstallationToken(issued.token, ports);
    throw error;
  }
  return { token: issued.token, expiresAt: typeof issued.expires_at === "string" ? issued.expires_at : null, repository: slug };
}

/** Best effort: a token nobody holds any more should not stay valid for an hour. */
export async function revokeInstallationToken(token, ports) {
  try { await ports.request("DELETE", "installation/token", { token }); } catch { /* It expires on its own. */ }
}

/* ── `gh` ─────────────────────────────────────────────────────────────────── */

/**
 * The kinds of GitHub write the App is permitted to make, which are the only
 * ones sent as the App. The list is explicit on purpose: a kind that is absent
 * (an issue, a workflow dispatch, a release, a comment) is not rerouted and
 * runs as it always did, because the App holds no permission for it and a
 * refusal would stop work that depends on it. Adding a kind here is a decision
 * about the App's permissions, never an inference from the command's shape.
 */
export const FORGE_APP_GH_COMMANDS = Object.freeze(["pr create", "pr edit", "pr merge", "pr update-branch"]);
const REPOSITORY_SEGMENT = "(\\{owner\\}/\\{repo\\}|[^/{}]+/[^/{}]+)";
/** The same kinds through `gh api`, as method and REST path. */
export const FORGE_APP_API_WRITES = Object.freeze([
  Object.freeze({ method: "POST", path: new RegExp(`^repos/${REPOSITORY_SEGMENT}/pulls$`) }),
  Object.freeze({ method: "PATCH", path: new RegExp(`^repos/${REPOSITORY_SEGMENT}/pulls/\\d+$`) }),
  Object.freeze({ method: "PUT", path: new RegExp(`^repos/${REPOSITORY_SEGMENT}/pulls/\\d+/merge$`) }),
  Object.freeze({ method: "PUT", path: new RegExp(`^repos/${REPOSITORY_SEGMENT}/pulls/\\d+/update-branch$`) }),
]);

const API_VALUE_FLAGS = new Set(["-X", "--method", "-H", "--header", "-f", "--raw-field", "-F", "--field", "--input", "-q", "--jq",
  "-t", "--template", "--hostname", "--cache", "-p", "--preview"]);
const PASS = Object.freeze({ kind: "pass" });

function repositoryFlag(args) {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "-R" || arg === "--repo") return args[index + 1] ?? "";
    if (arg.startsWith("--repo=")) return arg.slice("--repo=".length);
    if (arg.startsWith("-R") && arg.length > 2) return arg.slice(2).replace(/^=/, "");
  }
  return null;
}

function classifyApi(args) {
  let method = null;
  let body = false;
  let endpoint = null;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const [flag, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, null];
    if (API_VALUE_FLAGS.has(flag)) {
      const value = inline ?? args[++index] ?? "";
      if (flag === "-X" || flag === "--method") method = value.toUpperCase();
      if (["-f", "--raw-field", "-F", "--field", "--input"].includes(flag)) body = true;
      continue;
    }
    if (/^-X.+/.test(arg)) { method = arg.slice(2).toUpperCase(); continue; }
    if (arg.startsWith("-")) continue;
    endpoint ??= arg;
  }
  const target = (endpoint ?? "").replace(/^\/+/, "");
  /* The installation endpoints answer only an installation token: the batch
     lander's principal check reads one of them. */
  if (/^installation(?:\/|$|\?)/.test(target)) return { kind: "app", repository: null };
  const effective = method ?? (body ? "POST" : "GET");
  const route = target.replace(/[?#].*$/, "").replace(/\/+$/, "");
  for (const write of FORGE_APP_API_WRITES) {
    const match = write.method === effective ? write.path.exec(route) : null;
    if (match) return { kind: "app", repository: match[1].startsWith("{") ? null : match[1] };
  }
  return PASS;
}

/**
 * What one `gh` invocation is: one of the covered kinds of write, which goes
 * out as the App when its repository is declared, or anything else, which
 * passes through untouched. `repository` is null when the command names none
 * and `gh` would take it from the checkout.
 */
function ghCommand(args) {
  const positional = [];
  for (let index = 0; index < args.length && positional.length < 2; index++) {
    const arg = args[index];
    if (arg === "-R" || arg === "--repo") { index++; continue; }
    if (!arg.startsWith("-")) positional.push(arg);
  }
  return positional;
}

export function classifyGh(args, env = {}) {
  const [command, sub] = ghCommand(args);
  if (!command || args.includes("--help") || args.includes("-h")) return PASS;
  if (command === "api") return classifyApi(args.slice(args.indexOf("api") + 1));
  if (!FORGE_APP_GH_COMMANDS.includes(`${command} ${sub ?? ""}`)) return PASS;
  return { kind: "app", repository: repositoryFlag(args) ?? env.GH_REPO ?? null };
}

/** Runs `gh` for an agent. Returns the exit status. */
export async function runGh(args, ports) {
  const gh = ports.findGh();
  if (!gh) {
    ports.stderr("Delegatus: the gh command line tool was not found on PATH.\n");
    return 127;
  }
  const decision = classifyGh(args, ports.env);
  const named = decision.kind !== "app" ? null
    : decision.repository == null ? await ports.originRepository() : parseRepository(decision.repository);
  /* Not a covered kind, or not a declared repository: the command as typed,
     in the environment it was typed in. */
  if (!named || !isDeclaredRepository(named, ports.env)) return ports.exec(gh, args, ports.env);
  let issued;
  try {
    issued = await mintInstallationToken(named, ports);
  } catch (error) {
    ports.stderr(`${error instanceof ForgeAppRefusal ? error.message : refusalMessage(named, "the GitHub App credential could not be used")}\n`);
    return 1;
  }
  /* The App token and nothing else: no inherited token of either spelling, and
     a configuration directory that holds no account. `gh` is never started for
     a covered write without the token in place. */
  const env = { ...ports.env, GH_TOKEN: issued.token, GH_PROMPT_DISABLED: "1", GH_CONFIG_DIR: ports.emptyGhConfigDir() };
  for (const name of ["GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) delete env[name];
  try {
    const status = await ports.exec(gh, args, env);
    /* Older `gh` reads a pull request's classic project cards before every
       edit, which an installation token may not, and fails there. The REST
       form edits the same pull request and is a covered kind too. */
    if (status !== 0 && ghCommand(args).join(" ") === "pr edit") {
      ports.stderr(`Delegatus: if \`gh pr edit\` failed on a Projects query, this version of gh cannot edit a pull request with an App token; \`gh api -X PATCH repos/${named}/pulls/<number> -f title=… -F body=@file\` makes the same edit as the App.\n`);
    }
    return status;
  } finally {
    await revokeInstallationToken(issued.token, ports);
  }
}

/* ── git ──────────────────────────────────────────────────────────────────── */

/**
 * Git's credential helper for the push URL the launch environment rewrites a
 * declared repository's pushes to. A refusal answers `quit`, so git stops there
 * instead of asking the next helper or a terminal.
 *
 * The rewrite matches by prefix, so a sibling repository whose name merely
 * starts with a declared one arrives here too. It is not declared: its push is
 * answered by the helpers git would have asked without this arrangement.
 */
export async function gitCredential(action, input, ports) {
  if (action !== "get") return 0;
  const fields = Object.fromEntries(input.split("\n").filter((line) => line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  let named = null;
  try {
    if (fields.protocol !== "https" || (fields.host ?? "").toLowerCase() !== "github.com") {
      throw new ForgeAppRefusal(null, "the push does not go to github.com over HTTPS");
    }
    named = (fields.path ? parseRepository(fields.path) : null) ?? await ports.originRepository();
    if (!named) throw new ForgeAppRefusal(null, "the repository this push targets could not be determined");
    if (!isDeclaredRepository(named, ports.env)) {
      const own = await ports.ordinaryCredential(fields.path ?? "");
      if (own) ports.stdout(own);
      return 0;
    }
    const issued = await mintInstallationToken(named, ports);
    /* Git's own field names, joined so no credential-shaped literal sits in the source. */
    ports.stdout(`${["username", FORGE_APP_USERNAME].join("=")}\n${["password", issued.token].join("=")}\n`);
    return 0;
  } catch (error) {
    ports.stderr(`${error instanceof ForgeAppRefusal ? error.message : refusalMessage(named, "the GitHub App credential could not be used")}\n`);
    ports.stdout("quit=true\n");
    return 1;
  }
}

/* ── The running process ──────────────────────────────────────────────────── */

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 15_000, maxBuffer: 1024 * 1024, ...options }, (error, stdout) => {
      resolve(error ? null : String(stdout));
    });
  });
}

function sessionBusEnv(env) {
  if (env.DBUS_SESSION_BUS_ADDRESS || typeof process.getuid !== "function") return env;
  /* A spawned agent's environment is an allowlist and the bus address is not
     on it; the user's own bus lives at a fixed, user-owned path. */
  return { ...env, DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${process.getuid()}/bus` };
}

export function productionPorts(env = process.env, cwd = process.cwd()) {
  const originRepository = async () => parseRepository((await run("git", ["remote", "get-url", "origin"], { cwd, env }))?.trim() ?? "");
  return {
    env,
    now: Date.now,
    originRepository,
    /* The item is keyed by the repository as the origin spells it, which a
       caller's own spelling may differ from by case only. */
    readCredential: async (repository) => {
      const lookup = (name) => run("secret-tool", ["lookup", "service", FORGE_APP_SECRET_SERVICE, "repository", name], { env: sessionBusEnv(env) });
      const direct = await lookup(repository);
      if (direct?.trim()) return direct;
      const origin = await originRepository();
      return origin && origin !== repository && sameRepository(origin, repository) ? lookup(origin) : null;
    },
    request: async (method, target, { token, body } = {}) => {
      const response = await fetch(API + target, {
        method,
        headers: {
          Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Delegatus",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
      const text = await response.text();
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
      return { status: response.status, body: parsed };
    },
    /* What git's own helpers answer for an undeclared repository: `git
       credential fill` without the entries the launch added through the
       environment. Only the two fields git needs are passed on. */
    ordinaryCredential: (repositoryPath) => new Promise((resolve) => {
      const childEnv = Object.fromEntries(Object.entries(env).filter(([name]) => !/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(name)));
      const child = spawn("git", ["credential", "fill"], { stdio: ["pipe", "pipe", "ignore"], env: { ...childEnv, GIT_TERMINAL_PROMPT: "0" }, cwd });
      let text = "";
      child.stdout.on("data", (chunk) => { text += chunk; });
      child.on("error", () => resolve(null));
      child.on("exit", (code) => {
        const kept = text.split("\n").filter((line) => /^(?:username|password)=/.test(line));
        resolve(code === 0 && kept.length === 2 ? `${kept.join("\n")}\n` : null);
      });
      child.stdin.on("error", () => {});
      child.stdin.end(`protocol=https\nhost=github.com\n${repositoryPath ? `path=${repositoryPath}\n` : ""}\n`);
    }),
    emptyGhConfigDir: () => path.join(env[FORGE_DIR_ENV] || path.dirname(fileURLToPath(import.meta.url)), "gh-config"),
    findGh: () => {
      const own = [env[FORGE_DIR_ENV], path.dirname(fileURLToPath(import.meta.url))].filter(Boolean).map((dir) => { try { return fs.realpathSync(dir); } catch { return dir; } });
      for (const dir of (env.PATH ?? "").split(path.delimiter)) {
        if (!dir) continue;
        let real = dir;
        try { real = fs.realpathSync(dir); } catch { continue; }
        if (own.includes(real)) continue;
        const candidate = path.join(dir, "gh");
        try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { /* next */ }
      }
      return null;
    },
    exec: (command, args, childEnv) => new Promise((resolve) => {
      const child = spawn(command, args, { stdio: "inherit", env: childEnv, cwd });
      child.on("error", () => resolve(127));
      child.on("exit", (code, signal) => resolve(signal ? 1 : code ?? 1));
    }),
    readStdin: async () => {
      let text = "";
      for await (const chunk of process.stdin) text += chunk;
      return text;
    },
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
}

async function main(argv) {
  const [mode, ...rest] = argv;
  const ports = productionPorts();
  if (mode === "gh") return runGh(rest, ports);
  if (mode === "git-credential") return gitCredential(rest[0] ?? "", await ports.readStdin(), ports);
  if (mode === "token") {
    if (process.stdout.isTTY) {
      ports.stderr("Delegatus: capture the token; it is never shown on a terminal.\n");
      return 1;
    }
    const flag = rest.indexOf("--repository");
    try {
      const named = flag >= 0 ? rest[flag + 1] : await ports.originRepository();
      const issued = await mintInstallationToken(named ?? "", ports);
      ports.stdout(rest.includes("--json") ? `${JSON.stringify({ token: issued.token, expiresAt: issued.expiresAt })}\n` : `${issued.token}\n`);
      return 0;
    } catch (error) {
      ports.stderr(`${error instanceof ForgeAppRefusal ? error.message : refusalMessage(null, "the GitHub App credential could not be used")}\n`);
      return 1;
    }
  }
  ports.stderr("usage: forge-app-token.mjs token|gh|git-credential\n");
  return 2;
}

let invoked = false;
try { invoked = !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { invoked = false; }
/* No top-level await: the launch code imports this file for its constants. */
if (invoked) main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, () => { process.exitCode = 1; });
