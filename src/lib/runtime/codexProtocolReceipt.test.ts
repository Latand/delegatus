import { expect, test } from "bun:test";
import { normalizeCodexProtocolReceipt } from "./codexProtocolReceipt";

const base = { schemaVersion: "0.162.1", schemaDigest: "a".repeat(64), experimentalApi: true, models: [], anomalies: 0 };

test("an unpinned CLI admission is retained only in its validated shape", () => {
  const unpinnedCli = { cliVersion: "0.162.7", cliSchemaDigest: "b".repeat(64) };
  expect(normalizeCodexProtocolReceipt({ ...base, unpinnedCli })?.unpinnedCli).toEqual(unpinnedCli);
  expect(normalizeCodexProtocolReceipt({ ...base, unpinnedCli: null })).not.toHaveProperty("unpinnedCli");
  for (const malformed of [
    { cliVersion: "latest", cliSchemaDigest: "b".repeat(64) },
    { cliVersion: "0.162.7", cliSchemaDigest: "short" },
    { cliVersion: "0.162.7", cliSchemaDigest: "b".repeat(64), extra: "dropped" },
  ]) {
    const receipt = normalizeCodexProtocolReceipt({ ...base, unpinnedCli: malformed });
    if ("extra" in malformed) expect(receipt?.unpinnedCli).toEqual({ cliVersion: "0.162.7", cliSchemaDigest: "b".repeat(64) });
    else expect(receipt).not.toHaveProperty("unpinnedCli");
  }
});

test("the admission counts against the receipt's size budget", () => {
  const models = Array.from({ length: 64 }, (_, index) => ({ id: `model-${index}-${"x".repeat(150)}`, inputModalities: ["text"] }));
  const receipt = normalizeCodexProtocolReceipt({ ...base, models, unpinnedCli: { cliVersion: "0.162.7", cliSchemaDigest: "b".repeat(64) } })!;
  expect(receipt.unpinnedCli?.cliVersion).toBe("0.162.7");
  expect(receipt.modelsTruncated).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThanOrEqual(4064);
});
