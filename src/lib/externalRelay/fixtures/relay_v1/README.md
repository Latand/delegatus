X1 service fixtures copied byte for byte at revision `a0d9245bcac2c2246f29f180f8bd21aa825d478c`. All identities are synthetic placeholders.

```text
sha256 bytes file
2fdc03a4de10fbdc2df73322fc8e11fa4b240acb680962a70b2fce30b44c2a7d 10825 claimed_tools_member.json
845186f2d2c796a9a73ae47ad190312c311108af41f0ea38846cccab08ff4730 33322 claimed_tools_admin.json
cd05cf1937401dd4cfe804ddb3ed5b720961fdc3823582d2fe5ebf4ca1e71dae 33321 claimed_tools_anonymous_admin.json
7721980b31846f829b4bd67cf94a82ca3b5e478d32a606bf3d7c5833645b8994 34733 claimed_tools_owner.json
8e9274697d44d2996f2bbb20ec8d5b9620cc5d5878bcadab8e1e24a418b3f039 16863 claimed_tools_admin_owner_member.json
5514420f514516525418841ba19cfc8fa6c173c9e785a4b8943194f185627c6f 66162 claimed_tools_actions_admin.json
a8f60107ec907ca0237cae6670edb36875716a3d94097981f8f3c448d4cd6785 1165 tool_call_bodies.json
2c0c9008b8e84c9040ee56a09bce5bda116a9d7d4db598eb687e6d8e2dcb9d71 899 tool_call_errors.json
3d34147920af82036e5cfd628f911a5dcd406fb238ce93396c6c368cc4caf50f 38069 tool_call_results.json
bc90fffcec11665fee7022470747d0b741a9e649c3048a54474902945ad88e59 1436 tool_index_measurements.json
```

The merge of slice 2a at `f38f7e64` refreshed all ten service JSON files to
the manifest above. Slice 2b uses those exact bytes.

`actions-off-2a-hashes.json` and `actions-off-x2-2a-hashes.json` were captured
from the real runner at `f38f7e64`, in an isolated archive of that revision.
They pin SHA-256 of each runner prompt, compact CLI schema and serialized call
body for the five X1 role runs, the action index degraded to hand-off exactly
as the service does with actions OFF, and the X2 pending/page run in both HTTP
arrival orders. The X2 `wire` hash pins the complete 2a X2 bytes; the 2b test
removes its appended action runs and F2 advertisement before comparing them.
Read metadata rows carry no effect field.

The 2b X2 action run includes two concurrent reads before the action so that
normal and reversed HTTP arrivals exercise the same admission snapshots.
Polling an admitted image generation returns its stored delivered outcome with
`replayed: true`; the double counts one execution for that call identity.

## Slice 3 (X3)

Copied byte for byte from service revision `c5067f000493ca14e51216cdcac68fd6442fa2f6`.

| File | Bytes | SHA-256 |
|---|---:|---|
| `claimed_compact_owner.json` | 692 | `9b38c08da1a938cef1f28c8ca41703bc3f5207a3c2c61308c90055436a8c5276` |
| `claimed_compact_admin.json` | 690 | `63230ac373e55c9fe039bd5a5d313f9e5062a164dfc622bef23f762c25304a04` |
| `compact_completions.json` | 7988 | `4b90e23eed944d18f127ac2121b25a6fc6c48fa30db70a23b36c0f2db746816c` |

## Owner tools (X4), dark

Specification: Celestia amendment revision `03de6455`, 56,267 bytes,
SHA-256 `0a0e746a0868d7e5c81be9bdd12219205506f4cee082bb0126e2e82c89af050e`.
The install switch is `relay:owner_tools:enabled` in the existing private
`external-relay/switches.json`; absent, malformed or unreadable is OFF.
The production default stays OFF. No owner credential is introduced.

`owner-tools-index.json` is a local I10 rendering of the checked-in Celestia
`apps/backend/docs/openapi/public_moderation_openapi.json` at that revision
(document SHA-256 `451e8775dc9cf39bb10baae3e4029295c9af1023b59a05e6f1a31918903e42f4`).
It contains the 14 I9/R7 operations and their complete schemas, totaling
4,903 bytes. Production consumes the service's index and stores no operation
list; the fixture has no role in production negotiation or execution.

`owner-tools-off-v3-hashes.json` pins all 35 existing fixture and evidence
JSON files, including K/P compact claims and completions. The earlier X1,
X2 and X3 files retain their bytes. `owner-tools-off-runner-hashes.json`
was captured from the original Delegatus revision `39f654248666faa6e5deb01d59eeae305e64573f`
through the existing runner test, under isolated state. It pins each role's
prompts, schemas and calls, plus the OFF claim capabilities.

`evidence/external-relay/install_tool_loop_owner.json` extends the existing
X2 runner capture format: its root is the reads run; `actions` contains
writes, retry_ceiling, inner_404, lease_lost and confirmation. Every run drives
the real runner and HTTP transport against deterministic port-0 service
doubles. These are install-side captures; Celestia's future five X4 service
fixtures and the named-revision cross-check remain their follow-up before
either switch is enabled. The capture records a null completion for lease
loss. Confirmation identifiers and absolute expiry appear only on the wire;
the model sees the summary and seconds left, with confirmation through chat
buttons alone.

The E3 regression fails at the original revision with `failed/invalid_answer`
and passes here with `declined/handoff`. Four wire-defined 429 refusals make
three waits, cache the failure, refund exactly one local debit, and preserve
any earlier possible action. An ambiguous attempt keeps its debit and makes
an action outcome unknown. All owner calls use the existing shared limits.

Regenerate the install capture through the existing runner test only:
`LLV_RELAY_WIRE_OUTPUT_OWNER=<output> bash scripts/gate-slot.sh bun test src/lib/externalRelay/runner.test.ts --test-name-pattern 'X4 six owner runs'`,
with HOME, XDG, TMPDIR and LLV_STATE_DIR isolated and the Viewer control URL
pointing at a closed loopback port. No service fixture generator is added here.

| File | Bytes | SHA-256 |
|---|---:|---|
| `owner-tools-index.json` | 6730 | `13ffb1c99fde7ce1e74f3c7127f870b2a2c56dfc9e08a05984ae729dc926b93f` |
| `owner-tools-off-v3-hashes.json` | 4760 | `a6605093b4b1cffc7ef56b4cdc73979a376bfde686f3f6ac904de51e18372fde` |
| `owner-tools-off-runner-hashes.json` | 2879 | `709baf921762e4e9fdab4ab70eafd6141b0f7da7bac342d65ea7741374f9e9e2` |

Install X4 capture: 22956 bytes, SHA-256 `791d1c97d8da0359927fb909dca6cc05839ff88e772ac2c65fd591695599367b`.
