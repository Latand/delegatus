import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const dependencySections = [
  "dependencies", "devDependencies", "optionalDependencies", "peerDependencies",
  "peerDependenciesMeta", "bundledDependencies", "bundleDependencies", "overrides", "resolutions",
];

export function requireMatchingLockfile(base: string, root = process.cwd()): void {
  const before = JSON.parse(execFileSync("git", ["show", `${base}:package.json`], { cwd: root, encoding: "utf8" }));
  // Hooks inspect the checkout, including edits that have not been committed yet.
  const after = JSON.parse(readFileSync(`${root}/package.json`, "utf8"));
  const changed = dependencySections.filter(section => JSON.stringify(before[section] ?? null) !== JSON.stringify(after[section] ?? null));
  if (changed.length === 0) return;
  const files = execFileSync("git", ["diff", "--name-only", "-z", base], { cwd: root, encoding: "utf8" }).split("\0");
  if (!files.includes("bun.lock")) throw new Error(`Dependency sections changed without bun.lock: ${changed.join(", ")}`);
}

export function requireFrozenInstall(root = process.cwd()): void {
  const result = spawnSync(process.execPath, ["install", "--frozen-lockfile", "--ignore-scripts", "--lockfile-only"], {
    cwd: root, stdio: "inherit", env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`bun install --frozen-lockfile failed (${result.status ?? result.signal})`);
}

export function auditArguments(allowlist: unknown, today = new Date().toISOString().slice(0, 10)): string[] {
  if (!Array.isArray(allowlist)) throw new Error("security/audit-allowlist.json must contain an array");
  const seen = new Set<string>();
  return allowlist.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw new Error(`Allowlist entry ${index} must be an object`);
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const reason = typeof entry.reason === "string" ? entry.reason.trim() : "";
    const expires = entry.expires;
    if (!/^(?:CVE-\d{4}-\d{4,}|GHSA-[a-z0-9]+(?:-[a-z0-9]+)+)$/i.test(id)) throw new Error(`Allowlist entry ${index} has an invalid advisory id`);
    if (!reason) throw new Error(`Allowlist entry ${index} must include a reason`);
    if (typeof expires !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(expires)) throw new Error(`Allowlist entry ${index} must include an ISO expiry date`);
    const parsed = new Date(`${expires}T00:00:00Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== expires) throw new Error(`Allowlist entry ${index} has an invalid expiry date`);
    if (expires < today) throw new Error(`Allowlist entry ${id} expired on ${expires}`);
    if (seen.has(id.toUpperCase())) throw new Error(`Duplicate allowlist entry for ${id}`);
    seen.add(id.toUpperCase());
    console.error(`Allowlisting ${id} through ${expires}: ${reason}`);
    return `--ignore=${id}`;
  });
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const baseIndex = args.indexOf("--base");
    const base = baseIndex === -1 ? undefined : args[baseIndex + 1];
    if (!args.includes("--audit-only")) {
      if (!base || base.startsWith("--")) throw new Error("--base is required for the lockfile check");
      requireFrozenInstall();
      requireMatchingLockfile(base);
    }
    if (!args.includes("--lockfile-only")) {
      const auditArgs = auditArguments(JSON.parse(readFileSync("security/audit-allowlist.json", "utf8")));
      const result = spawnSync("bash", ["scripts/audit-with-retry.sh", "--audit-level=high", ...auditArgs], { stdio: "inherit", env: process.env });
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
