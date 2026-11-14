import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { checkEnvironment } from "./gate-cache";
import { runPrivacyTestProcess } from "./privacy-test-process";
import { commitInputs } from "./privacy-publication-gate";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const gate = join(import.meta.dir, "privacy-publication-gate.ts");
const home = ["", "home", "fixture-person", "private"].join("/");
const mailbox = ["fixture-person", "private.dev"].join("@");
const storedRule = "A synthetic learned rule whose text must stay private.";
const catalogValue = "synthetic catalog phrase";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "privacy-commits-")); roots.push(root);
  const repo = join(root, "repo"); mkdirSync(repo);
  const env = checkEnvironment(process.env);
  for (const key of Object.keys(env)) if (key.startsWith("GIT_") || key.startsWith("LLV_PRIVACY_")) delete env[key];
  for (const [key, name] of [["HOME", "home"], ["XDG_CONFIG_HOME", "config"], ["TMPDIR", "tmp"], ["LLV_STATE_DIR", "state"]]) {
    env[key] = join(root, name); mkdirSync(env[key]!);
  }
  Object.assign(env, { LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1", GIT_AUTHOR_NAME: "Synthetic", GIT_COMMITTER_NAME: "Synthetic",
    GIT_AUTHOR_EMAIL: "noreply@fixture.invalid", GIT_COMMITTER_EMAIL: "noreply@fixture.invalid",
    GIT_AUTHOR_DATE: "2001-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2001-01-01T00:00:00Z" });
  const git = (...args: string[]) => {
    const result = Bun.spawnSync({ cmd: ["git", "-c", "core.hooksPath=/dev/null", ...args], cwd: repo, env, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return result.stdout.toString().trim();
  };
  const write = (name: string, text: string | Buffer) => writeFileSync(join(repo, name), text);
  const commit = (message = "Synthetic change") => { git("add", "-A"); git("commit", "--quiet", "--allow-empty", "-m", message); };
  git("init", "--quiet", "-b", "main");
  write("content.txt", "baseline\n"); commit("Synthetic base");
  let base = git("rev-parse", "HEAD");
  const catalog = join(root, "catalog.json");
  writeFileSync(catalog, JSON.stringify({ schemaVersion: 1, normalization: "nfkc-lower-alnum-v1", fingerprints: [{
    length: catalogValue.replace(/[^a-z]/g, "").length, exactOnly: false,
    sha256: createHash("sha256").update(catalogValue.replace(/[^a-z]/g, "")).digest("hex"),
  }] }));
  const rules = join(root, "rules.txt"); writeFileSync(rules, storedRule);
  Object.assign(env, { LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE: catalog, LLV_PRIVACY_KNOWN_VALUES_FILE: rules });
  const scan = (extra: string[] = [], added = true) => runPrivacyTestProcess({
    cmd: [process.execPath, gate, "--repository", repo, "--base", base, "--require-known-values", "--check-commits", ...(added ? ["--added-lines"] : []), ...extra],
    env, cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
  });
  return { root, repo, env, git, write, commit, scan, inputs: () => [...commitInputs(repo, base)],
    rebase: () => { base = git("rev-parse", "HEAD"); } };
}

function refuses(result: Awaited<ReturnType<typeof runPrivacyTestProcess>>, finding: string) {
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(1);
  expect(result.stdout.toString()).toContain(`${finding}:`);
  expect(result.stdout.toString()).not.toContain(home);
  expect(result.stdout.toString()).not.toContain(mailbox);
}
function passes(result: Awaited<ReturnType<typeof runPrivacyTestProcess>>) {
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
  expect(result.stdout.toString()).toContain("PRIVACY GATE: PASS");
}

const violations = [
  ["home_path", home],
  ["email_address", mailbox],
  ["credential", ["api_token", "=", "synthetic".repeat(3)].join("")],
  ["private_network", ["192", "168", "87", "9"].join(".")],
  ["resource_identifier", ["12345678", "1234", "1234", "8234", "123456789abc"].join("-")],
  ["transcript_content", "assistant: synthetic private conversation"],
  ["known_value", storedRule],
  ["known_value", catalogValue],
];
for (const [finding, value] of violations) test(`added ${finding} survives a later deletion (${value === storedRule ? "rule" : value === catalogValue ? "catalog" : "detector"})`, async () => {
  const f = fixture();
  f.write("content.txt", `baseline\n${value}\n`); f.commit();
  f.write("content.txt", "baseline\n"); f.commit();
  refuses(await f.scan(), finding);
});

test("three context lines are inspected; distant pre-existing content and removed lines are excluded locally", async () => {
  const f = fixture();
  f.write("content.txt", [home, ...Array.from({ length: 20 }, (_, n) => `safe row ${n}`)].join("\n") + "\n"); f.commit(); f.rebase();
  f.write("content.txt", [home, ...Array.from({ length: 20 }, (_, n) => `safe row ${n}`), "new safe row"].join("\n") + "\n"); f.commit();
  passes(await f.scan());
  refuses(await f.scan([], false), "home_path"); // Hosted/default retains whole-file coverage.
  f.write("content.txt", `${home}\nnearby addition\n`); f.commit();
  refuses(await f.scan(), "home_path");
});

test("context joins an addition to the existing beginning of a split value", async () => {
  const f = fixture();
  f.write("content.txt", "synthetic catalog\nsafe suffix\n"); f.commit(); f.rebase();
  f.write("content.txt", "synthetic catalog\nphrase\n"); f.commit();
  refuses(await f.scan(), "known_value");
});

test("deletion-only hunks scan surviving new-side context but omit removed text", async () => {
  const joined = fixture();
  joined.write("content.txt", "synthetic catalog\nunrelated separator\nphrase\n"); joined.commit(); joined.rebase();
  joined.write("content.txt", "synthetic catalog\nphrase\n"); joined.commit();
  refuses(await joined.scan(), "known_value");

  const removed = fixture();
  removed.write("content.txt", `${catalogValue}\nsafe line\n`); removed.commit(); removed.rebase();
  removed.write("content.txt", "safe line\n"); removed.commit();
  passes(await removed.scan());
});

test("symlink-to-regular transition scans identical blob bytes; executable-bit change stays skipped", async () => {
  const f = fixture();
  rmSync(join(f.repo, "content.txt"));
  symlinkSync(home, join(f.repo, "content.txt")); f.commit(); f.rebase();
  rmSync(join(f.repo, "content.txt")); writeFileSync(join(f.repo, "content.txt"), home); f.commit();
  refuses(await f.scan(), "home_path");

  const executable = fixture();
  executable.write("content.txt", "safe executable content\n"); executable.commit(); executable.rebase();
  chmodSync(join(executable.repo, "content.txt"), 0o755); executable.commit();
  passes(await executable.scan());
});

test("working tree, index and untracked content do not enter the pushed commit selection", async () => {
  const f = fixture();
  f.write("content.txt", "safe committed addition\n"); f.commit();
  f.write("content.txt", home); f.git("add", "content.txt");
  f.write("content.txt", mailbox); f.write("untracked.txt", storedRule);
  passes(await f.scan());
  refuses(await f.scan([], false), "email_address");
});

test("renames, unusual filenames and separated hunks keep every new line", async () => {
  const f = fixture();
  f.git("mv", "content.txt", "odd\nname.txt");
  f.write("odd\nname.txt", "baseline\n" + "safe\n".repeat(20) + home); f.commit();
  refuses(await f.scan(), "home_path");
});

test("a merge resolution is inspected relative to its first parent", async () => {
  const f = fixture();
  f.git("checkout", "-qb", "side"); f.write("side.txt", "safe\n"); f.commit();
  f.git("checkout", "main"); f.write("other.txt", "safe\n"); f.commit();
  f.git("merge", "--no-commit", "--no-ff", "side");
  f.write("resolution.txt", home); f.commit();
  f.git("rm", "resolution.txt"); f.commit();
  refuses(await f.scan(), "home_path");
});

test("a base merge scans zero imported paths regardless of import size", async () => {
  const f = fixture(); f.git("branch", "lane");
  for (let n = 0; n < 40; n++) f.write(`import-${n}.txt`, `${catalogValue}\n`);
  f.commit(); f.rebase();
  f.git("checkout", "lane"); f.git("merge", "--no-ff", "-m", "Synthetic base merge", "main");
  expect(f.inputs()).toHaveLength(0);
  passes(await f.scan());
  passes(await f.scan([], false));
});

test("a base merge keeps a known value introduced only by conflict resolution", async () => {
  const f = fixture(); f.git("branch", "lane");
  f.write("content.txt", "published version\n"); f.commit(); f.rebase();
  f.git("checkout", "lane"); f.write("content.txt", "lane version\n"); f.commit();
  // Create the conflicted index through Git, then record the actual resolution.
  const merge = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", "merge", "--no-commit", "--no-ff", "main"],
    { cwd: f.repo, env: f.env, stdout: "pipe", stderr: "pipe" });
  expect(merge.exitCode).toBe(1);
  expect(f.git("ls-files", "-u")).not.toBe("");
  f.write("content.txt", `${catalogValue}\n`); f.commit("Synthetic resolution");
  const resolution = f.git("rev-parse", "HEAD");
  f.write("content.txt", "safe final version\n"); f.commit();
  const result = await f.scan(); refuses(result, "known_value");
  expect(result.stdout.toString()).toContain(`commit_content: ${resolution.slice(0, 12)}`);
});

