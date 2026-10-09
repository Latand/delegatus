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
| `descriptor_owner_api.json` | 1102 | `04d1da1e6ee737cac6f4596fbb8229c6d55bd7a54555d7a1b85436347fc02378` |
| `owner_api_me.json` | 116 | `cb92b7a6fa024402cc35ac1af60444a52a65192d98c905ed3ff2ccede86ce032` |
| `claimed_compact_owner.json` | 692 | `9b38c08da1a938cef1f28c8ca41703bc3f5207a3c2c61308c90055436a8c5276` |
| `claimed_compact_admin.json` | 690 | `63230ac373e55c9fe039bd5a5d313f9e5062a164dfc622bef23f762c25304a04` |
| `compact_completions.json` | 7988 | `4b90e23eed944d18f127ac2121b25a6fc6c48fa30db70a23b36c0f2db746816c` |
