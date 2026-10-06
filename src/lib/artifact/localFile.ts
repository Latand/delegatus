import { constants as FS, type promises as fsp } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { homeDirectory } from "@/lib/platformHome";

/*
 * Local-file plumbing shared by the artifact routes (/api/artifact and the
 * report frame beneath it): the allowed roots, lexical containment and the
 * bounded, abortable stream over one pinned descriptor.
 */

/** One streamed read; also the natural rhythm the deadline is checked at. */
const STREAM_CHUNK = 64 * 1024;

/* $HOME first: it is what the isolated demo/evidence runtimes (and tests)
   repoint, and Bun's os.homedir() ignores the env override. On Windows HOME is
   not a Windows variable and a Git Bash value would resolve to nothing — see
   `homeDirectory`. */
export function homeRoot(): string {
  return homeDirectory();
}

export function resolveLocal(raw: string): string {
  let p = raw.replace(/^file:\/\//, "");
  if (p === "~" || p.startsWith("~/")) p = path.join(homeRoot(), p.slice(1));
  return path.resolve(p);
}

export function underRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

/* Where agents write rendered evidence outside the home directory (#2084):
   stage specs keep rasters out of the repository and the config root, so
   renders land under `/var/tmp/<lane>/`. `LLV_EVIDENCE_ROOTS` (a `:`-separated
   list of absolute directories) replaces the default for an install whose
   agents write elsewhere. */
const DEFAULT_EVIDENCE_ROOTS = ["/var/tmp"];

export function evidenceRoots(): string[] {
  const configured = process.env.LLV_EVIDENCE_ROOTS;
  const roots = configured === undefined ? DEFAULT_EVIDENCE_ROOTS : configured.split(":");
  return roots.map((root) => root.trim()).filter((root) => path.isAbsolute(root)).map((root) => path.resolve(root));
}

/** SVG is a document; an evidence root serves rasters and nothing else. */
const EVIDENCE_IMAGE_RE = /\.(?:png|jpe?g|gif|webp|avif|bmp)$/i;

export function isEvidenceImage(pathname: string): boolean {
  return EVIDENCE_IMAGE_RE.test(pathname);
}

/* Stores under an allowed root that answer only through their own route. The
   prototype review copies are read by manifest, task and caller; a path route
   that handed them out would let any caller around that fence, so no path
   under one is admitted, as written or after its links resolve. */
export function fencedStores(): string[] {
  return [statePath("prototype-reviews")];
}

/** Whether a path, as written or resolved, lies in a fenced store. */
export function inFencedStore(candidate: string, fenced: readonly string[]): boolean {
  return fenced.some((store) => underRoot(candidate, store));
}

/** Which root admits a path: home, or an evidence root for a raster image. */
export type Admission = "home" | "evidence";

/**
 * Whether a path may be read, and under which root. The home root admits
 * every previewable artifact; an evidence root admits raster images only.
 * Callers check the path as written here, then its realpath with
 * `realpathAdmitted`.
 */
export function admittedAs(candidate: string, roots: AllowedRoots): Admission | null {
  if (inFencedStore(candidate, roots.fenced)) return null;
  if (underRoot(candidate, roots.home)) return "home";
  return isEvidenceImage(candidate) && roots.evidence.some((root) => underRoot(candidate, root)) ? "evidence" : null;
}

/**
 * Whether a path's realpath stays inside what the path as written was
 * admitted as, against the realpathed roots (`realAllowedRoots`). A home path
 * may resolve into either root, so a link out of home into an evidence root
 * still reads only an image. A path only an evidence root admitted must
 * resolve to an image under an evidence root: `/var/tmp` is world-writable, and
 * a link planted there must not read a home file the home root would serve.
 */
export function realpathAdmitted(lexical: Admission, real: string, roots: AllowedRoots): boolean {
  const resolved = admittedAs(real, roots);
  if (lexical === "home") return resolved !== null;
  return resolved !== null && isEvidenceImage(real) && roots.evidence.some((root) => underRoot(real, root));
}

export interface AllowedRoots {
  home: string;
  evidence: string[];
  /** Fenced stores, which no root admits. */
  fenced: string[];
}

export function lexicalAllowedRoots(): AllowedRoots {
  return { home: homeRoot(), evidence: evidenceRoots(), fenced: fencedStores() };
}

/** The same roots with symlinks resolved; a root that does not exist is dropped. */
export async function realAllowedRoots(): Promise<AllowedRoots> {
  const real = async (root: string) => fs.realpath(root).catch(() => null);
  const home = (await real(homeRoot())) ?? homeRoot();
  const evidence = (await Promise.all(evidenceRoots().map(real))).filter((root): root is string => root !== null);
  /* A store that does not exist yet holds nothing to read; one reached through
     a link is fenced at the place the link leads to as well. */
  const stores = fencedStores();
  const fenced = [...new Set([...stores, ...(await Promise.all(stores.map(real))).filter((store): store is string => store !== null)])];
  return { home, evidence, fenced };
}

/* macOS refuses an open with this flag (`ELOOP`) when any component of the
   path is a link, where `O_NOFOLLOW` looks at the last one only. */
const DARWIN_O_NOFOLLOW_ANY = 0x20000000;

let linklessOpen: Promise<boolean> | undefined;

/**
 * Whether this runtime's open honours `O_NOFOLLOW_ANY`, tried once against a
 * link of its own making: a runtime or a kernel that drops the flag would turn
 * the check built on it into an ordinary second open.
 */
function honoursLinklessOpen(): Promise<boolean> {
  return linklessOpen ??= (async () => {
    let scratch: string | undefined;
    try {
      scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "llv-linkless-")));
      await fs.mkdir(path.join(scratch, "real"));
      await fs.writeFile(path.join(scratch, "real", "probe"), "");
      await fs.symlink(path.join(scratch, "real"), path.join(scratch, "link"));
      const plain = await fs.open(path.join(scratch, "real", "probe"), FS.O_RDONLY | DARWIN_O_NOFOLLOW_ANY);
      await plain.close();
      const through = await fs.open(path.join(scratch, "link", "probe"), FS.O_RDONLY | DARWIN_O_NOFOLLOW_ANY).catch(() => null);
      await through?.close();
      return through === null;
    } catch {
      return false;
    } finally {
      if (scratch) await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  })();
}