test("a base merge keeps an ordinary lane commit even when the merge removes its value", async () => {
  const f = fixture(); f.git("branch", "lane");
  f.write("published.txt", "safe\n"); f.commit(); f.rebase();
  f.git("checkout", "lane"); f.write("lane.txt", `${catalogValue}\n`); f.commit();
  const lane = f.git("rev-parse", "HEAD");
  f.git("merge", "--no-commit", "--no-ff", "main");
  f.git("rm", "lane.txt"); f.commit("Synthetic base merge");
  const result = await f.scan(); refuses(result, "known_value");
  expect(result.stdout.toString()).toContain(`commit_content: ${lane.slice(0, 12)}`);
});

test("an unpublished merged parent keeps its known value after merge removal", async () => {
  const f = fixture(); f.git("branch", "lane"); f.git("checkout", "-qb", "side");
  f.write("side.txt", `${catalogValue}\n`); f.commit();
  const side = f.git("rev-parse", "HEAD");
  f.git("checkout", "lane"); f.write("lane.txt", "safe\n"); f.commit();
  f.git("merge", "--no-commit", "--no-ff", "side");
  f.git("rm", "side.txt"); f.commit("Synthetic side merge");
  const result = await f.scan(); refuses(result, "known_value");
  expect(result.stdout.toString()).toContain(`commit_content: ${side.slice(0, 12)}`);
});

