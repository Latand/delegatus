import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { APP_DIR_NAMES } from "../../bin/appDir.mjs";

/**
 * Who may resolve the operator's real config and state directories (#1905).
 *
 * A lane's `bun run build` once loaded a route module, the module reached a
 * store, the store ran its first-boot import — and the operator's live account
 * files were migrated out from under the running Viewer. Nothing in that chain
 * intended to touch state; every link resolved `~/.config/agent-log-viewer`
 * because that is what an unset environment resolves to. Prose cannot prevent
 * that, so resolution itself asks who is calling: a process reaches the real
 * directories only when it was started by an owner that says so through
 * `LLV_STATE_OWNER`, and a state-mutating startup step (import, migration,
 * backup, cleanup) needs one of the two owners that hold the release fence.
 *
 * Nothing here guards a directory the caller chose explicitly: `LLV_STATE_DIR`
 * and a sandboxed `XDG_CONFIG_HOME` are how every test and capture driver
 * isolates itself, and they stay exactly as isolating as they were.
 */

/** The one opt-in. Its value names the process kind, so a refusal can say who
    was missing rather than only that something was. */
export const STATE_OWNER_ENV = "LLV_STATE_OWNER";

/**
 * Process kinds that legitimately run against the operator's own directories:
 *
 * - `viewer` — the serving Viewer (`next start`, `next dev`, the container).
 * - `runtime-host` — the runtime host that owns the stable listener and the
 *   release fence.
 * - `launcher` — the `agent-log-viewer` CLI, which reads and writes state
 *   before it hands over to a Viewer.
 * - `deploy-adapter` — the in-image adapter that drives a release.
 * - `mcp` — the Viewer MCP server, which keeps its receipts beside the state
 *   it reports on.
 * - `tool` — an operator-run script that genuinely administers live state
 *   (bootstrap, provisioning). A script that only needs *a* state directory
 *   sets `LLV_STATE_DIR` instead.
 */
export const STATE_OWNERS = ["viewer", "runtime-host", "launcher", "deploy-adapter", "mcp", "tool"] as const;
export type StateOwner = (typeof STATE_OWNERS)[number];

/** The owners that may run a state-mutating startup step: the two processes
    that own the release fence. A launcher, an MCP server or a script reads the
    state a Viewer already migrated; it never migrates it itself. */
export const STARTUP_MUTATION_OWNERS: readonly StateOwner[] = ["viewer", "runtime-host"];

export type GuardedContext = "build" | "test";

/** The owner this process declares, or null when it declares none (an
    unrecognised token counts as none, and the refusal quotes it). */
export function stateOwner(env: NodeJS.ProcessEnv = process.env): StateOwner | null {
  const value = env[STATE_OWNER_ENV]?.trim();
  return value && (STATE_OWNERS as readonly string[]).includes(value) ? value as StateOwner : null;
}

/** Whether this process may run imports, migrations, backups and cleanups. */
export function ownsStateStartupMutation(env: NodeJS.ProcessEnv = process.env): boolean {
  const owner = stateOwner(env);
  return owner !== null && STARTUP_MUTATION_OWNERS.includes(owner);
}

/**
 * Declare this process's owner, unless it already carries one it inherited.
 *
 * **Where this runs matters more than what it sets.** An `import` is evaluated
 * before any statement in the file that wrote it, so a claim in an entry
 * point's body runs AFTER every module that entry point imports — and a module
 * that resolves state at module scope (`export const INBOX_DIR = inboxDir()`)
 * has already been refused by then. An entry point therefore claims through
 * one of the side-effect modules in `src/lib/state/owner/`, imported first, or
 * (like `src/runtime-host/main.ts`) claims in its body and reaches everything
 * else through `await import`.
 */
export function claimStateOwner(owner: StateOwner, env: NodeJS.ProcessEnv = process.env): void {
  if (!env[STATE_OWNER_ENV]) env[STATE_OWNER_ENV] = owner;
}

function uniqueStrings(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => !!value && value.trim().length > 0))];
}

function underTemp(directory: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const resolved = path.resolve(directory);
  return uniqueStrings([os.tmpdir(), env.TMPDIR, "/tmp", "/var/tmp"])
    .map((root) => path.resolve(root))
    .some((root) => resolved === root || resolved.startsWith(root + path.sep));
}

/**
 * The directory trees that belong to the operator's own installation.
 *
 * `os.homedir()` and `$HOME` are both consulted: under Bun `os.homedir()` reads
 * the passwd entry and ignores `$HOME`, so a process that moved `$HOME` to a
 * sandbox still resolves the real home through it — which is how a test can
 * believe it is isolated while writing live state.
 *
 * A relocated `XDG_CONFIG_HOME` is included too, unless it points under a temp
 * root: that is a sandbox a test or a capture driver built for itself, and it
 * is precisely what isolation looks like here.
 */
