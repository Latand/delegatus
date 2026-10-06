import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET as frameGET } from "@/app/api/artifact/frame/[...rest]/route";
import { GET as artifactGET } from "@/app/api/artifact/route";
import { GET as imageGET } from "@/app/api/image/route";
import { frameUrl, mintFrameScope } from "@/lib/artifact/frameScope";
import { stateDir } from "@/lib/configDir";
import { loadTasks, saveTasks } from "@/lib/tasks/store";
import type { PrototypeDelivery } from "./decision";
import { publishPOST, reviewGET, reviewPOST } from "./http";
import { admittedSource, PROTOTYPE_LIMITS } from "./input";
import { prototypeMediaGET } from "./media";
import { mediaFilename, roundDirectory, roundMedia } from "./store";
import type { PrototypeReviewRead, PublishPrototypeInput } from "./types";

const roots: string[] = [];
const PNG = Buffer.from([137,80,78,71,13,10,26,10]);
const WEBM = Buffer.concat([Buffer.from([0x1a,0x45,0xdf,0xa3,0x42,0x82,0x84]),Buffer.from("webm"),Buffer.alloc(64,7)]);
const TASK = "task-prototype";
function task(id = TASK,project = "project-a") { return { id, project, status: "inbox" as const, placement: "unplaced" as const, text: "Review layout", assignments: [], sources: [], createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" }; }
beforeEach(() => saveTasks([task()]));
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root,{ recursive: true, force: true }); });
function request(url: string,body?: unknown) {
  return new NextRequest(`http://localhost${url}`,{ headers: { host: "localhost", "sec-fetch-site": "same-origin" }, ...(body ? { method: "POST", body: JSON.stringify(body) } : {}) });
}
async function directory(parent: string,prefix: string) { const root = await fs.realpath(await fs.mkdtemp(path.join(parent,prefix))); roots.push(root); return root; }
const source = () => directory(process.env.HOME!,"prototype-source-");
async function input(key: string): Promise<PublishPrototypeInput> {
  const root = await source();
  await fs.writeFile(path.join(root,"new.png"),Buffer.concat([PNG,Buffer.from("inside!!")]));
  await fs.writeFile(path.join(root,"clip.webm"),WEBM);
  return { clientRequestId: key, taskId: TASK, title: "Review layout", variants: [
    { number: 1, name: "Compact", description: "Keeps the controls together.", frames: [{ path: path.join(root,"new.png"), caption: "Controls" }], videos: [{ path: path.join(root,"clip.webm"), caption: "Scroll" }] },
  ] };
}
async function publish(body: PublishPrototypeInput) { const response = await publishPOST(request("/api/prototype-reviews",body)); expect(response.status).toBe(200); return (await response.json()).reviewId as string; }
async function read() { return (await (await reviewGET(request(`/api/tasks/${TASK}/prototypes`),TASK)).json()) as PrototypeReviewRead; }

/**
 * A directory above the file is a link to `outside` from the first touch of
 * `target` until its open returns, and the real directory again afterwards:
 * the window in which a path check and an open disagree, made exact.
 */
async function swapDuringOpen(swapped: string,outside: string,target: string,run: () => Promise<void>) {
  const open = fs.open.bind(fs), stat = fs.stat.bind(fs), lstat = fs.lstat.bind(fs), readFile = fs.readFile.bind(fs);
  let state: "before" | "swapped" | "restored" = "before";
  const swapIn = async (file: unknown) => {
    if (file !== target || state !== "before") return;
    state = "swapped"; await fs.rename(swapped,`${swapped}.held`); await fs.symlink(outside,swapped);
  };
  const restore = async (file: unknown) => {
    if (file === target && state === "swapped") { state = "restored"; await fs.unlink(swapped); await fs.rename(`${swapped}.held`,swapped); }
  };
  const spies = [
    /* A read that opens the path a second time is an open like any other. */
    spyOn(fs,"readFile").mockImplementation((async (file: never,...rest: never[]) => {
      await swapIn(file);
      try { return await readFile(file,...rest); } finally { await restore(file); }
    }) as never),
    spyOn(fs,"stat").mockImplementation((async (file: never,...rest: never[]) => { await swapIn(file); return stat(file,...rest); }) as never),
    spyOn(fs,"lstat").mockImplementation((async (file: never,...rest: never[]) => { await swapIn(file); return lstat(file,...rest); }) as never),
    spyOn(fs,"open").mockImplementation((async (file: never,...rest: never[]) => {
      await swapIn(file);
      try { return await open(file,...rest); } finally { await restore(file); }
    }) as never),
  ];
  try { await run(); } finally { for (const spy of spies) spy.mockRestore(); }
  expect(state as string).toBe("restored");
}

