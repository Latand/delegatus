import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { writeMediaCopy } from "@/lib/prototypeReview/copy";
import type { PrototypeMedia } from "@/lib/prototypeReview/types";

const exec = promisify(execFile);
const MAX_IMAGE = 4 * 1024 * 1024;
const IMAGE_NAME = /\.(png|jpe?g|webp|gif)$/i;
export interface FrameRecovery {
  repository: string;
  number: number;
  repoDir: string;
  branch: string;
  name: string;
}
export interface RecoveryPorts {
  command(program: "git" | "gh", args: string[], cwd: string, max: number): Promise<Buffer>;
  download(url: string): Promise<{ mime: string; data: Buffer } | null>;
}
const production: RecoveryPorts = {
  async command(program,args,cwd,max) {
    const { stdout } = await exec(program,args,{cwd,timeout:5_000,killSignal:"SIGKILL",maxBuffer:max,encoding:"buffer",env:{...process.env,GH_PROMPT_DISABLED:"1",GIT_TERMINAL_PROMPT:"0"}});
    return stdout;
  },
  async download(url) {
    const response = await fetch(url,{redirect:"error",signal:AbortSignal.timeout(5_000)});
    if (!response.ok || Number(response.headers.get("content-length")) > MAX_IMAGE) { await response.body?.cancel(); return null; }
    const mime = response.headers.get("content-type")?.split(";")[0] ?? "";
    if (!["image/png","image/jpeg","image/webp","image/gif"].includes(mime)) { await response.body?.cancel(); return null; }
    const reader = response.body?.getReader(); if (!reader) return null;
    const chunks: Buffer[] = []; let bytes = 0;
    try {
      for (;;) {
        const {value,done} = await reader.read(); if (done) break;
        bytes += value.length; if (bytes > MAX_IMAGE) return null;
        chunks.push(Buffer.from(value));
      }
      return { mime,data:Buffer.concat(chunks) };
    } finally { await reader.cancel(); }
  },
};
/** A PR may name only its own raw repository images or GitHub's inert image
 * attachment hosts. Redirects, arbitrary hosts, ports and credentials refuse. */
export function recoveryImageURL(raw: string, repository: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return null;
    if (url.hostname === "raw.githubusercontent.com" && url.pathname.toLowerCase().startsWith(`/${repository.toLowerCase()}/`) && IMAGE_NAME.test(url.pathname)) return url.href;
    if (url.hostname === "github.com" && /^\/user-attachments\/assets\/[a-f0-9-]+$/.test(url.pathname)) return url.href;
    if (url.hostname === "user-images.githubusercontent.com" && /^\/\d+\/[a-zA-Z0-9._-]+\.(png|jpe?g|webp|gif)$/i.test(url.pathname)) return url.href;
  } catch { /* not a retained GitHub picture */ }
  return null;
}
function normalizedName(value: string): string {
  return path.posix.basename(value.trim()).replace(/\.(png|jpe?g|webp|gif)$/i, "").toLocaleLowerCase("en-US");
}
function namedAttachments(body: string, repository: string, name: string): string[] {
  const wanted = normalizedName(name);
  if (!wanted) return [];
  const matches = [...body.matchAll(/!\[([^\]]*)\]\((https:\/\/[^\s)]+)(?:\s+["'][^"']*["'])?\)|<img\b([^>]*?)\bsrc=["'](https:\/\/[^"']+)["']([^>]*)>/gi)].slice(0,64)
    .flatMap(match => {
      const label = match[1] ?? `${match[3] ?? ""} ${match[5] ?? ""}`;
      const raw = match[2] ?? match[4]!;
      const url = recoveryImageURL(raw, repository);
      if (!url) return [];
      let urlName = "";
      try { urlName = path.posix.basename(decodeURIComponent(new URL(url).pathname)); } catch { /* rejected below */ }
      const labels = label.match(/[\w.-]+\.(?:png|jpe?g|webp|gif)/gi) ?? [label.trim()];
      return labels.some(candidate => normalizedName(candidate) === wanted) || normalizedName(urlName) === wanted ? [url] : [];
    });
  const unique = [...new Set(matches)];
  return unique.length === 1 ? unique : [];
}
function exactImageName(file: string, name: string): boolean {
  return IMAGE_NAME.test(file) && normalizedName(path.posix.basename(file)) === normalizedName(name);
}
/** Cold migration only: bounded PR attachments and a named frame in the
 * branch/commits the PR body references. Never fetches or changes git refs. */
