import { parentPort, workerData, threadId } from "node:worker_threads";
import {
  readStagedAttachmentLocal,
  stageGeneratedAttachmentsLocal,
  stageOwnerAttachmentsLocal,
  type StagedAttachment,
} from "./attachments";

type Job =
  | { operation:"generated"; refs:Parameters<typeof stageGeneratedAttachmentsLocal>[0]; directory:string|null; names:string[]; runDir:string; caps:Parameters<typeof stageGeneratedAttachmentsLocal>[4]; drops:Parameters<typeof stageGeneratedAttachmentsLocal>[5]; sources:[string,string[]][] }
  | { operation:"owner"; refs:Parameters<typeof stageOwnerAttachmentsLocal>[0]; runDir:string; caps:Parameters<typeof stageOwnerAttachmentsLocal>[2]; drops:Parameters<typeof stageOwnerAttachmentsLocal>[3]; environment:Parameters<typeof stageOwnerAttachmentsLocal>[4]; roots?:string[] }
  | { operation:"read"; file:StagedAttachment };

async function run(job:Job) {
  if(job.operation==="generated") return stageGeneratedAttachmentsLocal(job.refs,job.directory,new Set(job.names),job.runDir,job.caps,job.drops,new Map(job.sources.map(([key,value])=>[key,new Set(value)])));
  if(job.operation==="owner") return stageOwnerAttachmentsLocal(job.refs,job.runDir,job.caps,job.drops,job.environment,job.roots);
  return readStagedAttachmentLocal(job.file);
}

void run(workerData as Job).then(value=>{
  const job=workerData as Job;
  const drops="drops" in job?job.drops:undefined;
  if(Buffer.isBuffer(value)) {
    const bytes=Uint8Array.from(value);
    parentPort?.postMessage({ok:true,bytes,drops,workerThreadId:threadId},[bytes.buffer]);
  } else parentPort?.postMessage({ok:true,value,drops,workerThreadId:threadId});
}).catch(error=>parentPort?.postMessage({ok:false,error:{code:typeof error?.code==="string"?error.code:undefined,message:error instanceof Error?error.message:"attachment staging failed"}}));
