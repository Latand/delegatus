import fs from "node:fs";
import path from "node:path";
import { artifactKey, releaseBuilderName, viewerCandidateContainerName } from "./deploymentArtifacts";
import { RECOGNIZED_DOCKER_NAMES } from "./dockerNames";

type Docker = (args: string[]) => Promise<string>;
export const DEFAULT_BUILD_CACHE_BYTES = 8 * 1024 ** 3;

export async function ensureReleaseBuilder(state: string, docker: Docker) {
  const name = releaseBuilderName(state);
  try { await docker(["buildx", "inspect", name]); }
  catch { await docker(["buildx", "create", "--name", name, "--driver", "docker-container"]); }
  return name;
}

/** Only a successful candidate reaches retain-only. Its local receipt binds
 * the destructive operations to the builder, build start and deployment. */
export async function retainReleaseDockerData(state: string, releases: readonly { image: string; container: string }[],
  docker: Docker, budget = process.env.LLV_RELEASE_BUILD_CACHE_BYTES, now = Date.now) {
  if (releases.length < 2) throw new Error("current and rollback releases are required");
  const directory = path.join(state, "deployments");
  const deployments = fs.readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory());
  const current = deployments.find(entry => viewerCandidateContainerName(entry.name) === releases[0]!.container);
  if (!current) return { state: "legacy-build", removed: 0 };
  const receiptFile = path.join(directory, current.name, "docker-build.json");
  if (!fs.existsSync(receiptFile)) return { state: "legacy-build", removed: 0 };
  const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
  const builder = releaseBuilderName(state);
  const started = receipt.startedAt;
  if (receipt.builder !== builder || receipt.image !== releases[0]!.image || !Number.isSafeInteger(started) || started <= 0 || started > now())
    throw new Error("invalid release build receipt");
  const bytes = budget === undefined ? DEFAULT_BUILD_CACHE_BYTES : Number(budget);
  if ((budget !== undefined && !/^\d+$/.test(budget)) || !Number.isSafeInteger(bytes) || bytes < 0)
    throw new Error("invalid release build cache budget");

  // Zero means remove all eligible cache. BuildKit treats a zero size limit
  // as unset. Use the age filter alone in that case.
  await docker(["buildx", "prune", "--builder", builder, "--force", "--all", "--filter",
    `until=${Math.ceil((now() - started) / 1000)}s`, ...(bytes ? ["--max-used-space", String(bytes)] : [])]);

  const retained = new Set(releases.map(release => release.image));
  const ids = (await docker(["image", "inspect", "--format", "{{.Id}}", ...retained])).trim().split(/\s+/);
  if (ids.length !== retained.size || ids.some(id => !/^sha256:[a-f0-9]{64}$/.test(id))) throw new Error("cannot identify retained images");
  const protectedIds = new Set(ids);
  const rows = await docker(["image", "ls", "--no-trunc", "--filter", `before=${releases[0]!.image}`,
    "--format", "{{.ID}} {{.Repository}}:{{.Tag}}"]);
  const keys = new Set(deployments.map(entry => artifactKey(viewerCandidateContainerName(entry.name))));
  let removed = 0;
  for (const row of rows.trim().split("\n")) {
    const [id, image] = row.split(" ");
    if (!image || !id || protectedIds.has(id) || retained.has(image)) continue;
    const match = /^([^:]+):deploy-[a-f0-9]{40}-([a-f0-9]{24})(?:-gate)?$/.exec(image);
    if (!match || !RECOGNIZED_DOCKER_NAMES.some(names => names.imageRepository === match[1]) || !keys.has(match[2])) continue;
    await docker(["image", "rm", image]);
    removed++;
  }
  return { state: "complete", removed, cacheBudgetBytes: bytes };
}