export async function recoverDoneFrame(input: FrameRecovery, staging: string, ports: RecoveryPorts = production): Promise<PrototypeMedia | null> {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(input.repository) || !Number.isSafeInteger(input.number) || input.number < 1) return null;
  let body = "";
  let headSha = "";
  try {
    const raw = (await ports.command("gh",["pr","view",String(input.number),"--repo",input.repository,"--json","body,headRefOid"],input.repoDir,256*1024)).toString("utf8");
    const pr = JSON.parse(raw) as { body?: unknown; headRefOid?: unknown };
    body = typeof pr.body === "string" ? pr.body : "";
    headSha = typeof pr.headRefOid === "string" && /^[a-f0-9]{40}$/i.test(pr.headRefOid) ? pr.headRefOid : "";
  } catch { /* local git copies may still exist */ }
  const images = namedAttachments(body,input.repository,input.name);
  for (const url of images) {
    try {
      const image = await ports.download(url);
      if (image) return await writeMediaCopy(image.data,image.mime as PrototypeMedia["mime"],staging);
    } catch { /* try the next retained copy */ }
  }
  const refs = [
    ...(/^[a-zA-Z0-9._/-]+$/.test(input.branch) && !input.branch.includes("..") ? [`refs/remotes/origin/${input.branch}`] : []),
    ...(headSha ? [headSha] : []),
    ...new Set([...body.matchAll(/\b[a-f0-9]{7,40}\b/g)].map(m=>m[0]).slice(0,3)),
  ];
  for (const ref of refs) {
    try {
      const files = (await ports.command("git",["ls-tree","-r","--name-only","-z",ref],input.repoDir,256*1024)).toString("utf8").split("\0");
      const named = files.filter(file => exactImageName(file,input.name));
      const file = named.length === 1 ? named[0] : null;
      if (!file) continue;
      const data = await ports.command("git",["show","--no-ext-diff","--no-textconv",`${ref}:${file}`],input.repoDir,MAX_IMAGE);
      const mime = mimeFor(file);
      return await writeMediaCopy(data,mime,staging);
    } catch { /* that ref/file is not available in this installation */ }
  }
  if (headSha) {
    try {
      const tree = JSON.parse((await ports.command("gh",["api",`repos/${input.repository}/git/trees/${headSha}?recursive=1`],input.repoDir,2*1024*1024)).toString("utf8")) as { truncated?: boolean; tree?: Array<{path?:unknown;type?:unknown;sha?:unknown}> };
      const files = (tree.tree ?? []).filter(row => row.type === "blob" && typeof row.path === "string" && typeof row.sha === "string" && exactImageName(row.path,input.name));
      if (!tree.truncated && files.length === 1) {
        const blob = JSON.parse((await ports.command("gh",["api",`repos/${input.repository}/git/blobs/${files[0]!.sha}`],input.repoDir,6*1024*1024)).toString("utf8")) as { encoding?:unknown; content?:unknown; size?:unknown };
        if (blob.encoding === "base64" && typeof blob.content === "string" && typeof blob.size === "number" && Number.isSafeInteger(blob.size) && blob.size > 0 && blob.size <= MAX_IMAGE) {
          const encoded = blob.content.replace(/\s/g,"");
          if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return null;
          const data = Buffer.from(encoded,"base64");
          if (data.length === blob.size) return await writeMediaCopy(data,mimeFor(files[0]!.path as string),staging);
        }
      }
    } catch { /* remote tree unavailable, ambiguous or malformed */ }
  }
  return null;
}
function mimeFor(file: string): PrototypeMedia["mime"] {
  const ext = path.posix.extname(file).toLowerCase();
  return ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : ext === ".gif" ? "image/gif" : "image/jpeg";
}
