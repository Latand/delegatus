import fs from "node:fs";
import path from "node:path";
import { Worker, threadId } from "node:worker_threads";
import { createHash } from "node:crypto";
import { homeDirectory } from "@/lib/platformHome";
import { stateDir, statePath } from "@/lib/configDir";
import { waitForStateLock } from "@/lib/state/lockWait";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { attachReadAttributionWorker } from "@/lib/readAttribution";
import { checkPhotoBytes, defaultDocumentRoots, documentBytesSecret, DocumentRefusal, readExactFile, readUnderRoots, type DocumentEnvironment } from "@/lib/telegram/bot/documents";
import { ExternalRelayError, relayPutBytes } from "./client";
import { uploadedAttachmentSchema, type ExternalRelayRequest, type RelayAttachment, type RelayMediaKind } from "./protocol";
import type { AnswerCapabilities, AnswerDrop, LocalAttachment } from "./answerV2";
import { checkedCaption } from "./answerV2";
const MiB = 1024 * 1024;
const mimeByExtension: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".pdf": "application/pdf", ".txt": "text/plain", ".log": "text/plain", ".md": "text/markdown", ".markdown": "text/markdown", ".json": "application/json", ".csv": "text/csv", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".mp4": "video/mp4" };
const extensions: Record<RelayMediaKind, readonly string[]> = { photo: [".png", ".jpg", ".jpeg"], document: [".png", ".jpg", ".jpeg", ".pdf", ".txt", ".log", ".md", ".markdown", ".json", ".csv"], audio: [".mp3", ".m4a"], video: [".mp4"] };
export type StagedAttachment = { id: string; file: string; filename: string; mime: string; size: number; sha256: string; kind: RelayMediaKind; caption: string };
type AttachmentWorkerJob =
  | { operation:"generated"; refs:LocalAttachment[]; directory:string|null; names:string[]; runDir:string; caps:AnswerCapabilities; drops:AnswerDrop[]; sources:[string,string[]][] }
  | { operation:"owner"; refs:LocalAttachment[]; runDir:string; caps:AnswerCapabilities; drops:AnswerDrop[]; environment:DocumentEnvironment; roots?:string[] }
  | { operation:"read"; file:StagedAttachment };
