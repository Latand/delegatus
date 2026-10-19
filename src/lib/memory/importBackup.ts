import fs from "node:fs/promises";
import path from "node:path";
import { writeJsonDurably } from "@/lib/state/durableJson";
import type { ImportManifest } from "./importTypes";

/** Validate every deletion path before deleting any file. Unknown directories
 * and extra files are never garbage: retention removes only manifest entries. */
export async function pruneMemoryBackups(parent: string): Promise<void> {
  const manifests: { directory: string; manifest: ImportManifest }[] = [];
  for (const entry of await fs.readdir(parent, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(parent, entry.name), file = path.join(directory, "manifest.json");
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024) throw Error("invalid memory backup manifest");
      const manifest = JSON.parse(await fs.readFile(file, "utf8")) as ImportManifest;
      if (manifest.schemaVersion !== 1 || manifest.importId !== entry.name || !Number.isFinite(Date.parse(manifest.createdAt)) || !Array.isArray(manifest.files)) throw Error("invalid memory backup manifest");
      manifests.push({ directory, manifest });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  manifests.sort((a, b) => b.manifest.createdAt.localeCompare(a.manifest.createdAt) || b.manifest.importId.localeCompare(a.manifest.importId));
  for (const { directory, manifest } of manifests.slice(5)) {
    const files: string[] = [], directories = new Set<string>();
    for (const entry of manifest.files) {
      if (typeof entry.copy !== "string" || path.isAbsolute(entry.copy) || entry.copy.split(/[\\/]/).some(part => !part || part === "." || part === "..") || !entry.copy.startsWith(`stores${path.sep}`)) throw Error("invalid memory backup path");
      const file = path.join(directory, entry.copy);
      for (let folder = path.dirname(file); folder !== directory; folder = path.dirname(folder)) {
        const stat = await fs.lstat(folder).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; });
        if (stat && !stat.isDirectory()) throw Error("invalid memory backup directory");
        directories.add(folder);
      }
      const stat = await fs.lstat(file).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; });
      if (stat && (!stat.isFile() || stat.nlink !== 1)) throw Error("invalid memory backup file");
      files.push(file);
    }
    for (const file of new Set(files)) await fs.unlink(file).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
    for (const folder of [...directories].sort((a, b) => b.length - a.length)) await fs.rmdir(folder).catch(error => { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; });
    await fs.unlink(path.join(directory, "manifest.json"));
    await fs.rmdir(directory).catch(error => { if (!["ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; });
  }
}

/** The caller runs outside the serving loop. Copies are flushed first, and a
 * durable manifest is the only record that makes a backup eligible to prune. */
export function commitImportManifest(directory: string, manifest: ImportManifest): void {
  writeJsonDurably(path.join(directory, "manifest.json"), manifest);
}