export function operatorOwnedRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const roots: string[] = [];
  /* `os.homedir()` is always the operator's. `$HOME` counts too, unless it
     points under a temp root — that is a sandbox a test or a driver built for
     itself, and treating it as the operator's would substitute a throw-away
     directory for the one the caller deliberately chose. */
  const homes = uniqueStrings([os.homedir(), env.HOME]).filter((home, index) => index === 0 || !underTemp(home, env));
  for (const home of homes) {
    /* Every name the app dir has had, `delegatus` included: a lane's build
       that resolved `~/.config/delegatus` as unguarded would be #1905 with a
       new name. */
    for (const name of APP_DIR_NAMES) roots.push(path.join(home, ".config", name));
    roots.push(path.join(home, ".claude", "viewer-state"));
    roots.push(path.join(home, ".claude", "viewer-inbox"));
  }
  const configHome = env.XDG_CONFIG_HOME?.trim();
  if (configHome && !underTemp(configHome, env)) {
    for (const name of APP_DIR_NAMES) roots.push(path.join(configHome, name));
  }
  return uniqueStrings(roots.map((root) => path.resolve(root)));
}

/**
 * Plain containment in {@link operatorOwnedRoots}, before the temp-root
 * exemption below.
 *
 * This is the question the spawn boundary asks about a `TMPDIR` it was handed:
 * that directory IS the process's scratch root, so the exemption would only
 * answer itself, while whether it sits inside the operator's installation is
 * exactly what has to be decided.
 */
export function underOperatorRoot(directory: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const resolved = path.resolve(directory);
  return operatorOwnedRoots(env).some((root) => resolved === root || resolved.startsWith(root + path.sep));
}

/**
 * Whether `directory` is, or sits inside, one of {@link operatorOwnedRoots}.
 *
 * The process temp root wins over the containment test, whatever it points at.
 * A restricted stage agent runs with `TMPDIR` under `statePath("scratch")`, so
 * by path alone every directory it `mktemp`s reads as the operator's — and the
 * suites it runs, which drive imports and backups against their own temp
 * directories, were refused by {@link assertStateStartupMutation}. A path the
 * process was told is its scratch root is nobody's durable state, exactly as a
 * caller-chosen `LLV_STATE_DIR` is admitted untouched.
 */
export function isOperatorOwnedDirectory(directory: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (underTemp(directory, env)) return false;
  return underOperatorRoot(directory, env);
}

/**
 * The contexts that get a throw-away directory rather than a refusal, because
 * refusing would only turn an accidental write into an accidental failure:
 * a production build collecting page data, and a test run.
 */
export function guardedContext(env: NodeJS.ProcessEnv = process.env): GuardedContext | null {
  if (env.NEXT_PHASE?.includes("build")) return "build";
  if (env.NODE_ENV === "test") return "test";
  if (process.argv.some((argument) => /\.test\.(ts|tsx|js|jsx|mjs|cjs)$/.test(argument))) return "test";
  return null;
}

/**
 * A test run, as the environment declares it. Narrower than
 * {@link guardedContext}, which also reads this process's argv: the fence
 * below overrides a declared owner, and an owner is a property of the
 * environment handed in, so the answer has to come from that environment too.
 * `bun test` pins it in `test-preload.ts`; the incident's `bun -e` set it by
 * hand.
 */
export function testEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === "test";
}

let throwawayRoot: string | null = null;
let throwawayRootCleanupInstalled = false;

function removeThrowawayStateRoot(): void {
  if (!throwawayRoot) return;
  try {
    /* This path came from mkdtemp in this process; never sweep the temp root. */
    fs.rmSync(throwawayRoot, { recursive: true, force: true });
  } catch {
    /* Exit cleanup is best effort. The root remains private and 0700 if the
       process is terminated before this handler can run. */
  }
}

/**
 * One throw-away root per process, created on first use. It is stable for the
 * life of the process on purpose: a build or a test that writes through the
 * substituted path and reads it back still sees its own writes, so the
 * substitution keeps whatever the caller was doing honest instead of
 * scattering it across directories.
 */
export function throwawayStateRoot(): string {
  if (!throwawayRoot) {
    /* The temp root is created first: a restricted stage agent's `TMPDIR` is
       deleted with its scratch directory when the stage releases, and a stale
       one turned a harmless substitution into an ENOENT crash. */
    const temporary = os.tmpdir();
    fs.mkdirSync(temporary, { recursive: true });
    throwawayRoot = fs.mkdtempSync(path.join(temporary, "llv-unowned-state-"));
    if (!throwawayRootCleanupInstalled) {
      throwawayRootCleanupInstalled = true;
      process.once("exit", removeThrowawayStateRoot);
    }
  }
  return throwawayRoot;
}

