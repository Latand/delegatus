import fs from "node:fs";
import { seatTickDecision, seatTickWakeCommit, seatTickWakeCommitPlan } from "./seatTick";
import { readSeatTickState, writeSeatTickState } from "./seatTickState";
import type { SeatTickCheckInput } from "./types";

const input = JSON.parse(fs.readFileSync(process.argv[2]!, "utf8")) as SeatTickCheckInput;
input.now = Number(process.argv[3]);
input.state = readSeatTickState(input.project);
const decision = seatTickDecision(input);
if (process.argv[4] === "deliver") {
  const commit = seatTickWakeCommitPlan(decision.verdict, { fingerprint: input.changeFingerprint, eventsThrough: 0 });
  if (!commit) throw new Error("expected a wake to deliver");
  writeSeatTickState(input.project, seatTickWakeCommit(decision.state, commit, input.now));
}
process.stdout.write(JSON.stringify({ kind: decision.verdict.kind,
  ids: decision.verdict.kind === "wake" ? decision.verdict.items.map(item => item.id) : [] }));
