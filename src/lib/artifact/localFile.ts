import { constants as FS, lstatSync, realpathSync, type promises as fsp } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { APP_DIR_NAMES } from "../../../bin/appDir.mjs";
import { repositoryRootForPath } from "@/lib/projects/identity";
import { stateDir, statePath } from "@/lib/configDir";
import { knownProjectFileRoots } from "@/lib/scanner/projectDirectories";
import { projectCurationSnapshot } from "@/lib/projects/curation";
import { homeDirectory } from "@/lib/platformHome";
import { keptReportRow, reportMediaCopyAllowed, reportMediaRoot } from "@/lib/reportMedia/lookup";
import { isEvidenceImage } from "./evidenceFormats";
export { isEvidenceImage } from "./evidenceFormats";

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

/* Durable rendered evidence is outside every managed scratch root. The
   historical OS temp location remains readable for existing report links. */
export function evidenceRoots(): string[] {
  const configured = process.env.LLV_EVIDENCE_ROOTS;
  const roots = configured === undefined ? [statePath("evidence"), "/var/tmp"] : configured.split(":");
  return roots.map((root) => root.trim()).filter((root) => path.isAbsolute(root)).map((root) => path.resolve(root));
}

/* The roots that serve rasters and nothing else: the evidence roots, and the
   report picture store. The store is no evidence root: agents are never told
   to render into it. */
function rasterRoots(): string[] {
  return [...new Set([...evidenceRoots(), reportMediaRoot()])];
}

/**
 * Where a requested local path is read from. A file that lies at the path,
 * under a root these routes serve, is read there. Otherwise the copy the
 * report picture store kept when a report named the path stands for it: the
 * picture was swept with its lane checkout or its temp directory, or it lies
 * in a temp directory these routes do not read. The store copies from the
 * served roots and the named temp roots only, so a copy reaches no further
 * than that. The answer goes through the same admission as any other path.
 */
export function readablePlace(abs: string, roots: AllowedRoots = lexicalAllowedRoots()): string {
  if (!hiddenPathAllowed(abs, roots)) return abs;
  if (admittedAs(abs, roots)) {
    try {
      lstatSync(abs);
      return abs;
    } catch {
      /* Gone from its own path. */
    }
  }
  /* Keep legacy candidates visible to admission, which refuses their store
     path with the existing 403 instead of mistaking them for missing files. */
  return keptReportRow(abs)?.copy ?? abs;
}

/**
 * The project whose members may read what `readablePlace` answered for a
 * requested path: for a kept copy, the project its picture lay in when it was
 * copied; undefined for a file read where it lies, whose own directory says.
 */
export function keptPictureProject(requested: string, place: string): string | null | undefined {
  const kept = keptReportRow(requested);
  return kept && kept.copy === place ? kept.row.project : undefined;
}

/* Stores under an allowed root that answer only through their own route. The
   prototype review copies are read by manifest, task and caller; a path route
   that handed them out would let any caller around that fence, so no path
   under one is admitted, as written or after its links resolve. */
export function fencedStores(): string[] {
  return [statePath("prototype-reviews"), statePath("done-media")];
}

/** Whether a path, as written or resolved, lies in a fenced store. */
export function inFencedStore(candidate: string, fenced: readonly string[]): boolean {
  return fenced.some((store) => underRoot(candidate, store));
}

/** A product-owned output directory inside a private area, with the class of file it may serve. */
interface Passage {
  root: string;
  /** Raster files only, and never a project root at or below it. */
  rasterOnly: boolean;
}

interface PrivateArea {
  root: string;
  /** Product-owned output directories inside this area that keep their main-branch admission. */
  passages: Passage[];
}

/* The two directories the product writes stage output into: managed scratch
   (a project root, any file) and durable evidence (a raster root, rasters
   only). Their root, class and hidden-component rules still decide admission;
   the passage only lifts the private-area veto that would otherwise cover the
   state directory, and only for the class its root serves on main. Another
   project root that contains evidence, or a cwd recorded inside it, therefore
   reaches its rasters and nothing else. */
const STATE_OUTPUTS = [{ name: "scratch", rasterOnly: false }, { name: "evidence", rasterOnly: true }] as const;

