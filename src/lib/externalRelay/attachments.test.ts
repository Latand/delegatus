import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { Database } from "bun:sqlite";
import { stageGeneratedAttachments, stageOwnerAttachments, uploadAnswerAttachments, contentDisposition } from "./attachments";
import { answerCapabilities, type AnswerDrop } from "./answerV2";
import { richRequest } from "./rich.fixture";
import { startTestRelay } from "./testRelay";
const root = fs.mkdtempSync(path.join("/tmp", "relay-attachments-"));
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
    return { status: 200, body: { attachment_id: file.id, sha256: file.sha256, byte_size: bytes.length, mime_type: file.mime, filename: file.filename, expires_at: "2027-01-01T00:00:00Z" } };
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
test("owner staging reuses root, type and secret checks and UTF-8 filenames", async () => {
  const env={ home: root, stateDir:path.join(root,"state") };
  await expect(stageOwnerAttachments([{path:path.join(root,"missing.mp3"),kind:"audio"}],root,caps,[],env)).rejects.toThrow();
  expect(contentDisposition("Звіт.png")).toContain("filename*=UTF-8''%D0");
});

test("owner files cover every negotiated kind, secret scans and atomic replacement cleanup", async () => {
  const handoff=path.join(root,"handoff"); fs.mkdirSync(handoff,{recursive:true});
  const env={home:root,stateDir:path.join(root,"state")};
  const png=await sharp({create:{width:2,height:2,channels:3,background:"red"}}).png().toBuffer();
  const samples=[ ["photo","photo.png",png], ["document","report.md",Buffer.from("# Report")], ["audio","track.mp3",Buffer.from("ID3fixture audio")], ["audio","track.m4a",Buffer.from([0,0,0,16,102,116,121,112,77,52,65,32])], ["video","clip.mp4",Buffer.from([0,0,0,16,102,116,121,112,105,115,111,109])] ] as const;
  for(const [kind,name,bytes] of samples){
    const file=path.join(handoff,name);fs.writeFileSync(file,bytes);
    const files=await stageOwnerAttachments([{path:file,kind}],root,caps,[],env);
    expect(files).toHaveLength(1); expect(files[0]?.kind).toBe(kind);
    expect(fs.readFileSync(files[0]!.file)).toEqual(bytes);
  }
  for(const [name,bytes,reason] of [["fake.png",Buffer.from("<html>"),"document_type"],["secret.txt",Buffer.from(["pass","word"].join("")+": "+["fixture","private","value"].join("-")),"document_secret"],["html.txt",Buffer.from("<!DOCTYPE html><html>"),"document_type"]] as const){
    const file=path.join(handoff,name);fs.writeFileSync(file,bytes);
    await expect(stageOwnerAttachments([{path:file,kind:"document"}],root,caps,[],env)).rejects.toMatchObject({code:reason});
  }
  const hidden=path.join(handoff,".private");fs.mkdirSync(hidden);fs.writeFileSync(path.join(hidden,"report.md"),"report");
  await expect(stageOwnerAttachments([{path:path.join(hidden,"report.md"),kind:"document"}],root,caps,[],env)).rejects.toMatchObject({code:"document_forbidden_path"});
  await expect(stageOwnerAttachments([{path:path.join(handoff,"photo.png"),kind:"photo",caption:"😀".repeat(513)}],root,caps,[],env)).rejects.toMatchObject({code:"caption_too_long"});
});

test("aggregate bytes are capped at 64 MiB and an oversized generated photo keeps its original as a document", async()=>{
  const {dir,refs}=await generated();
  // PNG permits trailing data; a fully decoded 2x2 image remains below the
  // pixel budget while its original bytes exceed the photo transport cap.
  const png=fs.readFileSync(refs[0]!.path);
  fs.writeFileSync(refs[0]!.path,Buffer.concat([png,Buffer.alloc(8*1024*1024+1-png.length)]));
  const drops:AnswerDrop[]=[];
  const files=await stageGeneratedAttachments(refs,dir,new Set(["exec-1.png"]),root,caps,drops);
  expect(files[0]?.kind).toBe("document");expect(drops).toContainEqual({part:"attachment",index:0,reason:"photo_as_document"});
  // Four valid 17 MiB MP4 originals cross the request budget on the last
  // file. A refused batch leaves none of its private staged copies behind.
  const handoff=path.join(root,"budget-root");fs.mkdirSync(handoff);
  const bytes=Buffer.alloc(17*1024*1024);bytes.write("ftyp",4);
  const refs4=Array.from({length:4},(_,i)=>{const file=path.join(handoff,`clip-${i}.mp4`);fs.writeFileSync(file,bytes);return {path:file,kind:"video" as const};});
  const before=new Set(fs.readdirSync(path.join(root,"attachments")));
  await expect(stageOwnerAttachments(refs4,root,caps,[],{home:root,stateDir:path.join(root,"state")},[handoff])).rejects.toMatchObject({code:"too_large"});
  expect(new Set(fs.readdirSync(path.join(root,"attachments")))).toEqual(before);
});

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
