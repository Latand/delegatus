import os from "node:os";
import { createHash } from "node:crypto";
import { githubRunner, type GithubRunner } from "@/lib/monitor/githubEvidence";

export type RepositorySetupFiles = Record<string, string>;
const manifests = new Set(["package.json", "Dockerfile", ".bun-version", ".node-version", ".nvmrc", ".tool-versions"]);
const locks = new Set(["bun.lock", "bun.lockb", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"]);
const exact = (value: unknown) => typeof value === "string" && value.length <= 64 ? /^(?:v|=)?(\d+\.\d+\.\d+)$/.exec(value.trim())?.[1] : undefined;
function dockerVersion(tool: "bun" | "node", tag: string): string | undefined {
  const match = /^(\d+\.\d+\.\d+)(?:-(.+))?$/.exec(tag);
  if (!match) return undefined;
  const suffix = match[2];
  if (!suffix) return match[1];
  const distribution = tool === "node"
    ? /^(?:alpine(?:\d+(?:\.\d+)?)?|slim|(?:slim-)?(?:bookworm|bullseye|trixie)(?:-slim)?)$/
    : /^(?:alpine|slim|debian)$/;
  return distribution.test(suffix) ? match[1] : undefined;
}
export const setupMarker = "# Delegatus repository setup v1";
const hash = (body: string) => createHash("sha256").update(body).digest("hex");
export function generatedRepositorySetup(script: string): boolean {
  const [marker, checksum, ...body] = script.split("\n");
  return marker === setupMarker && checksum === `# sha256:${hash(body.join("\n"))}`;
}

/** Read one immutable snapshot. Lockfiles need only presence, never their bodies.
 * No repository text is executed on the preparing machine. */
export async function readRepositorySetup(repository: string, ref: string, guard: () => void,
  run?: GithubRunner): Promise<RepositorySetupFiles> {
  const deadline = Date.now() + 20_000;
  const read = async (endpoint: string) => {
    guard(); const remaining = deadline - Date.now(); if (remaining <= 0) throw new Error("repository snapshot deadline exceeded");
    const value = JSON.parse(await (run ?? githubRunner(os.tmpdir(), remaining))(["api", endpoint]));
    guard(); if (Date.now() >= deadline) throw new Error("repository snapshot deadline exceeded"); return value;
  };
  const commit = await read(`repos/${repository}/commits/${encodeURIComponent(ref)}`);
  if (!/^[a-f0-9]{40}$/.test(commit.sha)) throw new Error("repository snapshot unavailable");
  const tree = await read(`repos/${repository}/git/trees/${commit.sha}`);
  if (tree.truncated || !Array.isArray(tree.tree) || tree.tree.length > 2000) throw new Error("repository snapshot incomplete");
  const files: RepositorySetupFiles = {};
  for (const entry of tree.tree) {
    if (!manifests.has(entry.path) && !locks.has(entry.path)) continue;
    if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode) || !/^[a-f0-9]{40}$/.test(entry.sha)) throw new Error("invalid setup file");
    if (locks.has(entry.path)) { files[entry.path] = ""; continue; }
    if (!Number.isSafeInteger(entry.size) || entry.size > 65536) throw new Error("setup file too large");
    const blob = await read(`repos/${repository}/git/blobs/${entry.sha}`);
    if (blob.encoding !== "base64" || typeof blob.content !== "string" || blob.content.length > 100000) throw new Error("invalid setup file");
    files[entry.path] = Buffer.from(blob.content, "base64").toString("utf8");
  }
  return files;
}

