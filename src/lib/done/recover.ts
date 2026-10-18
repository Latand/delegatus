import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { writeMediaCopy } from "@/lib/prototypeReview/copy";
import type { PrototypeMedia } from "@/lib/prototypeReview/types";

const exec = promisify(execFile);
const MAX_IMAGE = 4 * 1024 * 1024;
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
    if (!["image/png","image/jpeg","image/webp"].includes(mime)) { await response.body?.cancel(); return null; }
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
    if (url.hostname === "raw.githubusercontent.com" && url.pathname.toLowerCase().startsWith(`/${repository.toLowerCase()}/`) && /\.(png|jpe?g|webp)$/i.test(url.pathname)) return url.href;
    if (url.hostname === "github.com" && /^\/user-attachments\/assets\/[a-f0-9-]+$/.test(url.pathname)) return url.href;
    if (url.hostname === "user-images.githubusercontent.com" && /^\/\d+\/[a-zA-Z0-9._-]+\.(png|jpe?g|webp)$/i.test(url.pathname)) return url.href;
  } catch { /* not a retained GitHub picture */ }
  return null;
}
/** Cold migration only: bounded PR attachments and a named frame in the
 * branch/commits the PR body references. Never fetches or changes git refs. */
export async function recoverDoneFrame(input: FrameRecovery, staging: string, ports: RecoveryPorts = production): Promise<PrototypeMedia | null> {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(input.repository) || !Number.isSafeInteger(input.number) || input.number < 1) return null;
  let body = "";
  try { body = (await ports.command("gh",["pr","view",String(input.number),"--repo",input.repository,"--json","body","--jq",".body"],input.repoDir,256*1024)).toString("utf8"); } catch { /* local git copies may still exist */ }
  const images = [...body.matchAll(/!\[[^\]]*\]\((https:\/\/[^\s)]+)\)|<img\b[^>]*\bsrc=["'](https:\/\/[^"']+)["']/gi)]
    .flatMap(match => { const url=recoveryImageURL(match[1] ?? match[2]!,input.repository); return url ? [url] : []; }).slice(0,4);
  for (const url of images) {
    try {
      const image = await ports.download(url);
      if (image) return await writeMediaCopy(image.data,image.mime as PrototypeMedia["mime"],staging);
    } catch { /* try the next retained copy */ }
  }
  const refs = [
    ...(/^[a-zA-Z0-9._/-]+$/.test(input.branch) && !input.branch.includes("..") ? [`refs/remotes/origin/${input.branch}`] : []),
    ...new Set([...body.matchAll(/\b[a-f0-9]{7,40}\b/g)].map(m=>m[0]).slice(0,3)),
  ];
  for (const ref of refs) {
    try {
      const files = (await ports.command("git",["ls-tree","-r","--name-only","-z",ref],input.repoDir,256*1024)).toString("utf8").split("\0");
      const file = files.find(file => path.posix.basename(file) === input.name && /\.(png|jpe?g|webp)$/i.test(file));
      if (!file) continue;
      const data = await ports.command("git",["show","--no-ext-diff","--no-textconv",`${ref}:${file}`],input.repoDir,MAX_IMAGE);
      const mime = /\.png$/i.test(file) ? "image/png" : /\.webp$/i.test(file) ? "image/webp" : "image/jpeg";
      return await writeMediaCopy(data,mime,staging);
    } catch { /* that ref/file is not available in this installation */ }
  }
  return null;
}
