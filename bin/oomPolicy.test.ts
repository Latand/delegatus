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

for (const unit of ["delegatus@review.service", "delegatus@review\\x2dcase.service", "delegatus\\x20viewer.service"]) test(`user service ${unit} reads policy and emits the drop-in notice`, () => {
  const cgroup = `0::/user.slice/user-1000.slice/user@1000.service/app.slice/${unit}`;
  expect(viewerServiceUnit(cgroup)).toBe(unit);
  for (const language of ["en", "uk"]) for (const policy of ["stop", "kill"]) {
    const policyReads: string[] = [];
    const notice = detectOomPolicyNotice(language, { platform: "linux", readCgroup: () => cgroup,
      policy: (name: string) => { policyReads.push(name); return policy; } });
    expect(policyReads).toEqual([unit]);
    expect(notice).toContain("OOMPolicy=continue");
    expect(notice).toContain(`${unit}.d/oom.conf`);
    expect(notice).toContain(`systemctl --user restart '${unit}'`);
  }
});
