# Project setup recipes

Project setup is off by default. An operator can approve one command for a
project through `/api/projects/setup`. Agents can read the setting; the
existing operator-authority check refuses their preview, approval and disable
requests, including requests from an orchestrator.

The recipe has `command` (an executable and literal arguments) and `cwd` (a
repository-relative directory, `.` for the root). This first slice accepts a
direct repository script with `sh`, `bash`, `node`, `python3` or `bun`, or
`bun install --frozen-lockfile`. For example:

```json
{"command":["sh","scripts/setup.sh"],"cwd":"."}
```

Put shell expressions in the reviewed script. Package-manager script aliases,
inline shell expressions, absolute file arguments, traversal and symbolic links
are refused. Script and file arguments must be regular files of at most 1 MiB.
The command, working directory and contents of its file arguments
are hashed together. A frozen Bun install also pins its manifest and lockfile.
Approval covers those direct inputs; programs, downloads and scripts invoked
inside a script remain the operator's responsibility to review.

1. Send `POST /api/projects/setup` with `project`, `repoDir` (the project's
   checkout directory) and `recipe`. The response supplies the command, working
   directory, file contents and their combined `review.hash`. Nothing executes.
2. Review the returned content. Send the same fields with `PUT`, adding
   `reviewedHash` from that preview. The server recomputes the digest. A changed
   command or file returns `SETUP_REVIEW_REQUIRED` until a new preview is approved.
3. `GET` with `?project=` returns the approved setting. `PUT` with `project`
   and `recipe: null` disables it.

The pipeline reads this setting before its first builder, after the stage's CPU
admission and outside the controller mutation lease. Setup uses the work CPU
scope and the agent memory policy. It runs in the new pipeline checkout, with
private HOME, configuration, state and temporary directories. It receives no
account credentials. System tools are read-only; only the checkout and private
scratch are writable. Restricted stages also have isolated networking. This
initial runner requires Linux, Bubblewrap namespaces and Python 3; missing
isolation refuses execution and parks the stage. There is no host fallback.

Reviewed files are mounted from captured bytes, so replacing a script after
validation cannot change the command being executed. The start is checkpointed
before execution, with a three-minute execution limit and 64 KiB output limit.
The scope launcher dies with its parent; Bubblewrap ends detached descendants
with its PID namespace. Success, exit code, working directory and redacted output
are retained on the stage attempt. Each output stream is displayed up to 16,000
characters, with an ellipsis when shortened. Expand **Project setup** on the
stage or phone pipeline screen to inspect it.

A failure parks the stage before the builder starts. Inspect the output, repair
the environment, then use the existing **Retry stage** action. The failed
attempt keeps its evidence. Changed recipe content requires operator approval
before retry. An interrupted start also parks, because its effects may already
have happened; it never reruns automatically after a restart. Retry can repeat
setup effects, so scripts should tolerate repetition. After success, subsequent
builders and their retries reuse the prepared checkout. Enabling setup after a
builder has already started applies to future pipelines.

The existing publication dependency installation remains the publication gate.
Setup adds no workflow engine or stage kind.
