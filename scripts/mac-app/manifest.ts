import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function bunArchives(platform = "darwin"): Record<"arm64" | "x86_64", string> {
  if (platform !== "darwin" && platform !== "linux") throw new Error(`Unsupported launcher platform: ${platform}`);
  return { arm64: `bun-${platform}-aarch64.zip`, x86_64: `bun-${platform}-x64-baseline.zip` };
}

export function digest(bytes: Uint8Array, algorithm: "sha256" | "sha512"): string {
  return createHash(algorithm).update(bytes).digest(algorithm === "sha256" ? "hex" : "base64");
}
export function verifiedBun(bytes: Uint8Array, sums: string, name: string): string {
  const expected = sums.split(/\r?\n/).map(line => /^([a-f0-9]{64})\s+\*?(.+)$/.exec(line)).find(row => row?.[2] === name)?.[1];
  if (!expected || digest(bytes, "sha256") !== expected) throw new Error(`Bun checksum mismatch: ${name}`);
  return expected;
}
export function validatePackage(value: unknown, version: string, revision: string, integrity?: string) {
  const entry = value as { name?: string; version?: string; gitHead?: string; dist?: { tarball?: string; integrity?: string } };
  if (entry?.name !== "delegatus-cli" || entry.version !== version || entry.gitHead !== revision
    || entry.dist?.tarball !== `https://registry.npmjs.org/delegatus-cli/-/delegatus-cli-${version}.tgz`
    || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.dist?.integrity ?? "")
    || (integrity && integrity !== entry.dist?.integrity)) throw new Error("Registry package identity or integrity differs from the release");
  return { version, tarball: entry.dist.tarball, integrity: entry.dist.integrity!, gitHead: revision };
}
async function download(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}
async function main() {
  const [mode, output, target] = process.argv.slice(2);
  if (!output || !["pr", "release"].includes(mode!)) throw new Error("Usage: manifest.ts pr|release OUTPUT [TARBALL]");
  const platform = process.env.LAUNCHER_PLATFORM ?? "darwin";
  const archives = bunArchives(platform);
  const { version } = JSON.parse(await readFile("package.json", "utf8"));
  const pin = (await readFile("Dockerfile", "utf8")).match(/^RUN npm install -g bun@([^\s]+)$/m)?.[1];
  if (!pin || !/^\d+\.\d+\.\d+$/.test(pin)) throw new Error("Dockerfile Bun pin unavailable");
  const base = `https://github.com/oven-sh/bun/releases/download/bun-v${pin}`;
  const sums = new TextDecoder().decode(await download(`${base}/SHASUMS256.txt`));
  const bun = { version: pin, arm64: {}, x86_64: {} };
  for (const arch of ["arm64", "x86_64"] as const) {
    const name = archives[arch];
    const bytes = await download(`${base}/${name}`);
    bun[arch] = { url: `${base}/${name}`, sha256: verifiedBun(bytes, sums, name), bytes: bytes.length };
  }
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  let delegatus;
  if (mode === "pr") {
    if (!target) throw new Error("PR build requires the checkout tarball");
    const bytes = await readFile(target);
    const packed = JSON.parse(execFileSync("tar", ["-xOf", target, "package/package.json"], { encoding: "utf8" }));
    if (packed.name !== "delegatus-cli" || packed.version !== version || packed.gitHead !== revision) throw new Error("Checkout tarball identity differs from this revision");
    delegatus = { version, tarball: "bundle:delegatus.tgz", integrity: `sha512-${digest(bytes, "sha512")}`, gitHead: revision, bytes: bytes.length };
  } else {
    let last: unknown;
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        const value = JSON.parse(new TextDecoder().decode(await download(`https://registry.npmjs.org/delegatus-cli/${version}`)));
        const entry = validatePackage(value, version, revision, process.env.EXPECTED_INTEGRITY);
        const bytes = await download(entry.tarball);
        if (`sha512-${digest(bytes, "sha512")}` !== entry.integrity) throw new Error("Registry tarball checksum mismatch");
        delegatus = { ...entry, bytes: bytes.length }; break;
      } catch (error) { last = error; if (attempt < 59) await new Promise(resolve => setTimeout(resolve, 10_000)); }
    }
    if (!delegatus) throw last;
  }
  await writeFile(output, JSON.stringify({ mode, platform, port: 8898, bun, delegatus }, null, 2) + "\n");
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
