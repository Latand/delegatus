import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { releaseBuilderName } from "../../runtime-host/deploymentArtifacts";
import { retentionUnderTest } from "../retentionTestSafety";

const exec = promisify(execFile);
type Row = { kind: "dockerImages" | "dockerCache"; bytes: number };

function dockerBytes(text: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)\s*(B|kB|MB|GB|TB|PB)$/i.exec(text);
  if (!match) return undefined;
  const power = ["b", "kb", "mb", "gb", "tb", "pb"].indexOf(match[2]!.toLowerCase());
  return Math.round(Number(match[1]) * 1000 ** power);
}

export async function readDockerDiskConsumers(state: string, run?: (args: string[]) => Promise<string>): Promise<Row[]> {
  if (!run && (retentionUnderTest() || !(process.env.LLV_DOCKER_NSENTER_SHIMS === "1" || process.env.LLV_VIEWER_DEPLOY_TARGET))) return [];
  const docker = run ?? (async args => (await exec("docker", args, { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 })).stdout);
  let usage: string;
  try { usage = await docker(["system", "df", "--format", "{{.Type}}\t{{.Size}}"]); }
  catch { return []; }
  const rows: Row[] = [];
  for (const line of usage.trim().split("\n")) {
    const [type, size] = line.split("\t");
    if (type !== "Images" && type !== "Build Cache") continue;
    const bytes = dockerBytes(size ?? "");
    if (bytes !== undefined) rows.push({ kind: type === "Images" ? "dockerImages" : "dockerCache", bytes });
  }
  // The docker-container builder stores its records in a volume, outside
  // the daemon's Build Cache row. Older installs only have the default cache.
  try {
    const output = await docker(["buildx", "du", "--builder", releaseBuilderName(state)]);
    const allocated = dockerBytes(/^Total:\s*(\S+)\s*$/m.exec(output)?.[1] ?? "");
    if (allocated !== undefined) {
      const cache = rows.find(row => row.kind === "dockerCache");
      if (cache) cache.bytes += allocated;
      else rows.push({ kind: "dockerCache", bytes: allocated });
    }
  } catch { /* The install may predate the dedicated builder. */ }
  return rows;
}
