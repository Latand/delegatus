import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import packageInfo from "../../../package.json";
import { verifiedPackageArchive } from "./provenance";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const directory = await fs.mkdtemp(join(os.tmpdir(), "provenance-")); roots.push(directory);
  const bytes = Buffer.from("signed archive fixture");
  const sha512 = createHash("sha512").update(bytes).digest("hex");
  const repository = packageInfo.repository.url.replace(/^git\+/, "").replace(/\.git$/, "");
  const version = "1.0.1";
  const target = "a".repeat(40);
  const type = "https://slsa.dev/provenance/v1";
  const metadata = { name: "delegatus-cli", version, gitHead: target, dist: {
    integrity: `sha512-${Buffer.from(sha512, "hex").toString("base64")}`,
    attestations: { url: `https://registry.npmjs.org/-/npm/v1/attestations/delegatus-cli@${version}` },
  } };
  const statement = { _type: "https://in-toto.io/Statement/v1", predicateType: type,
    subject: [{ name: `pkg:npm/delegatus-cli@${version}`, digest: { sha512 } }],
    predicate: { buildDefinition: { externalParameters: { workflow: { repository, path: ".github/workflows/publish.yml", ref: `refs/tags/v${version}` } },
      resolvedDependencies: [{ uri: `git+${repository}@refs/tags/v${version}`, digest: { gitCommit: target } }] } } };
  let downloads = 0;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.redirect).toBe("error"); expect(init?.credentials).toBe("omit");
    const url = String(input);
    if (url.endsWith(".tgz")) { downloads++; return new Response(bytes); }
    if (url.includes("/attestations/")) return Response.json({ attestations: [{ predicateType: type,
      bundle: { dsseEnvelope: { payloadType: "application/vnd.in-toto+json", payload: Buffer.from(JSON.stringify(statement)).toString("base64") } } }] });
    return Response.json(metadata);
  }) as unknown as typeof fetch;
  return { directory, bytes, repository, version, target, metadata, statement, fetcher, downloads: () => downloads };
}

test("the verifier pins the signing workflow and installs only the signed archive bytes", async () => {
  const f = await fixture(); let verified = false;
  const archive = await verifiedPackageArchive(f.version, f.target, f.directory, f.fetcher, async (_bundle, options) => {
    expect(options).toMatchObject({ certificateIssuer: "https://token.actions.githubusercontent.com",
      certificateIdentityURI: `${f.repository}/.github/workflows/publish.yml@refs/tags/v${f.version}`, tlogThreshold: 1, ctLogThreshold: 1 });
    expect(f.downloads()).toBe(0); verified = true;
  });
  expect(verified).toBe(true);
  expect(await fs.readFile(archive.path)).toEqual(f.bytes);
  await archive.remove(); expect(await fs.readdir(f.directory)).toEqual([]);
});

for (const defect of ["signature", "revision", "workflow", "subject", "digest", "integrity", "missing", "foreign-url"]) {
  test(`provenance refuses ${defect} and leaves no installable archive`, async () => {
    const f = await fixture();
    if (defect === "revision") f.statement.predicate.buildDefinition.resolvedDependencies[0]!.digest.gitCommit = "b".repeat(40);
    if (defect === "workflow") f.statement.predicate.buildDefinition.externalParameters.workflow.path = ".github/workflows/untrusted.yml";
    if (defect === "subject") f.statement.subject[0]!.name = "pkg:npm/other@1.0.1";
    if (defect === "digest") f.statement.subject[0]!.digest.sha512 = "0".repeat(128);
    if (defect === "integrity") f.metadata.dist.integrity = "sha512-mismatch";
    if (defect === "missing") delete (f.metadata.dist as Partial<typeof f.metadata.dist>).attestations;
    if (defect === "foreign-url") f.metadata.dist.attestations.url = "https://registry.example.invalid/attestations";
    await expect(verifiedPackageArchive(f.version, f.target, f.directory, f.fetcher, async () => {
      if (defect === "signature") throw new Error("invalid signature");
    })).rejects.toThrow("npm provenance verification failed");
    expect(await fs.readdir(f.directory)).toEqual([]);
    if (!["digest", "integrity"].includes(defect)) expect(f.downloads()).toBe(0);
  });
}

test("registry errors and oversized metadata refuse before signature verification", async () => {
  const f = await fixture();
  for (const response of [new Response(null, { status: 503 }), new Response("x".repeat(1024 * 1024 + 1))]) {
    await expect(verifiedPackageArchive(f.version, f.target, f.directory, (async () => response) as unknown as typeof fetch,
      async () => { throw new Error("must not verify"); })).rejects.toThrow("npm provenance");
    expect(await fs.readdir(f.directory)).toEqual([]);
  }
});
