import { expect, test, harness, create, loadPipelines, savePipelines, tickPipelines } from "./engine.fixture";
import { withPipelineMutation } from "./store";

test("a controller evidence reply cannot overwrite a concurrent lane edit or trigger recovery", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const lane = loadPipelines()[0]!;
  const attempt = lane.runs[0]!.attempts[0]!;
  attempt.historical = true;
  lane.state = "paused";
  savePipelines([lane]);
  let entered!: () => void;
  let release!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const evidence = new Promise<void>(resolve => { release = resolve; });
  let reads = 0;
  h.ports.durableTurnEvidence = async () => {
    reads++;
    entered();
    await evidence;
    return { turn: "terminal", message: { text: '```json\n{"status":"pass"}\n```', ts: Date.now() } };
  };
  const callsBefore = [...h.calls];
  const tick = tickPipelines([], h.ports);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([reading, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("evidence read did not start")), 1000); })]);
    await withPipelineMutation((rows, persist) => {
      rows[0]!.stateDetail = "operator edit during evidence";
      persist([rows[0]!]);
    });
  } finally { if (timer) clearTimeout(timer); release(); await tick; }
  expect(reads).toBe(1);
  expect(loadPipelines()[0]).toMatchObject({ state: "paused", stateDetail: "operator edit during evidence" });
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.state).toBe("running");
  expect(h.calls).toEqual(callsBefore);
});
