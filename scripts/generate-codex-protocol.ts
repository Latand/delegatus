import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Run with the exact supported executable: bun scripts/generate-codex-protocol.ts --codex <binary>.
const binaryIndex = process.argv.indexOf("--codex");
const binary = binaryIndex < 0 ? "codex" : process.argv[binaryIndex + 1];
if (!binary) throw new Error("--codex requires an executable");
const run = (...args: string[]) => {
  const result = spawnSync(binary, args, { encoding: "utf8", timeout: 60_000 });
  if (result.status !== 0) throw new Error(`Codex protocol generation failed (${args[0]})`);
  return result.stdout;
};
const version = /^codex-cli (\d+\.\d+\.\d+)\s*$/.exec(run("--version"))?.[1];
if (!version) throw new Error("Cannot identify the Codex CLI version");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "delegatus-codex-protocol-"));
const destination = path.join(import.meta.dir, "../src/lib/accounts/protocol", version);
fs.mkdirSync(destination, { recursive: true });
try {
  const digests: Record<string, string> = {};
  for (const experimental of [false, true]) {
    const name = experimental ? "experimental" : "stable";
    run("app-server", "generate-json-schema", "--out", path.join(scratch, name), ...(experimental ? ["--experimental"] : []));
    const raw = fs.readFileSync(path.join(scratch, name, "codex_app_server_protocol.schemas.json"), "utf8");
    // Preserve the CLI's artifact verbatim, including its descriptions and references.
    fs.writeFileSync(path.join(destination, `${name}.json`), raw);
    digests[name] = createHash("sha256").update(raw).digest("hex");
  }
  fs.writeFileSync(path.join(destination, "manifest.json"), JSON.stringify({ version, generator: "codex app-server generate-json-schema", sha256: digests }, null, 2) + "\n");
  if (version === "0.162.1") {
    const types = path.join(scratch, "types");
    run("app-server", "generate-ts", "--experimental", "--out", types);
    // Keep only the request router's transitive type closure. Client payloads are schema-validated.
    const seeds = ["ServerRequest.ts", ...fs.readdirSync(path.join(types, "v2")).filter(name => /(?:RequestApproval|RequestUserInput|ElicitationRequest|DynamicToolCall|ChatgptAuthTokensRefresh|AttestationGenerate|CurrentTimeRead)Response\.ts$/.test(name)).map(name => `v2/${name}`), "ApplyPatchApprovalResponse.ts", "ExecCommandApprovalResponse.ts"];
    const pending = [...seeds];
    const written = new Set<string>();
    while (pending.length) {
      const name = pending.pop()!;
      if (written.has(name)) continue;
      written.add(name);
      const source = fs.readFileSync(path.join(types, name), "utf8");
      for (const match of source.matchAll(/from "(\.[^"]+)"/g)) pending.push(path.normalize(path.join(path.dirname(name), `${match[1]}.ts`)));
      const file = path.join(destination, "types", name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, source);
    }
  }
  console.log(`Pinned Codex ${version} protocol`);
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
