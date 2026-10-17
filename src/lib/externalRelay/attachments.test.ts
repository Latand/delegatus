import { afterAll, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { Database } from "bun:sqlite";
import { stageGeneratedAttachments, stageOwnerAttachments, uploadAnswerAttachments, contentDisposition, validateAttachmentContent } from "./attachments";
import { answerCapabilities, type AnswerDrop } from "./answerV2";
import { richRequest } from "./rich.fixture";
import { startTestRelay } from "./testRelay";
const root = fs.mkdtempSync(path.join("/tmp", "relay-attachments-"));
const MiB=1024*1024;
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const caps = answerCapabilities(richRequest(true), "codex");
async function generated() {
  const dir = fs.mkdtempSync(path.join(root, "generated-"));
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
  fs.writeFileSync(path.join(dir, "exec-1.png"), bytes);
  return { dir, bytes, refs: [{ path: path.join(dir, "exec-1.png"), kind: "photo" as const, caption: "Picture" }] };
}
test("generated files are pinned by listing and descriptor, then retried with the same bytes and id", async () => {
  const { dir, bytes, refs } = await generated(); const drops: AnswerDrop[] = [];
  const staged = await stageGeneratedAttachments(refs, dir, new Set(["exec-1.png"]), root, caps, drops);
  expect(staged).toHaveLength(1);
  fs.writeFileSync(refs[0]!.path, "changed after staging");
  const seen: { url: string; bytes: unknown; digest: unknown; lease: unknown; name: unknown }[] = [];
  const server = await startTestRelay((req, body) => {
    seen.push({url:req.url!,bytes:body,digest:req.headers["delegatus-relay-sha256"],lease:req.headers["delegatus-relay-lease"],name:req.headers["content-disposition"]});
    if (seen.length === 1) return { drop: true };
    const file = staged[0]!;
    return { status: 200, body: { attachment_id: file.id, sha256: file.sha256, byte_size: bytes.length, mime_type: file.mime, filename: file.filename, expires_at: new Date(Date.now()+60_000).toISOString() } };
  });
  try {
    const result = await uploadAnswerAttachments({ api_base: `${server.origin}/v1`, credential: "x".repeat(43) }, richRequest(true), staged, Date.now()+10000, new AbortController().signal, drops, { sleep: async () => {} });
    expect(result).toEqual([{ attachment_id: staged[0]!.id, kind: "photo", caption: "Picture" }]);
    expect(seen).toHaveLength(2); expect(seen[0]).toEqual(seen[1]); expect(seen[0]!.bytes).toEqual(bytes);
    expect(seen[0]!.lease).toBe(richRequest(true).lease_id);
    expect(seen[0]!.name).toContain("filename*=UTF-8");
    expect(drops).toEqual([]);
  } finally { await server.close(); }
});
test("a 64 MiB owner attachment batch reads, scans, hashes and stages outside the Viewer thread", async()=>{
  const dir=fs.mkdtempSync(path.join(root,"owner-batch-"));
  const bytes=Buffer.alloc(16*MiB,0x61);
  const batch=Array.from({length:4},(_,index)=>{
    const name=`attachment-${index}.txt`,file=path.join(dir,name);fs.writeFileSync(file,bytes);
    return {path:file,kind:"document" as const};
  });
  const drops:AnswerDrop[]=[];
  let ticks=0;
  const heartbeat=setInterval(()=>ticks++,10);
  let staged:Awaited<ReturnType<typeof stageOwnerAttachments>>;
  try { staged=await stageOwnerAttachments(batch,root,caps,drops,undefined,[dir]); }
  finally { clearInterval(heartbeat); }
  expect(staged).toHaveLength(4);expect(staged.reduce((total,file)=>total+file.size,0)).toBe(64*MiB);expect(drops).toEqual([]);
  expect(ticks).toBeGreaterThan(0);
},30_000);
test("content validation decodes text, checks declared structures and rejects truncated media",async()=>{
  const image=(await generated()).bytes;
  const mp3=Buffer.alloc(417);mp3.set([0xff,0xfb,0x90,0x64]);
  const iso=Buffer.from([0,0,0,16,102,116,121,112,77,52,65,32,0,0,0,0,0,0,0,12,109,100,97,116,1,2,3,4]);
  const pdf=Buffer.from("%PDF-1.4\nxref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 1 >>\nstartxref\n9\n%%EOF\n");
  expect(await validateAttachmentContent(image,".png","photo")).toBe("image/png");
  expect(await validateAttachmentContent(mp3,".mp3","audio")).toBe("audio/mpeg");
  expect(await validateAttachmentContent(iso,".m4a","audio")).toBe("audio/mp4");
  expect(await validateAttachmentContent(iso,".mp4","video")).toBe("video/mp4");
  expect(await validateAttachmentContent(pdf,".pdf","document")).toBe("application/pdf");
  expect(await validateAttachmentContent(Buffer.from("report"),".txt","document")).toBe("text/plain");
  const utf16=Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from("<html><body>x</body></html>","utf16le")]);
  const prohibited=[
    [Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'),".txt"],
    [utf16,".txt"],
    [Buffer.from("<script>alert(1)</script>"),".txt"],
    [Buffer.from("plain text, not JSON"),".json"],
    [Buffer.from("%PDF-1.4 truncated"),".pdf"],
    [Buffer.from("ID3fixture audio"),".mp3"],
    [Buffer.from([0,0,0,16,102,116,121,112,105,115,111,109]),".mp4"],
  ] as const;
  for(const [bytes,extension] of prohibited) await expect(validateAttachmentContent(bytes,extension,extension===".mp3"?"audio":extension===".mp4"?"video":"document")).rejects.toMatchObject({code:"document_type"});
  await expect(validateAttachmentContent(Buffer.from('{"ok":true}'),".json","document")).resolves.toBe("application/json");
});
test("generated staging refuses outside files, symlinks, hardlinks and old files", async () => {
  const { dir, refs } = await generated();
  const outside = path.join(root,"outside.png"); fs.copyFileSync(refs[0]!.path,outside);
  fs.symlinkSync(outside,path.join(dir,"link.png")); fs.linkSync(outside,path.join(dir,"hard.png"));
  for (const file of [outside,path.join(dir,"link.png"),path.join(dir,"hard.png"),refs[0]!.path]) {
    const drops: AnswerDrop[]=[];
    const staged=await stageGeneratedAttachments([{...refs[0]!,path:file}],dir,new Set(["link.png","hard.png"]),root,caps,drops);
    expect(staged).toEqual([]); expect(drops).toHaveLength(1);
  }
});
test("upload lease loss stops delivery, refusal drops a file, and receipts must match", async () => {
  const { dir, refs } = await generated();
  const staged=await stageGeneratedAttachments(refs,dir,new Set(["exec-1.png"]),root,caps,[]);
  for (const [status,code] of [[409,"lease_lost"],[415,"unsupported_media_type"],[200,"bad_receipt"]] as const) {
    const server=await startTestRelay(()=>({status,body: status===200?{}:{error:{code}}}));
    try {
      const drops: AnswerDrop[]=[];
      const call=()=>uploadAnswerAttachments({api_base:`${server.origin}/v1`,credential:"x".repeat(43)},richRequest(true),staged,Date.now()+5000,new AbortController().signal,drops);
      if(status===409) await expect(call()).rejects.toMatchObject({code:"lease_lost"});
      else {expect(await call()).toEqual([]);expect(drops[0]?.reason).toBe(code);}
    } finally { await server.close(); }
  }
});
test("expired upload receipts are refused at a controlled clock", async()=>{
  const {dir,refs}=await generated();
  const staged=await stageGeneratedAttachments(refs,dir,new Set(["exec-1.png"]),root,caps,[]);
  const now=Date.UTC(2035,0,2);const clock=spyOn(Date,"now").mockReturnValue(now);
  const server=await startTestRelay(()=>({status:201,body:{attachment_id:staged[0]!.id,sha256:staged[0]!.sha256,byte_size:staged[0]!.size,mime_type:staged[0]!.mime,filename:staged[0]!.filename,expires_at:new Date(now-1).toISOString()}}));
  try {
    const drops:AnswerDrop[]=[];
    expect(await uploadAnswerAttachments({api_base:`${server.origin}/v1`,credential:"x".repeat(43)},richRequest(true),staged,now+5000,new AbortController().signal,drops)).toEqual([]);
    expect(drops[0]?.reason).toBe("bad_receipt");
  } finally {clock.mockRestore();await server.close();}
});
test("owner staging reuses root, type and secret checks and UTF-8 filenames", async () => {
  const env={ home: root, stateDir:path.join(root,"state") };
  await expect(stageOwnerAttachments([{path:path.join(root,"missing.mp3"),kind:"audio"}],root,caps,[],env)).rejects.toThrow();
  expect(contentDisposition("Звіт.png")).toContain("filename*=UTF-8''%D0");
});

