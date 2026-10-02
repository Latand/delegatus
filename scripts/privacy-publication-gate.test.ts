import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

import { auditGithubPublication, shouldFailGithubAudit } from "./privacy-github-audit";
import { knownValueFingerprint } from "./generate-privacy-known-value-fingerprints";
import {
  commitMessageAddressReview,
  commitMessageFindings,
  formatPrivacyReport,
  mergeBoundaryReview,
  sensitiveClasses,
  TRUSTED_TELEGRAM_VENDOR_EXEMPT_FINDING_CLASSES,
  TRUSTED_TELEGRAM_VENDOR_ROOT_DIGEST,
  trustedVendorRootDigest,
  trustedVendorRootMatches,
} from "./privacy-publication-gate";

const gate = join(import.meta.dir, "privacy-publication-gate.ts");
const temporaryDirectories: string[] = [];
const packageVersionSamples = [
  ["pkg", "1.2.3"].join("@"),
  ["@scope/pkg", "1.2.3"].join("@"),
  ["delegatus", "1.9.0"].join("@"),
  ["fixture-package", "1.2.3"].join("@"),
  ["pkg", "1.2.3-beta.1"].join("@"),
  ["pkg", "1.2.3+sha"].join("@"),
  ["pkg", "1.2.3+sha.abc"].join("@"),
  ["pkg", "1.2"].join("@"),
  ["pkg", "1.2.3.4"].join("@"),
  ["pkg", "1.2.3-beta"].join("@"),
  ["pkg", "1.2.3-beta.rc"].join("@"),
  ["pkg", "1.2.3-beta.com"].join("@"),
  `Inspect \`${["pkg", "1.2.3"].join("@")}\`.`,
  `Inspect [${["pkg", "1.2.3+sha.abc"].join("@")}](https://fixture.invalid).`,
  `Encoded preface %41: \`${["pkg", "1.2.3"].join("@")}\`.`,
  ...[" ", "\t", "\r", "\n", "\v", "\f", '"', "'", "`", ")", "]", ",", ";", ":"]
    .map((boundary) => ["pkg", "1.2.3+sha.abc"].join("@") + boundary),
];
const versionLookingRealAddresses = [
  ...[".com", ".\u{1F130}.com", ".%F0%9F%84%B0.com", ".&#x1F130;.com"]
    .flatMap((suffix) => [
      `\`${["probe", "1.2.3"].join("@")}\`${suffix}`,
      `[${["probe", "1.2.3"].join("@")}](https://fixture.invalid)${suffix}`,
    ]),
  `\`${["pkg", "1.2.3"].join("@")}\` and ${["pkg", "1.2.3"].join("@")} . ${["probe", "1.2.3"].join("@")}\`.com`,
  `\`${["probe", "1.2.3+sha.abc"].join("@")}\`.com`,
  ...[".", "/", "!", "?", ">tail", "}", "=", "\\tail", "%20", "&#32;", "\u00A0", "\u200B", "💡"]
    .map((suffix) => ["probe", "1.2.3"].join("@") + suffix),
  ...["1.2.3.4.5", "1.2.3-beta.", "1.2.3+sha.", "1.2.3-beta%2E1", "1.2.3+sha&#46;abc", "1.2.3-beta.1+sha", "1.2.3-beta.rc.1+sha.2"]
    .map((domain) => ["probe", domain].join("@")),
  ["probe", "1.2.3"].join("%40"),
  ["probe", "1.2.3"].join("&#64;"),
  ["a", "1.2.3.com"].join("@"),
  ["probe", "1.2.3\u{1F130}.com"].join("@"),
  ["probe", "1.2.3%F0%9F%84%B0.com"].join("@"),
  ["probe", "1.2.3&#x1F130;.com"].join("@"),
  ["probe", "1.2.3.\u{1F130}.com"].join("@"),
  ["probe", "1.2.3.%F0%9F%84%B0.com"].join("@"),
  ["probe", "1.2.3.&#x1F130;.com"].join("@"),
  ["probe", "1.2.3.\u0F0B\u0F40.com"].join("@"),
  ["probe", "1.2.3.%E0%BC%8B%E0%BD%80.com"].join("@"),
  ["probe", "1.2.3.&#xF0B;&#xF40;.com"].join("@"),
  ["someone", "b.io"].join("@"),
  ...["com", "target", "укр", "xn--j1amh"].map((tld) => ["a", `1.2.3.${tld}`].join("@")),
  ["a", "1.2.3-beta.укр"].join("@"),
  [JSON.stringify(["someone", "b.io"].join("@")), "1.2.3"].join("@"),
  ...["\u200B", "\u0375α", "・カ", "१२३"].map((label) => ["a", `1.2.3.${label}.com`].join("@")),
];
const systemdUnitSamples = [
  ["user", "1000.service"].join("@"),
  ["delegatus", "review.service"].join("@"),
  `0::/user.slice/user-1000.slice/${["user", "1000.service"].join("@")}/app.slice/delegatus.service`,
  ["delegatus", String.raw`review\x2dworker.service`].join("@"),
  [String.raw`delegatus\x2dworker`, "review.service"].join("@"),
  ...["service", "socket", "scope", "slice", "timer", "mount", "automount", "path", "device", "swap"]
    .map((type) => ["delegatus", `review.${type}`].join("@")),
  ["delegatus", "review.SERVICE"].join("@"),
  `Inspect \`${["delegatus", "review.service"].join("@")}\`.`,
  `Inspect [${["delegatus", "review.service"].join("@")}](https://fixture.invalid).`,
  ...[" ", "\t", "\r", "\n", "\v", "\f", "/", '"', "'", "`", ")", "]", ",", ";", ":"]
    .map((boundary) => ["delegatus", "review.service"].join("@") + boundary),
];
const unitLookingRealAddresses = [
  ["probe", "b.service", "1.2.3"].join("@"),
  ["probe", "b.service", "1.2.3+sha.abc"].join("@"),
  [JSON.stringify(["probe", "personal.dev"].join("@")), "review.service"].join("@"),
  [JSON.stringify(["probe", "personal.dev"].join("@")), "review.service/"].join("@"),
  ["probe", "b**.service**%E2%80%8B"].join("%40"),
  ["probe", "b**.service**\u200B"].join("@"),
  ["probe", "b**.service**%00"].join("%40"),
  ["probe", "b.service&#x200B;"].join("&#64;"),
  ["probe", "b.service%E2%80%8B"].join("%40"),
  ["probe", "b&#46;service\u200B"].join("@"),
  ["probe", "b.service%25E2%2580%258B"].join("%2540"),
  ["probe", "b.service%00"].join("%40"),
  ["probe", "b\u200B.service"].join("@"),
  ["probe", "b.service\u200C"].join("@"),
  ["probe", "b.service\u04C0"].join("@"),
  `\`${["probe", "b.service"].join("@")}\`.com`,
  `\`${["probe", "b.service"].join("@")}\`.\u0375α.com`,
  `\`${["probe", "b.service"].join("@")}\`.💡.com`,
  "`" + ["probe", "b.service"].join("@") + "` and " + ["probe", "b.service"].join("@") + ".",
  ...["FEFF", "AD", "2060"].map((code) => ["probe", `b.service&#x${code};`].join("&#64;")),
  ["probe", "͵α.com"].join("@"),
  ["probe", "・カ.com"].join("@"),
  ...[".", "-", "+", "!", "?", ">tail", "}", "=", "\\tail", "α", "\u0301", "\u0375", "\u30FB", "\u200B", "\u00A0", "）", "／", "💡"]
    .map((suffix) => ["probe", `b.service${suffix}`].join("@")),
  ["probe", "a.b.service"].join("@"),
  ["probe", "b。service"].join("@"),
  ["probe", "b.ｓｅｒｖｉｃｅ"].join("@"),
  ["probe", String.raw`b\x2dworker.service+`].join("@"),
  ["someone", "company.services"].join("@"),
  ["probe", "b.target"].join("@"),
  ["a", "b.com"].join("@"),
  ["delegatus", "review.service.com"].join("@"),
  ["delegatus", "review.service.dev"].join("@"),
  ["delegatus", "review.services"].join("@"),
  ["delegatus", "review.serviceevil"].join("@"),
  ["someone", "b.service.TaRgEt"].join("@"),
  ["probe", "b.service.१२३.com"].join("@"),
  ["probe", "b.service.๐๑๒.com"].join("@"),
  ["probe", "b.service.１２３.com"].join("@"),
  ["probe", "b.service.xn--e4bcd.com"].join("@"),
  ["probe", "b.service.xn--b5ccd.com"].join("@"),
  ["probe", "b.service。com"].join("@"),
  ["probe", "b.service．com"].join("@"),
  ["probe", "b.service｡com"].join("@"),
  ["probe", "b.service.͵α.com"].join("@"),
  ["probe", "b.service.・カ.com"].join("@"),
  ["probe", "b.service.xn--wva4j.com"].join("@"),
  ["probe", "b.service.xn--lckxi.com"].join("@"),
  ["someone", "b.SeRvIcE.укр"].join("@"),
  ["probe", "b.service.xn--j1amh"].join("@"),
  ["probe", "b.SeRvIcE.XN--J1aMh"].join("@"),
  ["probe", "b.service.xn--p1ai"].join("@"),
  ["probe", "b.service.xn--j1amh.com"].join("@"),
];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function crc32(input: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function syntheticFineGrainedPat(): string {
  return `${[["git", "hub"].join(""), "pat"].join("_")}_${"A".repeat(82)}`;
}

function liveCapturePng(): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("tEXt", Buffer.from("capture-source\0live-runtime", "latin1")),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 255, 255, 255]))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function compressedLiveCapturePng(type: "iTXt" | "zTXt"): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk(type, Buffer.concat([
      Buffer.from(type === "zTXt" ? "capture-source\0\0" : "capture-source\0\x01\x00\0\0", "latin1"),
      deflateSync(Buffer.from("live-runtime", "latin1")),
    ])),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 255, 255, 255]))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function animatedPng(): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  const animation = Buffer.alloc(8);
  animation.writeUInt32BE(2, 0);
  const frameControl = (sequence: number) => {
    const control = Buffer.alloc(26);
    control.writeUInt32BE(sequence, 0);
    control.writeUInt32BE(1, 4);
    control.writeUInt32BE(1, 8);
    control.writeUInt16BE(1, 20);
    control.writeUInt16BE(10, 22);
    return control;
  };
  const secondFrame = Buffer.alloc(4);
  secondFrame.writeUInt32BE(2);
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("acTL", animation),
    pngChunk("fcTL", frameControl(0)),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 245, 247, 250]))),
    pngChunk("fcTL", frameControl(1)),
    pngChunk("fdAT", Buffer.concat([secondFrame, deflateSync(Buffer.from([0, 255, 255, 255]))])),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function redactedPlaceholderPng(): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("tEXt", Buffer.from("capture-source\0redacted-placeholder", "latin1")),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 245, 247, 250]))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngWithMetadata(value: string): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("tEXt", Buffer.from(`comment\0${value}`, "latin1")),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 245, 247, 250]))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngWithCustomMetadata(type: "eXIf" | "iCCP" | "iTXt" | "zTXt", value: string): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  let metadata: Buffer;
  if (type === "zTXt") {
    metadata = Buffer.concat([Buffer.from("comment\0\0", "latin1"), deflateSync(Buffer.from(value, "utf8"))]);
  } else if (type === "iCCP") {
    metadata = Buffer.concat([Buffer.from("synthetic-profile\0\0", "latin1"), deflateSync(Buffer.from(value, "utf8"))]);
  } else if (type === "iTXt") {
    metadata = Buffer.concat([
      Buffer.from("comment\0\x01\x00\0\0", "latin1"),
      deflateSync(Buffer.from(value, "utf8")),
    ]);
  } else {
    metadata = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), Buffer.from(value, "utf8")]);
  }
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk(type, metadata),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 245, 247, 250]))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngWithTrailingPayload(value: string): Buffer {
  return Buffer.concat([redactedPlaceholderPng(), Buffer.from(value, "utf8")]);
}

function oddAlignedUtf16(value: string, byteOrder: "be" | "le"): Buffer {
  const encoded = Buffer.from(value, "utf16le");
  if (byteOrder === "be") encoded.swap16();
  return Buffer.concat([Buffer.from([0x7f]), encoded]);
}

function pngWithExifBytes(data: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("eXIf", data),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 245, 247, 250]))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function writeValidProvenance(directory: string, name: string, contents: Buffer): void {
  const generator = Buffer.from([
    'export const PRIVACY_GENERATOR_RUNTIME = "1.3.3";',
    'export const PRIVACY_GENERATOR_VERSION = "fixture-generator-v2";',
    "",
  ].join("\n"));
  writeFileSync(join(directory, "generate-placeholder.mjs"), generator);
  writeFileSync(join(directory, "privacy-manifest.json"), JSON.stringify({
    schemaVersion: 2,
    assets: [{
      path: name,
      classification: "redacted-placeholder",
      source: "redacted-live-capture",
      generator: "generate-placeholder.mjs",
      generatorRuntime: "bun-1.3.3",
      generatorVersion: "fixture-generator-v2",
      generatorSha256: createHash("sha256").update(generator).digest("hex"),
      sourceDigests: [createHash("sha256").update(`fixture-source:${name}`).digest("hex")],
      description: "Synthetic redacted placeholder used by the privacy gate test.",
      sha256: createHash("sha256").update(contents).digest("hex"),
    }],
  }));
}

function installTool(directory: string, name: string, body = "exit 0"): Record<string, string> {
  const executable = join(directory, name);
  writeFileSync(executable, `#!/bin/sh\n${body}\n`);
  chmodSync(executable, 0o755);
  return { PATH: `${directory}:${process.env.PATH ?? ""}` };
}

function runGateArguments(arguments_: string[], environment: Record<string, string> = {}, cwd = join(import.meta.dir, "..")) {
  return Bun.spawnSync({
    cmd: [process.execPath, gate, ...arguments_],
    cwd,
    env: { ...process.env, ...environment, NO_COLOR: "1" },
    stderr: "pipe",
    stdout: "pipe",
  });
}


function runGate(paths: string[], environment: Record<string, string> = {}) {
  return runGateArguments(["--paths", ...paths], environment);
}

