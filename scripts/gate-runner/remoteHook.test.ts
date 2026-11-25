// Pre-push keeps its checks local while a legacy runner answers its probe.
// The unreachable runner's cases are remoteHookUnreachable.test.ts.
import { privacyParentCases } from "./remoteHook.fixture";

privacyParentCases(true);
