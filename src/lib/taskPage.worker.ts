import readline from "node:readline";
import { TaskPageBuilder, type PageBuildRequest } from "./links/taskPageBuild";

const builder = new TaskPageBuilder();
const lines = readline.createInterface({ input: process.stdin });
for await (const line of lines) {
  let id: unknown;
  try {
    const frame = JSON.parse(line) as { id: number; request: PageBuildRequest };
    id = frame.id;
    const cpu = process.cpuUsage();
    const result = builder.build(frame.request);
    const cpuUsed = process.cpuUsage(cpu);
    process.stdout.write(`{"id":${JSON.stringify(id)},"result":{"page":${result.pageJson},"privacyRevision":${JSON.stringify(result.privacyRevision)},"builds":${result.builds},"startRevision":${result.startRevision},"cpu":${JSON.stringify(cpuUsed)}}}\n`);
  } catch {
    // Store errors may contain task text or paths. Carry only the error class.
    process.stdout.write(`${JSON.stringify({ id, error: "LESSON_PRIVACY_UNAVAILABLE" })}\n`);
  }
}