function realOrWritten(root: string): string {
  try {
    const anchor = path.parse(root).root;
    const parts = root.slice(anchor.length).split(process.platform === "win32" ? /[\\/]+/ : /\/+/);
    // Bun's realpathSync also collapses `..` before following links. Resolve
    // each prefix before ascending so the filesystem chooses its parent.
    if (!parts.includes("..")) return realpathSync(root);
    let resolved = path.resolve(anchor || ".");
    let pending: string[] = [];
    for (const part of parts) {
      if (part === "..") {
        resolved = path.dirname(realpathSync(path.join(resolved, ...pending)));
        pending = [];
      } else pending.push(part);
    }
    return realpathSync(path.join(resolved, ...pending));
  } catch { return root; }
}

function privateRootNames(root: string): string[] {
  const lexical = path.resolve(root);
  // Follow links in the original spelling before collapsing `..`. Retain
  // the lexical consumer's location and any link it follows as well.
  return [...new Set([lexical, realOrWritten(root), realOrWritten(lexical)].map(name => path.resolve(name)))];
}

/** Private tool/config areas stay private even when another allowed root contains them.
 * Keep both written and resolved names: a configured home can itself be a link.
 */
function privateAreas(): PrivateArea[] {
  const literalHome = process.env.HOME;
  const literalProfile = process.env.USERPROFILE;
  const homes = [...new Set([
    homeRoot(),
    os.homedir(),
    ...(literalHome && path.isAbsolute(literalHome) ? [literalHome, literalHome.trim()].filter(Boolean) : []),
    ...(literalProfile && path.isAbsolute(literalProfile) ? [literalProfile, literalProfile.trim()].filter(Boolean) : []),
  ].flatMap(privateRootNames))];
  const tools = homes.flatMap(home => [".codex", ".claude", ".copilot", ".openclaw"].map(name => path.join(home, name)));
  for (const key of ["LLV_CODEX_HOME", "CODEX_HOME", "DELEGATUS_CODEX_HOME", "LLV_CLAUDE_HOME", "CLAUDE_CONFIG_DIR", "DELEGATUS_CLAUDE_HOME", "COPILOT_HOME", "OPENCLAW_STATE_DIR"]) {
    const configured = process.env[key];
    if (!configured) continue;
    // Some consumers use the configured value literally while others trim it.
    // Protect both filesystem locations so whitespace cannot select a path
    // outside this guard or weaken the existing trimmed-home policy.
    tools.push(configured);
    const trimmed = configured.trim();
    if (trimmed) tools.push(trimmed);
  }
  const configs = homes.map(home => path.join(home, ".config"));
  if (process.env.XDG_CONFIG_HOME) configs.push(process.env.XDG_CONFIG_HOME);
  const states = privateRootNames(stateDir());
  // Each output is named below every spelling of the state directory and never
  // by its own resolved target: a linked output that leads elsewhere inside a
  // private area gains nothing, because the resolved candidate is judged again.
  const outputs: Passage[] = states.flatMap(state => STATE_OUTPUTS.map(({ name, rasterOnly }) => ({ root: path.join(state, name), rasterOnly })));
  const areas: PrivateArea[] = [];
  const add = (root: string, withOutputs: boolean) => {
    for (const name of privateRootNames(root)) {
      areas.push({ root: name, passages: withOutputs ? outputs.filter(output => output.root !== name && underRoot(output.root, name)) : [] });
    }
  };
  for (const root of new Set(tools)) add(root, false);
  for (const root of new Set([...configs.flatMap(privateRootNames).flatMap(config => APP_DIR_NAMES.map(name => path.join(config, name))), ...states])) add(root, true);
  // Managed homes and shared credentials follow a relocated state directory.
  for (const state of states) {
    for (const name of ["accounts", "shared"]) add(path.join(path.dirname(state), name), false);
  }
  return areas;
}

/**
 * Whether no private area vetoes a path. A file candidate passes a passage of
 * its class; a project root candidate passes only a passage that serves every
 * file, because a root inside a raster passage would serve its other files.
 */
function privatePathAllowed(candidate: string, areas: readonly PrivateArea[], asRoot = false): boolean {
  const passes = (passage: Passage) => underRoot(candidate, passage.root)
    && (!passage.rasterOnly || (!asRoot && isEvidenceImage(candidate)));
  return areas.every(({ root, passages }) => !underRoot(candidate, root) || passages.some(passes));
}

