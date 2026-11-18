import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { shellQuote } from "@/lib/agent/cli";
import { ClaudeStreamBrokerHost, FileClaudeDeliveryLedger } from "./claudeStreamBrokerHost";
import { CodexAppServerHost } from "./codexAppServerHost";
import { FileRuntimeEventStore } from "./eventStore";

// A native executable stand-in must not itself load dotenv. Node reads only
// named synthetic variables; the production Bun launch intermediaries remain
// in the path and would expose their dotenv additions to this child.
const names = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "PROJECT_SERVICE_SECRET", "PROJECT_DATABASE_PASSWORD", "COLORTERM"];
const session = [8, 4, 4, 4, 12].map((width, index) => (index === 3 ? "8" : "4").repeat(width)).join("-");

for (const engine of ["claude", "codex"] as const) for (const resumed of [false, true]) {
  test(`${engine} ${resumed ? "resume" : "fresh"}: fake project dotenv never reaches the spawned engine (#3968)`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-environment-"));
    const cwd = path.join(root, "project");
    const observation = path.join(root, "received.json");
    const previousState = process.env.LLV_STATE_DIR;
    process.env.LLV_STATE_DIR = path.join(root, "state");
    fs.mkdirSync(cwd);
    fs.mkdirSync(path.join(root, "home"));
    fs.writeFileSync(path.join(cwd, ".env"), names.map(name => [name, "fixture-dotenv"].join("=")).join("\n"));
    fs.writeFileSync(path.join(cwd, ".env.local"), ["PROJECT_LOCAL_SECRET", "fixture-local"].join("="));
    const script = path.join(root, "engine.cjs");
    const binary = path.join(root, "engine");
    const selected = [...names, "PROJECT_LOCAL_SECRET"];
    fs.writeFileSync(script, `
      const fs = require("node:fs"), readline = require("node:readline");
      const send = value => console.log(JSON.stringify(value));
      const args = process.argv.slice(2);
      if (args[0] === "features") { console.log("multi_agent stable false"); process.exit(0); }
      if (args[0] === "auth") { send({loggedIn:true,authMethod:"claude.ai",subscriptionType:"max"}); process.exit(0); }
      if (args[0] === "--version") { console.log("2.1.209"); process.exit(0); }
      fs.writeFileSync(${JSON.stringify(observation)}, JSON.stringify({
        present: ${JSON.stringify(selected)}.filter(name => process.env[name] !== undefined),
        term: process.env.TERM,
        cwd: process.cwd(),
      }));
      const thread = {id:"environment-thread", path:null, turns:[]};
      readline.createInterface({input:process.stdin}).on("line", line => {
        const frame = JSON.parse(line);
        if (${JSON.stringify(engine)} === "claude") {
          if (frame.type === "control_request") send({type:"control_response",response:{
            subtype:"success",request_id:frame.request_id,response:{}}});
          return;
        }
        if (typeof frame.id !== "number") return;
        const replies = {
          initialize:{userAgent:"fixture"}, "account/read":{account:{type:"chatgpt",planType:"pro"}},
          "model/list":{data:[]}, "config/read":{config:{mcp_servers:{viewer:{command:"fixture-mcp",args:[]}}}},
          "mcpServerStatus/list":{data:[{name:"viewer",tools:{fixture_read:{}}}],nextCursor:null},
          "thread/start":{thread}, "thread/resume":{thread}, "thread/read":{thread},
          "thread/queue/list":{data:[]}, "thread/turns/list":{data:[],nextCursor:null},
          "modelProvider/capabilities/read":{},
        };
        send({id:frame.id,result:replies[frame.method] ?? {}});
      });
    `);
    const node = Bun.which("node");
    expect(node).not.toBeNull();
    fs.writeFileSync(binary, `#!/bin/sh\nexec ${shellQuote(node!)} ${shellQuote(script)} "$@"\n`, { mode: 0o700 });
    const env = { NODE_ENV: "development" as const, PATH: process.env.PATH, HOME: path.join(root, "home"),
      TMPDIR: root, XDG_CONFIG_HOME: path.join(root, "config"), LLV_STATE_DIR: process.env.LLV_STATE_DIR,
      LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1", TERM: "fixture-explicit" };
    const options = { cwd, binary, env, mcpServers: [], cleanMemory: true,
      eventStore: new FileRuntimeEventStore(path.join(root, "events")), requestTimeoutMs: 5_000, shutdownGraceMs: 100 };
    let host: ClaudeStreamBrokerHost | CodexAppServerHost | undefined;
    try {
      const control = Bun.spawn([process.execPath, "-e", `console.log(JSON.stringify(${JSON.stringify(selected)}.filter(name => process.env[name] !== undefined)))`],
        { cwd, env, stdout: "pipe", stderr: "pipe" });
      const controlOutput = await new Response(control.stdout).text();
      expect(await control.exited).toBe(0);
      expect(JSON.parse(controlOutput).sort()).toEqual([...selected].sort());
      if (engine === "claude") {
        const claude = { ...options, sessionId: session, readTranscript: () => [],
          deliveryLedger: new FileClaudeDeliveryLedger(path.join(root, "deliveries")) };
        host = resumed ? await ClaudeStreamBrokerHost.adopt(session, claude) : await ClaudeStreamBrokerHost.start(claude);
      } else {
        const codex = { ...options, persistentCallbacks: false, readProtocolVersion: () => "0.162.1" };
        host = resumed ? await CodexAppServerHost.adopt("environment-thread", codex) : await CodexAppServerHost.start(codex);
      }
      const deadline = performance.now() + 5_000;
      while (!fs.existsSync(observation) && performance.now() < deadline) await Bun.sleep(10);
      expect(JSON.parse(fs.readFileSync(observation, "utf8"))).toEqual({ present: [], term: "fixture-explicit", cwd });
      expect((await host.health()).status).toBe("idle");
    } finally {
      await host?.release();
      if (previousState === undefined) delete process.env.LLV_STATE_DIR;
      else process.env.LLV_STATE_DIR = previousState;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
}
