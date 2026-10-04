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
   App credential, or whose repository is named in a form that cannot be read,
   is refused with the message below and nothing is sent.
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
/** This file's name, in `bin/` and in every copy the launch environment makes. */
export const HELPER_FILE = "forge-app-token.mjs";
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
/** The other names `gh` itself gives a covered command. */
const GH_COMMAND_ALIASES = Object.freeze({ "pr new": "pr create" });
/* `gh api` fills either spelling of a placeholder from the base repository. */
const REPOSITORY_SEGMENT = "(\\{owner\\}|:owner|[^/{}:]+)/(\\{repo\\}|:repo|[^/{}:]+)";
/** The same kinds through `gh api`, as method and REST path. */
export const FORGE_APP_API_WRITES = Object.freeze([
  Object.freeze({ method: "POST", path: new RegExp(`^repos/${REPOSITORY_SEGMENT}/pulls$`, "i") }),
  Object.freeze({ method: "PATCH", path: new RegExp(`^repos/${REPOSITORY_SEGMENT}/pulls/\\d+$`, "i") }),
  Object.freeze({ method: "PUT", path: new RegExp(`^repos/${REPOSITORY_SEGMENT}/pulls/\\d+/merge$`, "i") }),
  Object.freeze({ method: "PUT", path: new RegExp(`^repos/${REPOSITORY_SEGMENT}/pulls/\\d+/update-branch$`, "i") }),
]);

/* The flags that take a value, by command, so a flag's value is never read as
   the command, the pull request or the endpoint. Every other flag is a switch. */