export class UnownedStateAccessError extends Error {
  readonly directory: string;
  constructor(directory: string, env: NodeJS.ProcessEnv) {
    const declared = env[STATE_OWNER_ENV]?.trim();
    super(
      `refusing to resolve the operator's state directory ${directory}: this process declares no ${STATE_OWNER_ENV}`
      + (declared ? ` (it set ${STATE_OWNER_ENV}=${declared}, which names no known owner)` : "")
      + `. Point LLV_STATE_DIR at a throw-away directory, or set ${STATE_OWNER_ENV} to one of ${STATE_OWNERS.join(", ")}`
      + " if this process really is that owner.",
    );
    this.name = "UnownedStateAccessError";
    this.directory = directory;
  }
}

export class StateStartupMutationRefused extends Error {
  constructor(step: string, directory: string, env: NodeJS.ProcessEnv) {
    const declared = stateOwner(env) ?? "none";
    super(
      `refusing to run the state startup step "${step}" against ${directory}: it belongs to the serving Viewer or the`
      + ` runtime host, and this process declares ${STATE_OWNER_ENV}=${declared}.`,
    );
    this.name = "StateStartupMutationRefused";
  }
}

/**
 * A test that reached the operator's own state (the live-state fence).
 *
 * The owner check above admits a declared owner wherever it points, and an
 * explicit `LLV_STATE_DIR` is never classified at all. Both are inherited: a
 * headless reviewer the Viewer spawned carried the Viewer's own
 * `LLV_STATE_OWNER=viewer`, ran a `NODE_ENV=test bun -e` fixture, and the two
 * placeholder tasks it minted landed in the live task store. A test context
 * owns nothing, whatever it inherited, so it is refused here.
 */
export class OperatorStateUnderTestError extends Error {
  readonly directory: string;
  constructor(directory: string, store: string) {
    super(
      `refusing to open the operator's ${store} at ${directory} from a test run (NODE_ENV=test).`
      + " A test never writes live state: point LLV_STATE_DIR at a throw-away directory.",
    );
    this.name = "OperatorStateUnderTestError";
    this.directory = directory;
  }
}

/**
 * The store boundary's half of the fence: the task store, the agent registry
 * and the state database call this with the file they are about to open. In a
 * test run an operator-owned path throws, whether it arrived through a
 * declared owner, an inherited `LLV_STATE_DIR` or an explicit argument.
 * Outside a test it is free: resolution already decided who may reach it.
 */
export function assertNotOperatorStateUnderTest(
  target: string,
  store: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!testEnvironment(env)) return;
  if (!isOperatorOwnedDirectory(target, env)) return;
  throw new OperatorStateUnderTestError(target, store);
}

const warned = new Set<string>();

function warnSubstitution(context: GuardedContext, directory: string, substitute: string): void {
  if (warned.has(directory)) return;
  warned.add(directory);
  console.warn(
    `[state ownership] ${context} resolved the operator's directory ${directory} without ${STATE_OWNER_ENV};`
    + ` using the throw-away ${substitute} instead.`,
  );
}

/**
 * Admit `directory` or hand back somewhere harmless.
 *
 * A directory that is not the operator's own passes untouched. The operator's
 * own passes only for a declared owner; a build or a test gets a throw-away
 * directory under the temp root, and anything else — a script, a one-off
 * `bun …` — is refused with an error that says what to set.
 */
export function admitOperatorDirectory(
  directory: string,
  kind: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  /* A declared owner is admitted wherever the directory is, so it is asked
     first: the classification below is path work that every `statePath()`
     call repeated (#1987). Both answers are read afresh on every call. */
  if (stateOwner(env) && !testEnvironment(env)) return directory;
  if (!isOperatorOwnedDirectory(directory, env)) return directory;
  /* A test run that carries an owner claimed the operator's directory on
     purpose or by inheritance; either way it is refused out loud rather than
     quietly redirected, so the claim is seen and removed. */
  if (stateOwner(env)) throw new OperatorStateUnderTestError(directory, `${kind} directory`);
  const context = guardedContext(env);
  if (!context) throw new UnownedStateAccessError(directory, env);
  const substitute = path.join(throwawayStateRoot(), kind);
  warnSubstitution(context, directory, substitute);
  fs.mkdirSync(substitute, { recursive: true, mode: 0o700 });
  return substitute;
}

/**
 * The gate every state-mutating startup step passes through. A directory that
 * is not the operator's own is free — that is how tests drive an import, a
 * backup or a cleanup against a temp root. The operator's own needs the Viewer
 * or the runtime host.
 */
export function assertStateStartupMutation(
  directory: string,
  step: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!isOperatorOwnedDirectory(directory, env)) return;
  if (ownsStateStartupMutation(env)) return;
  throw new StateStartupMutationRefused(step, directory, env);
}

/** The same question without the throw, for a step that may simply stand down
    and leave the work to the Viewer that owns it. */
export function mayRunStateStartupMutation(
  directory: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  /* The same answer as before, the cheap half first. */
  return ownsStateStartupMutation(env) || !isOperatorOwnedDirectory(directory, env);
}
