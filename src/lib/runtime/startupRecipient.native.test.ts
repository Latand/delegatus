import { setDefaultTimeout, test } from "bun:test";
import { addressedRecipientCases, addressedRecipientSocket } from "./startupRecipient.fixture";

setDefaultTimeout(60_000);

for (const { phase, race } of addressedRecipientCases("live"))
  test.skipIf(process.platform === "win32")(`addressed live recovery delivers the original HTTP operation to its socket transcript before the ${phase} (${race})`,
    () => addressedRecipientSocket("live", phase, race));