test("a source directory swapped for a link while its picture is opened publishes nothing", async () => {
  /* A home and a place outside it, whatever the run's own temp directory is under. */
  const base = await directory(os.tmpdir(),"prototype-roots-");
  const outside = path.join(base,"outside"); await fs.mkdir(outside);
  const home = process.env.HOME, evidence = process.env.LLV_EVIDENCE_ROOTS;
  process.env.HOME = path.join(base,"home"); await fs.mkdir(process.env.HOME);
  process.env.LLV_EVIDENCE_ROOTS = path.join(base,"evidence");
  try {
    const body = await input("swap-source");
    const picture = body.variants[0]!.frames![0]!.path;
    await fs.writeFile(path.join(outside,"new.png"),Buffer.concat([PNG,Buffer.from("OUTSIDE!")]));
    await expect(admittedSource(path.join(outside,"new.png"))).rejects.toThrow("outside what Delegatus reads");
    await swapDuringOpen(path.dirname(picture),outside,picture,async () => {
      const response = await publishPOST(request("/api/prototype-reviews",body));
      expect(response.status).toBe(403);
      expect((await response.json()).error).toContain("Nothing was published.");
    });
    expect(loadTasks()[0]!.prototypeReviews).toBeUndefined();
    const copies = await fs.readdir(path.join(stateDir(),"prototype-reviews"),{ recursive: true });
    expect(copies.filter(name => /\.(png|webm)$/.test(name))).toEqual([]);
  } finally {
    process.env.HOME = home;
    if (evidence === undefined) delete process.env.LLV_EVIDENCE_ROOTS; else process.env.LLV_EVIDENCE_ROOTS = evidence;
  }
});

test("a pipe named like a picture is refused at once and holds no publication", async () => {
  const body = await input("pipe");
  const pipe = path.join(path.dirname(body.variants[0]!.frames![0]!.path),"pipe.png");
  Bun.spawnSync(["mkfifo",pipe]);
  expect((await fs.stat(pipe)).isFIFO()).toBe(true);
  body.variants[0]!.frames![0]!.path = pipe;
  const started = Date.now();
  const response = await publishPOST(request("/api/prototype-reviews",body));
  expect(response.status).toBe(403); expect(Date.now() - started).toBeLessThan(2_000);
  expect(loadTasks()[0]!.prototypeReviews).toBeUndefined();
});

test("a round directory swapped for a link while a copy is opened serves no outside bytes, picture or video", async () => {
  const id = await publish(await input("swap-store"));
  const round = loadTasks()[0]!.prototypeReviews![0]!;
  const outside = await directory(os.tmpdir(),"prototype-outside-");
  for (const media of roundMedia(round)) {
    const own = await fs.readFile(path.join(roundDirectory(id),mediaFilename(media)));
    // Same name, size and type as the store's copy; only the place differs.
    const foreign = Buffer.from(own); foreign.write("OUTSIDE",own.length - 7);
    await fs.writeFile(path.join(outside,mediaFilename(media)),foreign);
    const kind = media.mime.startsWith("image/") ? "image" as const : "video" as const;
    const target = path.join(await fs.realpath(roundDirectory(id)),mediaFilename(media));
    await swapDuringOpen(roundDirectory(id),outside,target,async () => {
      const response = await prototypeMediaGET(request("/media"),TASK,id,media.id,kind);
      const bytes = Buffer.from(await response.arrayBuffer());
      expect(bytes.includes("OUTSIDE")).toBe(false);
      expect(response.status).toBe(404);
    });
    const restored = await prototypeMediaGET(request("/media"),TASK,id,media.id,kind);
    expect(restored.status).toBe(200); expect(Buffer.from(await restored.arrayBuffer())).toEqual(own);
  }
});

