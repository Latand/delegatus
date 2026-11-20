import path from "node:path";
import { spawn } from "node:child_process";
import { expect } from "bun:test";
import { ClaudeStreamBrokerHost, FileClaudeDeliveryLedger } from "../claudeStreamBrokerHost";
import { FileRuntimeEventStore } from "../eventStore";
const nativeUuid = (ordinal: number) => ["00000000", "0000", "4000", "8000", String(ordinal).padStart(12, "0")].join("-");

export async function admissionFixture(directory: string, sessionId: string) {
  const ledgerDirectory = path.join(directory, "ledger");
  const store = new FileRuntimeEventStore(path.join(directory, "events"));
  const wire: Array<Record<string, unknown>> = [];
  let child: ReturnType<typeof spawn>;
  const transport = `
    const readline = require("node:readline");
    const lines = readline.createInterface({ input: process.stdin });
    lines.on("line", line => {
      const frame = JSON.parse(line);
      if (frame.type === "user") process.stdout.write(JSON.stringify({ ...frame, isReplay: true }) + "\\n");
      if (frame.type === "fixture-result") process.stdout.write(JSON.stringify(frame.result) + "\\n");
      if (frame.type === "control_request") process.stdout.write(JSON.stringify({ type: "control_response",
        response: { subtype: "success", request_id: frame.request_id, response: {} } }) + "\\n");
    });`;
  const open = async (adopt: boolean, change?: (ledger: FileClaudeDeliveryLedger) => void) => {
    const ledger = new FileClaudeDeliveryLedger(ledgerDirectory);
    change?.(ledger);
    const options: import("../claudeStreamBrokerHost").ClaudeStreamBrokerHostOptions = { cwd: directory, sessionId, nativeQueuedSend: true,
      deliveryLedger: ledger, eventStore: store, readTranscript: () => [],
      env: { ...process.env, NODE_ENV: "test" },
      readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", version: "2.1.325" }),
      spawnProcess: (_command: string, _args: string[], options: import("node:child_process").SpawnOptionsWithoutStdio) => {
        const process = spawn(globalThis.process.execPath, ["-e", transport], { ...options, stdio: ["pipe", "pipe", "pipe"] });
        child = process;
        const write = process.stdin.write.bind(process.stdin);
        process.stdin.write = ((chunk: string, ...args: unknown[]) => {
          const frame = JSON.parse(String(chunk)); if (frame.type === "user") wire.push(frame);
          return Reflect.apply(write, process.stdin, [chunk, ...args]);
        }) as typeof process.stdin.write;
        return process;
      },
    };
    return adopt ? ClaudeStreamBrokerHost.adopt(sessionId, options) : ClaudeStreamBrokerHost.start(options);
  };
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 1000 && !check(); i++) await Bun.sleep(5);
    expect(check()).toBe(true);
  };
  let ordinal = 100;
  const finish = async (host: ClaudeStreamBrokerHost, ids: string[], idle = true) => {
    const inputs = new FileClaudeDeliveryLedger(ledgerDirectory).load(sessionId).filter(row => ids.includes(row.entry.id)).map(row => row.native!.inputUuid);
    child!.stdin!.write(JSON.stringify({ type: "fixture-result", result: { type: "result", subtype: "success", is_error: false,
      session_id: sessionId, uuid: nativeUuid(ordinal++), user_message_uuid: inputs.at(-1), user_message_uuids: inputs } }) + "\n");
    await until(() => store.load(sessionId).some(event => event.kind === "turn-ended" && event.turnId === ids[0]));
    if (idle) expect(await host.health()).toMatchObject({ status: "idle", activeTurnRef: null });
  };
  return { open, wire, store, finish, until, ledgerDirectory };
}
