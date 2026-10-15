/* Isolated performance fixtures only. Compile as a SQLite loadable extension.
 * No busy handler is installed: xSleep delegates to the runtime's original VFS
 * method, preserving its retry policy, including waits that later succeed.
 * SQLITE_OK_LOAD_PERMANENTLY keeps that function pointer valid after close. */
#include "sqlite3ext.h"
SQLITE_EXTENSION_INIT1
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

typedef struct {
  sqlite3 *db;
  int id, pending, explicit_transaction;
  sqlite3_int64 changes;
  char *name;
  int kinds;
  void *active_statement;
  int row_profiled;
  char collection[128];
} Connection;
static FILE *output;
static int next_id;
static __thread Connection *running;
static __thread char call_key[160], collection_key[128];
static int (*original_sleep)(sqlite3_vfs *, int);

/* Synchronous SQLite calls execute on this thread. The preload carries the
 * SDK callback's async context into native events without querying SQLite. */
void delegatus_observer_context(const char *call, const char *collection) {
  snprintf(call_key, sizeof(call_key), "%s", call ? call : "");
  snprintf(collection_key, sizeof(collection_key), "%s", collection ? collection : "");
}

static long long nanos(void) {
  struct timespec value;
  clock_gettime(CLOCK_MONOTONIC, &value);
  return (long long)value.tv_sec * 1000000000 + value.tv_nsec;
}
static void quoted(const char *value) {
  fputc('"', output);
  for (; value && *value; value++) {
    unsigned char c = *value;
    if (c == '"' || c == '\\') { fputc('\\', output); fputc(c, output); }
    else if (c < 32) fprintf(output, "\\u%04x", c);
    else fputc(c, output);
  }
  fputc('"', output);
}
static void event(Connection *c, const char *kind, long long value, const char *sql) {
  if (!output) return;
  fprintf(output, "{\"pid\":%d,\"connection\":%d,\"database\":", getpid(), c ? c->id : 0);
  quoted(c ? c->name : "none");
  fputs(",\"call\":", output); quoted(call_key);
  fputs(",\"collection\":", output); quoted(collection_key[0] ? collection_key : c ? c->collection : "");
  struct timespec wall;
  clock_gettime(CLOCK_REALTIME, &wall);
  fprintf(output, ",\"atNs\":%lld,\"atMs\":%lld,\"event\":\"%s\",\"value\":%lld", nanos(),
    (long long)wall.tv_sec * 1000 + wall.tv_nsec / 1000000, kind, value);
  if (sql) { fputs(",\"sql\":", output); quoted(sql); }
  fputs("}\n", output);
  fflush(output);
}
static int observed_sleep(sqlite3_vfs *vfs, int micros) {
  long long start = nanos();
  int result = original_sleep(vfs, micros);
  event(running, "sqlite-sleep-ns", nanos() - start, NULL);
  return result;
}
static int committing(void *argument) {
  ((Connection *)argument)->pending++;
  return 0;
}
static void rollback(void *argument) {
  Connection *c = argument;
  c->pending = 0;
  c->explicit_transaction = 0;
  c->kinds = 0; c->collection[0] = 0;
  c->changes = sqlite3_total_changes64(c->db);
  event(c, "rollback", 1, NULL);
}
static const char *trim(const char *sql) {
  if (!sql) return "";
  while (*sql == ' ' || *sql == '\n' || *sql == '\r' || *sql == '\t') sql++;
  return sql;
}
static int trace(unsigned type, void *argument, void *statement, void *detail) {
  (void)detail;
  Connection *c = argument;
  if (type == SQLITE_TRACE_STMT) {
    running = c;
    c->active_statement = statement;
    c->row_profiled = 0;
    const char *sql = trim(sqlite3_sql(statement));
    if (collection_key[0]) snprintf(c->collection, sizeof(c->collection), "%s", collection_key);
    if (!sqlite3_stmt_readonly(statement)) {
      if (!sqlite3_strnicmp(sql, "CREATE", 6) || !sqlite3_strnicmp(sql, "ALTER", 5) || !sqlite3_strnicmp(sql, "DROP", 4)) c->kinds |= 1;
      else if (strstr(sql, "state_leases") && !sqlite3_strnicmp(sql, "INSERT", 6)) c->kinds |= 2;
      else if (strstr(sql, "state_leases") && !sqlite3_strnicmp(sql, "DELETE", 6)) c->kinds |= 8;
      else if (strstr(sql, "state_rows") || strstr(sql, "state_changes") || strstr(sql, "state_collections")) c->kinds |= 4;
      else if (strstr(sql, "mcp_receipts")) c->kinds |= 16;
      else if (sqlite3_strnicmp(sql, "BEGIN", 5) && sqlite3_strnicmp(sql, "COMMIT", 6) && sqlite3_strnicmp(sql, "ROLLBACK", 8)) c->kinds |= 32;
    }
    if (!sqlite3_strnicmp(sql, "BEGIN", 5)) event(c, "begin-attempt", 1, NULL);
    if (!sqlite3_strnicmp(sql, "COMMIT", 6)) event(c, "commit-attempt", 1, NULL);
    if (sqlite3_get_autocommit(c->db) && !sqlite3_stmt_readonly(statement)
        && sqlite3_strnicmp(sql, "BEGIN", 5) && sqlite3_strnicmp(sql, "COMMIT", 6))
      event(c, "autocommit-statement-attempt", 1, NULL);
  }
  if (type == SQLITE_TRACE_PROFILE) {
    const char *sql = trim(sqlite3_sql(statement));
    int code = sqlite3_errcode(c->db);
    if (!sqlite3_strnicmp(sql, "BEGIN", 5) && !sqlite3_get_autocommit(c->db)) {
      c->explicit_transaction = 1;
      c->changes = sqlite3_total_changes64(c->db);
      event(c, "begin", 1, NULL);
    }
    /* Synthetic rows only. Save successful row statements before the commit
     * marker so teardown can reconcile effects even when a caller lost its
     * reply. Rolled-back transactions are discarded by the report. */
    if (c->active_statement == statement && !c->row_profiled
        && (code == SQLITE_OK || code == SQLITE_DONE || code == SQLITE_ROW)
        && sqlite3_changes64(c->db) > 0
        && (!sqlite3_strnicmp(sql, "INSERT INTO state_rows", 22)
            || !sqlite3_strnicmp(sql, "UPDATE state_rows", 17)
            || !sqlite3_strnicmp(sql, "DELETE FROM state_rows", 22))) {
      char *expanded = sqlite3_expanded_sql(statement);
      event(c, "domain-statement", sqlite3_changes64(c->db), expanded);
      sqlite3_free(expanded);
      c->row_profiled = 1;
    }
    /* A failed commit invokes rollback_hook, clearing pending. An explicit
     * empty transaction has no commit hook; its autocommit transition counts. */
    if (sqlite3_get_autocommit(c->db) && (code == SQLITE_OK || code == SQLITE_DONE || code == SQLITE_ROW)
        && (c->pending || (c->explicit_transaction && !sqlite3_strnicmp(sql, "COMMIT", 6)))) {
      event(c, "commit", c->pending ? c->pending : 1, NULL);
      event(c, "commit-kinds", c->kinds, NULL);
      event(c, "committed-changes", sqlite3_total_changes64(c->db) - c->changes, NULL);
      c->changes = sqlite3_total_changes64(c->db);
      c->pending = 0;
      c->explicit_transaction = 0;
      c->kinds = 0; c->collection[0] = 0;
    }
    if (strstr(sql, "state_leases")) {
      char *expanded = sqlite3_expanded_sql(statement);
      event(c, "lease-statement", sqlite3_changes64(c->db), expanded);
      sqlite3_free(expanded);
    }
    if (code == SQLITE_BUSY || code == SQLITE_LOCKED) event(c, "sqlite-contention", code, NULL);
    running = NULL;
  }
  if (type == SQLITE_TRACE_CLOSE) {
    event(c, "close-request", 1, NULL);
    if (running == c) running = NULL;
  }
  return 0;
}
/* close_v2 can leave outstanding statements on a zombie connection. Its
 * CLOSE trace precedes their finalization. The function destructor runs when
 * SQLite actually destroys the connection, after those statements finish. */
