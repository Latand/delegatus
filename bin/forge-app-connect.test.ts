import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkEnvironment } from "../scripts/gate-cache";
import { createGateSandbox, isolatedEnvironment } from "../scripts/local-gate";
import { appConnect, FORGE_APP_ISSUE_PERMISSIONS, FORGE_REPOSITORIES_ENV, mintInstallationToken, productionPorts } from "./forge-app-token.mjs";
import { fakeAppConnection, CONNECT_SOURCE, CONNECT_TARGET } from "../src/lib/forge/appConnect.fixture";

const root = createGateSandbox();
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

test("missing permission keys are separate from a mismatched or suspended installation", async () => {
  const fake = fakeAppConnection(); fake.set({ covered: true, installed: true });
  fake.items.set(CONNECT_TARGET, JSON.stringify({ ...JSON.parse(fake.items.get(CONNECT_SOURCE)!), installation_id: fake.targetInstallation }));
  const error = await mintInstallationToken(CONNECT_TARGET, fake.ports, FORGE_APP_ISSUE_PERMISSIONS).catch((error: unknown) => error) as Error & { reason: string };
  expect(error.reason).toBe("the GitHub App installation is missing permissions: issues");
  expect(fake.calls.filter(c => c.method === "POST")).toEqual([]);
  fake.set({ suspended: true });
  const suspended = await mintInstallationToken(CONNECT_TARGET, fake.ports, FORGE_APP_ISSUE_PERMISSIONS).catch((error: unknown) => error) as Error & { reason: string };
  expect(suspended.reason).toBe("the GitHub App installation is missing, suspended, or differs from the verified one");
  expect(suspended.message).not.toContain(fake.pem);
});

test.each(["locked", "unreachable", "suspended", "store", "broad"])("helper refuses %s without a false proof", async mode => {
  const fake = fakeAppConnection(); fake.set({ covered: true, installed: true });
  if (mode === "locked") fake.items.clear();
  if (mode === "unreachable") fake.set({ unreachable: true });
  if (mode === "suspended") fake.set({ suspended: true });
  if (mode === "store") fake.set({ storeRefused: true });
  if (mode === "broad") fake.set({ broadToken: true });
  const error = await appConnect(CONNECT_TARGET, [CONNECT_SOURCE], fake.ports, { store: fake.targetInstallation }).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).not.toContain(fake.pem);
  if (mode !== "broad") expect(fake.items.has(CONNECT_TARGET)).toBe(false);
  if (mode === "broad") expect(fake.calls.some(c => c.method === "DELETE" && c.target === "installation/token")).toBe(true);
});

test("poll discovery has bounded GETs and never reads unrelated installations", async () => {
  const fake = fakeAppConnection();
  const first = await appConnect(CONNECT_TARGET, [CONNECT_SOURCE], fake.ports);
  fake.calls.splice(0);
  await appConnect(CONNECT_TARGET, [CONNECT_SOURCE], fake.ports, { context: first.context });
  expect(fake.calls.every(c => c.method === "GET")).toBe(true);
  expect(fake.calls.length).toBeLessThanOrEqual(5);
  expect(fake.calls.some(c => c.target === "app/installations")).toBe(false);
});