const REPOSITORY_FLAGS = ["-R", "--repo"];
const VALUE_FLAGS = Object.freeze({
  "": new Set(REPOSITORY_FLAGS),
  api: new Set(["-X", "--method", "-H", "--header", "-f", "--raw-field", "-F", "--field", "--input", "-q", "--jq",
    "-t", "--template", "--hostname", "--cache", "-p", "--preview"]),
  "pr create": new Set([...REPOSITORY_FLAGS, "-a", "--assignee", "-B", "--base", "-b", "--body", "-F", "--body-file", "-H", "--head",
    "-l", "--label", "-m", "--milestone", "-p", "--project", "--recover", "-r", "--reviewer", "-T", "--template", "-t", "--title"]),
  "pr edit": new Set([...REPOSITORY_FLAGS, "--add-assignee", "--add-label", "--add-project", "--add-reviewer", "-B", "--base", "-b", "--body",
    "-F", "--body-file", "-m", "--milestone", "--remove-assignee", "--remove-label", "--remove-project", "--remove-reviewer", "-t", "--title"]),
  "pr merge": new Set([...REPOSITORY_FLAGS, "-A", "--author-email", "-b", "--body", "-F", "--body-file", "--match-head-commit", "-t", "--subject"]),
  "pr update-branch": new Set(REPOSITORY_FLAGS),
});
const API_BODY_FLAGS = ["-f", "--raw-field", "-F", "--field", "--input"];
const PULL_REQUEST_URL = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/\d+(?:[/?#].*)?$/i;
const PASS = Object.freeze({ kind: "pass" });
const refuse = (reason) => ({ kind: "refuse", reason });

/** One command line read the way `gh` reads it: `--name=value`, `--name value`,
    `-n value`, `-nvalue` and switches run together, with `--` ending the flags. */
function readArgs(args, values) {
  const positional = [];
  const flags = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") { positional.push(...args.slice(index + 1)); break; }
    if (arg.startsWith("--")) {
      const cut = arg.indexOf("=");
      const name = cut < 0 ? arg : arg.slice(0, cut);
      flags.push([name, cut >= 0 ? arg.slice(cut + 1) : values.has(name) ? args[++index] ?? "" : null]);
    } else if (arg.startsWith("-") && arg.length > 1) {
      for (let at = 1; at < arg.length; at++) {
        const name = `-${arg[at]}`;
        if (!values.has(name)) { flags.push([name, null]); continue; }
        const joined = arg.slice(at + 1);
        flags.push([name, joined ? joined.replace(/^=/, "") : args[++index] ?? ""]);
        break;
      }
    } else positional.push(arg);
  }
  const last = (...names) => flags.findLast(([name]) => names.includes(name))?.[1] ?? null;
  return { positional, last, help: flags.some(([name]) => name === "--help" || name === "-h") };
}

const isGitHubHost = (host) => /^(?:www\.)?github\.com$/i.test(host);

/** A REST path as GitHub routes it: no query, each segment decoded, and dot
    segments and doubled slashes resolved. */
function restRoute(target) {
  const route = [];
  for (const raw of target.replace(/[?#].*$/, "").split("/")) {
    let segment = raw;
    try { segment = decodeURIComponent(raw); } catch { /* as written */ }
    if (segment === "..") route.pop();
    else if (segment && segment !== ".") route.push(segment);
  }
  return route.join("/");
}

function classifyApi(args, env) {
  const { positional, last, help } = readArgs(args, VALUE_FLAGS.api);
  if (help) return PASS;
  const hostname = last("--hostname");
  if (hostname != null && !isGitHubHost(hostname)) return PASS;
  let target = positional[1] ?? "";
  const absolute = /^https?:\/\/([^/]+)\/(.*)$/i.exec(target);
  if (absolute) {
    /* An absolute URL is sent where it points; only GitHub's own API host is ours. */
    if (absolute[1].toLowerCase() !== "api.github.com") return PASS;
    target = absolute[2];
  }
  target = target.replace(/^\/+/, "");
  /* The installation endpoints answer only an installation token: the batch
     lander's principal check reads one of them. */
  if (/^installation(?:\/|$|\?)/.test(target)) return { kind: "app", repository: null };
  const body = API_BODY_FLAGS.some((name) => last(name) != null);
  const effective = (last("-X", "--method") ?? (body ? "POST" : "GET")).toUpperCase();
  const route = restRoute(target);
  /* GitHub answers the same routes under a repository's number, which names a
     repository nothing here can read. */
  const numbered = /^repositories\/\d+(\/.*)$/i.exec(route);
  for (const write of FORGE_APP_API_WRITES) {
    if (write.method !== effective) continue;
    if (numbered && write.path.test(`repos/owner/name${numbered[1]}`)) {
      return refuse("it names its repository by number; name it as owner/name");
    }
    const match = write.path.exec(route);
    if (!match) continue;
    const [owner, name] = [match[1], match[2]];
    const placeholders = [owner, name].filter((part) => /^[{:]/.test(part)).length;
    /* Both placeholders are filled from the base repository, as `gh` fills them. */
    if (placeholders === 2) return { kind: "app", repository: env.GH_REPO ?? null };
    if (placeholders === 1 || /[^A-Za-z0-9._-]/.test(owner + name)) {
      return refuse("its repository is named in a form Delegatus does not read; name it as owner/name");
    }
    return { kind: "app", repository: `${owner}/${name}` };
  }
  return PASS;
}

/**
 * What one `gh` invocation is: one of the covered kinds of write, which goes
 * out as the App when its repository is declared; a covered kind whose
 * repository is named in a way that cannot be read, which is refused; or
 * anything else, which passes through untouched. `repository` is null when the
 * command names none and `gh` would take it from the checkout.
 *
 * One action has one classification in every spelling `gh` accepts: the
 * command or its alias, a pull request given as its URL, a REST path or the
 * absolute URL of one, flags joined to their values, and either placeholder.
 */
export function classifyGh(args, env = {}) {
  const [command, sub] = readArgs(args, VALUE_FLAGS[""]).positional;
  if (!command) return PASS;
  if (command === "api") return classifyApi(args, env);
  const typed = `${command} ${sub ?? ""}`;
  const covered = GH_COMMAND_ALIASES[typed] ?? typed;
  if (!FORGE_APP_GH_COMMANDS.includes(covered)) return PASS;
  const { positional, last, help } = readArgs(args, VALUE_FLAGS[covered]);
  if (help) return PASS;
  /* A pull request given as its URL names its repository, before any flag. */
  const url = covered === "pr create" ? null : PULL_REQUEST_URL.exec(positional[2] ?? "");
  if (url) return isGitHubHost(url[1]) ? { kind: "app", repository: `${url[2]}/${url[3]}` } : PASS;
  return { kind: "app", repository: last(...REPOSITORY_FLAGS) ?? env.GH_REPO ?? null };
}

/** Runs `gh` for an agent. Returns the exit status. */
export async function runGh(args, ports) {
  const gh = ports.findGh();
  if (!gh) {
    ports.stderr("Delegatus: the gh command line tool was not found on PATH.\n");
    return 127;
  }
  /* Nothing declared: the command as typed, in the environment it was typed in. */
  if (declaredRepositories(ports.env).length === 0) return ports.exec(gh, args, ports.env);
  const decision = classifyGh(args, ports.env);
  if (decision.kind === "refuse") {
    ports.stderr(`${refusalMessage(null, decision.reason)}\n`);
    return 1;
  }
  let named = null;
  if (decision.kind === "app" && decision.repository != null) named = parseRepository(decision.repository);
  else if (decision.kind === "app") {
    /* `gh` picks the base repository among the checkout's remotes. When the
       first is not declared and another is, which one it would write to is
       not settled here, so the command has to say. */
    const remotes = await ports.checkoutRepositories();
    named = remotes[0] ?? null;
    if (named && !isDeclaredRepository(named, ports.env) && remotes.some((remote) => isDeclaredRepository(remote, ports.env))) {
      ports.stderr(`${refusalMessage(null, "this checkout has several GitHub remotes and one of them is an App repository; name the repository with --repo")}\n`);
      return 1;
    }
  }
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
    if (status !== 0 && readArgs(args, VALUE_FLAGS[""]).positional.slice(0, 2).join(" ") === "pr edit") {
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
  /* The checkout's GitHub repositories in the order `gh` prefers them as the
     base: one marked by `gh repo set-default`, then upstream, github, origin. */
  const checkoutRepositories = async () => {
    const remotes = [];
    for (const line of ((await run("git", ["remote", "-v"], { cwd, env })) ?? "").split("\n")) {
      const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line);
      const slug = match ? parseRepository(match[2]) : null;
      if (slug) remotes.push([match[1], slug]);
    }
    const rank = (name) => ["origin", "github", "upstream"].indexOf(name);
    remotes.sort((left, right) => rank(right[0]) - rank(left[0]));
    const chosen = [];
    for (const line of ((await run("git", ["config", "--get-regexp", "^remote\\..*\\.gh-resolved$"], { cwd, env })) ?? "").split("\n")) {
      const match = /^remote\.(.+)\.gh-resolved\s+(\S+)$/.exec(line);
      const slug = !match ? null : match[2] === "base" ? remotes.find(([name]) => name === match[1])?.[1] : parseRepository(match[2]);
      if (slug) chosen.push(slug);
    }
    return [...new Set([...chosen, ...remotes.map(([, slug]) => slug)])];
  };
  return {
    env,
    now: Date.now,
    originRepository,
    checkoutRepositories,
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
  ports.stderr(`usage: ${HELPER_FILE} token|gh|git-credential\n`);
  return 2;
}

/* The command line entry runs only when this file itself was started: the
   launch code imports it for its constants, and a bundle that contains it is
   started under its own name. */
let invoked = false;
try {
  invoked = !!process.argv[1] && path.basename(process.argv[1]) === HELPER_FILE
    && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
} catch { invoked = false; }
/* No top-level await: the launch code imports this file. */
if (invoked) main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, () => { process.exitCode = 1; });