for (const location of ["lane", "merge"] as const) for (const field of ["message", "author", "committer"] as const) test(`a base merge keeps the unpublished ${field} known value in the ${location}`, async () => {
  const f = fixture(); f.git("branch", "lane");
  f.write("published.txt", "safe\n"); f.commit(); f.rebase();
  f.git("checkout", "lane");
  const key = field === "author" ? "GIT_AUTHOR_NAME" : "GIT_COMMITTER_NAME";
  const previous = f.env[key];
  if (location === "lane" && field !== "message") f.env[key] = catalogValue;
  f.commit(location === "lane" && field === "message" ? `Synthetic ${catalogValue}` : "Synthetic lane change");
  if (location === "lane") f.env[key] = previous;
  if (location === "merge" && field !== "message") f.env[key] = catalogValue;
  const unpublished = f.git("rev-parse", "HEAD");
  f.git("merge", "--no-ff", "-m", location === "merge" && field === "message" ? `Synthetic ${catalogValue}` : "Synthetic base merge", "main");
  f.env[key] = previous;
  const result = await f.scan(); refuses(result, "known_value");
  expect(result.stdout.toString()).toContain((location === "lane" ? unpublished : f.git("rev-parse", "HEAD")).slice(0, 12));
});

test("a merge into the published first parent keeps resolution content and bounds paths", async () => {
  const f = fixture(); f.git("checkout", "-qb", "lane");
  f.write("lane.txt", "safe\n"); f.commit();
  f.git("checkout", "main");
  for (let n = 0; n < 40; n++) f.write(`import-${n}.txt`, `${catalogValue}\n`);
  f.commit(); f.rebase();
  f.git("merge", "--no-commit", "--no-ff", "lane");
  f.write("resolution.txt", `${catalogValue}\n`); f.commit("Synthetic batch merge");
  expect(f.inputs().map(input => input.path).sort()).toEqual(["lane.txt", "lane.txt", "resolution.txt"]);
  refuses(await f.scan(), "known_value");
});

