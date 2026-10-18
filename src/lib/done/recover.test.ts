import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { recoverDoneFrame, recoveryImageURL, type RecoveryPorts } from "./recover";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==","base64");
const input={repository:"acme/widgets",number:42,repoDir:"",branch:"pipeline/finished",name:"result.png"};
const attachmentInput={...input,name:"after.png"};

test("a missing scratch frame is backfilled from a PR attachment; hostile URLs never reach a downloader",async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"done-attachment-"));
  try {
    const asked:string[]=[];
    const before="https://user-images.githubusercontent.com/12345/before.png";
    const after="https://user-images.githubusercontent.com/12345/after.png";
    const leading="https://user-images.githubusercontent.com/12345/leading.png";
    expect(recoveryImageURL(after,input.repository)).toBe(after);
    const body=`![unrelated](https://example.invalid/first.png) ![Before before.png](${before}) ![After after.png](${after}) ![lead.png](${leading})`;
    const ports:RecoveryPorts={command:async()=>Buffer.from(JSON.stringify({body,headRefOid:""})),download:async url=>{asked.push(url);return {mime:"image/png",data:PNG};}};
    const media=await recoverDoneFrame(attachmentInput,root,ports); expect(asked).toEqual([after]); expect(media?.bytes).toBe(PNG.length);
    asked.length=0;
    const ambiguous:RecoveryPorts={command:async()=>Buffer.from(JSON.stringify({body:`![After after.png](${after}) ![after.png](${leading})`,headRefOid:""})),download:async url=>{asked.push(url);return {mime:"image/png",data:PNG};}};
    expect(await recoverDoneFrame(attachmentInput,root,ambiguous)).toBeNull(); expect(asked).toEqual([]);
    const credentialed=new URL("https://raw.githubusercontent.com/acme/widgets/abcdef123/evidence/result.png");credentialed.username="fixture";
    for(const url of ["https://raw.githubusercontent.com/other/repo/main/x.png","https://example.invalid/x.png","http://raw.githubusercontent.com/acme/widgets/main/x.png",credentialed.href,"https://raw.githubusercontent.com:444/acme/widgets/main/x.png","file:///etc/private.png"]) expect(recoveryImageURL(url,input.repository)).toBeNull();
    const malformed:RecoveryPorts={...ports,command:async()=>Buffer.from(JSON.stringify({body:`![after.png](${after})`,headRefOid:""})),download:async()=>({mime:"image/png",data:Buffer.from("not raster bytes")})};
    expect(await recoverDoneFrame(attachmentInput,root,malformed)).toBeNull();
  } finally {await fs.rm(root,{recursive:true,force:true});}
});

test("a named frame on an unfetched remote branch is recovered through the read-only forge API without changing local refs",async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"done-git-recovery-"));
  try {
    const remote=path.join(root,"remote"),repo=path.join(root,"repo"),staging=path.join(root,"copies");
    await fs.mkdir(remote);await fs.mkdir(repo);await fs.mkdir(staging);
    const gitAt=(cwd:string,...args:string[])=>execFileSync("git",args,{cwd,env:{...process.env,GIT_CONFIG_NOSYSTEM:"1"},encoding:"buffer"});
    gitAt(remote,"init","-q");await fs.mkdir(path.join(remote,"evidence"));await fs.writeFile(path.join(remote,"evidence","result.png"),PNG);
    gitAt(remote,"add","evidence/result.png");gitAt(remote,"-c","user.name=Fixture","-c","user.email=fixture.invalid","commit","-qm","Keep frame");
    const head=gitAt(remote,"rev-parse","HEAD").toString().trim();
    const blob=gitAt(remote,"rev-parse","HEAD:evidence/result.png").toString().trim();
    gitAt(repo,"init","-q");
    let treeReads=0,blobReads=0;
    const ports:RecoveryPorts={command:async(program,args)=>{
      if(program==="git") return Buffer.from("");
      if(args[0]==="pr") return Buffer.from(JSON.stringify({body:"",headRefOid:head}));
      if(args[1]===`repos/${input.repository}/git/trees/${head}?recursive=1`) {treeReads++;return Buffer.from(JSON.stringify({truncated:false,tree:[{path:"evidence/result.png",type:"blob",sha:blob}]}));}
      if(args[1]===`repos/${input.repository}/git/blobs/${blob}`) {blobReads++;return Buffer.from(JSON.stringify({encoding:"base64",content:PNG.toString("base64"),size:PNG.length}));}
      throw new Error("unexpected forge request");
    },download:async()=>null};
    const media=await recoverDoneFrame({...input,repoDir:repo},staging,ports);expect(media?.bytes).toBe(PNG.length);
    expect(await recoverDoneFrame({...input,name:"absent.png",repoDir:repo},staging,ports)).toBeNull();
    expect(treeReads).toBe(2);expect(blobReads).toBe(1);
    expect(gitAt(repo,"for-each-ref","--format=%(refname)").toString()).toBe("");
    expect(gitAt(repo,"status","--short").toString()).toBe("");
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
