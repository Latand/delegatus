import { expect, test, fixture } from "./stageAttemptPush.fixture";

// The real 260-commit boundary gets its own owned file runner. Keep a minute
// for fixture setup and cleanup within the gate's five-minute file limit.


test("B: every commit remains provable beyond the former 256 limit", async () => {
  const f = await fixture();
  try {
    let head = ""; for (let i = 0; i < 260; i++) head = await f.commit(`own ${i}`);
    await f.push(); expect(await f.settle()).toEqual({ ok: true, sha: head });
  } finally { await f.close(); }
}, 240_000);
