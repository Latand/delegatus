// Expression indexes are installed under the state schema's writer fence.
// SQLite maintains them on import and for every writer of state_rows.
export const taskListFields = {
  project: "json_extract(value_json,'$.project')",
  status: "json_extract(value_json,'$.status')",
  time: "json_extract(value_json,'$.updatedAt')",
  id: "json_extract(value_json,'$.id')",
};
export const taskListPredicate = `collection='tasks' AND row_key GLOB 't:*' AND json_valid(value_json)
  AND json_type(value_json,'$.updatedAt')='text' AND json_type(value_json,'$.id')='text'`;
const { project, status, time, id } = taskListFields;
export const taskListIndex = { installation: "state_rows_task_list_v1", project: "state_rows_task_list_project_v1" };
const definitions = {
  [taskListIndex.installation]: `ON state_rows(${status},${time} DESC,${id} DESC,${project}) WHERE ${taskListPredicate}`,
  [taskListIndex.project]: `ON state_rows(${project},${status},${time} DESC,${id} DESC) WHERE ${taskListPredicate}`,
};
export const taskListIndexes = Object.entries(definitions).map(([name, definition]) => `CREATE INDEX IF NOT EXISTS ${name} ${definition}`);
export function taskListIndexCurrent(name: string, sql: string | undefined) {
  return sql === `CREATE INDEX ${name} ${definitions[name]}`;
}

export function taskListSeekSql(scoped: boolean, phase: "head" | "tied" | "older") {
  const index = scoped ? taskListIndex.project : taskListIndex.installation;
  const range = phase === "tied" ? `${time}=? AND ${id}<?`
    : phase === "older" ? `${time}<? AND ${time}>=?` : `${time}>=?`;
  // When time is fixed, ordering by both expressions creates a temp sort on
  // SQLite 3.45. Order by id alone to stop the seek at LIMIT within the tie.
  const order = phase === "tied" ? `${id} DESC` : `${time} DESC,${id} DESC`;
  return `SELECT ${id} AS id,${time} AS time,${project} AS project,${status} AS status
    FROM state_rows INDEXED BY ${index}
    WHERE ${taskListPredicate} ${scoped ? `AND ${project}=?` : ""} AND ${status}=? AND ${range}
    ORDER BY ${order} LIMIT ?`;
}
