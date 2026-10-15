import { expect, test } from "bun:test";

import type { RuntimeHostClient } from "./client";
import { publishFilesRevision } from "./filesRevision";

test("serializes materialization bumps so concurrent transcripts receive distinct revisions", async () => {
  let filesRevision = 11;
  const published: number[] = [];
  const client = {
    snapshot: async () => ({ filesRevision }),
    append: async (event: { payload: { filesRevision: number } }) => {
      await Promise.resolve();
      filesRevision = event.payload.filesRevision;
      published.push(filesRevision);
    },
  } as unknown as RuntimeHostClient;

  await Promise.all([
    publishFilesRevision(client),
    publishFilesRevision(client),
  ]);

  expect(published).toEqual([12, 13]);
});

test("materialization reads only the scalar when the client supports it", async () => {
  let revision = 11;
  const client = {
    filesRevision: async () => revision,
    snapshot: async () => { throw new Error("population read is unnecessary"); },
    append: async (event: { payload: { filesRevision: number } }) => { revision = event.payload.filesRevision; },
  } as unknown as RuntimeHostClient;
  await Promise.all([publishFilesRevision(client), publishFilesRevision(client)]);
  expect(revision).toBe(13);
});

test("the runtime host serves files revision without constructing a snapshot", async () => {
  const { RuntimeJournal } = await import("@/runtime-host/journal");
  const { RuntimeHost } = await import("@/runtime-host/host");
  const journal = new RuntimeJournal(":memory:");
  try {
    journal.append({ scope: { type: "system", id: "files" }, kind: "files.revision", payload: { filesRevision: 17 } });
    journal.snapshotJson = () => { throw new Error("population read is unnecessary"); };
    const host = new RuntimeHost(journal);
    expect(await host.handle({ id: "synthetic-request", method: "files-revision" })).toEqual({ id: "synthetic-request", ok: true, result: 17 });
  } finally { journal.close(); }
});
