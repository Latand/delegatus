/*
 * `delegatus team <command>` (docs/design/sign-in-and-team.md §5.5): the
 * host is the root of recovery. Every other way in can be lost with a phone;
 * the machine cannot.
 *
 *   delegatus team recover [--origin https://host]   a one-time owner link, 15 minutes
 *   delegatus team revoke-sessions                   sign everyone out, everywhere
 *
 * Loaded by Node or Bun as plain `.mjs`, so it cannot import the TypeScript
 * store; it writes the two rows it needs straight into `<state>/team/team.sqlite`
 * with the table shapes of `src/lib/team/store.ts`. `cli.team.test.ts` creates
 * the store with that module, runs this command against it, and redeems the
 * printed link through the module's own join code — so the two cannot drift.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const RECOVERY_TTL_MS = 15 * 60_000;

async function openDatabase(filename) {
  if (process.versions.bun) {
    const { Database } = await import("bun:sqlite");
    const db = new Database(filename, { strict: true });
    return {
      get: (sql, ...params) => db.query(sql).get(...params) ?? null,
      run: (sql, ...params) => db.query(sql).run(...params),
      close: () => db.close(),
    };
  }
  const require = createRequire(import.meta.url);
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(filename);
  return {
    get: (sql, ...params) => db.prepare(sql).get(...params) ?? null,
    run: (sql, ...params) => db.prepare(sql).run(...params),
    close: () => db.close(),
  };
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index !== -1 && args[index + 1]) return args[index + 1];
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : null;
}

function usage() {
  return [
    "Usage:",
    "  delegatus team recover [--origin https://your-delegatus.example]",
    "      Prints a one-time link (15 minutes) that signs its browser in as the owner,",
    "      or makes it the owner when the team has none.",
    "  delegatus team revoke-sessions",
    "      Signs every member out on every device. Members sign in again as usual.",
  ].join("\n");
}

/**
 * @param {string[]} args
 * @param {{ stateDirectory: string, port?: number, env?: Record<string, string | undefined>, log?: (line: string) => void, now?: () => number }} context
 * @returns {Promise<number>} the exit code
 */
export async function runTeamCommand(args, context) {
  const log = context.log ?? ((line) => console.log(line));
  const env = context.env ?? process.env;
  const now = (context.now ?? Date.now)();
  const command = args[0];
  if (command !== "recover" && command !== "revoke-sessions") {
    log(usage());
    return command === undefined || command === "--help" || command === "-h" ? 0 : 2;
  }
  const filename = join(context.stateDirectory, "team", "team.sqlite");
  if (!existsSync(filename)) {
    log("This Delegatus has no team yet: nobody has to sign in, so there is nothing to recover.");
    return 1;
  }
  const db = await openDatabase(filename);
  try {
    if (command === "revoke-sessions") {
      const result = db.run("UPDATE sessions SET revoked_at = ? WHERE revoked_at IS NULL", new Date(now).toISOString());
      log(`Signed out ${Number(result.changes ?? 0)} session(s). Members sign in again with an invite, a passkey, Telegram or an approved device.`);
      return 0;
    }
    const code = randomBytes(16).toString("base64url");
    const id = `c_${randomBytes(16).toString("hex")}`;
    db.run(
      `INSERT INTO challenges(id, kind, secret_hash, user_code, member_id, created_by, created_at, expires_at, consumed_at, attempts,
        invited_name, result_json, requester_json, payload_json) VALUES (?, 'recovery', ?, NULL, NULL, 'cli', ?, ?, NULL, 0, NULL, NULL, NULL, NULL)`,
      id,
      createHash("sha256").update(code).digest("hex"),
      new Date(now).toISOString(),
      new Date(now + RECOVERY_TTL_MS).toISOString(),
    );
    const owner = db.get("SELECT name FROM members WHERE role = 'owner' AND status = 'active' LIMIT 1");
    const origin = (option(args, "--origin") ?? env.LLV_TS_URL?.replace(/\/?(\?.*)?$/, "") ?? `http://127.0.0.1:${context.port ?? 8898}`).replace(/\/+$/, "");
    const url = new URL(`/join/${code}`, `${origin}/`);
    if (env.LLV_TOKEN) url.searchParams.set("k", env.LLV_TOKEN);
    log(owner ? `Open this link to sign in as ${owner.name} (the owner). It works once, for 15 minutes:` : "Open this link to become the owner. It works once, for 15 minutes:");
    log(`  ${url.toString()}`);
    log(`On another address, open /join/${code} there instead.`);
    log("To sign everyone out everywhere: delegatus team revoke-sessions");
    return 0;
  } finally {
    db.close();
  }
}
