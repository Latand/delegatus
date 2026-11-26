import { diffBoard, type BoardDelta } from "@/lib/boardDelta";
import type { FileEntry } from "@/lib/types";

const tag = (revision: number) => '"isolation-' + revision + '"';

/** The page supplies one frozen seed. Playwright fulfils subsequent catalog reads from disk-free
 * response bodies, keeping the fixture's JSON encoding out of the Chromium input thread. */
export function isolationCatalogReplies(body: string, targetPath: string, catalogTraffic: boolean) {
  const initial = JSON.parse(body) as Record<string, unknown> & { files: FileEntry[] };
  const index = initial.files.findIndex(file => file.path === targetPath);
  if (index < 0 || initial.boardProtocol !== 2) throw Error("catalog transport seed is incomplete");
  function raw(revision: number) {
    if (revision === 1) return initial;
    const files = [...initial.files];
    const old = initial.files[index]!;
    files[index] = { ...old, size:old.size+revision-1, mtime:old.mtime+revision-1 };
    return { ...initial, files };
  }
  const deltas = new Map<number, BoardDelta>();
  function delta(revision: number): BoardDelta {
    let value = deltas.get(revision);
    if (!value) {
      value = diffBoard(raw(revision-1), raw(revision), tag(revision-1), tag(revision));
      deltas.set(revision,value);
    }
    return value;
  }
  if (catalogTraffic) for (let n=2; n<=16; n++) delta(n);
  const counts = { full:0, delta:0, unchanged:0, bytes:0 };
  return {
    counts,
    reply(revision: number, conditional?: string, acceptsDelta = false) {
      if (!Number.isSafeInteger(revision) || revision < 1) throw Error("invalid catalog revision");
      const headers: Record<string,string> = { etag:tag(revision), "x-llv-board-protocol":"2", "content-type":"application/json" };
      if (conditional === headers.etag) { counts.unchanged++; return { status:304,headers,body:"" }; }
      const base = /^"isolation-([0-9]+)"$/.exec(conditional ?? "");
      const from = Number(base?.[1]);
      let text: string;
      if (acceptsDelta && base && from >= 1 && from < revision) {
        const chain: BoardDelta[]=[];
        for (let n=from+1;n<=revision;n++) chain.push(delta(n));
        text=JSON.stringify({deltas:chain});headers["x-llv-files-delta-base"]=conditional!;counts.delta++;
      } else {
        text=revision===1 ? body : JSON.stringify(raw(revision));
        counts.full++;
      }
      counts.bytes+=Buffer.byteLength(text);
      return {status:200,headers,body:text};
    },
  };
}