test("a round directory that is a link out of the store is unavailable in the read and on the route alike", async () => {
  const id = await publish(await input("linked-round"));
  const outside = await directory(os.tmpdir(),"prototype-outside-");
  await fs.cp(roundDirectory(id),outside,{ recursive: true });
  await fs.rm(roundDirectory(id),{ recursive: true }); await fs.symlink(outside,roundDirectory(id));
  roots.push(roundDirectory(id));
  const frame = (await read()).rounds[0]!.variants[0]!.frames[0]!;
  expect(frame.image).toMatchObject({ available: false, url: null });
  expect((await prototypeMediaGET(request("/media"),TASK,id,frame.image.id,"image")).status).toBe(404);
});

test("a state directory reached through a link serves its pictures and videos, ranges included", async () => {
  const id = await publish(await input("linked-state"));
  const link = path.join(await directory(os.tmpdir(),"prototype-state-link-"),"state");
  await fs.symlink(stateDir(),link);
  const previous = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = link;
  try {
    const variant = (await read()).rounds[0]!.variants[0]!;
    const image = variant.frames[0]!.image, video = variant.videos[0]!.media;
    expect(image.available).toBe(true); expect(video.available).toBe(true);
    const picture = await imageGET(request(image.url!));
    expect(picture.status).toBe(200); expect(Buffer.from(await picture.arrayBuffer()).subarray(0,8)).toEqual(PNG);
    const ranged = request(video.url!); ranged.headers.set("range","bytes=0-3");
    const clip = await prototypeMediaGET(ranged,TASK,id,video.id,"video");
    expect(clip.status).toBe(206); expect(Buffer.from(await clip.arrayBuffer())).toEqual(WEBM.subarray(0,4));
    // A link below the root still answers nothing.
    const outside = await directory(os.tmpdir(),"prototype-outside-");
    await fs.cp(roundDirectory(id),outside,{ recursive: true });
    await fs.rm(roundDirectory(id),{ recursive: true }); await fs.symlink(outside,roundDirectory(id));
    roots.push(roundDirectory(id));
    expect((await read()).rounds[0]!.variants[0]!.frames[0]!.image.available).toBe(false);
    expect((await prototypeMediaGET(request(video.url!),TASK,id,video.id,"video")).status).toBe(404);
  } finally { if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous; }
});

test("no path route reads a stored copy, by its own path or through a link, and none is published again", async () => {
  // An installation keeps its state under the home directory, which the path routes read.
  const home = process.env.HOME;
  process.env.HOME = await fs.realpath(path.dirname(stateDir()));
  try {
    const id = await publish(await input("path-routes"));
    const media = roundMedia(loadTasks()[0]!.prototypeReviews![0]!).find(entry => entry.mime === "image/png")!;
    const stored = path.join(roundDirectory(id),mediaFilename(media));
    const link = path.join(await source(),"borrowed.png"); await fs.symlink(stored,link);
    const folder = path.join(await source(),"round"); await fs.symlink(roundDirectory(id),folder);
    const neighbour = path.join(await source(),"plain.png"); await fs.writeFile(neighbour,PNG);
    expect((await imageGET(request(`/api/image?path=${encodeURIComponent(neighbour)}`))).status).toBe(200);
    for (const candidate of [stored,link,path.join(folder,mediaFilename(media))]) {
      expect((await imageGET(request(`/api/image?path=${encodeURIComponent(candidate)}`))).status).toBe(403);
      expect((await artifactGET(request(`/api/artifact?path=${encodeURIComponent(candidate)}`))).status).toBe(403);
      const again = await publishPOST(request("/api/prototype-reviews",{ clientRequestId: `borrow-${candidate.length}`, taskId: TASK, title: "Borrowed",
        variants: [{ number: 1, name: "Borrowed", description: "Another review's copy.", frames: [{ path: candidate, caption: "Copy" }] }] }));
      expect(again.status).toBe(403);
    }
    expect(loadTasks()[0]!.prototypeReviews).toHaveLength(1);
    // The review's own URL still serves the operator.
    const own = (await read()).rounds[0]!.variants[0]!.frames[0]!.image;
    const served = await imageGET(request(own.url!));
    expect(served.status).toBe(200); await served.arrayBuffer();
  } finally { process.env.HOME = home; }
});

