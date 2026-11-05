import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Real helper and case-sensitive keyring lookup; only GitHub's HTTP replies
 * are replaced. The child starts outside any checkout, like a Viewer release. */
export function caseSensitiveAppFixture(root: string) {
  fs.mkdirSync(root, { recursive: true });
  const cwd = path.join(root, "release");
  fs.mkdirSync(cwd);
  const credential = path.join(root, "credential.json");
  const lookups = path.join(root, "lookups.jsonl");
  const requests = path.join(root, "requests.jsonl");
  const preload = path.join(root, "github.mjs");
  const repository = "Acme/Widgets";
  const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  fs.writeFileSync(credential, JSON.stringify({ id: 7, installation_id: 42, pem }), { mode: 0o600 });
  fs.writeFileSync(path.join(root, "secret-tool"), `#!${process.execPath}
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FIXTURE_LOOKUPS, JSON.stringify(args) + "\\n");
if (JSON.stringify(args) !== JSON.stringify(["lookup", "service", "delegatus-github-app", "repository", "Acme/Widgets"])) process.exit(1);
process.stdout.write(fs.readFileSync(process.env.FIXTURE_CREDENTIAL));
`, { mode: 0o700 });
  fs.writeFileSync(preload, `
import fs from "node:fs";
Date.now = () => Date.parse("2030-01-01T00:00:00Z");
globalThis.fetch = async (url, options) => {
  const target = new URL(url).pathname;
  fs.appendFileSync(process.env.FIXTURE_REQUESTS, JSON.stringify([options.method, target]) + "\\n");
  const permissions = { contents: "write", pull_requests: "write", metadata: "read" };
  let body;
  if (/^\\/repos\\/acme\\/widgets\\/installation$/i.test(target)) {
    body = { id: 42, app_id: 7, account: { login: "Acme" }, suspended_at: null, permissions };
  } else if (target === "/app/installations/42/access_tokens") {
    const request = JSON.parse(options.body);
    if (request.repositories.length !== 1 || request.repositories[0].toLowerCase() !== "widgets") throw new Error("unexpected repository scope");
    body = { token: "fixture", expires_at: "2030-01-01T01:00:00Z", permissions: request.permissions };
  } else if (target === "/installation/repositories") {
    body = { total_count: 1, repositories: [{ id: 99, full_name: "Acme/Widgets" }] };
  } else throw new Error("unexpected API request");
  return new Response(JSON.stringify(body), { status: 200 });
};
`);
  fs.writeFileSync(path.join(root, "bun"), '#!/bin/sh\ncd "$FIXTURE_CWD" || exit 1\nexec "$FIXTURE_BUN" --preload "$FIXTURE_PRELOAD" "$@"\n', { mode: 0o700 });
  const source: NodeJS.ProcessEnv = {
    NODE_ENV: "test", HOME: root, PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}`,
    FIXTURE_BUN: process.execPath, FIXTURE_CWD: cwd, FIXTURE_PRELOAD: preload,
    FIXTURE_CREDENTIAL: credential, FIXTURE_LOOKUPS: lookups, FIXTURE_REQUESTS: requests,
    LLV_STATE_DIR: path.join(root, "state"), XDG_CONFIG_HOME: path.join(root, "config"), TMPDIR: root,
  };
  const rows = (file: string): string[][] => fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  return { repository, source, cwd, lookups: () => rows(lookups), requests: () => rows(requests) };
}
