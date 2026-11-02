import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { CodexSocketTransport } from "@/lib/runtime/codexSocketTransport";

/** Match the existing credential-free native CLI fixtures: only account and
 * model catalog projection is synthetic. Socket identity, command execution,
 * callbacks, history, cleanup and reconnection remain the installed CLI's. */
export function credentialFreeSocketFixture() {
  const reconnect = CodexSocketTransport.reconnect;
  CodexSocketTransport.reconnect = async function (owner) {
    const transport = await reconnect.call(this, owner);
    const input = new PassThrough(), output = new PassThrough();
    const methods = new Map<number, string>();
    const inbound = createInterface({ input });
    const outbound = createInterface({ input: transport.stdout });
    inbound.on("line", line => {
      const frame = JSON.parse(line) as { id?: number; method?: string };
      if (typeof frame.id === "number" && (frame.method === "account/read" || frame.method === "model/list")) methods.set(frame.id, frame.method);
      transport.stdin.write(line + "\n");
    });
    outbound.on("line", line => {
      const frame = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
      const method = typeof frame.id === "number" ? methods.get(frame.id) : undefined;
      if (typeof frame.id === "number") methods.delete(frame.id);
      if (method === "account/read") {
        delete frame.error;
        frame.result = { account: { type: "chatgpt", planType: "fixture" }, requiresOpenaiAuth: false };
      }
      if (method === "model/list") {
        delete frame.error;
        frame.result = { data: [{ id: "fixture-model", model: "fixture-model", isDefault: true,
          inputModalities: ["text"], supportedReasoningEfforts: [{ reasoningEffort: "high" }] }] };
      }
      output.write(JSON.stringify(frame) + "\n");
    });
    const close = () => { inbound.close(); outbound.close(); input.destroy(); output.end(); };
    transport.once("close", close);
    return new Proxy(transport, { get(target, property) {
      if (property === "stdin") return input;
      if (property === "stdout") return output;
      if (property === "disconnect") return () => { close(); target.disconnect(); };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  };
  return () => { CodexSocketTransport.reconnect = reconnect; };
}