/** The three routes that read a file by its path. */
const pathRoutes = (file: string) => [
  () => imageGET(request(`/api/image?path=${encodeURIComponent(file)}`)),
  () => artifactGET(request(`/api/artifact?path=${encodeURIComponent(file)}`)),
  () => frameGET(request(frameUrl(mintFrameScope(path.dirname(file)),path.basename(file)))),
];
/** Each path route, asked for a picture whose directory leads to `elsewhere` for exactly as long as the open takes. */
async function swappedUnderEveryPathRoute(target: string,elsewhere: string,foreign: string) {
  const own = await fs.readFile(target);
  for (const route of pathRoutes(target)) {
    await swapDuringOpen(path.dirname(target),elsewhere,target,async () => {
      const response = await route();
      expect(Buffer.from(await response.arrayBuffer()).includes(foreign)).toBe(false);
      expect(response.status).toBe(403);
    });
    const restored = await route();
    expect(restored.status).toBe(200); expect(Buffer.from(await restored.arrayBuffer())).toEqual(own);
  }
}

test("a directory swapped for a link to a round while a path route opens its picture serves no stored copy", async () => {
  const home = process.env.HOME;
  process.env.HOME = await fs.realpath(path.dirname(stateDir()));
  try {
    const id = await publish(await input("swap-path-routes"));
    const media = roundMedia(loadTasks()[0]!.prototypeReviews![0]!).find(entry => entry.mime === "image/png")!;
    const stored = await fs.readFile(path.join(roundDirectory(id),mediaFilename(media)));
    expect(stored.includes("inside!!")).toBe(true);
    // An ordinary picture the routes serve, under the stored copy's own name.
    const allowed = path.join(await source(),mediaFilename(media));
    await fs.writeFile(allowed,Buffer.concat([PNG,Buffer.from("allowed!")]));
    await swappedUnderEveryPathRoute(allowed,await fs.realpath(roundDirectory(id)),"inside!!");
    // The review's own URL still serves the operator.
    const own = (await read()).rounds[0]!.variants[0]!.frames[0]!.image;
    const served = await imageGET(request(own.url!));
    expect(served.status).toBe(200); expect(Buffer.from(await served.arrayBuffer())).toEqual(stored);
  } finally { process.env.HOME = home; }
});

test("a directory swapped for a link out of the roots while a path route opens its picture serves nothing from there", async () => {
  const base = await directory(os.tmpdir(),"prototype-roots-");
  const outside = path.join(base,"outside"); await fs.mkdir(outside);
  const home = process.env.HOME, evidence = process.env.LLV_EVIDENCE_ROOTS;
  process.env.HOME = path.join(base,"home"); await fs.mkdir(process.env.HOME);
  process.env.LLV_EVIDENCE_ROOTS = path.join(base,"evidence");
  try {
    const allowed = path.join(await source(),"shot.png");
    await fs.writeFile(allowed,Buffer.concat([PNG,Buffer.from("allowed!")]));
    await fs.writeFile(path.join(outside,"shot.png"),Buffer.concat([PNG,Buffer.from("OUTSIDE!")]));
    expect((await imageGET(request(`/api/image?path=${encodeURIComponent(path.join(outside,"shot.png"))}`))).status).toBe(403);
    await swappedUnderEveryPathRoute(allowed,outside,"OUTSIDE!");
  } finally {
    process.env.HOME = home;
    if (evidence === undefined) delete process.env.LLV_EVIDENCE_ROOTS; else process.env.LLV_EVIDENCE_ROOTS = evidence;
  }
});

/**
 * A platform that publishes no name for an open file, and the race that a
 * second look at the path loses: the directory is a link to `outside` while
 * `target` is opened, real again afterwards, and a link once more between a
 * resolution of the path and the next status read of it. No status is forged.
 */