test("an octopus base merge bounds published paths and keeps every unpublished parent", async () => {
  const f = fixture(); f.git("branch", "lane"); f.git("checkout", "-qb", "side");
  f.write("side.txt", `${catalogValue}\n`); f.commit();
  const side = f.git("rev-parse", "HEAD");
  f.git("checkout", "main");
  for (let n = 0; n < 40; n++) f.write(`import-${n}.txt`, `${catalogValue}\n`);
  f.commit(); f.rebase();
  f.git("checkout", "lane"); f.write("lane.txt", "safe\n"); f.commit();
  f.git("merge", "--no-commit", "--no-ff", "main", "side");
  f.git("rm", "side.txt");
  f.write("resolution.txt", `${catalogValue}\n`); f.commit("Synthetic octopus merge");
  const merge = f.git("rev-parse", "HEAD");
  expect(f.git("rev-list", "--parents", "-1", "HEAD").split(" ")).toHaveLength(4);
  expect(f.inputs().map(input => input.path).sort()).toEqual(["lane.txt", "lane.txt", "resolution.txt", "side.txt"]);
  const result = await f.scan(); refuses(result, "known_value");
  for (const commit of [side, merge]) expect(result.stdout.toString()).toContain(`commit_content: ${commit.slice(0, 12)}`);
});

for (const kind of ["utf16", "binary-attribute", "disguised-binary"] as const) test(`historical ${kind} blobs are inspected before a later deletion`, async () => {
  const f = fixture();
  if (kind === "binary-attribute") f.write(".gitattributes", "*.txt -diff\n");
  f.write("content.txt", kind === "utf16" ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(home, "utf16le")])
    : kind === "disguised-binary" ? Buffer.from(`\0${home}\0`) : home);
  f.commit(); f.git("rm", "content.txt"); f.commit();
  refuses(await f.scan(), "home_path");
});

test("ident checkout conversion cannot hide raw learned-rule bytes", async () => {
  const f = fixture();
  const rule = "synthetic $Id$ private rule";
  writeFileSync(f.env.LLV_PRIVACY_KNOWN_VALUES_FILE!, rule);
  f.write(".gitattributes", "*.txt -diff ident\n");
  f.write("content.txt", rule);
  f.commit();
  f.git("rm", "content.txt"); f.commit();
  refuses(await f.scan(), "known_value");
});

for (const attributeState of ["dirty removal", "later committed removal"] as const) test(`historical binary attributes survive ${attributeState}`, async () => {
  const f = fixture();
  f.write(".gitattributes", "*.txt -diff\n");
  f.write("content.txt", `synthetic catalog\n${"\n".repeat(10)}unrelated separator\n${"\n".repeat(10)}phrase\n`);
  f.commit(); f.rebase();
  f.write("content.txt", `synthetic catalog\n${"\n".repeat(20)}phrase\n`); f.commit();
  if (attributeState === "dirty removal") {
    rmSync(join(f.repo, ".gitattributes"));
  } else {
    f.git("rm", ".gitattributes"); f.commit();
  }
  refuses(await f.scan(), "known_value");
});