/**
 * Whether an open descriptor is the file at `expected`, a path whose links
 * are already resolved, or `null` where the platform has no way to tell.
 * `O_NOFOLLOW` guards only the last component, so a directory above it swapped
 * for a link between the check and the open hands back a file from somewhere
 * else under the same name. Looking at the path again settles nothing: the
 * directory can be swapped back and forth around each look. Two mechanisms do
 * settle it. Linux publishes the kernel's own name for the open file
 * (`/proc/self/fd`), which names what was opened whatever the path says by
 * now. macOS opens the path once more in a single call that refuses every
 * link on the way (`O_NOFOLLOW_ANY`) and must arrive at the same inode.
 */
export async function descriptorPlace(handle: fsp.FileHandle, expected: string, platform: NodeJS.Platform = process.platform): Promise<boolean | null> {
  const held = await fs.readlink(`/proc/self/fd/${handle.fd}`).catch(() => null);
  if (held !== null) return held === expected;
  if (platform !== "darwin" || !await honoursLinklessOpen()) return null;
  let again: fsp.FileHandle | undefined;
  try {
    again = await fs.open(expected, FS.O_RDONLY | FS.O_NONBLOCK | DARWIN_O_NOFOLLOW_ANY);
    const [named, pinned] = await Promise.all([again.stat(), handle.stat()]);
    return named.ino === pinned.ino && named.dev === pinned.dev;
  } catch {
    return false;
  } finally {
    await again?.close().catch(() => {});
  }
}

/**
 * Whether an open descriptor is known to be the file at `expected`. A platform
 * that cannot tell answers no: the prototype store publishes and serves a copy
 * only where its place is established.
 */
export async function openedAt(handle: fsp.FileHandle, expected: string): Promise<boolean> {
  return await descriptorPlace(handle, expected) === true;
}

/**
 * Opens a path whose links were resolved and whose place was admitted, and
 * hands the descriptor back only when the open file is the one at that place.
 * The roots and the fenced stores were judged on the path; this is what makes
 * that judgement hold for the bytes, and every read after it goes through the
 * descriptor. A file that turns out to lie elsewhere fails as a link at the
 * last component does (`ELOOP`), and so does one whose place the platform
 * cannot establish. `O_NONBLOCK` keeps a pipe under the name from holding the
 * open; the caller's own check refuses anything that is no file.
 *
 * Windows has neither mechanism and no `O_NOFOLLOW`. There the path is
 * resolved once more after the open and must still lead to the same file,
 * which is what these routes did before they pinned a descriptor; the store
 * that needs the stronger fence holds nothing on Windows, because `openedAt`
 * refuses its publications.
 */
export async function openAdmitted(real: string, platform: NodeJS.Platform = process.platform): Promise<fsp.FileHandle> {
  const handle = await fs.open(real, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
  const place = await descriptorPlace(handle, real, platform);
  if (place === true || (place === null && platform === "win32" && await resolvesTo(handle, real))) return handle;
  await handle.close().catch(() => {});
  throw Object.assign(new Error("the opened file is not the admitted one"), { code: "ELOOP" });
}

async function resolvesTo(handle: fsp.FileHandle, expected: string): Promise<boolean> {
  try {
    if (await fs.realpath(expected) !== expected) return false;
    const [named, pinned] = await Promise.all([fs.stat(expected), handle.stat()]);
    return named.ino === pinned.ino && named.dev === pinned.dev;
  } catch {
    return false;
  }
}

/**
 * Streams `[start, end]` from the pinned descriptor, honouring the request's
 * AbortSignal (the preview closing cancels the fetch) and the configured time
 * budget. The descriptor is closed on completion, cancellation and error —
 * exactly once.
 */
export function streamWindow(
  handle: fsp.FileHandle,
  start: number,
  end: number,
  signal: AbortSignal,
  timeBudgetMs: number,
): ReadableStream<Uint8Array> {
  let position = start;
  const deadline = Date.now() + timeBudgetMs;
  let done = false;
  const finish = async () => {
    if (done) return;
    done = true;
    await handle.close().catch(() => {});
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (signal.aborted || Date.now() > deadline) {
        await finish();
        controller.error(new Error(signal.aborted ? "client aborted" : "artifact time budget exceeded"));
        return;
      }
      const want = Math.min(STREAM_CHUNK, end - position + 1);
      if (want <= 0) {
        await finish();
        controller.close();
        return;
      }
      const buffer = Buffer.alloc(want);
      try {
        const { bytesRead } = await handle.read(buffer, 0, want, position);
        if (bytesRead <= 0) {
          /* The pinned inode ended early (truncated in place): end the body
             rather than hang — the client's validator round-trip reports it. */
          await finish();
          controller.close();
          return;
        }
        position += bytesRead;
        controller.enqueue(new Uint8Array(buffer.subarray(0, bytesRead)));
      } catch (error) {
        await finish();
        controller.error(error);
      }
    },
    async cancel() {
      await finish();
    },
  });
}
