import { relayAnswerSchema } from "./protocol";
export { relayAnswerSchema } from "./protocol";
import { ExternalRelayError } from "./client";
import { liveOwnerRelayRequest } from "./ownerAuthority";
import { answerCapabilities, checkedButtons, type AnswerDrop } from "./answerV2";
import { stageOwnerAttachments, removeStaged, type StagedAttachment } from "./attachments";
import type { ExternalRelayRequest, RelayUrlButton, RelayMention } from "./protocol";
import { scrubOwnerOutput } from "./ownerOutput";
export type OwnerAnswerParts = { format:"plain"|"rich_markdown"; buttons:RelayUrlButton[][]; mentions?:RelayMention[]; attachments:StagedAttachment[] };
type Entry = {relayId:string;request:ExternalRelayRequest;runDir:string;credentials:readonly string[];authorize:()=>boolean;signal?:AbortSignal;open:boolean;sequence:number;parts:OwnerAnswerParts;drops:AnswerDrop[]};
const shared=globalThis as typeof globalThis & {__llvRelayOwnerAnswers?:Map<string,Entry>};
const entries=shared.__llvRelayOwnerAnswers??=new Map<string,Entry>();
export function ownerAnswerDrops(requestId:string) { return entries.get(requestId)?.drops ?? []; }
export function sealOwnerAnswer(requestId:string) {
  const entry=entries.get(requestId);
  if (entry) entry.open=false;
  return entry?.parts;
}
export function openOwnerAnswer(relayId:string,request:ExternalRelayRequest,runDir:string,credentials:readonly string[],authorize:()=>boolean,signal?:AbortSignal) {
  if (!answerCapabilities(request, "").rich || entries.has(request.request_id)) throw new ExternalRelayError("relay_answer_unavailable");
  const entry:Entry={relayId,request,runDir,credentials,authorize,...(signal?{signal}:{}),open:true,sequence:0,parts:{format:"plain",buttons:[],attachments:[]},drops:[]};
  entries.set(request.request_id,entry);
  return {parts:()=>entry.parts, drops:entry.drops,
    close:()=>{entry.open=false;},
    dispose:async(keepFiles=false)=>{entry.open=false; if(entries.get(request.request_id)===entry) entries.delete(request.request_id); if(!keepFiles) await removeStaged(entry.parts.attachments);},
  };
}
export async function relayAnswerOp(conversationId:string,args:unknown) {
  const live=liveOwnerRelayRequest(conversationId);
  const entry=live?entries.get(live.requestId):undefined;
  const available=()=>{
    const current=liveOwnerRelayRequest(conversationId);
    return !!entry && entry.open && entries.get(entry.request.request_id)===entry && entry.authorize() && current?.requestId===entry.request.request_id && current.relayId===entry.relayId && current.targetId===entry.request.target_id;
  };
  if(!entry || !available()) return null;
  const parsed=relayAnswerSchema.safeParse(args);
  if(!parsed.success) {
    if (parsed.error.issues.some(issue => issue.path[0] === "mentions")) throw new ExternalRelayError("malformed", 400);
    throw new ExternalRelayError("invalid_answer_parts");
  }
  const value=parsed.data, caps=answerCapabilities(entry.request,"");
  if (value.mentions?.length && (!caps.mentions || value.format !== "rich_markdown")) throw new ExternalRelayError("malformed", 400);
  const sequence=++entry.sequence;
  const drops:AnswerDrop[]=[];
  const scrub=(text:string)=>scrubOwnerOutput(text,entry.credentials);
  const buttons=checkedButtons(value.buttons??[],caps,drops);
  if(drops.length) throw new ExternalRelayError("button_invalid");
  for(const row of buttons) for(const button of row) {
    if(scrub(button.url)!==button.url || !scrub(button.text).trim()) throw new ExternalRelayError("button_invalid");
    button.text=scrub(button.text);
  }
  const refs=(value.attachments??[]).map(ref=>({...ref,caption:scrub(ref.caption??"")}));
  const files=await stageOwnerAttachments(refs,entry.runDir,caps,drops,undefined,undefined,entry.signal);
  if(!available() || sequence!==entry.sequence) {await removeStaged(files);return null;}
  const old=entry.parts.attachments;
  entry.parts={format:value.format??"plain",buttons,...(value.mentions ? {mentions:value.mentions} : {}),attachments:files}; entry.drops.push(...drops);
  await removeStaged(old);
  return {format:entry.parts.format,buttons,attachments:files.map((file,index)=>({index,attachment_id:file.id,kind:file.kind,filename:file.filename,bytes:file.size})),limits:{plain:caps.plainMax,rich_markdown:caps.richMax,max_items:caps.maxItems}};
}
