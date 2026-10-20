import { expect, spyOn, test } from "bun:test";
import { structuredUserProvenance } from "./structuredUserProvenanceClient";

test("the browser uses bounded same-origin POST and reports HTTP failures for retry", async () => {
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}, { status: 503 }));
  try {
    await expect(structuredUserProvenance([])).rejects.toThrow("unavailable");
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/structured-user/provenance");
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store", body: '{"refs":[]}' });
    fetch.mockResolvedValue(Response.json({}));
    expect(await structuredUserProvenance([])).toEqual({});
    fetch.mockResolvedValue(Response.json([]));
    await expect(structuredUserProvenance([])).rejects.toThrow("invalid provenance");
  } finally { fetch.mockRestore(); }
});
