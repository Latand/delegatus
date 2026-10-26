import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { join } from "node:path";
import { bundleFromJSON, type SerializedBundle as Bundle } from "@sigstore/bundle";
import { getTrustedRoot } from "@sigstore/tuf";
import { Verifier } from "@sigstore/verify";
import packageInfo from "../../../package.json";

const registry = "https://registry.npmjs.org";
const repository = packageInfo.repository.url.replace(/^git\+/, "").replace(/\.git$/, "");
const predicateType = "https://slsa.dev/provenance/v1";
type VerifyOptions = { certificateIssuer: string; certificateIdentityURI: string; tlogThreshold: number; ctLogThreshold: number; timeout: number; retry: number };
type Verification = (bundle: Bundle, options: VerifyOptions) => Promise<void>;

// Bun's crypto implementation rejects the TUF root signatures that Node verifies.
// Keep Sigstore external in the server build so the Node child uses its installed graph.
async function verifyWithNode(bundle: Bundle, options: VerifyOptions): Promise<void> {
  if (![bundleFromJSON, getTrustedRoot, Verifier].every(value => typeof value === "function")) throw new Error("Sigstore verification is unavailable");
  const script = `
    const {bundleFromJSON}=require("@sigstore/bundle");
    const {getTrustedRoot}=require("@sigstore/tuf");
    const {Verifier,toTrustMaterial,toSignedEntity}=require("@sigstore/verify");
    let input=""; process.stdin.setEncoding("utf8"); process.stdin.on("data",s=>input+=s);
    process.stdin.on("end",async()=>{try {
      const {bundle,options}=JSON.parse(input);
      const root=await getTrustedRoot({timeout:options.timeout,retry:options.retry});
      const verifier=new Verifier(toTrustMaterial(root),{ctlogThreshold:options.ctLogThreshold,tlogThreshold:options.tlogThreshold});
      verifier.verify(toSignedEntity(bundleFromJSON(bundle)),{subjectAlternativeName:options.certificateIdentityURI,extensions:{issuer:options.certificateIssuer}});
    } catch(e) { console.error(e.message); process.exitCode=1; }});`;
  await new Promise<void>((resolve, reject) => {
    const child = spawn("node", ["-e", script], { cwd: process.cwd(), stdio: ["pipe", "ignore", "pipe"], timeout: 45_000, killSignal: "SIGKILL" });
    let error = "";
    child.stderr.on("data", chunk => { error = (error + chunk).slice(-2048); });
    child.stdin.on("error", () => { /* close/error settles the owned process */ });
    child.once("error", () => reject(new Error("Node is required for npm provenance verification")));
    child.once("close", code => code === 0 ? resolve() : reject(new Error(error.trim() || "npm provenance verifier failed or timed out")));
    child.stdin.end(JSON.stringify({ bundle, options }));
  });
}
export type VerifiedArchive = { path: string; remove: () => Promise<void> };

/** Bounded reads share one deadline; redirects cannot change the registry authority. */
async function read(url: string, max: number, fetcher: typeof fetch, signal: AbortSignal): Promise<Buffer> {
  const response = await fetcher(url, { signal, redirect: "error", credentials: "omit" });
  if (!response.ok || !response.body) throw new Error("npm provenance data is unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) throw new Error("npm provenance data exceeds its size limit");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks, size);
}

/** Verify the signed build identity and subject, then download exactly those bytes.
 * Installation uses this archive, so a second registry lookup cannot substitute it. */
export async function verifiedPackageArchive(version: string, target: string, directory: string,
  fetcher: typeof fetch = fetch, verifyBundle: Verification = verifyWithNode): Promise<VerifiedArchive> {
  try {
    if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version) || !/^[a-f0-9]{40}$/.test(target)) throw new Error("invalid release identity");
    const signal = AbortSignal.timeout(45_000);
    const metadata = JSON.parse((await read(`${registry}/delegatus-cli/${version}`, 1024 * 1024, fetcher, signal)).toString());
    if (metadata.name !== "delegatus-cli" || metadata.version !== version || metadata.gitHead !== target) throw new Error("package revision changed");
    const attestationsURL = `${registry}/-/npm/v1/attestations/delegatus-cli@${version}`;
    if (metadata.dist?.attestations?.url !== attestationsURL) throw new Error("the release has no npm provenance attestation");
    const attestations = JSON.parse((await read(attestationsURL, 4 * 1024 * 1024, fetcher, signal)).toString());
    const bundle = attestations.attestations?.find((item: { predicateType?: string }) => item.predicateType === predicateType)?.bundle;
    if (!bundle?.dsseEnvelope || bundle.dsseEnvelope.payloadType !== "application/vnd.in-toto+json") throw new Error("the release has no build provenance");
    const statement = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, "base64").toString());
    const definition = statement.predicate?.buildDefinition;
    const workflow = definition?.externalParameters?.workflow;
    const ref = workflow?.ref;
    if (statement._type !== "https://in-toto.io/Statement/v1" || statement.predicateType !== predicateType
      || workflow?.repository !== repository || workflow?.path !== ".github/workflows/publish.yml"
      || (ref !== `refs/tags/v${version}` && ref !== "refs/heads/main")
      || !definition?.resolvedDependencies?.some((source: { uri?: string; digest?: { gitCommit?: string } }) =>
        source.uri === `git+${repository}@${ref}` && source.digest?.gitCommit === target)) throw new Error("build provenance does not match the release source");
    const subject = statement.subject;
    if (!Array.isArray(subject) || subject.length !== 1 || subject[0]?.name !== `pkg:npm/delegatus-cli@${version}`
      || !/^[a-f0-9]{128}$/.test(subject[0]?.digest?.sha512)) throw new Error("build provenance does not name the package archive");
    await verifyBundle(bundle, { certificateIssuer: "https://token.actions.githubusercontent.com",
      certificateIdentityURI: `${repository}/.github/workflows/publish.yml@${ref}`, tlogThreshold: 1, ctLogThreshold: 1, timeout: 5000, retry: 0 });
    signal.throwIfAborted();
    const archive = await read(`${registry}/delegatus-cli/-/delegatus-cli-${version}.tgz`, 64 * 1024 * 1024, fetcher, signal);
    const digest = createHash("sha512").update(archive).digest();
    if (digest.toString("hex") !== subject[0].digest.sha512 || metadata.dist.integrity !== `sha512-${digest.toString("base64")}`) throw new Error("package archive does not match its signed provenance");
    signal.throwIfAborted();
    const file = join(directory, `verified-${randomUUID()}.tgz`);
    await fs.writeFile(file, archive, { mode: 0o600, flag: "wx" });
    return { path: file, remove: () => fs.rm(file, { force: true }) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "verification failed";
    throw new Error(`Update refused: npm provenance verification failed (${reason})`);
  }
}
