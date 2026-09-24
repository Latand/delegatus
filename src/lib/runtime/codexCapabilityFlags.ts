/**
 * What a Codex host advertises in its `activeFlags` about the app-server it
 * holds (#1560, #1636). Each is set by `CodexAppServerHost.state()` from the
 * app-server's negotiated capabilities, stays for the host's whole life, and is
 * read by the delivery controller to decide which composer actions to offer.
 * None says the host is doing anything, which is why the retirement predicate
 * classifies them with the other advertisements (#2137).
 *
 * A leaf module so the classifier can name them without importing the host.
 */

/** The app-server owns a native pending-input queue for this thread. */
export const NATIVE_QUEUE_CAPABILITY = "native-queue";

/** The observed capability flag that lets the composer offer the injection
    action (#1560). Absent = the action is not offered at all. */
export const NATIVE_INJECT_CAPABILITY = "native-inject";

/** The app-server publishes a model catalogue, so the composer can offer
    per-turn model and effort settings. */
export const NATIVE_TURN_PROFILE_CAPABILITY = "native-turn-profile";
