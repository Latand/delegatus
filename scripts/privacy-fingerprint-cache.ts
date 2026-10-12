import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, resolve, sep } from "node:path";

const capacity = 1024;
const lifetime = 7 * 24 * 60 * 60 * 1000;
type NegativeRecord = { schema: 1; key: string; created: number; mac: string };

function safeAncestors(path: string): boolean {
  let current = parse(resolve(path)).root;
  for (const segment of resolve(path).slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) return false;
    } catch {
      return true;
    }
  }
  return true;
}

function privateFile(path: string, limit: number): Buffer {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > limit) {
      throw new Error("unsafe cache file");
    }
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/** Optional local Linux acceleration. Every refusal falls back to the real scanner. */
export function fingerprintNegativeCache(scannerSource: string, algorithmSource = "") {
  // Candidate jobs must never populate a cache a hosted trusted scan reads.
  if (process.env.CI !== undefined || process.platform !== "linux" || !process.getuid) return undefined;
  const root = resolve(process.env.LLV_PRIVACY_FINGERPRINT_CACHE_DIR
    ?? join(tmpdir(), `delegatus-privacy-fingerprints-${process.getuid()}`));
  let seal: Buffer;
  let implementation: string;
  try {
    if (!safeAncestors(root)) return undefined;
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) return undefined;
    const sealPath = join(root, "seal");
    try {
      writeFileSync(sealPath, randomBytes(32), { flag: "wx", mode: 0o600 });
    } catch {
      // A concurrent writer may have created the seal. Read and validate it.
    }
    seal = privateFile(sealPath, 32);
    if (seal.length !== 32) return undefined;
    implementation = createHash("sha256")
      .update(readFileSync(scannerSource)).update(readFileSync(import.meta.path))
      // Bind the loaded code too: a mutable checkout can change its files
      // after this process imported them and before it prepared the cache.
      .update(JSON.stringify([algorithmSource, fingerprintNegativeCache.toString(),
        privateFile.toString(), safeAncestors.toString(), capacity, lifetime]))
      .update(`${Bun.version}\0${Bun.revision}\0${process.platform}\0${process.arch}`).digest("hex");
  } catch {
    return undefined;
  }
  const payload = (record: Pick<NegativeRecord, "key" | "created">) => JSON.stringify([1, record.key, record.created]);
  const authenticate = (record: Pick<NegativeRecord, "key" | "created">) => createHmac("sha256", seal).update(payload(record)).digest("hex");
  function safeStore(): boolean {
    try {
      if (!safeAncestors(root)) return false;
      const stat = lstatSync(root);
      return stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.()
        && (stat.mode & 0o077) === 0 && privateFile(join(root, "seal"), 32).equals(seal);
    } catch {
      return false;
    }
  }
  const recordPath = (key: string) => join(root, `slot-${Number.parseInt(key.slice(0, 4), 16) % capacity}`);
  function readRecord(path: string, expectedKey?: string): NegativeRecord | undefined {
    try {
      const record = JSON.parse(privateFile(path, 1024).toString("utf8")) as NegativeRecord;
      if (Object.keys(record).sort().join(",") !== "created,key,mac,schema"
        || record.schema !== 1 || (expectedKey !== undefined && record.key !== expectedKey)
        || typeof record.key !== "string" || !/^[a-f0-9]{64}$/.test(record.key) || recordPath(record.key) !== path
        || !Number.isSafeInteger(record.created) || record.created < 0
        || typeof record.mac !== "string" || !/^[a-f0-9]{64}$/.test(record.mac)) return undefined;
      if (!timingSafeEqual(Buffer.from(record.mac, "hex"), Buffer.from(authenticate(record), "hex"))) return undefined;
      return record;
    } catch {
      return undefined;
    }
  }
  return {
    key(text: string, policy: string): string {
      // UTF-16LE preserves lone surrogates and window boundaries. UTF-8 alone
      // would let distinct source strings share replacement-character bytes.
      const hash = createHash("sha256").update(implementation).update("\0" + policy + "\0");
      for (let start = 0; start < text.length; start += 16_384) {
        hash.update(Buffer.from(text.slice(start, start + 16_384), "utf16le"));
      }
      return hash.digest("hex");
    },
    has(key: string): boolean {
      if (process.env.CI !== undefined || !/^[a-f0-9]{64}$/.test(key) || !safeStore()) return false;
      const record = readRecord(recordPath(key), key);
      const age = record ? Date.now() - record.created : -1;
      return age >= 0 && age <= lifetime;
    },
    add(key: string): void {
      if (process.env.CI !== undefined || !/^[a-f0-9]{64}$/.test(key) || !safeStore()) return;
      let temporary: string | undefined;
      try {
        const destination = recordPath(key);
        // Fixed slots bound storage even with concurrent writers. A collision
        // replaces an authenticated cache row; unknown files remain untouched.
        try {
          lstatSync(destination);
          if (!readRecord(destination)) return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
        }
        const record = { schema: 1 as const, key, created: Date.now(), mac: "" };
        record.mac = authenticate(record);
        temporary = join(root, `write-${randomBytes(12).toString("hex")}`);
        writeFileSync(temporary, JSON.stringify(record), { flag: "wx", mode: 0o600 });
        renameSync(temporary, destination);
        temporary = undefined;
      } catch {
        // Storage is optional; the caller has already completed the real scan.
      } finally {
        if (temporary) {
          try { unlinkSync(temporary); } catch { /* Only this invocation's temporary path. */ }
        }
      }
    },
  };
}