test("prepared text keeps known-value configurations independent", async () => {
  const environment = {
    LLV_PRIVACY_KNOWN_VALUES: "", LLV_PRIVACY_KNOWN_VALUES_FILE: "",
    LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE: "", LLV_PRIVACY_KNOWN_VALUES_FORMAT: "plain",
  };
  const saved = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  const texts = ["freshwater", "x".repeat(100_000) + " freshwater"];
  const staticFindingText = ["pass", "word"].join("") + '="shared classifier cache credential"';
  try {
    for (const [index, value] of ["freshwater", "saltwater", "freshwater"].entries()) {
      Object.assign(process.env, environment, { LLV_PRIVACY_KNOWN_VALUES: value });
      const modulePath = `${gate}?independent-preparation=${index}`;
      const scanner: typeof import("./privacy-publication-gate") = await import(modulePath);
      for (const text of texts) expect(scanner.sensitiveClasses(text).has("known_value")).toBe(value === "freshwater");
      expect(scanner.sensitiveClasses(staticFindingText).has("credential")).toBe(true);
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

function runGit(directory: string, arguments_: string[]): void {
  const result = Bun.spawnSync({ cmd: ["git", ...arguments_], cwd: directory, stderr: "pipe", stdout: "pipe" });
  expect(result.exitCode).toBe(0);
}

function generatePrivacyPlaceholders(repositoryRoot: string) {
  const scriptsDirectory = join(repositoryRoot, "scripts");
  mkdirSync(scriptsDirectory, { recursive: true });
  writeFileSync(
    join(scriptsDirectory, "generate-privacy-placeholders.ts"),
    readFileSync(join(import.meta.dir, "generate-privacy-placeholders.ts")),
  );
  return Bun.spawnSync({
    cmd: [process.execPath, join(scriptsDirectory, "generate-privacy-placeholders.ts")],
    cwd: repositoryRoot,
    stderr: "pipe",
    stdout: "pipe",
  });
}

function writeFingerprintCatalog(path: string, value: string): void {
  const compact = value.normalize("NFKC").toLocaleLowerCase("en-US").replaceAll(/[^\p{L}\p{N}]/gu, "");
  writeFileSync(path, JSON.stringify({
    schemaVersion: 1,
    normalization: "nfkc-lower-alnum-v1",
    fingerprints: [{
      length: compact.length,
      sha256: createHash("sha256").update(compact).digest("hex"),
    }],
  }));
}

const FIXED_VENDOR_FIXTURE_DIGEST = "6f86679e7321bb68b4a370cc5c419e0a593568c45982e63887ef82232cc70342";
const FIXED_EXECUTABLE_VENDOR_FIXTURE_DIGEST = "e4a542b697441803c4bc2f48f02158758fd7d853345474e6d7d2babd561fc051";

function fileNotice(path: string, finding: string, line?: number): string {
  const digest = createHash("sha256").update(path).digest("hex");
  return `file-sha256:${digest}${line === undefined ? "" : `:${line}`} ${finding}`;
}

function createVendorDigestFixture(): { manifest: string; readme: string; root: string; runtime: string } {
  const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-vendor-root-"));
  temporaryDirectories.push(directory);
  const root = join(directory, "vendor", "fixture-connector");
  const runtime = join(root, "nested", "runtime.py");
  const readme = join(root, "README.md");
  const manifest = join(root, "SHA256SUMS");
  mkdirSync(join(root, "nested"), { recursive: true });
  writeFileSync(readme, "alpha\n");
  writeFileSync(manifest, "fixture manifest\n");
  writeFileSync(runtime, "bravo\n");
  return { manifest, readme, root, runtime };
}

describe("privacy publication gate", () => {
  test("the real gate reports fingerprint-only file findings with safe file and line attribution", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-attribution-"));
    temporaryDirectories.push(directory);
    const findingValue = "known-test-fingerprint-private-value";
    const file = "src/shared-fixture.ts";
    mkdirSync(join(directory, "src"), { recursive: true });
    writeFileSync(join(directory, file), `export const sample = "${findingValue}";\n`);
    const catalog = join(directory, "fingerprints.json");
    writeFingerprintCatalog(catalog, findingValue);
    const result = runGateArguments(["--repository", directory, "--paths", file], {
      LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE: catalog,
      LLV_PRIVACY_KNOWN_VALUES: "",
    }, directory);
    const output = result.stdout.toString();
    expect(result.exitCode).toBe(1);
    expect(output).toContain("PRIVACY GATE: FAIL\nknown_value: 1\n");
    expect(output).toContain(fileNotice(file, "known_value", 1));
    expect(output).not.toContain(findingValue);
  });

  test("file attribution withholds fingerprint, email, and credential values embedded in filenames", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-filename-"));
    temporaryDirectories.push(directory);
    const email = [["fixture", "person"].join("-"), ["internal", "local"].join(".")].join("@");
    const credential = `${String.fromCharCode(33, 35, 36, 64)}syntheticfixture123456`;
    const credentialKey = ["pass", "word"].join("");
    const cases = [
      { finding: "known_value", value: "filename-fingerprint-private-value", path: "known-filename-fingerprint-private-value.ts" },
      { finding: "email_address", value: email, path: `email-${email}.txt` },
      { finding: "credential", value: credential, path: `password-${credential}.md` },
    ];
    const catalog = join(directory, "fingerprints.json");
    writeFingerprintCatalog(catalog, cases[0]!.value);

    for (const item of cases) {
      const body = item.finding === "credential" ? `${credentialKey}=${JSON.stringify(item.value)}\n` : `${item.value}\n`;
      writeFileSync(join(directory, item.path), body);
      const result = runGateArguments(["--repository", directory, "--paths", item.path], {
        LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE: catalog,
        LLV_PRIVACY_KNOWN_VALUES: "",
      }, directory);
      const output = result.stdout.toString();

      expect(result.exitCode).toBe(1);
      expect(output).toContain(`${item.finding}: 1\n`);
      expect(output).toContain(fileNotice(item.path, item.finding, 1));
      expect(output).not.toContain(item.value);
      expect(result.stderr.toString()).not.toContain(item.value);
    }
  });

  test("publication children exclude unapproved ambient API keys", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-ambient-"));
    temporaryDirectories.push(directory);
    runGit(directory, ["init", "--quiet"]);
    runGit(directory, ["config", "user.email", "fixture.invalid"]);
    runGit(directory, ["config", "user.name", "Fixture"]);
    writeFileSync(join(directory, "README.md"), "synthetic public fixture\n");
    runGit(directory, ["add", "README.md"]);
    runGit(directory, ["commit", "--quiet", "-m", "fixture"]);

    const credentialName = "EXAMPLE_PLUGIN_API_KEY";
    const credentialPlaceholder = ["ambient", "public", "fixture"].join("-");
    const bin = join(directory, "bin");
    mkdirSync(bin);
    const realGit = Bun.which("git");
    if (!realGit) throw new Error("Git fixture executable is unavailable");
    const git = join(bin, "git");
    writeFileSync(git, `#!/bin/sh
credential_name=EXAMPLE_PLUGIN_API_KEY
if env | grep -q "^\${credential_name}="; then exit 97; fi
exec "$LLV_TEST_REAL_GIT" "$@"
`);
    chmodSync(git, 0o755);

    const result = runGateArguments(["--base", "HEAD"], {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      LLV_TEST_REAL_GIT: realGit,
      [credentialName]: credentialPlaceholder,
    }, directory);
    const publicEvidence = `${result.stdout.toString()}${result.stderr.toString()}`;

    expect(publicEvidence).not.toContain(credentialName);
    expect(publicEvidence).not.toContain(credentialPlaceholder);
    expect(result.exitCode).toBe(0);
  });

  test("blocks an unsafe live raster without provenance using redacted diagnostics", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const image = join(directory, "capture.png");
    writeFileSync(image, liveCapturePng());

    const result = runGate([image], installTool(directory, "tesseract"));
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe([
      "PRIVACY GATE: FAIL",
      "media_live_source: 1",
      "provenance_missing: 1",
      "",
    ].join("\n"));
    expect(output).not.toContain("live-runtime");
    expect(output).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  for (const metadataType of ["zTXt", "iTXt"] as const) {
    test(`detects live-source metadata inside compressed PNG ${metadataType}`, () => {
      const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
      temporaryDirectories.push(directory);
      const image = join(directory, "capture.png");
      writeFileSync(image, compressedLiveCapturePng(metadataType));

      const result = runGate([image], installTool(directory, "tesseract"));
      const output = result.stdout.toString();

      expect(result.exitCode).toBe(1);
      expect(output).toBe([
        "PRIVACY GATE: FAIL",
        "media_live_source: 1",
        "provenance_missing: 1",
        "",
      ].join("\n"));
      expect(output).not.toContain("live-runtime");
      expect(output).not.toContain(directory);
      expect(result.stderr.toString()).toBe("");
    });
  }

  test("fails closed for animated PNG publication input", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const image = join(directory, "capture.png");
    const contents = animatedPng();
    writeFileSync(image, contents);
    writeValidProvenance(directory, "capture.png", contents);

    const result = runGate([image], installTool(directory, "tesseract"));
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe("PRIVACY GATE: FAIL\ninspection_error: 1\nprovenance_invalid: 1\n");
    expect(output).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("rejects provenance that does not declare the published raster", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const image = join(directory, "capture.png");
    writeFileSync(image, redactedPlaceholderPng());
    writeFileSync(join(directory, "privacy-manifest.json"), JSON.stringify({ schemaVersion: 1, assets: [] }));

    const result = runGate([image], installTool(directory, "tesseract"));

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("PRIVACY GATE: FAIL\nprovenance_invalid: 1\n");
    expect(result.stderr.toString()).toBe("");
  });

  test("rejects output-only provenance without source and generator bindings", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const image = join(directory, "capture.png");
    const contents = redactedPlaceholderPng();
    writeFileSync(image, contents);
    writeFileSync(join(directory, "generate-placeholder.mjs"), "// Legacy generator without a version binding.\n");
    writeFileSync(join(directory, "privacy-manifest.json"), JSON.stringify({
      schemaVersion: 1,
      assets: [{
        path: "capture.png",
        classification: "redacted-placeholder",
        source: "redacted-live-capture",
        generator: "generate-placeholder.mjs",
        description: "Legacy output-only provenance fixture for the privacy gate test.",
        sha256: createHash("sha256").update(contents).digest("hex"),
      }],
    }));

    const result = runGate([image], installTool(directory, "tesseract"));

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("PRIVACY GATE: FAIL\nprovenance_invalid: 1\n");
    expect(result.stderr.toString()).toBe("");
  });

  test("regenerates source-bound placeholders deterministically", () => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), "llv-privacy-generator-"));
    temporaryDirectories.push(repositoryRoot);
    const image = join(repositoryRoot, "docs", "acceptance", "issue-290", "readiness-kanban.png");
    const manifestPath = join(repositoryRoot, "docs", "acceptance", "issue-290", "privacy-manifest.json");

    const first = generatePrivacyPlaceholders(repositoryRoot);
    const firstImageDigest = createHash("sha256").update(readFileSync(image)).digest("hex");
    const firstManifestDigest = createHash("sha256").update(readFileSync(manifestPath)).digest("hex");
    const second = generatePrivacyPlaceholders(repositoryRoot);
    const secondImageDigest = createHash("sha256").update(readFileSync(image)).digest("hex");
    const secondManifestDigest = createHash("sha256").update(readFileSync(manifestPath)).digest("hex");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      assets?: Array<Record<string, unknown>>;
      schemaVersion?: unknown;
    };

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(first.stderr.toString()).toBe("");
    expect(second.stderr.toString()).toBe("");
    expect(firstImageDigest).toBe(secondImageDigest);
    expect(firstManifestDigest).toBe(secondManifestDigest);
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.assets?.[0]?.generatorRuntime).toBe("bun-1.3.3");
    expect(manifest.assets?.[0]?.generatorVersion).toBe("privacy-placeholders-v2");
    expect(manifest.assets?.[0]?.generatorSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.assets?.[0]?.sourceDigests).toEqual([expect.stringMatching(/^[a-f0-9]{64}$/)]);
  });

  test("accepts media reproduced by the trusted source-bound generator", () => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), "llv-privacy-candidate-"));
    temporaryDirectories.push(repositoryRoot);
    const image = join(repositoryRoot, "docs", "acceptance", "issue-290", "readiness-kanban.png");
    const generation = generatePrivacyPlaceholders(repositoryRoot);

    const result = runGateArguments(
      ["--repository", repositoryRoot, "--paths", image],
      installTool(repositoryRoot, "tesseract"),
    );

    expect(generation.exitCode).toBe(0);
    expect(generation.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("PRIVACY GATE: PASS\n");
    expect(result.stderr.toString()).toBe("");
  });

  test("detects private text in raster pixels without echoing OCR content", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const image = join(directory, "capture.png");
    const contents = redactedPlaceholderPng();
    writeFileSync(image, contents);
    writeValidProvenance(directory, "capture.png", contents);
    const syntheticHome = ["", "home", "fixture-operator", "private"].join("/");

    const result = runGate([image], installTool(directory, "tesseract", `printf '%s\\n' '${syntheticHome}'`));
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe("PRIVACY GATE: FAIL\nhome_path: 1\nprovenance_invalid: 1\n");
    expect(output).not.toContain(syntheticHome);
    expect(output).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("scans changed text for private paths, addresses, and credential shapes", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const text = join(directory, "release-notes.md");
    const syntheticHome = ["", "home", "fixture-person", "records"].join("/");
    const syntheticAddress = ["fixture-person", "internal.local"].join("@");
    const syntheticCredential = ["api", "token"].join("_") + "=synthetic-test-value-1234567890";
    writeFileSync(text, [syntheticHome, syntheticAddress, syntheticCredential].join("\n"));

    const result = runGate([text]);
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe([
      "PRIVACY GATE: FAIL",
      "credential: 1",
      "email_address: 1",
      "home_path: 1",
      "",
    ].join("\n"));
    expect(output).not.toContain(syntheticHome);
    expect(output).not.toContain(syntheticAddress);
    expect(output).not.toContain(syntheticCredential);
    expect(output).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("scans changed text for a quoted mailbox", () => {
    /* `"fixture person"@host` is a mailbox RFC 5322 spells with quotes around
       the local part, and it reaches whoever the plain form would. */
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-quoted-"));
    temporaryDirectories.push(directory);
    const text = join(directory, "release-notes.md");
    const quotedAddress = ['"fixture person"', "internal.local"].join("@");
    writeFileSync(text, `Reported by ${quotedAddress}.\n`);

    const result = runGate([text]);
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe("PRIVACY GATE: FAIL\nemail_address: 1\n");
    expect(output).not.toContain(quotedAddress);
    expect(result.stderr.toString()).toBe("");
  });

  test("systemd unit names pass text publication inspection", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-systemd-"));
    temporaryDirectories.push(directory);
    const text = join(directory, "units.md");
    writeFileSync(text, systemdUnitSamples.join("\n"));

    const result = runGate([text]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("PRIVACY GATE: PASS\n");
    expect(result.stderr.toString()).toBe("");
  });

  test("systemd boundaries reject every unlisted ASCII character and representative Unicode characters", () => {
    const permitted = new Set([" ", "\t", "\r", "\n", "\v", "\f", "/", '"', "'", "`", ")", "]", ",", ";", ":"]);
    const boundaries = Array.from({ length: 128 }, (_, code) => String.fromCharCode(code));
    boundaries.push("α", "\u0301", "\u0375", "\u30FB", "\u200B", "\u00A0", "）", "／", "💡");
    for (const boundary of boundaries) {
      const unit = ["probe", "b.service"].join("@") + boundary;
      expect(sensitiveClasses(unit).has("email_address"), `boundary ${boundary.codePointAt(0)}`).toBe(!permitted.has(boundary));
      expect(commitMessageAddressReview(unit).attributable.length, `boundary ${boundary.codePointAt(0)}`).toBe(permitted.has(boundary) ? 0 : 1);
    }
  });

  test("RAW version tokens follow the positive grammar across ASCII and Unicode", () => {
    const permitted = new Set([" ", "\t", "\r", "\n", "\v", "\f", '"', "'", "`", ")", "]", ",", ";", ":"]);
    const boundaries = Array.from({ length: 128 }, (_, code) => String.fromCharCode(code));
    boundaries.push("α", "\u0301", "\u0375", "\u30FB", "\u200B", "\u00A0", "）", "／", "💡");
    for (const boundary of boundaries) {
      const token = ["pkg", "1.2.3"].join("@") + boundary;
      // Another digit extends the numeric version before its end-of-text boundary.
      const accepted = permitted.has(boundary) || /^[0-9]$/.test(boundary);
      expect(sensitiveClasses(token).has("email_address"), `boundary ${boundary.codePointAt(0)}`).toBe(!accepted);
      expect(commitMessageAddressReview(token).attributable.length > 0, `boundary ${boundary.codePointAt(0)}`).toBe(!accepted);
    }
  });

  test.each(unitLookingRealAddresses)("systemd suffix rule keeps real-TLD text blocked (%#)", (address) => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-systemd-address-"));
    temporaryDirectories.push(directory);
    const text = join(directory, "units.md");
    writeFileSync(text, address);

    const result = runGate([text]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("PRIVACY GATE: FAIL\nemail_address: 1\n");
    expect(result.stderr.toString()).toBe("");
  });

  test("scans several text files after one large source file", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-multi-text-"));
    temporaryDirectories.push(directory);
    const paths = ["large.ts", "second.ts", "third.ts", "fourth.ts"].map((name) => join(directory, name));
    writeFileSync(paths[0]!, "export const fixture = true;\n".repeat(12_000));
    for (const path of paths.slice(1)) writeFileSync(path, "export const fixture = true;\n");

    const result = runGate(paths);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("PRIVACY GATE: PASS\n");
    expect(result.stderr.toString()).toBe("");
  });

  test("detects quoted credential assignments containing punctuation", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const text = join(directory, "publication.md");
    const punctuation = String.fromCharCode(33, 35, 36, 64);
    const credentialKey = ["pass", "word"].join("");
    const credential = `${credentialKey}="${punctuation}syntheticfixture123456"`;
    writeFileSync(text, credential);

    const result = runGate([text]);
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe("PRIVACY GATE: FAIL\ncredential: 1\n");
    expect(output).not.toContain(credential);
    expect(output).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("matches a fixed independently derived vendor digest vector", () => {
    const fixture = createVendorDigestFixture();
    expect(trustedVendorRootDigest(fixture.root)).toBe(FIXED_VENDOR_FIXTURE_DIGEST);
    expect(trustedVendorRootMatches(fixture.root, FIXED_VENDOR_FIXTURE_DIGEST)).toBe(true);
    expect(TRUSTED_TELEGRAM_VENDOR_ROOT_DIGEST).toBe("8f3238a84139bff7ef88f522c60affc5880183f9f23048a39e124191c5e6619d");
    expect([...TRUSTED_TELEGRAM_VENDOR_EXEMPT_FINDING_CLASSES]).toEqual(["credential", "home_path"]);
    expect(TRUSTED_TELEGRAM_VENDOR_EXEMPT_FINDING_CLASSES.has("known_value")).toBe(false);
  });

  test("rejects vendor content and length changes", () => {
    const sameLength = createVendorDigestFixture();
    writeFileSync(sameLength.runtime, "bravx\n");
    expect(trustedVendorRootMatches(sameLength.root, FIXED_VENDOR_FIXTURE_DIGEST)).toBe(false);

    const changedLength = createVendorDigestFixture();
    writeFileSync(changedLength.runtime, "bravo extended\n");
    expect(trustedVendorRootMatches(changedLength.root, FIXED_VENDOR_FIXTURE_DIGEST)).toBe(false);
  });

  test("authenticates both executable-bit transitions", () => {
    const fixture = createVendorDigestFixture();
    expect(trustedVendorRootDigest(fixture.root)).toBe(FIXED_VENDOR_FIXTURE_DIGEST);

    chmodSync(fixture.runtime, 0o755);
    expect(trustedVendorRootDigest(fixture.root)).toBe(FIXED_EXECUTABLE_VENDOR_FIXTURE_DIGEST);
    expect(trustedVendorRootMatches(fixture.root, FIXED_VENDOR_FIXTURE_DIGEST)).toBe(false);

    chmodSync(fixture.runtime, 0o644);
    expect(trustedVendorRootDigest(fixture.root)).toBe(FIXED_VENDOR_FIXTURE_DIGEST);
    expect(trustedVendorRootMatches(fixture.root, FIXED_EXECUTABLE_VENDOR_FIXTURE_DIGEST)).toBe(false);
  });

  test("rejects vendor root path, addition, deletion, and rename changes", () => {
    const changedPath = createVendorDigestFixture();
    expect(trustedVendorRootMatches(join(changedPath.root, "nested"), FIXED_VENDOR_FIXTURE_DIGEST)).toBe(false);

    const addition = createVendorDigestFixture();
    writeFileSync(join(addition.root, "added.py"), "added\n");
    expect(trustedVendorRootMatches(addition.root, FIXED_VENDOR_FIXTURE_DIGEST)).toBe(false);

    const deletion = createVendorDigestFixture();
    unlinkSync(deletion.runtime);
    expect(trustedVendorRootMatches(deletion.root, FIXED_VENDOR_FIXTURE_DIGEST)).toBe(false);

    const rename = createVendorDigestFixture();
    renameSync(rename.runtime, join(rename.root, "nested", "renamed.py"));
    expect(trustedVendorRootMatches(rename.root, FIXED_VENDOR_FIXTURE_DIGEST)).toBe(false);
  });

  test("rejects simultaneous vendor file and manifest updates", () => {
    const fixture = createVendorDigestFixture();
    writeFileSync(fixture.runtime, "changed runtime\n");
    writeFileSync(fixture.manifest, "candidate-updated manifest\n");
    expect(trustedVendorRootMatches(fixture.root, FIXED_VENDOR_FIXTURE_DIGEST)).toBe(false);
  });

  test("rejects symlink, special-node, and unreadable vendor trees", () => {
    const symlink = createVendorDigestFixture();
    symlinkSync(symlink.readme, join(symlink.root, "linked-readme"));
    expect(trustedVendorRootDigest(symlink.root)).toBeNull();

    const special = createVendorDigestFixture();
    const fifo = join(special.root, "special-node");
    const mkfifo = Bun.spawnSync({ cmd: ["mkfifo", fifo], stderr: "pipe", stdout: "pipe" });
    expect(mkfifo.exitCode).toBe(0);
    expect(trustedVendorRootDigest(special.root)).toBeNull();

    const unreadable = createVendorDigestFixture();
    chmodSync(unreadable.runtime, 0o000);
    try {
      expect(trustedVendorRootDigest(unreadable.root)).toBeNull();
    } finally {
      chmodSync(unreadable.runtime, 0o600);
    }
  });

  test("detects UUIDv7 session identifiers with class-only diagnostics", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const text = join(directory, "publication.md");
    const sessionIdentifier = ["0190f47d", "1a2b", "7c3d", "8def", "123456789abc"].join("-");
    writeFileSync(text, `Synthetic session: ${sessionIdentifier}\n`);

    const result = runGate([text]);
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe("PRIVACY GATE: FAIL\nresource_identifier: 1\n");
    expect(output).not.toContain(sessionIdentifier);
    expect(output).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("detects resource identifiers split across visible Markdown link text", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const text = join(directory, "publication.md");
    const identifier = ["12345678", "1234", "4abc", "8def", "123456789abc"].join("-");
    const publication = `${identifier.slice(0, 4)}[${identifier.slice(4, 8)}](https://example.invalid)${identifier.slice(8)}`;
    writeFileSync(text, `${publication}\n`);

    const result = runGate([text]);
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe("PRIVACY GATE: FAIL\nresource_identifier: 1\n");
    expect(output).not.toContain(publication);
    expect(output).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("keeps the all-zero UUID placeholder exempt", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const text = join(directory, "publication.md");
    const placeholder = ["00000000", "0000", "0000", "0000", "000000000000"].join("-");
    writeFileSync(text, `Synthetic placeholder: ${placeholder}\n`);

    const result = runGate([text]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("PRIVACY GATE: PASS\n");
    expect(result.stderr.toString()).toBe("");
  });

  test("detects a plain fine-grained GitHub PAT without exposing it", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const text = join(directory, "publication.md");
    const token = syntheticFineGrainedPat();
    writeFileSync(text, token);

    const result = runGate([text]);
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe("PRIVACY GATE: FAIL\ncredential: 1\n");
    expect(output).not.toContain(token);
    expect(output).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("detects a percent-encoded fine-grained GitHub PAT without exposing it", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const text = join(directory, "publication.md");
    const token = syntheticFineGrainedPat();
    const encodedToken = [...token]
      .map((character) => `%${character.charCodeAt(0).toString(16).padStart(2, "0")}`)
      .join("");
    writeFileSync(text, encodedToken);

    const result = runGate([text]);
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe("PRIVACY GATE: FAIL\ncredential: 1\n");
    expect(output).not.toContain(token);
    expect(output).not.toContain(encodedToken);
    expect(output).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("detects a separator-split fine-grained GitHub PAT without exposing it", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const text = join(directory, "publication.md");
    const token = syntheticFineGrainedPat();
    const splitToken = [...token].join(" ");
    writeFileSync(text, splitToken);

    const result = runGate([text]);
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe("PRIVACY GATE: FAIL\ncredential: 1\n");
    expect(output).not.toContain(token);
    expect(output).not.toContain(splitToken);
    expect(output).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("fails closed when required known-value fingerprints are unavailable", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const text = join(directory, "release-notes.md");
    writeFileSync(text, "Synthetic release evidence.\n");

    const result = runGateArguments(["--require-known-values", "--paths", text], {
      LLV_PRIVACY_KNOWN_VALUES: "",
      LLV_PRIVACY_KNOWN_VALUES_FILE: "",
      LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE: "",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("PRIVACY GATE: FAIL\nconfiguration_error: 1\n");
    expect(result.stderr.toString()).toBe("");
  });

  test("normalizes links, HTML forms, percent encoding, and split tokens", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const text = join(directory, "publication.md");
    const fingerprints = join(directory, "known-values.json");
    const knownLabel = "fixture-private-project-label";
    const compactKnownLabel = knownLabel.replaceAll(/[^a-z0-9]/g, "");
    writeFileSync(fingerprints, JSON.stringify({
      schemaVersion: 1,
      normalization: "nfkc-lower-alnum-v1",
      fingerprints: [{
        length: compactKnownLabel.length,
        sha256: createHash("sha256").update(compactKnownLabel).digest("hex"),
      }],
    }));
    const splitKnownLabel = "fixture-<span>private</span>-project-**label**";
    const percentSlash = String.fromCharCode(37, 50, 70);
    const encodedHome = ["", "home", "fixture-person", "records"].join("/").replaceAll("/", encodeURIComponent(percentSlash));
    const splitToken = `${String.fromCharCode(103)} ${String.fromCharCode(104)} ${String.fromCharCode(112)} _ syntheticfixturecredential123456`;
    const passwordInput = ['<form><in', 'put type="password" value="synthetic-form-credential-123456"></form>'].join("");
    const encodedPasswordInput = passwordInput.replace("<", "&lt;");
    const authorizationHeader = ["Author", "ization: Bear", "er syntheticfixturecredential123456"].join("");
    const authenticatedUrl = ["https://fixture-user:", "synthetic-password-123456", "@example.invalid"].join("");
    writeFileSync(text, [
      `[evidence](https://example.invalid/${encodedHome})`,
      splitKnownLabel,
      encodedPasswordInput,
      splitToken,
      authorizationHeader,
      authenticatedUrl,
    ].join("\n"));

    const result = runGate([text], {
      LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE: fingerprints,
    });
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe([
      "PRIVACY GATE: FAIL",
      "credential: 1",
      "home_path: 1",
      "known_value: 1",
      "",
    ].join("\n"));
    expect(output).not.toContain(knownLabel);
    expect(output).not.toContain(encodedHome);
    expect(output).not.toContain(splitToken);
    expect(output).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  const canonicalizationFixtures = [
    {
      expected: "home_path",
      name: "mixed entity and percent encoding",
      publication: () => `${"&#37;26&#37;23x2f&#37;3B"}home&#37;26&#37;23x2f&#37;3Bfixture-person&#37;26&#37;23x2f&#37;3Brecords`,
    },
    {
      expected: "home_path",
      name: "entity-encoded zero-width separators",
      publication: () => ["", "ho&#8203;me", "fixture-person", "records"].join("/"),
    },
    {
      expected: "home_path",
      name: "percent-encoded zero-width separators",
      publication: () => {
        const encodedSeparator = encodeURIComponent(String.fromCodePoint(0x200b));
        return ["", `ho${encodedSeparator}me`, "fixture-person", "records"].join("/");
      },
    },
    {
      expected: "resource_identifier",
      name: "U+2063 default-ignorable separators",
      publication: () => `1234${String.fromCodePoint(0x2063)}5678-1234-4abc-8def-123456789abc`,
    },
    {
      expected: "resource_identifier",
      name: "U+2061 function-application separators",
      publication: () => `1234${String.fromCodePoint(0x2061)}5678-1234-4abc-8def-123456789abc`,
    },
    {
      expected: "resource_identifier",
      name: "U+2062 invisible-times separators",
      publication: () => `1234${String.fromCodePoint(0x2062)}5678-1234-4abc-8def-123456789abc`,
    },
    {
      expected: "resource_identifier",
      name: "U+2064 invisible-plus separators",
      publication: () => `1234${String.fromCodePoint(0x2064)}5678-1234-4abc-8def-123456789abc`,
    },
    {
      expected: "resource_identifier",
      name: "soft-hyphen default-ignorables",
      publication: () => `1234${String.fromCodePoint(0x00ad)}5678-1234-4abc-8def-123456789abc`,
    },
    {
      expected: "resource_identifier",
      name: "supplementary tag default-ignorables",
      publication: () => `1234${String.fromCodePoint(0xe007f)}5678-1234-4abc-8def-123456789abc`,
    },
    {
      expected: "home_path",
      name: "four-layer percent encoding",
      publication: () => {
        let encoded = ["", "home", "fixture-person", "records"].join("/");
        for (let pass = 0; pass < 4; pass += 1) encoded = encodeURIComponent(encoded);
        return encoded;
      },
    },
    {
      expected: "home_path",
      name: "CommonMark escaped slashes",
      publication: () => ["", "home", "fixture-person", "records"].join("\\/"),
    },
    {
      expected: "known_value",
      name: "newline-split known values",
      publication: () => ["fixture", process.pid, "newline", "known", "label"].join("\n"),
      value: () => ["fixture", process.pid, "newline", "known", "label"].join("-"),
    },
    {
      expected: "home_path",
      name: "lowercase Windows home paths",
      publication: () => ["c:", "users", "fixture-person", "records"].join("\\"),
    },
    {
      expected: "private_network",
      name: "GFM HTML5 named entities",
      publication: () => ["192", "168", "12", "34"].join("&period;"),
    },
    {
      expected: "private_network",
      name: "GFM underscore emphasis",
      publication: () => ["192", "_168_", "12", "34"].join("."),
    },
  ];

  for (const fixture of canonicalizationFixtures) {
    test(`canonicalizes ${fixture.name} with class-only diagnostics`, () => {
      const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
      temporaryDirectories.push(directory);
      const publication = fixture.publication();
      const text = join(directory, "publication.md");
      writeFileSync(text, `${publication}\n`);
      const environment: Record<string, string> = {};
      if (fixture.value) {
        const fingerprints = join(directory, "known-values.json");
        writeFingerprintCatalog(fingerprints, fixture.value());
        environment.LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE = fingerprints;
      }

      const result = runGate([text], environment);
      const output = result.stdout.toString();

      expect(result.exitCode).toBe(1);
      expect(output).toBe(`PRIVACY GATE: FAIL\n${fixture.expected}: 1\n`);
      expect(output).not.toContain(publication);
      expect(output).not.toContain(directory);
      expect(result.stderr.toString()).toBe("");
    });
  }

  test("matches fingerprinted labels inside HTML attributes", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const text = join(directory, "publication.html");
    const fingerprints = join(directory, "known-values.json");
    const knownLabel = ["fixture", "private", "attribute", "label"].join("-");
    const compactKnownLabel = knownLabel.replaceAll("-", "");
    writeFileSync(fingerprints, JSON.stringify({
      schemaVersion: 1,
      normalization: "nfkc-lower-alnum-v1",
      fingerprints: [{
        length: compactKnownLabel.length,
        sha256: createHash("sha256").update(compactKnownLabel).digest("hex"),
      }],
    }));
    writeFileSync(text, `<div data-project="${knownLabel}">Synthetic evidence</div>\n`);

    const result = runGate([text], {
      LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE: fingerprints,
    });
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe("PRIVACY GATE: FAIL\nknown_value: 1\n");
    expect(output).not.toContain(knownLabel);
    expect(output).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("keeps malformed HTML entities inside class-only inspection", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const text = join(directory, "publication.html");
    writeFileSync(text, "Synthetic entity &#99999999; remains inert.\n");

    const result = runGate([text]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("PRIVACY GATE: PASS\n");
    expect(result.stderr.toString()).toBe("");
  });

  const encodedTextFixtures = [
    {
      expected: "home_path",
      name: "NUL-prefixed text",
      value: () => Buffer.concat([
        Buffer.from([0]),
        Buffer.from(["", "home", "fixture-person", "records"].join("/")),
      ]),
    },
    {
      expected: "home_path",
      name: "embedded-NUL text",
      value: () => Buffer.concat([
        Buffer.from("Synthetic prefix"),
        Buffer.from([0]),
        Buffer.from(["", "home", "fixture-person", "records"].join("/")),
      ]),
    },
    {
      expected: "home_path",
      name: "UTF-16 text",
      value: () => Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from(["", "home", "fixture-person", "records"].join("/"), "utf16le"),
      ]),
    },
  ];

  for (const fixture of encodedTextFixtures) {
    test(`inspects ${fixture.name} with class-only diagnostics`, () => {
      const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
      temporaryDirectories.push(directory);
      const text = join(directory, "publication.md");
      const contents = fixture.value();
      writeFileSync(text, contents);

      const result = runGate([text]);
      const output = result.stdout.toString();

      expect(result.exitCode).toBe(1);
      expect(output).toBe(`PRIVACY GATE: FAIL\n${fixture.expected}: 1\n`);
      expect(output).not.toContain(directory);
      expect(result.stderr.toString()).toBe("");
    });
  }

  test("fails closed for unsupported binary publication input", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const binary = join(directory, "publication.bin");
    writeFileSync(binary, Buffer.from([0x00, 0xff, 0x00, 0xfe, 0x01, 0x02]));

    const result = runGate([binary]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("PRIVACY GATE: FAIL\ninspection_error: 1\n");
    expect(result.stdout.toString()).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("skips text inspection for signature-verified MP3 and WAV assets", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const mp3 = join(directory, "cue.mp3");
    const wav = join(directory, "ambient.wav");
    writeFileSync(mp3, Buffer.concat([
      Buffer.from("ID3"),
      Buffer.from([0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
      Buffer.from([0xff, 0xfb, 0x90, 0x64]),
    ]));
    writeFileSync(wav, Buffer.concat([
      Buffer.from("RIFF"),
      Buffer.from([0x24, 0x00, 0x00, 0x00]),
      Buffer.from("WAVEfmt "),
      Buffer.from([0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x02, 0x00]),
    ]));

    const result = runGate([mp3, wav]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("PRIVACY GATE: PASS\n");
    expect(result.stderr.toString()).toBe("");
  });

  test("does not trust an audio extension without an audio signature", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const fakeAudio = join(directory, "cue.mp3");
    const credentialKey = ["pass", "word"].join("");
    writeFileSync(fakeAudio, `${credentialKey}="synthetic-fixture-value-123456"\n`);

    const result = runGate([fakeAudio]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("PRIVACY GATE: FAIL\ncredential: 1\n");
    expect(result.stderr.toString()).toBe("");
  });

  test("fails closed for binary content renamed with a text extension", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const binary = join(directory, "publication.md");
    writeFileSync(binary, Buffer.from([0x00, 0xff, 0x00, 0xfe, 0x01, 0x02]));

    const result = runGate([binary]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("PRIVACY GATE: FAIL\ninspection_error: 1\n");
    expect(result.stdout.toString()).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("fails closed for UTF-32LE text under a Markdown extension", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const text = join(directory, "publication.md");
    const syntheticHome = ["", "home", "fixture-person", "utf32-records"].join("/");
    const codePoints = [...syntheticHome].map((character) => character.codePointAt(0) ?? 0);
    const contents = Buffer.alloc(4 + codePoints.length * 4);
    contents.set([0xff, 0xfe, 0x00, 0x00]);
    codePoints.forEach((codePoint, index) => contents.writeUInt32LE(codePoint, 4 + index * 4));
    writeFileSync(text, contents);

    const result = runGate([text]);
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe("PRIVACY GATE: FAIL\ninspection_error: 1\n");
    expect(output).not.toContain(syntheticHome);
    expect(output).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  // The relay-value matrix spawns the gate per case and does not finish within
  // the required check's budget; it runs on demand until it is batched.
  describe("operator-approved public relay values", () => {
    // Keep sanctioned strings out of publication input for the trusted gate.
    const relayLabel = "chatmoderator";
    const relayZone = "botfather";
    const host = [relayLabel, relayZone, "dev"].join(".");
    const origin = `https://${host}`;
    const discovery = `${origin}/.well-known/delegatus-relay.json`;
    const domain = host.split(".").slice(1).join(".");
    const percent = (text: string) => [...text].map((c) => `%${c.charCodeAt(0).toString(16)}`).join("");
    const unicode = (text: string) => [...text].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
    const entities = (text: string) => [...text].map((c) => `&#${c.charCodeAt(0)};`).join("");
    const fullWidth = (text: string) => [...text].map((c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).join("");
    const tick = String.fromCharCode(96);
    const interpolation = (value: string) => "${" + JSON.stringify(value) + "}";
    const cases = [
      { name: "host", text: host, pass: true },
      { name: "origin", text: origin, pass: true },
      { name: "discovery", text: discovery, pass: true },
      // The ruling allows ASCII whitespace only, on raw text. Every other
      // code point and encoded neighbour withholds the exemption.
      ...[host, origin, discovery].flatMap((value, form) => [
        ...[0, 0x85, 0xa0, 0xad, 0x1680, 0x180e, 0x200b, 0x200c, 0x200d,
          0x2028, 0x2029, 0x202f, 0x2060, 0x3000, 0xfeff,
          ...Array.from({ length: 11 }, (_, index) => 0x2000 + index)]
          .flatMap((code) => [
            { name: `raw boundary before ${form} ${code}`, text: String.fromCharCode(code) + value, pass: false },
            { name: `raw boundary after ${form} ${code}`, text: value + String.fromCharCode(code), pass: false },
          ]),
        ...[".", "-", "x", "%20", "&#32;", "<", "{", ","].map((before) => ({
          name: `raw boundary prefix ${form} ${before}`, text: before + value, pass: false,
        })),
        ...[".", "-", "x", "%20", "&#32;", ":", ">", "}", "/"].map((after) => ({
          name: `raw boundary suffix ${form} ${after}`, text: value + after, pass: false,
        })),
        ...[" ", "\t", "\n", "\r", "\v", "\f"].map((space, index) => ({
          name: `raw ASCII whitespace ${form} ${index}`, text: space + value + space, pass: true,
        })),
        ...["=", ":", "(", "["].map((before) => ({
          name: `raw ASCII prefix ${form} ${before}`, text: before + value, pass: true,
        })),
        ...[")", "]", ",", ";"].map((after) => ({
          name: `raw ASCII suffix ${form} ${after}`, text: value + after, pass: true,
        })),
        ...["\u200b", "\u00a0", "%C2%A0", "&#160;"].map((separator, index) => ({
          name: `raw quoted wrapper suffix ${form} ${index}`,
          text: `relay=( "${value}" )${separator}/private;`, pass: false,
        })),
      ]),
      ...[host, origin, discovery].flatMap((value, form) => [
        ...["\u00a0", "\u200b", "\ufeff", "\u3000", "%C2%A0", "&#160;"].flatMap((separator, index) => [
          { name: `raw call suffix ${form} ${index}`, text: `String("${value}")${separator}/private`, pass: false },
          { name: `raw index suffix ${form} ${index}`, text: `x["${value}"]${separator}`, pass: false },
          { name: `raw nested call suffix ${form} ${index}`, text: `((String("${value}")))${separator}/private`, pass: false },
          { name: `raw multi argument call suffix ${form} ${index}`, text: `String("${value}", 1)${separator}`, pass: false },
          { name: `raw nested call prefix ${form} ${index}`, text: `${separator}((String("${value}")))`, pass: false },
          { name: `raw bare wrapper suffix ${form} ${index}`, text: `(${value})${separator}`, pass: false },
          { name: `raw bare index suffix ${form} ${index}`, text: `[${value}]${separator}`, pass: false },
          { name: `raw bare nested suffix ${form} ${index}`, text: `((${value}))${separator}`, pass: false },
          { name: `raw bare multi argument suffix ${form} ${index}`, text: `f(${value}, 1)${separator}`, pass: false },
          { name: `raw bare comment wrapper suffix ${form} ${index}`, text: `// (${value})${separator}`, pass: false },
          { name: `raw bare prose comment wrapper suffix ${form} ${index}`, text: `// It's (${value})${separator}`, pass: false },
          { name: `raw call chained prefix ${form} ${index}`, text: `${separator}(x)("${value}")`, pass: false },
          { name: `raw index chained prefix ${form} ${index}`, text: `${separator}[x]["${value}"]`, pass: false },
        ]),
        { name: `raw standalone call ${form}`, text: `String("${value}")`, pass: true },
        { name: `raw standalone index ${form}`, text: `x["${value}"]`, pass: true },
      ]),
      ...[host, origin, discovery].flatMap((value, form) =>
        [" ", " /*comment*/ ", " //comment\n "].flatMap((trivia, gap) => [
          ...["\u00a0", "\u200b"].flatMap((separator, code) => [
            { name: `raw trivia call prefix ${form} ${gap} ${code}`, text: `${separator}String${trivia}("${value}")`, pass: false },
            { name: `raw trivia chained call prefix ${form} ${gap} ${code}`, text: `${separator}(x)${trivia}("${value}")`, pass: false },
            { name: `raw trivia chained index prefix ${form} ${gap} ${code}`, text: `${separator}[x]${trivia}["${value}"]`, pass: false },
          ]),
          { name: `raw trivia standalone call ${form} ${gap}`, text: `String${trivia}("${value}")`, pass: true },
        ])),
      ...[host, origin, discovery].flatMap((value, form) =>
        ['/* " */ ', `/* ${tick} */ `, `// ${tick}\n`, '/* ) */ ', '/* ] */ '].flatMap((comment, kind) => [
          { name: `raw comment call prefix ${form} ${kind}`, text: `${comment}\u200bString("${value}")`, pass: false },
          { name: `raw comment index prefix ${form} ${kind}`, text: `${comment}\u00a0x["${value}"]`, pass: false },
          { name: `raw comment group prefix ${form} ${kind}`, text: `${comment}\u200b("${value}")`, pass: false },
          { name: `raw comment standalone call ${form} ${kind}`, text: `${comment}String("${value}")`, pass: true },
          { name: `raw comment internal close ${form} ${kind}`, text: `\u200bf(${comment}"${value}")`, pass: false },
        ])),
      ...[host, origin, discovery].flatMap((value, form) => [
        { name: `raw entity comment call prefix ${form}`, text: `&#160;String /*comment*/ ("${value}")`, pass: false },
        { name: `raw entity comment continued call prefix ${form}`, text: `&#160;String /*comment*/\n ("${value}")`, pass: false },
        { name: `raw entity comment index prefix ${form}`, text: `&#x200b;x /*comment*/ ["${value}"]`, pass: false },
        { name: `raw entity comment chained call prefix ${form}`, text: `&#160;(x) /*comment*/ ("${value}")`, pass: false },
      ]),
      ...[host, origin, discovery].flatMap((value, form) =>
        ["\u00a0", "\ufeff", "\u3000", "\u200b"].flatMap((gap, space) =>
          ["\u00a0", "&#160;"].flatMap((prefix, boundary) => [
            { name: `raw Unicode trivia call prefix ${form} ${space} ${boundary}`, text: `${prefix}f${gap} ("${value}")`, pass: false },
            { name: `raw Unicode trivia index prefix ${form} ${space} ${boundary}`, text: `${prefix}x${gap} ["${value}"]`, pass: false },
            { name: `raw Unicode trivia chained prefix ${form} ${space} ${boundary}`, text: `${prefix}(x)${gap} ("${value}")`, pass: false },
          ]))),
      ...[host, origin, discovery].flatMap((value, form) =>
        ['/* " */', `/* ${tick} */`].flatMap((comment, quote) => [
          { name: `raw entity quoted comment call ${form} ${quote}`, text: `&#160;f ${comment} ("${value}", 1)`, pass: false },
          { name: `raw entity quoted comment index ${form} ${quote}`, text: `&#160;x ${comment} ["${value}"]`, pass: false },
          { name: `raw entity quoted comment chained ${form} ${quote}`, text: `&#160;(x) ${comment} ("${value}", 1)`, pass: false },
        ])),
      ...[host, origin, discovery].flatMap((value, form) =>
        ["//", "/*"].flatMap((comment, kind) =>
          ["", tick].flatMap((close, ending) =>
            ["\u00a0", "\u200b"].map((prefix, boundary) => ({
              name: `raw comment template callee ${form} ${kind} ${ending} ${boundary}`,
              text: `${comment} ${tick} text ${prefix}f("${value}")${close}${kind === 1 ? " */" : ""}`,
              pass: false,
            }))))),
      ...[host, origin, discovery].flatMap((value, form) =>
        ["\u00a0", "\u200b", "\ufeff", "\u3000"].flatMap((space, boundary) => [
          { name: `raw template group prefix ${form} ${boundary}`, text: `${tick}\u0024{${space} ("${value}")}${tick}`, pass: false },
          { name: `raw template group suffix ${form} ${boundary}`, text: `${tick}\u0024{("${value}") ${space}}${tick}`, pass: false },
        ])),
      ...[host, origin, discovery].flatMap((value, form) =>
        ["\u2028", "\u2029"].flatMap((line, boundary) => [
          { name: `raw template group comment prefix ${form} ${boundary}`, text: `${tick}\u0024{//comment${line}("${value}")}${tick}`, pass: false },
          { name: `raw template group comment suffix ${form} ${boundary}`, text: `${tick}\u0024{("${value}")//comment${line}}${tick}`, pass: false },
        ])),
      ...[host, origin, discovery].flatMap((value, form) => [
        ...["&#160;", "&#x200b;", "&nbsp;", "&amp;#160;", "%26#160;", "&#38;nbsp;"].flatMap((gap, encoding) => [
          { name: `raw encoded trivia call ${form} ${encoding}`, text: `f${gap} /*comment*/ ("${value}")`, pass: false },
          { name: `raw encoded trivia index ${form} ${encoding}`, text: `x${gap} ["${value}"]`, pass: false },
        ]),
        ...["&amp;#160;", "%26#160;", String.raw`\u0026#160;`].flatMap((prefix, encoding) => [
          { name: `raw encoded hash call ${form} ${encoding}`, text: `${prefix}f /* " */ ("${value}")`, pass: false },
          { name: `raw encoded hash index ${form} ${encoding}`, text: `${prefix}x /* ${tick} */ ["${value}"]`, pass: false },
        ]),
      ]),
      ...[host, origin, discovery].flatMap((value, form) => [
        ...["%20", "%09", "&#32;", "&#x09;", String.raw`\u0020`, String.raw`\u0009`, "&amp;#32;"].flatMap((gap, encoding) => [
          { name: `raw encoded call trivia regression ${form} ${encoding}`, text: `\u200bf${gap} /* " */ ("${value}")`, pass: false },
          { name: `raw encoded index trivia regression ${form} ${encoding}`, text: `\u200bx${gap} /* ${tick} */ ["${value}"]`, pass: false },
        ]),
        ...["f", "helpers.tag", "(f)", "x[0]"].map((tag, kind) => ({
          name: `review tagged template regression ${form} ${kind}`, text: `${tag}${tick}${value}${tick}`, pass: false,
        })),
        ...["/[)]/", "/[}]/", '/"/', "/`/", "/\\)/"].flatMap((regex, kind) => [
          { name: `review regex delimiter prefix regression ${form} ${kind}`, text: `"other." + f(${regex}, "${value}")`, pass: false },
          { name: `review regex delimiter suffix regression ${form} ${kind}`, text: `f("${value}", ${regex}) + "/private"`, pass: false },
        ]),
        ...["1 + /[)]/", "() => /[)]/", "function(){return /[)]/}", "typeof /[)]/", "/*c*/ /[)]/", "/*c*/ /)/", String.raw`/*c*/ /\)/`, String.raw`()=>{return /*c*/ /\)/}`, "()=>{return /*c*/ /[)]/}", "(()=>{if(x) /[)]/; return 0;})()", "(()=>{if(x){} /[)]/; return 0;})()"].map((operand, kind) => ({
          name: `review expression regex ownership regression ${form} ${kind}`, text: `"other." + f(${operand}, "${value}")`, pass: false,
        })),
        ...["{/[)]/", "{x:/[)]/", "switch(x){default: /[)]/"].map((operand, kind) => ({
          name: `raw call suffix unfinished regex wrapper regression ${form} ${kind}`, text: `f("${value}", ${operand}) + "/private"`, pass: false,
        })),
        ...["[/*)]", "[//)]", "[()]*", String.raw`[\"()]`].flatMap((pattern, kind) => [
          { name: `review control regex suffix regression ${form} ${kind}`, text: `f("${value}", (()=>{if(x) /${pattern}/; return 0;})()) + "/private"`, pass: false },
          { name: `review control block regex suffix regression ${form} ${kind}`, text: `f("${value}", (()=>{if(x){} /${pattern}/; return 0;})()) + "/private"`, pass: false },
        ]),
        ...["/*c*/ /x)/", "/*c*/ /)/"].map((operand, kind) => ({
          name: `review malformed regex suffix regression ${form} ${kind}`, text: `f("${value}", ${operand}) + "/private"`, pass: false,
        })),
        ...["return", "typeof", "await", "throw", "in", "instanceof"].flatMap((property, kind) => ["x . ", "x./*c*/", "x.//c\n", "x.\u00a0"].flatMap((prefix, trivia) => [
          { name: `review property division suffix regression ${form} ${kind} ${trivia}`, text: `f("${value}", ${prefix}${property} / 2) + "/private"`, pass: false },
          { name: `review standalone property division regression ${form} ${kind} ${trivia}`, text: `f("${value}", ${prefix}${property} / 2);`, pass: true },
        ])),
        ...["1 / 2", "x / y", "x /*c*/ / y", "x++ / 2", "x-- / 2", "({x:1}) / 2", "x.return / 2"].map((operand, kind) => ({
          name: `review standalone division regression ${form} ${kind}`, text: `f("${value}", ${operand});`, pass: true,
        })),
        { name: `review unrelated division regression ${form}`, text: `function relay(){const endpoint="${value}"; return 1 / 2;}`, pass: true },
        ...["1 / 2", "x / y", "x /*c*/ / y", "x++ / 2", "x-- / 2", "({x:1}) / 2", "{x:1} / 2", "x.return / 2"].map((operand, kind) => ({
          name: `review division ownership regression ${form} ${kind}`, text: `f("${value}", ${operand}) + "/private"`, pass: false,
        })),
        ...[")", "]", "}"].flatMap((close, kind) => [
          { name: `review unmatched close prefix regression ${form} ${kind}`, text: `"other." + ${close}("${value}")`, pass: false },
          { name: `review unmatched close suffix regression ${form} ${kind}`, text: `("${value}")${close}/private`, pass: false },
        ]),
      ]),
      { name: "quoted code", text: `export const relay = "${origin}";`, pass: true },
      { name: "repeated host", text: `${host}\n`.repeat(1000), pass: true },
      { name: "NUL metadata boundaries", text: `comment\0${host}\0`, pass: false },
      { name: "test code", text: `expect(relay).toBe('${discovery}');`, pass: true },
      { name: "JSON", text: JSON.stringify({ relay: host }), pass: true },
      { name: "Markdown", text: `[Relay](${discovery}) and \`${host}\``, pass: true },
      { name: "Markdown link label", text: `[${host}](https://example.invalid)`, pass: false },
      { name: "Markdown origin label", text: `[${origin}](https://example.invalid)`, pass: false },
      { name: "Markdown discovery label", text: `[${discovery}](https://example.invalid)`, pass: false },
      { name: "HTML attribute", text: `<a href="${origin}">Relay</a>`, pass: true },
      ...[host, origin, discovery].flatMap((value, index) => [";private", ",private", ")private"].map((suffix) => ({
        name: `review JSON URI punctuation ${index} ${suffix[0]}`,
        text: JSON.stringify({ relay: value + suffix }), pass: false,
      }))),
      ...[origin, discovery].flatMap((value, index) => [";?private=1", ";.example.invalid", ",:443", ";%70rivate", ";&#112;rivate"].map((suffix) => ({
        name: `review URI continuation ${index} ${suffix}`, text: value + suffix, pass: false,
      }))),
      ...["https://prefix=", "https://example.invalid/path=", "https://example.invalid/path(", "https://example.invalid/?target="].flatMap((prefix, index) => [
        { name: `review enclosing URI literal ${index}`, text: `const relay = "${prefix}${host}";`, pass: false },
        { name: `review bare URI prefix ${index}`, text: `${prefix}${host}`, pass: false },
      ]),
      { name: "review discovery apostrophe tail", text: `${discovery}'/private`, pass: false },
      { name: "review Markdown apostrophe tail", text: `[Relay](${discovery}'/private)`, pass: false },
      { name: "review discovery unmatched close", text: `${discovery}}/private`, pass: false },
      { name: "review Markdown unmatched close", text: `[Relay](${discovery}}/private)`, pass: false },
      { name: "review opposite quote URI", text: `const relay = "https://example.invalid/'${host}'";`, pass: false },
      { name: "review opposite quote prefix", text: `const relay = "other.'${host}'";`, pass: false },
      { name: "review opposite quote suffix", text: `const relay = "'${origin}'/private";`, pass: false },
      { name: "review bare quoted URI", text: `https://example.invalid/'${host}'`, pass: false },
      ...["HTTPS", "ftp", "wss"].map((scheme) => ({
        name: `review URI scheme ${scheme}`, text: `${scheme}://example.invalid/path=${host}`, pass: false,
      })),
      ...[
        ["extra closing delimiter", `(${origin}))private`],
        ["parenthesis semicolon", `(${origin});private`],
        ["angle semicolon", `<${origin}>;private`],
        ["angle entity semicolon", `<${origin}>&#59;private`],
        ["parenthesis NFKC semicolon", `(${origin})；private`],
      ].map(([name, text]) => ({ name: `review wrapper tail ${name}`, text, pass: false })),
      { name: "review standalone parenthesis punctuation", text: `(${origin});`, pass: true },
      { name: "review standalone angle punctuation", text: `<${origin}>;`, pass: false },
      { name: "review parenthesis URI suffix", text: `(${origin})/private`, pass: false },
      { name: "review parenthesis host suffix", text: `(${host}).example.invalid`, pass: false },
      { name: "review parenthesis host prefix", text: `other.(${host})`, pass: false },
      ...["}private", "]private", ">private"].map((suffix) => ({
        name: `review closing delimiter tail ${suffix[0]}`, text: origin + suffix, pass: false,
      })),
      { name: "review enclosing origin literal", text: JSON.stringify({ relay: `https://example.invalid/?target=${origin}` }), pass: false },
      { name: "review quoted angle prefix", text: `other.<${tick}${host}${tick}>`, pass: false },
      { name: "review quoted angle suffix", text: `<${tick}${origin}${tick}>/private`, pass: false },
      { name: "review interpolated angle prefix", text: `const relay = ${tick}other.<${interpolation(host)}>${tick};`, pass: false },
      { name: "review nested angle prefix", text: `other.<${tick}<${host}>${tick}>`, pass: false },
      { name: "review angle prefix", text: `other.<${host}>`, pass: false },
      { name: "review angle suffix", text: `<${host}>.example.invalid`, pass: false },
      { name: "review angle origin suffix", text: `<${origin}>/private`, pass: false },
      { name: "review angle scheme prefix", text: `https://<${host}>`, pass: false },
      { name: "review template prefix", text: `const relay = ${tick}other.${interpolation(host)}${tick};`, pass: false },
      { name: "review template suffix", text: `const relay = ${tick}${interpolation(origin)}:443${tick};`, pass: false },
      { name: "review template email", text: `const relay = ${tick}fixture@${interpolation(host)}${tick};`, pass: false },
      ...[10, 13, 0x2028, 0x2029].flatMap((code) => {
        const line = String.fromCharCode(code);
        const commented = "${" + JSON.stringify(host) + " // comment" + line + "}";
        const leading = "${// comment" + line + JSON.stringify(host) + "}";
        return [
          { name: `review interpolation line-comment prefix ${code}`, text: `const relay = ${tick}other.${commented}${tick};`, pass: false },
          { name: `review interpolation line-comment suffix ${code}`, text: `const relay = ${tick}${commented}.example.invalid${tick};`, pass: false },
          { name: `review interpolation leading line-comment ${code}`, text: `const relay = ${tick}fixture@${leading}${tick};`, pass: false },
          { name: `review standalone commented interpolation ${code}`, text: `const relay = ${tick}${commented}${tick};`, pass: true },
        ];
      }),
      { name: "review shell bare prefix", text: `relay=other"${host}"`, pass: false },
      ...[0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0xad].flatMap((code) => {
        const invisible = String.fromCharCode(code);
        return [
          { name: `review Unicode zero-width shell prefix ${code}`, text: `relay=other.${invisible}"${host}";`, pass: false },
          { name: `review Unicode zero-width shell suffix ${code}`, text: `relay="${origin}"${invisible}/private;`, pass: false },
          { name: `review Unicode zero-width quoted prefix ${code}`, text: `relay="other."${invisible}"${host}";`, pass: false },
          { name: `review Unicode zero-width quoted suffix ${code}`, text: `relay="${origin}"${invisible}"/private";`, pass: false },
        ];
      }),
      ...[0xa0, ...Array.from({ length: 11 }, (_, index) => 0x2000 + index), 0x202f, 0x205f, 0x3000].flatMap((code) => {
        const whitespace = String.fromCharCode(code);
        return [
          { name: `review Unicode NFKC shell prefix ${code}`, text: `relay=other.${whitespace}"${host}";`, pass: false },
          { name: `review Unicode NFKC shell suffix ${code}`, text: `relay="${origin}"${whitespace}/private;`, pass: false },
          { name: `review Unicode NFKC source whitespace ${code}`, text: [host, origin, discovery]
            .map((value) => `const relay =${whitespace}"${value}";${whitespace}`).join("\n"), pass: false },
        ];
      }),
      ...["\u200b", "\u00a0"].flatMap((separator, index) => [
        { name: `review Unicode wrapper prefix ${index}`, text: `relay=other.${separator}("${host}");`, pass: false },
        { name: `review Unicode wrapper suffix ${index}`, text: `relay=("${origin}")${separator}/private;`, pass: false },
        { name: `review Unicode percent suffix ${index}`, text: `relay="${origin}"${encodeURIComponent(separator)}/private;`, pass: false },
        { name: `review Unicode entity suffix ${index}`, text: `relay="${origin}"${entities(separator)}/private;`, pass: false },
        { name: `review Unicode JSON suffix ${index}`, text: `relay="${origin}"${unicode(separator)}/private;`, pass: false },
      ]),
      ...[0xa0, 0x2009].flatMap((code) => {
        const whitespace = String.fromCharCode(code);
        return [
          { name: `review Unicode standalone optional call ${code}`, text: `const relay = String?.${whitespace}("${host}");`, pass: false },
          { name: `review Unicode standalone optional index ${code}`, text: `const relay = ["${host}"]${whitespace}?.[0];`, pass: false },
        ];
      }),
      { name: "review shell continued bare prefix", text: `relay=other${String.fromCharCode(92)}
"${host}"`, pass: false },
      { name: "review shell escaped opening quote", text: `relay=${String.fromCharCode(92)}"${host}"`, pass: false },
      { name: "review quoted comment cast prefix", text: `const relay = "other." + (<string> /* "fake" */ "${host}");`, pass: false },
      { name: "review single quoted comment cast prefix", text: `const relay = "other." + (<string> /* 'fake' */ "${host}");`, pass: false },
      { name: "review quoted approved comment cast prefix", text: `const relay = "other." + (<string> /* "${host}" */ "${host}");`, pass: false },
      { name: "review PHP quoted comment prefix", text: `$relay = "other." . /* "fake" */ "${host}";`, pass: false },
      { name: "review standalone quoted comment", text: `// Public relay: "${origin}"`, pass: true },
      ...[host, origin, discovery].map((value, index) => ({
        name: `review standalone multiline comment ${index}`, text: `/**\n * Public relay: ${value}\n */`, pass: true,
      })),
      ...[host, origin, discovery].map((value, index) => ({
        name: `review standalone bare multiline comment ${index}`, text: `/**\n * ${value}\n */`, pass: true,
      })),
      ...[host, origin, discovery].map((value, index) => ({
        name: `review standalone bare quoted multiline comment ${index}`, text: `/**\n * "${value}"\n */`, pass: true,
      })),
      { name: "review standalone repeated bare comments", text: `/**\n * ${host}\n */\n/**\n * "${origin}"\n */`, pass: true },
      ...[host, origin, discovery].map((value, index) => ({
        name: `review standalone quoted multiline comment ${index}`, text: `/**\n * Public relay: "${value}"\n */`, pass: true,
      })),
      { name: "review multiline comment email continuation", text: `/**\n * fixture@\n${host}\n */`, pass: false },
      { name: "review multiline comment URI continuation", text: `/**\n * ${origin}\n!private\n */`, pass: false },
      ...[host, origin, discovery].flatMap((value, index) => [
        { name: `review URI opaque comma ${index}`, text: `data:,${value}`, pass: false },
        { name: `review URI opaque payload ${index}`, text: `data:text,${value}`, pass: false },
        { name: `review URI assigned opaque payload ${index}`, text: `relay=data:text,${value}`, pass: false },
        { name: `review URI opaque URN ${index}`, text: `urn:fixture,${value}`, pass: false },
        { name: `review URI opaque equals ${index}`, text: `urn:fixture=${value}`, pass: false },
        { name: `review URI opaque quoted equals ${index}`, text: `urn:fixture='${value}'`, pass: false },
        { name: `review URI opaque wrapped equals ${index}`, text: `<urn:fixture='${value}'>`, pass: false },
        { name: `review URI opaque parenthesized payload ${index}`, text: `urn:fixture(${value})`, pass: false },
        { name: `review URI opaque bracketed payload ${index}`, text: `urn:fixture[${value}]`, pass: false },
        { name: `review URI opaque quoted payload ${index}`, text: `<urn:'${value}'>`, pass: false },
        { name: `review URI opaque source-shaped payload ${index}`, text: `urn:fixture,key:'${value}'`, pass: false },
        { name: `review URI opaque nested source-shaped payload ${index}`, text: `<urn:{key:'${value}'}>`, pass: false },
        { name: `review URI opaque object payload ${index}`, text: `data:,{origin:"${value}"}`, pass: false },
        { name: `review URI opaque JSON payload ${index}`, text: `data:application/json,{"origin":"${value}"}`, pass: false },
        { name: `review URI opaque repeated quoted payload ${index}`, text: `urn:"fixture","${value}"`, pass: false },
        { name: `review URI wrapped opaque autolink ${index}`, text: `<data:text,'${value}'>`, pass: false },
        { name: `review URI wrapped opaque quoted ${index}`, text: `(data:text,"${value}")`, pass: false },
        { name: `review URI wrapped opaque bare ${index}`, text: `(data:text,${value} )`, pass: false },
        { name: `review URI opaque content type ${index}`, text: `data:text/plain,${value}`, pass: false },
      ]),
      ...["\t", "\n", "\r", "%09 ", "&#9; "].map((separator, index) => ({
        name: `review URI split scheme ${index}`, text: `http:${separator}${host}`, pass: false,
      })),
      ...[["(", " )"], ["<", ">"], ["[", " ]"]].map(([open, close], index) => ({
        name: `review URI wrapped split scheme ${index}`, text: `${open}http:\t${host}${close}`, pass: false,
      })),
      { name: "review URI minified object boundary", text: `const relay={origin:"${origin}"};`, pass: true },
      { name: "review URI spaced object key boundary", text: `const relay={ origin:"${origin}"};`, pass: true },
      { name: "review URI multiline object key boundary", text: `const relay={ origin:\n"${origin}"};`, pass: true },
      { name: "review URI interface key boundary", text: `interface Relay { origin:"${origin}"; }`, pass: true },
      { name: "review URI type key boundary", text: `type Relay = { origin:"${origin}" };`, pass: true },
      // The existing narrow policy treats an adjacent '=' as a continuation.
      { name: "review URI compact literal type continuation", text: `const relay:"${host}"="${host}";`, pass: false },
      { name: "review URI spaced literal type boundary", text: `const relay: "${host}" = "${host}";`, pass: true },
      { name: "review URI generic type boundary", text: `const relay:Record<string,string>="${host}";`, pass: true },
      { name: "review URI nested object boundary", text: `const relay={outer:{origin:"${origin}"}};`, pass: true },
      { name: "review URI sibling URL boundary", text: `const relay={other:"https://example.invalid",origin:"${origin}"};`, pass: true },
      ...["ur%6e:", "ur&#110;:", "ｕｒｎ:", "ur\u200bn:", "urn%3a", "urn&#58;", "urn\\u003a"].map((scheme, index) => ({
        name: `review URI decoded opaque scheme ${index}`, text: `${scheme}fixture="${host}"`, pass: false,
      })),
      ...["\t ", "\u2028 ", "%09 ", "&#9; "].flatMap((separator, index) => [
        { name: `review whitespace quoted URI ownership ${index}`, text: `urn:${separator}"${host}"`, pass: false },
        { name: `review whitespace quoted email ownership ${index}`, text: `fixture@${separator}"${host}"`, pass: false },
        { name: `review whitespace JSON URI ownership ${index}`, text: `data:application/json,${separator}{"origin":"${host}"}`, pass: false },
      ]),
      { name: "review whitespace standalone quoted prose", text: `Relay: "${host}"`, pass: true },
      ...["%09 ", "&#9; ", "\t "].flatMap((separator, index) => [
        { name: `review quoted continuation host prefix ${index}`, text: `"other."${separator}"${host}"`, pass: false },
        { name: `review quoted continuation host suffix ${index}`, text: `${host}${separator}".example.invalid"`, pass: false },
        { name: `review quoted continuation path suffix ${index}`, text: `${origin} ${separator}"/private"`, pass: false },
        { name: `review quoted continuation URI prefix ${index}`, text: `"ur%6e:"${separator}"${host}"`, pass: false },
      ]),
      { name: "review quoted continuation decoded mailbox", text: `%22fixture@%22\t"${host}"`, pass: false },
      { name: "review quoted continuation single-quoted host", text: `other.\t '${host}'`, pass: false },
      { name: "review quoted continuation standalone newline terminator", text: `const relay = "${host}"\n;`, pass: true },
      { name: "review quoted continuation standalone newline object", text: `const relay = {\n"origin":\n"${origin}"\n};`, pass: true },
      { name: "review wrapped continuation opaque prefix", text: `("urn:")\t"${host}"`, pass: false },
      { name: "review wrapped continuation host prefix", text: `("other.")%09 "${host}"`, pass: false },
      { name: "review wrapped continuation quoted origin suffix", text: `("${origin}")\t"/private"`, pass: false },
      { name: "review wrapped continuation quoted path suffix", text: `"${origin}"\t("/private")`, pass: false },
      { name: "review wrapped continuation nested prefix", text: `(("ur%6e:"))&#9; (("${host}"))`, pass: false },
      { name: "review wrapped continuation nested suffix", text: `(("${origin}"))\t(("/private"))`, pass: false },
      { name: "review wrapped continuation standalone origin", text: `const relay = (("${origin}"));`, pass: true },
      { name: "review wrapped continuation standalone multiline origin", text: `const relay = (\n"${origin}"\n);`, pass: true },
      ...["/private", ":443", "?private=1", ".example.invalid"].map((suffix, index) => ({
        name: `review unquoted wrapped continuation suffix ${index}`, text: `("${origin}")\t${suffix}`, pass: false,
      })),
      { name: "review unquoted wrapped continuation bare quoted port", text: `"${origin}"\t:443`, pass: false },
      { name: "review unquoted wrapped continuation JSON tab suffix", text: `("${host}")\\t.example.invalid`, pass: false },
      { name: "review unquoted wrapped continuation JSON Unicode tab suffix", text: `("${host}")\\u0009.example.invalid`, pass: false },
      { name: "review unquoted wrapped continuation multiline JSON key", text: `{ "${host}"\n: true }`, pass: true },
      { name: "review unquoted wrapped continuation multiline statement", text: `const relay = ("${origin}")\n;`, pass: true },
      { name: "review unquoted wrapped continuation multiline line comment", text: `const relay = ("${origin}")\n// Public relay`, pass: true },
      { name: "review unquoted wrapped continuation multiline block comment", text: `const relay = ("${origin}")\n/* Public relay */`, pass: true },
      { name: "review compound concatenation assignment", text: `let relay = "other."; relay += "${host}";`, pass: false },
      { name: "review compound concatenation call assignment", text: `let relay = "other."; relay += String("${host}");`, pass: false },
      { name: "review compound PHP concatenation assignment", text: `$relay = "other."; $relay .= "${host}";`, pass: false },
      { name: "review standalone logical assignment", text: `let relay; relay ||= "${host}";`, pass: true },
      { name: "review compound format assignment", text: `relay = "other.%s"; relay %= "${host}"`, pass: false },
      { name: "review compound format call assignment", text: `relay = "other.%s"; relay %= str("${host}")`, pass: false },
      { name: "review compound conditional first branch", text: `let relay = "other."; relay += true ? "${host}" : "unused";`, pass: false },
      { name: "review compound conditional second branch", text: `let relay = "other."; relay += false ? "unused" : "${host}";`, pass: false },
      { name: "review compound conditional call branch", text: `let relay = "other."; relay += true ? String("${host}") : "unused";`, pass: false },
      { name: "review compound conditional multiline branch", text: `let relay = "other."; relay += true ?\nString("${host}")\n: "unused";`, pass: false },
      { name: "review standalone logical conditional assignment", text: `let relay; relay ||= true ? "${host}" : "unused";`, pass: true },
      { name: "review standalone assignment after compound comma", text: `let other, relay = ""; relay += "unused", other = "${host}";`, pass: true },
      { name: "review standalone declaration after compound newline", text: `let relay = ""; relay += "unused"\nconst other = "${host}";`, pass: true },
      { name: "review standalone assignment after compound newline", text: `let relay = ""; relay += "unused"\nrelay = "${host}";`, pass: true },
      ...[host, origin, discovery].flatMap((value, index) => [
        { name: `review source array value ${index}`, text: `const relays = {origin:["${value}"]};`, pass: true },
        { name: `review source nested array value ${index}`, text: `const relays = {origin:[["${value}"]]};`, pass: true },
        { name: `review source multiline array value ${index}`, text: `const relays = {origin:\n["${value}"]};`, pass: true },
        { name: `review URI array-shaped payload ${index}`, text: `data:,{origin:["${value}"]}`, pass: false },
      ]),
      { name: "review standalone unbalanced comment", text: `const relay = /* " */ "${origin}";`, pass: true },
      { name: "review commented prefix type assertion", text: `const relay = "other." + (<string> /* comment */ "${host}");`, pass: false },
      { name: "review spaced prefix type assertion", text: `const relay = "other." + (<string> "${host}");`, pass: false },
      { name: "review Lua commented operator prefix", text: `local relay = "other." .. -- comment
 "${host}"`, pass: false },
      { name: "review Lua commented operator suffix", text: `local relay = "${host}" -- comment
 .. ".example.invalid"`, pass: false },
      { name: "review SQL commented operator prefix", text: `SELECT 'other.' || -- comment
 '${host}'`, pass: false },
      { name: "review Python commented operator prefix", text: `relay = ("other." + # comment
 "${host}")`, pass: false },
      { name: "review Python commented operator suffix", text: `relay = ("${host}" # comment
 + ".example.invalid")`, pass: false },
      { name: "review Python Unicode concat", text: `relay = "other." + u"${host}"`, pass: false },
      { name: "review shell brace expansion suffix", text: `relay="${origin}"{,/private}`, pass: false },
      { name: "review prefix type assertion", text: `const relay = "other." + (<string>"${host}");`, pass: false },
      ...[["PHP", ".", "$relay = ", '"'], ["Lua", "..", "local relay = ", '"'], ["SQL", "||", "SELECT ", "'"]].flatMap(([language, operator, prefix, quote]) => [
        { name: `review ${language} operator prefix`, text: `${prefix}${quote}other.${quote} ${operator} ${quote}${host}${quote}`, pass: false },
        { name: `review ${language} operator suffix`, text: `${prefix}${quote}${origin}${quote} ${operator} ${quote}/private${quote}`, pass: false },
      ]),
      { name: "review Python percent interpolation prefix", text: `relay = "other.%s" % "${host}"`, pass: false },
      { name: "review Python percent interpolation suffix", text: `relay = "%s/private" % "${origin}"`, pass: false },
      { name: "review union assertion host suffix", text: `const relay = ("${host}" as string | null) + ".example.invalid";`, pass: false },
      { name: "review union assertion origin suffix", text: `const relay = ("${origin}" as string | null) + "/private";`, pass: false },
      { name: "review intersection assertion suffix", text: `const relay = ("${host}" as string & {}) + ".example.invalid";`, pass: false },
      { name: "review standalone const assertion", text: `const relay = "${origin}" as const;`, pass: true },
      { name: "review standalone satisfies", text: `const relay = "${host}" satisfies string;`, pass: true },
      { name: "review standalone string assertion", text: `const relay = ("${host}" as string);`, pass: true },
      { name: "review Python f-string port", text: `relay = f'{"${origin}"}:443'`, pass: false },
      { name: "review Python f-string prefix", text: `relay = f'other.{"${host}"}'`, pass: false },
      { name: "review Python f-string suffix", text: `relay = f'{"${host}"}.example.invalid'`, pass: false },
      { name: "review Python raw f-string email", text: `relay = rf'fixture@{"${host}"}'`, pass: false },
      { name: "review Python single quoted Unicode", text: `relay = u'${host}'`, pass: false },
      { name: "review Python single quoted raw", text: `relay = r'${host}'`, pass: false },
      { name: "review Python single quoted f-string literal", text: `relay = f'${host}'`, pass: false },
      { name: "review Python Unicode prefix adjacency", text: `relay = "other." u"${host}"`, pass: false },
      { name: "review Python raw suffix adjacency", text: `relay = "${origin}" r"/private"`, pass: false },
      { name: "review Python Unicode standalone", text: `relay = u"${host}"`, pass: false },
      { name: "review Python raw standalone", text: `relay = r"${host}"`, pass: false },
      { name: "review shell escaped punctuation", text: `relay="${origin}"${String.fromCharCode(92)};private`, pass: false },
      { name: "review shell ANSI literal suffix", text: `relay="${origin}"$'/private'`, pass: false },
      { name: "review Python commented adjacency", text: `relay = ("other." # comment
 "${host}")`, pass: false },
      { name: "review C commented adjacency", text: `const char* relay = "other." /* comment */ "${host}";`, pass: false },
      { name: "review JSON approved property key", text: JSON.stringify({ [host]: "public" }), pass: true },
      { name: "review shell port suffix", text: `relay="${origin}":443`, pass: false },
      { name: "review shell NFKC suffix", text: `relay="${host}"．example.invalid`, pass: false },
      { name: "review shell line continuation suffix", text: `relay="${origin}"${String.fromCharCode(92)}
:443`, pass: false },
      { name: "review Python adjacent prefix", text: `relay = "other." "${host}"`, pass: false },
      { name: "review Python adjacent suffix", text: `relay = "${origin}" "/private"`, pass: false },
      { name: "review Python multiline adjacency", text: `relay = ("other."
 "${host}")`, pass: false },
      { name: "review Python standalone literal", text: `relay = "${host}"`, pass: true },
      { name: "review shell adjacent prefix", text: `relay="other.""${host}"`, pass: false },
      { name: "review shell adjacent suffix", text: `relay="${origin}""/private"`, pass: false },
      { name: "review shell bare suffix", text: `relay="${origin}"/private`, pass: false },
      { name: "review shell bare host suffix", text: `relay="${host}".example.invalid`, pass: false },
      { name: "review shell email prefix", text: `relay="fixture@"'${host}'`, pass: false },
      { name: "review shell standalone literal", text: `relay="${origin}"`, pass: true },
      { name: "review non-null concat suffix", text: `const relay = "${host}"! + ".example.invalid";`, pass: false },
      { name: "review parenthesized non-null concat", text: `const relay = ("${host}"!) + ".example.invalid";`, pass: false },
      { name: "review non-null interpolation", text: `const relay = ${tick}other.\${"${host}"!}${tick};`, pass: false },
      { name: "review asserted concat prefix", text: `const relay = ("other." as string) + "${host}";`, pass: false },
      { name: "review asserted concat suffix", text: `const relay = ("${host}" as string) + ".example.invalid";`, pass: false },
      { name: "review satisfies concat prefix", text: `const relay = ("fixture@" satisfies string) + "${host}";`, pass: false },
      { name: "review asserted interpolation prefix", text: `const relay = ${tick}other.\${"${host}" as string}${tick};`, pass: false },
      { name: "review asserted interpolation suffix", text: `const relay = ${tick}\${"${host}" as string}.example.invalid${tick};`, pass: false },
      { name: "review satisfies interpolation", text: `const relay = ${tick}fixture@\${"${host}" satisfies string}${tick};`, pass: false },
      { name: "review template literal", text: `const relay = ${tick}${origin}${tick};`, pass: true },
      { name: "review standalone interpolation", text: `const relay = ${tick}${interpolation(host)}${tick};`, pass: true },
      { name: "review bare URI punctuation", text: `${discovery};private`, pass: false },
      { name: "review prose apostrophes", text: `It's "${host}" and it's live.`, pass: true },
      { name: "review prose apostrophes single quote", text: `It's '${host}' and it's live.`, pass: true },
      { name: "review prose boundary", text: `Ready. ${host}`, pass: true },
      { name: "review metadata boundary", text: `Ready.\0${host}\0`, pass: false },
      { name: "review shell attached brace prefix", text: `relay={other.,}"${host}"`, pass: false },
      { name: "review shell quoted brace prefix", text: `relay={"other.",}"${host}"`, pass: false },
      { name: "review shell standalone brace argument", text: `printf %s {other.,} "${host}"`, pass: true },
      { name: "review newline URI subdelimiter suffix", text: `${origin}\n!private`, pass: false },
      { name: "review newline encoded URI suffix", text: `${origin}\n%21private`, pass: false },
      { name: "review standalone arrow callback container", text: `const relays = values.map(() => ({relay: "${host}"}));`, pass: true },
      { name: "review standalone arrow literal", text: `const relay = () => "${host}";`, pass: true },
      { name: "review Python repetition prefix", text: `relay = 2 * "${host}"`, pass: false },
      { name: "review Python repetition suffix", text: `relay = "${host}" * 2`, pass: false },
      { name: "review Python parenthesized repetition", text: `relay = ("${host}") * 2`, pass: false },
      { name: "review Python conditional repetition", text: `relay = ("${host}" if True else "unused") * 2`, pass: false },
      ...["&", "~", "^", "<>"].flatMap((operator) => [
        { name: `review literal operator prefix ${operator}`, text: `relay = "other." ${operator} "${host}"`, pass: false },
        { name: `review literal operator suffix ${operator}`, text: `relay = "${host}" ${operator} ".example.invalid"`, pass: false },
      ]),
      { name: "review Ruby literal prefix", text: `relay = "other." << "${host}"`, pass: false },
      { name: "review Ruby literal suffix", text: `relay = "${host}" << ".example.invalid"`, pass: false },
      { name: "review Ruby nested operand", text: `relay = "other." << ("unused"; "${host}")`, pass: false },
      { name: "review enclosing first conditional suffix", text: `const relay = (true ? "${host}" : "unused") + ".example.invalid";`, pass: false },
      { name: "review enclosing conditional URI suffix", text: `const relay = (true ? "${origin}" : "unused") + "/private";`, pass: false },
      { name: "review enclosing first comma suffix", text: `const relay = ("${host}", "unused") + ".example.invalid";`, pass: false },
      { name: "review enclosing nested conditional suffix", text: `const relay = ((true ? "${host}" : "unused")) + ".example.invalid";`, pass: false },
      { name: "review newline hyphen suffix", text: `${host}\n-private`, pass: false },
      { name: "review newline underscore suffix", text: `${host}\n_private`, pass: false },
      { name: "review newline underscore prefix", text: `other_\n${host}`, pass: false },
      { name: "review following Markdown list", text: `${host}\n- List item`, pass: true },
      { name: "review enclosing comma operand", text: `const relay = "other." + ("unused", "${host}");`, pass: false },
      { name: "review enclosing ternary operand", text: `const relay = "other." + (true ? "unused" : "${host}");`, pass: false },
      { name: "review enclosing nested operand", text: `const relay = "other." + (("unused", ("${host}")));`, pass: false },
      { name: "review standalone comma operand", text: `const relay = ("unused", "${host}");`, pass: true },
      { name: "review newline URI query prefix", text: `https://example.invalid/?target=\n${host}`, pass: false },
      { name: "review newline URI punctuation suffix", text: `${origin}\n;private`, pass: false },
      { name: "review newline host label prefix", text: `other-\n${host}`, pass: false },
      { name: "review standalone Markdown list", text: `-\n${host}`, pass: true },
      { name: "review newline prefix", text: `other.\n${host}`, pass: false },
      { name: "review newline suffix", text: `${host}\n.example.invalid`, pass: false },
      { name: "review newline email", text: `fixture@\n${host}`, pass: false },
      ...[["tab", "\t"], ["line separator", "\u2028 "], ["paragraph separator", "\u2029 "],
        ["percent tab", "%09 "], ["entity tab", "&#9; "]].flatMap(([name, separator]) => [
        { name: `review whitespace email ${name}`, text: `fixture@${separator}${host}`, pass: false },
        { name: `review whitespace host prefix ${name}`, text: `other.${separator}${host}`, pass: false },
        { name: `review whitespace host suffix ${name}`, text: `${host} ${separator}.example.invalid`, pass: false },
      ]),
      ...["\n", "\t"].flatMap((separator, index) => ["--", "__", "%2d%2d", "&#45;&#45;"].flatMap((run, runIndex) => [
        { name: `review whitespace repeated prefix ${index} ${runIndex}`, text: `private${run}${separator}${host}`, pass: false },
        { name: `review whitespace repeated suffix ${index} ${runIndex}`, text: `${host}${separator}${run}private`, pass: false },
      ])),
      { name: "review whitespace standalone horizontal rule", text: `${host}\n---`, pass: true },
      { name: "review concatenated prefix", text: `const relay = "other." + "${host}";`, pass: false },
      { name: "review call operand String prefix", text: `const relay = "other." + String("${host}");`, pass: false },
      { name: "review call operand arrow prefix", text: `const relay = "other." + ((x)=>x)("${host}");`, pass: false },
      { name: "review call operand nested prefix", text: `const relay = "other." + String(String("${host}"));`, pass: false },
      { name: "review call operand method prefix", text: `const relay = "other." + helpers.identity("${host}");`, pass: false },
      { name: "review call operand comment prefix", text: `const relay = "other." + String /* comment */ ("${host}");`, pass: false },
      { name: "review call operand String suffix", text: `const relay = String("${host}") + ".example.invalid";`, pass: false },
      { name: "review call operand arrow suffix", text: `const relay = ((x)=>x)("${host}") + ".example.invalid";`, pass: false },
      { name: "review call operand concat method", text: `const relay = "other.".concat("${host}");`, pass: false },
      { name: "review call operand returned literal suffix", text: `const relay = (() => "${host}")() + ".example.invalid";`, pass: false },
      { name: "review call operand shell substitution prefix", text: `relay=other.$(printf %s "${host}")`, pass: false },
      { name: "review call operand indexed array suffix", text: `const relay = ["${host}"][0] + ".example.invalid";`, pass: false },
      { name: "review call operand indexed tuple suffix", text: `relay = ("${host}",)[0] + ".example.invalid"`, pass: false },
      { name: "review call operand indexed literal method", text: `const relay = ("${host}")["concat"](".example.invalid");`, pass: false },
      { name: "review call operand standalone typed call", text: `const relay = identity<string>("${host}");`, pass: false },
      { name: "review call operand standalone typed collection", text: `const relays = new Set<string>(["${host}"]);`, pass: false },
      { name: "review call operand attached typed call", text: `const relay = "other." + identity<string>("${host}");`, pass: false },
      { name: "review call operand Ruby prefix", text: `relay = "other." << String("${host}")`, pass: false },
      { name: "review call operand private method prefix", text: `class Relay {\n#identity(x){return x;}\nmake(){return "other." + this.#identity("${host}");}}`, pass: false },
      { name: "review call operand private method body", text: `class Relay {\n#make(){return "other." + String("${host}");}\nmake(){return this.#make();}}`, pass: false },
      { name: "review call operand spaced private method", text: `class Relay {\n#identity(x){return x;}\nmake(){return "other." + this. #identity("${host}");}}`, pass: false },
      { name: "review call operand standalone private method", text: `class Relay {\n#identity(x){return x;}\nmake(){return this.#identity("${host}");}}`, pass: false },
      { name: "review call operand here-doc prefix", text: `relay=other.$(cat <<EOF\n${host}\nEOF\n)`, pass: false },
      { name: "review call operand here-doc suffix", text: `relay=$(cat <<EOF\n${host}\nEOF\n).example.invalid`, pass: false },
      { name: "review call operand optional receiver method", text: `const relay = ("${host}")?.concat(".example.invalid");`, pass: false },
      { name: "review call operand optional indexed suffix", text: `const relay = ["${host}"]?.[0] + ".example.invalid";`, pass: false },
      { name: "review call operand optional literal callee", text: `const relay = "other."?.concat("${host}");`, pass: false },
      { name: "review call operand optional call prefix", text: `const relay = "other." + String?.("${host}");`, pass: false },
      { name: "review call operand optional member prefix", text: `const relay = "other." + helpers?.identity("${host}");`, pass: false },
      { name: "review call operand standalone optional call", text: `const relay = String?.("${host}");`, pass: true },
      { name: "review call operand standalone optional member", text: `const relay = helpers?.identity("${host}");`, pass: true },
      { name: "review call operand standalone optional index", text: `const relay = ["${host}"]?.[0];`, pass: false },
      { name: "review concatenated suffix", text: `const relay = '${host}' + '.example.invalid';`, pass: false },
      { name: "review concatenated email", text: `const relay = "fixture@" +\n "${host}";`, pass: false },
      { name: "review concatenated origin", text: `const relay = "${origin}" + ":443";`, pass: false },
      ...[["FF", 12], ["VT", 11], ["LS", 0x2028], ["PS", 0x2029]].flatMap(([name, code]) => [
        { name: `review concat whitespace prefix ${name}`, text: `const relay = "other." +${String.fromCharCode(Number(code))}"${host}";`, pass: false },
        { name: `review concat whitespace suffix ${name}`, text: `const relay = "${host}"${String.fromCharCode(Number(code))}+ ".example.invalid";`, pass: false },
      ]),
      ...[0x2028, 0x2029].map((code) => ({
        name: `review line comment terminator ${code}`,
        text: `const relay = "other." // comment${String.fromCharCode(code)}+ "${host}";`, pass: false,
      })),
      { name: "review string line continuation", text: `const relay = "other.${String.fromCharCode(92)}\n" + "${host}";`, pass: false },
      { name: "review commented prefix", text: `const relay = "other." /* comment */ + "${host}";`, pass: false },
      { name: "review parenthesized prefix", text: `const relay = ("other.") + ("${host}");`, pass: false },
      { name: "review commented suffix", text: `const relay = "${host}" + /* comment */ ".example.invalid";`, pass: false },
      { name: "review parenthesized suffix", text: `const relay = ("${host}") + (".example.invalid");`, pass: false },
      { name: "review line-commented email", text: `const relay = "fixture@" // comment\n + "${host}";`, pass: false },
      { name: "review JSON unicode email", text: `{"relay":"${unicode(["fixture", domain].join("@"))}"}`, pass: false },
      { name: "review JSON unicode subdomain", text: `{"relay":"${unicode(`other.${domain}`)}"}`, pass: false },
      { name: "review JSON escaped dot", text: JSON.stringify({ relay: domain }).replace(".", "\\u002e"), pass: false },
      { name: "review JSON escaped letter", text: JSON.stringify({ relay: domain }).replace(domain[0], unicode(domain[0])), pass: false },
      { name: "review JSON escaped email", text: JSON.stringify({ relay: unicode(["fixture", domain].join("@")) }), pass: false },
      { name: "review JSON escaped subdomain", text: JSON.stringify({ relay: unicode(`other.${domain}`) }), pass: false },
      { name: "review JSON escaped host", text: `{"relay":"${unicode(host)}"}`, pass: false },
      { name: "review JSON escaped origin", text: `{"relay":"${unicode(origin)}"}`, pass: false },
      { name: "review JSON escaped discovery", text: `{"relay":"${unicode(discovery)}"}`, pass: false },
      { name: "review JSON escaped prefix", text: `{"relay":"other\\u002e${host}"}`, pass: false },
      { name: "review JSON escaped suffix", text: `{"relay":"${host}\\u002eexample.invalid"}`, pass: false },
      { name: "bare domain", text: domain, pass: false },
      { name: "base-domain email", text: ["fixture", domain].join("@"), pass: false },
      { name: "approved-host email", text: ["fixture", host].join("@"), pass: false },
      { name: "other subdomain", text: `other.${domain}`, pass: false },
      { name: "nested subdomain", text: `other.${host}`, pass: false },
      { name: "host prefix", text: `other${host}`, pass: false },
      { name: "host suffix", text: `${host}other`, pass: false },
      { name: "domain suffix", text: `${origin}.example.invalid`, pass: false },
      { name: "userinfo", text: `${origin}@example.invalid`, pass: false },
      { name: "HTTP", text: origin.replace("https:", "http:"), pass: false },
      { name: "port", text: `${origin}:443`, pass: false },
      { name: "other path", text: `${origin}/private`, pass: false },
      { name: "discovery suffix", text: `${discovery}/private`, pass: false },
      { name: "query", text: `${origin}?private=1`, pass: false },
      { name: "fragment", text: `${origin}#private`, pass: false },
      { name: "percent host", text: percent(host), pass: false },
      { name: "entity host", text: entities(host), pass: false },
      { name: "NFKC host", text: fullWidth(host), pass: false },
      { name: "percent domain", text: percent(domain), pass: false },
      { name: "entity domain", text: entities(domain), pass: false },
      { name: "NFKC domain", text: fullWidth(domain), pass: false },
      { name: "encoded email boundary", text: `fixture%40${host}`, pass: false },
      { name: "entity subdomain boundary", text: `other&#46;${host}`, pass: false },
      { name: "NFKC suffix boundary", text: `${origin}．example.invalid`, pass: false },
      { name: "invisible subdomain boundary", text: `other.\u200b${host}`, pass: false },
      { name: "Markdown-split host", text: host.replace(".", "**.**"), pass: false },
      { name: "Markdown prefix boundary", text: `other.\`${host}\``, pass: false },
      { name: "Markdown suffix boundary", text: `\`${host}\`.example.invalid`, pass: false },
      { name: "Markdown scheme boundary", text: `https://\`${host}\``, pass: false },
      { name: "Markdown label boundary", text: `other.[${host}](https://example.invalid)`, pass: false },
      { name: "mixed-case host", text: host.toUpperCase(), pass: false },
      { name: "approved and private together", text: `${origin}\n${domain}`, pass: false },
      { name: "marker collision", text: `${String.fromCharCode(0xe000)}\n${origin}`, pass: false },
      { name: "encoded marker collision", text: `${["EE", "80", "80"].map((byte) => `%${byte}`).join("")}\n${origin}`, pass: false },
      { name: "entity marker collision", text: `${["&#", "57344", ";"].join("")}\n${origin}`, pass: false },
    ];
    const sources = ["committed catalog", "compact fingerprint", "exact fingerprint", "compact env", "exact env", "compact file", "exact file", "plain env", "plain file"];
    function configuration(directory: string, source: string): Record<string, string> {
      const environment: Record<string, string> = {
        LLV_PRIVACY_KNOWN_VALUES: "", LLV_PRIVACY_KNOWN_VALUES_FILE: "",
        LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE: "", LLV_PRIVACY_KNOWN_VALUES_FORMAT: "plain",
      };
      if (source === "committed catalog") {
        environment.LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE = join(import.meta.dir, "privacy-known-value-fingerprints.json");
      } else {
        const entry = { value: domain, exactOnly: source.startsWith("exact") };
        const path = join(directory, ".git", "known.json");
        if (source.endsWith("fingerprint")) {
          writeFileSync(path, JSON.stringify({ schemaVersion: 1, normalization: "nfkc-lower-alnum-v1",
            fingerprints: [knownValueFingerprint(entry)] }));
          environment.LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE = path;
        } else {
          const serialized = source.startsWith("plain") ? domain : JSON.stringify(entry);
          environment.LLV_PRIVACY_KNOWN_VALUES_FORMAT = source.startsWith("plain") ? "plain" : "jsonl";
          if (source.endsWith("file")) {
            writeFileSync(path, serialized);
            environment.LLV_PRIVACY_KNOWN_VALUES_FILE = path;
          } else environment.LLV_PRIVACY_KNOWN_VALUES = serialized;
        }
      }
      return environment;
    }
    const boundedCases = [
      ...[
        ["block comments", "/* ".repeat(200_000)],
        ["templates", tick + String.fromCharCode(92, 96).repeat(200_000)],
        ["double quotes", String.fromCharCode(34) + String.fromCharCode(92, 34).repeat(200_000)],
        ["single quotes", String.fromCharCode(39) + String.fromCharCode(92, 39).repeat(200_000)],
      ].map(([name, fragment]) => ({ name: `unclosed ${name}`, text: `${fragment} ${host}`, pass: false, budget: 10_000 })),
      ...["/private", "", ";"].map((suffix, index) => ({ name: `nested closing delimiters ${index}`, text: "(".repeat(200_000) + `"${host}"` + ")".repeat(200_000) + suffix, pass: false, budget: 10_000 })),
      { name: "unclosed regex classes", text: `${"/[".repeat(100_000)} "${host}"`, pass: false, budget: 10_000 },
      { name: "long identifiers", text: `${"a".repeat(200_000)},"${host}"`, pass: true, budget: 10_000 },
      { name: "repeated declarations", text: `${"const a: ".repeat(30_000)}"${host}"`, pass: true, budget: 10_000 },
      { name: "large unquoted tokens", text: `(${host})`.repeat(4000), pass: false, budget: 3000 },
      { name: "large chained calls", text: `relay${`("${host}")`.repeat(100_000)};`, pass: false, budget: 10_000 },
      { name: "large quoted JSON", text: JSON.stringify(Array(10_000).fill(host)), pass: true, budget: 3000 },
    ];
    for (const specimen of boundedCases) test(`${specimen.name}: all sources stay bounded`, async () => {
      const directory = mkdtempSync(join(tmpdir(), "llv-privacy-public-"));
      temporaryDirectories.push(directory);
      const publication = join(directory, "bounded.ts");
      writeFileSync(publication, specimen.text);
      const batches = sources.map((source, index) => {
        const root = join(directory, `source-${index}`);
        mkdirSync(join(root, ".git"), { recursive: true });
        return { source, environment: configuration(root, source) };
      });
      // One isolated child per pathological input. Each child loads
      // every source independently and reports timings/findings per source.
      const child = Bun.spawn([process.execPath, "--eval", `
        const request = JSON.parse(await Bun.stdin.text());
        const results = [];
        for (const [index, batch] of request.batches.entries()) {
          Object.assign(process.env, batch.environment);
          const scanner = await import(request.gate + "?bounded=" + index);
          const started = performance.now();
          const findings = scanner.inspectPaths([request.publication], false, true);
          results.push({ source: batch.source, elapsed: performance.now() - started,
            findings: [...findings.keys()], report: scanner.formatPrivacyReport(findings) });
        }
        process.stdout.write(JSON.stringify(results));
      `], { stdin: Buffer.from(JSON.stringify({ gate, publication, batches })), stdout: "pipe", stderr: "pipe" });
      const timeout = setTimeout(() => child.kill("SIGKILL"), specimen.budget * sources.length);
      try {
        const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect(code).toBe(0);
        expect(stderr).toBe("");
        const results: { source: string; elapsed: number; findings: string[]; report: string }[] = JSON.parse(stdout);
        expect(results.map((result) => result.source)).toEqual(sources);
        for (const result of results) {
          expect(result.elapsed, result.source).toBeLessThan(specimen.budget);
          expect(result.findings.length === 0, result.source).toBe(specimen.pass);
          expect(result.findings.includes("known_value"), result.source).toBe(!specimen.pass);
          expect(result.report).not.toContain(domain);
        }
      } finally {
        clearTimeout(timeout);
        // This PID belongs to this test. Reap it even if a read/assertion fails.
        if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
      }
    }, 100_000);
    for (const source of sources) {
      test(`${source}: file, commit and merge-identity batches assert every specimen`, async () => {
        const directory = mkdtempSync(join(tmpdir(), "llv-privacy-public-"));
        temporaryDirectories.push(directory);
        mkdirSync(join(directory, ".git"));
        const environment = configuration(directory, source);
        const saved = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
        try {
          Object.assign(process.env, environment);
          // Each source gets its own module instance: known values are loaded at
          // import time. Restore the environment before leaving this batch.
          const modulePath = `${gate}?relay-source=${encodeURIComponent(source)}`;
          const scanner: typeof import("./privacy-publication-gate") = await import(modulePath);
          // Inspect the complete source bytes once per source configuration.
          // File/line attribution has dedicated CLI regressions elsewhere.
          const sourceFindings = scanner.inspectPaths([gate, import.meta.path], false, true, directory);
          expect(scanner.formatPrivacyReport(sourceFindings)).toBe("PRIVACY GATE: PASS\n");
          const credentialPath = join(directory, "credential.ts");
          writeFileSync(credentialPath, `password="${origin}"`);
          expect(scanner.formatPrivacyReport(scanner.inspectPaths([credentialPath], false, true)))
            .toBe("PRIVACY GATE: FAIL\ncredential: 1\n");
          const toolEnvironment = installTool(directory, "tesseract", 'printf "%s" "$OCR_TEXT"');
          const savedPath = process.env.PATH;
          const savedOcr = process.env.OCR_TEXT;
          const which = Bun.which.bind(Bun);
          const toolLookup = spyOn(Bun, "which").mockImplementation((command, options) =>
            command === "tesseract" ? join(directory, "tesseract") : which(command, options));
          try {
            Object.assign(process.env, toolEnvironment);
            for (const channel of ["metadata", "OCR"]) {
              for (const specimen of cases.filter((c) => ["host", "origin", "discovery", "other subdomain", "percent host"].includes(c.name))) {
                const publication = join(directory, "publication.png");
                writeFileSync(publication, pngWithMetadata(channel === "metadata" ? specimen.text : "Synthetic fixture"));
                process.env.OCR_TEXT = channel === "OCR" ? specimen.text : "";
                const findings = scanner.inspectPaths([publication], false, false);
                expect(findings.has("known_value"), `${channel}: ${specimen.name}: ${scanner.formatPrivacyReport(findings)}`).toBe(channel === "metadata" || !specimen.pass);
                expect(findings.has("provenance_missing")).toBe(true);
                expect(scanner.formatPrivacyReport(findings)).not.toContain(domain);
              }
            }
          } finally {
            toolLookup.mockRestore();
            if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
            if (savedOcr === undefined) delete process.env.OCR_TEXT; else process.env.OCR_TEXT = savedOcr;
          }
          const publications = cases.map((specimen, index) => {
            const extension = specimen.name.includes("JSON") ? ".json" : specimen.name.includes("shell") ? ".sh" : specimen.name.includes("Python") ? ".py" : specimen.name === "test code" ? ".test.ts" : ".ts";
            const filename = `case-${index}${extension}`;
            const path = join(directory, filename);
            writeFileSync(path, specimen.text);
            return { path, digest: createHash("sha256").update(filename).digest("hex") };
          });
          const fileNotices: string[] = [];
          const fileFindings = scanner.inspectPaths(publications.map((publication) => publication.path), false, true, directory, undefined, fileNotices);
          const attributed = new Set(fileNotices.map((notice) => `${notice.split(" ")[0].split(":")[1]} ${notice.split(" ")[1]}`));
          // Configuration/path failures cannot silently escape case mapping.
          expect([...fileFindings.values()].reduce((sum, count) => sum + count, 0)).toBe(attributed.size);
          const reportedFiles = new Set(fileNotices.map((notice) => notice.split(" ")[0].split(":")[1]));
          const knownFiles = new Set(fileNotices.filter((notice) => notice.endsWith(" known_value")).map((notice) => notice.split(" ")[0].split(":")[1]));
          const fileReport = scanner.formatPrivacyReport(fileFindings, fileNotices);
          expect(fileReport).not.toContain(domain);
          const caseNotices = new Map<string, string[]>();
          for (const notice of fileNotices) {
            const digest = notice.split(" ")[0].split(":")[1];
            const notices = caseNotices.get(digest) ?? [];
            notices.push(notice);
            caseNotices.set(digest, notices);
          }
          for (const [index, specimen] of cases.entries()) {
            const digest = publications[index].digest;
            expect(reportedFiles.has(digest), specimen.name).toBe(!specimen.pass);
            expect(knownFiles.has(digest), specimen.name).toBe(!specimen.pass);
            expect((caseNotices.get(digest) ?? []).join("\n")).not.toContain(domain);
          }
          const identityCases = cases.filter((c) => ["host", "origin", "discovery", "other subdomain", "base-domain email",
        "review shell bare prefix", "review shell bare suffix", "review shell port suffix"].includes(c.name)
        || c.name.startsWith("review Unicode zero-width shell")
        || c.name.startsWith("review Unicode NFKC shell")
        || c.name.startsWith("raw quoted wrapper suffix")
        || c.name.startsWith("raw bare ")
        || c.name.startsWith("raw entity comment ")
        || c.name.startsWith("raw entity quoted comment ")
        || c.name.startsWith("raw Unicode trivia ")
        || c.name.startsWith("raw template group ")
        || c.name.startsWith("raw encoded ")
        || (c.name.startsWith("raw comment ") && !c.text.includes("\n"))
        || (c.name.startsWith("raw trivia ") && !(c.pass && c.text.includes("\n")))
        || /^(?:raw (?:call|index|nested call|multi argument call) (?:prefix|suffix)|raw standalone (?:call|index))/.test(c.name));
          const commitCases = cases.filter((c) => !c.text.includes("\0") && (["host", "origin", "discovery", "bare domain", "base-domain email", "percent host", "quoted code", "test code", "JSON"].includes(c.name) || ((c.name.startsWith("review ") || c.name.startsWith("raw ")) && c.name !== "review metadata boundary")));
          for (const [channel, specimens] of [["identity", identityCases], ["commit", commitCases]] as const) {
            const repository = join(directory, channel);
            mkdirSync(repository);
            runGit(repository, ["init", "--quiet"]);
            // fast-import preserves git's recorded identity/message behavior
            // without initializing and committing a new repository per case.
            const records = [{ name: "base", text: "base", pass: true }, ...specimens];
            const stream = records.map((specimen, index) => {
              const name = channel === "identity" && index > 0 ? specimen.text.replace(/[\n<>]/g, "").replace(/^[\x09-\x0d ]+|[\x09-\x0d ]+$/g, "") : "Fixture Tool";
              const message = channel === "commit" ? specimen.text + "\n" : "fixture\n";
              return `commit refs/heads/matrix\nmark :${index + 1}\ncommitter ${name} <noreply@example.invalid> ${index + 1} +0000\ndata ${Buffer.byteLength(message)}\n${message}\n`;
            }).join("");
            const imported = Bun.spawnSync(["git", "fast-import", "--quiet", "--export-marks=.git/marks"], { cwd: repository, stdin: Buffer.from(stream), stdout: "pipe", stderr: "pipe" });
            expect(imported.exitCode, imported.stderr.toString()).toBe(0);
            runGit(repository, ["symbolic-ref", "HEAD", "refs/heads/matrix"]);
            const hashes = readFileSync(join(repository, ".git/marks"), "utf8").trim().split("\n").map((line) => line.split(" ")[1]);
            const notices: string[] = [];
            const findings = channel === "identity"
              ? (() => { const result = scanner.mergeBoundaryReview(repository, hashes[0]); notices.push(...result.notices); return result.findings; })()
              : scanner.commitMessageFindings(repository, hashes[0], notices);
            expect(findings.has("inspection_error")).toBe(false);
            const reported = new Set(notices.map((notice) => notice.split(" ")[1]));
            const known = new Set(notices.filter((notice) => notice.includes("known_value")).map((notice) => notice.split(" ")[1]));
            for (const [index, specimen] of specimens.entries()) {
              const hash = hashes[index + 1].slice(0, 12);
              expect(reported.has(hash), `${channel}: ${specimen.name}`).toBe(!specimen.pass);
              expect(known.has(hash), `${channel}: ${specimen.name}`).toBe(!specimen.pass);
            }
            expect(scanner.formatPrivacyReport(findings, notices)).not.toContain(domain);
          }
        } finally {
          for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
          }
        }
      }, 60_000);
    }
  });

  describe("exactOnly known values", () => {
    const words = ["fresh", "water"];
    const value = words.join("");
    const fullWidth = (text: string) => [...text].map((character) =>
      String.fromCharCode(character.charCodeAt(0) + 0xfee0)).join("");
    const spellings = [
      { name: "space", text: words.join(" "), contiguous: false },
      { name: "hyphen", text: words.join("-"), contiguous: false },
      { name: "underscore", text: words.join("_"), contiguous: false },
      { name: "decoded space", text: words.join("%20"), contiguous: false },
      { name: "entity space", text: words.join("&Tab;"), contiguous: false },
      { name: "plain text", text: value, contiguous: true },
      { name: "URL", text: `https://example.invalid/${value}`, contiguous: true },
      { name: "path", text: `/workspace/${value}/file`, contiguous: true },
      { name: "mailbox", text: `${value}@example.invalid`, contiguous: true },
      { name: "handle", text: `@${value}`, contiguous: true },
      { name: "identifier", text: `prefix${value}suffix`, contiguous: true },
      { name: "HTML attribute", text: `<a href="https://example.invalid/${value}">label</a>`, contiguous: true },
      { name: "mixed case", text: words.map((word) => word[0].toUpperCase() + word.slice(1)).join(""), contiguous: true },
      { name: "NFKC", text: fullWidth(value), contiguous: true },
      { name: "percent decoded", text: [...value].map((c) => `%${c.charCodeAt(0).toString(16)}`).join(""), contiguous: true },
      { name: "entity decoded", text: [...value].map((c) => `&#${c.charCodeAt(0)};`).join(""), contiguous: true },
    ];
    for (const source of ["fingerprint", "raw file", "environment"] as const) {
      for (const exactOnly of [true, false]) {
        for (const spelling of spellings) {
          test(`${source} exactOnly=${exactOnly} ${spelling.name}`, () => {
            const directory = mkdtempSync(join(tmpdir(), "llv-privacy-exact-"));
            temporaryDirectories.push(directory);
            const publication = join(directory, "publication.md");
            const configuration = join(directory, "known.json");
            writeFileSync(publication, spelling.text);
            const entry = { value, ...(exactOnly ? { exactOnly: true } : {}) };
            const environment: Record<string, string> = {
              LLV_PRIVACY_KNOWN_VALUES: "",
              LLV_PRIVACY_KNOWN_VALUES_FILE: "",
              LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE: "",
            };
            if (source === "fingerprint") {
              writeFileSync(configuration, JSON.stringify({
                schemaVersion: 1, normalization: "nfkc-lower-alnum-v1",
                fingerprints: [{ length: value.length, sha256: createHash("sha256").update(value).digest("hex"),
                  ...(exactOnly ? { exactOnly: true } : {}) }],
              }));
              environment.LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE = configuration;
            } else {
              const input = exactOnly ? JSON.stringify(entry) : value;
              environment.LLV_PRIVACY_KNOWN_VALUES_FORMAT = exactOnly ? "jsonl" : "plain";
              if (source === "raw file") {
                writeFileSync(configuration, input);
                environment.LLV_PRIVACY_KNOWN_VALUES_FILE = configuration;
              } else environment.LLV_PRIVACY_KNOWN_VALUES = input;
            }
            const result = runGate([publication], environment);
            expect(result.exitCode).toBe(!exactOnly || spelling.contiguous ? 1 : 0);
            expect(result.stdout.toString().includes("known_value:")).toBe(!exactOnly || spelling.contiguous);
            expect(result.stdout.toString()).not.toContain(value);
            expect(result.stderr.toString()).toBe("");
          });
        }
      }
    }

    for (const exactOnly of [true, false]) {
      for (const contiguous of [true, false]) {
        test(`commit exactOnly=${exactOnly} contiguous=${contiguous}`, () => {
          const directory = mkdtempSync(join(tmpdir(), "llv-privacy-exact-"));
          temporaryDirectories.push(directory);
          runGit(directory, ["init", "--quiet"]);
          runGit(directory, ["config", "user.name", "Fixture Tool"]);
          runGit(directory, ["config", "user.email", "noreply@example.invalid"]);
          runGit(directory, ["commit", "--allow-empty", "-m", "base"]);
          runGit(directory, ["commit", "--allow-empty", "-m", contiguous ? value : words.join(" ")]);
          const configuration = join(directory, ".git", "known.json");
          writeFileSync(configuration, JSON.stringify({ schemaVersion: 1, normalization: "nfkc-lower-alnum-v1",
            fingerprints: [{ length: value.length, sha256: createHash("sha256").update(value).digest("hex"),
              ...(exactOnly ? { exactOnly: true } : {}) }] }));
          const result = runGateArguments(["--base", "HEAD~1", "--check-commits"], {
            LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE: configuration,
          }, directory);
          expect(result.exitCode).toBe(!exactOnly || contiguous ? 1 : 0);
          expect(result.stdout.toString().includes("known_value:")).toBe(!exactOnly || contiguous);
          expect(result.stderr.toString()).toBe("");
        });
      }
    }

    for (const exactOnly of [true, false]) {
      for (const contiguous of [true, false]) {
        test(`OCR exactOnly=${exactOnly} contiguous=${contiguous}`, () => {
          const directory = mkdtempSync(join(tmpdir(), "llv-privacy-exact-"));
          temporaryDirectories.push(directory);
          const generation = generatePrivacyPlaceholders(directory);
          expect(generation.exitCode).toBe(0);
          const imagePath = "docs/acceptance/issue-290/readiness-kanban.png";
          const image = join(directory, imagePath);
          const ocrText = contiguous ? fullWidth(value) : words.join("-");
          const configuration = join(directory, "known.json");
          writeFileSync(configuration, JSON.stringify({ schemaVersion: 1, normalization: "nfkc-lower-alnum-v1",
            fingerprints: [{ length: value.length, sha256: createHash("sha256").update(value).digest("hex"),
              ...(exactOnly ? { exactOnly: true } : {}) }] }));
          const result = runGateArguments(["--repository", directory, "--paths", image], {
            ...installTool(directory, "tesseract", 'printf "%s" "$OCR_TEXT"'),
            LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE: configuration,
            OCR_TEXT: ocrText,
          });
          expect(result.exitCode).toBe(!exactOnly || contiguous ? 1 : 0);
          const output = result.stdout.toString();
          expect(output).toBe(!exactOnly || contiguous
            ? `PRIVACY GATE: FAIL\nknown_value: 1\n${fileNotice(imagePath, "known_value")}\n` : "PRIVACY GATE: PASS\n");
          expect(output).not.toContain(imagePath);
          expect(output).not.toContain(image);
          expect(output).not.toContain(ocrText);
          expect(output).not.toContain(value);
          expect(result.stderr.toString()).toBe("");
        });
      }
    }

    for (const policy of ["true", null, 1]) {
      test(`rejects malformed exactOnly policy ${JSON.stringify(policy)}`, () => {
        const directory = mkdtempSync(join(tmpdir(), "llv-privacy-exact-"));
        temporaryDirectories.push(directory);
        const configuration = join(directory, "known.json");
        const publication = join(directory, "publication.md");
        writeFileSync(publication, "Synthetic safe text");
        writeFileSync(configuration, JSON.stringify({ schemaVersion: 1, normalization: "nfkc-lower-alnum-v1",
          fingerprints: [{ length: value.length, sha256: createHash("sha256").update(value).digest("hex"), exactOnly: policy }] }));
        const result = runGate([publication], { LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE: configuration });
        expect(result.exitCode).toBe(1);
        expect(result.stdout.toString()).toBe("PRIVACY GATE: FAIL\nconfiguration_error: 1\n");
      });
    }

    test("compact policy survives a duplicate exactOnly fingerprint", () => {
      const directory = mkdtempSync(join(tmpdir(), "llv-privacy-exact-"));
      temporaryDirectories.push(directory);
      const configuration = join(directory, "known.json");
      const publication = join(directory, "publication.md");
      writeFileSync(publication, words.join(" "));
      const fingerprint = { length: value.length, sha256: createHash("sha256").update(value).digest("hex") };
      writeFileSync(configuration, JSON.stringify({ schemaVersion: 1, normalization: "nfkc-lower-alnum-v1",
        fingerprints: [fingerprint, { ...fingerprint, exactOnly: true }] }));
      const result = runGate([publication], { LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE: configuration });
      expect(result.exitCode).toBe(1);
      expect(result.stdout.toString()).toBe("PRIVACY GATE: FAIL\nknown_value: 1\n");
    });

    test("preserves JSON-looking legacy values without format opt-in", () => {
      const directory = mkdtempSync(join(tmpdir(), "llv-privacy-exact-"));
      temporaryDirectories.push(directory);
      const input = join(directory, "known.txt");
      const output = join(directory, "catalog.json");
      const publication = join(directory, "publication.md");
      const legacyValue = `{${value}}`;
      writeFileSync(input, legacyValue);
      writeFileSync(publication, words.join(" "));
      const raw = runGate([publication], { LLV_PRIVACY_KNOWN_VALUES: legacyValue,
        LLV_PRIVACY_KNOWN_VALUES_FILE: "", LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE: "",
        LLV_PRIVACY_KNOWN_VALUES_FORMAT: "plain" });
      expect(raw.stdout.toString()).toBe("PRIVACY GATE: FAIL\nknown_value: 1\n");
      const generated = Bun.spawnSync({ cmd: [process.execPath,
        join(import.meta.dir, "generate-privacy-known-value-fingerprints.ts"), "--input", input, "--output", output],
        stdout: "pipe", stderr: "pipe" });
      expect(generated.exitCode).toBe(0);
    });

    test("preserves legacy generator NFKC expansion before length filtering", () => {
      const directory = mkdtempSync(join(tmpdir(), "llv-privacy-exact-"));
      temporaryDirectories.push(directory);
      const input = join(directory, "known.txt");
      const output = join(directory, "catalog.json");
      const legacyValue = String.fromCodePoint(0x337f);
      writeFileSync(input, legacyValue);
      const generated = Bun.spawnSync({ cmd: [process.execPath,
        join(import.meta.dir, "generate-privacy-known-value-fingerprints.ts"), "--input", input, "--output", output],
        stdout: "pipe", stderr: "pipe" });
      expect(generated.exitCode).toBe(0);
      expect(JSON.parse(readFileSync(output, "utf8")).fingerprints).toEqual([{
        length: 4, sha256: createHash("sha256").update(legacyValue.normalize("NFKC")).digest("hex"),
      }]);
    });

    test("generator preserves exactOnly and legacy entries", () => {
      const directory = mkdtempSync(join(tmpdir(), "llv-privacy-exact-"));
      temporaryDirectories.push(directory);
      const input = join(directory, "known.txt");
      const output = join(directory, "catalog.json");
      writeFileSync(input, `${JSON.stringify({ value, exactOnly: true })}\n${["fixture", "legacy"].join("-")}\n`);
      const result = Bun.spawnSync({ cmd: [process.execPath,
        join(import.meta.dir, "generate-privacy-known-value-fingerprints.ts"), "--input", input, "--output", output, "--json-lines"],
        stdout: "pipe", stderr: "pipe" });
      expect(result.exitCode).toBe(0);
      const catalog = JSON.parse(readFileSync(output, "utf8"));
      expect(catalog.fingerprints).toContainEqual({ length: value.length,
        sha256: createHash("sha256").update(value).digest("hex"), exactOnly: true });
      expect(catalog.fingerprints).toContainEqual({ length: 13,
        sha256: createHash("sha256").update(["fixture", "legacy"].join("")).digest("hex") });
      expect(readFileSync(output, "utf8")).not.toContain(value);
    });
  });

  test("generates a value-free fingerprint catalog from an operator file", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const input = join(directory, "known-values.txt");
    const output = join(directory, "fingerprints.json");
    const knownLabel = ["fixture", "private", "catalog", "label"].join("-");
    writeFileSync(input, `${knownLabel}\n`);

    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        join(import.meta.dir, "generate-privacy-known-value-fingerprints.ts"),
        "--input",
        input,
        "--output",
        output,
      ],
      stderr: "pipe",
      stdout: "pipe",
    });
    const catalog = readFileSync(output, "utf8");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("FINGERPRINT CATALOG: PASS\nfingerprint_count: 1\n");
    expect(result.stderr.toString()).toBe("");
    expect(catalog).not.toContain(knownLabel);
    expect(catalog).toContain(createHash("sha256").update(knownLabel.replaceAll("-", "")).digest("hex"));
  });

  test("rejects fingerprint catalogs reached through symlinked ancestors", () => {
    const root = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(root);
    const realDirectory = join(root, "real-catalog");
    mkdirSync(realDirectory);
    const catalog = join(realDirectory, "known-values.json");
    writeFingerprintCatalog(catalog, `fixture-${process.pid}-catalog-value`);
    const linkedDirectory = join(root, "linked-catalog");
    symlinkSync(realDirectory, linkedDirectory);
    const publication = join(root, "publication.md");
    writeFileSync(publication, "Synthetic publication.\n");

    const result = runGateArguments(["--require-known-values", "--paths", publication], {
      LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE: join(linkedDirectory, "known-values.json"),
      LLV_PRIVACY_KNOWN_VALUES: "",
      LLV_PRIVACY_KNOWN_VALUES_FILE: "",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("PRIVACY GATE: FAIL\nconfiguration_error: 1\n");
    expect(result.stdout.toString()).not.toContain(root);
    expect(result.stderr.toString()).toBe("");
  });

  test("rejects symlink publication inputs without reading their targets", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const target = join(directory, "private-target.txt");
    const link = join(directory, "publication.md");
    const syntheticHome = ["", "home", "fixture-person", "records"].join("/");
    writeFileSync(target, `${syntheticHome}\n`);
    symlinkSync(target, link);

    const result = runGate([link]);
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe("PRIVACY GATE: FAIL\nunsafe_path: 1\n");
    expect(output).not.toContain(syntheticHome);
    expect(output).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("discovers committed regular-file to symlink type changes", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    runGit(directory, ["init", "--quiet"]);
    runGit(directory, ["config", "user.name", "Synthetic Fixture"]);
    runGit(directory, ["config", "user.email", "fixture@example.invalid"]);
    const publication = join(directory, "publication.md");
    writeFileSync(publication, "Synthetic baseline.\n");
    runGit(directory, ["add", "publication.md"]);
    runGit(directory, ["commit", "--quiet", "-m", "fixture baseline"]);
    const baseResult = Bun.spawnSync({ cmd: ["git", "rev-parse", "HEAD"], cwd: directory, stdout: "pipe" });
    const base = baseResult.stdout.toString().trim();
    rmSync(publication);
    symlinkSync(["", "home", "fixture-person", "dangling-target"].join("/"), publication);
    runGit(directory, ["add", "publication.md"]);
    runGit(directory, ["commit", "--quiet", "-m", "fixture type change"]);

    const result = runGateArguments(["--base", base], {}, directory);

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("PRIVACY GATE: FAIL\nunsafe_path: 1\n");
    expect(result.stdout.toString()).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("rejects dangling symlinks without resolving their target strings", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const publication = join(directory, "publication.md");
    const target = ["", "home", "fixture-person", "missing-target"].join("/");
    symlinkSync(target, publication);

    const result = runGate([publication]);
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe("PRIVACY GATE: FAIL\nunsafe_path: 1\n");
    expect(output).not.toContain(target);
    expect(output).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("samples GIF and video frames while keeping decoded content private", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const animation = join(directory, "capture.gif");
    const contents = Buffer.from("deterministic synthetic animation fixture");
    writeFileSync(animation, contents);
    writeValidProvenance(directory, "capture.gif", contents);
    const counter = join(directory, "sample-count");
    const syntheticHome = ["", "Users", "fixture-person", "records"].join("/");
    installTool(directory, "ffprobe", `printf '%s' '{"format":{"duration":"8","tags":{}},"streams":[{"duration":"8","nb_frames":"80","tags":{}}]}'`);
    installTool(directory, "ffmpeg", "printf '%s' 'synthetic-frame'");
    const environment = installTool(directory, "tesseract", `printf x >> "$FRAME_COUNTER"\nprintf '%s\\n' '${syntheticHome}'`);

    const result = runGate([animation], { ...environment, FRAME_COUNTER: counter });
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe("PRIVACY GATE: FAIL\nhome_path: 1\nprovenance_invalid: 1\n");
    expect(readFileSync(counter, "utf8")).toHaveLength(5);
    expect(output).not.toContain(syntheticHome);
    expect(output).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("inspects every video stream with class-only diagnostics", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const animation = join(directory, "capture.mp4");
    const contents = Buffer.from("deterministic synthetic multi-stream video fixture");
    writeFileSync(animation, contents);
    writeValidProvenance(directory, "capture.mp4", contents);
    const syntheticHome = ["", "Users", "fixture-person", "second-stream"].join("/");
    installTool(directory, "ffprobe", `printf '%s' '{"format":{"duration":"8","tags":{}},"streams":[{"duration":"8","nb_frames":"80","tags":{"title":"safe-zero"}},{"duration":"8","nb_frames":"80","tags":{"title":"safe-one"}}]}'`);
    installTool(directory, "ffmpeg", `case "$*" in *"0:v:1"*) printf '%s' 'private-frame';; *) printf '%s' 'safe-frame';; esac`);
    const environment = installTool(directory, "tesseract", `frame=$(cat)\nif [ "$frame" = "private-frame" ]; then printf '%s\\n' '${syntheticHome}'; fi`);

    const result = runGate([animation], environment);
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe("PRIVACY GATE: FAIL\nhome_path: 1\nprovenance_invalid: 1\n");
    expect(output).not.toContain(syntheticHome);
    expect(output).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("inspects metadata from every video stream", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const animation = join(directory, "capture.mp4");
    const contents = Buffer.from("deterministic synthetic multi-stream metadata fixture");
    writeFileSync(animation, contents);
    writeValidProvenance(directory, "capture.mp4", contents);
    const syntheticHome = ["", "Users", "fixture-person", "stream-metadata"].join("/");
    installTool(directory, "ffprobe", `case "$*" in *"v:0"*) printf '%s' '{"format":{"duration":"8"},"streams":[{"duration":"8","nb_frames":"80","tags":{"title":"safe-zero"}}]}';; *) printf '%s' '{"format":{"duration":"8"},"streams":[{"duration":"8","nb_frames":"80","tags":{"title":"safe-zero"}},{"duration":"8","nb_frames":"80","tags":{"title":"${syntheticHome}"}}]}';; esac`);
    installTool(directory, "ffmpeg", "printf '%s' 'safe-frame'");
    const environment = installTool(directory, "tesseract");

    const result = runGate([animation], environment);
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe("PRIVACY GATE: FAIL\nhome_path: 1\nprovenance_invalid: 1\n");
    expect(output).not.toContain(syntheticHome);
    expect(output).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("fails closed before sampling excessive video streams", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const animation = join(directory, "capture.mp4");
    const contents = Buffer.from("deterministic synthetic excessive-stream video fixture");
    writeFileSync(animation, contents);
    writeValidProvenance(directory, "capture.mp4", contents);
    const counter = join(directory, "sample-count");
    const probe = JSON.stringify({
      format: { duration: "8" },
      streams: Array.from({ length: 17 }, () => ({ duration: "8", nb_frames: "80", tags: {} })),
    });
    installTool(directory, "ffprobe", `printf '%s' '${probe}'`);
    installTool(directory, "ffmpeg", `printf x >> "$FRAME_COUNTER"\nprintf '%s' 'safe-frame'`);
    const environment = installTool(directory, "tesseract");

    const result = runGate([animation], { ...environment, FRAME_COUNTER: counter });
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe("PRIVACY GATE: FAIL\ninspection_error: 1\nprovenance_invalid: 1\n");
    expect(existsSync(counter)).toBe(false);
    expect(output).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("samples representative frame indexes when video duration is unknown", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const animation = join(directory, "capture.mp4");
    const contents = Buffer.from("deterministic synthetic unknown-duration video fixture");
    writeFileSync(animation, contents);
    writeValidProvenance(directory, "capture.mp4", contents);
    const counter = join(directory, "sample-count");
    const syntheticHome = ["", "Users", "fixture-person", "records"].join("/");
    installTool(directory, "ffprobe", `printf '%s' '{"format":{"duration":"N/A","tags":{}},"streams":[{"nb_read_frames":"N/A","nb_frames":"240"}]}'`);
    installTool(directory, "ffmpeg", `printf x >> "$FRAME_COUNTER"\nprintf '%s' 'synthetic-frame'`);
    const environment = installTool(directory, "tesseract", `printf '%s\n' '${syntheticHome}'`);

    const result = runGate([animation], { ...environment, FRAME_COUNTER: counter });
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe("PRIVACY GATE: FAIL\nhome_path: 1\nprovenance_invalid: 1\n");
    expect(readFileSync(counter, "utf8")).toHaveLength(5);
    expect(output).not.toContain(syntheticHome);
    expect(output).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("fails closed when protected late video frames cannot be bounded", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const animation = join(directory, "capture.mp4");
    const contents = Buffer.from("deterministic synthetic unbounded long-video fixture");
    writeFileSync(animation, contents);
    writeValidProvenance(directory, "capture.mp4", contents);
    const sampleLog = join(directory, "sample-log");
    installTool(directory, "ffprobe", `printf '%s' '{"format":{"duration":"N/A"},"streams":[{"nb_read_frames":"N/A","nb_frames":"N/A"}]}'`);
    installTool(directory, "ffmpeg", `printf '%s\n' "$*" >> "$SAMPLE_LOG"\nprintf '%s' 'synthetic-frame'`);
    const environment = installTool(directory, "tesseract", "printf '%s' 'synthetic-safe-ocr'");

    const result = runGate([animation], { ...environment, SAMPLE_LOG: sampleLog });

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("PRIVACY GATE: FAIL\ninspection_error: 1\nprovenance_invalid: 1\n");
    expect(existsSync(sampleLog)).toBe(false);
    expect(result.stdout.toString()).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("matches a Ukrainian OCR value with configured multilingual language data", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const image = join(directory, "capture.png");
    const contents = redactedPlaceholderPng();
    writeFileSync(image, contents);
    writeValidProvenance(directory, "capture.png", contents);
    const argumentsFile = join(directory, "ocr-arguments");
    const fingerprints = join(directory, "known-values.json");
    const ukrainianValue = ["приватна", "назва", "проєкту"].join("-");
    writeFingerprintCatalog(fingerprints, ukrainianValue);
    const environment = installTool(directory, "tesseract", `printf '%s' "$*" > "$OCR_ARGUMENTS"\nprintf '%s\n' "$OCR_TEXT"`);

    const result = runGate([image], {
      ...environment,
      LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE: fingerprints,
      LLV_PRIVACY_OCR_LANGUAGES: "eng+ukr",
      OCR_ARGUMENTS: argumentsFile,
      OCR_TEXT: ukrainianValue,
    });
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe("PRIVACY GATE: FAIL\nknown_value: 1\nprovenance_invalid: 1\n");
    expect(readFileSync(argumentsFile, "utf8")).toContain("-l eng+ukr");
    expect(output).not.toContain(ukrainianValue);
    expect(output).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("fails closed when configured OCR language data is unavailable", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const image = join(directory, "capture.png");
    const contents = redactedPlaceholderPng();
    writeFileSync(image, contents);
    writeValidProvenance(directory, "capture.png", contents);
    const environment = installTool(directory, "tesseract", "exit 1");

    const result = runGate([image], {
      ...environment,
      LLV_PRIVACY_OCR_LANGUAGES: "eng+ukr",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("PRIVACY GATE: FAIL\ninspection_error: 1\nprovenance_invalid: 1\n");
    expect(result.stdout.toString()).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("detects PNG media renamed with a Markdown extension", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const image = join(directory, "capture.md");
    writeFileSync(image, liveCapturePng());

    const result = runGate([image], installTool(directory, "tesseract"));

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe([
      "PRIVACY GATE: FAIL",
      "media_live_source: 1",
      "provenance_missing: 1",
      "",
    ].join("\n"));
    expect(result.stdout.toString()).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("detects video media renamed with a text extension", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const video = join(directory, "capture.txt");
    const signature = Buffer.from("000000186674797069736f6d0000020069736f6d", "hex");
    writeFileSync(video, signature);
    const syntheticHome = ["", "home", "fixture-person", "renamed-video"].join("/");
    installTool(directory, "ffprobe", `printf '%s' '{"format":{"duration":"1"},"streams":[{"duration":"1","nb_frames":"5"}]}'`);
    installTool(directory, "ffmpeg", "printf '%s' 'synthetic-frame'");
    const environment = installTool(directory, "tesseract", `printf '%s' '${syntheticHome}'`);

    const result = runGate([video], environment);
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe("PRIVACY GATE: FAIL\nhome_path: 1\nprovenance_missing: 1\n");
    expect(output).not.toContain(syntheticHome);
    expect(output).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("matches operator-provided private labels without publishing them", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const text = join(directory, "release-notes.md");
    const privateLabel = ["fixture", "private", "project", "label"].join("-");
    writeFileSync(text, `Evidence for ${privateLabel}.\n`);

    const result = runGate([text], { LLV_PRIVACY_KNOWN_VALUES: privateLabel });
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe("PRIVACY GATE: FAIL\nknown_value: 1\n");
    expect(output).not.toContain(privateLabel);
    expect(output).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("discovers publication changes relative to the requested Git base", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    runGit(directory, ["init", "--quiet"]);
    runGit(directory, ["config", "user.name", "Synthetic Fixture"]);
    runGit(directory, ["config", "user.email", "fixture@example.invalid"]);
    const notes = join(directory, "release-notes.md");
    writeFileSync(notes, "Synthetic release evidence.\n");
    runGit(directory, ["add", "release-notes.md"]);
    runGit(directory, ["commit", "--quiet", "-m", "fixture baseline"]);
    const baseResult = Bun.spawnSync({ cmd: ["git", "rev-parse", "HEAD"], cwd: directory, stdout: "pipe" });
    const base = baseResult.stdout.toString().trim();
    const syntheticHome = ["", "home", "fixture-person", "records"].join("/");
    writeFileSync(notes, `Synthetic release evidence.\n${syntheticHome}\n`);

    const result = runGateArguments(["--base", base], {}, directory);
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe(`PRIVACY GATE: FAIL\nhome_path: 1\n${fileNotice("release-notes.md", "home_path", 2)}\n`);
    expect(output).not.toContain(syntheticHome);
    expect(output).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("resolves the current protected base tip for long-lived pull requests", () => {
    const workflow = readFileSync(join(import.meta.dir, "..", ".github", "workflows", "privacy-publication.yml"), "utf8");

    expect(workflow).not.toContain("github.event.pull_request.base.sha");
    expect(workflow).toMatch(
      /PRIVACY_BASE_REF: \$\{\{[^}]*github\.event\.pull_request\.base\.ref[^}]*\}\}/,
    );
    expect(workflow).toContain(
      'git fetch --no-tags --force origin "+refs/heads/${PRIVACY_BASE_REF}:refs/remotes/origin/${PRIVACY_BASE_REF}"',
    );
    expect(workflow).toContain(
      'git rev-parse --verify "refs/remotes/origin/${PRIVACY_BASE_REF}^{commit}"',
    );
    expect(workflow).toContain('printf \'PRIVACY_BASE_SHA=%s\\n\' "$PRIVACY_BASE_SHA" >> "$GITHUB_ENV"');
    expect(workflow).toContain('--base "$PRIVACY_BASE_SHA"');
  });

  test("scopes issue-comment audits to the triggering comment", () => {
    const workflow = readFileSync(join(import.meta.dir, "..", ".github", "workflows", "privacy-tracker-audit.yml"), "utf8");

    expect(workflow).toContain(
      "PUBLICATION_ISSUE_COMMENT_ID: ${{ github.event_name == 'issue_comment' && github.event.comment.id || '' }}",
    );
    expect(workflow).toContain('--issue-comment "$PUBLICATION_ISSUE_COMMENT_ID"');
  });

  test("reports post-publication tracker findings without hiding audit failures", () => {
    const workflow = readFileSync(join(import.meta.dir, "..", ".github", "workflows", "privacy-tracker-audit.yml"), "utf8");

    expect(workflow).not.toContain("continue-on-error: true");
    expect(workflow).toContain('bun scripts/privacy-github-audit.ts "${arguments[@]}" --report-only');
    expect(shouldFailGithubAudit(new Map([["resource_identifier", 1]]), true)).toBe(false);
    expect(shouldFailGithubAudit(new Map([["home_path", 1]]), true)).toBe(false);
    expect(shouldFailGithubAudit(new Map([["inspection_error", 1]]), true)).toBe(true);
    expect(shouldFailGithubAudit(new Map([["configuration_error", 1]]), true)).toBe(true);
    expect(shouldFailGithubAudit(new Map([["resource_identifier", 1]]), false)).toBe(true);
  });

  test("uses trusted scanner and fingerprints when every candidate gate surface is tampered", () => {
    const root = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(root);
    const candidate = join(root, "candidate");
    mkdirSync(candidate);
    runGit(candidate, ["init", "--quiet"]);
    runGit(candidate, ["config", "user.name", "Synthetic Fixture"]);
    runGit(candidate, ["config", "user.email", "fixture@example.invalid"]);
    const tamperedPaths = [
      ".github/workflows/privacy-publication.yml",
      "scripts/privacy-known-value-fingerprints.json",
      "scripts/privacy-publication-gate.test.ts",
      "scripts/privacy-publication-gate.ts",
    ];
    for (const path of [...tamperedPaths, "docs/publication.md"]) {
      const absolute = join(candidate, path);
      mkdirSync(join(absolute, ".."), { recursive: true });
      writeFileSync(absolute, "Synthetic baseline.\n");
    }
    runGit(candidate, ["add", "."]);
    runGit(candidate, ["commit", "--quiet", "-m", "fixture baseline"]);

    for (const path of tamperedPaths) writeFileSync(join(candidate, path), "tampered candidate gate surface\n");
    const knownValue = `fixture-${process.pid}-trusted-tampering-label`;
    writeFileSync(join(candidate, "docs/publication.md"), `${knownValue}\n`);
    const trustedCatalog = join(root, "trusted-fingerprints.json");
    writeFingerprintCatalog(trustedCatalog, knownValue);

    const result = runGateArguments(["--repository", candidate, "--base", "HEAD", "--require-known-values"], {
      LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE: trustedCatalog,
      LLV_PRIVACY_KNOWN_VALUES: "",
      LLV_PRIVACY_KNOWN_VALUES_FILE: "",
    });
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe(`PRIVACY GATE: FAIL\nknown_value: 1\n${fileNotice("docs/publication.md", "known_value", 1)}\n`);
    expect(output).not.toContain(knownValue);
    expect(output).not.toContain(candidate);
    expect(result.stderr.toString()).toBe("");
  });

  test("rejects candidate-created adversarial exemptions", () => {
    const root = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(root);
    runGit(root, ["init", "--quiet"]);
    runGit(root, ["config", "user.name", "Synthetic Fixture"]);
    runGit(root, ["config", "user.email", "fixture@example.invalid"]);
    writeFileSync(join(root, "README.md"), "Synthetic baseline.\n");
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "--quiet", "-m", "fixture baseline"]);
    const directory = join(root, "privacy-fixtures");
    mkdirSync(directory);
    const image = join(directory, "synthetic-path.png");
    const contents = redactedPlaceholderPng();
    writeFileSync(image, contents);
    const generator = Buffer.from('export const PRIVACY_GENERATOR_RUNTIME = "1.3.3";\nexport const PRIVACY_GENERATOR_VERSION = "fixture-generator-v2";\n');
    writeFileSync(join(directory, "generate-fixture.mjs"), generator);
    writeFileSync(join(directory, "privacy-manifest.json"), JSON.stringify({
      schemaVersion: 2,
      assets: [{
        path: "synthetic-path.png",
        classification: "adversarial-synthetic",
        source: "deterministic-generator",
        generator: "generate-fixture.mjs",
        generatorRuntime: "bun-1.3.3",
        generatorVersion: "fixture-generator-v2",
        generatorSha256: createHash("sha256").update(generator).digest("hex"),
        sourceDigests: [createHash("sha256").update("adversarial-fixture-source").digest("hex")],
        description: "Synthetic adversarial raster for path-detection regression coverage.",
        expectedFindingClasses: ["home_path"],
        sha256: createHash("sha256").update(contents).digest("hex"),
      }],
    }));
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "--quiet", "-m", "candidate exemption"]);
    const syntheticHome = ["", "home", "fixture-person", "records"].join("/");

    const result = runGateArguments(
      ["--repository", root, "--base", "HEAD^", "--paths", image],
      installTool(directory, "tesseract", `printf '%s\\n' '${syntheticHome}'`),
    );
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe([
      "PRIVACY GATE: FAIL",
      "home_path: 1",
      "provenance_invalid: 1",
      fileNotice("privacy-fixtures/synthetic-path.png", "home_path"),
      fileNotice("privacy-fixtures/synthetic-path.png", "provenance_invalid"),
      "",
    ].join("\n"));
    expect(output).not.toContain(syntheticHome);
    expect(output).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("rejects live output and source digests that contradict the trusted generator", () => {
    const root = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(root);
    runGit(root, ["init", "--quiet"]);
    runGit(root, ["config", "user.name", "Synthetic Fixture"]);
    runGit(root, ["config", "user.email", "fixture@example.invalid"]);
    writeFileSync(join(root, "README.md"), "Synthetic baseline.\n");
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "--quiet", "-m", "fixture baseline"]);
    const directory = join(root, "docs", "acceptance", "issue-290");
    const scriptsDirectory = join(root, "scripts");
    mkdirSync(directory, { recursive: true });
    mkdirSync(scriptsDirectory, { recursive: true });
    const image = join(directory, "readiness-kanban.png");
    const contents = liveCapturePng();
    writeFileSync(image, contents);
    const generator = readFileSync(join(import.meta.dir, "generate-privacy-placeholders.ts"));
    writeFileSync(join(scriptsDirectory, "generate-privacy-placeholders.ts"), generator);
    writeFileSync(join(directory, "privacy-manifest.json"), JSON.stringify({
      schemaVersion: 2,
      assets: [{
        path: "readiness-kanban.png",
        classification: "redacted-placeholder",
        source: "redacted-live-capture",
        generator: "../../../scripts/generate-privacy-placeholders.ts",
        generatorRuntime: "bun-1.3.3",
        generatorVersion: "privacy-placeholders-v2",
        generatorSha256: createHash("sha256").update(generator).digest("hex"),
        sourceDigests: [createHash("sha256").update("candidate-declared-source").digest("hex")],
        description: "Candidate-declared source and output for a live publication capture.",
        sha256: createHash("sha256").update(contents).digest("hex"),
      }],
    }));
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "--quiet", "-m", "candidate publication"]);

    const result = runGateArguments(
      ["--repository", root, "--base", "HEAD^", "--paths", image],
      installTool(root, "tesseract"),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe([
      "PRIVACY GATE: FAIL",
      "media_live_source: 1",
      "provenance_invalid: 1",
      fileNotice("docs/acceptance/issue-290/readiness-kanban.png", "media_live_source"),
      fileNotice("docs/acceptance/issue-290/readiness-kanban.png", "provenance_invalid"),
      "",
    ].join("\n"));
    expect(result.stdout.toString()).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("rejects candidate-controlled generators that self-certify live media", () => {
    const root = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(root);
    const directory = join(root, "published");
    mkdirSync(directory);
    const image = join(directory, "capture.png");
    const contents = liveCapturePng();
    writeFileSync(image, contents);
    const generator = Buffer.from([
      'export const PRIVACY_GENERATOR_RUNTIME = "1.3.3";',
      'export const PRIVACY_GENERATOR_VERSION = "privacy-placeholders-v2";',
      "",
    ].join("\n"));
    writeFileSync(join(directory, "generate-placeholder.mjs"), generator);
    writeFileSync(join(directory, "privacy-manifest.json"), JSON.stringify({
      schemaVersion: 2,
      assets: [{
        path: "capture.png",
        classification: "redacted-placeholder",
        source: "redacted-live-capture",
        generator: "generate-placeholder.mjs",
        generatorRuntime: "bun-1.3.3",
        generatorVersion: "privacy-placeholders-v2",
        generatorSha256: createHash("sha256").update(generator).digest("hex"),
        sourceDigests: [createHash("sha256").update("candidate-declared-source").digest("hex")],
        description: "Candidate-declared provenance for a live publication capture.",
        sha256: createHash("sha256").update(contents).digest("hex"),
      }],
    }));

    const result = runGateArguments(
      ["--repository", root, "--paths", image],
      installTool(directory, "tesseract"),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe([
      "PRIVACY GATE: FAIL",
      "media_live_source: 1",
      "provenance_invalid: 1",
      fileNotice("published/capture.png", "media_live_source"),
      fileNotice("published/capture.png", "provenance_invalid"),
      "",
    ].join("\n"));
    expect(result.stdout.toString()).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("allows adversarial exemptions already present in the trusted base", () => {
    const root = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(root);
    runGit(root, ["init", "--quiet"]);
    runGit(root, ["config", "user.name", "Synthetic Fixture"]);
    runGit(root, ["config", "user.email", "fixture@example.invalid"]);
    const directory = join(root, "privacy-fixtures");
    mkdirSync(directory);
    const image = join(directory, "synthetic-path.png");
    const contents = redactedPlaceholderPng();
    writeFileSync(image, contents);
    const generator = Buffer.from('export const PRIVACY_GENERATOR_RUNTIME = "1.3.3";\nexport const PRIVACY_GENERATOR_VERSION = "fixture-generator-v2";\n');
    writeFileSync(join(directory, "generate-fixture.mjs"), generator);
    writeFileSync(join(directory, "privacy-manifest.json"), JSON.stringify({
      schemaVersion: 2,
      assets: [{
        path: "synthetic-path.png",
        classification: "adversarial-synthetic",
        source: "deterministic-generator",
        generator: "generate-fixture.mjs",
        generatorRuntime: "bun-1.3.3",
        generatorVersion: "fixture-generator-v2",
        generatorSha256: createHash("sha256").update(generator).digest("hex"),
        sourceDigests: [createHash("sha256").update("adversarial-fixture-source").digest("hex")],
        description: "Synthetic adversarial raster for path-detection regression coverage.",
        expectedFindingClasses: ["home_path"],
        sha256: createHash("sha256").update(contents).digest("hex"),
      }],
    }));
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "--quiet", "-m", "trusted exemption"]);
    const syntheticHome = ["", "home", "fixture-person", "records"].join("/");

    const result = runGateArguments(
      ["--repository", root, "--base", "HEAD", "--paths", image],
      installTool(directory, "tesseract", `printf '%s\\n' '${syntheticHome}'`),
    );
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(0);
    expect(output).toBe("PRIVACY GATE: PASS\n");
    expect(output).not.toContain(syntheticHome);
    expect(output).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("rejects symlink manifests and provenance generators", () => {
    const root = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(root);
    const contents = redactedPlaceholderPng();
    const externalManifest = join(root, "external-manifest.json");
    const manifestLinkDirectory = join(root, "manifest-link");
    mkdirSync(manifestLinkDirectory);
    const manifestLinkImage = join(manifestLinkDirectory, "capture.png");
    writeFileSync(manifestLinkImage, contents);
    const generator = Buffer.from('export const PRIVACY_GENERATOR_RUNTIME = "1.3.3";\nexport const PRIVACY_GENERATOR_VERSION = "fixture-generator-v2";\n');
    writeFileSync(join(manifestLinkDirectory, "generate-placeholder.mjs"), generator);
    writeFileSync(externalManifest, JSON.stringify({
      schemaVersion: 2,
      assets: [{
        path: "capture.png",
        classification: "redacted-placeholder",
        source: "redacted-live-capture",
        generator: "generate-placeholder.mjs",
        generatorRuntime: "bun-1.3.3",
        generatorVersion: "fixture-generator-v2",
        generatorSha256: createHash("sha256").update(generator).digest("hex"),
        sourceDigests: [createHash("sha256").update("fixture-source").digest("hex")],
        description: "Synthetic provenance fixture with a linked manifest.",
        sha256: createHash("sha256").update(contents).digest("hex"),
      }],
    }));
    symlinkSync(externalManifest, join(manifestLinkDirectory, "privacy-manifest.json"));

    const generatorLinkDirectory = join(root, "generator-link");
    mkdirSync(generatorLinkDirectory);
    const generatorLinkImage = join(generatorLinkDirectory, "capture.png");
    writeFileSync(generatorLinkImage, contents);
    writeValidProvenance(generatorLinkDirectory, "capture.png", contents);
    const regularGenerator = join(generatorLinkDirectory, "generate-placeholder.mjs");
    const externalGenerator = join(root, "external-generator.mjs");
    writeFileSync(externalGenerator, readFileSync(regularGenerator));
    rmSync(regularGenerator);
    symlinkSync(externalGenerator, regularGenerator);

    const result = runGate(
      [manifestLinkImage, generatorLinkImage],
      installTool(root, "tesseract"),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("PRIVACY GATE: FAIL\nprovenance_invalid: 2\n");
    expect(result.stderr.toString()).toBe("");
  });

  test("rejects asset and manifest paths reached through symlinked ancestors", () => {
    const root = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(root);
    const realDirectory = join(root, "real-publication");
    mkdirSync(realDirectory);
    const contents = redactedPlaceholderPng();
    writeFileSync(join(realDirectory, "capture.png"), contents);
    writeValidProvenance(realDirectory, "capture.png", contents);
    const linkedDirectory = join(root, "linked-publication");
    symlinkSync(realDirectory, linkedDirectory);

    const result = runGate(
      [join(linkedDirectory, "capture.png")],
      installTool(root, "tesseract"),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("PRIVACY GATE: FAIL\nunsafe_path: 1\n");
    expect(result.stdout.toString()).not.toContain(root);
    expect(result.stderr.toString()).toBe("");
  });

  test("rejects provenance generators reached through symlinked ancestors", () => {
    const root = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(root);
    const publicationDirectory = join(root, "published");
    const externalDirectory = join(root, "external-generator");
    mkdirSync(publicationDirectory);
    mkdirSync(externalDirectory);
    const image = join(publicationDirectory, "capture.png");
    const contents = redactedPlaceholderPng();
    writeFileSync(image, contents);
    const generator = Buffer.from('export const PRIVACY_GENERATOR_RUNTIME = "1.3.3";\nexport const PRIVACY_GENERATOR_VERSION = "fixture-generator-v2";\n');
    writeFileSync(join(externalDirectory, "generate-placeholder.mjs"), generator);
    symlinkSync(externalDirectory, join(publicationDirectory, "linked-generator"));
    writeFileSync(join(publicationDirectory, "privacy-manifest.json"), JSON.stringify({
      schemaVersion: 2,
      assets: [{
        path: "capture.png",
        classification: "redacted-placeholder",
        source: "redacted-live-capture",
        generator: "linked-generator/generate-placeholder.mjs",
        generatorRuntime: "bun-1.3.3",
        generatorVersion: "fixture-generator-v2",
        generatorSha256: createHash("sha256").update(generator).digest("hex"),
        sourceDigests: [createHash("sha256").update("fixture-source").digest("hex")],
        description: "Synthetic provenance fixture with an ancestor-linked generator.",
        sha256: createHash("sha256").update(contents).digest("hex"),
      }],
    }));

    const result = runGate([image], installTool(root, "tesseract"));

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("PRIVACY GATE: FAIL\nprovenance_invalid: 1\n");
    expect(result.stdout.toString()).not.toContain(root);
    expect(result.stderr.toString()).toBe("");
  });

  test("rejects provenance generators outside the asset boundary", () => {
    const root = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(root);
    const directory = join(root, "published");
    mkdirSync(directory);
    const image = join(directory, "capture.png");
    const contents = redactedPlaceholderPng();
    writeFileSync(image, contents);
    const generator = Buffer.from('export const PRIVACY_GENERATOR_RUNTIME = "1.3.3";\nexport const PRIVACY_GENERATOR_VERSION = "fixture-generator-v2";\n');
    const externalGenerator = join(root, "external-generator.mjs");
    writeFileSync(externalGenerator, generator);
    writeFileSync(join(directory, "privacy-manifest.json"), JSON.stringify({
      schemaVersion: 2,
      assets: [{
        path: "capture.png",
        classification: "redacted-placeholder",
        source: "redacted-live-capture",
        generator: "../external-generator.mjs",
        generatorRuntime: "bun-1.3.3",
        generatorVersion: "fixture-generator-v2",
        generatorSha256: createHash("sha256").update(generator).digest("hex"),
        sourceDigests: [createHash("sha256").update("fixture-source").digest("hex")],
        description: "Synthetic provenance fixture with an external generator.",
        sha256: createHash("sha256").update(contents).digest("hex"),
      }],
    }));

    const result = runGate([image], installTool(root, "tesseract"));

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("PRIVACY GATE: FAIL\nprovenance_invalid: 1\n");
    expect(result.stderr.toString()).toBe("");
  });

  test("requires a dedicated generator version declaration", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const image = join(directory, "capture.png");
    const contents = redactedPlaceholderPng();
    writeFileSync(image, contents);
    const generator = Buffer.from('export const PRIVACY_GENERATOR_RUNTIME = "1.3.3";\nexport const packageMetadata = { version: "fixture-generator-v2" };\n');
    writeFileSync(join(directory, "generate-placeholder.mjs"), generator);
    writeFileSync(join(directory, "privacy-manifest.json"), JSON.stringify({
      schemaVersion: 2,
      assets: [{
        path: "capture.png",
        classification: "redacted-placeholder",
        source: "redacted-live-capture",
        generator: "generate-placeholder.mjs",
        generatorRuntime: "bun-1.3.3",
        generatorVersion: "fixture-generator-v2",
        generatorSha256: createHash("sha256").update(generator).digest("hex"),
        sourceDigests: [createHash("sha256").update("fixture-source").digest("hex")],
        description: "Synthetic provenance fixture with a generic version string.",
        sha256: createHash("sha256").update(contents).digest("hex"),
      }],
    }));

    const result = runGate([image], installTool(directory, "tesseract"));

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("PRIVACY GATE: FAIL\nprovenance_invalid: 1\n");
    expect(result.stderr.toString()).toBe("");
  });

  for (const runtimeFixture of [
    { name: "missing", value: undefined },
    { name: "malformed", value: "bun latest!" },
    { name: "mismatched", value: "bun-1.3.14" },
  ]) {
    test(`rejects ${runtimeFixture.name} provenance generator runtime declarations`, () => {
      const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
      temporaryDirectories.push(directory);
      const image = join(directory, "capture.png");
      const contents = redactedPlaceholderPng();
      writeFileSync(image, contents);
      writeValidProvenance(directory, "capture.png", contents);
      const manifestPath = join(directory, "privacy-manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        assets: Array<Record<string, unknown>>;
      };
      if (runtimeFixture.value === undefined) delete manifest.assets[0].generatorRuntime;
      else manifest.assets[0].generatorRuntime = runtimeFixture.value;
      writeFileSync(manifestPath, JSON.stringify(manifest));

      const result = runGate([image], installTool(directory, "tesseract"));

      expect(result.exitCode).toBe(1);
      expect(result.stdout.toString()).toBe("PRIVACY GATE: FAIL\nprovenance_invalid: 1\n");
      expect(result.stdout.toString()).not.toContain(directory);
      expect(result.stderr.toString()).toBe("");
    });
  }

  test("classifies private network, resource, and transcript-shaped media text", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const image = join(directory, "capture.png");
    const contents = redactedPlaceholderPng();
    writeFileSync(image, contents);
    writeValidProvenance(directory, "capture.png", contents);
    const syntheticAddress = [10, 23, 45, 67].join(".");
    const syntheticIdentifier = ["12345678", "1234", "4abc", "8def", "123456789abc"].join("-");
    const transcriptMarker = ["trans", "cript"].join("") + ": synthetic fixture utterance";
    const ocr = [syntheticAddress, syntheticIdentifier, transcriptMarker].join("\\n");

    const result = runGate([image], installTool(directory, "tesseract", `printf '%b\\n' '${ocr}'`));
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe([
      "PRIVACY GATE: FAIL",
      "private_network: 1",
      "provenance_invalid: 1",
      "resource_identifier: 1",
      "transcript_content: 1",
      "",
    ].join("\n"));
    expect(output).not.toContain(syntheticAddress);
    expect(output).not.toContain(syntheticIdentifier);
    expect(output).not.toContain(transcriptMarker);
    expect(output).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("scans embedded raster metadata independently from OCR", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const image = join(directory, "capture.png");
    const syntheticHome = ["", "home", "fixture-person", "metadata"].join("/");
    const contents = pngWithMetadata(syntheticHome);
    writeFileSync(image, contents);
    writeValidProvenance(directory, "capture.png", contents);

    const result = runGate([image], installTool(directory, "tesseract"));
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe("PRIVACY GATE: FAIL\nhome_path: 1\nprovenance_invalid: 1\n");
    expect(output).not.toContain(syntheticHome);
    expect(output).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("scans compressed PNG text, eXIf, and trailing payloads", () => {
    const root = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(root);
    const syntheticHome = ["", "home", "fixture-person", "metadata"].join("/");
    const images: string[] = [];
    const fixtures: Array<[string, Buffer]> = [
      ["ztxt", pngWithCustomMetadata("zTXt", syntheticHome)],
      ["itxt", pngWithCustomMetadata("iTXt", syntheticHome)],
      ["iccp", pngWithCustomMetadata("iCCP", syntheticHome)],
      ["exif", pngWithCustomMetadata("eXIf", syntheticHome)],
      ["trailing", pngWithTrailingPayload(syntheticHome)],
    ];
    for (const [name, contents] of fixtures) {
      const directory = join(root, name);
      mkdirSync(directory);
      const image = join(directory, "capture.png");
      writeFileSync(image, contents);
      writeValidProvenance(directory, "capture.png", contents);
      images.push(image);
    }

    const result = runGate(images, installTool(root, "tesseract"));
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe("PRIVACY GATE: FAIL\nhome_path: 5\nprovenance_invalid: 5\n");
    expect(output).not.toContain(syntheticHome);
    expect(output).not.toContain(root);
    expect(result.stderr.toString()).toBe("");
  });

  for (const fixture of [
    { byteOrder: "le" as const, location: "eXIf" as const },
    { byteOrder: "be" as const, location: "eXIf" as const },
    { byteOrder: "le" as const, location: "trailing payload" as const },
    { byteOrder: "be" as const, location: "trailing payload" as const },
  ]) {
    test(`scans odd-aligned ${fixture.byteOrder.toUpperCase()} UTF-16 in ${fixture.location}`, () => {
      const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
      temporaryDirectories.push(directory);
      const syntheticHome = ["", "home", "fixture-person", `${fixture.byteOrder}-metadata`].join("/");
      const payload = oddAlignedUtf16(syntheticHome, fixture.byteOrder);
      const contents = fixture.location === "eXIf"
        ? pngWithExifBytes(payload)
        : Buffer.concat([redactedPlaceholderPng(), payload]);
      const image = join(directory, "capture.png");
      writeFileSync(image, contents);
      writeValidProvenance(directory, "capture.png", contents);

      const result = runGate([image], installTool(directory, "tesseract"));
      const output = result.stdout.toString();

      expect(result.exitCode).toBe(1);
      expect(output).toBe("PRIVACY GATE: FAIL\nhome_path: 1\nprovenance_invalid: 1\n");
      expect(output).not.toContain(syntheticHome);
      expect(output).not.toContain(directory);
      expect(result.stderr.toString()).toBe("");
    });
  }

  test("audits authenticated GitHub issue, PR, comment, review, and media surfaces", async () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const originalOcrLanguages = process.env.LLV_PRIVACY_OCR_LANGUAGES;
    const syntheticHome = ["", "home", "fixture-person", "tracker"].join("/");
    const encodedHome = syntheticHome.replaceAll("/", "%2F");
    const syntheticIdentifier = ["12345678", "1234", "4abc", "8def", "123456789abc"].join("-");
    const media = pngWithCustomMetadata("eXIf", syntheticHome);
    const token = ["synthetic", "github", "audit", "token"].join("-");
    const passwordInput = ['<form><in', 'put name=token value=synthetic-form-credential-123456></form>'].join("");
    const transcriptMarker = ["trans", "cript"].join("") + ": synthetic fixture utterance";
    const requests: Array<{ authorization: string | null; url: string }> = [];
    const languageResult = Bun.spawnSync({ cmd: ["tesseract", "--list-langs"], stderr: "pipe", stdout: "pipe" });
    const ocrLanguage = languageResult.stdout.toString().split(/\r?\n/).find((language) => /^[a-z0-9_]+$/i.test(language) && language !== "osd");
    process.env.LLV_PRIVACY_OCR_LANGUAGES = ocrLanguage ?? "missing-test-language";
    const fetcher = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input);
      requests.push({ authorization: new Headers(init?.headers).get("authorization"), url: url.href });
      if (url.hostname === "github.com") {
        return new Response(Uint8Array.from(media), { headers: { "content-type": "image/png" } });
      }
      if (url.pathname.endsWith("/issues/456")) {
        return Response.json({ body: "", pull_request: {} });
      }
      if (url.pathname.endsWith("/issues/456/comments")) {
        return Response.json([{ body: `[encoded](${encodedHome})` }]);
      }
      if (url.pathname.endsWith("/pulls/456")) {
        const mediaUrl = "https://github.com/example/repository/assets/synthetic(media).png";
        return Response.json({
          body: [
            passwordInput,
            `![evidence](<${mediaUrl}>)`,
            `<img src=${mediaUrl}>`,
          ].join("\n"),
        });
      }
      if (url.pathname.endsWith("/pulls/456/comments")) {
        return Response.json([{ body: transcriptMarker }]);
      }
      if (url.pathname.endsWith("/pulls/456/reviews")) {
        return Response.json([{ body: `Synthetic resource ${syntheticIdentifier}` }]);
      }
      return new Response(null, { status: 404 });
    };

    try {
      const findings = await auditGithubPublication({
        apiUrl: "https://api.github.test/",
        fetcher,
        number: 456,
        repo: "example/repository",
        requireKnownValues: false,
        token,
      });
      const output = formatPrivacyReport(findings);

      expect(output).toBe([
        "PRIVACY GATE: FAIL",
        "credential: 1",
        "home_path: 2",
        "provenance_missing: 1",
        "resource_identifier: 1",
        "transcript_content: 1",
        "",
      ].join("\n"));
      expect(requests).toHaveLength(6);
      expect(requests.every((request) => request.authorization === `Bearer ${token}`)).toBe(true);
      expect(requests.some((request) => request.url.includes("/issues/456/comments"))).toBe(true);
      expect(requests.some((request) => request.url.includes("/pulls/456/comments"))).toBe(true);
      expect(requests.some((request) => request.url.includes("/pulls/456/reviews"))).toBe(true);
      expect(output).not.toContain(syntheticHome);
      expect(output).not.toContain(syntheticIdentifier);
      expect(output).not.toContain(token);
      expect(output).not.toContain(directory);
    } finally {
      if (originalOcrLanguages === undefined) delete process.env.LLV_PRIVACY_OCR_LANGUAGES;
      else process.env.LLV_PRIVACY_OCR_LANGUAGES = originalOcrLanguages;
    }
  });

  test("audits only the triggering issue comment when a surface is selected", async () => {
    const syntheticHome = ["", "home", "fixture-person", "historical-issue"].join("/");
    const requests: string[] = [];
    const fetcher = async (input: string | URL): Promise<Response> => {
      const url = new URL(input);
      requests.push(url.pathname);
      if (url.pathname.endsWith("/issues/421")) return Response.json({ body: syntheticHome, title: "Historical issue" });
      if (url.pathname.endsWith("/issues/421/comments")) return Response.json([{ body: "Clean historical comment" }]);
      if (url.pathname.endsWith("/issues/comments/999")) return Response.json({ body: "Clean current status" });
      return new Response(null, { status: 404 });
    };

    const findings = await auditGithubPublication({
      apiUrl: "https://api.github.test/",
      fetcher,
      number: 421,
      repo: "example/repository",
      requireKnownValues: false,
      surface: { id: 999, kind: "issue_comment" },
      token: "synthetic-github-audit-token",
    });

    expect(formatPrivacyReport(findings)).toBe("PRIVACY GATE: PASS\n");
    expect(requests).toEqual(["/repos/example/repository/issues/comments/999"]);
  });

  test("keeps triggering issue-comment audits fail closed with class-only diagnostics", async () => {
    const syntheticIdentifier = ["12345678", "1234", "4abc", "8def", "123456789abc"].join("-");
    const fetcher = async (input: string | URL): Promise<Response> => {
      const url = new URL(input);
      if (url.pathname.endsWith("/issues/comments/999")) {
        return Response.json({ body: `Sensitive resource ${syntheticIdentifier}` });
      }
      return new Response(null, { status: 404 });
    };

    const findings = await auditGithubPublication({
      apiUrl: "https://api.github.test/",
      fetcher,
      number: 421,
      repo: "example/repository",
      requireKnownValues: false,
      surface: { id: 999, kind: "issue_comment" },
      token: "synthetic-github-audit-token",
    });
    const output = formatPrivacyReport(findings);

    expect(output).toBe("PRIVACY GATE: FAIL\nresource_identifier: 1\n");
    expect(output).not.toContain(syntheticIdentifier);
  });

  test("audits issue titles with class-only diagnostics", async () => {
    const syntheticHome = ["", "home", "fixture-person", "issue-title"].join("/");
    const fetcher = async (input: string | URL): Promise<Response> => {
      const url = new URL(input);
      if (url.pathname.endsWith("/issues/448")) return Response.json({ body: "", title: syntheticHome });
      if (url.pathname.endsWith("/issues/448/comments")) return Response.json([]);
      return new Response(null, { status: 404 });
    };

    const findings = await auditGithubPublication({
      apiUrl: "https://api.github.test/",
      fetcher,
      number: 448,
      repo: "example/repository",
      requireKnownValues: false,
      token: "synthetic-github-audit-token",
    });
    const output = formatPrivacyReport(findings);

    expect(output).toBe("PRIVACY GATE: FAIL\nhome_path: 1\n");
    expect(output).not.toContain(syntheticHome);
  });

  test("audits pull-request titles with class-only diagnostics", async () => {
    const syntheticIdentifier = ["12345678", "1234", "4abc", "8def", "123456789abc"].join("-");
    const fetcher = async (input: string | URL): Promise<Response> => {
      const url = new URL(input);
      if (url.pathname.endsWith("/issues/456")) return Response.json({ body: "", pull_request: {}, title: "" });
      if (url.pathname.endsWith("/issues/456/comments")) return Response.json([]);
      if (url.pathname.endsWith("/pulls/456")) return Response.json({ body: "", title: syntheticIdentifier });
      if (url.pathname.endsWith("/pulls/456/comments")) return Response.json([]);
      if (url.pathname.endsWith("/pulls/456/reviews")) return Response.json([]);
      return new Response(null, { status: 404 });
    };

    const findings = await auditGithubPublication({
      apiUrl: "https://api.github.test/",
      fetcher,
      number: 456,
      repo: "example/repository",
      requireKnownValues: false,
      token: "synthetic-github-audit-token",
    });
    const output = formatPrivacyReport(findings);

    expect(output).toBe("PRIVACY GATE: FAIL\nresource_identifier: 1\n");
    expect(output).not.toContain(syntheticIdentifier);
  });

  test("audits extensionless inline Markdown images", async () => {
    const originalOcrLanguages = process.env.LLV_PRIVACY_OCR_LANGUAGES;
    const syntheticHome = ["", "home", "fixture-person", "extensionless-media"].join("/");
    const media = pngWithCustomMetadata("eXIf", syntheticHome);
    const mediaUrl = "https://github.com/example/repository/rendered/capture";
    const requests: string[] = [];
    const languageResult = Bun.spawnSync({ cmd: ["tesseract", "--list-langs"], stderr: "pipe", stdout: "pipe" });
    const ocrLanguage = languageResult.stdout.toString().split(/\r?\n/).find((language) => /^[a-z0-9_]+$/i.test(language) && language !== "osd");
    process.env.LLV_PRIVACY_OCR_LANGUAGES = ocrLanguage ?? "missing-test-language";
    const fetcher = async (input: string | URL): Promise<Response> => {
      const url = new URL(input);
      requests.push(url.href);
      if (url.href === mediaUrl) {
        return new Response(Uint8Array.from(media), { headers: { "content-type": "image/png" } });
      }
      if (url.pathname.endsWith("/issues/448")) {
        return Response.json({ body: `![extensionless](${mediaUrl})`, title: "Synthetic issue" });
      }
      if (url.pathname.endsWith("/issues/448/comments")) return Response.json([]);
      return new Response(null, { status: 404 });
    };

    try {
      const findings = await auditGithubPublication({
        apiUrl: "https://api.github.test/",
        fetcher,
        number: 448,
        repo: "example/repository",
        requireKnownValues: false,
        token: "synthetic-github-audit-token",
      });
      const output = formatPrivacyReport(findings);

      expect(output).toBe("PRIVACY GATE: FAIL\nhome_path: 1\nprovenance_missing: 1\n");
      expect(requests).toHaveLength(3);
      expect(requests.at(-1)).toBe(mediaUrl);
      expect(output).not.toContain(syntheticHome);
    } finally {
      if (originalOcrLanguages === undefined) delete process.env.LLV_PRIVACY_OCR_LANGUAGES;
      else process.env.LLV_PRIVACY_OCR_LANGUAGES = originalOcrLanguages;
    }
  });

  test("audits Markdown images with escaped brackets in their descriptions", async () => {
    const originalOcrLanguages = process.env.LLV_PRIVACY_OCR_LANGUAGES;
    const syntheticHome = ["", "home", "fixture-person", "escaped-bracket-media"].join("/");
    const media = pngWithCustomMetadata("eXIf", syntheticHome);
    const relativeMedia = "rendered/escaped-bracket-capture";
    const resolvedMedia = `https://github.com/example/repository/${relativeMedia}`;
    const requests: string[] = [];
    const languageResult = Bun.spawnSync({ cmd: ["tesseract", "--list-langs"], stderr: "pipe", stdout: "pipe" });
    const ocrLanguage = languageResult.stdout.toString().split(/\r?\n/).find((language) => /^[a-z0-9_]+$/i.test(language) && language !== "osd");
    process.env.LLV_PRIVACY_OCR_LANGUAGES = ocrLanguage ?? "missing-test-language";
    const fetcher = async (input: string | URL): Promise<Response> => {
      const url = new URL(input);
      requests.push(url.href);
      if (url.href === resolvedMedia) {
        return new Response(Uint8Array.from(media), { headers: { "content-type": "image/png" } });
      }
      if (url.pathname.endsWith("/issues/448")) {
        return Response.json({
          body: `![escaped \\]](${relativeMedia})`,
          title: "Synthetic issue",
        });
      }
      if (url.pathname.endsWith("/issues/448/comments")) return Response.json([]);
      return new Response(null, { status: 404 });
    };

    try {
      const findings = await auditGithubPublication({
        apiUrl: "https://api.github.test/",
        fetcher,
        number: 448,
        repo: "example/repository",
        requireKnownValues: false,
        token: "synthetic-github-audit-token",
      });
      const output = formatPrivacyReport(findings);

      expect(output).toBe("PRIVACY GATE: FAIL\nhome_path: 1\nprovenance_missing: 1\n");
      expect(requests).toHaveLength(3);
      expect(requests.at(-1)).toBe(resolvedMedia);
      expect(output).not.toContain(syntheticHome);
    } finally {
      if (originalOcrLanguages === undefined) delete process.env.LLV_PRIVACY_OCR_LANGUAGES;
      else process.env.LLV_PRIVACY_OCR_LANGUAGES = originalOcrLanguages;
    }
  });

  test("audits HTML media across quoted and parse-error attribute delimiters", async () => {
    const originalOcrLanguages = process.env.LLV_PRIVACY_OCR_LANGUAGES;
    const syntheticHome = ["", "home", "fixture-person", "quoted-attribute-media"].join("/");
    const media = pngWithCustomMetadata("eXIf", syntheticHome);
    const mediaPaths = [
      "/user-attachments/assets/quoted-capture",
      "/user-attachments/assets/unquoted-capture",
    ];
    const resolvedMedia = mediaPaths.map((mediaPath) => `https://github.com${mediaPath}`);
    const requests: string[] = [];
    const languageResult = Bun.spawnSync({ cmd: ["tesseract", "--list-langs"], stderr: "pipe", stdout: "pipe" });
    const ocrLanguage = languageResult.stdout.toString().split(/\r?\n/).find((language) => /^[a-z0-9_]+$/i.test(language) && language !== "osd");
    process.env.LLV_PRIVACY_OCR_LANGUAGES = ocrLanguage ?? "missing-test-language";
    const fetcher = async (input: string | URL): Promise<Response> => {
      const url = new URL(input);
      requests.push(url.href);
      if (resolvedMedia.includes(url.href)) {
        return new Response(Uint8Array.from(media), { headers: { "content-type": "image/png" } });
      }
      if (url.pathname.endsWith("/issues/448")) {
        return Response.json({
          body: [
            `<img title=">" src="${mediaPaths[0]}">`,
            `<img title=unquoted" src="${mediaPaths[1]}">`,
          ].join("\n"),
          title: "Synthetic issue",
        });
      }
      if (url.pathname.endsWith("/issues/448/comments")) return Response.json([]);
      return new Response(null, { status: 404 });
    };

    try {
      const findings = await auditGithubPublication({
        apiUrl: "https://api.github.test/",
        fetcher,
        number: 448,
        repo: "example/repository",
        requireKnownValues: false,
        token: "synthetic-github-audit-token",
      });
      const output = formatPrivacyReport(findings);

      expect(output).toBe("PRIVACY GATE: FAIL\nhome_path: 2\nprovenance_missing: 2\n");
      expect(requests).toHaveLength(4);
      expect(requests.slice(-2).sort()).toEqual(resolvedMedia.toSorted());
      expect(output).not.toContain(syntheticHome);
    } finally {
      if (originalOcrLanguages === undefined) delete process.env.LLV_PRIVACY_OCR_LANGUAGES;
      else process.env.LLV_PRIVACY_OCR_LANGUAGES = originalOcrLanguages;
    }
  });

  test("audits slash-delimited HTML media attributes", async () => {
    const originalOcrLanguages = process.env.LLV_PRIVACY_OCR_LANGUAGES;
    const syntheticHome = ["", "home", "fixture-person", "slash-attribute-media"].join("/");
    const media = pngWithCustomMetadata("eXIf", syntheticHome);
    const mediaPath = "/user-attachments/assets/slash-capture";
    const resolvedMedia = `https://github.com${mediaPath}`;
    const requests: string[] = [];
    const languageResult = Bun.spawnSync({ cmd: ["tesseract", "--list-langs"], stderr: "pipe", stdout: "pipe" });
    const ocrLanguage = languageResult.stdout.toString().split(/\r?\n/).find((language) => /^[a-z0-9_]+$/i.test(language) && language !== "osd");
    process.env.LLV_PRIVACY_OCR_LANGUAGES = ocrLanguage ?? "missing-test-language";
    const fetcher = async (input: string | URL): Promise<Response> => {
      const url = new URL(input);
      requests.push(url.href);
      if (url.href === resolvedMedia) {
        return new Response(Uint8Array.from(media), { headers: { "content-type": "image/png" } });
      }
      if (url.pathname.endsWith("/issues/448")) {
        return Response.json({
          body: `<img/src="${mediaPath}">`,
          title: "Synthetic issue",
        });
      }
      if (url.pathname.endsWith("/issues/448/comments")) return Response.json([]);
      return new Response(null, { status: 404 });
    };

    try {
      const findings = await auditGithubPublication({
        apiUrl: "https://api.github.test/",
        fetcher,
        number: 448,
        repo: "example/repository",
        requireKnownValues: false,
        token: "synthetic-github-audit-token",
      });
      const output = formatPrivacyReport(findings);

      expect(output).toBe("PRIVACY GATE: FAIL\nhome_path: 1\nprovenance_missing: 1\n");
      expect(requests).toHaveLength(3);
      expect(requests.at(-1)).toBe(resolvedMedia);
      expect(output).not.toContain(syntheticHome);
    } finally {
      if (originalOcrLanguages === undefined) delete process.env.LLV_PRIVACY_OCR_LANGUAGES;
      else process.env.LLV_PRIVACY_OCR_LANGUAGES = originalOcrLanguages;
    }
  });

  test("audits every extensionless source srcset candidate", async () => {
    const originalOcrLanguages = process.env.LLV_PRIVACY_OCR_LANGUAGES;
    const syntheticHome = ["", "home", "fixture-person", "srcset-media"].join("/");
    const media = pngWithCustomMetadata("eXIf", syntheticHome);
    const mediaUrls = [
      "https://github.com/example/repository/rendered/srcset-one",
      "https://github.com/example/repository/rendered/srcset-two",
    ];
    const requests: string[] = [];
    const languageResult = Bun.spawnSync({ cmd: ["tesseract", "--list-langs"], stderr: "pipe", stdout: "pipe" });
    const ocrLanguage = languageResult.stdout.toString().split(/\r?\n/).find((language) => /^[a-z0-9_]+$/i.test(language) && language !== "osd");
    process.env.LLV_PRIVACY_OCR_LANGUAGES = ocrLanguage ?? "missing-test-language";
    const fetcher = async (input: string | URL): Promise<Response> => {
      const url = new URL(input);
      requests.push(url.href);
      if (mediaUrls.includes(url.href)) {
        return new Response(Uint8Array.from(media), { headers: { "content-type": "image/png" } });
      }
      if (url.pathname.endsWith("/issues/448")) {
        return Response.json({
          body: `<picture><source srcset="${mediaUrls[0]} 1x, ${mediaUrls[1]} 2x"></picture>`,
          title: "Synthetic issue",
        });
      }
      if (url.pathname.endsWith("/issues/448/comments")) return Response.json([]);
      return new Response(null, { status: 404 });
    };

    try {
      const findings = await auditGithubPublication({
        apiUrl: "https://api.github.test/",
        fetcher,
        number: 448,
        repo: "example/repository",
        requireKnownValues: false,
        token: "synthetic-github-audit-token",
      });
      const output = formatPrivacyReport(findings);

      expect(output).toBe("PRIVACY GATE: FAIL\nhome_path: 2\nprovenance_missing: 2\n");
      expect(requests).toHaveLength(4);
      expect(requests.slice(-2).sort()).toEqual(mediaUrls.toSorted());
      expect(output).not.toContain(syntheticHome);
    } finally {
      if (originalOcrLanguages === undefined) delete process.env.LLV_PRIVACY_OCR_LANGUAGES;
      else process.env.LLV_PRIVACY_OCR_LANGUAGES = originalOcrLanguages;
    }
  });

  test("audits relative reference-style Markdown images", async () => {
    const originalOcrLanguages = process.env.LLV_PRIVACY_OCR_LANGUAGES;
    const syntheticHome = ["", "home", "fixture-person", "reference-media"].join("/");
    const media = pngWithCustomMetadata("eXIf", syntheticHome);
    const relativeMedia = "rendered/reference-capture";
    const resolvedMedia = `https://github.com/example/repository/${relativeMedia}`;
    const requests: string[] = [];
    const languageResult = Bun.spawnSync({ cmd: ["tesseract", "--list-langs"], stderr: "pipe", stdout: "pipe" });
    const ocrLanguage = languageResult.stdout.toString().split(/\r?\n/).find((language) => /^[a-z0-9_]+$/i.test(language) && language !== "osd");
    process.env.LLV_PRIVACY_OCR_LANGUAGES = ocrLanguage ?? "missing-test-language";
    const fetcher = async (input: string | URL): Promise<Response> => {
      const url = new URL(input);
      requests.push(url.href);
      if (url.href === resolvedMedia) {
        return new Response(Uint8Array.from(media), { headers: { "content-type": "image/png" } });
      }
      if (url.pathname.endsWith("/issues/448")) {
        return Response.json({
          body: `![reference][capture]\n\n[capture]: ${relativeMedia}`,
          title: "Synthetic issue",
        });
      }
      if (url.pathname.endsWith("/issues/448/comments")) return Response.json([]);
      return new Response(null, { status: 404 });
    };

    try {
      const findings = await auditGithubPublication({
        apiUrl: "https://api.github.test/",
        fetcher,
        number: 448,
        repo: "example/repository",
        requireKnownValues: false,
        token: "synthetic-github-audit-token",
      });
      const output = formatPrivacyReport(findings);

      expect(output).toBe("PRIVACY GATE: FAIL\nhome_path: 1\nprovenance_missing: 1\n");
      expect(requests).toHaveLength(3);
      expect(requests.at(-1)).toBe(resolvedMedia);
      expect(output).not.toContain(syntheticHome);
    } finally {
      if (originalOcrLanguages === undefined) delete process.env.LLV_PRIVACY_OCR_LANGUAGES;
      else process.env.LLV_PRIVACY_OCR_LANGUAGES = originalOcrLanguages;
    }
  });

  test("audits escaped reference labels in Markdown images", async () => {
    const originalOcrLanguages = process.env.LLV_PRIVACY_OCR_LANGUAGES;
    const syntheticHome = ["", "home", "fixture-person", "escaped-reference-media"].join("/");
    const media = pngWithCustomMetadata("eXIf", syntheticHome);
    const mediaPath = "/user-attachments/assets/escaped-reference-capture";
    const resolvedMedia = `https://github.com${mediaPath}`;
    const requests: string[] = [];
    const languageResult = Bun.spawnSync({ cmd: ["tesseract", "--list-langs"], stderr: "pipe", stdout: "pipe" });
    const ocrLanguage = languageResult.stdout.toString().split(/\r?\n/).find((language) => /^[a-z0-9_]+$/i.test(language) && language !== "osd");
    process.env.LLV_PRIVACY_OCR_LANGUAGES = ocrLanguage ?? "missing-test-language";
    const fetcher = async (input: string | URL): Promise<Response> => {
      const url = new URL(input);
      requests.push(url.href);
      if (url.href === resolvedMedia) {
        return new Response(Uint8Array.from(media), { headers: { "content-type": "image/png" } });
      }
      if (url.pathname.endsWith("/issues/448")) {
        return Response.json({
          body: `![alt][a\\]b]\n\n[a\\]b]: ${mediaPath}`,
          title: "Synthetic issue",
        });
      }
      if (url.pathname.endsWith("/issues/448/comments")) return Response.json([]);
      return new Response(null, { status: 404 });
    };

    try {
      const findings = await auditGithubPublication({
        apiUrl: "https://api.github.test/",
        fetcher,
        number: 448,
        repo: "example/repository",
        requireKnownValues: false,
        token: "synthetic-github-audit-token",
      });
      const output = formatPrivacyReport(findings);

      expect(output).toBe("PRIVACY GATE: FAIL\nhome_path: 1\nprovenance_missing: 1\n");
      expect(requests).toHaveLength(3);
      expect(requests.at(-1)).toBe(resolvedMedia);
      expect(output).not.toContain(syntheticHome);
    } finally {
      if (originalOcrLanguages === undefined) delete process.env.LLV_PRIVACY_OCR_LANGUAGES;
      else process.env.LLV_PRIVACY_OCR_LANGUAGES = originalOcrLanguages;
    }
  });

  test("audits multiline reference destinations in Markdown images", async () => {
    const originalOcrLanguages = process.env.LLV_PRIVACY_OCR_LANGUAGES;
    const syntheticHome = ["", "home", "fixture-person", "multiline-reference-media"].join("/");
    const media = pngWithCustomMetadata("eXIf", syntheticHome);
    const mediaPath = "/user-attachments/assets/multiline-reference-capture";
    const resolvedMedia = `https://github.com${mediaPath}`;
    const requests: string[] = [];
    const languageResult = Bun.spawnSync({ cmd: ["tesseract", "--list-langs"], stderr: "pipe", stdout: "pipe" });
    const ocrLanguage = languageResult.stdout.toString().split(/\r?\n/).find((language) => /^[a-z0-9_]+$/i.test(language) && language !== "osd");
    process.env.LLV_PRIVACY_OCR_LANGUAGES = ocrLanguage ?? "missing-test-language";
    const fetcher = async (input: string | URL): Promise<Response> => {
      const url = new URL(input);
      requests.push(url.href);
      if (url.href === resolvedMedia) {
        return new Response(Uint8Array.from(media), { headers: { "content-type": "image/png" } });
      }
      if (url.pathname.endsWith("/issues/448")) {
        return Response.json({
          body: `![evidence][capture]\n\n[capture]:\n ${mediaPath}`,
          title: "Synthetic issue",
        });
      }
      if (url.pathname.endsWith("/issues/448/comments")) return Response.json([]);
      return new Response(null, { status: 404 });
    };

    try {
      const findings = await auditGithubPublication({
        apiUrl: "https://api.github.test/",
        fetcher,
        number: 448,
        repo: "example/repository",
        requireKnownValues: false,
        token: "synthetic-github-audit-token",
      });
      const output = formatPrivacyReport(findings);

      expect(output).toBe("PRIVACY GATE: FAIL\nhome_path: 1\nprovenance_missing: 1\n");
      expect(requests).toHaveLength(3);
      expect(requests.at(-1)).toBe(resolvedMedia);
      expect(output).not.toContain(syntheticHome);
    } finally {
      if (originalOcrLanguages === undefined) delete process.env.LLV_PRIVACY_OCR_LANGUAGES;
      else process.env.LLV_PRIVACY_OCR_LANGUAGES = originalOcrLanguages;
    }
  });

  test("fetches entity-encoded GitHub media references for inspection", async () => {
    const originalOcrLanguages = process.env.LLV_PRIVACY_OCR_LANGUAGES;
    const syntheticHome = ["", "home", "fixture-person", "encoded-media"].join("/");
    const media = pngWithCustomMetadata("eXIf", syntheticHome);
    const requests: string[] = [];
    const encodedMedia = "&#104;&amp;#116;&#116;&#112;&#115;&amp;colon;&sol;&sol;github.com/example/repository/assets/encoded.png";
    const languageResult = Bun.spawnSync({ cmd: ["tesseract", "--list-langs"], stderr: "pipe", stdout: "pipe" });
    const ocrLanguage = languageResult.stdout.toString().split(/\r?\n/).find((language) => /^[a-z0-9_]+$/i.test(language) && language !== "osd");
    process.env.LLV_PRIVACY_OCR_LANGUAGES = ocrLanguage ?? "missing-test-language";
    const fetcher = async (input: string | URL): Promise<Response> => {
      const url = new URL(input);
      requests.push(url.href);
      if (url.hostname === "github.com") {
        return new Response(Uint8Array.from(media), { headers: { "content-type": "image/png" } });
      }
      if (url.pathname.endsWith("/issues/448")) {
        return Response.json({ body: `<img src="${encodedMedia}">`, title: "Synthetic issue" });
      }
      if (url.pathname.endsWith("/issues/448/comments")) return Response.json([]);
      return new Response(null, { status: 404 });
    };

    try {
      const findings = await auditGithubPublication({
        apiUrl: "https://api.github.test/",
        fetcher,
        number: 448,
        repo: "example/repository",
        requireKnownValues: false,
        token: "synthetic-github-audit-token",
      });
      const output = formatPrivacyReport(findings);

      expect(output).toBe("PRIVACY GATE: FAIL\nhome_path: 1\nprovenance_missing: 1\n");
      expect(requests).toHaveLength(3);
      expect(requests.at(-1)).toBe("https://github.com/example/repository/assets/encoded.png");
      expect(output).not.toContain(syntheticHome);
      expect(output).not.toContain(encodedMedia);
    } finally {
      if (originalOcrLanguages === undefined) delete process.env.LLV_PRIVACY_OCR_LANGUAGES;
      else process.env.LLV_PRIVACY_OCR_LANGUAGES = originalOcrLanguages;
    }
  });

  test("resolves relative GitHub media references before trusted-host inspection", async () => {
    const originalOcrLanguages = process.env.LLV_PRIVACY_OCR_LANGUAGES;
    const syntheticHome = ["", "home", "fixture-person", "relative-media"].join("/");
    const media = pngWithCustomMetadata("eXIf", syntheticHome);
    const authorizationKey = ["author", "ization"].join("") as "authorization";
    const githubAuthorization = ["Bearer", "synthetic-github-audit-token"].join(" ");
    const requests: Array<{ authorization: string | null; url: string }> = [];
    const languageResult = Bun.spawnSync({ cmd: ["tesseract", "--list-langs"], stderr: "pipe", stdout: "pipe" });
    const ocrLanguage = languageResult.stdout.toString().split(/\r?\n/).find((language) => /^[a-z0-9_]+$/i.test(language) && language !== "osd");
    process.env.LLV_PRIVACY_OCR_LANGUAGES = ocrLanguage ?? "missing-test-language";
    const fetcher = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input);
      requests.push({
        authorization: new Headers(init?.headers).get("authorization"),
        url: url.href,
      });
      if (url.hostname === "github.com" || url.hostname === "raw.githubusercontent.com") {
        return new Response(Uint8Array.from(media), { headers: { "content-type": "image/png" } });
      }
      if (url.pathname.endsWith("/issues/448")) {
        return Response.json({
          body: [
            "![root relative](/user-attachments/assets/capture.png)",
            '<img src="//raw.githubusercontent.com/example/repository/main/capture.png">',
            "![blocked](//127.0.0.2/private.png)",
          ].join("\n"),
          title: "Synthetic issue",
        });
      }
      if (url.pathname.endsWith("/issues/448/comments")) return Response.json([]);
      return new Response(null, { status: 404 });
    };

    try {
      const findings = await auditGithubPublication({
        apiUrl: "https://api.github.test/",
        fetcher,
        number: 448,
        repo: "example/repository",
        requireKnownValues: false,
        token: "synthetic-github-audit-token",
      });
      const output = formatPrivacyReport(findings);

      expect(output).toBe("PRIVACY GATE: FAIL\nhome_path: 2\ninspection_error: 1\nprovenance_missing: 2\n");
      expect(requests).toHaveLength(4);
      expect(requests).toContainEqual({
        [authorizationKey]: githubAuthorization,
        url: "https://github.com/user-attachments/assets/capture.png",
      });
      expect(requests).toContainEqual({
        [authorizationKey]: null,
        url: "https://raw.githubusercontent.com/example/repository/main/capture.png",
      });
      expect(requests.some((request) => request.url.includes("127.0.0.2"))).toBe(false);
      expect(output).not.toContain(syntheticHome);
    } finally {
      if (originalOcrLanguages === undefined) delete process.env.LLV_PRIVACY_OCR_LANGUAGES;
      else process.env.LLV_PRIVACY_OCR_LANGUAGES = originalOcrLanguages;
    }
  });

  test("fails the GitHub audit closed when authentication is unavailable", async () => {
    let requestCount = 0;
    const findings = await auditGithubPublication({
      fetcher: async () => {
        requestCount += 1;
        return new Response(null, { status: 500 });
      },
      number: 456,
      repo: "example/repository",
      requireKnownValues: false,
      token: "",
    });

    expect(formatPrivacyReport(findings)).toBe("PRIVACY GATE: FAIL\nconfiguration_error: 1\n");
    expect(requestCount).toBe(0);
  });

  test("blocks untrusted publication media URLs before network access", async () => {
    const requests: string[] = [];
    const fetcher = async (input: string | URL): Promise<Response> => {
      const url = new URL(input);
      requests.push(url.href);
      if (url.pathname.endsWith("/issues/448")) {
        return Response.json({ body: "![evidence](http://127.0.0.2/private.png)" });
      }
      if (url.pathname.endsWith("/issues/448/comments")) return Response.json([]);
      return new Response(null, { status: 500 });
    };

    const findings = await auditGithubPublication({
      apiUrl: "https://api.github.test/",
      fetcher,
      number: 448,
      repo: "example/repository",
      requireKnownValues: false,
      token: "synthetic-github-audit-token",
    });

    expect(formatPrivacyReport(findings)).toBe("PRIVACY GATE: FAIL\ninspection_error: 1\n");
    expect(requests).toHaveLength(2);
    expect(requests.every((url) => url.startsWith("https://api.github.test/"))).toBe(true);
  });
});

describe("commitMessageFindings", () => {
  function gitRepo(): string {
    const repo = mkdtempSync(join(tmpdir(), "llv-privacy-commit-"));
    temporaryDirectories.push(repo);
    Bun.spawnSync({ cmd: ["git", "init", "-b", "main", repo], stderr: "pipe", stdout: "pipe" });
    Bun.spawnSync({ cmd: ["git", "-C", repo, "config", "user.email", "test@example.com"], stderr: "pipe", stdout: "pipe" });
    Bun.spawnSync({ cmd: ["git", "-C", repo, "config", "user.name", "Test"], stderr: "pipe", stdout: "pipe" });
    writeFileSync(join(repo, "init.txt"), "init");
    Bun.spawnSync({ cmd: ["git", "-C", repo, "add", "."], stderr: "pipe", stdout: "pipe" });
    Bun.spawnSync({ cmd: ["git", "-C", repo, "commit", "-m", "init"], stderr: "pipe", stdout: "pipe" });
    Bun.spawnSync({ cmd: ["git", "-C", repo, "checkout", "-b", "feature"], stderr: "pipe", stdout: "pipe" });
    return repo;
  }

  function commit(repo: string, message: string): void {
    writeFileSync(join(repo, `${Date.now()}.txt`), "x");
    Bun.spawnSync({ cmd: ["git", "-C", repo, "add", "."], stderr: "pipe", stdout: "pipe" });
    Bun.spawnSync({ cmd: ["git", "-C", repo, "commit", "-m", message], stderr: "pipe", stdout: "pipe" });
  }

  function git(repo: string, ...arguments_: string[]): string {
    const result = Bun.spawnSync({
      cmd: ["git", "-C", repo, ...arguments_],
      stderr: "pipe",
      stdout: "pipe",
    });
    return result.stdout.toString();
  }

  /* A commit whose message git records EXACTLY as given. `git commit -m` cleans
     the message up and ends it with a newline; `commit-tree` writes what it is
     handed, which is how a message with no terminal newline reaches a branch. */
  function rawCommit(repo: string, message: string): string {
    const tree = git(repo, "rev-parse", "HEAD^{tree}").trim();
    const parent = git(repo, "rev-parse", "HEAD").trim();
    const result = Bun.spawnSync({
      cmd: ["git", "-C", repo, "commit-tree", tree, "-p", parent],
      stderr: "pipe",
      stdin: new TextEncoder().encode(message),
      stdout: "pipe",
    });
    expect(result.exitCode).toBe(0);
    const commit = result.stdout.toString().trim();
    runGit(repo, ["update-ref", "refs/heads/feature", commit]);
    return commit;
  }

  /* The footer `git cherry-pick -x` appends, spelled out where a test needs the
     shape without performing the pick. */
  const cherryPickLine = `(cherry picked from commit ${"0123456789abcdef".repeat(2) + "01234567"})`;

  test("flags a personal email in a Co-Authored-By trailer", () => {
    const repo = gitRepo();
    const localPart = "someone";
    const domain = "personal.dev";
    commit(repo, `feat: something\n\nCo-Authored-By: Someone <${localPart}@${domain}>`);
    const findings = commitMessageFindings(repo, "main");
    expect(findings.has("email_address")).toBe(true);
  });

  test("flags a home path in a commit message", () => {
    const repo = gitRepo();
    const segment = ["home", "operator"].join("/");
    commit(repo, `fix: update path /${segment}/project/file.ts`);
    const findings = commitMessageFindings(repo, "main");
    expect(findings.has("home_path")).toBe(true);
  });

  test("passes when commit messages contain no sensitive data", () => {
    const repo = gitRepo();
    commit(repo, "feat: add feature X");
    commit(repo, "fix: resolve edge case in Y");
    const findings = commitMessageFindings(repo, "main");
    expect(findings.size).toBe(0);
  });

  test("a vendor no-reply attribution trailer is machine attribution, not a person", () => {
    /* The commit trailer every agent-written commit here carries. It names a
       tool and identifies nobody, and it is on 13 commits of one branch — so
       flagging it would mean either rewriting history on every branch or
       teaching everyone that a red privacy gate is normal. */
    const repo = gitRepo();
    const vendor = ["noreply", "vendor.example.com"].join("@");
    commit(repo, `feat: something\n\nCo-Authored-By: Some Model <${vendor}>`);
    const findings = commitMessageFindings(repo, "main");
    expect(findings.has("email_address")).toBe(false);
  });

  test("the forge support role address is exempt in a sign-off trailer", () => {
    const repo = gitRepo();
    const forgeRole = ["support", "github.com"].join("@");
    commit(
      repo,
      `chore: refresh dependencies\n\nSigned-Off-By: Dependency Tool <${forgeRole}>`,
    );
    const findings = commitMessageFindings(repo, "main");
    expect(findings.has("email_address")).toBe(false);
  });

  test("the forge role exemption preserves another address on the trailer line", () => {
    const repo = gitRepo();
    const forgeRole = ["support", "github.com"].join("@");
    const otherAddress = ["someone", "personal.example"].join("@");
    commit(
      repo,
      `chore: refresh dependencies\n\nSigned-Off-By: ${otherAddress} Dependency Tool <${forgeRole}>`,
    );
    const findings = commitMessageFindings(repo, "main");
    expect(findings.has("email_address")).toBe(true);
  });

  test("the forge role exemption preserves other private trailer content", () => {
    const repo = gitRepo();
    const forgeRole = ["support", "github.com"].join("@");
    const syntheticHome = ["", "home", "fixture-person", "records"].join("/");
    const syntheticCredential =
      ["api", "token"].join("_") + "=synthetic-test-value-1234567890";
    commit(
      repo,
      `chore: refresh dependencies\n\nSigned-Off-By: ${syntheticHome} ${syntheticCredential} Dependency Tool <${forgeRole}>`,
    );
    const findings = commitMessageFindings(repo, "main");
    expect(findings.has("credential")).toBe(true);
    expect(findings.has("home_path")).toBe(true);
    expect(findings.has("email_address")).toBe(false);
  });

  test("the forge support role address remains flagged in the commit body", () => {
    const repo = gitRepo();
    const forgeRole = ["support", "github.com"].join("@");
    commit(
      repo,
      `fix: document the dependency report\n\nSigned-Off-By: Dependency Tool <${forgeRole}>\n\nThe quoted line above came from the report body.`,
    );
    const findings = commitMessageFindings(repo, "main");
    expect(findings.has("email_address")).toBe(true);
  });

  test("a support role address on another domain remains flagged in a trailer", () => {
    const repo = gitRepo();
    const otherRole = ["support", "forge.example.com"].join("@");
    commit(
      repo,
      `chore: refresh dependencies\n\nSigned-Off-By: Dependency Tool <${otherRole}>`,
    );
    const findings = commitMessageFindings(repo, "main");
    expect(findings.has("email_address")).toBe(true);
  });

  test("an account-form no-reply address remains flagged in a trailer", () => {
    const repo = gitRepo();
    const accountAddress = [
      "4242+fixture-account",
      "users.noreply.github.com",
    ].join("@");
    commit(
      repo,
      `chore: refresh dependencies\n\nSigned-Off-By: Dependency Tool <${accountAddress}>`,
    );
    const findings = commitMessageFindings(repo, "main");
    expect(findings.has("email_address")).toBe(true);
  });

  test("a GitHub no-reply address is still an account handle and is still flagged", () => {
    /* The carve-out is the LOCAL PART being exactly noreply, and this is why:
       `<id>+<handle>@users.noreply.github.com` reads as a no-reply address and
       is an account handle with a number in front of it. */
    const repo = gitRepo();
    const handle = ["4242+someone", "users.noreply.github.com"].join("@");
    commit(repo, `feat: something\n\nCo-Authored-By: Someone <${handle}>`);
    const findings = commitMessageFindings(repo, "main");
    expect(findings.has("email_address")).toBe(true);
  });

  test("the carve-out is the trailer only, never the body", () => {
    /* A no-reply address written into prose is not attribution, and the
       exemption must not follow it there. */
    const repo = gitRepo();
    const vendor = ["noreply", "vendor.example.com"].join("@");
    commit(repo, `fix: reported by ${vendor} in the incident thread`);
    const findings = commitMessageFindings(repo, "main");
    expect(findings.has("email_address")).toBe(true);
  });

  test("a trailer-shaped line in the body stays body prose", () => {
    /* The first round filtered every line that looked like a trailer wherever
       it sat, so an address quoted into the body left the scan with it. Git
       reads a trailer block as the final paragraph, and this address is not
       in it. */
    const repo = gitRepo();
    const vendor = ["noreply", "vendor.example.com"].join("@");
    commit(
      repo,
      `fix: quote the incident report\n\nThe report reads:\nSigned-off-by: Some Person <${vendor}>\nand the thread continues below.`,
    );
    const findings = commitMessageFindings(repo, "main");
    expect(findings.has("email_address")).toBe(true);
  });

  test("a quoted local part in the commit body is an address", () => {
    /* Commit message detection could not see a quoted mailbox at all, so
       writing the local part in quotes cleared the gate outright. */
    const repo = gitRepo();
    const quoted = ['"some one"', "personal.example"].join("@");
    commit(repo, `fix: reported by ${quoted} in the incident thread`);
    const findings = commitMessageFindings(repo, "main");
    expect(findings.has("email_address")).toBe(true);
  });

  test("a quoted local part on the exempt trailer line is an address", () => {
    const repo = gitRepo();
    const forgeRole = ["support", "github.com"].join("@");
    const quoted = ['"some one"', "personal.example"].join("@");
    commit(
      repo,
      `chore: refresh dependencies\n\nSigned-Off-By: ${quoted} Dependency Tool <${forgeRole}>`,
    );
    const findings = commitMessageFindings(repo, "main");
    expect(findings.has("email_address")).toBe(true);
  });

  test("a quoted forge role local part is still an address", () => {
    /* Quoting is not the form the forge signs off with, and reading it as the
       same mailbox would mean unquoting RFC 5322 inside a gate that fails
       closed. */
    const repo = gitRepo();
    const quotedRole = ['"support"', "github.com"].join("@");
    commit(
      repo,
      `chore: refresh dependencies\n\nSigned-Off-By: Dependency Tool <${quotedRole}>`,
    );
    const findings = commitMessageFindings(repo, "main");
    expect(findings.has("email_address")).toBe(true);
  });

  test("a trailer that is not machine attribution keeps its address", () => {
    const repo = gitRepo();
    const forgeRole = ["support", "github.com"].join("@");
    commit(
      repo,
      `chore: refresh dependencies\n\nReported-By: Dependency Tool <${forgeRole}>`,
    );
    const findings = commitMessageFindings(repo, "main");
    expect(findings.has("email_address")).toBe(true);
  });

  test("a folded trailer continuation keeps its address", () => {
    /* Git folds a value onto a following indented line; the exemption reads
       the trailer that starts its own line and nothing else. */
    const repo = gitRepo();
    const forgeRole = ["support", "github.com"].join("@");
    commit(
      repo,
      `chore: refresh dependencies\n\nSigned-Off-By: Dependency Tool\n <${forgeRole}>`,
    );
    const findings = commitMessageFindings(repo, "main");
    expect(findings.has("email_address")).toBe(true);
  });

  test("a cherry-picked attribution trailer is still inside the trailer block", () => {
    /* `git cherry-pick -x` writes its own line into the trailer block it
       copies, and git keeps reading that block as one. Requiring every line of
       the final paragraph to be `Token: value` discarded the whole block
       instead, so the standing agent trailer became a finding and a branch
       carrying a cherry-pick could only clear a required check by removing a
       trailer AGENTS.md forbids removing. */
    const repo = gitRepo();
    const vendor = ["noreply", "vendor.example.com"].join("@");
    git(repo, "checkout", "-b", "source");
    commit(repo, `feat: something\n\nCo-Authored-By: Some Model <${vendor}>`);
    const picked = git(repo, "rev-parse", "HEAD").trim();
    git(repo, "checkout", "feature");
    git(repo, "cherry-pick", "-x", picked);

    const message = git(repo, "log", "--format=%B", "-1", "HEAD");
    expect(message).toContain("(cherry picked from commit ");
    const findings = commitMessageFindings(repo, "main");
    expect(findings.has("email_address")).toBe(false);
  });

  test("a cherry-pick line does not turn body prose into a trailer block", () => {
    const repo = gitRepo();
    const vendor = ["noreply", "vendor.example.com"].join("@");
    commit(
      repo,
      `fix: quote the report\n\nThe report reads:\nCo-Authored-By: Some Model <${vendor}>\n${cherryPickLine}`,
    );
    const findings = commitMessageFindings(repo, "main");
    expect(findings.has("email_address")).toBe(true);
  });

  test("the forge's own co-author paragraph does not demote the trailer above it", () => {
    /* A squash merge writes the pull request's commits into one message and
       appends its own co-author paragraph behind a horizontal rule. Reading
       only the message's last paragraph left every trailer the forge wrote
       above that rule outside the block. */
    const repo = gitRepo();
    const vendor = ["noreply", "vendor.example.com"].join("@");
    commit(
      repo,
      `feat: something (#1)\n\nA body paragraph.\n\nCo-Authored-By: Some Model <${vendor}>\n\n---------\n\nCo-authored-by: Some Model <${vendor}>`,
    );
    const findings = commitMessageFindings(repo, "main");
    expect(findings.has("email_address")).toBe(false);
  });

  test("a squashed pull request keeps the trailer block of every commit in it", () => {
    const repo = gitRepo();
    const vendor = ["noreply", "vendor.example.com"].join("@");
    commit(
      repo,
      `feat: two things (#2)\n\n* feat: the first thing\n\nFirst body.\n\nCo-Authored-By: Some Model <${vendor}>\n\n* feat: the second thing\n\nSecond body.\n\nCo-Authored-By: Some Model <${vendor}>\n\n---------\n\nCo-authored-by: Some Model <${vendor}>`,
    );
    const findings = commitMessageFindings(repo, "main");
    expect(findings.has("email_address")).toBe(false);
  });

  test("neither concatenation shape launders a person", () => {
    const repo = gitRepo();
    const person = ["someone", "personal.dev"].join("@");
    const vendor = ["noreply", "vendor.example.com"].join("@");
    commit(repo, `feat: something\n\nCo-Authored-By: Someone <${person}>\n${cherryPickLine}`);
    commit(
      repo,
      `feat: something (#3)\n\n* feat: the first thing\n\nCo-Authored-By: Someone <${person}>\n\n---------\n\nCo-authored-by: Some Model <${vendor}>`,
    );
    const findings = commitMessageFindings(repo, "main");
    expect(findings.get("email_address")).toBe(2);
  });

  test("a bullet after a trailer paragraph is not a squashed message", () => {
    /* The bullets only mark embedded messages when the text is the forge's
       concatenation, which it marks by bulleting the paragraph right after the
       title. A body that merely holds a list is one message with one trailer
       block, and this address is not in it. */
    const repo = gitRepo();
    const forgeRole = ["support", "github.com"].join("@");
    commit(
      repo,
      `fix: document the dependency report\n\nSigned-Off-By: Dependency Tool <${forgeRole}>\n\n* the line above came from the report body`,
    );
    const findings = commitMessageFindings(repo, "main");
    expect(findings.has("email_address")).toBe(true);
  });

  test("the review exempts a detected address rather than skipping text", () => {
    const forgeRole = ["support", "github.com"].join("@");
    const trailer = commitMessageAddressReview(
      `chore: refresh dependencies\n\nSigned-off-by: Dependency Tool <${forgeRole}>`,
    );
    expect(trailer.exempt).toEqual([forgeRole]);
    expect(trailer.attributable).toEqual([]);

    /* The same address in the body is detected by the same scan and stays
       attributable: nothing is removed from the message, the exemption is
       subtracted from what the scan reported. */
    const body = commitMessageAddressReview(`chore: write to ${forgeRole} about it`);
    expect(body.exempt).toEqual([]);
    expect(body.attributable).toEqual([forgeRole]);
  });

  test("ignores resource_identifier and transcript_content classes", () => {
    const repo = gitRepo();
    const uuid = ["550e8400", "e29b", "41d4", "a716", "446655440000"].join("-");
    commit(repo, `fix: handle ${uuid} correctly`);
    const findings = commitMessageFindings(repo, "main");
    expect(findings.has("resource_identifier")).toBe(false);
  });

  test("a message already on the protected base is not this branch's surface", () => {
    /* #1315. The range was `base...HEAD`, and to `git log` three dots are the
       SYMMETRIC difference — not the ancestry cut they are to `git diff` — so
       a branch that was merely BEHIND the base inherited every message the
       base had gained since the fork. The finding named a commit this branch
       did not write and cannot change, and no push it could make would clear
       it. */
    const repo = gitRepo();
    const person = ["someone", "personal.dev"].join("@");
    runGit(repo, ["commit", "--allow-empty", "--quiet", "-m", "feat: the branch's own work"]);
    runGit(repo, ["checkout", "--quiet", "main"]);
    runGit(repo, ["commit", "--allow-empty", "--quiet", "-m", `fix: write to ${person} about it`]);
    runGit(repo, ["checkout", "--quiet", "feature"]);

    expect(commitMessageFindings(repo, "main").size).toBe(0);
  });

  test("the same message on the branch's own commit is still flagged", () => {
    /* The other half of the range: narrowing it must not stop reading what the
       branch does publish. */
    const repo = gitRepo();
    const person = ["someone", "personal.dev"].join("@");
    runGit(repo, ["commit", "--allow-empty", "--quiet", "-m", `fix: write to ${person} about it`]);

    expect(commitMessageFindings(repo, "main").get("email_address")).toBe(1);
  });

  test("names the commit and the field for every message it flags", () => {
    const repo = gitRepo();
    const person = ["someone", "personal.dev"].join("@");
    const segment = ["home", "fixture-person"].join("/");
    runGit(repo, ["commit", "--allow-empty", "--quiet", "-m", `fix: write to ${person} about it`]);
    const first = git(repo, "rev-parse", "HEAD").trim();
    runGit(repo, ["commit", "--allow-empty", "--quiet", "-m", `fix: read /${segment}/notes.txt`]);
    const second = git(repo, "rev-parse", "HEAD").trim();

    const notices: string[] = [];
    commitMessageFindings(repo, "main", notices);

    expect(notices).toEqual([
      `commit_message: ${second.slice(0, 12)} message home_path`,
      `commit_message: ${first.slice(0, 12)} message email_address`,
    ]);
    /* The notice locates the finding; the report is itself published, so it
       never quotes what it found. */
    expect(notices.join("\n")).not.toContain(person);
    expect(notices.join("\n")).not.toContain(segment);
  });

  test("names an unreadable range rather than reporting it silently", () => {
    const repo = gitRepo();
    const notices: string[] = [];

    expect(commitMessageFindings(repo, "no-such-base", notices).get("inspection_error")).toBe(1);
    expect(notices).toEqual(["commit_message: range unreadable"]);
  });

  test("fails closed for a raw commit declaring a legacy message encoding", () => {
    const repo = gitRepo();
    const tree = git(repo, "rev-parse", "HEAD^{tree}").trim();
    const parent = git(repo, "rev-parse", "HEAD").trim();
    const value = "r\u00e9sum\u00e9";
    const header = `tree ${tree}\nparent ${parent}\nauthor Fixture Tool <noreply@example.invalid> 1 +0000\ncommitter Fixture Tool <noreply@example.invalid> 1 +0000\nencoding ISO-8859-1\n\n`;
    const object = Bun.spawnSync(["git", "hash-object", "-t", "commit", "-w", "--stdin"], {
      cwd: repo, stdin: Buffer.concat([Buffer.from(header), Buffer.from(value + "\n", "latin1")]),
      stdout: "pipe", stderr: "pipe",
    });
    expect(object.exitCode).toBe(0);
    runGit(repo, ["update-ref", "refs/heads/feature", object.stdout.toString().trim()]);
    // The previous per-message reader asked Git to transcode this value.
    expect(git(repo, "log", "-1", "--format=%B")).toContain(value);
    const result = runGateArguments(["--base", "main", "--check-commits"], { LLV_PRIVACY_KNOWN_VALUES: value }, repo);
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toContain("inspection_error:");
    expect(result.stdout.toString()).not.toContain(value);
    expect(result.stderr.toString()).toBe("");
  });

  test("reads a message that is nothing but a hash-shaped value", () => {
    /* #1315, second round. The hashes and the messages arrived in one stream
       that carries no lengths, so the reader decided where a message ended by
       SHAPE: forty lowercase hex characters were the next commit's hash. A raw
       commit whose whole message is such a value — and git records one with no
       terminal newline when it is handed one — was read as a hash and never
       scanned, so a value the gate knows passed the check. */
    const repo = gitRepo();
    const value = `${"fedcba9876543210".repeat(2)}89abcdef`;
    const flagged = rawCommit(repo, value);
    /* No terminal newline: the message is the last thing in the object. */
    expect(git(repo, "cat-file", "commit", flagged).endsWith(value)).toBe(true);

    const result = runGateArguments(
      ["--base", "main", "--check-commits"],
      { LLV_PRIVACY_KNOWN_VALUES: value },
      repo,
    );
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe(
      `PRIVACY GATE: FAIL\nknown_value: 1\ncommit_message: ${flagged.slice(0, 12)} message known_value\n`,
    );
    expect(output).not.toContain(value);
  });
});

describe("mergeBoundaryReview", () => {
  /* Every address here is invented. The change is about an address that
     reached the public history, and a fixture that quotes a real one would
     publish it again. */
  const forgeAccountDomain = ["users.noreply", "github.com"].join(".");
  const owner = "privacy-gate-fixture-owner";
  const canonicalIdentity = { email: [`4242+${owner}`, forgeAccountDomain].join("@"), name: "Fixture Maintainer" };
  let fixtureFile = 0;

  function gitRepo(remote = `https://github.com/${owner}/fixture-repository.git`): string {
    const repo = mkdtempSync(join(tmpdir(), "llv-privacy-merge-"));
    temporaryDirectories.push(repo);
    runGit(repo, ["init", "--quiet", "-b", "main", "."]);
    if (remote) runGit(repo, ["remote", "add", "origin", remote]);
    commit(repo, "chore: baseline", canonicalIdentity);
    runGit(repo, ["checkout", "--quiet", "-b", "feature"]);
    return repo;
  }

  function commit(repo: string, message: string, identity: { email: string; name: string }): void {
    fixtureFile += 1;
    writeFileSync(join(repo, `fixture-${fixtureFile}.txt`), "x");
    runGit(repo, ["add", "."]);
    runGit(repo, [
      "-c", `user.name=${identity.name}`,
      "-c", `user.email=${identity.email}`,
      "commit", "--quiet", "-m", message,
    ]);
  }

  function head(repo: string): string {
    const result = Bun.spawnSync({ cmd: ["git", "-C", repo, "rev-parse", "HEAD"], stderr: "pipe", stdout: "pipe" });
    return result.stdout.toString().trim();
  }

  function identityField(repo: string, format: string): string {
    const result = Bun.spawnSync({
      cmd: ["git", "-C", repo, "log", "-1", `--format=${format}`, "HEAD"],
      stderr: "pipe",
      stdout: "pipe",
    });
    return result.stdout.toString().trim();
  }

  test.each(packageVersionSamples)("package versions pass files, commit messages and identities (%#)", (specifier) => {
    const repo = gitRepo();
    writeFileSync(join(repo, "packages.md"), `bun add -g ${specifier}\n`);
    commit(repo, `chore: install ${specifier}`, { email: specifier, name: "Fixture Tool" });

    expect(sensitiveClasses(specifier).has("email_address")).toBe(false);
    expect(commitMessageFindings(repo, "main").size).toBe(0);
    expect(mergeBoundaryReview(repo, "main").findings.size).toBe(0);
    const result = runGateArguments(["--base", "main", "--check-commits"], {}, repo);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("PRIVACY GATE: PASS\n");
    expect(result.stderr.toString()).toBe("");
  });

  test.each(versionLookingRealAddresses)("version-like real domains fail files, commit messages and identities (%#)", (address) => {
    const repo = gitRepo();
    writeFileSync(join(repo, "packages.md"), address);
    commit(repo, `chore: inspect ${address}`, { email: address, name: "Fixture Person" });

    expect(commitMessageFindings(repo, "main").get("email_address")).toBe(1);
    expect(mergeBoundaryReview(repo, "main").findings.get("email_address")).toBe(1);
    const result = runGateArguments(["--base", "main", "--check-commits"], {}, repo);
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toContain("PRIVACY GATE: FAIL\nemail_address: 3\n");
    expect(result.stdout.toString()).not.toContain(address);
    expect(result.stderr.toString()).toBe("");
  });

  test.each(systemdUnitSamples)("systemd unit names pass commit messages and identities (%#)", (unit) => {
    const repo = gitRepo();
    commit(repo, `chore: inspect ${unit}`, { email: unit, name: "Fixture Tool" });

    expect(commitMessageFindings(repo, "main").size).toBe(0);
    expect(mergeBoundaryReview(repo, "main").findings.size).toBe(0);
    const result = runGateArguments(["--base", "main", "--check-commits"], {}, repo);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("PRIVACY GATE: PASS\n");
    expect(result.stderr.toString()).toBe("");
  });

  test.each(unitLookingRealAddresses)("systemd suffix rule keeps real-TLD commits and identities blocked (%#)", (address) => {
    const repo = gitRepo();
    commit(repo, `chore: inspect ${address}`, { email: address, name: "Fixture Person" });

    expect(commitMessageFindings(repo, "main").get("email_address")).toBe(1);
    expect(mergeBoundaryReview(repo, "main").findings.get("email_address")).toBe(1);
    const result = runGateArguments(["--base", "main", "--check-commits"], {}, repo);
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toContain("PRIVACY GATE: FAIL\nemail_address: 2\n");
    expect(result.stdout.toString()).not.toContain(address);
    expect(result.stderr.toString()).toBe("");
  });

  /* What the forge records as COMMITTER on a commit it composes itself: its
     own web-flow mailbox, whose local part is exactly `noreply`. It names the
     forge and identifies nobody, which is why the machine-attribution rule
     already reads it as a tool. */
  const forgeWebFlowIdentity = { email: ["noreply", "github.com"].join("@"), name: "GitHub" };

  /* The commit the "Update branch" button composes: the base merged into the
     branch, authored by the account that pressed it and committed by the
     forge. */
  function mergeAsForge(
    repo: string,
    base: string,
    branch: string,
    author = canonicalIdentity,
    committer = forgeWebFlowIdentity,
  ): void {
    const result = Bun.spawnSync({
      cmd: ["git", "merge", "--quiet", "--no-ff", "-m", `Merge branch '${base}' into ${branch}`, base],
      cwd: repo,
      env: {
        ...process.env,
        GIT_AUTHOR_EMAIL: author.email,
        GIT_AUTHOR_NAME: author.name,
        GIT_COMMITTER_EMAIL: committer.email,
        GIT_COMMITTER_NAME: committer.name,
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
  }

  test("a non-canonical author becomes an attributable trailer at the merge boundary", () => {
    /* Nothing in the message carries this address — git recorded it as the
       author, and the squash merge is what turns it into a trailer. */
    const repo = gitRepo();
    const personal = ["someone", "personal.dev"].join("@");
    commit(repo, "feat: something", { email: personal, name: "Someone" });
    const review = mergeBoundaryReview(repo, "main");

    expect(commitMessageFindings(repo, "main").size).toBe(0);
    expect(review.findings.get("email_address")).toBe(1);
    expect(review.notices).toHaveLength(1);
    expect(review.notices[0]).toContain(head(repo).slice(0, 12));
    expect(review.notices[0]).toContain("author");
    expect(review.notices[0]).toContain("Co-authored-by");
    expect(review.notices[0]).not.toContain(personal);
  });

  test("a canonically authored branch composes nothing attributable", () => {
    const repo = gitRepo();
    commit(repo, "feat: something", canonicalIdentity);
    commit(repo, "fix: something else", canonicalIdentity);
    const review = mergeBoundaryReview(repo, "main");

    expect(review.findings.size).toBe(0);
    expect(review.notices).toEqual([]);
  });

  test("a contributor's forge account identity composes nothing attributable", () => {
    /* The forge issues this address so the contributor's own one is not what
       their commits carry, and the handle in front of it is already public on
       the pull request. Reporting it blocked every outside contribution while
       exempting the repository's own identity, which has the same shape. */
    const repo = gitRepo();
    const contributor = ["77+privacy-gate-fixture-contributor", forgeAccountDomain].join("@");
    commit(repo, "feat: something", { email: contributor, name: "Some Contributor" });
    const review = mergeBoundaryReview(repo, "main");

    expect(review.findings.size).toBe(0);
    expect(review.notices).toEqual([]);
  });

  test("the exemption is the identity path, never the message", () => {
    /* One address, two surfaces. Composed from an identity it publishes an
       account; written into a trailer by hand it is still an account handle
       with a number in front of it, and the trailer rule still reads it that
       way. This change moves the merge boundary and nothing else. */
    const repo = gitRepo();
    const contributor = ["77+privacy-gate-fixture-contributor", forgeAccountDomain].join("@");
    commit(repo, `feat: something\n\nCo-Authored-By: Some Contributor <${contributor}>`, canonicalIdentity);

    expect(mergeBoundaryReview(repo, "main").findings.size).toBe(0);
    expect(commitMessageFindings(repo, "main").get("email_address")).toBe(1);
  });

  test("a vendor no-reply identity stays machine attribution", () => {
    const repo = gitRepo();
    const vendor = ["noreply", "vendor.example.com"].join("@");
    commit(repo, "feat: something", { email: vendor, name: "Some Model" });
    const review = mergeBoundaryReview(repo, "main");

    expect(review.findings.size).toBe(0);
  });

  test("a forge role account identity stays exempt", () => {
    /* The forge merges its own automation's branches — a dependency bump, a
       lockfile refresh — and those commits are authored by an app account on
       the forge's own domain. Flagging one would freeze those merges. */
    const repo = gitRepo();
    const roleAccount = ["4242+fixture-tool[bot]", forgeAccountDomain].join("@");
    commit(repo, "chore: refresh", { email: roleAccount, name: "fixture-tool[bot]" });
    const review = mergeBoundaryReview(repo, "main");

    expect(review.findings.size).toBe(0);
  });

  test("the rule reads the address, not the checkout's remote", () => {
    /* A fork's checkout, a mirror, a bare clone with no origin at all: which
       account the repository belongs to no longer decides anything here, so a
       missing remote neither exempts a person nor reports an account. */
    const withoutRemote = gitRepo("");
    const personal = ["someone", "personal.dev"].join("@");
    commit(withoutRemote, "feat: something", { email: personal, name: "Someone" });
    expect(mergeBoundaryReview(withoutRemote, "main").findings.get("email_address")).toBe(1);

    const forgeAccounts = gitRepo("");
    commit(forgeAccounts, "feat: something", canonicalIdentity);
    expect(mergeBoundaryReview(forgeAccounts, "main").findings.size).toBe(0);
  });

  test("the committer identity publishes too", () => {
    /* A rebase or an amend rewrites the committer and leaves the author
       alone, so the two fields can name different people on one commit. */
    const repo = gitRepo();
    const personal = ["someone", "personal.dev"].join("@");
    commit(repo, "feat: something", canonicalIdentity);
    runGit(repo, [
      "-c", "user.name=Someone",
      "-c", `user.email=${personal}`,
      "commit", "--quiet", "--amend", "--no-edit",
    ]);
    const review = mergeBoundaryReview(repo, "main");

    expect(review.findings.get("email_address")).toBe(1);
    expect(review.notices).toHaveLength(1);
    expect(review.notices[0]).toContain("committer");
  });

  test("reports one finding for a commit whose author and committer are the same person", () => {
    const repo = gitRepo();
    const personal = ["someone", "personal.dev"].join("@");
    commit(repo, "feat: something", { email: personal, name: "Someone" });
    const review = mergeBoundaryReview(repo, "main");

    expect(review.findings.get("email_address")).toBe(1);
  });

  test("reports an unreadable range rather than passing it, and names which read failed", () => {
    const repo = gitRepo();
    const review = mergeBoundaryReview(repo, "no-such-base");

    expect(review.findings.get("inspection_error")).toBe(1);
    expect(review.notices).toEqual(["merge_boundary: range unreadable"]);
  });

  test("both commit reads name themselves when the base cannot be resolved", () => {
    /* One flag runs two reads over the commits. `inspection_error: 2` with no
       notice under it says only that something the gate could not read exists
       somewhere. */
    const repo = gitRepo();
    commit(repo, "feat: something", canonicalIdentity);

    const result = runGateArguments(["--base", "no-such-base", "--check-commits"], {}, repo);

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toContain("commit_message: range unreadable");
    expect(result.stdout.toString()).toContain("merge_boundary: range unreadable");
  });

  test("the gate reads the merge boundary under --check-commits and withholds the address", () => {
    const repo = gitRepo();
    const personal = ["someone", "personal.dev"].join("@");
    commit(repo, "feat: something", { email: personal, name: "Someone" });

    const result = runGateArguments(["--base", "main", "--check-commits"], {}, repo);
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toContain("PRIVACY GATE: FAIL\nemail_address: 1\n");
    expect(output).toContain("merge_boundary: ");
    expect(output).toContain(head(repo).slice(0, 12));
    expect(output).not.toContain(personal);
  });

  test("an address in the commit body is still flagged, and named as a message finding", () => {
    const repo = gitRepo();
    const personal = ["someone", "personal.dev"].join("@");
    commit(repo, `feat: write to ${personal} about it`, canonicalIdentity);

    const result = runGateArguments(["--base", "main", "--check-commits"], {}, repo);
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe(
      `PRIVACY GATE: FAIL\nemail_address: 1\ncommit_message: ${head(repo).slice(0, 12)} message email_address\n`,
    );
    expect(output).not.toContain(personal);
  });

  test("a forge-composed 'Update branch' merge commit passes every field the gate reads", () => {
    /* #1315 read this commit as the one that failed. It is clean on all three
       surfaces, and this pins that: the AUTHOR is an account on the forge's
       no-reply host, the COMMITTER is the forge's own web-flow identity — now
       exempt as an identity of the forge's, where before it passed only as
       some vendor's no-reply mailbox — and the MESSAGE the forge writes
       carries no address at all. The finding on that pull request came from a
       commit already on the base, which the range above no longer reads. */
    const repo = gitRepo();
    commit(repo, "feat: the branch's own work", canonicalIdentity);
    runGit(repo, ["checkout", "--quiet", "main"]);
    commit(repo, "chore: the base moves on", canonicalIdentity);
    runGit(repo, ["checkout", "--quiet", "feature"]);
    mergeAsForge(repo, "main", "feature");

    expect(identityField(repo, "%P").split(" ")).toHaveLength(2);
    expect(identityField(repo, "%ce")).toBe(forgeWebFlowIdentity.email);
    expect(identityField(repo, "%ae")).toBe(canonicalIdentity.email);

    const review = mergeBoundaryReview(repo, "main");
    expect(review.findings.size).toBe(0);
    expect(review.notices).toEqual([]);
    expect(commitMessageFindings(repo, "main").size).toBe(0);

    const result = runGateArguments(["--base", "main", "--check-commits"], {}, repo);
    expect(result.stdout.toString()).toBe("PRIVACY GATE: PASS\n");
    expect(result.exitCode).toBe(0);
  });

  test("a single-parent commit with the forge's web-flow committer is attributable and named", () => {
    /* The forge mailbox identifies a merge only when the commit graph agrees.
       A normal commit can carry the same committer identity, and that field
       remains part of what a squash merge composes into its message even when
       its author happens to carry the identical identity. */
    const repo = gitRepo();
    const personal = ["someone", "personal.dev"].join("@");
    commit(repo, `feat: write to ${personal} about it`, forgeWebFlowIdentity);
    const flagged = head(repo);

    expect(identityField(repo, "%P").split(" ")).toHaveLength(1);
    expect(identityField(repo, "%ae")).toBe(forgeWebFlowIdentity.email);
    expect(identityField(repo, "%ce")).toBe(forgeWebFlowIdentity.email);

    const result = runGateArguments(["--base", "main", "--check-commits"], {}, repo);
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe(
      `PRIVACY GATE: FAIL\nemail_address: 2\n`
      + `commit_message: ${flagged.slice(0, 12)} message email_address\n`
      + `merge_boundary: ${flagged.slice(0, 12)} committer identity composes an attributable `
      + "Co-authored-by trailer (address withheld)\n",
    );
    expect(result.stdout.toString()).not.toContain(personal);
    expect(result.stdout.toString()).not.toContain(forgeWebFlowIdentity.email);
  });

  test("a message with a real-looking address still fails behind a forge merge, and is named", () => {
    /* The narrowed range and the forge exemptions must not carry a person
       across with them: this commit is the branch's own, and the merge that
       follows it publishes it either way. */
    const repo = gitRepo();
    const personal = ["someone", "personal.dev"].join("@");
    commit(repo, `feat: write to ${personal} about it`, canonicalIdentity);
    const flagged = head(repo);
    runGit(repo, ["checkout", "--quiet", "main"]);
    commit(repo, "chore: the base moves on", canonicalIdentity);
    runGit(repo, ["checkout", "--quiet", "feature"]);
    mergeAsForge(repo, "main", "feature");

    const result = runGateArguments(["--base", "main", "--check-commits"], {}, repo);
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe(
      `PRIVACY GATE: FAIL\nemail_address: 1\ncommit_message: ${flagged.slice(0, 12)} message email_address\n`,
    );
    expect(output).not.toContain(personal);
  });

  test("the forge's own committer is exempt while the author of the same commit is still read", () => {
    /* The exemption is the committer field of a commit the forge composed, and
       it covers that field only. The account that pressed the button is the
       author, and a merge whose author is a person publishes that person the
       moment the branch is squashed — so the finding survives the exemption
       and names which of the two fields it came from. */
    const repo = gitRepo();
    const personal = ["someone", "personal.dev"].join("@");
    commit(repo, "feat: the branch's own work", canonicalIdentity);
    runGit(repo, ["checkout", "--quiet", "main"]);
    commit(repo, "chore: the base moves on", canonicalIdentity);
    runGit(repo, ["checkout", "--quiet", "feature"]);
    mergeAsForge(repo, "main", "feature", { email: personal, name: "Someone" });

    expect(identityField(repo, "%ce")).toBe(forgeWebFlowIdentity.email);
    const review = mergeBoundaryReview(repo, "main");

    expect(review.findings.get("email_address")).toBe(1);
    expect(review.notices).toHaveLength(1);
    expect(review.notices[0]).toContain(head(repo).slice(0, 12));
    expect(review.notices[0]).toContain("author");
    expect(review.notices[0]).not.toContain("committer");
    expect(review.notices[0]).not.toContain(personal);
  });

  test("the exemption names the forge's address, and reads the name beside it", () => {
    /* An identity is a name as well as a mailbox, and the mailbox is the only
       part of it the forge decides. A commit committed under the forge's
       address carries whatever name it was committed with — so the exemption
       drops that one address out of what the composed trailer publishes, and
       everything else on the trailer is read as it always was. */
    const repo = gitRepo();
    const personal = ["someone", "personal.dev"].join("@");
    commit(repo, "feat: the branch's own work", canonicalIdentity);
    runGit(repo, ["checkout", "--quiet", "main"]);
    commit(repo, "chore: the base moves on", canonicalIdentity);
    runGit(repo, ["checkout", "--quiet", "feature"]);
    mergeAsForge(repo, "main", "feature", canonicalIdentity, {
      email: forgeWebFlowIdentity.email,
      name: personal,
    });

    expect(identityField(repo, "%P").split(" ")).toHaveLength(2);
    expect(identityField(repo, "%ce")).toBe(forgeWebFlowIdentity.email);
    expect(identityField(repo, "%cn")).toBe(personal);
    const review = mergeBoundaryReview(repo, "main");

    expect(review.findings.get("email_address")).toBe(1);
    expect(review.notices).toHaveLength(1);
    expect(review.notices[0]).toContain("committer");
    expect(review.notices[0]).not.toContain(personal);
  });
});
