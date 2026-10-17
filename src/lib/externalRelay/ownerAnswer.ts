import { relayAnswerSchema } from "./protocol";
export { relayAnswerSchema } from "./protocol";
import { ExternalRelayError } from "./client";
import { liveOwnerRelayRequest } from "./ownerAuthority";
import { answerCapabilities, checkedButtons, type AnswerDrop } from "./answerV2";
import { stageOwnerAttachments, removeStaged, type StagedAttachment } from "./attachments";
import type { ExternalRelayRequest, RelayUrlButton } from "./protocol";
import { scrubOwnerOutput } from "./ownerOutput";
export type OwnerAnswerParts = { format:"plain"|"rich_markdown"; buttons:RelayUrlButton[][]; attachments:StagedAttachment[] };
type Entry = {relayId:string;request:ExternalRelayRequest;runDir:string;credentials:readonly string[];authorize:()=>boolean;open:boolean;sequence:number;parts:OwnerAnswerParts;drops:AnswerDrop[]};
const shared=globalThis as typeof globalThis & {__llvRelayOwnerAnswers?:Map<string,Entry>};
const entries=shared.__llvRelayOwnerAnswers??=new Map<string,Entry>();
export function ownerAnswerDrops(requestId:string) { return entries.get(requestId)?.drops ?? []; }
export function sealOwnerAnswer(requestId:string) {
  const entry=entries.get(requestId);
  if (entry) entry.open=false;
  return entry?.parts;
}
export function openOwnerAnswer(relayId:string,request:ExternalRelayRequest,runDir:string,credentials:readonly string[],authorize:()=>boolean) {
  if (!answerCapabilities(request, "").rich || entries.has(request.request_id)) throw new ExternalRelayError("relay_answer_unavailable");
  const entry:Entry={relayId,request,runDir,credentials,authorize,open:true,sequence:0,parts:{format:"plain",buttons:[],attachments:[]},drops:[]};
  entries.set(request.request_id,entry);
  return {parts:()=>entry.parts, drops:entry.drops,
    close:()=>{entry.open=false;},
    dispose:()=>{entry.open=false; if(entries.get(request.request_id)===entry) entries.delete(request.request_id); removeStaged(entry.parts.attachments);},
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
  if(!parsed.success) throw new ExternalRelayError("invalid_answer_parts");
  const value=parsed.data, caps=answerCapabilities(entry.request,"");
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
  const files=await stageOwnerAttachments(refs,entry.runDir,caps,drops);
  if(!available() || sequence!==entry.sequence) {removeStaged(files);return null;}
  const old=entry.parts.attachments;
  entry.parts={format:value.format??"plain",buttons,attachments:files}; entry.drops.push(...drops);
  removeStaged(old);
  return {format:entry.parts.format,buttons,attachments:files.map((file,index)=>({index,kind:file.kind,filename:file.filename,bytes:file.size})),limits:{plain:caps.plainMax,rich_markdown:caps.richMax,max_items:caps.maxItems}};
}