test("new symbolic links are refused even when removed before HEAD", async () => {
  const f = fixture();
  f.git("update-index", "--add", "--cacheinfo", "120000", f.git("hash-object", "-w", "content.txt"), "link");
  f.git("commit", "--quiet", "-m", "Synthetic link");
  f.git("rm", "--cached", "link"); f.commit();
  refuses(await f.scan(), "unsafe_path");
});

test("missing known-value configuration is refused in added-lines mode", async () => {
  const f = fixture();
  delete f.env.LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE; delete f.env.LLV_PRIVACY_KNOWN_VALUES_FILE;
  // The CLI has a committed default catalog; this case explicitly models a
  // caller that opts out so the missing-configuration refusal stays covered.
  f.env.LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE = "";
  refuses(await f.scan(), "configuration_error");
});

test("commit messages keep their privacy checks", async () => {
  const f = fixture();
  f.commit(`Synthetic message ${catalogValue}`);
  refuses(await f.scan(), "known_value");
});

test("recorded identities keep their privacy checks", async () => {
  const f = fixture();
  f.env.GIT_AUTHOR_EMAIL = mailbox; f.commit();
  refuses(await f.scan(), "email_address");
});

function png(withLiveSource = true) {
  const chunk = (kind: string, bytes: Buffer) => {
    const type = Buffer.from(kind); let crc = 0xffffffff;
    for (const byte of Buffer.concat([type, bytes])) {
      crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    const size = Buffer.alloc(4); size.writeUInt32BE(bytes.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, type, bytes, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header),
    chunk("tEXt", Buffer.from(`Description\0${home}`)), ...(withLiveSource ? [chunk("tEXt", Buffer.from("capture-source\0live-fixture"))] : []), chunk("IDAT", deflateSync(Buffer.from([0, 0, 0, 0]))), chunk("IEND", Buffer.alloc(0))]);
}

test("historical image blobs retain metadata, OCR and provenance checks", async () => {
  const f = fixture();
  const bin = join(f.root, "bin"); mkdirSync(bin);
  const tesseract = join(bin, "tesseract");
  const trace = join(f.root, "ocr-calls");
  writeFileSync(tesseract, `#!/bin/sh\nprintf 'call\\n' >> '${trace}'\nprintf '%s\\n' '${mailbox}'\n`); chmodSync(tesseract, 0o755);
  f.env.PATH = `${bin}:${f.env.PATH}`;
  f.write("image.png", png()); f.commit();
  f.write("duplicate.png", png()); f.commit();
  f.git("rm", "image.png", "duplicate.png"); f.commit();
  const result = await f.scan();
  for (const finding of ["home_path", "email_address", "provenance_missing", "media_live_source"]) refuses(result, finding);
  expect(readFileSync(trace, "utf8")).toBe("call\n");
});

test("explicit paths cannot replace the pushed selection", async () => {
  const f = fixture(); f.write("content.txt", home); f.commit();
  f.write("safe.txt", "safe");
  refuses(await f.scan(["--paths", "safe.txt"]), "inspection_error");
});

test("a known value in an identity name remains private beside a safe mailbox", async () => {
  const f = fixture(); f.env.GIT_AUTHOR_NAME = catalogValue; f.commit();
  refuses(await f.scan(), "known_value");
});

test("a removed pre-existing violation is excluded from a distant safe addition", async () => {
  const f = fixture(); const rows = "safe row\n".repeat(20);
  f.write("content.txt", home + "\n" + rows); f.commit(); f.rebase();
  f.write("content.txt", rows + "safe addition\n"); f.commit();
  passes(await f.scan());
});

test("an uninspectable binary blob remains a refusal after it is deleted", async () => {
  const f = fixture(); f.write("opaque.bin", Buffer.from([0xff, 0xff, 0, 1])); f.commit();
  f.git("rm", "opaque.bin"); f.commit();
  refuses(await f.scan(), "inspection_error");
});

