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
The command, working directory, resolved interpreter location and contents of
its file arguments are hashed together. A frozen Bun install also pins its manifest, lockfile and
`.npmrc` (including an absent configuration). Installs require the repository
root; workspace, patched dependency and local dependency installs (including
local overrides and resolutions) are refused in this slice. Use a reviewed
direct script for those.
Python runs in isolated mode, which excludes checkout module shadows. Bun uses
an empty explicit configuration and disables automatic `.env` loading. Direct
Bun scripts also use an empty TypeScript configuration, so checkout preloads,
import aliases and JSX runtime overrides cannot execute implicitly.
Direct scripts launch by their resolved file paths, including
files whose names match an interpreter's built-in commands.
Interpreters resolve on the Viewer's PATH in the read-only system trees; an
unavailable interpreter refuses approval.
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
admission and outside the controller mutation lease. The existing bounded
controller jobs own setup by activation, so a running setup leaves controller
ticks and other lanes free to advance. Setup uses the work CPU
scope and the agent memory policy, including project, role and bound stage
memory caps. It runs in the new pipeline checkout, with
private HOME, configuration, state and temporary directories. It receives no
account credentials. System tools are read-only; only the checkout and private
scratch are writable. A new checkout borrows the parent checkout's installed
`node_modules` through a link; setup runs without that link, and the link
returns only when setup installed no `node_modules` of its own. Restricted
stages also have isolated networking. This
initial runner requires Linux, Bubblewrap namespaces and Python 3; missing
isolation refuses execution and parks the stage. There is no host fallback.

Reviewed files are mounted from captured bytes, so replacing a script after
validation cannot change the command being executed. The start is checkpointed
before execution, with a three-minute execution limit and 64 KiB output limit.
The scope launcher dies with its parent; Bubblewrap ends detached descendants
with its PID namespace. Success, exit code, working directory and redacted output
are retained on the stage attempt. Each output stream is displayed up to 16,000
characters, with an ellipsis when shortened. The setup is one line with a dot
and its outcome: in the board's **Stages** sheet for the attempt the pane shows,
and on the phone pipeline screen for the lane's latest setup. A failure opens on
its command, its stderr and the end of its output; with no conversation on the
attempt, the setup takes the pane. Select a closed line to see its command and output, and
hover or tap the dot for when it started and how long it took. A failed setup
stays on its attempt beside its successful retry; in the **Stages** sheet the
attempt buttons switch between them.

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
