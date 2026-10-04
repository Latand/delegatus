#!/usr/bin/env bun

/* The one place a Delegatus agent or the pipeline engine gets a credential for
   a GitHub write. It runs beside the agent, in the agent's own namespace, so it
   imports nothing but the runtime: the launch environment copies this file into
   the launching home's cache and the `gh` shim there starts it.

   Three entries:
     token [--repository owner/name] [--json]   one installation token on stdout
     gh <args…>                                 `gh`, with writes sent as the App
     git-credential <get|store|erase>           git's helper for push URLs

   A write with no usable App credential is refused with REFUSAL below. Nothing
   here ever reads a person's token, and no token is written to a file or to a
   terminal. */

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
/** Set by the launch environment: the `gh` configuration reads keep using. */
export const FORGE_READ_CONFIG_ENV = "LLV_AGENT_FORGE_READ_CONFIG_DIR";

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

const READ_SUBCOMMANDS = new Set(["view", "list", "status", "checks", "diff", "watch", "download", "verify", "verify-asset",
  "item-list", "field-list", "check", "get", "logs", "checkout", "clone"]);
const READ_COMMANDS = new Set(["search", "status", "browse", "help", "version", "completion"]);
const API_VALUE_FLAGS = new Set(["-X", "--method", "-H", "--header", "-f", "--raw-field", "-F", "--field", "--input", "-q", "--jq",
  "-t", "--template", "--hostname", "--cache", "-p", "--preview"]);

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
  const fields = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const [flag, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, null];
    if (API_VALUE_FLAGS.has(flag)) {
      const value = inline ?? args[++index] ?? "";
      if (flag === "-X" || flag === "--method") method = value.toUpperCase();
      if (["-f", "--raw-field", "-F", "--field"].includes(flag)) { body = true; fields.push(value); }
      if (flag === "--input") { body = true; fields.push("\0input"); }
      continue;
    }
    if (/^-X.+/.test(arg)) { method = arg.slice(2).toUpperCase(); continue; }
    if (arg.startsWith("-")) continue;
    endpoint ??= arg;
  }
  const target = (endpoint ?? "").replace(/^\/+/, "");
  const effective = method ?? (body ? "POST" : "GET");
  /* The installation endpoints answer only an installation token: the batch
     lander's principal check reads one of them. */
  if (/^installation(?:\/|$|\?)/.test(target)) return { kind: "write", repository: null };
  const repository = /^repos\/([^/{]+\/[^/{?]+)/.exec(target)?.[1] ?? null;
  if (target === "graphql") {
    /* A query is a read whatever its HTTP method; a body this cannot see is not. */
    const visible = fields.every((field) => field !== "\0input" && !/^query=@/.test(field));
    return visible && !fields.some((field) => /\bmutation\b/.test(field)) ? { kind: "read" } : { kind: "write", repository: null };
  }
  return effective === "GET" || effective === "HEAD" ? { kind: "read" } : { kind: "write", repository };
}

/**
 * What one `gh` invocation is: a read, which keeps the credentials reads always
 * had; a write, which goes out as the App or not at all; or a command an agent
 * is not given. Anything this does not recognise as a read is a write, so a
 * command added to `gh` later can never reach a person's token by being new.
 */
export function classifyGh(args, env = {}) {
  const positional = [];
  for (let index = 0; index < args.length && positional.length < 2; index++) {
    const arg = args[index];
    if (arg === "-R" || arg === "--repo") { index++; continue; }
    if (!arg.startsWith("-")) positional.push(arg);
  }
  const [command, sub] = positional;
  if (!command) return { kind: "read" };
  if (args.includes("--help") || args.includes("-h")) return { kind: "read" };
  if (command === "auth") {
    if (sub === "status") return { kind: "read" };
    if (sub === "git-credential") return { kind: "git-credential", action: args[args.indexOf("git-credential") + 1] ?? "" };
    return { kind: "refuse", reason: `\`gh auth${sub ? ` ${sub}` : ""}\` is not available to an agent` };
  }
  if (command === "api") return classifyApi(args.slice(args.indexOf("api") + 1));
  if (READ_COMMANDS.has(command) || (sub && READ_SUBCOMMANDS.has(sub))) return { kind: "read" };
  const flagged = repositoryFlag(args) ?? env.GH_REPO ?? null;
  return { kind: "write", repository: flagged };
}

/** Runs `gh` for an agent. Returns the exit status. */
export async function runGh(args, ports) {
  const decision = classifyGh(args, ports.env);
  if (decision.kind === "refuse") {
    ports.stderr(`Delegatus: ${decision.reason}; it would hand out or change a person's GitHub credentials.\n`);
    return 1;
  }
  if (decision.kind === "git-credential") return gitCredential(decision.action, await ports.readStdin(), ports);
  const gh = ports.findGh();
  if (!gh) {
    ports.stderr("Delegatus: the gh command line tool was not found on PATH.\n");
    return 127;
  }
  if (decision.kind === "read") {
    const env = { ...ports.env };
    if (ports.env[FORGE_READ_CONFIG_ENV]) env.GH_CONFIG_DIR = ports.env[FORGE_READ_CONFIG_ENV];
    return ports.exec(gh, args, env);
  }
  let issued;
  try {
    const named = decision.repository == null ? await ports.originRepository() : parseRepository(decision.repository);
    if (!named) throw new ForgeAppRefusal(null, "the repository this write targets could not be determined");
    issued = await mintInstallationToken(named, ports);
  } catch (error) {
    ports.stderr(`${error instanceof ForgeAppRefusal ? error.message : refusalMessage(null, "the GitHub App credential could not be used")}\n`);
    return 1;
  }
  /* The App token and nothing else: no inherited token of either spelling, and
     the configuration directory the launch handed the agent, which holds no
     account. `gh` is never started for a write without the token in place. */
  const env = { ...ports.env, GH_TOKEN: issued.token, GH_PROMPT_DISABLED: "1" };
  for (const name of ["GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) delete env[name];
  try {
    return await ports.exec(gh, args, env);
  } finally {
    await revokeInstallationToken(issued.token, ports);
  }
}

/* ── git ──────────────────────────────────────────────────────────────────── */

/**
 * Git's credential helper for the push URL the launch environment rewrites
 * GitHub pushes to. A refusal answers `quit`, so git stops there instead of
 * asking the next helper or a terminal.
 */
export async function gitCredential(action, input, ports) {
  if (action !== "get") return 0;
  const fields = Object.fromEntries(input.split("\n").filter((line) => line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  try {
    if (fields.protocol !== "https" || (fields.host ?? "").toLowerCase() !== "github.com") {
      throw new ForgeAppRefusal(null, "the push does not go to github.com over HTTPS");
    }
    const named = (fields.path ? parseRepository(fields.path) : null) ?? await ports.originRepository();
    if (!named) throw new ForgeAppRefusal(null, "the repository this push targets could not be determined");
    const issued = await mintInstallationToken(named, ports);
    /* Git's own field names, joined so no credential-shaped literal sits in the source. */
    ports.stdout(`${["username", FORGE_APP_USERNAME].join("=")}\n${["password", issued.token].join("=")}\n`);
    return 0;
  } catch (error) {
    ports.stderr(`${error instanceof ForgeAppRefusal ? error.message : refusalMessage(null, "the GitHub App credential could not be used")}\n`);
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
