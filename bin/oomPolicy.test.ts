import { expect, test } from "bun:test";
import { detectOomPolicyNotice, viewerServiceUnit } from "./oomPolicy.mjs";
test("only a user service with stop/kill policy needs the drop-in notice", () => {
  const cgroup = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/delegatus.service";
  expect(viewerServiceUnit(cgroup)).toBe("delegatus.service");
  expect(viewerServiceUnit("0::/system.slice/delegatus.service")).toBeNull();
  expect(viewerServiceUnit("0::/user.slice/user-1000.slice/user@1000.service/app.slice/terminal.scope")).toBeNull();
  for (const language of ["en", "uk"]) for (const policy of ["stop", "kill"]) {
    const notice = detectOomPolicyNotice(language, { platform: "linux", readCgroup: () => cgroup, policy: () => policy });
    expect(notice).toContain("OOMPolicy=continue");
    expect(notice).toContain("OOMScoreAdjust=100");
  }
  expect(detectOomPolicyNotice("en", { platform: "linux", readCgroup: () => cgroup, policy: () => "continue" })).toBeNull();
  expect(detectOomPolicyNotice("en", { platform: "linux", readCgroup: () => cgroup, policy: () => { throw new Error("unavailable"); } })).toBeNull();
});
