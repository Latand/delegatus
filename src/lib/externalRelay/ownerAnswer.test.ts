import { expect, test, afterAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { openOwnerAnswer, relayAnswerOp, relayAnswerSchema } from "./ownerAnswer";
import { richRequest } from "./rich.fixture";
import { reserveRun, updateRelayStore } from "./store";
import { procBackend } from "@/lib/proc";
const root=fs.mkdtempSync(path.join("/tmp","relay-owner-answer-"));
process.env.LLV_STATE_DIR=path.join(root,"state");
afterAll(()=>fs.rmSync(root,{recursive:true,force:true}));
test("relay_answer binds a live owner conversation, replaces parts and closes after the answer", async()=>{
  const request=richRequest(true); request.request_id="rq_owner_parts";
  const relay={id:"relay_1", paused:false, targets:[{id:request.target_id,enabled:true,ownerTier:true}]};
  updateRelayStore(s=>({...s,relays:[relay as never]}));
  reserveRun({requestId:request.request_id,leaseId:request.lease_id,relayId:relay.id,targetId:request.target_id,childPid:null,childIdentity:null,ownerPid:process.pid,ownerIdentity:procBackend.processIdentity(process.pid)!,runDir:root,startedAt:new Date().toISOString(),conversationId:"conversation_owner_parts",ownerTurn:{clientAttemptId:"relay-owner-rq_owner_parts",request:{text:"Hello",requestText:null}}},1);
  const savedHome=process.env.HOME; process.env.HOME=root;
  const handoff=path.join(root,"handoff");fs.mkdirSync(handoff);
  const file=path.join(handoff,"report.md");fs.writeFileSync(file,"# Report");
  const entry=openOwnerAnswer(relay.id,request,root,["private-credential"],()=>true);
  try {
    expect(await relayAnswerOp("conversation_other",{format:"rich_markdown"})).toBeNull();
    expect(await relayAnswerOp("conversation_owner_parts",{format:"rich_markdown",buttons:[[{text:"Open",url:"https://example.com/"}]]})).toMatchObject({format:"rich_markdown",buttons:[[{text:"Open"}]]});
    expect(entry.parts().format).toBe("rich_markdown");
    await relayAnswerOp("conversation_owner_parts",{format:"plain"});
    expect(entry.parts().buttons).toEqual([]);
    await expect(relayAnswerOp("conversation_owner_parts",{buttons:[[{text:"No",url:"https://localhost"}]]})).rejects.toMatchObject({code:"button_invalid"});
    expect(relayAnswerSchema.safeParse({attachments:Array(5).fill({path:"/file",kind:"document"})}).success).toBe(false);
    await relayAnswerOp("conversation_owner_parts",{attachments:[{path:file,kind:"document"}]});
    const first=entry.parts().attachments[0]!;
    await relayAnswerOp("conversation_owner_parts",{attachments:[{path:file,kind:"document"}]});
    expect(fs.existsSync(first.file)).toBe(false);
    expect(entry.parts().attachments[0]?.id).toBe(first.id);
    const childTemp=path.join(root,"child-tmp");fs.mkdirSync(childTemp);
    const restarted=Bun.spawn([process.execPath,"-e",'import {relayAnswerOp} from "./src/lib/externalRelay/ownerAnswer.ts"; console.log(JSON.stringify(await relayAnswerOp("conversation_owner_parts",{format:"plain"})));'],{
      env:{...process.env,HOME:root,XDG_CONFIG_HOME:path.join(root,"config"),TMPDIR:childTemp,LLV_STATE_DIR:path.join(root,"state"),LLV_VIEWER_CONTROL_URL:"http://127.0.0.1:1"},stdout:"pipe",stderr:"pipe"});
    const fresh=await new Response(restarted.stdout).text();
    expect(await restarted.exited).toBe(0);expect(fresh.trim()).toBe("null");
    const before=new Set(fs.readdirSync(path.join(root,"attachments")));
    const late=relayAnswerOp("conversation_owner_parts",{attachments:[{path:file,kind:"document"}]});
    entry.close();
    expect(await late).toBeNull();
    expect(new Set(fs.readdirSync(path.join(root,"attachments")))).toEqual(before);
    expect(await relayAnswerOp("conversation_owner_parts",{format:"rich_markdown"})).toBeNull();
  } finally {const files=entry.parts().attachments;entry.dispose();for(const file of files)expect(fs.existsSync(file.file)).toBe(false);if(savedHome===undefined)delete process.env.HOME;else process.env.HOME=savedHome;}
});
