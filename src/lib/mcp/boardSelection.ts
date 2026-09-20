import { Database, type SQLQueryBindings } from "bun:sqlite";
import { createHash } from "node:crypto";
import { canonicalProject, projectAliasSnapshot } from "@/lib/projects/aliases";
import { LIST_ANSWER_BYTES } from "./listAnswers";

type Metadata = { id: string; time: string; project: string; status: string; placement: string; hidden: number; text: string; links: string };
export type Source<T> = { filename: string; read: (id: string) => T | null; database?: Database | null };
export type BoardScope = { project: string; ids: string[]; query: string; updatedSince: string;
  statuses?: string[]; states?: string[]; placement?: string; openOnly?: boolean; includeClosed?: boolean };
export type ProjectSelection = { canonical: (project: string) => string; aliases: () => Record<string, string> };
const defaultProjects: ProjectSelection = { canonical: canonicalProject, aliases: () => projectAliasSnapshot().aliases };
const projections = new Map<string, BoardSelection>();

/** One process-local scalar index per durable collection. Bootstrap reads only
 * selection fields; later generations replay the indexed SQLite change journal.
 * Full records are fetched by primary key only for the delivered page. */
export class BoardSelection {
  private db = new Database(":memory:");
  private revision = -1;
  readonly work = { metadataRows: 0, recordReads: 0, rebuilds: 0 };
  constructor(private filename: string, private collection: "tasks" | "pipelines" | "flows", private projects: ProjectSelection = defaultProjects) {
    this.db.exec(`CREATE TABLE rows(id TEXT PRIMARY KEY, time TEXT, project TEXT, status TEXT, placement TEXT, hidden INTEGER, text TEXT);
      CREATE INDEX row_time ON rows(time DESC,id DESC);
      CREATE INDEX row_project ON rows(project,time DESC,id DESC);
      CREATE INDEX row_status ON rows(status,time DESC,id DESC);
      CREATE INDEX row_placement ON rows(placement,time DESC,id DESC);
      CREATE TABLE terms(term TEXT, id TEXT, PRIMARY KEY(term,id));
      CREATE INDEX terms_id ON terms(id);
      CREATE TABLE links(task TEXT, pipeline TEXT, PRIMARY KEY(task,pipeline));
      CREATE INDEX links_pipeline ON links(pipeline);`);
  }
  close() { this.db.close(); }
  private metadataSql() {
    const task = this.collection === "tasks";
    return `SELECT json_extract(value_json,'$.id') AS id,
      json_extract(value_json,'$.${task ? "updatedAt" : "createdAt"}') AS time,
      json_extract(value_json,'$.project') AS project,
      json_extract(value_json,'$.${task ? "status" : "state"}') AS status,
      CASE WHEN COALESCE(json_extract(value_json,'$.placement'),'pinned') = 'pinned' AND json_type(value_json,'$.pos.x') IN ('integer','real') AND json_type(value_json,'$.pos.y') IN ('integer','real') THEN 'pinned' ELSE 'unplaced' END AS placement,
      (json_extract(value_json,'$.${this.collection === "flows" ? "closedAt" : "hiddenAt"}') IS NOT NULL) AS hidden,
      ${this.collection === "flows" ? "''" : `json_extract(value_json,'$.${task ? "text" : "task"}')`} AS text,
      COALESCE(json_extract(value_json,'$.taskIds'),'[]') AS links
      FROM state_rows WHERE collection = ? ${task ? "AND row_key GLOB 't:*'" : ""}`;
  }
  private remove(id: string) {
    this.db.query("DELETE FROM rows WHERE id=?").run(id);
    this.db.query("DELETE FROM terms WHERE id=?").run(id);
    this.db.query("DELETE FROM links WHERE pipeline=?").run(id);
  }
  private put(row: Metadata) {
    this.work.metadataRows++;
    this.remove(row.id);
    this.db.query("INSERT INTO rows VALUES (?,?,?,?,?,?,?)").run(row.id, row.time, row.project, row.status, row.placement, row.hidden, row.text.toLowerCase());
    const add = this.db.query("INSERT OR IGNORE INTO terms VALUES (?,?)");
    for (const term of grams(row.text.toLowerCase())) add.run(term, row.id);
    if (this.collection === "pipelines") for (const task of JSON.parse(row.links) as string[]) {
      this.db.query("INSERT OR IGNORE INTO links VALUES (?,?)").run(task, row.id);
    }
  }
  sync(snapshot?: Database | null) {
    const source = snapshot ?? new Database(this.filename, { readonly: true });
    try {
      if (!snapshot) source.exec("BEGIN");
      const meta = source.query<{ revision: number; change_floor: number }, [string]>("SELECT revision,change_floor FROM state_collections WHERE collection=?").get(this.collection);
      if (!meta) throw new Error(`missing ${this.collection} collection`);
      if (meta.revision === this.revision) return;
      const reset = this.revision < 0 || this.revision > meta.revision || this.revision < meta.change_floor;
      const changes = reset ? [] : source.query<{ row_key: string }, [string, number, number]>(
        "SELECT DISTINCT row_key FROM state_changes WHERE collection=? AND revision>? AND revision<=?"
      ).all(this.collection, this.revision, meta.revision);
      this.db.transaction(() => {
        if (reset || !changes.length) {
          this.work.rebuilds++;
          this.db.exec("DELETE FROM rows; DELETE FROM terms; DELETE FROM links;");
          for (const row of source.query<Metadata, [string]>(this.metadataSql()).all(this.collection)) this.put(row);
        } else for (const { row_key } of changes) {
          if (this.collection === "tasks" && !row_key.startsWith("t:")) continue;
          const row = source.query<Metadata, [string, string]>(`${this.metadataSql()} AND row_key=?`).get(this.collection, row_key);
          if (row) this.put(row);
          else this.remove(this.collection === "tasks" ? row_key.slice(2) : row_key);
        }
      })();
      this.revision = meta.revision;
    } finally { if (!snapshot) source.close(); }
  }
  links(task: string): string[] {
    this.sync();
    return this.db.query<{ pipeline: string }, [string]>("SELECT pipeline FROM links WHERE task=? ORDER BY pipeline").all(task).map(row => row.pipeline);
  }
  page<T, Row>(source: Source<T>, scope: BoardScope, cursor: unknown, limit: number, project: (record: T) => Row) {
    const hash = createHash("sha256").update(JSON.stringify(scope)).digest("hex").slice(0, 16);
    let boundary: { id: string; time: string } | null = null, cursorReset = false;
    if (cursor) try {
      const decoded = JSON.parse(Buffer.from(String(cursor).slice(0, 2048), "base64url").toString());
      if (decoded.scope !== hash || typeof decoded.id !== "string" || typeof decoded.time !== "string") throw new Error("scope");
      boundary = decoded;
    } catch { cursorReset = true; }
    let candidates: Array<{ id: string; time: string }>, total: number, remaining: number;
    const keyed = new Map<string, T>();
    if (scope.ids.length) {
      // A cold one-id read never bootstraps or traverses the board index.
      candidates = [];
      for (const id of scope.ids) {
        this.work.recordReads++;
        const record = source.read(id);
        if (!record) continue;
        const row = record as Record<string, any>;
        const time = String(this.collection === "tasks" ? row.updatedAt : row.createdAt);
        if (!matches(row, scope, this.collection, this.projects.canonical)) continue;
        keyed.set(id, record); candidates.push({ id, time });
      }
      candidates.sort(compare);
      total = candidates.length;
      candidates = candidates.filter(row => !boundary || compare(row, boundary) > 0);
      remaining = candidates.length;
      candidates = candidates.slice(0, limit);
    } else {
      this.sync(source.database);
      const { where, values } = this.where(scope);
      total = this.db.query<{ n: number }, SQLQueryBindings[]>(`SELECT count(*) AS n FROM rows WHERE ${where}`).get(...values)!.n;
      const after = boundary ? " AND (time < ? OR (time = ? AND id < ?))" : "";
      const bindings: SQLQueryBindings[] = boundary ? [...values, boundary.time, boundary.time, boundary.id] : values;
      remaining = boundary ? this.db.query<{ n: number }, SQLQueryBindings[]>(`SELECT count(*) AS n FROM rows WHERE ${where}${after}`).get(...bindings)!.n : total;
      candidates = this.db.query<{ id: string; time: string }, SQLQueryBindings[]>(`SELECT id,time FROM rows WHERE ${where}${after} ORDER BY time DESC,id DESC LIMIT ?`).all(...bindings, limit);
    }
    const rows: Row[] = [];
    let bytes = 2, last: { id: string; time: string } | undefined;
    for (const candidate of candidates) {
      let record = keyed.get(candidate.id);
      if (!record) { this.work.recordReads++; record = source.read(candidate.id) ?? undefined; }
      if (!record) continue;
      const row = project(record), size = Buffer.byteLength(JSON.stringify(row)) + 1;
      if (rows.length && bytes + size > LIST_ANSWER_BYTES) break;
      rows.push(row); bytes += size; last = candidate;
    }
    const remainingCount = remaining - rows.length;
    return { rows, count: rows.length, total, remainingCount, hasMore: remainingCount > 0,
      nextCursor: remainingCount > 0 && last ? Buffer.from(JSON.stringify({ scope: hash, ...last })).toString("base64url") : null,
      omittedCount: total - rows.length, cursorReset };
  }
  private where(scope: BoardScope) {
    const clauses = ["1"], values: SQLQueryBindings[] = [];
    const set = (column: string, items: string[]) => {
      if (items.length) { clauses.push(`${column} IN (${items.map(() => "?").join(",")})`); values.push(...items); }
    };
    if (scope.project) set("project", [scope.project, ...Object.keys(this.projects.aliases()).filter(key => this.projects.canonical(key) === scope.project)]);
    set("status", scope.statuses ?? expandStates(scope.states ?? []));
    if (scope.placement) set("placement", [scope.placement]);
    if (scope.openOnly) clauses.push("status != 'done'");
    if (this.collection !== "tasks" && !scope.includeClosed) clauses.push("status != 'closed' AND hidden=0");
    if (scope.updatedSince) { clauses.push("time >= ?"); values.push(scope.updatedSince); }
    if (scope.query) {
      const terms = [...grams(scope.query, Math.min(3, scope.query.length))];
      // Pick the narrowest indexed posting; verify literal substring semantics.
      const term = terms.sort((a, b) => this.termCount(a) - this.termCount(b))[0]!;
      clauses.push("id IN (SELECT id FROM terms WHERE term=?) AND instr(text,?) > 0"); values.push(term, scope.query);
    }
    return { where: clauses.join(" AND "), values };
  }
  private termCount(term: string) { return this.db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM terms WHERE term=?").get(term)!.n; }
}
function grams(text: string, only?: number) {
  const result = new Set<string>();
  for (let n = only ?? 1; n <= (only ?? 3); n++) for (let i = 0; i + n <= text.length; i++) result.add(text.slice(i, i + n));
  return result;
}
function expandStates(states: string[]) { return [...new Set(states.flatMap(state => state === "open" ? ["draft", "provisioning", "running", "paused", "needs_decision"] : [state]))]; }
function matches(row: Record<string, any>, scope: BoardScope, collection: string, canonical: (project: string) => string) {
  const task = collection === "tasks", states = scope.statuses ?? expandStates(scope.states ?? []);
  return (!scope.project || canonical(row.project) === scope.project)
    && (!states.length || states.includes(task ? row.status : row.state))
    && (!scope.openOnly || row.status !== "done") && (!scope.placement || row.placement === scope.placement)
    && (task || scope.includeClosed || (row.state !== "closed" && !(collection === "flows" ? row.closedAt : row.hiddenAt)))
    && (!scope.updatedSince || (task ? row.updatedAt : row.createdAt) >= scope.updatedSince)
    && (!scope.query || (task ? row.text : row.task).toLowerCase().includes(scope.query));
}
function compare(a: { time: string; id: string }, b: { time: string; id: string }) { return a.time === b.time ? (a.id > b.id ? -1 : a.id === b.id ? 0 : 1) : a.time > b.time ? -1 : 1; }
export function boardSelection(filename: string, collection: "tasks" | "pipelines" | "flows") {
  const key = `${filename}:${collection}`;
  let projection = projections.get(key);
  if (!projection) { projection = new BoardSelection(filename, collection); projections.set(key, projection); }
  return projection;
}
