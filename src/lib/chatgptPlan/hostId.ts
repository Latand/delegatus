import { randomUUID } from "node:crypto";
import { object } from "./constants";
import { PlanError } from "./errors";
import type { PlanStore } from "./store";

export async function hostId(store: PlanStore): Promise<string> {
  return store.transaction("host", async () => {
    const raw = await store.read("host");
    if (raw === undefined) {
      if (await store.credentials()) throw new PlanError("host_file");
      const id = `urn:uuid:${randomUUID()}`;
      store.write("host", { version: 1, id });
      return id;
    }
    const value = object(raw);
    if (value?.version !== 1 || typeof value.id !== "string"
      || !/^urn:uuid:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.id)) throw new PlanError("host_file");
    return value.id;
  });
}
