export const SEAT_AGENDA_VERSION_PREFIX = "seat-agenda:";

/** The two form writers already share state_rows. Project their waiting
 * rounds in the same transaction as the form, including after a restart. */
function waitingForm(row: "OLD" | "NEW"): string {
  const latest = `json_extract(${row}.value_json, '$.prototypeReviews[#-1]')`;
  return `CASE ${row}.collection
    WHEN 'seat-decisions' THEN CASE WHEN json_extract(${row}.value_json, '$.decision') IS NULL
      THEN ${row}.value_json END
    WHEN 'tasks' THEN CASE WHEN substr(${row}.row_key, 1, 2) = 't:'
      AND json_type(${row}.value_json, '$.prototypeReviews[#-1]') = 'object'
      AND json_extract(${latest}, '$.decision') IS NULL
      AND (json_extract(${row}.value_json, '$.status') IS NOT 'done'
        OR julianday(json_extract(${latest}, '$.createdAt')) >
          julianday(coalesce(json_extract(${row}.value_json, '$.doneAt'), json_extract(${row}.value_json, '$.updatedAt'))))
      THEN ${latest} END
    END`;
}

const current = waitingForm("NEW");
const previous = waitingForm("OLD");
const id = (form: string) => `json_extract((${form}), '$.id')`;
const reopenedEpisode = (form: string) => `CASE
  WHEN OLD.collection = 'tasks' AND json_extract(OLD.value_json, '$.status') = 'done'
    THEN ${id(form)} || ':' || coalesce(json_extract(OLD.value_json, '$.doneAt'), json_extract(OLD.value_json, '$.updatedAt'))
  ELSE ${id(form)} END`;
const insert = `INSERT INTO seat_agenda(id, kind, target, source_project, ref, task_id, text)
  SELECT 'legatus-question:' || ${id(current)}, 'legatus-question', '', json_extract(NEW.value_json, '$.project'),
    ${id(current)}, json_extract((${current}), '$.taskId'), ''
  WHERE ${id(current)} IS NOT NULL ON CONFLICT(id) DO NOTHING;`;
const insertUpdated = `INSERT INTO seat_agenda(id, kind, target, source_project, ref, task_id, text)
  SELECT 'legatus-question:' || ${reopenedEpisode(current)}, 'legatus-question', '', json_extract(NEW.value_json, '$.project'),
    ${id(current)}, json_extract((${current}), '$.taskId'), ''
  WHERE ${id(current)} IS NOT NULL ON CONFLICT(id) DO NOTHING;`;
const retire = `UPDATE seat_agenda SET pending = 0
  WHERE ref = ${id(previous)} AND kind = 'legatus-question' AND pending = 1`;

export const seatAgendaSchema = [
  `CREATE TABLE IF NOT EXISTS seat_agenda (
    seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, target TEXT NOT NULL,
    source_project TEXT NOT NULL, ref TEXT NOT NULL, task_id TEXT, text TEXT NOT NULL,
    sender TEXT, urgent INTEGER NOT NULL DEFAULT 0, pending INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE INDEX IF NOT EXISTS seat_agenda_pending ON seat_agenda(target, urgent DESC, seq) WHERE pending = 1`,
  `CREATE INDEX IF NOT EXISTS seat_agenda_pending_form_ref ON seat_agenda(ref, kind) WHERE pending = 1`,
  `CREATE TRIGGER IF NOT EXISTS seat_agenda_form_insert AFTER INSERT ON state_rows
    WHEN NEW.collection IN ('tasks', 'seat-decisions')
    BEGIN ${insert} END`,
  `CREATE TRIGGER IF NOT EXISTS seat_agenda_form_update_episode AFTER UPDATE OF value_json ON state_rows
    WHEN NEW.collection IN ('tasks', 'seat-decisions') AND ${id(previous)} IS NOT ${id(current)}
    BEGIN ${retire}; ${insertUpdated} END`,
  `CREATE TRIGGER IF NOT EXISTS seat_agenda_form_delete AFTER DELETE ON state_rows
    WHEN OLD.collection IN ('tasks', 'seat-decisions')
    BEGIN ${retire}; END`,
];
