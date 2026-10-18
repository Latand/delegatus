import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET as imageGET } from "@/app/api/image/route";
import { GET as artifactGET } from "@/app/api/artifact/route";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/capabilityHeader";
import { copyMedia } from "@/lib/prototypeReview/copy";
import { DONE_MEDIA_BYTES, DONE_MEDIA_ITEMS, doneMediaRoot, preserveDoneFrame, removeDoneMedia } from "./media";
import { copyDoneFrameSource } from "./source";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
let root: string;
let previous: string | undefined;
beforeEach(async () => {
  previous = process.env.LLV_STATE_DIR;
  root = await fs.mkdtemp(path.join(os.tmpdir(), "done-media-"));
  process.env.LLV_STATE_DIR = path.join(root,"state");
});
afterEach(async () => {
  process.env.LLV_STATE_DIR = previous;
  await fs.rm(root,{ recursive:true,force:true });
});
const request = (src: string, headers: Record<string,string> = {}) => new NextRequest(`http://localhost${src}`, { headers: { host:"localhost",...headers } });
async function source(bytes = PNG) {
  // Source admission uses the isolated HOME, exactly as a lane capture does.
  const dir = await fs.mkdtemp(path.join(process.env.HOME!,"done-lane-"));
  const file = path.join(dir,"after.png"); await fs.writeFile(file,bytes);
  return { dir,file,frame: { src:`/api/artifact?${new URLSearchParams({ path:file })}`,caption:"Result" } };
}
async function child(...args: string[]) {
  const run = Bun.spawn([process.execPath,path.join(import.meta.dir,"mediaChild.fixture.ts"),...args], { env:{...process.env},stdout:"pipe",stderr:"pipe" });
  const [out,err,exit] = await Promise.all([new Response(run.stdout).text(),new Response(run.stderr).text(),run.exited]);
  expect(exit,err).toBe(0); return out;
}
async function manifest() { return JSON.parse(await fs.readFile(path.join(doneMediaRoot(),"index.json"),"utf8")); }

test("a closed lane's pair still serves through the image route after its worktree is swept and the process restarts",async () => {
  const lane = await source();
  try {
    const before = path.join(lane.dir,"before.png"); await fs.writeFile(before,PNG);
    const saved = await preserveDoneFrame("task:closed",{...lane.frame,before:`/api/artifact?${new URLSearchParams({path:before})}`},copyDoneFrameSource,1);
    await fs.rm(lane.dir,{recursive:true,force:true});
    for (const url of [saved.src,saved.before!]) {
      const response = await imageGET(request(url)); expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG);
      expect(JSON.parse(await child("read",url))).toEqual({status:200,bytes:PNG.length});
    }
    await removeDoneMedia(["task:another"]);
    const retained = await imageGET(request(saved.src));
    expect(retained.status).toBe(200); await retained.arrayBuffer();
    await removeDoneMedia(["task:closed"]);
    expect((await imageGET(request(saved.src))).status).toBe(404);
  } finally { await fs.rm(lane.dir,{recursive:true,force:true}); }
});

test("the count bound persists across real process restarts; eviction removes the owned bytes",async () => {
  const lane = await source();
  try {
    await child("capture",lane.file,"0",String(DONE_MEDIA_ITEMS));
    const first = (await manifest())[0];
    await child("capture",lane.file,String(DONE_MEDIA_ITEMS),"1");
    const rows = await manifest(); expect(rows).toHaveLength(DONE_MEDIA_ITEMS);
    expect(rows.some((r: {owner:string})=>r.owner===first.owner)).toBe(false);
    expect((await imageGET(request(first.frame.src))).status).toBe(404);
    await expect(fs.stat(path.join(doneMediaRoot(),first.directory))).rejects.toThrow();
    const directories = (await fs.readdir(doneMediaRoot(),{withFileTypes:true})).filter(e=>e.isDirectory() && /^[a-f0-9]{64}$/.test(e.name));
    expect(directories).toHaveLength(DONE_MEDIA_ITEMS);
  } finally { await fs.rm(lane.dir,{recursive:true,force:true}); }
},30_000);

test("the byte bound persists across restart even below the item cap",async () => {
  const bytes = Buffer.alloc(4*1024*1024); PNG.copy(bytes);
  const lane = await source(bytes);
  try {
    await child("capture",lane.file,"0","16");
    expect((await manifest()).reduce((n:number,r:{media:{bytes:number}[]})=>n+r.media[0]!.bytes,0)).toBe(DONE_MEDIA_BYTES);
    await child("capture",lane.file,"16","1");
    const rows = await manifest(); expect(rows).toHaveLength(16);
    expect(rows[0].owner).toBe("task:frame-1");
    expect(rows.reduce((n:number,r:{media:{bytes:number}[]})=>n+r.media[0]!.bytes,0)).toBe(DONE_MEDIA_BYTES);
  } finally { await fs.rm(lane.dir,{recursive:true,force:true}); }
},30_000);

test("missing, malformed, over-size and remote sources produce a missing-frame state without publishing partial files",async () => {
  const huge = Buffer.alloc(4*1024*1024+1); PNG.copy(huge);
  for (const [i,bytes] of [Buffer.from("not an image"),huge].entries()) {
    const lane = await source(bytes);
    try { expect((await preserveDoneFrame(`task:bad-${i}`,lane.frame,copyDoneFrameSource,i)).unavailable).toBe(true); }
    finally { await fs.rm(lane.dir,{recursive:true,force:true}); }
  }
  for (const src of ["/api/artifact?path=/missing/frame.png","https://example.invalid/frame.png","//example.invalid/frame.png"]) {
    expect((await preserveDoneFrame("task:missing",{src,caption:"Missing"},copyDoneFrameSource,4)).unavailable).toBe(true);
  }
  expect((await fs.readdir(doneMediaRoot())).some(name=>name.startsWith(".copy-"))).toBe(false);
});

test("the manifest and same-origin operator gate fence copies from path routes, forged ids and links",async () => {
  const lane = await source();
  try {
    const saved = await preserveDoneFrame("task:private",lane.frame,copyDoneFrameSource,1);
    expect((await imageGET(request(saved.src,{origin:"https://example.invalid"}))).status).toBe(403);
    expect((await imageGET(request(saved.src,{[VIEWER_SPAWN_CAPABILITY_HEADER]:"invalid"}))).status).toBe(403);
    expect((await imageGET(request(saved.src.replace("task%3Aprivate","task%3Aother")))).status).toBe(404);
    const entry=(await manifest())[0]; const file=path.join(doneMediaRoot(),entry.directory,`${entry.media[0].id}.png`);
    const raw=`/api/image?${new URLSearchParams({path:file})}`;
    expect((await imageGET(request(raw))).status).toBe(403);
    expect((await artifactGET(request(raw.replace("/api/image?","/api/artifact?")))) .status).toBe(403);
    const staging=await fs.mkdtemp(path.join(root,"copy-"));
    await expect(copyMedia(file,staging)).rejects.toThrow();
    await fs.unlink(file); await fs.symlink(lane.file,file);
    expect((await imageGET(request(saved.src))).status).toBe(404);
  } finally { await fs.rm(lane.dir,{recursive:true,force:true}); }
});
