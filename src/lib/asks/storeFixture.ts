import { operatorAsksCollectionForTests, operatorAsksFile } from "./store";

/*
 * Test fixtures for the asks store in `state.sqlite`: where a test removed or
 * spoiled `operator-asks.json`, it now clears or damages the stored rows.
 */

/** Remove every stored row: the store reads as a first run again. */
export function clearOperatorAsksForTests(file = operatorAsksFile()): void {
  operatorAsksCollectionForTests(file).replaceSync([]);
}

/** Make the store unreadable the way a torn file was: its meta row names no
    schema this release reads. Returns the restore. */
export function spoilOperatorAsksForTests(file = operatorAsksFile()): () => void {
  const collection = operatorAsksCollectionForTests(file);
  const meta = collection.get("meta");
  collection.patchSync(() => ({ records: [{ key: "meta", value: { schemaVersion: 0 } }] }));
  return () => {
    if (meta) collection.patchSync(() => ({ records: [meta] }));
    else collection.patchSync(() => ({ records: [], deleteKeys: ["meta"] }));
  };
}
