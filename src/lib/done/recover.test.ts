import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { recoverDoneFrame, recoveryImageURL, type RecoveryPorts } from "./recover";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==","base64");
const input={repository:"acme/widgets",number:42,repoDir:"",branch:"pipeline/finished",name:"result.png"};

test("a missing scratch frame is backfilled from a PR attachment; hostile URLs never reach a downloader",async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"done-attachment-"));
  try {
    const asked:string[]=[];
    const valid="https://raw.githubusercontent.com/acme/widgets/abcdef123/evidence/result.png";
    const ports:RecoveryPorts={command:async()=>Buffer.from(`![bad](http://127.0.0.1/private.png) ![bad](https://example.invalid/x.png) ![saved](${valid})`),download:async url=>{asked.push(url);return {mime:"image/png",data:PNG};}};
    const media=await recoverDoneFrame(input,root,ports); expect(media?.bytes).toBe(PNG.length); expect(asked).toEqual([valid]);
    const credentialed=new URL(valid);credentialed.username="fixture";
    for(const url of ["https://raw.githubusercontent.com/other/repo/main/x.png","https://example.invalid/x.png","http://raw.githubusercontent.com/acme/widgets/main/x.png",credentialed.href,"https://raw.githubusercontent.com:444/acme/widgets/main/x.png","file:///etc/private.png"]) expect(recoveryImageURL(url,input.repository)).toBeNull();
    ports.download=async()=>({mime:"image/png",data:Buffer.from("not raster bytes")});
    expect(await recoverDoneFrame(input,root,ports)).toBeNull();
  } finally {await fs.rm(root,{recursive:true,force:true});}
});

test("a frame in the retained remote branch is recovered through read-only git, with a missing-frame answer when no copy exists",async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"done-git-recovery-"));
  try {
    const repo=path.join(root,"repo"),staging=path.join(root,"copies"); await fs.mkdir(repo);await fs.mkdir(staging);
    const git=(...args:string[])=>execFileSync("git",args,{cwd:repo,env:{...process.env,GIT_CONFIG_NOSYSTEM:"1"},encoding:"buffer"});
    git("init","-q");git("config","core.hooksPath",path.join(root,"no-hooks"));
    await fs.mkdir(path.join(repo,"evidence"));await fs.writeFile(path.join(repo,"evidence","result.png"),PNG);
    git("add","evidence/result.png");git("-c","user.name=Fixture","-c","user.email=fixture.invalid","commit","-qm","Keep frame");
    git("update-ref","refs/remotes/origin/pipeline/finished","HEAD");await fs.rm(path.join(repo,"evidence"),{recursive:true});
    const ports:RecoveryPorts={command:async(program,args)=>program==="gh"?Buffer.from(""):git(...args),download:async()=>null};
    const media=await recoverDoneFrame({...input,repoDir:repo},staging,ports);expect(media?.bytes).toBe(PNG.length);
    expect(await recoverDoneFrame({...input,name:"absent.png",repoDir:repo},staging,ports)).toBeNull();
    const status=git("status","--short").toString();expect(status).toContain("D evidence/result.png");
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