test.skipIf(process.platform === "win32")("production credential lookup falls back to the declared spelling before minting", async () => {
  const env = isolatedEnvironment(fs.mkdtempSync(path.join(root, "case-")), checkEnvironment(process.env));
  const bin = path.join(env.HOME!, "bin"); fs.mkdirSync(bin);
  const fake = fakeAppConnection();
  const credential = path.join(env.HOME!, "credential.json"); fs.writeFileSync(credential, fake.items.get(CONNECT_SOURCE)!);
  const log = path.join(env.HOME!, "lookups");
  const native = path.join(bin, "secret-tool");
  const script = path.join(bin, "secret-tool.ts");
  fs.writeFileSync(native, `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${script.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o700 });
  fs.writeFileSync(script, `import fs from 'node:fs'; const name=process.argv.at(-1); fs.appendFileSync(${JSON.stringify(log)}, name+'\\n'); if(name==='Example-Owner/Example-Repo') process.stdout.write(fs.readFileSync(${JSON.stringify(credential)},'utf8'));`);
  const p = productionPorts({ ...env, PATH: `${bin}${path.delimiter}${env.PATH}`, [FORGE_REPOSITORIES_ENV]: "Example-Owner/Example-Repo" }, env.HOME);
  const raw = await p.readCredential(CONNECT_SOURCE);
  expect(raw).toBe(fake.items.get(CONNECT_SOURCE));
  const issued = await mintInstallationToken(CONNECT_SOURCE, { ...fake.ports, readCredential: p.readCredential });
  expect(issued.repository).toBe(CONNECT_SOURCE);
  expect(fs.readFileSync(log, "utf8").trim().split("\n")).toContain("Example-Owner/Example-Repo");
});

test.skipIf(process.platform === "win32")("real helper child writes the secret on stdin, proves it, revokes it and returns only public metadata", async () => {
  const env = isolatedEnvironment(fs.mkdtempSync(path.join(root, "child-")), checkEnvironment(process.env));
  const bin = path.join(env.HOME!, "bin"); fs.mkdirSync(bin);
  const items = path.join(env.HOME!, "items.json"), initial = path.join(env.HOME!, "initial.json"), audit = path.join(env.LLV_STATE_DIR!, "forge-app-tokens.ndjson");
  const fixtureModule = fileURLToPath(new URL("../src/lib/forge/appConnect.fixture.ts", import.meta.url));
  const preload = path.join(env.HOME!, "preload.ts");
  fs.writeFileSync(preload, `import fs from 'node:fs'; import {fakeAppConnection,CONNECT_SOURCE} from ${JSON.stringify(fixtureModule)};
    const fake=fakeAppConnection(); fake.set({installed:true,covered:true,broadToken:process.env.CONNECT_FAKE_BROAD==='1'}); const raw=JSON.stringify([...fake.items]); fs.writeFileSync(${JSON.stringify(items)},raw); fs.writeFileSync(${JSON.stringify(initial)},raw);
    globalThis.fetch=async(url,init)=>{ const target=String(url).replace('https://api.github.com/',''); const token=new Headers(init.headers).get('authorization')?.replace(/^Bearer /,'');
      const answer=await fake.ports.request(init.method,target,{token,body:init.body?JSON.parse(init.body):undefined}); return new Response(answer.status===204?null:JSON.stringify(answer.body),{status:answer.status}); };`);
  const shim = path.join(bin, "secret-tool"), script = path.join(bin, "secret-tool.ts");
  fs.writeFileSync(shim, `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${script.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o700 });
  fs.writeFileSync(script, `import fs from 'node:fs'; const file=${JSON.stringify(items)}, values=new Map(JSON.parse(fs.readFileSync(file,'utf8'))); const repo=process.argv.at(-1);
    if(process.argv[2]==='lookup'){if(values.has(repo)) process.stdout.write(values.get(repo)); else process.exitCode=1;}
    else{let raw=''; for await(const chunk of process.stdin)raw+=chunk; if(raw.endsWith('\\n'))process.exit(2); values.set(repo,raw);fs.writeFileSync(file,JSON.stringify([...values]));}`);
  const { agentForgeDir } = await import("../src/lib/git/agentForgeCredentials");
  const helper = path.join(agentForgeDir(env), "forge-app-token.mjs");
  const child = Bun.spawn([process.execPath, "--preload", preload, helper, "app-connect", "--repository", CONNECT_TARGET, "--from", CONNECT_SOURCE, "--store", String(fakeAppConnection().targetInstallation)],
    { env: { ...env, PATH: `${bin}${path.delimiter}${env.PATH}` }, cwd: env.HOME, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  expect(JSON.parse(stdout)).toMatchObject({ proved: true, covered: true, missingPermissions: [] });
  const before = new Map(JSON.parse(fs.readFileSync(initial, "utf8")) as Array<[string, string]>), after = new Map(JSON.parse(fs.readFileSync(items, "utf8")) as Array<[string, string]>);
  expect(after.get(CONNECT_SOURCE)).toBe(before.get(CONNECT_SOURCE));
  const app = JSON.parse(after.get(CONNECT_TARGET)!);
  expect(stdout + stderr + fs.readFileSync(audit, "utf8")).not.toContain(app.pem);
  expect(fs.readFileSync(audit, "utf8").trim().split("\n").map(line => JSON.parse(line).event)).toEqual(["mint", "revoke"]);
  expect(app.installation_id).toBe(fakeAppConnection().targetInstallation);
  const missing = Bun.spawn([process.execPath, "--preload", preload, helper, "app-connect", "--repository", CONNECT_TARGET,
    "--from", CONNECT_SOURCE, "--store", String(app.installation_id), "--permissions", JSON.stringify({ issues: "write" })],
    { env: { ...env, PATH: `${bin}${path.delimiter}${env.PATH}` }, cwd: env.HOME, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [missingOut, missingErr, missingExit] = await Promise.all([new Response(missing.stdout).text(), new Response(missing.stderr).text(), missing.exited]);
  expect({ missingExit, missingOut, missingErr }).toEqual({ missingExit: 1, missingOut: "", missingErr: "Delegatus: missing_permissions: issues\n" });
  expect(missingOut + missingErr).not.toContain(app.pem);
  const refused = Bun.spawn([process.execPath, "--preload", preload, helper, "app-connect", "--repository", CONNECT_TARGET, "--from", CONNECT_SOURCE, "--store", String(app.installation_id)],
    { env: { ...env, CONNECT_FAKE_BROAD: "1", PATH: `${bin}${path.delimiter}${env.PATH}` }, cwd: env.HOME, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [refusedOut, refusedErr, refusedExit] = await Promise.all([new Response(refused.stdout).text(), new Response(refused.stderr).text(), refused.exited]);
  expect(refusedExit).toBe(1); expect(refusedOut).toBe("");
  expect(refusedErr).toBe("Delegatus: verification_failed: the issued token is not limited to this repository\n");
  const refusedApp = JSON.parse(new Map(JSON.parse(fs.readFileSync(items, "utf8")) as Array<[string, string]>).get(CONNECT_TARGET)!);
  expect(refusedOut + refusedErr).not.toContain(refusedApp.pem);
});
