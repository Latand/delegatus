import { parentPort, workerData, threadId } from "node:worker_threads";
import {
  readStagedAttachmentLocal,
  stageGeneratedAttachmentsLocal,
  stageOwnerAttachmentsLocal,
  type AttachmentWorkerJob,
  type StagedAttachment,
} from "./attachments";

async function run(job:AttachmentWorkerJob) {
  if(job.operation==="generated") return stageGeneratedAttachmentsLocal(job.refs,job.directory,new Set(job.names),job.runDir,job.caps,job.drops,new Map(job.sources.map(([key,value])=>[key,new Set(value)])));
  if(job.operation==="owner") return stageOwnerAttachmentsLocal(job);
  return readStagedAttachmentLocal(job.file);
}

void run(workerData as AttachmentWorkerJob).then(value=>{
  const job=workerData as AttachmentWorkerJob;
  const drops="drops" in job?job.drops:undefined;
  if(Buffer.isBuffer(value)) {
    const bytes=Uint8Array.from(value);
    parentPort?.postMessage({ok:true,bytes,drops,workerThreadId:threadId},[bytes.buffer]);
  } else parentPort?.postMessage({ok:true,value,drops,workerThreadId:threadId});
}).catch(error=>parentPort?.postMessage({ok:false,error:{code:typeof error?.code==="string"?error.code:undefined,message:error instanceof Error?error.message:"attachment staging failed"}}));