/** Exact project folders and worktrees, plus the product-owned stage scratch. */
function projectRoots(): string[] {
  return [...new Set([...knownProjectFileRoots(), ...projectCurationSnapshot().manualProjects.map(entry => entry.root), statePath("scratch")])]
    .filter(root => path.isAbsolute(root)).map(root => path.resolve(root));
}

export type Admission = "project" | "evidence";

/**
 * Hidden components below any containing root of the admission kind are
 * private. Only product-owned directory passages are served; a hidden file
 * name is always private. Root components are deliberately outside the rule.
 * The picture writer supplies temp roots only for paths outside served roots.
 * With no surviving root, still refuse a hidden name before kept-copy lookup.
 */
export function hiddenPathAllowed(candidate: string, roots: AllowedRoots, temp: readonly string[] = []): boolean {
  if (!privatePathAllowed(candidate, roots.privateAreas ?? [])) return false;
  const containing = (group: readonly string[]) => group.filter(root => underRoot(candidate, root));
  const projects = containing(roots.projects);
  const evidence = projects.length ? [] : containing(roots.evidence);
  const selected = projects.length ? projects : evidence.length ? evidence : containing(temp);
  if (!selected.length) return !path.basename(candidate).startsWith(".");
  return selected.every(root => {
    const relative = path.relative(root, candidate);
    if (!relative) return true;
    const parts = relative.split(path.sep);
    return parts.every((part, index) => {
      if (!part.startsWith(".")) return true;
      if (index === parts.length - 1) return false;
      return part === ".artifacts" || part === ".worktrees"
        || (part === ".claude" && parts[index + 1] === "worktrees" && index + 2 < parts.length);
    });
  });
}

/** Check lexical containment before resolving links; evidence roots admit rasters only. */
export function admittedAs(candidate: string, roots: AllowedRoots): Admission | null {
  if (inFencedStore(candidate, roots.fenced) || !hiddenPathAllowed(candidate, roots) || !reportMediaCopyAllowed(candidate)) return null;
  if (roots.projects.some(root => underRoot(candidate, root))) return "project";
  return isEvidenceImage(candidate) && roots.evidence.some((root) => underRoot(candidate, root)) ? "evidence" : null;
}

/** A link must stay within admitted roots. Evidence links still resolve to rasters. */
export function realpathAdmitted(lexical: Admission, real: string, roots: AllowedRoots): boolean {
  const resolved = admittedAs(real, roots);
  if (lexical === "project") return resolved !== null;
  return resolved !== null && isEvidenceImage(real) && roots.evidence.some((root) => underRoot(real, root))
    && hiddenPathAllowed(real, { ...roots, projects: [] });
}

export interface AllowedRoots {
  home: string;
  projects: string[];
  /** Roots that serve rasters only: the evidence roots and the report picture store. */
  evidence: string[];
  /** Fenced stores, which no root admits. */
  fenced: string[];
  /** Private tool/config areas, with narrowly owned output passages. */
  privateAreas?: PrivateArea[];
}

export function lexicalAllowedRoots(): AllowedRoots {
  const home = homeRoot();
  const candidates = projectRoots();
  const areas = privateAreas();
  const projects = candidates.filter(root => !underRoot(home, root) && privatePathAllowed(root, areas, true));
  return { home, projects, evidence: rasterRoots(), fenced: fencedStores(), privateAreas: areas };
}

/** The same roots with symlinks resolved; a root that does not exist is dropped. */
export async function realAllowedRoots(): Promise<AllowedRoots> {
  return realAllowedRootsSync();
}

/** Resolve the current roots synchronously for album readers. */
export function realAllowedRootsSync(): AllowedRoots {
  const real = (root: string) => {
    try {
      return realpathSync(root);
    } catch {
      return null;
    }
  };
  const home = real(homeRoot()) ?? homeRoot();
  const evidence = rasterRoots().map(real).filter((root): root is string => root !== null);
  /* A store that does not exist yet holds nothing to read; one reached through
     a link is fenced at the place the link leads to as well. */
  const stores = fencedStores();
  const fenced = [...new Set([...stores, ...stores.map(real).filter((store): store is string => store !== null)])];
  const lexical = lexicalAllowedRoots();
  const areas = lexical.privateAreas ?? [];
  const projects = lexical.projects.map(real).filter((root): root is string => root !== null && !underRoot(home, root) && privatePathAllowed(root, areas, true));
  return { home, projects, evidence, fenced, privateAreas: areas };
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
