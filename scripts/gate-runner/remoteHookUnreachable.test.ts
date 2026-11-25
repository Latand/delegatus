// Pre-push keeps its checks local while a legacy runner fails its probe.
// The reachable runner's cases are remoteHook.test.ts.
import { privacyParentCases } from "./remoteHook.fixture";

privacyParentCases(false);