test("identical binary blobs keep filename-dependent inspection errors in either path order", async () => {
  const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("safe binary data", "utf16le")]);

  const textOnly = fixture(); textOnly.write("safe.txt", bytes); textOnly.commit();
  passes(await textOnly.scan());

  const binaryOnly = fixture(); binaryOnly.write("opaque.bin", bytes); binaryOnly.commit();
  refuses(await binaryOnly.scan(), "inspection_error");

  const textFirst = fixture();
  textFirst.write("a.txt", bytes); textFirst.write("b.bin", bytes); textFirst.commit();
  refuses(await textFirst.scan(), "inspection_error");

  const binaryFirst = fixture();
  binaryFirst.write("a.bin", bytes); binaryFirst.write("b.txt", bytes); binaryFirst.commit();
  refuses(await binaryFirst.scan(), "inspection_error");
});

test("a historical image cannot borrow a later manifest", async () => {
  const f = fixture(); f.write("image.png", png()); f.write("privacy-manifest.json", "{}"); f.commit();
  f.git("rm", "image.png", "privacy-manifest.json"); f.commit();
  refuses(await f.scan(), "provenance_invalid");
});

test("unavailable OCR can be deferred locally while metadata and provenance still refuse", async () => {
  const f = fixture(); const bin = join(f.root, "only-git"); mkdirSync(bin);
  const nativeGit = Bun.which("git", { PATH: checkEnvironment(process.env).PATH ?? "" });
  if (!nativeGit) throw new Error("Git fixture executable is unavailable");
  symlinkSync(nativeGit, join(bin, "git")); f.env.PATH = bin;
  f.write("image.png", png()); f.commit();
  refuses(await f.scan(), "tool_unavailable");
  const deferred = await f.scan(["--defer-unavailable-media"]);
  refuses(deferred, "home_path"); refuses(deferred, "provenance_missing");
  expect(deferred.stdout.toString()).not.toContain("tool_unavailable:");
});

for (const name of [":(exclude)*.txt", "[abc].txt", "-leading.txt"]) test(`commit paths are literal: ${name}`, async () => {
  const f = fixture(); f.write(name, home); f.commit();
  rmSync(join(f.repo, name)); f.commit();
  refuses(await f.scan(), "home_path");
});

test("approved fixture media passes from its own commit snapshot", async () => {
  const f = fixture(); const folder = "fixtures/approved";
  mkdirSync(join(f.repo, folder), { recursive: true });
  const image = `${folder}/positive.png`; const bytes = png(false);
  const generator = 'const PRIVACY_GENERATOR_RUNTIME = "1.3.3";\nconst PRIVACY_GENERATOR_VERSION = "fixture-generator-v1";\n';
  f.write(`${folder}/generate.ts`, generator); f.write(image, bytes);
  f.write(`${folder}/privacy-manifest.json`, JSON.stringify({ schemaVersion: 2, assets: [{
    path: "positive.png", classification: "adversarial-synthetic", source: "deterministic-generator",
    description: "Approved synthetic fixture used by commit input tests.",
    generator: "generate.ts", generatorRuntime: "bun-1.3.3", generatorVersion: "fixture-generator-v1",
    generatorSha256: createHash("sha256").update(generator).digest("hex"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sourceDigests: [createHash("sha256").update("synthetic source").digest("hex")],
    expectedFindingClasses: ["home_path"],
  }] }));
  f.commit(); f.rebase();
  const bin = join(f.root, "bin"); mkdirSync(bin);
  const tesseract = join(bin, "tesseract"); writeFileSync(tesseract, "#!/bin/sh\nexit 0\n"); chmodSync(tesseract, 0o755);
  f.env.PATH = `${bin}:${f.env.PATH}`;
  f.git("rm", image); f.commit(); f.write(image, bytes); f.commit(); f.git("rm", image); f.commit();
  passes(await f.scan());
});
