# Publication checks and credential lifetime

Native Git authenticates discovery before invoking `pre-push`. It retains the
discovered password for the final HTTP RPC. An App token can therefore expire
while a successful hook waits for CPU admission or runs checks.

For repositories using `scripts/local-gate.ts`, the pipeline publisher runs
`pre-push --publication-prepare` before starting authenticated write discovery.
This runs the existing privacy and admitted check plan. The ordinary Git push
then invokes the repository's native hook, which consumes a receipt and makes
a fresh privacy observation. Transport has a separate one-minute bound. The
App credential helper still mints and verifies a repository-scoped credential
when Git requests it; credentials remain in process memory.

The handoff binds the publication operation, owner epoch, controller custody
fence, accepted head, destination ref and observed remote head. Its input
digest includes the exact check plan, head, tree, merge base, branch, gate
tooling, installed dependencies, ignored source inputs, check environment,
host epoch, effective Git configuration and privacy sources. The native hook
checks Git's actual pushed head and destination. Changed inputs refuse the
handoff. A receipt expires after one minute and is claimed by atomic rename
before validation; a failed hook cannot reuse it.

Independent step passes retain their exact fingerprints. Their validation
happens before CPU admission, so an entirely reusable check plan needs no
second admission. Privacy, frozen installation and supply-chain observations
remain fresh for each publication operation. The native hook repeats privacy
after credential acquisition. Publication custody never reaches check children.

The publisher's existing lock, cancellation watcher, authority checks and
remote reconciliation remain responsible for ownership and exactly-once
effects. A stopped check phase begins no write. A stopped transport retains
an uncertain result, and a fresh controller reconciles the remote before any
new publication. HTTP 401 remains a refusal, with no automatic authentication
retry or successful-publication claim. Older gate tooling that emits no
receipt refuses before transport and requires a compatible gate update.

`scripts/local-gate.publication.test.ts` drives native Git against an isolated
smart HTTP server backed by `git http-backend`. Its logical credential clock
advances during the expensive check. Direct Git discovery obtains the
credential first, the check advances beyond its lifetime, and RPC receives
401 without creating a remote ref. The pipeline path records checks, then
mint, then one accepted RPC. Additional cases change custody and check inputs,
refuse authentication and recover a lost reply through a fresh process.
