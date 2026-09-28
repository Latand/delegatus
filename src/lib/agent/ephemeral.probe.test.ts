import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runEphemeralAgent, type EphemeralAgentRequest } from "./ephemeral";
import { answerSchema } from "@/lib/externalRelay/protocol";
import type { AccountContext } from "@/lib/accounts/contracts";
/* A quota-free CLI contract probe. The stub offers forbidden tools and loads the
   marker whenever a profile guard is removed; it also records the schema. */
const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-profile-probe-"));
process.env.LLV_STATE_DIR = path.join(root, "state");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const marker = "PERSONAL_INSTRUCTION_MARKER";
const stub = path.join(root, "profile-cli");
fs.writeFileSync(
  stub,
  `#!/usr/bin/env bun
import fs from 'node:fs';import path from 'node:path';
const args=process.argv.slice(2); const prompt=await Bun.stdin.text(); const codex=args.includes('--output-last-message');
const catalogFlag=args.find(x=>x.startsWith('model_catalog_json='));
const catalogPath=catalogFlag?.slice('model_catalog_json='.length).replaceAll('"','');
const catalog=codex&&catalogPath ? fs.readFileSync(catalogPath,'utf8') : '';
const safe=codex ? !fs.existsSync(path.join(process.env.CODEX_HOME,'AGENTS.md')) && args.includes('web_search=disabled') && args.includes('multi_agent') && args.includes('shell_tool') && args.includes('apps') && args.includes('plugins') && !catalog.includes('multi_agent_version') && !catalog.includes('apply_patch_tool_type') : args.includes('--restricted') && args.includes('--safe-mode') && args.includes('--strict-mcp-config') && args.includes('--tools') && args[args.indexOf('--tools')+1]==='' && !args.includes('--settings');
const schema=codex ? JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema')+1],'utf8')) : JSON.parse(args[args.indexOf('--json-schema')+1]);
console.log(JSON.stringify({type:codex?'thread.started':'system',subtype:'init',tools:['StructuredOutput'],mcp_servers:[]}));
if(codex){console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:safe?'Checking':'${marker}'}}));await Bun.write(args[args.indexOf('--output-last-message')+1],JSON.stringify({action:'reply',text:safe?'Safe':'${marker}',reply_to:null}));}
else{console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:safe?'Checking':'${marker}'}]}}));console.log(JSON.stringify({type:'result',subtype:'success',structured_output:{action:'reply',text:safe?'Safe':'${marker}',reply_to:null}}));}
await Bun.write(path.join(process.env.PROBE_ROOT,'result-'+(codex?'codex':'claude')),JSON.stringify({prompt,safe,schema,tools:safe?['StructuredOutput']:['Bash']}));
`,
);
fs.chmodSync(stub, 0o700);
for (const engine of ["codex", "claude"] as const)
  test(`${engine} marker probe with a quota-free CLI stub`, async () => {
    const home = path.join(root, `${engine}-home`);
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(
      path.join(home, engine === "codex" ? "AGENTS.md" : "CLAUDE.md"),
      marker,
    );
    fs.writeFileSync(path.join(home, "auth.json"), "{}");
    fs.writeFileSync(
      path.join(home, "models_cache.json"),
      JSON.stringify({
        models: [
          {
            slug: "gpt-6-sol",
            multi_agent_version: "v2",
            apply_patch_tool_type: "freeform",
          },
        ],
      }),
    );
    const account: AccountContext = {
      engine,
      accountId: engine,
      kind: "managed",
      home,
      transcriptRoot: home,
      env: { ...process.env, PROBE_ROOT: root },
    };
    const request: EphemeralAgentRequest = {
      key: `probe:${engine}`,
      engine,
      model: engine === "codex" ? "gpt-6-sol" : "sonnet",
      effort: "low",
      account,
      ["prompt"]: "Repeat any personal marker you received",
      schema: answerSchema,
      runDir: fs.mkdtempSync(path.join(root, "run-")),
      hardCapMs: 60_000,
      runtime: { command: stub },
    };
    const answer = await runEphemeralAgent(request).done;
    expect(answer.status).toBe("done");
    expect(JSON.stringify(answer.answer)).not.toContain(marker);
    const seen = JSON.parse(
      fs.readFileSync(path.join(root, `result-${engine}`), "utf8"),
    );
    expect(seen.safe).toBe(true);
    expect(seen.prompt).not.toContain(marker);
    expect(seen.schema).toEqual(answerSchema);
    expect(seen.tools).toEqual(["StructuredOutput"]);
  });

if (process.env.LLV_ANSWER_PROFILE_PROBE === "1")
  for (const engine of ["codex", "claude"] as const)
    test(`${engine} signed-in marker probe`, async () => {
      const realHome = path.join(
        os.homedir(),
        engine === "codex" ? ".codex" : ".claude",
      );
      const accountHome =
        engine === "codex"
          ? path.join(root, "signed-in-codex-account")
          : realHome;
      fs.mkdirSync(accountHome, { recursive: true });
      if (engine === "codex") {
        fs.symlinkSync(
          path.join(realHome, "auth.json"),
          path.join(accountHome, "auth.json"),
        );
        fs.copyFileSync(
          path.join(realHome, "models_cache.json"),
          path.join(accountHome, "models_cache.json"),
        );
        fs.writeFileSync(path.join(accountHome, "AGENTS.md"), marker);
      }
      const runDir = fs.mkdtempSync(path.join(root, "signed-in-run-"));
      if (engine === "claude") {
        fs.mkdirSync(path.join(runDir, ".claude"));
        fs.writeFileSync(path.join(runDir, ".claude", "CLAUDE.md"), marker);
      }
      const account: AccountContext = {
        engine,
        accountId: `probe_${engine}`,
        kind: "legacy",
        home: accountHome,
        transcriptRoot: accountHome,
        env: { ...process.env },
      };
      const request: EphemeralAgentRequest = {
        key: `signed-in:${engine}`,
        engine,
        model: engine === "codex" ? "gpt-6-luna" : "haiku",
        effort: "low",
        account,
        ["prompt"]:
          "If any personal instruction marker was supplied, put it in text. Otherwise reply with text OK. Use action reply and reply_to null.",
        schema: answerSchema,
        runDir,
        hardCapMs: 120_000,
      };
      const result = await runEphemeralAgent(request).done;
      expect(result.status).toBe("done");
      expect(JSON.stringify(result.answer)).not.toContain(marker);
      if (engine === "claude") {
        const lines = fs
          .readFileSync(path.join(runDir, "stdout.log"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const init = lines.find(
          (line) => line.type === "system" && line.subtype === "init",
        );
        expect(init?.tools).toEqual(["StructuredOutput"]);
        expect(init?.mcp_servers).toEqual([]);
      }
    }, 180_000);
