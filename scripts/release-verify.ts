/** Read-only release preflight and restartable publication verification. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
export interface ReleasePreflight {
  tag: string; version: string; localTag: boolean; remoteTag: boolean; npmVersion: boolean;
  files: string[]; provenance: boolean; clean: boolean;
}
export function releasePreflight(input: ReleasePreflight): string[] {
  const errors: string[] = [];
  if (!/^v\d+\.\d+\.\d+$/.test(input.tag) || input.tag !== `v${input.version}`) errors.push("tag/version mismatch");
  if (input.localTag || input.remoteTag) errors.push("tag already exists");
  if (input.npmVersion) errors.push("npm version already exists");
  if (!input.clean) errors.push("release head is dirty");
  if (!input.provenance) errors.push("README provenance does not match");
  if (input.files.some(f => !/^(CHANGELOG\.md|package\.json|bun\.lock|README\.md)$/.test(f) && !/^(patches|scripts|docs\/media\/readme)\//.test(f))) errors.push("diff includes product paths");
  return errors;
}
export interface PublishedRelease {
  version: string; npmVersion: string; latest: string; integrity: string;
  runs: (string | null)[]; images: { digest: string; platforms: string[] }[];
}
export function releasePublished(input: PublishedRelease): string[] {
  const errors: string[] = [];
  if (input.npmVersion !== input.version || input.latest !== input.version || !input.integrity) errors.push("npm version/latest/integrity not verified");
  if (input.runs.length !== 3 || input.runs.some(run => run !== "success")) errors.push("publication workflows not successful");
  if (input.images.length !== 3 || new Set(input.images.map(i => i.digest)).size !== 1 || input.images.some(i => !i.digest || !["linux/amd64", "linux/arm64"].every(p => i.platforms.includes(p)))) errors.push("Docker tags/digest/platforms not verified");
  return errors;
}
export function readmeProvenance(root: string): boolean {
  try {
    const base = path.join(root, "docs/media/readme");
    const p = JSON.parse(fs.readFileSync(path.join(base, "provenance.json"), "utf8"));
    const hash = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    if (p.schemaVersion !== 1 || p.classification !== "synthetic" || p.generator !== "scripts/capture-readme-media.ts" || p.seed !== "scripts/readme-demo-state.ts"
      || hash(path.join(root, p.generator)) !== p.generatorSha256 || hash(path.join(root, p.seed)) !== p.seedSha256) return false;
    const files = fs.readdirSync(base).filter(f => f.endsWith(".svg")).sort();
    if (!Array.isArray(p.assets) || files.length !== 8 || p.assets.length !== 8 || new Set(p.assets.map((a: { path: string }) => a.path)).size !== 8) return false;
    return p.assets.every((a: { path: string; sha256: string }) => files.includes(a.path) && hash(path.join(base, a.path)) === a.sha256);
  } catch { return false; }
}
export interface VerifyPorts {
  command: (file: string, args: string[]) => Promise<string>;
  registry: (url: string) => Promise<Record<string, unknown> | null>;
  provenance: () => boolean;
  now: () => number; wait: () => Promise<void>;
}
const productionPorts: VerifyPorts = {
  command: async (file, args) => (await promisify(execFile)(file, args, { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 })).stdout.trim(),
  registry: async url => {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error("npm registry read failed");
    return await response.json() as Record<string, unknown>;
  }, provenance: () => readmeProvenance(process.cwd()), now: Date.now, wait: () => new Promise(resolve => setTimeout(resolve, 30_000)),
};
interface WorkflowRun { databaseId: number; headSha: string; displayTitle: string; status: string; conclusion: string | null }
export async function verifyRelease(tag: string, cut: string | null, ports: VerifyPorts = productionPorts): Promise<string[]> {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error("expected a v-prefixed release version");
  const git = (...args: string[]) => ports.command("git", args);
  const pkg = JSON.parse(await git("show", "HEAD:package.json"));
  let registryURL = `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}`;
  const version = tag.slice(1);
  if (cut !== null) {
    if (!/^[a-f0-9]{40}$/i.test(cut)) throw new Error("cut must be an exact commit SHA");
    await git("merge-base", "--is-ancestor", cut, "HEAD");
    const local = await git("for-each-ref", "--format=%(refname)", `refs/tags/${tag}`);
    const remote = await git("ls-remote", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`);
    return releasePreflight({ tag, version: pkg.version, localTag: !!local, remoteTag: !!remote,
      npmVersion: !!await ports.registry(`${registryURL}/${version}`),
      files: (await git("diff", "--name-only", cut, "HEAD")).split("\n").filter(Boolean),
      clean: !(await git("status", "--porcelain")), provenance: ports.provenance() });
  }
  const sha = await git("rev-parse", `refs/tags/${tag}^{commit}`);
  const object = await git("rev-parse", `refs/tags/${tag}`);
  const type = await git("cat-file", "-t", `refs/tags/${tag}`);
  const remote = (await git("ls-remote", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`)).split("\n").map(line => line.split(/\s+/));
  if (type !== "tag" || !remote.some(([id, ref]) => id === object && ref === `refs/tags/${tag}`)
    || !remote.some(([id, ref]) => id === sha && ref === `refs/tags/${tag}^{}`)) return ["remote annotated tag differs from the local release"];
  const tagged = JSON.parse(await git("show", `${tag}:package.json`));
  if (tagged.version !== version) return ["tag/version mismatch"];
  registryURL = `https://registry.npmjs.org/${encodeURIComponent(tagged.name)}`;
  const repo = await ports.command("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
  const deadline = ports.now() + 90 * 60_000;
  let errors = ["publication not observed"];
  do {
    const runs: WorkflowRun[][] = [];
    for (const workflow of ["publish.yml", "docker-image.yml", "macos-newcomer.yml"]) runs.push(JSON.parse(await ports.command("gh", ["run", "list", "--workflow", workflow, "--limit", "100", "--json", "databaseId,headSha,displayTitle,status,conclusion"])));
    const npm = runs[0].find(r => r.headSha === sha || r.displayTitle === `Publish ${tag}`);
    const docker = runs[1].find(r => r.headSha === sha);
    const mac = runs[2].find(r => r.displayTitle === `macOS install after npm run ${npm?.databaseId}` || r.headSha === sha && r.status === "completed");
    const selected = [npm, docker, mac];
    const failed = selected.find(r => r?.status === "completed" && r.conclusion !== "success");
    if (failed) {
      const log = await ports.command("gh", ["run", "view", String(failed.databaseId), "--log-failed"]);
      return [`workflow failed: ${failed.databaseId}\n${log.slice(-2000)}`];
    }
    const manifest = await ports.registry(`${registryURL}/${version}`);
    const packument = await ports.registry(registryURL);
    const tags = packument?.["dist-tags"] as { latest?: string } | undefined;
    const images: PublishedRelease["images"] = [];
    if (selected.every(r => r?.conclusion === "success")) {
      for (const imageTag of [version, version.split(".").slice(0, 2).join("."), "latest"]) {
        const raw = await ports.command("docker", ["buildx", "imagetools", "inspect", `ghcr.io/${repo.toLowerCase()}:${imageTag}`, "--raw"]);
        const parsed = JSON.parse(raw);
        images.push({ digest: createHash("sha256").update(raw).digest("hex"), platforms: (parsed.manifests ?? []).map((m: { platform: { os: string; architecture: string } }) => `${m.platform.os}/${m.platform.architecture}`) });
      }
    }
    errors = releasePublished({ version, npmVersion: String(manifest?.version ?? ""), latest: String(tags?.latest ?? ""), integrity: String((manifest?.dist as { integrity?: string })?.integrity ?? ""), runs: selected.map(r => r?.conclusion ?? null), images });
    if (!errors.length) return [];
    if (ports.now() < deadline) await ports.wait();
  } while (ports.now() < deadline);
  return errors;
}
if (import.meta.main) {
  const args = process.argv.slice(2); const tag = args[args.indexOf("--tag") + 1];
  const cut = args.includes("--preflight") ? args[args.indexOf("--cut") + 1] : null;
  try {
    const errors = await verifyRelease(tag, cut);
    if (errors.length) { console.error(errors.join("\n")); process.exitCode = 1; }
    else console.log(cut ? "release preflight passed" : "npm, Docker and macOS installation verified");
  } catch (error) { console.error(error instanceof Error ? error.message : "release verification failed"); process.exitCode = 1; }
}
