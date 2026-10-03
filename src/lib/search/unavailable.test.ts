import { expect, spyOn, test } from "bun:test";
import { searchUnavailable } from "./unavailable";

test("search failure diagnostics accept only known codes and withhold exception contents", async () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    const failure = Object.assign(new Error("private query and database location"), { code: "SQLITE_BUSY" });
    expect((await searchUnavailable("transcript", failure).json()).code).toBe("TRANSCRIPT_SEARCH_UNAVAILABLE");
    expect(log).toHaveBeenLastCalledWith("[search unavailable]", "transcript", "SQLITE_BUSY");
    searchUnavailable("memory", { code: "SQLITE_PRIVATE_VALUE", message: failure.message });
    expect(log).toHaveBeenLastCalledWith("[search unavailable]", "memory", "unexpected");
    searchUnavailable("memory", null);
    expect(log).toHaveBeenLastCalledWith("[search unavailable]", "memory", "unexpected");
    expect(JSON.stringify(log.mock.calls)).not.toContain("private");
    expect(JSON.stringify(log.mock.calls)).not.toContain("SQLITE_PRIVATE_VALUE");
  } finally {
    log.mockRestore();
  }
});
