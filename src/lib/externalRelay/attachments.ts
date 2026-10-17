import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { homeDirectory } from "@/lib/platformHome";
import { stateDir, statePath } from "@/lib/configDir";
import { waitForStateLock } from "@/lib/state/lockWait";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { checkPhotoBytes, defaultDocumentRoots, documentBytesSecret, DocumentRefusal, readExactFile, readUnderRoots, type DocumentEnvironment } from "@/lib/telegram/bot/documents";
import { ExternalRelayError, relayPutBytes } from "./client";
import { uploadedAttachmentSchema, type ExternalRelayRequest, type RelayAttachment, type RelayMediaKind } from "./protocol";
import type { AnswerCapabilities, AnswerDrop, LocalAttachment } from "./answerV2";
import { checkedCaption } from "./answerV2";
const MiB = 1024 * 1024;
const mimeByExtension: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".pdf": "application/pdf", ".txt": "text/plain", ".log": "text/plain", ".md": "text/markdown", ".markdown": "text/markdown", ".json": "application/json", ".csv": "text/csv", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".mp4": "video/mp4" };
const extensions: Record<RelayMediaKind, readonly string[]> = { photo: [".png", ".jpg", ".jpeg"], document: [".png", ".jpg", ".jpeg", ".pdf", ".txt", ".log", ".md", ".markdown", ".json", ".csv"], audio: [".mp3", ".m4a"], video: [".mp4"] };
export type StagedAttachment = { id: string; file: string; filename: string; mime: string; size: number; sha256: string; kind: RelayMediaKind; caption: string };
function refuse(code: string): never { throw new ExternalRelayError(code); }
function typeClass(extension: string) { return extensions.photo.includes(extension) ? "image" : extension === ".pdf" ? "pdf" : [".mp3", ".m4a", ".mp4"].includes(extension) ? extension : "text"; }
export function contentDisposition(filename: string) {
  return `attachment; filename="${filename.replace(/[^A-Za-z0-9._ -]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}
async function validateBytes(bytes: Buffer, extension: string, kind: RelayMediaKind) {
  const mime = mimeByExtension[extension];
  if (!mime || !extensions[kind]?.includes(extension)) refuse("document_type");
  const signature = extension === ".png" ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : extension === ".jpg" || extension === ".jpeg" ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : extension === ".pdf" ? bytes.subarray(0,5).toString() === "%PDF-"
    : extension === ".mp3" ? bytes.subarray(0,3).toString() === "ID3" || bytes.length > 1 && bytes[0] === 255 && (bytes[1]! & 224) === 224
    : extension === ".m4a" || extension === ".mp4" ? bytes.length >= 12 && bytes.subarray(4,8).toString() === "ftyp" : true;
  if (!signature) refuse("document_type");
  if (mime.startsWith("image/")) { try { await checkPhotoBytes(bytes); } catch { refuse("document_type"); } }
  if (typeClass(extension) === "text") {
    if (documentBytesSecret(bytes)) refuse("document_secret");
    // The wire excludes HTML, SVG, archives and executable bytes, regardless
    // of a selected file's text extension.
    if (/^﻿?\s*(?:<!doctype\s+html|<html\b|<svg\b)/i.test(bytes.toString("utf8")) || bytes.subarray(0,2).toString() === "MZ" || bytes.subarray(0,2).toString() === "PK" || bytes.subarray(0,4).equals(Buffer.from([127,69,76,70]))) refuse("document_type");
  }
  return mime;
}
function stage(bytes: Buffer, filename: string, mime: string, ref: LocalAttachment, runDir: string, index: number): StagedAttachment {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const directory = path.join(runDir, "attachments"); fs.mkdirSync(directory, {recursive:true, mode:0o700});
  const file = path.join(directory, `${index}-${crypto.randomUUID()}`);
  fs.writeFileSync(file, bytes, { mode: 0o600, flag: "wx" });
  return { id: `a${index}-${sha256.slice(0,16)}`, file, filename, mime, size: bytes.length, sha256, kind: ref.kind, caption: checkedCaption(ref.caption ?? "") };
}
const reasonOf = (error: unknown) => error instanceof DocumentRefusal && error.code === "document_too_large" ? "too_large" : error instanceof ExternalRelayError || error instanceof DocumentRefusal ? error.code : "document_invalid";
export async function stageGeneratedAttachments(refs: LocalAttachment[], directory: string | null, names: ReadonlySet<string>, runDir: string, caps: AnswerCapabilities, drops: AnswerDrop[], sources: ReadonlyMap<string, ReadonlySet<string>> = directory ? new Map([[directory,names]]) : new Map()): Promise<StagedAttachment[]> {
  return withViewerOperation("relay.attachments", async () => {
    const staged: StagedAttachment[] = []; let total = 0;
    for (const [index, original] of refs.entries()) {
      try {
        const name = path.basename(original.path);
        const selected = path.isAbsolute(original.path) ? path.dirname(original.path) : directory;
        if (!selected || !/^[A-Za-z0-9_-]{1,96}\.png$/.test(name) || !sources.get(selected)?.has(name)) refuse("outside_run");
        if (index >= caps.maxItems || !caps.media) refuse("too_many_attachments");
        const { bytes } = readExactFile(path.join(selected!, name), 20 * MiB);
        const ref = { ...original };
        if (ref.kind === "photo" && bytes.length > 8 * MiB) { ref.kind = "document"; drops.push({part:"attachment",index,reason:"photo_as_document"}); }
        if (!caps.kinds.includes(ref.kind)) refuse("media_not_negotiated");
        if (total + bytes.length > caps.maxBytes) refuse("too_large");
        const mime = await validateBytes(bytes, ".png", ref.kind);
        staged.push(stage(bytes, name, mime, ref, runDir, index)); total += bytes.length;
      } catch (error) { drops.push({ part:"attachment", index, reason:reasonOf(error) }); }
    }
    return staged;
  });
}
/** Only read the existing operator setting. A relay answer never creates or
 * migrates the bot database just to select a file. */
async function configuredRoots(environment: DocumentEnvironment): Promise<string[]> {
  const file = statePath("telegram/bot.sqlite");
  if (!fs.existsSync(file)) return defaultDocumentRoots(environment.home);
  return waitForStateLock("relay.document-roots", () => {
    const sqlite=process.getBuiltinModule?.("bun:sqlite") as typeof import("bun:sqlite") | undefined;
    if (!sqlite) throw new Error("Relay document roots require the Bun runtime");
    const db = new sqlite.Database(file, { readonly:true });
    try {
      db.exec("PRAGMA busy_timeout = 0");
      const row = db.query<{value:string},[string]>("SELECT value FROM settings WHERE key = ?1").get("document_roots");
      const value: unknown = row ? JSON.parse(row.value) : null;
      return Array.isArray(value) && value.length && value.every(v => typeof v === "string") ? value as string[] : defaultDocumentRoots(environment.home);
    } finally { db.close(); }
  }, {waitMs:5000});
}
export async function stageOwnerAttachments(refs: LocalAttachment[], runDir: string, caps: AnswerCapabilities, drops: AnswerDrop[], environment: DocumentEnvironment = {home:homeDirectory(), stateDir:stateDir()}, rootsOverride?: readonly string[]): Promise<StagedAttachment[]> {
  return withViewerOperation("relay.attachments", async () => {
    if (refs.length > caps.maxItems || refs.length && !caps.media) refuse("media_not_negotiated");
    if (!refs.length) return [];
    const staged: StagedAttachment[] = []; let total = 0;
    try {
      const roots = rootsOverride ?? await configuredRoots(environment);
      for (const [index, ref] of refs.entries()) {
        if (!ref || typeof ref.path !== "string" || !path.isAbsolute(ref.path) || !caps.kinds.includes(ref.kind)) refuse("document_invalid");
        const filename = ref.filename ?? path.basename(ref.path);
        if (!filename.trim() || [...filename].length > 128 || /[\\/\x00-\x1f\x7f]/.test(filename) || filename.startsWith(".")) refuse("document_invalid");
        if (ref.caption !== undefined && (typeof ref.caption !== "string" || ref.caption !== checkedCaption(ref.caption))) refuse("caption_too_long");
        const { bytes, admitted: extension } = readUnderRoots(ref.path, roots, environment, ref.kind === "photo" ? 8 * MiB : 20 * MiB, real => {
          const ext = path.extname(real).toLowerCase(), shown = path.extname(filename).toLowerCase();
          if (!extensions[ref.kind]?.includes(ext) || !extensions[ref.kind]?.includes(shown) || typeClass(ext) !== typeClass(shown)) refuse("document_type");
          return ext;
        });
        if (total + bytes.length > caps.maxBytes) refuse("too_large");
        const mime = await validateBytes(bytes, extension, ref.kind);
        staged.push(stage(bytes, filename, mime, ref, runDir, index)); total += bytes.length;
      }
      return staged;
    } catch (error) { removeStaged(staged); throw new ExternalRelayError(reasonOf(error)); }
  });
}
export function removeStaged(files: StagedAttachment[]) { for (const file of files) fs.rmSync(file.file,{force:true}); }
export async function uploadAnswerAttachments(relay: {api_base:string;credential:string}, request: ExternalRelayRequest, files: StagedAttachment[], deadline: number, signal: AbortSignal, drops: AnswerDrop[], options: {sleep?: (ms:number,signal:AbortSignal)=>Promise<void>; authorize?:()=>void} = {}): Promise<RelayAttachment[]> {
  return withViewerOperation("relay.attachments.upload", async () => {
    const result: RelayAttachment[] = [];
    const sleep = options.sleep ?? ((ms:number, abort:AbortSignal) => new Promise<void>((resolve,reject) => {
      abort.throwIfAborted(); const done=()=>{abort.removeEventListener("abort",cancel);resolve();};
      const timer=setTimeout(done,ms); const cancel=()=>{clearTimeout(timer);reject(abort.reason);}; abort.addEventListener("abort",cancel,{once:true});
    }));
    for (const file of files) {
      const until = Math.min(Date.now()+30000, deadline-3000);
      if (until <= Date.now()) { drops.push({part:"attachment",reason:"deadline"}); continue; }
      const bytes = readExactFile(file.file,20*MiB).bytes;
      if (bytes.length !== file.size || createHash("sha256").update(bytes).digest("hex") !== file.sha256) { drops.push({part:"attachment",reason:"staged_file_changed"}); continue; }
      let wait=1000;
      while (Date.now()<until) {
        signal.throwIfAborted(); options.authorize?.();
        try {
          const receipt = await relayPutBytes<Record<string,unknown>>(relay.api_base, `/requests/${encodeURIComponent(request.request_id)}/attachments/${file.id}`, bytes,
            {"Content-Type":file.mime,"Content-Disposition":contentDisposition(file.filename),"Delegatus-Relay-Lease":request.lease_id,"Delegatus-Relay-SHA256":file.sha256},relay.credential,
            { signal:AbortSignal.any([signal,AbortSignal.timeout(Math.max(1,until-Date.now()))]), prepareBody:options.authorize });
          signal.throwIfAborted(); options.authorize?.();
          const checked=uploadedAttachmentSchema.safeParse(receipt.body);
          if (!checked.success) refuse("bad_receipt");
          const body=checked.data;
          if (![200,201].includes(receipt.status) || body?.attachment_id!==file.id || body?.sha256!==file.sha256 || body?.byte_size!==file.size || body?.mime_type!==file.mime || body?.filename!==file.filename || Date.parse(body.expires_at) <= Date.now()) refuse("bad_receipt");
          result.push({attachment_id:file.id,kind:file.kind,caption:file.caption}); break;
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof ExternalRelayError) {
            if (error.status===404 || error.status===409 && error.code==="lease_lost") throw error;
            if (error.status===401) { drops.push({part:"attachment",reason:error.code}); return result; }
            if (error.status>=400 && error.status<500 && error.status!==429 || error.code==="bad_receipt") { drops.push({part:"attachment",reason:error.code}); break; }
            if (error.status===429 && error.retryAfterSeconds !== null) wait=Math.max(1,error.retryAfterSeconds*1000);
          }
          if (Date.now()+wait>=until) { drops.push({part:"attachment",reason:"upload_timeout"}); break; }
          await sleep(wait,signal); wait=Math.min(wait*2,4000);
        }
      }
    }
    return result;
  });
}