async function attachmentWorkerPath() {
  const bundled=path.join(process.cwd(),".next/server/relay-attachment-stage-worker.js");
  const source=path.join(process.cwd(),"src/lib/externalRelay/attachmentStage.worker.ts");
  for(const candidate of process.env.NODE_ENV==="production"?[bundled,source]:[source,bundled]) {
    try { await fs.promises.access(candidate);return candidate; } catch { /* Try the other packaged form. */ }
  }
  throw new Error("relay attachment worker is unavailable");
}
async function runAttachmentWorker<T>(job:AttachmentWorkerJob,signal?:AbortSignal):Promise<T> {
  if(signal?.aborted)throw signal.reason ?? new DOMException("attachment work cancelled","AbortError");
  const workerPath=await attachmentWorkerPath();
  if(signal?.aborted)throw signal.reason ?? new DOMException("attachment work cancelled","AbortError");
  return new Promise((resolve,reject)=>{
    let settled=false;
    const worker=new Worker(workerPath,{workerData:job});
    const detachAttribution=attachReadAttributionWorker(worker,"relay-attachment-stage");
    const timer=setTimeout(()=>finish(new Error("relay attachment worker timed out")),60_000);
    const finish=(error?:Error,value?:T)=>{
      if(settled)return;settled=true;clearTimeout(timer);
      signal?.removeEventListener("abort",onAbort);
      detachAttribution();
      void worker.terminate().catch(()=>undefined).then(()=>{
        if(error)reject(error);else resolve(value!);
      });
    };
    const onAbort=()=>finish(signal?.reason instanceof Error?signal.reason:new DOMException("attachment work cancelled","AbortError"));
    signal?.addEventListener("abort",onAbort,{once:true});
    if(signal?.aborted){onAbort();return;}
    const onMessage=(event:{data?:unknown;ok?:boolean;value?:T;error?:{message?:string;code?:string};bytes?:Uint8Array;drops?:AnswerDrop[];workerThreadId?:number})=>{
      if(event && typeof event==="object" && "type" in event && event.type==="delegatus-read-attribution")return;
      const message=(event && typeof event==="object" && "data" in event ? event.data : event) as {ok?:boolean;value?:T;error?:{message?:string;code?:string};bytes?:Uint8Array;drops?:AnswerDrop[];workerThreadId?:number};
      if(!message?.ok) {
        const error=new ExternalRelayError(message?.error?.code ?? "document_invalid");
        finish(error);return;
      }
      if(typeof message.workerThreadId!=="number" || message.workerThreadId===threadId){finish(new Error("relay attachment worker identity was invalid"));return;}
      if(message.drops && "drops" in job) job.drops.splice(0,job.drops.length,...message.drops);
      finish(undefined,(message.bytes ? Buffer.from(message.bytes) : message.value) as T);
    };
    worker.on("message",onMessage);
    worker.once("error",error=>finish(error instanceof Error?error:new Error("relay attachment worker failed")));
    worker.once("exit",code=>{if(!settled)finish(new Error(`relay attachment worker exited (${code})`));});
  });
}
function refuse(code: string): never { throw new ExternalRelayError(code); }
function typeClass(extension: string) { return extensions.photo.includes(extension) ? "image" : extension === ".pdf" ? "pdf" : [".mp3", ".m4a", ".mp4"].includes(extension) ? extension : "text"; }
export function contentDisposition(filename: string) {
  return `attachment; filename="${filename.replace(/[^A-Za-z0-9._ -]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}
export async function validateAttachmentContent(bytes: Buffer, extension: string, kind: RelayMediaKind) {
  const mime = mimeByExtension[extension];
  if (!mime || !extensions[kind]?.includes(extension)) refuse("document_type");
  const signature = extension === ".png" ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : extension === ".jpg" || extension === ".jpeg" ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : extension === ".pdf" ? bytes.subarray(0,5).toString() === "%PDF-"
    : extension === ".mp3" ? validMp3(bytes)
    : extension === ".m4a" || extension === ".mp4" ? validIsoMedia(bytes,extension===".m4a"?"soun":"vide") : true;
  if (!signature) refuse("document_type");
  if (mime.startsWith("image/")) { try { await checkPhotoBytes(bytes); } catch { refuse("document_type"); } }
  if (typeClass(extension) === "text") {
    if (documentBytesSecret(bytes)) refuse("document_secret");
    const text = decodeText(bytes);
    if (text === null || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) refuse("document_type");
    const normalized = text.replace(/^\uFEFF/, "").trimStart();
    // The wire excludes HTML, SVG, archives and executable bytes, regardless
    // of encoding or a selected file's text extension.
    if (/(?:<!doctype\s+html\b|<(?:html|head|body|script|iframe|object|embed|form|meta|link|style|title|div|span|p|a|img|table|ul|ol|li|br|section|main|article|svg)\b)/i.test(normalized) || bytes.subarray(0,2).toString() === "MZ" || bytes.subarray(0,2).toString() === "PK" || bytes.subarray(0,4).equals(Buffer.from([127,69,76,70]))) refuse("document_type");
    if (extension === ".json") { try { JSON.parse(normalized); } catch { refuse("document_type"); } }
  }
  if (extension === ".pdf" && !await validPdf(bytes)) refuse("document_type");
  return mime;
}
function decodeText(bytes: Buffer): string | null {
  try {
    if (bytes.subarray(0,2).equals(Buffer.from([0xff,0xfe]))) return new TextDecoder("utf-16le", { fatal:true }).decode(bytes.subarray(2));
    if (bytes.subarray(0,2).equals(Buffer.from([0xfe,0xff]))) {
      const swapped=Buffer.from(bytes.subarray(2)); for(let i=0;i+1<swapped.length;i+=2) [swapped[i],swapped[i+1]]=[swapped[i+1]!,swapped[i]!];
      return new TextDecoder("utf-16le", { fatal:true }).decode(swapped);
    }
    const sample=bytes.subarray(0,Math.min(bytes.length,4096));let evenZeros=0,oddZeros=0;
    for(let i=0;i<sample.length;i++)if(sample[i]===0){if(i%2)oddZeros++;else evenZeros++;}
    if(sample.length>=4 && oddZeros>sample.length/4) return new TextDecoder("utf-16le",{fatal:true}).decode(bytes);
    if(sample.length>=4 && evenZeros>sample.length/4) {
      const swapped=Buffer.from(bytes); for(let i=0;i+1<swapped.length;i+=2) [swapped[i],swapped[i+1]]=[swapped[i+1]!,swapped[i]!];
      return new TextDecoder("utf-16le", { fatal:true }).decode(swapped);
    }
    return new TextDecoder("utf-8", { fatal:true }).decode(bytes);
  } catch { return null; }
}
function validIsoMedia(bytes: Buffer, expectedHandler:"soun"|"vide"): boolean {
  let offset=0, ftyp=false, mediaData=false;
  while(offset+8<=bytes.length) {
    const size=bytes.readUInt32BE(offset), type=bytes.toString("ascii",offset+4,offset+8);
    const header=size===1?16:8;
    if(offset+header>bytes.length)return false;
    const boxSize=size===0?bytes.length-offset:size===1?Number(bytes.readBigUInt64BE(offset+8)):size;
    if(boxSize<header || boxSize>bytes.length-offset) return false;
    if(type==="ftyp") ftyp=boxSize>=16;
    if(type==="mdat") mediaData=boxSize>header;
    offset+=boxSize;
  }
  if(offset!==bytes.length||!ftyp||!mediaData)return false;
  const moov=readIsoBoxes(bytes,0,bytes.length)?.find(box=>box.type==="moov");
  if(!moov)return false;
  const tracks=readIsoBoxes(bytes,moov.payload,moov.end)?.filter(box=>box.type==="trak")??[];
  return tracks.some(track=>{
    const mdia=readIsoBoxes(bytes,track.payload,track.end)?.find(box=>box.type==="mdia");
    const handler=mdia&&readIsoBoxes(bytes,mdia.payload,mdia.end)?.find(box=>box.type==="hdlr");
    return !!handler&&handler.end-handler.payload>=12&&bytes.toString("ascii",handler.payload+8,handler.payload+12)===expectedHandler;
  });
}
type IsoBox={type:string;payload:number;end:number};
function readIsoBoxes(bytes:Buffer,start:number,end:number):IsoBox[]|null {
  const boxes:IsoBox[]=[];
  for(let offset=start;offset<end;) {
    if(offset+8>end)return null;
    const size=bytes.readUInt32BE(offset),type=bytes.toString("ascii",offset+4,offset+8),header=size===1?16:8;
    if(offset+header>end)return null;
    const boxSize=size===0?end-offset:size===1?Number(bytes.readBigUInt64BE(offset+8)):size;
    if(!Number.isSafeInteger(boxSize)||boxSize<header||boxSize>end-offset)return null;
    boxes.push({type,payload:offset+header,end:offset+boxSize});offset+=boxSize;
  }
  return boxes;
}
async function validPdf(bytes:Buffer):Promise<boolean> {
  if(!/^%PDF-\d\.\d/.test(bytes.toString("latin1",0,8)))return false;
  try {
    const {getDocument}=await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loading=getDocument({data:Uint8Array.from(bytes),isEvalSupported:false,useSystemFonts:false,stopAtErrors:true} as Parameters<typeof getDocument>[0]);
    try { const document=await loading.promise;if(document.numPages<1)return false;await document.getPage(1);return true; }
    finally { await loading.destroy(); }
  } catch { return false; }
}
function validMp3(bytes: Buffer): boolean {
  let offset=0;
  if(bytes.subarray(0,3).toString()==="ID3") {
    if(bytes.length<10 || bytes[6]!>=128 || bytes[7]!>=128 || bytes[8]!>=128 || bytes[9]!>=128) return false;
    const tagSize=(bytes[6]!<<21)|(bytes[7]!<<14)|(bytes[8]!<<7)|bytes[9]!;
    offset=10+tagSize+(bytes[5]!&0x10?10:0);
  }
  if(offset+4>bytes.length) return false;
  const header=bytes.readUInt32BE(offset), version=(header>>>19)&3, layer=(header>>>17)&3, bitrate=(header>>>12)&15, rate=(header>>>10)&3;
  if(((header&0xffe00000)>>>0)!==(0xffe00000>>>0) || version===1 || layer===0 || bitrate===0 || bitrate===15 || rate===3) return false;
  const rates=[44100,48000,32000]; const actualRate=rates[rate]!/(version===3?1:version===2?2:4);
  const kbps=(version===3?[0,32,40,48,56,64,80,96,112,128,160,192,224,256,320]:[0,8,16,24,32,40,48,56,64,80,96,112,128,144,160])[bitrate]!;
  const padding=(header>>>9)&1;
  const frameLength=layer===3?Math.floor(12*kbps*1000/actualRate+padding)*4
    :Math.floor((version===3 || layer!==1?144:72)*kbps*1000/actualRate)+padding;
  return frameLength>=4 && offset+frameLength<=bytes.length;
}
function stage(bytes: Buffer, filename: string, mime: string, ref: LocalAttachment, runDir: string, index: number): StagedAttachment {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const directory = path.join(runDir, "attachments"); fs.mkdirSync(directory, {recursive:true, mode:0o700});
  const file = path.join(directory, `${index}-${crypto.randomUUID()}`);
  fs.writeFileSync(file, bytes, { mode: 0o600, flag: "wx" });
  return { id: `a${index}-${sha256.slice(0,16)}`, file, filename, mime, size: bytes.length, sha256, kind: ref.kind, caption: checkedCaption(ref.caption ?? "") };
}
const reasonOf = (error: unknown) => error instanceof DocumentRefusal && error.code === "document_too_large" ? "too_large" : error instanceof ExternalRelayError || error instanceof DocumentRefusal ? error.code : "document_invalid";
export async function stageGeneratedAttachments(refs: LocalAttachment[], directory: string | null, names: ReadonlySet<string>, runDir: string, caps: AnswerCapabilities, drops: AnswerDrop[], sources: ReadonlyMap<string, ReadonlySet<string>> = directory ? new Map([[directory,names]]) : new Map(),signal?:AbortSignal): Promise<StagedAttachment[]> {
  return withViewerOperation("relay.attachments", async()=>{
    const jobDir=path.join(runDir,`relay-job-${crypto.randomUUID()}`);
    try { return await runAttachmentWorker<StagedAttachment[]>({operation:"generated",refs,directory,names:[...names],runDir:jobDir,caps,drops,sources:[...sources].map(([key,value])=>[key,[...value]])},signal); }
    catch(error) { await fs.promises.rm(jobDir,{recursive:true,force:true});throw error; }
  });
}
/** Worker entry only: descriptor reads, media checks, hashes and writes are sync here. */
export async function stageGeneratedAttachmentsLocal(refs: LocalAttachment[], directory: string | null, names: ReadonlySet<string>, runDir: string, caps: AnswerCapabilities, drops: AnswerDrop[], sources: ReadonlyMap<string, ReadonlySet<string>> = directory ? new Map([[directory,names]]) : new Map()): Promise<StagedAttachment[]> {
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
        const mime = await validateAttachmentContent(bytes, ".png", ref.kind);
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
export async function stageOwnerAttachments(refs: LocalAttachment[], runDir: string, caps: AnswerCapabilities, drops: AnswerDrop[], environment: DocumentEnvironment = {home:homeDirectory(), stateDir:stateDir()}, rootsOverride?: readonly string[],signal?:AbortSignal): Promise<StagedAttachment[]> {
  return withViewerOperation("relay.attachments", async()=>{
    const jobDir=path.join(runDir,`relay-job-${crypto.randomUUID()}`);
    try { return await runAttachmentWorker<StagedAttachment[]>({operation:"owner",refs,runDir:jobDir,caps,drops,environment,...(rootsOverride?{roots:[...rootsOverride]}:{})},signal); }
    catch(error) { await fs.promises.rm(jobDir,{recursive:true,force:true});throw error; }
  });
}
/** Worker entry only, paired with the exact root and descriptor checks above. */
export async function stageOwnerAttachmentsLocal(refs: LocalAttachment[], runDir: string, caps: AnswerCapabilities, drops: AnswerDrop[], environment: DocumentEnvironment = {home:homeDirectory(), stateDir:stateDir()}, rootsOverride?: readonly string[]): Promise<StagedAttachment[]> {
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
        const mime = await validateAttachmentContent(bytes, extension, ref.kind);
        staged.push(stage(bytes, filename, mime, ref, runDir, index)); total += bytes.length;
      }
      return staged;
    } catch (error) { await removeStaged(staged); throw new ExternalRelayError(reasonOf(error)); }
  });
}
export async function readStagedAttachment(file:StagedAttachment,signal?:AbortSignal):Promise<Buffer> {
  return withViewerOperation("relay.attachments.read",async()=>runAttachmentWorker<Buffer>({operation:"read",file},signal));
}
export function readStagedAttachmentLocal(file:StagedAttachment):Buffer {
  const bytes=readExactFile(file.file,20*MiB).bytes;
  if(bytes.length!==file.size || createHash("sha256").update(bytes).digest("hex")!==file.sha256) refuse("staged_file_changed");
  return bytes;
}
export async function removeStaged(files: StagedAttachment[]) { await Promise.all(files.map(file=>fs.promises.rm(file.file,{force:true}))); }
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
      let bytes:Buffer;
      try { bytes=await readStagedAttachment(file,signal); }
      catch { drops.push({part:"attachment",reason:"staged_file_changed"}); continue; }
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