test("owner files cover every negotiated kind, secret scans and atomic replacement cleanup", async () => {
  const handoff=path.join(root,"handoff"); fs.mkdirSync(handoff,{recursive:true});
  const env={home:root,stateDir:path.join(root,"state")};
  const png=await sharp({create:{width:2,height:2,channels:3,background:"red"}}).png().toBuffer();
  const mp3=Buffer.alloc(417);mp3.set([0xff,0xfb,0x90,0x64]);
  const iso=Buffer.from([0,0,0,16,102,116,121,112,77,52,65,32,0,0,0,0,0,0,0,12,109,100,97,116,1,2,3,4]);
  const samples=[ ["photo","photo.png",png], ["document","report.md",Buffer.from("# Report")], ["audio","track.mp3",mp3], ["audio","track.m4a",iso], ["video","clip.mp4",iso] ] as const;
  for(const [kind,name,bytes] of samples){
    const file=path.join(handoff,name);fs.writeFileSync(file,bytes);
    const files=await stageOwnerAttachments([{path:file,kind}],root,caps,[],env);
    expect(files).toHaveLength(1); expect(files[0]?.kind).toBe(kind);
    expect(fs.readFileSync(files[0]!.file)).toEqual(bytes);
  }
  const pdf=Buffer.from("%PDF-1.4\nxref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 1 >>\nstartxref\n9\n%%EOF\n");
  fs.writeFileSync(path.join(handoff,"report.pdf"),pdf);
  expect(await stageOwnerAttachments([{path:path.join(handoff,"report.pdf"),kind:"document"}],root,caps,[],env)).toHaveLength(1);
  fs.writeFileSync(path.join(handoff,"broken.pdf"),Buffer.from("%PDF-1.4 truncated"));
  await expect(stageOwnerAttachments([{path:path.join(handoff,"broken.pdf"),kind:"document"}],root,caps,[],env)).rejects.toMatchObject({code:"document_type"});
  for(const [name,bytes,reason] of [["fake.png",Buffer.from("<html>"),"document_type"],["secret.txt",Buffer.from(["pass","word"].join("")+": "+["fixture","private","value"].join("-")),"document_secret"],["html.txt",Buffer.from("<!DOCTYPE html><html>"),"document_type"]] as const){
    const file=path.join(handoff,name);fs.writeFileSync(file,bytes);
    await expect(stageOwnerAttachments([{path:file,kind:"document"}],root,caps,[],env)).rejects.toMatchObject({code:reason});
  }
  const utf16=Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from("<html><body>x</body></html>","utf16le")]);
  const xml=Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>');
  const malformedJson=Buffer.from("plain text, not JSON");
  for(const [name,bytes] of [["markup.txt",utf16],["vector.txt",xml],["bad.json",malformedJson]] as const){
    const file=path.join(handoff,name);fs.writeFileSync(file,bytes);
    await expect(stageOwnerAttachments([{path:file,kind:"document"}],root,caps,[],env)).rejects.toMatchObject({code:"document_type"});
  }
  for(const [name,bytes] of [["short.mp3",Buffer.from("ID3fixture audio")],["short.mp4",Buffer.from([0,0,0,16,102,116,121,112,105,115,111,109])]] as const){
    const file=path.join(handoff,name);fs.writeFileSync(file,bytes);
    await expect(stageOwnerAttachments([{path:file,kind:name.endsWith("mp3")?"audio":"video"}],root,caps,[],env)).rejects.toMatchObject({code:"document_type"});
  }
  const hidden=path.join(handoff,".private");fs.mkdirSync(hidden);fs.writeFileSync(path.join(hidden,"report.md"),"report");
  await expect(stageOwnerAttachments([{path:path.join(hidden,"report.md"),kind:"document"}],root,caps,[],env)).rejects.toMatchObject({code:"document_forbidden_path"});
  await expect(stageOwnerAttachments([{path:path.join(handoff,"photo.png"),kind:"photo",caption:"😀".repeat(513)}],root,caps,[],env)).rejects.toMatchObject({code:"caption_too_long"});
});

