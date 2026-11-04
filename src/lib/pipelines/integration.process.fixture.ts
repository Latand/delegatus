import { loadPipelines } from "./store";
import { defaultPipelinePorts, startPipelineIntegration } from "./engine";
const p = loadPipelines()[0]!;
let result: unknown = null;
if (process.argv[2] === "admit") {
  const ports = defaultPipelinePorts();
  ports.now = () => "2026-11-04T00:00:00.000Z";
  ports.exec = async () => ({ code: 0, stdout: `${p.merge!.refresh!.head}\t${p.delivery!.target.branch}\n`, stderr: "" });
  ports.roleLookup = id => ({ engine: "codex", model: null, effort: null, access: id === "reviewer" ? "read-only" : "read-write", promptScaffold: "Fixture role" });
  result = await startPipelineIntegration(p, ports);
}
console.log(JSON.stringify({ result, items: loadPipelines().map(p => ({ id: p.id, state: p.state, integration: p.merge?.integration, epoch: p.delivery?.epoch })) }));
