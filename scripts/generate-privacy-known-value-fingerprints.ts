import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";

import { compactSensitiveText } from "../src/lib/privacy/staticDetectors";

function argumentValue(arguments_: string[], flag: string): string | undefined {
  const index = arguments_.indexOf(flag);
  if (index === -1) return undefined;
  const value = arguments_[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

export { compactSensitiveText };

export type KnownValue = { value: string; exactOnly?: boolean };
export type KnownValueFingerprint = { length: number; sha256: string; exactOnly?: boolean };

/** Legacy input has one label per line; JSON lines carry per-label policy. */
export function parseKnownValues(input: string, jsonLines = false): KnownValue[] {
  return input.split(/\r?\n/).map((line) => {
    const value = line.trim();
    if (!jsonLines || !value.startsWith("{")) return { value };
    const entry: unknown = JSON.parse(value);
    if (typeof entry !== "object" || entry === null
      || !("value" in entry) || typeof entry.value !== "string"
      || ("exactOnly" in entry && typeof entry.exactOnly !== "boolean")) {
      throw new Error("invalid known value");
    }
    return { value: entry.value.trim(), ...("exactOnly" in entry ? { exactOnly: entry.exactOnly as boolean } : {}) };
  });
}

export function knownValueFingerprint(entry: KnownValue): KnownValueFingerprint | undefined {
  const value = entry.exactOnly
    ? entry.value.normalize("NFKC").toLocaleLowerCase("en-US")
    : compactSensitiveText(entry.value);
  if (value.length < 4) return undefined;
  return { length: value.length, sha256: createHash("sha256").update(value).digest("hex"),
    ...(entry.exactOnly ? { exactOnly: true } : {}) };
}

export function fingerprintKey(entry: KnownValueFingerprint): string {
  return `${entry.exactOnly === true ? "exact" : "compact"}:${entry.length}:${entry.sha256}`;
}

function generateCatalog(): void {
  const arguments_ = process.argv.slice(2);
  const input = argumentValue(arguments_, "--input");
  const output = argumentValue(arguments_, "--output");
  if (!input || !output) {
    process.stdout.write("FINGERPRINT CATALOG: FAIL\nconfiguration_error: 1\n");
    process.exit(1);
  }

  try {
    const inputMetadata = lstatSync(input);
    if (inputMetadata.isSymbolicLink() || !inputMetadata.isFile()) throw new Error("unsafe input");
    if (existsSync(output)) {
      const outputMetadata = lstatSync(output);
      if (outputMetadata.isSymbolicLink() || !outputMetadata.isFile()) throw new Error("unsafe output");
    }
    const fingerprints = new Map<string, KnownValueFingerprint>();
    for (const entry of parseKnownValues(readFileSync(input, "utf8"), arguments_.includes("--json-lines"))) {
      const fingerprint = knownValueFingerprint(entry);
      if (fingerprint) fingerprints.set(fingerprintKey(fingerprint), fingerprint);
    }
    if (fingerprints.size === 0) throw new Error("empty catalog");
    const catalog = {
      schemaVersion: 1,
      normalization: "nfkc-lower-alnum-v1",
      scope: "operator-private-labels",
      fingerprints: [...fingerprints.values()].sort((left, right) =>
      left.length - right.length || left.sha256.localeCompare(right.sha256)
      || Number(left.exactOnly === true) - Number(right.exactOnly === true)),
    };
    writeFileSync(output, `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`FINGERPRINT CATALOG: PASS\nfingerprint_count: ${fingerprints.size}\n`);
  } catch {
    process.stdout.write("FINGERPRINT CATALOG: FAIL\nconfiguration_error: 1\n");
    process.exitCode = 1;
  }
}

if (import.meta.main) generateCatalog();
