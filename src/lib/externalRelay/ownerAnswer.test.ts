import { expect, test, afterAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { openOwnerAnswer, relayAnswerOp, relayAnswerSchema } from "./ownerAnswer";
import { ownerAnswer } from "./ownerRun";
import { richRequest } from "./rich.fixture";
import { reserveRun, updateRelayStore } from "./store";
import { procBackend } from "@/lib/proc";
const root=fs.mkdtempSync(path.join(os.tmpdir(),"relay-owner-answer-"));
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
    const stagedFiles=()=>fs.readdirSync(root).filter(name=>name.startsWith("relay-job-")).flatMap(job=>{
      const directory=path.join(root,job,"attachments");
      return fs.existsSync(directory)?fs.readdirSync(directory).map(file=>`${job}/${file}`):[];
    });
    const before=new Set(stagedFiles());
    const late=relayAnswerOp("conversation_owner_parts",{attachments:[{path:file,kind:"document"}]});
    entry.close();
    expect(await late).toBeNull();
    expect(new Set(stagedFiles())).toEqual(before);
    expect(await relayAnswerOp("conversation_owner_parts",{format:"rich_markdown"})).toBeNull();
  } finally {const files=entry.parts().attachments;await entry.dispose();for(const file of files)expect(fs.existsSync(file.file)).toBe(false);if(savedHome===undefined)delete process.env.HOME;else process.env.HOME=savedHome;}
});

test("owner mentions keep leading source whitespace and refuse redaction that would move offsets", async () => {
  const request = richRequest(); request.request_id = "owner_mention_offsets";
  request.input.requester = { key: "person", is_owner: true, is_admin: true, is_anonymous_admin: false, can_delete_messages: true, can_restrict_members: true };
  const relay = { id: "relay_mentions", paused: false, targets: [{ id: request.target_id, enabled: true, ownerTier: true }] };
  updateRelayStore(s => ({ ...s, relays: [relay as never] }));
  reserveRun({ requestId: request.request_id, leaseId: request.lease_id, relayId: relay.id, targetId: request.target_id, childPid: null, childIdentity: null, ownerPid: process.pid, ownerIdentity: procBackend.processIdentity(process.pid)!, runDir: root, startedAt: "2026-10-17T12:00:00Z", conversationId: "conversation_owner_mentions", ownerTurn: { clientAttemptId: "relay-owner-mentions", request: { text: "Hello", requestText: null } } }, 1);
  const owner = { messageId: "m1", text: "Hello", requestText: null };
  const entry = openOwnerAnswer(relay.id, request, root, [], () => true);
  try {
    const mentions = [{ author_key: "person", offset: 4, length: 6 }];
    for (const invalid of [null, [{ ...mentions[0], offset: -1 }], [{ ...mentions[0], length: 129 }], [{ ...mentions[0], extra: true }], Array(17).fill(mentions[0])]) {
      await expect(relayAnswerOp("conversation_owner_mentions", { format: "rich_markdown", mentions: invalid })).rejects.toMatchObject({ code: "malformed", status: 400 });
    }
    await expect(relayAnswerOp("conversation_owner_mentions", { format: "plain", mentions })).rejects.toMatchObject({ code: "malformed", status: 400 });
    await relayAnswerOp("conversation_owner_mentions", { format: "rich_markdown", mentions });
    expect(ownerAnswer("  😀 Person", request, owner)).toMatchObject({ text: "  😀 Person", mentions });
    for (const text of ["[ignore]", "[handoff]"])
      expect(() => ownerAnswer(text, request, owner)).toThrow("malformed");
  } finally { await entry.dispose(); }
  const changed = openOwnerAnswer(relay.id, request, root, ["sensitive-fixture"], () => true);
  try {
    await relayAnswerOp("conversation_owner_mentions", { format: "rich_markdown", mentions: [{ author_key: "person", offset: 18, length: 6 }] });
    expect(() => ownerAnswer("sensitive-fixture Person", request, owner, ["sensitive-fixture"])).toThrow("malformed");
  } finally { await changed.dispose(); }
});
