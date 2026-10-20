import { projectStoreSignature } from "@/lib/projects/persistence";
import fs from "node:fs";
import { repairLinkedTasks } from "./taskRepair";
import { statePath } from "@/lib/configDir";
import { storedLessonRevision } from "@/lib/memory/roleStore";
import { stateDatabaseSignature, readStateCollectionRevisions } from "@/lib/state/sqliteStateStore";
import { taskFeedSource } from "@/lib/tasks/store";
import { readLogPage, readScanPage, taskEligibilitySweepPending, type FeedFilter, type FeedFiles, type LogPage, type ScanPage, type Position } from "./taskFeed";

export type PageRequest = { kind: "scan"; after: string } | { kind: "log"; after: Position };
export type PageFilter = Omit<FeedFilter, "projects" | "files" | "validity" | "now"> & { projects: string[] };
export type PageBuildRequest = PageRequest & { filter: PageFilter; files?: FeedFiles; now?: number };
export type PageBuildResult = { page: LogPage | ScanPage; startRevision: number; privacyRevision: string; builds: number };

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_PAGES = 16;
/** One owner in the leased worker, across failed calls and peer cursors. No task
 * text is persisted. LRU eviction caps both entries and their encoded bytes. */
export class TaskPageBuilder {
  private pages = new Map<string, { page: LogPage | ScanPage; pageJson: string; bytes: number; until: number; at: number }>();
  private bytes = 0;
  private files: FeedFiles = [];
  private filesEpoch = 0;
  private filesKey = "[]";
  private revisions = new Map<string, { signature: string; value: unknown }>();
  private builds = 0;

  private revision(database: string): unknown {
    const stat = fs.statSync(database, { bigint: true, throwIfNoEntry: false });
    const signature = `${stat ? `${stat.dev}:${stat.ino}:${stat.ctimeNs}` : "absent"}:${stateDatabaseSignature(database)}`;
    const held = this.revisions.get(database);
    if (held?.signature === signature) return held.value;
    const value = [stat ? `${stat.dev}:${stat.ino}` : "absent",
      [...readStateCollectionRevisions(database, ["tasks", "task_tombstones", "task_export_omissions", "pipelines", "worktree_recovery"])]];
    // One installation, plus at most one explicit fixture task store.
    if (this.revisions.size >= 2) this.revisions.clear();
    this.revisions.set(database, { signature, value });
    return value;
  }

  build(request: PageBuildRequest): PageBuildResult & { pageJson: string } {
    if (request.files) {
      const key = JSON.stringify(request.files);
      if (key !== this.filesKey) {
        this.files = request.files; this.filesKey = key; this.filesEpoch++; this.pages.clear(); this.bytes = 0;
      }
    }
    const now = request.now ?? Date.now();
    repairLinkedTasks(request.filter.filePath);
    const privacyRevision = storedLessonRevision(); // A failed read never serves an old cache entry.
    const source = taskFeedSource(request.filter.filePath);
    const startRevision = source?.revision() ?? 0;
    const database = statePath("state.sqlite");
    const context = () => {
      const seat = fs.statSync(statePath("orchestrator-seats.json"), { bigint: true, throwIfNoEntry: false });
      return JSON.stringify([source?.revision(), this.revision(database),
      source && source.database !== database ? this.revision(source.database) : null, storedLessonRevision(),
      seat ? `${seat.dev}:${seat.ino}:${seat.size}:${seat.mtimeNs}:${seat.ctimeNs}` : "absent",
      projectStoreSignature("project-aliases.json")]);
    };
    const before = context();
    const key = JSON.stringify([request.kind, request.after, request.filter, this.filesEpoch, before]);
    const held = this.pages.get(key);
    const pending = () => request.kind === "log" && source !== null
      && taskEligibilitySweepPending(source.database, request.filter.self.id, request.filter.projects);
    if (held && now >= held.at && now < held.until && !pending()) {
      this.pages.delete(key); this.pages.set(key, held);
      return { page: held.page, pageJson: held.pageJson, startRevision, privacyRevision, builds: this.builds };
    }
    if (held) { this.pages.delete(key); this.bytes -= held.bytes; }
    const validity = { until: Infinity };
    const filter = { ...request.filter, projects: new Set(request.filter.projects), files: this.files, validity, now };
    const page = request.kind === "scan" ? readScanPage(request.after, filter) : readLogPage(request.after, filter);
    this.builds++;
    if (storedLessonRevision() !== privacyRevision) throw new Error("LESSON_PRIVACY_UNAVAILABLE");
    // Omission bookkeeping can change a revision during the read. Return the
    // correct page, but do not cache it under an observation it already moved.
    const pageJson = JSON.stringify(page);
    if (context() === before && !pending()) {
      const bytes = Buffer.byteLength(pageJson) * 2;
      while (this.pages.size && (this.pages.size >= MAX_PAGES || this.bytes + bytes > MAX_BYTES)) {
        const oldest = this.pages.keys().next().value!;
        this.bytes -= this.pages.get(oldest)!.bytes; this.pages.delete(oldest);
      }
      if (bytes <= MAX_BYTES) { this.pages.set(key, { page, pageJson, bytes, until: validity.until, at: now }); this.bytes += bytes; }
    }
    return { page, pageJson, startRevision, privacyRevision, builds: this.builds };
  }
}
