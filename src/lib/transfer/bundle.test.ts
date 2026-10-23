import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import zlib from "node:zlib";

import { generatePassphrase, isSealedBundle, sealBundle, TransferSealError, unsealBundle } from "../../../bin/transferSeal.mjs";
import { decodeBundle, encodeBundle, MAX_BUNDLE_BYTES, TransferBundleError } from "./bundle";

const HEADER = {
  exportId: "export-1",
  createdAt: "2026-10-22T00:00:00.000Z",
  product: "test",
  projects: [],
  accounts: [],
  environment: [],
  notices: [],
};

function sample() {
  return encodeBundle({
    ...HEADER,
    sections: [
      { name: "memory.role", schema: 1, summary: { scopes: 1 }, records: [{ k: "rows:role_memory|r:a", v: { kind: "rule", id: "a" } }, { k: "rows:role_memory|s:machine", v: { kind: "scope" } }] },
      { name: "settings.forge", schema: 1, summary: {}, records: [{ k: "set:forge|owner/name", v: "owner/name" }] },
    ],
  });
}

function lines(bytes: Buffer): string[] {
  return zlib.gunzipSync(bytes).toString("utf8").split("\n").filter(Boolean);
}

function regzip(text: string): Buffer {
  return zlib.gzipSync(Buffer.from(text, "utf8"));
}

/** A header and record lines framed again with a coherent total and trailer,
    so a test reaches the check it means and no earlier one. */
function reframe(header: Record<string, unknown>, records: string[]): Buffer {
  let total = 0;
  for (let pass = 0; pass < 4; pass += 1) {
    const body = `${JSON.stringify({ ...header, bytes: total })}\n${records.map(line => `${line}\n`).join("")}`;
    const next = Buffer.byteLength(body) + Buffer.byteLength(`${JSON.stringify({ end: true, records: records.length, sha256: "0".repeat(64) })}\n`);
    if (next === total) break;
    total = next;
  }
  const body = `${JSON.stringify({ ...header, bytes: total })}\n${records.map(line => `${line}\n`).join("")}`;
  return regzip(`${body}${JSON.stringify({ end: true, records: records.length, sha256: createHash("sha256").update(body).digest("hex") })}\n`);
}

async function refusal(bytes: Buffer): Promise<string> {
  try { await decodeBundle(bytes); }
  catch (error) { if (error instanceof TransferBundleError) return error.code; throw error; }
  throw new Error("decode accepted the bundle");
}

