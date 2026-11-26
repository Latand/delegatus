# State compatibility under deployment-shaped CPU contention

Measured on 2026-11-26 with Bun 1.4.0 on a 24-logical-CPU Linux host. The
source baseline was `c38535d43308f13c59e47b6f225e6e55e84beb72`; the candidate
was `047c519320fd30fb8080f302fe92d0c424c0147a`. Each run used a fresh private
state directory copied from the same 3,354,591,232-byte synthetic SQLite
fixture. The Viewer served the real readiness handler on an ephemeral loopback
port, and each request required the exact source revision.

The temporary cgroup layout modeled the deployment sibling weights described
in [CPU placement](../design/cpu-placement.md): a 20-CPU parent, a Viewer group
at weight 1000, an agents group at weight 100, and an 18-CPU work slice at
weight 100. Six gate-shaped groups ran five CPU burners each; each gate group
was configured at weight 10 with a three-CPU quota. The same 30 burners and
fixture were used in all six runs. Work-slice PSI `some` stall time records the
fraction of each sample during which runnable work in that cgroup waited for
CPU.

| Pair | Revision | Start load average | Compatibility phase (s) | Revision-bound HTTP 200 (s) | Work-slice PSI `some` |
|---:|---|---:|---:|---:|---:|
| 1 | Baseline | 35.7 | 13.27 | 18.94 | 45.2% |
| 1 | Candidate | 39.1 | 9.40 | 12.34 | 47.5% |
| 2 | Baseline | 55.3 | 11.46 | 15.09 | 46.3% |
| 2 | Candidate | 46.3 | 12.35 | 16.25 | 46.5% |
| 3 | Baseline | 59.4 | 13.76 | 16.91 | 48.0% |
| 3 | Candidate | 66.1 | 12.86 | 16.92 | 47.2% |

All six boots reached revision-bound HTTP 200 in under 19 seconds. Median
compatibility time was 13.27 seconds on the baseline and 12.35 seconds on the
candidate; median readiness time was 16.91 and 16.25 seconds, respectively.
The candidate therefore has substantial headroom under this matched
deployment-shaped contention. The small median difference is within the
observed run-to-run spread. Work-slice PSI remained closely matched across the
samples despite changing ambient load.

The 90-second timeout did not reproduce in this layout. This result validates
the candidate's headroom during a gate wave; it does not assign a single cause
to the earlier production timeouts.