async function swapWithoutDescriptorNames(swapped: string,outside: string,target: string,run: () => Promise<void>) {
  const open = fs.open.bind(fs), stat = fs.stat.bind(fs), realpath = fs.realpath.bind(fs), readlink = fs.readlink.bind(fs);
  let state: "before" | "opening" | "opened" | "resolved" | "judged" = "before";
  const link = async () => { await fs.rename(swapped,`${swapped}.held`); await fs.symlink(outside,swapped); };
  const unlink = async () => { await fs.unlink(swapped); await fs.rename(`${swapped}.held`,swapped); };
  const spies = [
    spyOn(fs,"readlink").mockImplementation((async (file: never,...rest: never[]) => {
      if (String(file).startsWith("/proc/self/fd/")) throw Object.assign(new Error("no such file or directory"),{ code: "ENOENT" });
      return readlink(file,...rest);
    }) as never),
    spyOn(fs,"open").mockImplementation((async (file: never,...rest: never[]) => {
      if (file !== target || state !== "before") return open(file,...rest);
      state = "opening"; await link();
      try { return await open(file,...rest); } finally { await unlink(); state = "opened"; }
    }) as never),
    spyOn(fs,"realpath").mockImplementation((async (file: never,...rest: never[]) => {
      const resolved = await realpath(file,...rest);
      if (file === target && state === "opened") { state = "resolved"; await link(); }
      return resolved;
    }) as never),
    spyOn(fs,"stat").mockImplementation((async (file: never,...rest: never[]) => {
      try { return await stat(file,...rest); } finally { if (file === target && state === "resolved") { state = "judged"; await unlink(); } }
    }) as never),
  ];
  try { await run(); } finally {
    for (const spy of spies) spy.mockRestore();
    if ((state as string) === "resolved") await unlink();
  }
  expect(["opened","judged"]).toContain(state as string);
}
test("where the kernel names no open file, a directory swapped twice around the open reads nothing outside the roots on any path route", async () => {
  const base = await directory(os.tmpdir(),"prototype-roots-");
  const outside = path.join(base,"outside"); await fs.mkdir(outside);
  const home = process.env.HOME, evidence = process.env.LLV_EVIDENCE_ROOTS;
  process.env.HOME = path.join(base,"home"); await fs.mkdir(process.env.HOME);
  process.env.LLV_EVIDENCE_ROOTS = path.join(base,"evidence");
  try {
    const allowed = path.join(await source(),"shot.png");
    await fs.writeFile(allowed,Buffer.concat([PNG,Buffer.from("allowed!")]));
    await fs.writeFile(path.join(outside,"shot.png"),Buffer.concat([PNG,Buffer.from("OUTSIDE!")]));
    for (const route of pathRoutes(allowed)) {
      await swapWithoutDescriptorNames(path.dirname(allowed),outside,allowed,async () => {
        const response = await route();
        expect(Buffer.from(await response.arrayBuffer()).includes("OUTSIDE!")).toBe(false);
        expect(response.status).toBe(403);
      });
      // With the kernel's names back the same picture is served.
      const restored = await route();
      expect(restored.status).toBe(200); expect(Buffer.from(await restored.arrayBuffer()).includes("allowed!")).toBe(true);
    }
  } finally {
    process.env.HOME = home;
    if (evidence === undefined) delete process.env.LLV_EVIDENCE_ROOTS; else process.env.LLV_EVIDENCE_ROOTS = evidence;
  }
});

