import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const HEALTH_FILE = ".provider-auth-health";

export function providerCredentialChangedAt(home) {
  try {
    return Math.max(...[".provider-token", ".provider-runtime", ".provider-headers"].map((name) => {
      try { return fs.lstatSync(path.join(home, name)).ctimeMs; }
      catch (error) { if (error?.code === "ENOENT" && name === ".provider-headers") return 0; throw error; }
    }));
  } catch { return null; }
}

/** File identities change on credential repair and on every atomic runtime edit. */
export function providerCredentialRevision(home) {
  try {
    const identities = [".provider-token", ".provider-runtime", ".provider-headers"].map((name) => {
      const file = path.join(home, name);
      let stat;
      try { stat = fs.lstatSync(file, { bigint: true }); }
      catch (error) { if (error?.code === "ENOENT" && name === ".provider-headers") return "absent"; throw error; }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || (stat.mode & 0o777n) !== 0o600n) return null;
      return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String);
    });
    if (identities.includes(null)) return null;
    return crypto.createHash("sha256").update(JSON.stringify(identities)).digest("hex");
  } catch { return null; }
}

export function readProviderMessageHealth(home) {
  const revision = providerCredentialRevision(home);
  if (!revision) return null;
  try {
    const file = path.join(home, HEALTH_FILE);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > 512) return null;
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    return record?.version === 1 && record.revision === revision
      && ["error", "authenticated"].includes(record.state) && Number.isFinite(record.checkedAt)
      ? { state: record.state, checkedAt: record.checkedAt } : null;
  } catch { return null; }
}

/** Only Messages proves or disproves Messages auth; catalog reads never write here. */
export function recordProviderMessageHealth(home, revision, state) {
  if (!revision || !["error", "authenticated"].includes(state) || providerCredentialRevision(home) !== revision) return;
  const target = path.join(home, HEALTH_FILE);
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, revision, state, checkedAt: Date.now() }), { mode: 0o600, flag: "wx" });
    if (providerCredentialRevision(home) === revision) fs.renameSync(temporary, target);
  } finally { fs.rmSync(temporary, { force: true }); }
}
