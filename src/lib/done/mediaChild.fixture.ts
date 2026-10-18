import { preserveDoneFrame, doneMediaGET } from "./media";
import { copyDoneFrameSource, doneFrameSource, prepareDoneFrameSource } from "./source";
import { NextRequest } from "next/server";
import { fileAlbumSeenStore } from "@/lib/taskAlbum/seen";
import type { BoardTask } from "@/lib/tasks/types";
import type { TaskAlbumDeps } from "@/lib/taskAlbum/album";

const [action, source, start, count, owner] = process.argv.slice(2);
if (action === "restore") {
  const task = { id:"task-legacy",assignments:[{path:start}] } as BoardTask;
  const deps: TaskAlbumDeps = { world:{ task:()=>task,pipelines:()=>[],flow:()=>null,conversationPaths:()=>[],transcriptAllowed:()=>true },seen:fileAlbumSeenStore(`${process.env.LLV_STATE_DIR}/seen.json`) };
  if (!await prepareDoneFrameSource(source!,deps)) throw new Error("fixture did not finish indexing");
  const frame = await preserveDoneFrame(owner ?? "task:legacy",{src:source!,caption:"Original result"},doneFrameSource(()=>deps),1);
  console.log(JSON.stringify(frame));
} else if (action === "capture") {
  for (let i = Number(start); i < Number(start) + Number(count); i++) {
    const frame = await preserveDoneFrame(`task:frame-${i}`, { src: `/api/artifact?${new URLSearchParams({ path: source! })}`, caption: "Saved result" }, copyDoneFrameSource, i);
    if (frame.unavailable) throw new Error("capture failed");
  }
} else {
  const req = new NextRequest(`http://localhost${source}`, { headers: { host: "localhost" } });
  const response = await doneMediaGET(req,req.nextUrl.searchParams.get("done")!,req.nextUrl.searchParams.get("media")!);
  const bytes = await response.arrayBuffer();
  console.log(JSON.stringify({ status: response.status, bytes: bytes.byteLength }));
}