test("where the kernel names no open file, the same race publishes nothing and a stored copy answers nothing from outside", async () => {
  const base = await directory(os.tmpdir(),"prototype-roots-");
  const outside = path.join(base,"outside"); await fs.mkdir(outside);
  const home = process.env.HOME, evidence = process.env.LLV_EVIDENCE_ROOTS;
  process.env.HOME = path.join(base,"home"); await fs.mkdir(process.env.HOME);
  process.env.LLV_EVIDENCE_ROOTS = path.join(base,"evidence");
  try {
    const body = await input("swap-source-unnamed");
    const picture = body.variants[0]!.frames![0]!.path;
    await fs.writeFile(path.join(outside,"new.png"),Buffer.concat([PNG,Buffer.from("OUTSIDE!")]));
    await swapWithoutDescriptorNames(path.dirname(picture),outside,picture,async () => {
      const response = await publishPOST(request("/api/prototype-reviews",body));
      expect(response.status).toBe(403);
      expect((await response.json()).error).toContain("Nothing was published.");
    });
    expect(loadTasks()[0]!.prototypeReviews).toBeUndefined();
    const copies = await fs.readdir(path.join(stateDir(),"prototype-reviews"),{ recursive: true }).catch(() => []);
    expect(copies.filter(name => /\.(png|webm)$/.test(name))).toEqual([]);

    const id = await publish(body);
    const round = loadTasks()[0]!.prototypeReviews![0]!;
    const elsewhere = path.join(base,"elsewhere"); await fs.mkdir(elsewhere);
    for (const media of roundMedia(round)) {
      const own = await fs.readFile(path.join(roundDirectory(id),mediaFilename(media)));
      const foreign = Buffer.from(own); foreign.write("OUTSIDE",own.length - 7);
      await fs.writeFile(path.join(elsewhere,mediaFilename(media)),foreign);
      const kind = media.mime.startsWith("image/") ? "image" as const : "video" as const;
      const target = path.join(await fs.realpath(roundDirectory(id)),mediaFilename(media));
      await swapWithoutDescriptorNames(roundDirectory(id),elsewhere,target,async () => {
        const response = await prototypeMediaGET(request("/media"),TASK,id,media.id,kind);
        expect(Buffer.from(await response.arrayBuffer()).includes("OUTSIDE")).toBe(false);
        expect(response.status).toBe(404);
      });
      const restored = await prototypeMediaGET(request("/media"),TASK,id,media.id,kind);
      expect(restored.status).toBe(200); expect(Buffer.from(await restored.arrayBuffer())).toEqual(own);
    }
  } finally {
    process.env.HOME = home;
    if (evidence === undefined) delete process.env.LLV_EVIDENCE_ROOTS; else process.env.LLV_EVIDENCE_ROOTS = evidence;
  }
});

const lockLeftovers = async () => (await fs.readdir(path.join(stateDir(),"prototype-reviews"))).filter(name => name.includes(".decision.lock")).sort();

test("the lock queues of rounds no task holds leave with the next publication; a held round keeps its own, pictures retired or not", async () => {
  const body = await input("locks");
  const decide = async (id: string) => expect((await reviewPOST(request("/review",{ reviewId: id, chosen: [1], comment: "Chosen." }),TASK)).status).toBe(200);
  for (let n = 0; n < 5; n += 1) {
    saveTasks([task()]);
    await decide(await publish({ ...body, clientRequestId: `locks-${n}` }));
    saveTasks([]);
  }
  saveTasks([task()]);
  const kept = await publish({ ...body, clientRequestId: "locks-kept" });
  await decide(kept);
  expect(await lockLeftovers()).toEqual([`${kept}.decision.lock.write-locks`]);
  const rounds = PROTOTYPE_LIMITS.storedRounds;
  try {
    Reflect.set(PROTOTYPE_LIMITS,"storedRounds",1);
    const next = await publish({ ...body, clientRequestId: "locks-next" });
    // The kept round's pictures are retired; its decision is still read under its lock.
    expect(loadTasks()[0]!.prototypeReviews!.find(round => round.id === kept)!.mediaRemovedAt).toBeDefined();
    await publish({ ...body, clientRequestId: "locks-after" });
    expect(await lockLeftovers()).toEqual([`${kept}.decision.lock.write-locks`]);
    expect((await read()).rounds.find(round => round.id === kept)!.decision!.comment).toBe("Chosen.");
    expect(next).not.toBe(kept);
  } finally { Reflect.set(PROTOTYPE_LIMITS,"storedRounds",rounds); }
});

