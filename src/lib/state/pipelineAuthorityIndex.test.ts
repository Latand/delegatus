import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initializeStateCollections, pipelineAuthorityRevision, readCompactPipelineEvidence } from "./sqliteStateStore";

const seed = {
  id: "owner", repoDir: "repository", worktreeDir: "checkout", branch: "lane", state: "running",
  delivery: { target: { repository: "repository", remote: "origin", branch: "refs/heads/lane" },
    active: true, ownerId: "owner", epoch: 1, publish: "enabled" },
};
const encode = JSON.stringify;
const duplicate = (key: string, first: unknown, last: unknown) => `{"${key}":${encode(first)},"${key}":${encode(last)}}`;
const withDelivery = (delivery: string) => `{${encode(seed).slice(1, -1)},"delivery":${delivery}}`;
const cases: Array<{ name: string; before: string; after: string }> = [];
for (const [field, value] of Object.entries(seed)) {
  if (field === "delivery") continue;
  const next = field === "state" ? "closed" : `${value}-changed`;
  cases.push({ name: `duplicate root ${field}`, before: `{${encode(seed).slice(1, -1)},"${field}":${encode(value)}}`,
    after: `{${encode(seed).slice(1, -1)},"${field}":${encode(next)}}` });
}
for (const [field, value] of Object.entries(seed.delivery)) {
  const next = field === "target" ? { ...seed.delivery.target, branch: "refs/heads/other" }
    : field === "active" ? false : field === "epoch" ? 2 : `${value}-changed`;
  const raw = (last: unknown) => encode({ ...seed, delivery: null }).replace('"delivery":null',
    `"delivery":{${encode(seed.delivery).slice(1, -1)},"${field}":${encode(last)}}`);
  cases.push({ name: `duplicate delivery ${field}`, before: raw(value), after: raw(next) });
}
cases.push(
  { name: "duplicate root delivery", before: withDelivery(encode(seed.delivery)),
    after: withDelivery(encode({ ...seed.delivery, target: { ...seed.delivery.target, branch: "refs/heads/other" } })) },
  { name: "escaped root member alias", before: String.raw`{"id":"first","\u0069d":"last"}`,
    after: String.raw`{"id":"first","\u0069d":"changed"}` },
  { name: "escaped delivery member alias", before: `{"delivery":${String.raw`{"target":{},"targ\u0065t":{"branch":"first"}}`}}`,
    after: `{"delivery":${String.raw`{"target":{},"targ\u0065t":{"branch":"changed"}}`}}` },
  { name: "escaped member spelling", before: String.raw`{"\u0069d":"first"}`, after: String.raw`{"\u0069d":"changed"}` },
  { name: "lone surrogate text", before: String.raw`{"branch":"\ud800"}`, after: String.raw`{"branch":"\ud801"}` },
  { name: "boolean versus integer", before: '{"delivery":{"active":true}}', after: '{"delivery":{"active":1}}' },
  { name: "distinct large integers", before: '{"delivery":{"epoch":9223372036854775808}}',
    after: '{"delivery":{"epoch":9223372036854775809}}' },
  { name: "duplicate terminal state", before: duplicate("state", "running", "running"), after: duplicate("state", "running", "closed") },
);

test.each(cases)("authority freshness sees $name through a raw connection", async ({ before, after }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "authority-index-"));
  const filename = path.join(root, "state.sqlite");
  try {
    initializeStateCollections(filename, ["pipelines", "pipelines_archive"].map(collection => ({ collection,
      schemaVersion: 1, migrationId: "one", key: (row: { id: string }) => row.id, loadRecords: () => [seed] })));
    const db = new Database(filename);
    try {
      const update = db.query("UPDATE state_rows SET value_json=? WHERE collection=? AND row_key='owner'");
      for (const collection of ["pipelines", "pipelines_archive"]) {
        update.run(before, collection);
        const revision = pipelineAuthorityRevision(filename);
        expect(revision).not.toBeNull();
        update.run(after, collection);
        expect(pipelineAuthorityRevision(filename)).not.toBe(revision);
        // Raw writer output is consumed by the real JSON reader, including
        // duplicate members and strings SQLite cannot losslessly decode.
        const evidence = await readCompactPipelineEvidence(filename, undefined, row => row);
        expect(evidence!.rows.get(encode([collection, "owner"]))!.value).toEqual(JSON.parse(after));
      }
    } finally { db.close(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("unambiguous progress stays fresh while ambiguous no-op writes invalidate", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "authority-progress-"));
  const filename = path.join(root, "state.sqlite");
  try {
    initializeStateCollections(filename, ["pipelines", "pipelines_archive"].map(collection => ({ collection,
      schemaVersion: 1, migrationId: "one", key: (row: { id: string }) => row.id, loadRecords: () => [seed] })));
    const db = new Database(filename);
    try {
      const update = db.query("UPDATE state_rows SET value_json=? WHERE collection='pipelines' AND row_key='owner'");
      const revision = pipelineAuthorityRevision(filename);
      update.run(encode({ ...seed, state: "paused", stateDetail: "progress", delivery: { ...seed.delivery,
        operation: { state: "pending" } } }));
      expect(pipelineAuthorityRevision(filename)).toBe(revision);
      db.exec("UPDATE state_rows SET value_json=value_json WHERE collection='pipelines'");
      expect(pipelineAuthorityRevision(filename)).toBe(revision);
      for (const raw of [duplicate("id", "owner", "owner"), String.raw`{"\u0069d":"owner"}`, "{broken"]) {
        update.run(raw);
        const ambiguous = pipelineAuthorityRevision(filename);
        update.run(raw);
        expect(pipelineAuthorityRevision(filename)).not.toBe(ambiguous);
      }
    } finally { db.close(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