export function deriveRepositorySetup(files: RepositorySetupFiles): { installScript: string; reason: string | null; steps: string[] } {
  const pins = { bun: new Set<string>(), node: new Set<string>() };
  const needed = new Set<"bun" | "node">();
  const issues: string[] = [];
  const add = (tool: "bun" | "node", value: unknown) => { if (value !== undefined) needed.add(tool); const pin = exact(value); if (pin) pins[tool].add(pin); };
  let pkg: Record<string, unknown> = {};
  try { pkg = JSON.parse(files["package.json"] ?? "{}"); if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) throw new Error(); }
  catch { return { installScript: "", reason: "Repository package.json is invalid; setup cannot be derived", steps: [] }; }
  const engines = pkg.engines as Record<string, unknown> | undefined;
  const volta = pkg.volta as Record<string, unknown> | undefined;
  for (const tool of ["bun", "node"] as const) { add(tool, engines?.[tool]); add(tool, volta?.[tool]); }
  add("bun", files[".bun-version"]); add("node", files[".node-version"]); add("node", files[".nvmrc"]);
  for (const line of (files[".tool-versions"] ?? "").split(/\r?\n/)) {
    const match = /^\s*(bun|nodejs)\s+(\S+)/.exec(line); if (match) add(match[1] === "bun" ? "bun" : "node", match[2]);
  }
  const docker = files.Dockerfile ?? "";
  for (const match of docker.matchAll(/^\s*FROM\s+(?:--platform=\S+\s+)?(node|oven\/bun):([^\s@]+)/gim)) {
    const tool = match[1] === "node" ? "node" : "bun";
    const version = dockerVersion(tool, match[2]!);
    if (!version) issues.push("Dockerfile contains an unsupported or ambiguous runtime image tag");
    add(tool, version ?? match[2]);
  }
  for (const match of docker.matchAll(/^\s*RUN\s+npm\s+(?:install|i)\s+(?:--global|-g)\s+bun@(\d+\.\d+\.\d+)(?=\s|$)/gim)) add("bun", match[1]);
  const managerMatch = typeof pkg.packageManager === "string" && pkg.packageManager.length <= 256
    ? /^(bun|npm|pnpm|yarn)@(\d+\.\d+\.\d+)(?:\+sha\d+\.[a-f0-9]+)?$/.exec(pkg.packageManager) : null;
  const manager = managerMatch && exact(managerMatch[2]) ? managerMatch : null;
  if (manager?.[1] === "bun") add("bun", manager[2]);
  else if (manager) needed.add("node");
  const presentLocks = [...locks].filter(file => Object.hasOwn(files, file));
  if (presentLocks.some(file => file.startsWith("bun.lock"))) needed.add("bun");
  if (presentLocks.some(file => !file.startsWith("bun.lock"))) needed.add("node");
  if (pkg.packageManager !== undefined && !manager) issues.push("Repository declares no supported exact packageManager version pin");
  if (!needed.size) issues.push("Repository declares no exact Bun or Node toolchain pin");
  for (const tool of needed) {
    if (!pins[tool].size) issues.push(`Repository declares no exact ${tool === "bun" ? "Bun" : "Node"} version pin`);
    if (pins[tool].size > 1) issues.push(`Repository declares conflicting ${tool === "bun" ? "Bun" : "Node"} version pins`);
  }
  const steps: string[] = [];
  const lines = ["set -eu", "export PATH=/usr/local/bin:/usr/bin:/bin", "setup_tmp=$(mktemp -d)", "trap 'rm -rf \"$setup_tmp\"' EXIT", "cd \"$(git rev-parse --show-toplevel)\""];
  if (pins.node.size === 1) {
    const version = [...pins.node][0]!; steps.push(`Node ${version} on the system PATH`);
    lines.push('case "$(uname -m)" in x86_64) node_arch=x64 ;; aarch64|arm64) node_arch=arm64 ;; *) echo "Unsupported Node architecture" >&2; exit 1 ;; esac',
      `curl -fsSL "https://nodejs.org/dist/v${version}/node-v${version}-linux-$node_arch.tar.xz" -o "$setup_tmp/node.tar.xz"`,
      'tar -xJf "$setup_tmp/node.tar.xz" -C /usr/local --strip-components=1',
      `test "$(env -i PATH=/usr/local/bin:/usr/bin:/bin node --version)" = "v${version}"`);
  }
  if (pins.bun.size === 1) {
    const version = [...pins.bun][0]!; steps.push(`Bun ${version} on the system PATH`);
    lines.push('case "$(uname -m)" in x86_64) bun_arch=x64-baseline ;; aarch64|arm64) bun_arch=aarch64 ;; *) echo "Unsupported Bun architecture" >&2; exit 1 ;; esac',
      `curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${version}/bun-linux-$bun_arch.zip" -o "$setup_tmp/bun.zip"`,
      'unzip -q "$setup_tmp/bun.zip" -d "$setup_tmp"',
      'install -m 0755 "$setup_tmp/bun-linux-$bun_arch/bun" /usr/local/bin/bun',
      'ln -sf /usr/local/bin/bun /usr/local/bin/bunx',
      `test "$(env -i PATH=/usr/local/bin:/usr/bin:/bin bun --version)" = "${version}"`);
  }
  if (manager && manager[1] !== "bun") {
    const tool = manager[1]!, version = manager[2]!;
    // Modern Yarn publishes its standalone CLI under a different package.
    const distribution = tool === "yarn" && !version.startsWith("1.") ? "@yarnpkg/cli-dist" : tool;
    lines.push(`npm install --global --prefix /usr/local ${distribution}@${version}`,
      `test "$(env -i PATH=/usr/local/bin:/usr/bin:/bin ${tool} --version)" = "${version}"`);
    steps.push(`${tool} ${version} on the system PATH`);
  }
  const families = new Set(presentLocks.map(file => file.startsWith("bun.lock") ? "bun" : file === "pnpm-lock.yaml" ? "pnpm" : file === "yarn.lock" ? "yarn" : "npm"));
  if (families.size > 1) issues.push("Repository has conflicting package-manager lockfiles");
  else if (families.size) {
    const family = [...families][0]!;
    if (manager && manager[1] !== family) issues.push("Repository packageManager conflicts with its lockfile");
    if (family === "pnpm" || family === "yarn") {
      if (!manager || manager[1] !== family) issues.push(`Repository declares no exact ${family} packageManager pin`);
    }
    const command = family === "bun" ? "bun install --frozen-lockfile" : family === "npm" ? "npm ci" : family === "yarn" && manager?.[2]?.startsWith("1.") ? "yarn install --frozen-lockfile" : family === "yarn" ? "yarn install --immutable" : "pnpm install --frozen-lockfile";
    lines.push(command); steps.push(command);
  }
  const body = lines.join("\n") + "\n";
  return { installScript: `${setupMarker}\n# sha256:${hash(body)}\n${body}`, reason: issues.length ? issues.join("; ") : null, steps };
}
