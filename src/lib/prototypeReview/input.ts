import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { homeRoot, evidenceRoots, resolveLocal, underRoot, realAllowedRoots } from "@/lib/artifact/localFile";
import type { PublishPrototypeInput } from "./types";

export const PROTOTYPE_LIMITS = {
  variants: 9, media: 240, imageBytes: 4 * 1024 * 1024, videoBytes: 64 * 1024 * 1024,
  imageSetBytes: 48 * 1024 * 1024, setBytes: 192 * 1024 * 1024,
  storeBytes: 2 * 1024 * 1024 * 1024, storedRounds: 200, comment: 20_000,
} as const;
const localPath = z.string().min(1).max(4096).refine(value => !/[\0\r\n]/.test(value));
export const prototypePublishSchema = z.object({
  clientRequestId: z.string().min(1).max(160), taskId: z.string().min(1).optional(),
  title: z.string().trim().min(1).max(120), dir: localPath.optional(),
  variants: z.array(z.object({
    number: z.number().int().min(1).max(9), name: z.string().trim().min(1).max(60),
    description: z.string().trim().min(1).max(300),
    frames: z.array(z.object({ path: localPath, originalPath: localPath.optional(), caption: z.string().max(200),
      width: z.number().int().min(240).max(3840).optional(), lang: z.enum(["en", "uk"]).optional(),
    })).max(240).optional(),
    videos: z.array(z.object({ path: localPath, caption: z.string().max(200) })).max(240).optional(),
  })).min(1).max(9),
}).strict();

export class PrototypeError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
export function parsePrototypeInput(raw: unknown): PublishPrototypeInput {
  const parsed = prototypePublishSchema.safeParse(raw);
  if (!parsed.success) throw new PrototypeError(`invalid prototype publication: ${parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  if (new Set(parsed.data.variants.map(v => v.number)).size !== parsed.data.variants.length) throw new PrototypeError("variant numbers must be unique");
  if (parsed.data.dir && parsed.data.variants.some(v => v.frames?.length || v.videos?.length)) throw new PrototypeError("use dir or explicit frames and videos in variants");
  return parsed.data;
}
function quote(value: string) { return `'${value.replaceAll("'", "'\\''")}'`; }
export function unreadableSource(raw: string): PrototypeError {
  const roots = evidenceRoots().join(", ");
  return new PrototypeError(`${raw} is outside what Delegatus reads or is unreadable. Frames are read from: your worktree (the capture drivers write to .artifacts/ in it); the stage's own directory ($TMPDIR); ${roots}. Nothing was published. Copy the frames and call again with the copy: cp -r ${quote(raw)} ${quote(path.join(evidenceRoots()[0] ?? homeRoot(), "prototype-frames"))}`, 403);
}
/** The image route's roots; evidence video admission is scoped to publishing. */
export async function admittedSource(raw: string): Promise<string> {
  const abs = resolveLocal(raw);
  const fromHome = underRoot(abs, homeRoot());
  if (!fromHome && !evidenceRoots().some(root => underRoot(abs, root))) throw unreadableSource(raw);
  try {
    const real = await fs.realpath(abs);
    const roots = await realAllowedRoots();
    const inEvidence = roots.evidence.some(root => underRoot(real, root));
    if (!(fromHome ? underRoot(real, roots.home) || inEvidence : inEvidence)) throw unreadableSource(raw);
    return real;
  } catch { throw unreadableSource(raw); }
}
export async function expandPrototypeInput(input: PublishPrototypeInput): Promise<PublishPrototypeInput> {
  if (!input.dir) return input;
  const dir = await admittedSource(input.dir);
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { throw unreadableSource(input.dir); }
  const variants = input.variants.map(v => ({ ...v, frames: [...v.frames ?? []], videos: [...v.videos ?? []] }));
  const names = new Set(entries.filter(file => !file.isDirectory()).map(file => file.name));
  for (const file of entries.sort((a,b) => a.name.localeCompare(b.name, "en", { numeric: true }))) {
    if (file.isDirectory() || !/\.(png|jpe?g|webp|mp4|webm)$/i.test(file.name)) continue;
    if (/[-_]original\.(png|jpe?g|webp)$/i.test(file.name)) {
      if (!names.has(file.name.replace(/([-_])original(?=\.)/i,"$1changed"))) throw new PrototypeError("an original filename needs its matching changed picture");
      continue;
    }
    const words = path.parse(file.name).name.split(/[-_]/);
    const match = path.parse(file.name).name.match(/(?:^|[-_])(?:variant[-_]|v)([1-9])(?:[-_]|$)/i);
    const variant = variants.find(v => v.number === Number(match?.[1]));
    if (!variant) throw new PrototypeError("every media filename must name a declared variant (variant-N or vN)");
    const variantEnd = match!.index! + match![0].length - 1;
    const tail = path.parse(file.name).name.slice(variantEnd).split(/[-_]/);
    const widthWord = tail.find(word => /^\d+(?:x\d+)?$/.test(word) && Number(word.split("x")[0]) >= 240 && Number(word.split("x")[0]) <= 3840);
    const lang = words.find(word => word === "en" || word === "uk") as "en" | "uk" | undefined;
    const caption = words.filter(word => word !== "variant" && word !== `v${variant.number}` && word !== String(variant.number) && word !== widthWord && word !== lang).join(" ").slice(0,200);
    const entry = { path: path.join(dir, file.name), caption };
    if (/\.(mp4|webm)$/i.test(file.name)) variant.videos.push(entry);
    else {
      const originalName = file.name.replace(/([-_])changed(?=\.)/i,"$1original");
      const originalPath = originalName !== file.name && names.has(originalName) ? path.join(dir,originalName) : undefined;
      variant.frames.push({ ...entry, ...(originalPath ? { originalPath } : {}), ...(widthWord ? { width: Number(widthWord.split("x")[0]) } : {}), ...(lang ? { lang } : {}) });
    }
  }
  return { ...input, variants };
}
