X1 service fixtures copied byte for byte at revision `a8bfda0b836a17f2d3ba7a4d065fabf03e967a13`. All identities are synthetic placeholders.

```text
claimed_tools_member 6b98c7c183e2f1b1752bab92bcae724891ac5c75a9f484bbaaa4fb65b73f2387
claimed_tools_admin 624dbf25ea7417e2e5862bbe935e07a3940fb0a19476367018e9c01a5139f993
claimed_tools_owner 0b17bb59a7702451a28d4ae08e897a32a412fce619dfd652dc9a10a9062b027c
claimed_tools_anonymous_admin 589d1ee4843456569fdd6ae797b122f306b6aa57733c45d445099f0df09b255e
claimed_tools_admin_owner_member eb89272cae981ccfb7f4214f05b5f89eed9ec41fb1158c6a8decfd89d4310bd6
claimed_tools_actions_admin 987b7063a482687ea242dc351333b6e192898b79457306a1f4c2ede00bcae8f0
tool_call_bodies a8f60107ec907ca0237cae6670edb36875716a3d94097981f8f3c448d4cd6785
tool_call_results 3d34147920af82036e5cfd628f911a5dcd406fb238ce93396c6c368cc4caf50f
tool_call_errors 2c0c9008b8e84c9040ee56a09bce5bda116a9d7d4db598eb687e6d8e2dcb9d71
tool_index_measurements 5c7e684994ca50c172484f570218c9c364df91cd558d650849b735aeeadc186f
```

The same ten service JSON files were fetched at `4a48a759cb59a0159ad519e70713a422341b8149`
and verified byte-identical for slice 2b. No service fixture was rewritten.

`actions-off-2a-hashes.json` and `actions-off-x2-2a-hashes.json` were captured
before implementation from the unchanged slice 2a code at `c9a93de8`. They
pin SHA-256 of each real runner prompt, compact CLI schema and serialized call
body for the five X1 role runs, the action index degraded to hand-off exactly
as the service does with actions OFF, and the X2 pending/page run (including
reversed HTTP arrival order). The runner tests compare these hashes and check
that read metadata rows carry no effect field. Claim advertisement adds F2;
it is the sole change in the old X2 and completion wire bodies.