test("aggregate bytes above 64 MiB are refused and staged copies are removed", async()=>{
  // Just over the negotiated aggregate cap, with every item under its own cap.
  const handoff=path.join(root,"budget-root");fs.mkdirSync(handoff);
  const bytes=Buffer.alloc(16*MiB+1,0x61);
  const refs4=Array.from({length:4},(_,i)=>{const file=path.join(handoff,`report-${i}.txt`);fs.writeFileSync(file,bytes);return {path:file,kind:"document" as const};});
  const before=new Set(fs.readdirSync(root).filter(name=>name.startsWith("relay-job-")));
  await expect(stageOwnerAttachments(refs4,root,caps,[],{home:root,stateDir:path.join(root,"state")},[handoff])).rejects.toMatchObject({code:"too_large"});
  expect(new Set(fs.readdirSync(root).filter(name=>name.startsWith("relay-job-")))).toEqual(before);
},30_000);

test("owner staging reads configured document roots and keeps malformed settings failures private", async () => {
  const state = path.join(root, "configured-state");
  fs.mkdirSync(path.join(state, "telegram"), { recursive: true });
  const directory = path.join(root, "configured-root"); fs.mkdirSync(directory);
  const file = path.join(directory, "report.md"); fs.writeFileSync(file, "Report");
  const db = new Database(path.join(state, "telegram", "bot.sqlite"));
  db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)");
  db.query("INSERT INTO settings VALUES (?, ?)").run("document_roots", JSON.stringify([directory]));
  const old = process.env.LLV_STATE_DIR; process.env.LLV_STATE_DIR = state;
  try {
    const send = () => stageOwnerAttachments([{ path: file, kind: "document" }], root, caps, [], { home: root, stateDir: state });
    expect(await send()).toHaveLength(1);
    db.query("UPDATE settings SET value = ? WHERE key = ?").run("malformed setting", "document_roots");
    await expect(send()).rejects.toMatchObject({ code: "document_invalid" });
  } finally { db.close(); if (old === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = old; }
});
