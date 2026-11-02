import { callingAttempt, handoffRecordedCheck, verifyLiveCustody } from "./service";
import { RecordedCheckObserver } from "./observer";
import { RecordedCheckStore } from "./store";
import { readEnvelope, writeEnvelope } from "./wire";

const input = readEnvelope(process.argv[2]!) as {
  mode: "prepare" | "recover"; conversation: string; log: string; request: string; id: string; ready: string;
};
if (input.mode === "prepare") {
  await handoffRecordedCheck(input.conversation, input.request, input.log, {
    binding: callingAttempt,
    verify(binding, descriptor, directory) {
      const proof = verifyLiveCustody(binding, descriptor, directory);
      writeEnvelope(input.ready, { id: descriptor.runId, deadline: descriptor.deadlineUptimeMs });
      process.kill(process.pid, "SIGSTOP");
      return proof;
    },
    observe: async () => {},
  });
} else {
  const observer = new RecordedCheckObserver({ active: () => true, recipient: () => null,
    deliver: async () => { throw new Error("unreserved completion must not send"); } });
  try {
    await observer.observe(input.id);
    const store = new RecordedCheckStore();
    try { writeEnvelope(input.ready, store.get(input.id)); } finally { store.close(); }
  } finally { observer.stop(); }
}
