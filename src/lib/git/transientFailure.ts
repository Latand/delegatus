/* One classifier for the Git and network failures that say nothing about the
   work itself, shared by the pipeline controller and the deployment adapter
   (#1692, #2115, #2176, #2220). It imports nothing, so a script that must not
   resolve state can load it.

   Classification is narrow on purpose: a refused login, a missing repository
   or branch, and anything unrecognized are never transient, so a real error
   fails on its first sighting exactly as it did before. */

/* Checked first: an SSH login the server refused can also print "Connection
   closed by …", and that is a credential problem no retry fixes. */
const REFUSED = /permission denied|authentication failed|host key verification failed|could not read (username|password)|repository not found|does not appear to be a git repository|returned error: 40[134]|couldn't find remote ref|invalid username or (password|token)/i;

/* Name resolution, the most common transient of all (#2220): curl's and ssh's
   wording, the resolver's own, and Go's (Docker's registry client). */
const DNS = /could not resolve host(?:name)?:?\s*([^\s:'",]+)|temporary failure in name resolution|name or service not known|lookup ([^\s:]+)(?: on [^\s]+)?: no such host|\b(?:enotfound|eai_again)\b/i;

/* A connection that failed below the protocol. */
const CONNECT = /connection refused|connection reset|connection closed by|network is unreachable|no route to host|failed to connect to|returned error: 5\d\d|tls handshake timeout|i\/o timeout/i;

/* A bare "timed out" — how a bounded Git read reports the network that never
   answered (#1692). Too broad for a whole image build, whose own steps can
   print it, so {@link connectionFailure} leaves it out. */
const TIMED_OUT = /timed out/i;

/* Another Git process holding a lock for a moment (#2115). Only the wording
   Git uses for a lock that EXISTS: "cannot lock ref" also covers a D/F
   conflict ("'refs/heads/a' exists; cannot create 'refs/heads/a/b'") and an
   existing reference, which are real and stay out. */
const LOCK = /unable to create '[^']*\.lock': file exists|cannot lock ref '[^']*': is at [0-9a-f]+ but expected [0-9a-f]+/i;

/* A Git child the provisioning bound killed under load (#2176). */
const BOUND = /checkout interrupted or timed out after \d+s|git command timed out after \d+s/i;

export type TransientGitFailure = "dns" | "network" | "lock" | "timeout";

export function transientGitFailure(error: string): TransientGitFailure | null {
  if (REFUSED.test(error)) return null;
  if (DNS.test(error)) return "dns";
  if (LOCK.test(error)) return "lock";
  if (BOUND.test(error)) return "timeout";
  if (CONNECT.test(error) || TIMED_OUT.test(error)) return "network";
  return null;
}

/** Only name resolution and connection failures: the classes a whole image
    build or package install may be retried for (#2220). */
export function connectionFailure(error: string): "dns" | "network" | null {
  if (REFUSED.test(error)) return null;
  if (DNS.test(error)) return "dns";
  return CONNECT.test(error) ? "network" : null;
}

/** Whether a failed remote read is one the network failed (#1692): it says
    nothing about the branch, so asking again is sound. */
export function networkFailureIsTransient(error: string): boolean {
  const kind = transientGitFailure(error);
  return kind === "dns" || kind === "network" || kind === "timeout";
}

/** The host a DNS failure names, when it names one. */
function unresolvedHost(error: string): string | null {
  const match = DNS.exec(error);
  return match?.[1] ?? match?.[2] ?? null;
}

/** One phrase for the cause, naming the host a DNS failure could not
    resolve, and the action that fixes it. */
export function describeTransientGitFailure(kind: TransientGitFailure, error: string): { cause: string; fix: string } {
  if (kind === "dns") {
    const host = unresolvedHost(error);
    return {
      cause: host ? `DNS lookup of ${host} failed` : "a DNS lookup failed",
      fix: "once the network resolves the host",
    };
  }
  if (kind === "network") return { cause: "the network connection failed", fix: "once the remote answers" };
  if (kind === "lock") {
    return {
      cause: "a Git lock was held by another process",
      fix: "once the other Git process finishes (if none is running, remove the .lock file the error names)",
    };
  }
  return { cause: "Git did not finish inside its bound under host load", fix: "once the host is less loaded" };
}

/** A bounded, in-process retry of one network step, for a process with no
    controller tick to wait between (the deployment adapter). Non-transient
    errors propagate unchanged on their first sighting; the last transient one
    is rethrown naming its cause, the attempts it took and the fix. */
export async function retryTransientNetwork<T>(
  operation: () => Promise<T>,
  options: {
    /** Waits before the second, third, … attempt; its length + 1 is the attempt count. */
    backoffMs: readonly number[];
    sleep?: (ms: number) => Promise<void>;
    onRetry?: (detail: string) => void;
    /** What the operator does once the cause clears, e.g. "retry the deploy". */
    action: string;
    /** Which failures count; the Git classes by default. */
    classify?: (error: string) => TransientGitFailure | null;
  },
): Promise<T> {
  const classify = options.classify ?? ((error: string) => {
    const kind = transientGitFailure(error);
    return kind === "lock" ? null : kind;
  });
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const kind = classify(message);
      if (!kind) throw error;
      const { cause, fix } = describeTransientGitFailure(kind, message);
      const delay = options.backoffMs[attempt];
      if (delay === undefined) {
        throw new Error(`${cause} on ${attempt + 1} attempts; ${options.action} ${fix}: ${message}`, { cause: error });
      }
      options.onRetry?.(`${cause}; retrying (${attempt + 2}/${options.backoffMs.length + 1}) in ${Math.round(delay / 1_000)}s`);
      await sleep(delay);
    }
  }
}