static void destroyed(void *argument) {
  Connection *c = argument;
  event(c, "close", 1, NULL);
  free(c->name);
  free(c);
}
static void marker(sqlite3_context *context, int count, sqlite3_value **values) {
  (void)count; (void)values;
  sqlite3_result_null(context);
}
int sqlite3_observer_init(sqlite3 *db, char **error, const sqlite3_api_routines *api) {
  (void)error;
  SQLITE_EXTENSION_INIT2(api);
  if (!output) {
    const char *file = getenv("MCP_SQL_EVENTS");
    if (!file || !(output = fopen(file, "a"))) return SQLITE_ERROR;
  }
  sqlite3_vfs *vfs = sqlite3_vfs_find(NULL);
  if (!original_sleep) { original_sleep = vfs->xSleep; vfs->xSleep = observed_sleep; }
  Connection *c = calloc(1, sizeof(Connection));
  if (!c) return SQLITE_NOMEM;
  c->db = db; c->id = ++next_id;
  const char *file = sqlite3_db_filename(db, "main");
  c->name = strdup(file && strrchr(file, '/') ? strrchr(file, '/') + 1 : "memory");
  c->changes = sqlite3_total_changes64(db);
  int registered = sqlite3_create_function_v2(db, "delegatus_observer_context", 0, SQLITE_UTF8,
    c, marker, NULL, NULL, destroyed);
  if (registered != SQLITE_OK) return registered;
  event(c, "open", sqlite3_db_readonly(db, "main"), NULL);
  sqlite3_commit_hook(db, committing, c);
  sqlite3_rollback_hook(db, rollback, c);
  sqlite3_trace_v2(db, SQLITE_TRACE_STMT | SQLITE_TRACE_PROFILE | SQLITE_TRACE_CLOSE, trace, c);
  return SQLITE_OK_LOAD_PERMANENTLY;
}
