import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { RuntimeJournal } from "./journal";

test("a consumer holding the retention anchor prevents history scans on every append", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "journal-consumer-retention-"));
  const filename = path.join(directory, "events.sqlite");
  const journal = new RuntimeJournal(filename, { maxEvents: 2 });
  journal.registerConsumer("orchestration");
  const append = (id: number) => journal.append({
    scope: "system:fixture", kind: "fixture.history", payload: { id },
  });
  const events = Array.from({ length: 240 }, (_, index) => append(index));
  const query = spyOn(Database.prototype, "query");
  try {
    const tail = Array.from({ length: 8 }, (_, index) => append(240 + index));
    // Count and OFFSET walk retained history even when no prefix is eligible.
    const historyScans = query.mock.calls.filter(([sql]) => /COUNT\(\*\).*FROM events|FROM events ORDER BY seq LIMIT 1 OFFSET/i.test(sql));
    expect(historyScans).toHaveLength(0);
    query.mockRestore();
    expect(journal.unconsumedEvents("orchestration")[0]?.eventId).toBe(events[0]!.eventId);
    journal.markConsumerCompleted(events[0]!.eventId, "orchestration");
    journal.compact();
    expect(journal.unconsumedEvents("orchestration")[0]?.eventId).toBe(events[1]!.eventId);
    const db = new Database(filename, { readonly: true });
    try {
      expect(db.query<{ seq: number }, []>("SELECT MIN(seq) AS seq FROM events").get()?.seq).toBe(events[1]!.seq);
    } finally { db.close(); }
    for (const event of [...events.slice(1), ...tail]) journal.markConsumerCompleted(event.eventId, "orchestration");
    journal.compact();
    expect(journal.unconsumedEvents("orchestration")).toEqual([]);
    journal.close();
    const reopened = new RuntimeJournal(filename, { maxEvents: 2 });
    try {
      expect(reopened.isWritable()).toBe(true);
      const db = new Database(filename, { readonly: true });
      try {
        expect(db.query<{ seq: number }, []>("SELECT seq FROM events ORDER BY seq").all().map((row) => row.seq))
          .toEqual(tail.slice(-2).map((event) => event.seq));
      } finally { db.close(); }
    } finally { reopened.close(); }
  } finally {
    query.mockRestore();
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
