import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { doneMediaGET } from "./media";
import { albumImageId } from "@/lib/taskAlbum/album";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const GIF = "R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";
test("an old album URL recovers its exact transcript bytes in a fresh process after scratch is gone",async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),"done-legacy-"));
  const prior = process.env.LLV_STATE_DIR;
  try {
    const filename = path.join(root,"swept-stage","result.png");
    const transcript = path.join(root,"critic.jsonl");
    await fs.writeFile(transcript,[
      {type:"assistant",timestamp:"2026-10-16T12:00:00Z",message:{role:"assistant",content:[{type:"tool_use",id:"read-frame",name:"Read",input:{file_path:filename}}]}},
      {type:"user",timestamp:"2026-10-16T12:00:01Z",message:{role:"user",content:[{type:"tool_result",tool_use_id:"read-frame",content:[{type:"image",source:{type:"base64",media_type:"image/png",data:PNG}}]}]}},
    ].map(row=>JSON.stringify(row)).join("\n")+"\n");
    const url = `/api/tasks/task-legacy/album/image?id=${albumImageId(`f:${filename}`)}`;
    process.env.LLV_STATE_DIR=path.join(root,"state");
    const run=Bun.spawn([process.execPath,path.join(import.meta.dir,"mediaChild.fixture.ts"),"restore",url,transcript],{env:{...process.env},stdout:"pipe",stderr:"pipe"});
    const [out,err,exit]=await Promise.all([new Response(run.stdout).text(),new Response(run.stderr).text(),run.exited]);
    expect(exit,err).toBe(0);
    const frame=JSON.parse(out); expect(frame.unavailable).toBeUndefined(); expect(frame.src).toStartWith("/api/image?done=");
    const request=new NextRequest(`http://localhost${frame.src}`,{headers:{host:"localhost"}});
    const response=await doneMediaGET(request,"task:legacy",request.nextUrl.searchParams.get("media")!);
    expect(response.status).toBe(200); expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(PNG,"base64"));
    await fs.rm(transcript);
    const held=await doneMediaGET(request,"task:legacy",request.nextUrl.searchParams.get("media")!);
    expect(held.status).toBe(200); await held.arrayBuffer();
  } finally { process.env.LLV_STATE_DIR=prior; await fs.rm(root,{recursive:true,force:true}); }
});

test("an inline album GIF is copied and served after its transcript is removed",async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),"done-legacy-gif-"));
  const prior = process.env.LLV_STATE_DIR;
  try {
    const filename = path.join(root,"swept-stage","result.gif");
    const transcript = path.join(root,"critic.jsonl");
    await fs.writeFile(transcript,[
      {type:"assistant",timestamp:"2026-10-16T12:00:00Z",message:{role:"assistant",content:[{type:"tool_use",id:"read-frame",name:"Read",input:{file_path:filename}}]}},
      {type:"user",timestamp:"2026-10-16T12:00:01Z",message:{role:"user",content:[{type:"tool_result",tool_use_id:"read-frame",content:[{type:"image",source:{type:"base64",media_type:"image/gif",data:GIF}}]}]}},
    ].map(row=>JSON.stringify(row)).join("\n")+"\n");
    const url = `/api/tasks/task-legacy-gif/album/image?id=${albumImageId(`f:${filename}`)}`;
    process.env.LLV_STATE_DIR=path.join(root,"state");
    const run=Bun.spawn([process.execPath,path.join(import.meta.dir,"mediaChild.fixture.ts"),"restore",url,transcript,"","task:legacy-gif"],{env:{...process.env},stdout:"pipe",stderr:"pipe"});
    const [out,err,exit]=await Promise.all([new Response(run.stdout).text(),new Response(run.stderr).text(),run.exited]);
    expect(exit,err).toBe(0);
    const frame=JSON.parse(out); expect(frame.unavailable).toBeUndefined();
    const request=new NextRequest(`http://localhost${frame.src}`,{headers:{host:"localhost"}});
    const response=await doneMediaGET(request,"task:legacy-gif",request.nextUrl.searchParams.get("media")!);
    expect(response.status).toBe(200); expect(response.headers.get("content-type")).toBe("image/gif");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(GIF,"base64"));
    await fs.rm(transcript);
    const held=await doneMediaGET(request,"task:legacy-gif",request.nextUrl.searchParams.get("media")!);
    expect(held.status).toBe(200); await held.arrayBuffer();
  } finally { process.env.LLV_STATE_DIR=prior; await fs.rm(root,{recursive:true,force:true}); }
});