describe("transfer bundle format", () => {
  test("round-trips header, sections and records with their checksums", async () => {
    const bytes = sample();
    const decoded = await decodeBundle(bytes);
    expect(decoded.header.format).toBe("delegatus-transfer");
    expect(decoded.header.version).toBe(1);
    expect(decoded.header.sections.map(section => [section.name, section.records])).toEqual([["memory.role", 2], ["settings.forge", 1]]);
    expect(decoded.records.map(record => record.k)).toEqual(["rows:role_memory|r:a", "rows:role_memory|s:machine", "set:forge|owner/name"]);
    expect(decoded.sha256).toBe(createHash("sha256").update(zlib.gunzipSync(bytes)).digest("hex"));
    const all = lines(bytes);
    expect(JSON.parse(all.at(-1)!)).toMatchObject({ end: true, records: 3 });
  });

  test("refuses a record whose section checksum no longer matches", async () => {
    const all = lines(sample());
    all[1] = all[1]!.replace('"id":"a"', '"id":"b"');
    // Recompute the trailer so only the section hash disagrees.
    const body = `${all.slice(0, -1).join("\n")}\n`;
    const trailer = { end: true, records: 3, sha256: createHash("sha256").update(body).digest("hex") };
    expect(await refusal(regzip(`${body}${JSON.stringify(trailer)}\n`))).toBe("section_checksum");
  });

  test("refuses a bundle whose trailer hash does not cover its bytes", async () => {
    const all = lines(sample());
    const trailer = JSON.parse(all.at(-1)!);
    all[all.length - 1] = JSON.stringify({ ...trailer, sha256: "0".repeat(64) });
    expect(await refusal(regzip(`${all.join("\n")}\n`))).toBe("bundle_checksum");
  });

  test("refuses a bundle cut before its trailer", async () => {
    const all = lines(sample());
    expect(await refusal(regzip(`${all.slice(0, -1).join("\n")}\n`))).toBe("truncated");
  });

  test("refuses a declared total over the bound before reading records", async () => {
    const all = lines(sample());
    const header = JSON.parse(all[0]!);
    all[0] = JSON.stringify({ ...header, bytes: MAX_BUNDLE_BYTES + 1 });
    expect(await refusal(regzip(`${all.join("\n")}\n`))).toBe("too_large");
  });

  test("stops reading once decompressed bytes pass the declared total", async () => {
    const all = lines(sample());
    const header = JSON.parse(all[0]!);
    const padding = "x".repeat(4 * 1024 * 1024);
    // Same declared total, four extra mebibytes appended: the bomb ends at the bound.
    expect(await refusal(regzip(`${JSON.stringify(header)}\n${all.slice(1).join("\n")}\n${padding}`))).toBe("too_large");
  });

  test("refuses a record line longer than its section declared", async () => {
    const all = lines(sample());
    const header = JSON.parse(all[0]!);
    header.sections[1].bytes = 5;
    expect(await refusal(reframe(header, all.slice(1, -1)))).toBe("record_too_long");
    // The same framing with the true size decodes, so only the bound refused.
    header.sections[1].bytes = Buffer.byteLength(`${all[3]}\n`);
    expect((await decodeBundle(reframe(header, all.slice(1, -1)))).records).toHaveLength(3);
  });

  test("refuses bytes that are not a gzip bundle", async () => {
    expect(await refusal(Buffer.from("not a bundle"))).toBe("not_a_bundle");
  });
});

describe("sealed transfer", () => {
  const plain = Buffer.concat([sample(), Buffer.alloc(3 * 1024 * 1024, 7)]);

  test("seals in chunks and opens with the passphrase shown once", () => {
    const passphrase = generatePassphrase();
    expect(passphrase).toMatch(/^[A-Z2-9]{5}(-[A-Z2-9]{5}){5}$/);
    const sealed = sealBundle(plain, passphrase);
    expect(isSealedBundle(sealed)).toBe(true);
    expect(isSealedBundle(plain)).toBe(false);
    expect(sealed.includes(plain.subarray(0, 64))).toBe(false);
    expect(unsealBundle(sealed, passphrase.toLowerCase()).equals(plain)).toBe(true);
  });

  test("refuses a wrong passphrase, a dropped chunk and a cut tail", () => {
    const passphrase = generatePassphrase();
    const sealed = sealBundle(plain, passphrase);
    const code = (run: () => unknown) => { try { run(); } catch (error) { return (error as TransferSealError).code; } return "opened"; };
    expect(code(() => unsealBundle(sealed, generatePassphrase()))).toBe("wrong_passphrase_or_damaged");
    const headerEnd = sealed.indexOf(0x0a) + 1;
    const firstFrame = 33 + sealed.readUInt32BE(headerEnd + 1);
    const dropped = Buffer.concat([sealed.subarray(0, headerEnd), sealed.subarray(headerEnd + firstFrame)]);
    expect(code(() => unsealBundle(dropped, passphrase))).toBe("wrong_passphrase_or_damaged");
    const lastFrameStart = (() => { let offset = headerEnd; let start = offset; while (offset < sealed.length) { start = offset; offset += 33 + sealed.readUInt32BE(offset + 1); } return start; })();
    expect(code(() => unsealBundle(sealed.subarray(0, lastFrameStart), passphrase))).toBe("truncated");
    expect(code(() => unsealBundle(plain, passphrase))).toBe("not_sealed");
  });
});