test("a publication's cleanup during a save leaves the save its lock: a second save, a read and a retry wait and one message goes", async () => {
  saveTasks([task(),task("task-other")]);
  const body = await input("lock-held");
  const id = await publish(body);
  let sends = 0, sent = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const delivery: PrototypeDelivery = {
    recover: async () => sent ? { state: "sent", operationId: "operation-1" } : null,
    send: async () => { sends += 1; await gate; sent = true; return { state: "sent", operationId: "operation-1" }; },
    retry: async () => { throw new Error("nothing failed, so nothing is retried"); },
  };
  const world = { caller: () => ({ conversationId: null, project: null }), stage: () => null, orchestrator: () => "conversation_seat" };
  const save = () => reviewPOST(request("/review",{ reviewId: id, chosen: [1], comment: "Chosen once." }),TASK,world,delivery);
  const first = save();
  for (let n = 0; sends === 0 && n < 500; n += 1) await Bun.sleep(5);
  expect(sends).toBe(1);
  const waiting = [save(),reviewGET(request("/review"),TASK,world,delivery),reviewPOST(request("/review",{ reviewId: id, retry: true }),TASK,world,delivery)];
  await Bun.sleep(30);
  // Another task's publication runs the cleanup while the lock is held and queued for.
  await publish({ ...body, taskId: "task-other", clientRequestId: "lock-held-other" });
  const queue = path.join(stateDir(),"prototype-reviews",`${id}.decision.lock.write-locks`);
  expect((await fs.readdir(queue)).length).toBe(4);
  expect(await lockLeftovers()).toEqual([`${id}.decision.lock.write-lock`,`${id}.decision.lock.write-locks`]);
  release();
  for (const response of [await first,...await Promise.all(waiting)]) expect(response.status).toBe(200);
  expect(sends).toBe(1);
  expect(loadTasks()[0]!.prototypeReviews![0]!.decision!.delivery).toMatchObject({ state: "sent", operationId: "operation-1" });
  expect(await fs.readdir(queue)).toEqual([]);
});

test("a task's history keeps a bounded number of rounds: superseded undecided rounds leave first and decisions never do", async () => {
  const body = await input("history");
  const rounds = PROTOTYPE_LIMITS.taskRounds;
  try {
    Reflect.set(PROTOTYPE_LIMITS,"taskRounds",3);
    const ids: string[] = [];
    for (let n = 0; n < 5; n += 1) ids.push(await publish({ ...body, clientRequestId: `history-${n}` }));
    let held = loadTasks()[0]!.prototypeReviews!;
    expect(held.map(round => round.id)).toEqual(ids.slice(2));
    for (const gone of ids.slice(0,2)) expect(await fs.stat(roundDirectory(gone)).then(() => true,() => false)).toBe(false);
    expect((await read()).rounds).toHaveLength(3);
    const comments = ids.slice(2).map((_,n) => `  Round ${n}: keep these words.\n`);
    for (const [n,id] of ids.slice(2).entries()) expect((await reviewPOST(request("/review",{ reviewId: id, chosen: [1], comment: comments[n] }),TASK)).status).toBe(200);
    const refused = await publishPOST(request("/api/prototype-reviews",{ ...body, clientRequestId: "history-full" }));
    expect(refused.status).toBe(409); expect((await refused.json()).error).toContain("3 decided");
    held = loadTasks()[0]!.prototypeReviews!;
    expect(held.map(round => round.id)).toEqual(ids.slice(2));
    expect(held.map(round => round.decision?.comment)).toEqual(comments);
    expect((await read()).rounds.map(round => round.decision?.chosen)).toEqual([[1],[1],[1]]);
  } finally { Reflect.set(PROTOTYPE_LIMITS,"taskRounds",rounds); }
});

test("a task's history keeps a bounded size of metadata under the same rule", async () => {
  const body = await input("history-bytes");
  const bytes = PROTOTYPE_LIMITS.taskMetadataBytes;
  try {
    const first = await publish({ ...body, clientRequestId: "bytes-0" });
    const one = Buffer.byteLength(JSON.stringify(loadTasks()[0]!.prototypeReviews));
    Reflect.set(PROTOTYPE_LIMITS,"taskMetadataBytes",Math.floor(one * 2.5));
    const kept: string[] = [first];
    for (let n = 1; n < 6; n += 1) kept.push(await publish({ ...body, clientRequestId: `bytes-${n}` }));
    const held = loadTasks()[0]!.prototypeReviews!;
    expect(held.map(round => round.id)).toEqual(kept.slice(-2));
    expect(Buffer.byteLength(JSON.stringify(held))).toBeLessThanOrEqual(PROTOTYPE_LIMITS.taskMetadataBytes);
  } finally { Reflect.set(PROTOTYPE_LIMITS,"taskMetadataBytes",bytes); }
});
