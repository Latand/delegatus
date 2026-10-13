import { expect, test } from "bun:test";
import { relayRequestDeadline } from "./deadline";
import { enterRelayHold, leaveRelayHold, olderCapacityWaiter, capacityWaiters } from "./hold";

test("capacity order follows fixed deadlines, with insertion order for ties and independent busy causes", async () => {
  const deadline = relayRequestDeadline({}, 1000);
  const later = relayRequestDeadline({}, 2000);
  const release = async () => {};
  const base = { relayId: "ordering", targetId: "target", release };
  try {
    enterRelayHold({ ...base, requestId: "later", cause: "capacity", deadline: later });
    expect(olderCapacityWaiter(base.relayId, base.targetId, "earlier", deadline)).toBe(false);
    enterRelayHold({ ...base, requestId: "earlier", cause: "capacity", deadline });
    expect(olderCapacityWaiter(base.relayId, base.targetId, "later", later)).toBe(true);
    expect(olderCapacityWaiter(base.relayId, base.targetId, "tie", deadline)).toBe(true);
    enterRelayHold({ ...base, requestId: "tie", cause: "capacity", deadline });
    expect(olderCapacityWaiter(base.relayId, base.targetId, "earlier", deadline)).toBe(false);
    leaveRelayHold("earlier");
    expect(olderCapacityWaiter(base.relayId, base.targetId, "tie", deadline)).toBe(false);
    enterRelayHold({ ...base, requestId: "tie", cause: "chat", deadline });
    enterRelayHold({ ...base, requestId: "drain", cause: "drain", deadline });
    expect(capacityWaiters(base.relayId, base.targetId)).toBe(1);
    expect(olderCapacityWaiter(base.relayId, "neighbor", "new", later)).toBe(false);
    const copy = await import("./hold.ts?ordering-copy");
    expect(copy.capacityWaiters(base.relayId, base.targetId)).toBe(1);
  } finally { for (const id of ["earlier", "later", "tie", "drain"]) leaveRelayHold(id); }
});
