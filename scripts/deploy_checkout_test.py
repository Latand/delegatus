"""Synthetic switch regressions; no installation, service or live state is used."""
import importlib.util
import contextlib
import functools
import hashlib
import pathlib
import subprocess
import json
import shutil
import sqlite3
import os
import sys
import subprocess
import io
import tempfile
import time
import unittest
import uuid
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("deploy_checkout", pathlib.Path(__file__).with_name("deploy-checkout.py"))
deploy = importlib.util.module_from_spec(spec)
# Loading the fixture must leave the checked source tree unchanged.
previous_bytecode_setting = sys.dont_write_bytecode
try:
    sys.dont_write_bytecode = True
    spec.loader.exec_module(deploy)
finally:
    sys.dont_write_bytecode = previous_bytecode_setting

TARGET = "a" * 40
OLD = "b" * 40
# Survivors of a stop are re-parented to the user manager, which stays readable.
USER_MANAGER = 7000
CENSUS_BUN = os.environ.get("CENSUS_TEST_BUN") or shutil.which("bun")


def inline_evidence(adapter, lanes, sample, cutoff, owner_check=None):
    # Stateful relocation fixtures use a fake clock in one process. The
    # worker tests below exercise the actual subprocess supervisor and pipes.
    start = finish = adapter.clock.now()
    for lane in lanes:
        kind, inputs = lane[:2]
        lane_cutoff = min(cutoff, lane[2]) if len(lane) > 2 else cutoff
        if owner_check:
            owner_check()
        adapter.clock.value = start
        for frame in deploy.evidence_frames(adapter, kind, inputs, lane_cutoff):
            if adapter.clock.now() < lane_cutoff:
                sample.accept(frame)
            if owner_check:
                owner_check()
        finish = max(finish, adapter.clock.now())
    adapter.clock.value = finish


class FakeClock:
    def __init__(self):
        self.value = 0

    def now(self):
        return self.value

    def sleep(self, seconds):
        self.value += seconds

    def process_since(self, identity):
        return "2026-01-01T00:00:00Z"


class Switch:
    sample = functools.partialmethod(deploy.collect_sample, collect=inline_evidence)

    def __init__(self):
        self.clock = FakeClock()
        self.published = False
        self.samples = []
        self.events = []
        self.old = [{"pid": 101, "startIdentity": "old"}]
        self.hosts = [{"pid": 102, "startIdentity": "stage", "stageId": "build", "attempt": 1}]
        self.restart_error = None
        self.relocation = {"released": True, "placement": "placed", "started": True,
                           "stopSubmitted": False, "startAttempts": 0, "diagnostics": []}
        self.process_error = None
        self.mcp_errors = 0
        self.outcome = "recovered"
        self.cut = []
        self.cut_unreadable = []
        self.cut_error = None

    def preflight(self):
        return self.old, self.hosts

    def publish(self):
        self.published = True

    def restart(self):
        if self.restart_error:
            raise self.restart_error
        return self.relocation

    def process(self, entry):
        if self.process_error:
            raise self.process_error
        return None

    def serving(self):
        self.samples.append(self.clock.now())
        return {**{role: {"sha": TARGET, "since": "2026-01-01T00:00:00Z", "healthy": True}
                   for role in ["launcher", "viewer", "runtimeHost"]},
                "checks": dict.fromkeys(["http", "runtimeSocket", "mcp", "service", "placement"], True)}

    def stage(self, host):
        if self.mcp_errors:
            self.mcp_errors -= 1
            raise RuntimeError("MCP tool returned error")
        return {"outcome": self.outcome, "stageId": host["stageId"], "attempt": 2}

    def emit(self, event):
        self.events.append(event)

    def interrupted(self, since, hosts):
        if self.cut_error:
            raise self.cut_error
        return self.cut, self.cut_unreadable


class LoggedFailures(unittest.TestCase):
    def test_deployment_read_budget_does_not_scale_with_pending_hosts(self):
        for count in [0, 1, 7, 40]:
            with self.subTest(pending=count):
                switch = Switch()
                switch.hosts = [{"pipelineId": "synthetic", "stageId": "build-" + str(i),
                                 "conversationId": "capture-" + str(i), "attempt": 1} for i in range(count + 1)]
                calls = []
                def stage(host):
                    calls.append((switch.clock.now(), host["stageId"]))
                    if host == switch.hosts[-1]:
                        return {"outcome": "completed", "attempt": 1}
                    return {"outcome": "unknown", "reason": "stage-conversation-pending",
                            "attempt": 2, "stageState": "running"}
                switch.stage = stage
                result = deploy.run_switch(switch, TARGET)
                self.assertEqual(len(switch.samples), 22)
                self.assertLessEqual(switch.clock.now(), 21 * deploy.SAMPLE_TIMEOUT + 20 * 15)
                self.assertLessEqual(len(calls), 21 * (12 * count + 1))
                self.assertEqual(result["verdict"], "needs_decision" if count else "pass")
                self.assertEqual([row["captured"] for row in result["protected"]], switch.hosts)
                self.assertEqual(result["protected"][-1]["outcome"], "completed")
                self.assertTrue(all(row["outcome"] == "unknown" and row["reason"] == "stage-conversation-pending"
                                    and row["attempt"] == 2 for row in result["protected"][:-1]))

    def test_stage_reply_after_its_cutoff_cannot_pass_with_healthy_serving(self):
        switch = Switch()
        def overdue(host):
            switch.clock.sleep(4)
            return {"outcome": "completed", "attempt": 1}
        switch.stage = overdue
        result = deploy.run_switch(switch, TARGET, samples=1, timeout=5)
        self.assertEqual(result["verdict"], "needs_decision")
        self.assertEqual(result["protected"][0]["outcome"], "unknown")
        self.assertTrue(deploy.ready(result["serving"], TARGET))
        self.assertTrue(switch.published)

    def test_unconfirmed_owner_recovery_cannot_pass_on_a_healthy_sample(self):
        switch = Switch()
        switch.relocation.update({"released": True, "placement": "placed", "started": True,
                                  "stopSubmitted": True})
        switch.unit = "synthetic-viewer.service"
        def unconfirmed(command_deadline=None, **_kwargs):
            if command_deadline is not None:
                raise TimeoutError("owner deadline")
        switch.recover_start = unconfirmed
        result = deploy.run_switch(switch, TARGET, samples=1, interval=0, timeout=5)
        self.assertEqual(result["verdict"], "needs_decision")
        self.assertTrue(deploy.ready(result["serving"], TARGET))
        self.assertIn("sample-recovery:TimeoutError", result["diagnostics"])

    def test_attempt_transition_drops_prior_attempt_evidence_and_keeps_unknown_reason(self):
        sample = deploy.EvidenceSample([{"pipelineId": "lane", "stageId": "build", "attempt": 1,
                                        "conversationId": "captured", "startIdentity": "101:old"}])
        row = sample.protected[0]
        row.update(stageState="running", observedConversationId="old-conversation", hostState="alive",
                   turnState="busy", lifecycle="running")
        sample.accept(("protected", (0, {"outcome": "unknown", "pipelineId": "lane", "stageId": "build",
                                         "attempt": 2, "stageState": "running", "reason": "replacement-pipeline-mismatch"})))
        self.assertEqual(row["captured"], {"pipelineId": "lane", "stageId": "build", "attempt": 1,
                                          "conversationId": "captured", "startIdentity": "101:old"})
        self.assertEqual(row["reason"], "replacement-pipeline-mismatch")
        self.assertEqual(row["attempt"], 2)
        for field in ["observedConversationId", "hostState", "turnState", "lifecycle"]:
            self.assertNotIn(field, row)

    def test_delayed_start_settlement_invalidates_a_pre_settlement_serving_witness(self):
        switch = Switch()
        switch.relocation = {"released": True, "placement": "placed", "started": False,
                             "stopSubmitted": True, "startAttempts": 1, "diagnostics": []}
        switch.unit = "synthetic-viewer.service"
        seen_serving = False
        recovery_owners = []

        def serving():
            nonlocal seen_serving
            switch.samples.append(switch.clock.now())
            if switch.relocation["started"]:
                return {"launcher": {"sha": OLD}, "viewer": {"sha": OLD}, "runtimeHost": {"sha": OLD},
                        "checks": dict.fromkeys(["http", "runtimeSocket", "mcp", "service", "placement"], True)}
            seen_serving = True
            return {**{role: {"sha": TARGET, "since": "2026-01-01T00:00:00Z", "healthy": True}
                       for role in ["launcher", "viewer", "runtimeHost"]},
                    "checks": dict.fromkeys(["http", "runtimeSocket", "mcp", "service", "placement"], True)}

        def recover_start(**_kwargs):
            recovery_owners.append(os.getpid())
            if seen_serving:
                # A submitted no-block start settles without another submission.
                switch.relocation["started"] = True

        switch.serving = serving
        switch.recover_start = recover_start
        result = deploy.run_switch(switch, TARGET, samples=1, interval=0, timeout=5)

        self.assertEqual(result["verdict"], "fail")
        self.assertTrue(recovery_owners)
        self.assertEqual(set(recovery_owners), {os.getpid()})
        self.assertEqual(switch.relocation["startAttempts"], 1)
        self.assertEqual(result.get("recovery", {}).get("state"), "complete")
        self.assertEqual(result["serving"]["viewer"]["sha"], OLD)

    def test_inventory_is_reread_after_recovery_during_its_read(self):
        switch = Switch()
        events = []
        recovery_done = False
        cut = [{"conversationId": "cut-after-recovery", "stage": {"pipelineId": "synthetic", "stageId": "build", "attempt": 1}}]

        def owner_check(_cutoff=None):
            nonlocal recovery_done
            if "interrupted:first" in events and not recovery_done:
                recovery_done = True
                switch.cut = cut
                events.append("owner-recovery")
                return True
            return False

        def collect(_adapter, lanes, result, _cutoff, owner_check=None):
            for kind, _inputs, *_rest in lanes:
                events.append(kind + (":final" if recovery_done else ":first"))
                if kind == "serving":
                    result.accept(("serving", switch.serving()))
                elif kind == "interrupted":
                    result.accept(("interrupted", (list(switch.cut), [])))
                    if not recovery_done:
                        owner_check(_cutoff)

        sample = deploy.collect_sample(switch, [], [], TARGET, "cut-boundary", 0, 8,
                                       collect=collect, owner_check=owner_check)
        recovery_at = events.index("owner-recovery")
        self.assertEqual(events[recovery_at + 1:], ["serving:final", "interrupted:final"])
        self.assertEqual(sample.interrupted, cut)
        self.assertEqual(sample.unreadable, [])
        self.assertFalse(sample.incomplete)

    def test_degrading_post_protected_serving_witness_never_passes(self):
        switch = Switch()
        observations = []
        def serving():
            observations.append(len(observations))
            result = {**{role: {"sha": TARGET, "since": "2026-01-01T00:00:00Z", "healthy": True}
                         for role in ["launcher", "viewer", "runtimeHost"]},
                      "checks": dict.fromkeys(["http", "runtimeSocket", "mcp", "service", "placement"], True)}
            if len(observations) > 1:
                result["checks"]["http"] = False
            return result
        def collect(_adapter, lanes, sample, _cutoff, owner_check=None):
            for lane in lanes:
                kind, inputs = lane[:2]
                if kind == "serving":
                    sample.accept(("serving", serving()))
                elif kind == "protected":
                    for index, _host in inputs:
                        sample.accept(("protected", (index, {"outcome": "completed", "attempt": 1})))
                elif kind == "interrupted":
                    sample.accept(("interrupted", ([], [])))
        switch.hosts = [{"pipelineId": "synthetic", "stageId": "build", "attempt": 1}]
        switch.sample = functools.partial(deploy.collect_sample, switch, collect=collect)
        switch.serving = serving
        result = deploy.run_switch(switch, TARGET, samples=1, interval=0, timeout=5)
        self.assertGreaterEqual(len(observations), 2)
        self.assertFalse(result["serving"]["checks"]["http"])
        self.assertEqual(result["verdict"], "fail")

    def test_cut_inventory_that_overruns_the_sample_deadline_keeps_its_reason(self):
        switch = Switch()
        def overdue_inventory(_since, _hosts):
            switch.clock.sleep(6)
            return [], []
        switch.interrupted = overdue_inventory
        result = deploy.run_switch(switch, TARGET, samples=1, interval=0, timeout=5)
        self.assertEqual(result["verdict"], "needs_decision")
        self.assertIsNone(result["interrupted"])
        self.assertEqual(result["interruptedUnreadable"], ["interrupted:sample-deadline"])
        self.assertTrue(deploy.ready(result["serving"], TARGET))

    def test_exited_old_process_after_pointer_publication_still_samples_and_passes(self):
        switch = Switch()
        switch.process_error = FileNotFoundError("old process exited during restart")
        result = deploy.run_switch(switch, TARGET, samples=3, interval=2, timeout=5)
        self.assertEqual(result["verdict"], "pass")
        self.assertEqual(len(switch.samples), 4)
        self.assertEqual(result["serving"]["viewer"]["sha"], TARGET)

    def test_vanished_protected_host_and_mcp_restart_error_are_reconciled(self):
        switch = Switch()
        switch.mcp_errors = 1
        result = deploy.run_switch(switch, TARGET, samples=3, interval=2, timeout=18)
        self.assertEqual(result["verdict"], "pass")
        self.assertEqual(len(switch.samples), 4)
        self.assertEqual(result["protected"][0]["outcome"], "recovered")
        self.assertEqual(switch.clock.now(), 4)  # Only the two inter-sample waits.

    def test_restart_submission_error_after_publish_still_runs_every_sample(self):
        switch = Switch()
        switch.restart_error = TimeoutError("submission timed out while restart continued")
        result = deploy.run_switch(switch, TARGET, samples=3, interval=2, timeout=5)
        self.assertEqual(result["verdict"], "pass")
        self.assertEqual(len(switch.samples), 4)
        self.assertEqual(result["serving"]["launcher"]["since"], "2026-01-01T00:00:00Z")

    def test_only_lost_work_fails_a_healthy_switch(self):
        for outcome, expected in [("fresh attempt started", "pass"), ("completed", "pass"), ("lost", "fail"), ("unknown", "needs_decision")]:
            with self.subTest(outcome=outcome):
                switch = Switch()
                switch.outcome = outcome
                result = deploy.run_switch(switch, TARGET, samples=3, interval=2, timeout=5)
                self.assertEqual(result["verdict"], expected)
                self.assertEqual(len(switch.samples), 4)

    def test_verdict_lists_the_conversations_the_restart_cut(self):
        switch = Switch()
        switch.cut = [{"conversationId": "conversation_synthetic", "stage": None}]
        result = deploy.run_switch(switch, TARGET, samples=3, interval=2, timeout=5)
        self.assertEqual(result["verdict"], "pass")
        self.assertEqual(result["interrupted"], switch.cut)
        self.assertEqual(result["interruptedUnreadable"], [])
        self.assertEqual(result["diagnostics"], [])

    def test_an_unreadable_cut_inventory_is_unknown_and_never_passes(self):
        switch = Switch()
        switch.cut_error = PermissionError("records unreadable")
        result = deploy.run_switch(switch, TARGET, samples=3, interval=2, timeout=5)
        self.assertEqual(result["verdict"], "needs_decision")
        self.assertIsNone(result["interrupted"])
        self.assertEqual(result["interruptedUnreadable"], ["interrupted:PermissionError"])
        self.assertEqual(result["diagnostics"], ["interrupted:PermissionError"])

    def test_a_cut_inventory_with_gaps_keeps_what_it_read_and_never_passes(self):
        switch = Switch()
        switch.cut = [{"conversationId": "conversation_synthetic", "stage": None}]
        switch.cut_unreadable = ["interruption-continuation-broken.json:JSONDecodeError"]
        result = deploy.run_switch(switch, TARGET, samples=3, interval=2, timeout=5)
        self.assertEqual(result["verdict"], "needs_decision")
        self.assertEqual(result["interrupted"], switch.cut)
        self.assertEqual(result["interruptedUnreadable"], switch.cut_unreadable)

    def test_old_or_mixed_serving_releases_retry_and_are_named_in_verdict(self):
        switch = Switch()
        original = switch.serving
        def mixed():
            result = original()
            result["runtimeHost"]["sha"] = OLD
            return result
        switch.serving = mixed
        result = deploy.run_switch(switch, TARGET, samples=3, interval=2, timeout=5)
        self.assertEqual(result["verdict"], "fail")
        self.assertEqual(result["serving"]["runtimeHost"]["sha"], OLD)
        self.assertGreaterEqual(switch.clock.now(), 15)

    def test_http_and_registry_read_errors_retry_with_a_bound(self):
        switch = Switch()
        original = switch.serving
        failures = [ConnectionError("HTTP restart"), ValueError("registry replacement")]
        def restarting():
            if failures:
                raise failures.pop()
            return original()
        switch.serving = restarting
        result = deploy.run_switch(switch, TARGET, samples=3, interval=2, timeout=5)
        self.assertEqual(result["verdict"], "pass")
        self.assertEqual(len(switch.samples), 4)
        self.assertGreaterEqual(switch.clock.now(), 6)

    def test_persistent_transport_failure_records_unknown_and_keeps_sampling(self):
        switch = Switch()
        def unavailable():
            switch.samples.append(switch.clock.now())
            raise ConnectionError("HTTP unavailable")
        switch.serving = unavailable
        result = deploy.run_switch(switch, TARGET, samples=3, interval=2, timeout=5)
        self.assertEqual(result["verdict"], "fail")
        self.assertEqual(len([e for e in switch.events if "sample" in e]), 3)
        self.assertLessEqual(switch.clock.now(), 19)

    def test_a_sample_log_error_does_not_skip_remaining_health(self):
        switch = Switch()
        original = switch.emit
        def emit(event):
            if event.get("sample") == 1:
                raise OSError("temporary evidence write error")
            original(event)
        switch.emit = emit
        result = deploy.run_switch(switch, TARGET, samples=3, interval=2, timeout=5)
        self.assertEqual(result["verdict"], "pass")
        self.assertEqual(len(switch.samples), 4)


class AdapterContracts(unittest.TestCase):
    def test_census_does_not_launch_after_its_remaining_bound_is_spent(self):
        with patch.object(deploy.subprocess, "Popen", side_effect=AssertionError("late launch")) as launch:
            for timeout in [0, -1, 31, float("nan")]:
                with self.assertRaises(RuntimeError):
                    deploy.protected_host_census(pathlib.Path("/fixture"), sys.executable, "/fixture/state", TARGET, timeout)
            launch.assert_not_called()

    def test_census_environment_carries_no_identity_or_credential_under_either_prefix(self):
        with patch.dict(os.environ, {"DELEGATUS_TOKEN": "fixture", "LLV_TOKEN": "fixture",
                                    "DELEGATUS_SPAWN_CAPABILITY": "fixture", "LLV_SPAWN_CONVERSATION_ID": "fixture",
                                    "LLV_STATE_OWNER": "viewer", "OPENAI_API_KEY": "fixture",
                                    "FAL_KEY": "fixture", "SSH_AUTH_SOCK": "/fixture/agent.sock"}):
            environment = deploy.census_environment("/fixture/state")
        self.assertEqual({key for key in environment if key.startswith(("LLV_", "DELEGATUS_"))},
                         {"LLV_STATE_DIR", "LLV_VIEWER_CONTROL_URL"})
        self.assertNotIn("OPENAI_API_KEY", environment)
        self.assertNotIn("FAL_KEY", environment)
        self.assertNotIn("SSH_AUTH_SOCK", environment)

    def test_hanging_census_is_killed_and_reaped_at_its_owned_deadline(self):
        self.assertIsNotNone(CENSUS_BUN, "census child tests require Bun")
        with tempfile.TemporaryDirectory(prefix="census-child-") as root:
            directory = pathlib.Path(root)
            (directory / "scripts").mkdir()
            pidfile = directory / "pid"
            (directory / "scripts/protected-host-census.ts").write_text(
                "import fs from 'node:fs'; fs.writeFileSync('pid', String(process.pid)); "
                "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);\n")
            with self.assertRaises(RuntimeError):
                deploy.protected_host_census(directory, CENSUS_BUN, directory, TARGET, 3)
            pid = int(pidfile.read_text())
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)
            with self.assertRaises(ChildProcessError):
                os.waitpid(pid, os.WNOHANG)

    def test_timed_out_census_child_is_stopped_inside_its_sample_boundary(self):
        self.assertIsNotNone(CENSUS_BUN, "census child tests require Bun")
        with tempfile.TemporaryDirectory(prefix="census-cutoff-") as root:
            directory = pathlib.Path(root)
            (directory / "scripts").mkdir()
            pidfile = directory / "pid"
            (directory / "scripts/protected-host-census.ts").write_text(
                "import fs from 'node:fs'; fs.writeFileSync('pid', String(process.pid)); "
                "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);")
            started = time.monotonic()
            with self.assertRaises(RuntimeError):
                deploy.protected_host_census(directory, CENSUS_BUN, directory, TARGET, 0.5)
            self.assertLess(time.monotonic() - started, 0.8)
            pid = int(pidfile.read_text())
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)

    def test_census_adapter_rejects_malformed_oversized_and_failed_output_beside_a_positive_child(self):
        self.assertIsNotNone(CENSUS_BUN, "census child tests require Bun")
        with tempfile.TemporaryDirectory(prefix="census-child-") as root:
            directory = pathlib.Path(root)
            (directory / "scripts").mkdir()
            script = directory / "scripts/protected-host-census.ts"
            answer = {"targetRevision": TARGET, "registryRevision": 1, "observedAt": "2026-01-01T00:00:00Z",
                      "conversations": [], "unselectedCount": 0, "undescribedHostCount": 0,
                      "selection": {"matched": 0, "selected": 0, "recoveryPending": 0,
                                    "recoveryTruncated": False, "cacheStatus": "hit", "projected": 0, "unreadable": 0}}
            for body in ["console.log('not JSON')", "process.stdout.write('x'.repeat(4*1024*1024+1))", "process.exit(1)"]:
                script.write_text(body)
                with self.assertRaises((ValueError, RuntimeError)):
                    deploy.protected_host_census(directory, CENSUS_BUN, directory, TARGET, 3)
            (directory / ".env").write_text("DELEGATUS_TOKEN=fixture\nLLV_TOKEN=fixture\nLLV_SPAWN_CAPABILITY=fixture\nFAL_KEY=fixture\n")
            answer["conversations"] = [{"conversationId": "conversation_census", "host": {"state": "alive", "kind": "structured", "pid": 104},
                                         "turnState": "busy", "lifecycle": "running", "evidenceSource": "transcript", "pipeline": None}]
            answer["selection"].update({"matched": 1, "selected": 1})
            script.write_text("if (['DELEGATUS_TOKEN','LLV_TOKEN','LLV_SPAWN_CAPABILITY','FAL_KEY'].some(key => process.env[key] !== undefined)) process.exit(1); "
                              "console.log(" + json.dumps(json.dumps(answer)) + ");")
            rows = deploy.complete_census(deploy.protected_host_census(directory, CENSUS_BUN, directory, TARGET, 3))
            self.assertEqual(len(rows), 1)
            self.assertIsNone(rows[0]["pipeline"])

    def test_legacy_target_census_without_lifecycle_remains_usable_for_preflight(self):
        self.assertIsNotNone(CENSUS_BUN, "census child tests require Bun")
        with tempfile.TemporaryDirectory(prefix="census-legacy-lifecycle-") as root:
            release = pathlib.Path(root)
            (release / "scripts").mkdir()
            # Shape emitted by the pre-lifecycle target producer: a complete,
            # nonempty transcript-backed busy row with no lifecycle property.
            answer = {"targetRevision": TARGET, "registryRevision": 3, "observedAt": "2026-01-01T00:00:00Z",
                      "conversations": [{"conversationId": "conversation_legacy", "host": {"state": "alive", "kind": "structured", "pid": 104},
                                         "turnState": "busy", "evidenceSource": "transcript", "pipeline": None}],
                      "unselectedCount": 0, "undescribedHostCount": 0,
                      "selection": {"matched": 1, "selected": 1, "recoveryPending": 0,
                                    "recoveryTruncated": False, "cacheStatus": "hit", "projected": 0, "unreadable": 0}}
            (release / "scripts/protected-host-census.ts").write_text(
                "console.log(" + json.dumps(json.dumps(answer)) + ");")
            captured = deploy.protected_host_census(release, CENSUS_BUN, release, TARGET, 3)
            rows = deploy.complete_census(captured)
            self.assertEqual(rows, answer["conversations"])
            host = {"stageId": "build", "attempt": 1}
            self.assertEqual(deploy.stage_outcome(host, [{"n": 1, "state": "running"}], rows[0])["outcome"], "unknown")

    def test_census_custody_fields_validate_real_child_output_and_allow_older_releases(self):
        with tempfile.TemporaryDirectory(prefix="census-custody-") as root:
            directory = pathlib.Path(root)
            (directory / "scripts").mkdir()
            script = directory / "scripts/protected-host-census.ts"
            identity = {"pid": 104, "startIdentity": "104:42", "bootEpoch": "fixture-boot"}
            writer = {"process": {**identity, "pid": 105}, "exitFile": str(directory / "host-exits/fixture.exit.json")}
            host = {"state": "alive", "kind": "structured", "pid": 104, "process": identity, "exitWriter": writer}
            row = {"conversationId": "conversation_custody", "host": host, "turnState": "idle", "lifecycle": "waiting", "evidenceSource": "transcript", "pipeline": None}
            answer = {"targetRevision": TARGET, "registryRevision": 1, "observedAt": "2026-01-01T00:00:00Z",
                      "conversations": [row], "unselectedCount": 0, "undescribedHostCount": 0,
                      "selection": {"matched": 1, "selected": 1, "recoveryPending": 0,
                                    "recoveryTruncated": False, "cacheStatus": "hit", "projected": 0, "unreadable": 0}}
            def read(value):
                row["host"] = value
                script.write_text("console.log(" + json.dumps(json.dumps(answer)) + ");")
                return deploy.protected_host_census(directory, CENSUS_BUN, directory, TARGET, 3)["conversations"][0]["host"]
            self.assertEqual(read(host), host)
            legacy = {key: value for key, value in host.items() if key not in ["process", "exitWriter"]}
            self.assertNotIn("process", read(legacy))
            malformed = [{**host, "process": {**identity, "pid": 999}}, {**host, "process": "bad"},
                         {**host, "process": {**identity, "startIdentity": ""}},
                         {**host, "process": {**identity, "bootEpoch": 9}},
                         {**host, "exitWriter": {**writer, "exitFile": "relative.exit.json"}},
                         {**host, "exitWriter": {**writer, "process": {**identity, "pid": True}}},
                         {**host, "exitWriter": []}]
            for value in malformed:
                with self.subTest(value=value), self.assertRaisesRegex(RuntimeError, "census row malformed"):
                    read(value)

    def test_census_child_rejects_selection_counts_that_exceed_its_rows(self):
        self.assertIsNotNone(CENSUS_BUN, "census child tests require Bun")
        with tempfile.TemporaryDirectory(prefix="census-child-") as root:
            directory = pathlib.Path(root)
            (directory / "scripts").mkdir()
            script = directory / "scripts/protected-host-census.ts"
            valid = {"targetRevision": TARGET, "registryRevision": 1, "observedAt": "2026-01-01T00:00:00Z",
                     "conversations": [], "unselectedCount": 0, "undescribedHostCount": 0,
                     "selection": {"matched": 1, "selected": 1, "recoveryPending": 0,
                                   "recoveryTruncated": False, "cacheStatus": "hit", "projected": 0, "unreadable": 0}}
            malformed = [valid]
            missing_selected = json.loads(json.dumps(valid))
            del missing_selected["selection"]["selected"]
            malformed.append(missing_selected)
            wrong_count_type = json.loads(json.dumps(valid))
            wrong_count_type["selection"]["selected"] = True
            malformed.append(wrong_count_type)
            missing_completeness = json.loads(json.dumps(valid))
            del missing_completeness["selection"]["unreadable"]
            malformed.append(missing_completeness)
            for answer in malformed:
                with self.subTest(answer=answer):
                    script.write_text("console.log(" + json.dumps(json.dumps(answer)) + ");")
                    with self.assertRaisesRegex(RuntimeError, "census output malformed"):
                        deploy.protected_host_census(directory, CENSUS_BUN, directory, TARGET, 3)

    def test_every_process_read_tolerates_exit_including_cwd_and_second_stat(self):
        for missing in range(4):
            with self.subTest(read=missing):
                calls = []
                def read(pid, field):
                    calls.append(field)
                    if len(calls) - 1 == missing:
                        raise FileNotFoundError("process exited")
                    return {"stat": "101 (synthetic worker) " + " ".join(["S"] + ["0"] * 18 + ["321"]),
                            "cmdline": b"bun\x00/release/bin/cli.mjs\x00", "cwd": "/release"}[field]
                self.assertIsNone(deploy.read_process({"pid": 101, "startIdentity": "321"}, read))
        self.assertIsNone(deploy.read_process({"pid": 101, "startIdentity": "different"}, read))

    def test_stage_classification_uses_current_attempt_and_recovery_evidence(self):
        host = {"stageId": "build", "attempt": 1, "conversationId": "synthetic-original"}
        original = {"n": 1, "state": "running", "conversationId": "synthetic-original"}
        alive = {"host": {"state": "alive"}, "turnState": "busy", "lifecycle": "running"}
        self.assertEqual(deploy.stage_outcome(host, [original], alive)["outcome"], "recovered")
        fresh = {"n": 2, "state": "running", "conversationId": "synthetic-replacement"}
        self.assertEqual(deploy.stage_outcome(host, [original, fresh], alive)["outcome"], "fresh attempt started")
        waiting = {"host": {"state": "alive"}, "turnState": "idle", "lifecycle": "waiting"}
        self.assertEqual(deploy.stage_outcome(host, [original], waiting)["outcome"], "recovered")
        stalled = {"host": {"state": "alive"}, "turnState": "busy", "lifecycle": "stalled"}
        self.assertEqual(deploy.stage_outcome(host, [original], stalled)["outcome"], "unknown")
        self.assertEqual(deploy.stage_outcome(host, [original], {**alive, "lifecycle": "running"})["outcome"], "recovered")
        self.assertEqual(deploy.stage_outcome(host, [original, {**fresh, "state": "spawning"}], {})["outcome"], "unknown")
        failed = {**original, "state": "failed", "error": "stage host was lost while its turn was open"}
        self.assertEqual(deploy.stage_outcome(host, [failed], {})["outcome"], "lost")
        self.assertEqual(deploy.stage_outcome(host, [{**original, "state": "passed"}], {})["outcome"], "completed")
        self.assertEqual(deploy.stage_outcome(host, [failed, fresh], alive)["outcome"], "fresh attempt started")
        self.assertEqual(deploy.stage_outcome(host, [], {})["outcome"], "unknown")

    def test_atomic_private_verdict_names_all_serving_shas_and_since(self):
        with tempfile.TemporaryDirectory(prefix="delegatus-deploy-test-") as root:
            destination = pathlib.Path(root) / "verdict.json"
            result = deploy.run_switch(Switch(), TARGET, samples=3, interval=2, timeout=5)
            deploy.write_json(destination, result)
            self.assertEqual(json.loads(destination.read_text()), result)
            self.assertEqual(destination.stat().st_mode & 0o777, 0o600)
            self.assertEqual(len(list(pathlib.Path(root).iterdir())), 1)

    def test_detached_launch_names_only_a_separate_unit_and_pins_explicit_state(self):
        command = deploy.detached_command("/release/scripts/deploy-checkout.py", "/private/plan.json", "/private/state", "synthetic-attempt")
        self.assertEqual(command[0:2], ["systemd-run", "--user"])
        self.assertIn("--unit=delegatus-deploy-synthetic-attempt", command)
        self.assertIn("--setenv=LLV_STATE_DIR=/private/state", command)
        self.assertIn("--property=UMask=0077", command)
        self.assertNotIn("--scope", command)
        self.assertEqual(command[-4:], ["--config", "/private/plan.json", "--worker", "synthetic-attempt"])

    @unittest.skipUnless(hasattr(os, "pidfd_open"), "pidfd requires Linux")
    def test_pidfd_signal_reaches_only_the_identified_process_in_its_cgroup(self):
        import subprocess
        child = subprocess.Popen(["sleep", "30"])
        self.addCleanup(lambda: child.poll() is None and (child.kill(), child.wait()))
        entry = {"pid": child.pid, "startIdentity": deploy.start_identity(deploy.proc_field(child.pid, "stat"))}
        group = deploy.kernel_cgroup(deploy.proc_field(child.pid, "cgroup"))
        self.assertFalse(deploy.pidfd_signal({**entry, "startIdentity": "0"}, deploy.signal.SIGTERM, group))
        self.assertFalse(deploy.pidfd_signal(entry, deploy.signal.SIGTERM, group + "-other"))
        self.assertIsNone(child.poll())
        self.assertTrue(deploy.pidfd_signal(entry, deploy.signal.SIGTERM, group))
        self.assertEqual(child.wait(timeout=10), -deploy.signal.SIGTERM)
        self.assertFalse(deploy.pidfd_signal(entry, deploy.signal.SIGKILL, group))

    def test_termination_is_held_until_the_start_has_run(self):
        received = []
        signals = [deploy.signal.SIGTERM, deploy.signal.SIGHUP, deploy.signal.SIGINT]
        for signum in signals:
            previous = deploy.signal.signal(signum, lambda number, frame: received.append(number))
            self.addCleanup(deploy.signal.signal, signum, previous)
        with deploy.deferred_termination():
            for signum in signals:
                os.kill(os.getpid(), signum)
                os.kill(os.getpid(), signum)
            self.assertEqual(received, [])
        self.assertEqual(received, signals)

    def test_import_and_cli_help_require_no_state_or_service(self):
        import subprocess
        result = subprocess.run(["python3", str(pathlib.Path(__file__).with_name("deploy-checkout.py")), "--help"],
                                capture_output=True, timeout=5, env={**os.environ, "LLV_STATE_DIR": ""})
        self.assertEqual(result.returncode, 0)
        self.assertIn(b"--preflight", result.stdout)


def obligation(identifier, conversation, recorded, **extra):
    return {"version": 1, "id": "interruption-continuation-" + identifier, "conversationId": conversation,
            "engine": "claude", "hostKey": "claude:synthetic", "path": "/synthetic.jsonl", "reason": "viewer-restart",
            "recordedAt": recorded, "checkpoint": {"lastEventKind": "tool-result", "lastEventAt": 0},
            "seat": None, "state": "owed", "resolution": None, **extra}


class InterruptedConversations(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="delegatus-interrupted-test-")
        self.addCleanup(self.temp.cleanup)
        self.state = pathlib.Path(self.temp.name)
        self.directory = self.state / "interruption-obligations"
        self.directory.mkdir()

    def write(self, record):
        deploy.write_json(self.directory / (record["id"] + ".json"), record)

    def seal_source(self, records):
        database = self.state / "state.sqlite"
        collection = "interruption_obligations:interruption-obligations"
        with sqlite3.connect(database) as db:
            db.executescript("CREATE TABLE state_collections(collection TEXT PRIMARY KEY,schema_version INTEGER,migration_id TEXT);"
                             "CREATE TABLE state_rows(collection TEXT,row_key TEXT,value_json TEXT,row_order INTEGER);")
            db.execute("INSERT INTO state_collections VALUES (?,2,'interruption-source-v2')", (collection,))
            for order, record in enumerate(records):
                db.execute("INSERT INTO state_rows VALUES (?,?,?,?)", (collection, record["id"], json.dumps(record), order))
        self.directory.rename(self.state / "retained-source")
        status = database.stat()
        deploy.write_json(self.directory, {"format": "interruption-sqlite-v2", "epoch": "fixture-source", "collection": collection,
                                          "databaseIdentity": str(status.st_dev) + ":" + str(status.st_ino)})
        return database, collection

    def test_reads_sealed_source_and_pending_cuts_without_repair_or_legacy_files(self):
        canonical = obligation("canonical", "conversation_canonical", "2026-10-06T14:26:00Z")
        self.seal_source([canonical])
        pending = self.state / "interruption-obligations.pending.jsonl"
        pending.write_text(json.dumps(obligation("pending", "conversation_pending", "2026-10-06T14:26:01Z")) + "\n")
        before = {file.name: file.read_bytes() for file in self.state.iterdir() if file.is_file()}
        listed, unreadable = deploy.interrupted_conversations(self.state, "2026-10-06T14:25:15Z")
        self.assertEqual(unreadable, [])
        self.assertEqual([row["conversationId"] for row in listed], ["conversation_canonical", "conversation_pending"])
        self.assertEqual({file.name: file.read_bytes() for file in self.state.iterdir() if file.is_file()}, before)

    def test_unrelated_database_writes_do_not_keep_the_cut_inventory_moving(self):
        canonical = obligation("canonical", "conversation_canonical", "2026-10-06T14:26:00Z")
        database, _collection = self.seal_source([canonical])
        read = deploy.read_obligations
        writes = []

        def read_then_write(*args):
            result = read(*args)
            with sqlite3.connect(database) as db:
                db.execute("INSERT INTO state_rows VALUES ('unrelated',?,?,?)", ("other", "{}", len(writes)))
            writes.append(True)
            return result

        with patch.object(deploy, "read_obligations", side_effect=read_then_write):
            listed, unreadable = deploy.interrupted_conversations(self.state, "2026-10-06T14:25:15Z")
        self.assertEqual(unreadable, [])
        self.assertEqual([row["conversationId"] for row in listed], ["conversation_canonical"])
        self.assertEqual(len(writes), 1)

    def test_sealed_inventory_refuses_missing_replaced_or_incompatible_authority(self):
        for flaw in ("collection", "schema", "identity", "payload"):
            with self.subTest(flaw=flaw), tempfile.TemporaryDirectory(prefix="delegatus-cut-source-") as root:
                original = self.state, self.directory
                self.state = pathlib.Path(root)
                self.directory = self.state / "interruption-obligations"
                self.directory.mkdir()
                try:
                    database, collection = self.seal_source([obligation("cut", "conversation_cut", "2026-10-06T14:26:00Z")])
                    with sqlite3.connect(database) as db:
                        if flaw == "collection":
                            db.execute("DELETE FROM state_collections")
                        elif flaw == "schema":
                            db.execute("UPDATE state_collections SET schema_version=99")
                        elif flaw == "payload":
                            db.execute("UPDATE state_rows SET value_json='{' WHERE collection=?", (collection,))
                    if flaw == "identity":
                        marker = json.loads(self.directory.read_text())
                        marker["databaseIdentity"] = "replacement"
                        deploy.write_json(self.directory, marker)
                    listed, unreadable = deploy.interrupted_conversations(self.state, "2026-10-06T14:25:15Z")
                    self.assertEqual(listed, [])
                    self.assertTrue(unreadable)
                finally:
                    self.state, self.directory = original

    def test_cutover_intent_with_no_marker_keeps_inventory_unknown(self):
        deploy.write_json(self.state / "interruption-obligations.source.json", {"format": "interruption-sqlite-v2"})
        listed, unreadable = deploy.interrupted_conversations(self.state, "2026-10-06T14:25:15Z")
        self.assertEqual(listed, [])
        self.assertEqual(unreadable, ["interruption-obligations:incomplete"])

    def test_lists_cuts_recorded_since_the_switch_with_their_stage(self):
        self.write(obligation("old", "conversation_before", "2026-10-06T14:00:00.000Z"))
        self.write(obligation("agent", "conversation_agent", "2026-10-06T14:25:30.000Z",
                              checkpoint={"lastEventKind": "assistant-message", "lastEventAt": 0,
                                          "backgroundTasks": ["background task b1"]}))
        self.write(obligation("stage", "conversation_stage", "2026-10-06T14:25:31.000Z", state="discharged",
                              resolution="a pipeline stage: its controller retries the attempt",
                              stage={"pipelineId": "lane", "stageId": "build", "attempt": 1}))
        self.write(obligation("protected", "conversation_protected", "2026-10-06T14:25:32.000Z"))
        hosts = [{"conversationId": "conversation_protected", "pipelineId": "other", "stageId": "fix", "attempt": 4}]
        listed, unreadable = deploy.interrupted_conversations(self.state, "2026-10-06T14:25:15.000000+00:00", hosts)
        self.assertEqual(unreadable, [])
        self.assertEqual([entry["conversationId"] for entry in listed],
                         ["conversation_agent", "conversation_stage", "conversation_protected"])
        self.assertIsNone(listed[0]["stage"])
        self.assertEqual(listed[0]["backgroundTasks"], ["background task b1"])
        self.assertEqual(listed[1]["stage"], {"pipelineId": "lane", "stageId": "build", "attempt": 1})
        self.assertEqual(listed[1]["state"], "discharged")
        self.assertEqual(listed[2]["stage"], {"pipelineId": "other", "stageId": "fix", "attempt": 4})

    def test_reads_the_pending_journal_and_names_every_record_it_could_not_read(self):
        (self.directory / "interruption-continuation-broken.json").write_text("{")
        self.write(obligation("undated", "conversation_undated", None))
        pending = self.state / "interruption-obligations.pending.jsonl"
        pending.write_text(json.dumps(obligation("journal", "conversation_journal", "2026-10-06T14:26:00.000Z")) + "\n{\n")
        listed, unreadable = deploy.interrupted_conversations(self.state, "2026-10-06T14:25:15+00:00")
        self.assertEqual([entry["conversationId"] for entry in listed], ["conversation_journal"])
        self.assertEqual(unreadable, ["interruption-obligations.pending.jsonl:2",
                                      "interruption-continuation-broken.json:JSONDecodeError",
                                      "interruption-continuation-undated:recordedAt"])

    def claim(self, suffix, body):
        claimed = self.state / ("interruption-obligations.pending.jsonl.claim-" + suffix)
        claimed.write_text(body)
        return claimed

    def test_records_an_import_holds_in_its_claim_are_listed_and_a_corrupt_claim_is_unreadable(self):
        # An import in flight, one that died holding its claim, and a claim
        # whose record also reached the directory, which keeps the directory's.
        self.claim("123-abcdef123456", json.dumps(obligation("active", "conversation_active", "2026-10-06T14:26:00.000Z",
                                                             stage={"pipelineId": "lane", "stageId": "build", "attempt": 1})) + "\n")
        self.claim("77-0123456789ab", json.dumps(obligation("abandoned", "conversation_abandoned", "2026-10-06T14:26:01.000Z")) + "\n{\n")
        self.claim("88-ba9876543210", json.dumps(obligation("imported", "conversation_imported", "2026-10-06T14:26:02.000Z")) + "\n")
        self.write(obligation("imported", "conversation_imported", "2026-10-06T14:26:02.000Z", state="delivered"))
        listed, unreadable = deploy.interrupted_conversations(self.state, "2026-10-06T14:25:15+00:00")
        self.assertEqual([(entry["conversationId"], entry["state"], entry["stage"]) for entry in listed], [
            ("conversation_active", "owed", {"pipelineId": "lane", "stageId": "build", "attempt": 1}),
            ("conversation_abandoned", "owed", None),
            ("conversation_imported", "delivered", None),
        ])
        self.assertEqual(unreadable, ["interruption-obligations.pending.jsonl.claim-77-0123456789ab:2"])

    def test_a_claim_the_inventory_cannot_read_is_unreadable(self):
        claimed = self.claim("123-abcdef123456", "")
        claimed.chmod(0)
        if os.access(claimed, os.R_OK):
            self.skipTest("this user reads files whatever their mode")
        listed, unreadable = deploy.interrupted_conversations(self.state, "2026-10-06T14:25:15+00:00")
        self.assertEqual(listed, [])
        self.assertEqual(unreadable, ["interruption-obligations.pending.jsonl.claim-123-abcdef123456:PermissionError"])

    def test_a_switch_whose_only_cut_waits_in_an_import_claim_lists_it(self):
        state = self.state

        class ClaimedSwitch(Switch):
            def restart(self):
                pending = state / "interruption-obligations.pending.jsonl"
                pending.write_text(json.dumps(obligation("claimed", "conversation_claimed", deploy.utc(),
                                                         stage={"pipelineId": "lane", "stageId": "build", "attempt": 1})) + "\n")
                pending.rename(state / "interruption-obligations.pending.jsonl.claim-123-abcdef123456")

            def interrupted(self, since, hosts):
                return deploy.interrupted_conversations(state, since, hosts)

        result = deploy.run_switch(ClaimedSwitch(), TARGET, samples=3, interval=2, timeout=5)
        self.assertEqual(result["verdict"], "pass")
        self.assertEqual(result["interruptedUnreadable"], [])
        self.assertEqual([(entry["conversationId"], entry["stage"]) for entry in result["interrupted"]],
                         [("conversation_claimed", {"pipelineId": "lane", "stageId": "build", "attempt": 1})])

    def test_a_corrupt_import_claim_keeps_a_healthy_switch_from_passing(self):
        state = self.state

        class CorruptClaimSwitch(Switch):
            def restart(self):
                (state / "interruption-obligations.pending.jsonl.claim-77-0123456789ab").write_text("{\n")

            def interrupted(self, since, hosts):
                return deploy.interrupted_conversations(state, since, hosts)

        result = deploy.run_switch(CorruptClaimSwitch(), TARGET, samples=3, interval=2, timeout=5)
        self.assertEqual(result["verdict"], "needs_decision")
        self.assertEqual(result["interruptedUnreadable"], ["interruption-obligations.pending.jsonl.claim-77-0123456789ab:1"])

    def test_a_claim_taken_over_while_it_is_read_is_still_listed_by_a_switch(self):
        # A later import renames an abandoned claim to its own just before the
        # inventory reads it, and has not published the record yet.
        state = self.state
        abandoned = "interruption-obligations.pending.jsonl.claim-77-0123456789ab"
        original = pathlib.Path.read_text

        def taken_over(path, *args, **kwargs):
            if path.name == abandoned:
                path.rename(path.with_name("interruption-obligations.pending.jsonl.claim-99-fedcba987654"))
            return original(path, *args, **kwargs)

        class TakeoverSwitch(Switch):
            def restart(self):
                (state / abandoned).write_text(json.dumps(obligation("taken", "conversation_taken", deploy.utc())) + "\n")

            def interrupted(self, since, hosts):
                with patch.object(pathlib.Path, "read_text", taken_over):
                    return deploy.interrupted_conversations(state, since, hosts)

        result = deploy.run_switch(TakeoverSwitch(), TARGET, samples=3, interval=2, timeout=5)
        self.assertEqual(result["verdict"], "pass")
        self.assertEqual(result["interruptedUnreadable"], [])
        self.assertEqual([entry["conversationId"] for entry in result["interrupted"]], ["conversation_taken"])

    def test_records_that_keep_moving_leave_the_inventory_unknown(self):
        state = self.state
        pending = state / "interruption-obligations.pending.jsonl"
        original = deploy.read_journal

        def appended_during_every_read(path, records, unreadable):
            original(path, records, unreadable)
            with pending.open("a") as journal:
                journal.write("\n")

        class MovingSwitch(Switch):
            def restart(self):
                record = obligation("moving", "conversation_moving", deploy.utc())
                deploy.write_json(state / "interruption-obligations" / (record["id"] + ".json"), record)

            def interrupted(self, since, hosts):
                with patch.object(deploy, "read_journal", appended_during_every_read), patch.object(deploy.time, "sleep"):
                    return deploy.interrupted_conversations(state, since, hosts)

        result = deploy.run_switch(MovingSwitch(), TARGET, samples=3, interval=2, timeout=5)
        self.assertEqual(result["verdict"], "needs_decision")
        self.assertEqual(result["interruptedUnreadable"], ["interruption-obligations:moving"])
        self.assertEqual([entry["conversationId"] for entry in result["interrupted"]], ["conversation_moving"])

    def test_a_record_too_incomplete_to_name_its_conversation_is_unreadable(self):
        self.write({"id": "interruption-continuation-bare", "recordedAt": "2026-10-06T23:00:00Z"})
        for name, change in [("anonymous", {"conversationId": None}), ("stageless", {"stage": {"stageId": "build"}}),
                             ("attempt", {"stage": {"pipelineId": "lane", "stageId": "build", "attempt": "1"}}),
                             ("tasks", {"checkpoint": {"backgroundTasks": "background task b1"}}),
                             ("checkpoint", {"checkpoint": None}), ("state", {"state": "pending"}),
                             ("reason", {"reason": None})]:
            self.write(obligation(name, "conversation_" + name, "2026-10-06T23:00:01.000Z", **change))
        self.write(obligation("stale", "conversation_stale", "2026-10-06T21:00:00.000Z", conversationId=None))
        self.write(obligation("whole", "conversation_whole", "2026-10-06T23:00:02.000Z",
                              stage={"pipelineId": "lane", "stageId": None, "attempt": None}))
        pending = self.state / "interruption-obligations.pending.jsonl"
        pending.write_text(json.dumps({"id": "interruption-continuation-journal", "recordedAt": "2026-10-06T23:00:03Z"}) + "\n")
        listed, unreadable = deploy.interrupted_conversations(self.state, "2026-10-06T22:00:00+00:00")
        self.assertEqual([(entry["conversationId"], entry["stage"]) for entry in listed],
                         [("conversation_whole", {"pipelineId": "lane", "stageId": None, "attempt": None})])
        self.assertEqual(sorted(unreadable), sorted(
            "interruption-continuation-" + flaw for flaw in [
                "bare:version", "anonymous:conversationId", "stageless:stage", "attempt:stage", "tasks:checkpoint",
                "checkpoint:checkpoint", "state:state", "reason:reason", "journal:version"]))

    def test_an_unreadable_record_directory_raises_rather_than_listing_nothing(self):
        self.directory.rmdir()
        self.directory.write_text("not a directory")
        with self.assertRaises(OSError):
            deploy.interrupted_conversations(self.state, "2026-10-06T14:25:15+00:00")

    def test_a_state_without_records_lists_nothing(self):
        self.directory.rmdir()
        self.assertEqual(deploy.interrupted_conversations(self.state, "2026-10-06T14:25:15+00:00"), ([], []))


class CheckoutIntegration(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="delegatus-checkout-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.state = self.root / "state"
        (self.state / "self-update").mkdir(parents=True)
        (self.state / "host-exits").mkdir()
        self.checkout = self.root / "checkout"
        self.checkout.mkdir()
        self.releases = self.root / "releases"
        self.target = self.releases / TARGET[:12]
        (self.target / ".next").mkdir(parents=True)
        (self.target / ".next/BUILD_ID").write_text("synthetic")
        (self.target / "bin").mkdir()
        (self.target / "bin/cli.mjs").write_text(deploy.CHECKOUT_HANDOFF)
        (self.target / "bin/launcher-relaunch.mjs").write_text(deploy.RELAUNCH_PROTOCOL)
        self.token = self.root / "service.env"
        self.token.write_text("LLV_TOKEN=synthetic-secret\n")
        self.evidence = self.root / "verified.json"
        deploy.write_json(self.evidence, {"sha": TARGET, "viewer": "pass", "runtimeHost": "pass"})
        self.pointer = self.state / "self-update" / ("release-" + "c" * 16 + ".json")
        self.record_file = self.pointer.with_name("launcher-" + "c" * 16 + ".json")
        self.request_file = self.pointer.with_name("request-" + "c" * 16 + ".json")
        self.baseline = {"sha": OLD, "dir": str(self.releases / OLD[:12]), "checkoutHead": OLD, "publishedAt": "2026-01-01T00:00:00Z"}
        deploy.write_json(self.pointer, self.baseline)
        self.plan = self.root / "plan.json"
        deploy.write_json(self.plan, {"stateDir": str(self.state), "installId": "c" * 16, "target": TARGET,
                                     "checkout": str(self.checkout), "checkoutHead": OLD, "releaseDir": str(self.target),
                                     "tokenFile": str(self.token), "verificationFile": str(self.evidence),
                                     "unit": "synthetic-viewer.service", "baselinePointer": self.baseline, "bun": "/synthetic/bun"})
        self.current = OLD
        self.old_gone = False
        self.mcp_failures = 0
        self.http_failures = 0
        self.commands = []
        self.attempts = [{"n": 1, "state": "running", "conversationId": "synthetic-stage"}]
        self.inventory_overrides = {}
        self.inventory_reads = 0
        self.recovery_overrides = {}
        self.merger_delivery = {}
        self.replacement_overrides = {}
        # The service's kernel cgroup, under the slice its unit configures.
        self.cgroup = self.root / "cgroup"
        self.slice = "delegatus.slice"
        self.slice_group = "/user.slice/delegatus.slice"
        self.service_group = self.slice_group + "/synthetic-viewer.service"
        self.parents = {}
        self.pgroups = {}
        self.sessions = {}
        self.descriptors = {}
        self.scopes = {}
        self.cmdlines = {}
        self.groups = {}
        self.moving = set()
        self.stat_reads = 0
        self.main_pid = 101
        self.unit_changes = {}
        self.bound = set()
        self.unit_jobs = ""
        self.members = [101, 102, 103]
        (self.cgroup / self.service_group.lstrip("/") / "cpu.weight").write_text("1000\n")
        self.set_record(OLD)
        # The user manager's view of the unit. A stop leaves `surviving` in the
        # old cgroup; while it is populated systemd keeps naming that path and
        # a start reuses it, as systemd 255 does.
        self.active = True
        self.old_group = None
        self.surviving = set()
        self.ignores_term = set()
        self.reborn = set()
        self.leave_at = {}
        self.never_released = False
        self.start_refusals = 0
        self.stop_refused = False
        self.weight = "1000"
        self.weight_effective = True
        self.signals = []
        fixture = self
        class Transport:
            def __init__(self, *args):
                pass
            def close(self):
                pass
            def probe(self):
                if fixture.mcp_failures:
                    fixture.mcp_failures -= 1
                    raise RuntimeError("MCP tool returned error")
                return True
            def call(self, tool, args):
                if fixture.mcp_failures:
                    fixture.mcp_failures -= 1
                    raise RuntimeError("MCP tool returned error")
                if tool == "get_pipeline":
                    return {"ok": True, "pipeline": {"stages": [{"id": "build"}], "runs": [
                        {"stageId": "other", "attempts": [{"n": 99, "state": "passed"}]},
                        {"stageId": "build", "attempts": fixture.attempts if fixture.old_gone else [
                            {"n": 1, "state": "running", "conversationId": "synthetic-stage"}]}]}}
                if tool == "conversation_deliverability":
                    return fixture.merger_delivery
                current = fixture.attempts[-1] if fixture.old_gone else {"n": 1, "conversationId": "synthetic-stage"}
                row = {"conversationId": "synthetic-stage", "turnState": "busy", "lifecycle": "running",
                       "evidenceSource": "transcript",
                       "host": {"state": "alive", "pid": 204 if fixture.old_gone else 104,
                                "process": {"pid": 204 if fixture.old_gone else 104,
                                            "startIdentity": str(204 if fixture.old_gone else 104) + ":" + str(204 if fixture.old_gone else 104),
                                            "bootEpoch": "fixture-boot"}},
                       "pipeline": {"pipelineId": "synthetic-lane", "stageId": "build", "attempt": current["n"]}}
                row["conversationId"] = current.get("conversationId", "synthetic-stage")
                for key, value in fixture.replacement_overrides.items():
                    if key == "host":
                        for host_key, host_value in value.items():
                            if host_key == "process" and isinstance(host_value, dict):
                                row["host"].setdefault("process", {}).update(host_value)
                            else:
                                row["host"][host_key] = host_value
                    elif key == "pipeline":
                        row["pipeline"].update(value)
                    else:
                        row[key] = value
                answer = {"ok": True, "conversations": [row], "unselectedCount": 0,
                          "selection": {"matched": 1, "selected": 1, "recoveryPending": 0,
                                        "recoveryTruncated": False, "cacheStatus": "fresh", "projected": 0, "unreadable": 0}}
                if args.get("limit") == 200 and not args.get("protected_census") and not args.get("conversation_id"):
                    fixture.inventory_reads += 1
                    overrides = fixture.inventory_overrides
                    if callable(overrides):
                        overrides = overrides(fixture.inventory_reads)
                    answer.update(overrides)
                elif args.get("protected_census") or args.get("conversationId"):
                    answer.update(fixture.recovery_overrides)
                return answer
        env = patch.dict(os.environ, {"LLV_STATE_DIR": str(self.state)})
        env.start()
        self.addCleanup(env.stop)
        self.adapter = deploy.Checkout(self.plan, clock=FakeClock(), process_read=self.process,
                                       http=self.http, runtime=lambda record: {"ready": True},
                                       execute=self.execute, mcp_factory=Transport, cgroup_root=self.cgroup,
                                       signal_process=self.signal,
                                       epoch=lambda: "fixture-boot",
                                       census=lambda *args: Transport().call("census", {"limit": 200}))
        self.adapter.read_host_census = lambda: Transport().call("census", {"limit": 200, "protected_census": True})
        self.adapter.sample = functools.partial(deploy.collect_sample, self.adapter, collect=inline_evidence)
        self.addCleanup(self.adapter.close)
        clock = self.adapter.clock
        def sleep(seconds, advance=clock.sleep):
            advance(seconds)
            # Survivors that exit by themselves once their time has come.
            for pid, at in list(self.leave_at.items()):
                if clock.now() >= at:
                    del self.leave_at[pid]
                    self.exit_survivor(pid)
        clock.sleep = sleep

    def service_commands(self):
        return [c[3] for c in self.commands if c[:3] == ["systemctl", "--user", "--no-block"]]

    def answer_relaunch(self, result="done", after=None):
        clock = self.adapter.clock
        sleep = clock.sleep
        self.requests = []

        def respond(seconds):
            sleep(seconds)
            if self.requests or not self.request_file.exists():
                return
            request = json.loads(self.request_file.read_text())
            self.requests.append(request)
            if result in {"unsettled", "request-refused"}:
                return
            self.request_file.unlink()
            if result == "done":
                self.old_gone = True
                self.surviving.update({101, self.main_pid, 104, *self.members} - {102, 103})
                self.members = sorted(self.surviving | {202, 203})
                self.current = TARGET
                self.set_record(TARGET, launcher_pid=101)
            else:
                if result != "refused":
                    self.pointer.write_bytes(request["rollbackPointer"].encode())
                if result in {"fell-back", "refused"}:
                    self.set_record(OLD, requestId=request["requestId"],
                                    error={"kind": "fell-back" if result == "fell-back" else "message"})
            if result in {"done", "rolled-back"}:
                deploy.write_json(self.adapter.result_file, {
                    "requestId": request["requestId"], "target": TARGET, "state": result,
                    "revision": self.current, "launcherPid": 101, "launcherIdentity": "101",
                })
            if after:
                after()

        clock.sleep = respond

    def test_placed_relaunch_keeps_bound_scopes_and_receipt_writers(self):
        self.answer_relaunch()
        groups = self.helper_groups(2, parent=102)
        groups[0]["row"]["pipeline"] = {"pipelineId": "synthetic-lane", "stageId": "build", "attempt": 1}
        self.bound = set(self.scopes)
        original = self.pointer.read_bytes().replace(b"\n", b"\r\n")
        self.pointer.write_bytes(original)
        result = deploy.run_switch(self.adapter, TARGET, samples=3, interval=2, timeout=5)
        self.assertEqual(result["verdict"], "pass")
        proof = result["relaunch"]
        self.assertIsNone(result["relocation"])
        self.assertEqual(proof["result"], "done")
        self.assertEqual(proof["signalled"], [])
        self.assertEqual(proof["unitBefore"], proof["unitAfter"])
        self.assertEqual(self.requests[0]["rollbackPointer"].encode(), original)
        self.assertEqual(set(self.requests[0]), {"requestId", "role", "target", "rollbackPointer", "requestedAt"})
        for row, group in zip(proof["hosts"], groups):
            self.assertTrue(row["alive"])
            self.assertEqual(row["process"]["pid"], group["host"])
            self.assertEqual(row["writerBefore"], row["writerAfter"])
            self.assertEqual({e["pid"] for e in row["helpersAfter"]}, set(group["pids"]))
            self.assertEqual(proof["scopes"][row["scope"]]["before"], proof["scopes"][row["scope"]]["after"])
        self.assertEqual(result["protected"][0]["outcome"], "preserved")
        self.assertEqual(result["protected"][0]["custody"], proof["hosts"][0])
        self.assertEqual(self.service_commands(), [])
        self.assertTrue(all(c[2] in {"show", "list-jobs"} for c in self.commands if c[0] == "systemctl"))

    def test_relocation_refuses_active_bound_units_at_both_admission_points(self):
        for late in [False, True]:
            with self.subTest(late=late):
                self.setUp()
                self.relocating()
                scope = "synthetic-dependent.scope"
                self.scopes[scope] = {"Id": scope, "ActiveState": "active"}
                if late:
                    publish = self.adapter.publish
                    def admit():
                        publish()
                        self.bound.add(scope)
                    self.adapter.publish = admit
                    result = deploy.run_switch(self.adapter, TARGET, samples=1, interval=0, timeout=0)
                    self.assertEqual(result["relocation"]["diagnostics"], ["relocation would stop 1 bound units"])
                    self.assertEqual(result["verdict"], "fail")
                else:
                    self.bound.add(scope)
                    with self.assertRaisesRegex(deploy.SwitchRefused, "relocation would stop 1 bound units"):
                        deploy.run_switch(self.adapter, TARGET)
                    self.assert_no_switch()
                self.assertEqual(self.service_commands(), [])
                self.assertEqual(self.signals, [])

    def test_relaunch_preflight_refuses_incompatible_or_pending_launchers(self):
        for case, reason in [
            ("capability", "launcher cannot relaunch in place"),
            ("protocol", "launcher cannot relaunch in place"),
            ("target", "target release cannot take a relaunch"),
            ("topology", "checkout launcher topology differs from plan"),
            ("request", "launcher request or update already pending"),
            ("trial", "launcher request or update already pending"),
            ("apply", "launcher request or update already pending"),
            ("gate", "launcher request or update already pending"),
            ("busy", "launcher not idle"),
            ("serving", "target already serving"),
        ]:
            with self.subTest(case=case):
                self.setUp()
                if case == "capability":
                    self.set_record(OLD, relaunch=True)
                elif case == "protocol":
                    self.set_record(OLD, protocol="obsolete")
                elif case == "target":
                    (self.target / "bin/cli.mjs").write_text("legacy")
                elif case == "topology":
                    record = json.loads(self.record_file.read_text())
                    deploy.write_json(self.record_file, {**record, "requestFile": str(self.root / "other.json")})
                elif case in {"request", "trial"}:
                    deploy.write_json(getattr(self.adapter, case + "_file"), {})
                elif case == "apply":
                    deploy.write_json(self.pointer.with_name("apply.json"), {"state": "ready"})
                elif case == "gate":
                    deploy.write_json(self.pointer.with_name("auto-admission.json"), {"id": "gate", "until": 10**14})
                elif case == "busy":
                    self.set_record(OLD, state="relaunching")
                    observed = self.adapter.serving()
                    observed["launcher"]["healthy"] = True
                    self.adapter.serving = lambda: observed
                else:
                    self.baseline["dir"] = str(self.target)
                    deploy.write_json(self.pointer, self.baseline)
                    self.adapter.baseline = self.baseline
                with self.assertRaisesRegex(deploy.SwitchRefused, reason):
                    self.adapter.preflight()
                self.assert_no_switch()

    def test_relaunch_failure_receipts_and_exclusive_request_collision(self):
        for state in ["rolled-back", "fell-back", "refused", "request-refused", "unsettled"]:
            with self.subTest(state=state):
                self.setUp()
                self.answer_relaunch(state)
                if state == "request-refused":
                    publish = self.adapter.publish
                    def collide():
                        publish()
                        deploy.write_json(self.request_file, {"requestId": "different-request"})
                    self.adapter.publish = collide
                verdict = deploy.run_switch(self.adapter, TARGET, samples=2, interval=1, timeout=5)
                self.assertEqual(verdict["relaunch"]["result"], state)
                self.assertEqual(verdict["verdict"], "needs_decision" if state == "unsettled" else "fail")
                self.assertEqual(verdict["interrupted"], [])
                self.assertEqual(verdict["interruptedUnreadable"], [])
                self.assertEqual(verdict["relaunch"]["signalled"], [])
                self.assertEqual(self.service_commands(), [])
                self.assertEqual(self.request_file.exists(), state in {"request-refused", "unsettled"})
                expected = OLD if state in {"rolled-back", "fell-back"} else TARGET
                self.assertEqual(json.loads(self.pointer.read_bytes())["sha"], expected)
                if state == "request-refused":
                    self.assertEqual(self.requests, [{"requestId": "different-request"}])

    def test_relaunch_fence_retains_each_mismatch_and_unreadable_poll(self):
        for key, change in [
            ("ActiveState", "inactive"), ("MainPID", "99"), ("NRestarts", "1"),
            ("InvocationID", "b" * 32), ("InactiveEnterTimestampMonotonic", "42"),
            ("jobs", "7 synthetic-viewer.service stop running"), ("identity", "reborn"),
            ("unreadable", "yes"),
        ]:
            with self.subTest(key=key):
                self.setUp()
                def mutate():
                    if key == "jobs":
                        self.unit_jobs = change
                    elif key == "identity":
                        self.reborn.add(101)
                    elif key == "unreadable":
                        self.unit_changes["NRestarts"] = "unknown"
                    else:
                        self.unit_changes[key] = change
                self.answer_relaunch(after=mutate)
                result = deploy.run_switch(self.adapter, TARGET, samples=2, interval=1, timeout=5)
                self.assertEqual(result["verdict"], "needs_decision" if key == "unreadable" else "fail")
                self.assertTrue(result["relaunch"]["unitUnknown" if key == "unreadable" else "unitLeftActive"])
                self.assertEqual(self.service_commands(), [])

    def test_relaunch_verdict_rejects_scope_writer_and_generation_changes(self):
        for mutation in ["scope-replaced", "scope-inactive", "scope-unreadable", "writer-replaced", "generation"]:
            with self.subTest(mutation=mutation):
                self.setUp()
                group = self.helper_groups()[0]
                if mutation == "generation":
                    self.parents[150] = 102
                    self.pgroups[150] = 102
                    self.members += [150]

                def mutate():
                    if mutation == "scope-replaced":
                        group["scope"]["InvocationID"] = "e" * 32
                    elif mutation == "scope-inactive":
                        group["scope"]["ActiveState"] = "inactive"
                    elif mutation == "scope-unreadable":
                        del group["scope"]["LoadState"]
                    elif mutation == "writer-replaced":
                        exit_file = group["row"]["host"]["exitWriter"]["exitFile"]
                        deploy.write_json(exit_file.replace(".exit.json", ".writer.json"), {"pid": 7001})

                self.answer_relaunch(after=mutate)
                result = deploy.run_switch(self.adapter, TARGET, samples=2, interval=1, timeout=5)
                proof = result["relaunch"]
                self.assertEqual(result["verdict"], "needs_decision" if mutation == "scope-unreadable" else "fail")
                if mutation == "scope-unreadable":
                    self.assertTrue(proof["custodyUnknown"])
                elif mutation == "writer-replaced":
                    self.assertTrue(proof["custodyChanged"])
                elif mutation == "generation":
                    self.assertEqual(proof["generationSurvivors"], [
                        {"pid": 150, "startIdentity": "150", "reason": "generation survivor"}])
                else:
                    self.assertEqual(proof["scopeStopped"], [group["scope"]["Id"]])
                self.assertEqual(self.service_commands(), [])

    def test_relaunch_requires_receipts_for_all_signal_shaped_host_exits(self):
        for turn_state, exit_record, has_receipt, expected, custody_changed, custody_unknown in [
            ("busy", {"code": None, "signal": "SIGTERM"}, True, "fail", True, False),
            ("unknown", {"code": None, "signal": "SIGTERM"}, True, "needs_decision", False, True),
            ("idle", {"code": None, "signal": "SIGTERM"}, True, "pass", False, False),
            ("busy", {"code": 0, "signal": "EOF"}, False, "pass", False, False),
            ("busy", {"code": 143, "signal": None}, True, "fail", True, False),
            ("unknown", {"code": 143, "signal": None}, True, "needs_decision", False, True),
            ("busy", {"code": 137, "signal": None}, True, "fail", True, False),
            ("unknown", {"code": 137, "signal": None}, True, "needs_decision", False, True),
            ("busy", {"code": 143, "signal": "EOF"}, True, "fail", True, False),
            ("idle", {"code": 143, "signal": None}, False, "fail", True, False),
            ("idle", {"code": 137, "signal": None}, False, "fail", True, False),
            ("unknown", {"code": 143, "signal": None}, False, "fail", True, False),
            ("idle", {"code": 143, "signal": None}, True, "pass", False, False),
            ("idle", {"code": 0, "signal": None}, False, "pass", False, False),
            ("idle", {"code": 0, "signal": 9}, False, "pass", False, False),
        ]:
            with self.subTest(turn_state=turn_state, exit_record=exit_record, has_receipt=has_receipt):
                self.setUp()
                group = self.helper_groups()[0]
                group["row"]["turnState"] = turn_state
                group["row"]["pipeline"] = {"pipelineId": "synthetic-lane", "stageId": "build", "attempt": 1}
                original_alive = self.adapter.identity_alive
                stopped = {"value": False}

                def stop_host():
                    before = next(iter(self.adapter.relaunch_hosts.values()))
                    slots = before["slots"]
                    if has_receipt:
                        deploy.write_json(slots["stop"], {
                            "active": 1, "path": "startup-adoption-cleanup", "signal": "SIGTERM"})
                    deploy.write_json(slots["exit"], exit_record)
                    stopped["value"] = True
                    self.attempts = [{"n": 2, "state": "running", "conversationId": "synthetic-stage"}]

                def identity_alive(entry):
                    if stopped["value"] and entry["pid"] == group["host"]:
                        return False
                    return original_alive(entry)

                self.adapter.identity_alive = identity_alive
                self.answer_relaunch(after=stop_host)
                result = deploy.run_switch(self.adapter, TARGET, samples=2, interval=1, timeout=5)
                self.assertEqual(result["verdict"], expected)
                custody = result["relaunch"]["hosts"][0]
                self.assertEqual(custody["exit"]["stopPath"], "startup-adoption-cleanup" if has_receipt else None)
                self.assertEqual(result["relaunch"]["custodyChanged"], custody_changed)
                self.assertEqual(result["relaunch"]["custodyUnknown"], custody_unknown)
                self.assertEqual(self.service_commands(), [])

    def test_relaunch_admits_the_captured_attempts_settlement_stop(self):
        attempt = {"n": 1, "state": "passed", "conversationId": "synthetic-stage", "launchId": "fixture-launch"}
        receipt = {"active": 1, "path": "pipeline-stage-stop", "operationId": "fixture-launch:build:1",
                   "signal": "SIGTERM"}
        signalled = {"signal": "SIGTERM"}
        for name, exit_record, stop, attempts, outcome, verdict in [
            ("signal", signalled, receipt, [attempt], "completed", "pass"),
            ("signal code", {"code": 143}, receipt, [attempt], "completed", "pass"),
            ("after final sample", signalled, receipt, [attempt], "completed", "pass"),
            ("withdrawn", signalled, {**receipt, "active": 0}, [attempt], "completed", "fail"),
            ("prior receipt", signalled, {"active": 0, "prior": receipt}, [attempt], "completed", "pass"),
            ("startup", signalled, {**receipt, "path": "startup-retained-host-release"}, [attempt], "completed", "fail"),
            ("other stage", signalled, {**receipt, "operationId": "fixture-launch:other:1"}, [attempt], "completed", "fail"),
            ("other attempt", signalled, {**receipt, "operationId": "fixture-launch:build:2"}, [attempt], "completed", "fail"),
            ("other launch", signalled, {**receipt, "operationId": "other-launch:build:1"}, [attempt], "completed", "fail"),
            ("other conversation", signalled, receipt, [{**attempt, "conversationId": "other"}], "completed", "fail"),
            ("other signal", {"code": 137}, receipt, [attempt], "completed", "fail"),
            ("missing receipt", signalled, None, [attempt], "completed", "fail"),
            ("lost", signalled, receipt, [{**attempt, "state": "failed", "error": "stage host was lost"}], "lost", "fail"),
            ("reported failure", signalled, receipt, [{**attempt, "state": "failed", "verdict": "fail"}],
             "completed", "pass"),
            ("interrupted", signalled, receipt, [{**attempt, "state": "needs_decision", "error": "operator stopped the stage"}],
             "completed", "fail"),
            ("replacement", signalled, receipt, [attempt, {**attempt, "n": 2}], "completed", "fail"),
        ]:
            with self.subTest(name=name):
                self.setUp()
                group = self.helper_groups()[0]
                group["row"].update(conversationId=attempt["conversationId"],
                                    pipeline={"pipelineId": "synthetic-lane", "stageId": "build", "attempt": 1})
                host_exited = False
                original_read = self.adapter.process_read

                def process_read(pid, field):
                    if host_exited and pid == group["host"]:
                        raise FileNotFoundError("captured host exited")
                    return original_read(pid, field)

                self.adapter.process_read = process_read

                def stop_host():
                    nonlocal host_exited
                    slots = next(iter(self.adapter.relaunch_hosts.values()))["slots"]
                    if stop is not None:
                        deploy.write_json(slots["stop"], stop)
                    deploy.write_json(slots["exit"], exit_record)
                    host_exited = True
                    self.attempts = attempts

                if name == "after final sample":
                    interrupted = self.adapter.interrupted

                    def read_interrupted(since, hosts):
                        stop_host()
                        return interrupted(since, hosts)

                    self.adapter.interrupted = read_interrupted
                    self.answer_relaunch()
                else:
                    self.answer_relaunch(after=stop_host)
                result = deploy.run_switch(self.adapter, TARGET, samples=2, interval=1, timeout=5)
                self.assertEqual(result["relaunch"]["result"], "done")
                self.assertFalse(result["relaunch"]["hosts"][0]["alive"])
                self.assertEqual(result["protected"][0]["outcome"], outcome)
                self.assertEqual(result["relaunch"]["custodyChanged"], verdict == "fail")
                self.assertFalse(result["relaunch"]["custodyUnknown"])
                self.assertEqual(result["verdict"], verdict)
                self.assertEqual(self.service_commands(), [])

    def test_a_stale_or_wrong_launcher_receipt_cannot_settle_relaunch(self):
        for field, value in [("requestId", "foreign"), ("launcherPid", 900), ("launcherIdentity", "reused"),
                             ("revision", OLD), ("target", OLD)]:
            with self.subTest(field=field):
                self.setUp()
                def corrupt_receipt():
                    receipt = json.loads(self.adapter.result_file.read_bytes())
                    deploy.write_json(self.adapter.result_file, {**receipt, field: value})
                self.answer_relaunch(after=corrupt_receipt)
                result = deploy.run_switch(self.adapter, TARGET, samples=1, interval=0, timeout=5)
                self.assertEqual(result["verdict"], "needs_decision")
                self.assertEqual(result["relaunch"]["result"], "unsettled")
                self.assertEqual(result["serving"]["viewer"]["sha"], TARGET)
                self.assertEqual(self.service_commands(), [])

    def test_census_capture_and_generation_do_not_call_the_viewer(self):
        # Baseline health remains its own MCP gate. The protected capture and
        # retirement refresh have an independent injected census transport.
        observed = self.adapter.serving()
        self.adapter.serving = lambda: observed
        with patch.object(self.adapter.mcp, "call", side_effect=AssertionError("Viewer unavailable")), patch.dict(os.environ, {"LLV_VIEWER_CONTROL_URL": "http://127.0.0.1:1"}):
            self.adapter.preflight()
            self.adapter.generation(self.service_group)
        self.assertIn(104, self.adapter.agents)
        self.assertEqual(self.service_commands(), [])

    def test_standalone_merger_is_recorded_before_stop_and_needs_its_own_receipt(self):
        for case_index, (has_receipt, turn_state) in enumerate(((False, "busy"), (True, "busy"), (False, "idle"))):
            with self.subTest(has_receipt=has_receipt, turn_state=turn_state):
                if case_index:
                    self.adapter.close()
                    self.doCleanups()
                    self.setUp()
                self.relocating()
                conversation = "conversation_merger"
                process = {"pid": 104, "startIdentity": "104:104", "bootEpoch": "fixture-boot"}
                merger = {"conversationId": conversation, "engine": "codex", "sessionId": "fixture-merger",
                          "path": str(self.root / "merger.jsonl"), "claimEpoch": 2, "process": process,
                          "writer": {"pid": 102, "startIdentity": "102:102", "bootEpoch": "fixture-boot"}, "batch": None}
                row = {"conversationId": conversation, "host": {"kind": "structured", "state": "alive", "pid": 104,
                                                                "process": process},
                       "turnState": turn_state, "evidenceSource": "transcript", "pipeline": None, "merger": merger}
                # The merger started after preflight. The final census must
                # both persist it and add it to the switch verdict.
                self.inventory_overrides = lambda n: {"conversations": [row]} if n > 1 else {
                    "conversations": [], "selection": {"matched": 0, "selected": 0, "recoveryPending": 0,
                                                        "recoveryTruncated": False}}
                self.recovery_overrides = {"conversations": [{**row, "host": {"kind": "structured", "state": "alive", "pid": 204},
                                                              "lifecycle": "working"}]}
                self.merger_delivery = {"conversationId": conversation, "transcriptPath": merger["path"],
                                        "deliverable": True, "processRecorded": True}
                observations = []
                def observed(command, cwd=None):
                    if command[:4] == ["systemctl", "--user", "--no-block", "stop"]:
                        capture = self.state / deploy.CHECKOUT_MERGER_CAPTURE
                        self.assertEqual(capture.stat().st_mode & 0o777, 0o600)
                        record, = json.loads(capture.read_text())
                        observations.append(record)
                        if has_receipt:
                            directory = self.state / "interruption-obligations"
                            directory.mkdir()
                            deploy.write_json(directory / "interruption-continuation-fixture.json", {
                                "version": 1, "id": "fixture", "conversationId": conversation, "engine": "codex",
                                "hostKey": "codex:fixture-merger", "path": merger["path"],
                                "reason": "viewer-restart", "state": "delivered", "boundary": record["boundary"],
                                "recordedAt": record["capturedAt"], "checkpoint": {},
                            })
                    return self.execute(command, cwd)
                self.adapter.command = observed
                # Turn admission may begin after final census and generation
                # capture. The retained quiet custody row must still be armed.
                original_generation = self.adapter.generation
                def generation_with_late_turn(group, rows=None):
                    captured = original_generation(group, rows)
                    row["turnState"] = turn_state
                    row["merger"]["turnState"] = turn_state
                    return captured
                self.adapter.generation = generation_with_late_turn
                result = deploy.run_switch(self.adapter, TARGET, samples=3, interval=2, timeout=5)
                self.assertEqual(len(observations), 1)
                self.assertEqual(observations[0]["conversationId"], conversation)
                reader = subprocess.run(["bun", "-e",
                    "import { readCheckoutMergerCuts } from './src/lib/runtime/checkoutMergerRecovery.ts'; "
                    "console.log(JSON.stringify(readCheckoutMergerCuts(process.argv[1])))",
                    str(self.state)], cwd=pathlib.Path(__file__).resolve().parents[1],
                    check=True, capture_output=True, text=True, timeout=15)
                self.assertEqual(json.loads(reader.stdout)[0]["boundary"], observations[0]["boundary"])
                expected = "recovered" if has_receipt else "unknown"
                self.assertEqual(result["protected"], [{"kind": "standalone-merger", "conversationId": conversation,
                                                         "outcome": expected}])
                self.assertEqual(result["verdict"], "pass" if has_receipt else "needs_decision")
                self.assertLessEqual(len((self.state / deploy.CHECKOUT_MERGER_CAPTURE).read_bytes()), deploy.CHECKOUT_MERGER_MAX_BYTES)

    def test_oversized_merger_inventory_refuses_stop(self):
        rows = [{"merger": {"conversationId": f"conversation_{n}", "engine": "claude",
            "sessionId": "x", "path": "/tmp/x", "claimEpoch": 1,
            "process": {"pid": 1, "startIdentity": "1:1", "bootEpoch": self.adapter.boot_epoch},
            "writer": {"pid": 2, "startIdentity": "2:2", "bootEpoch": self.adapter.boot_epoch},
            "batch": None, "payload": "x" * 5000}, "conversationId": f"conversation_{n}",
            "host": {"state": "alive", "kind": "structured", "pid": 1}, "turnState": "busy",
            "evidenceSource": "transcript", "pipeline": None} for n in range(150)]
        rows[0]["merger"]["conversationId"] = rows[0]["conversationId"] = "conversation_fixture"
        self.adapter.merger_observed_at = deploy.utc()
        self.adapter.census = lambda *args, **kwargs: {"conversations": rows, "unselectedCount": 0,
            "selection": {"matched": len(rows), "selected": len(rows), "recoveryPending": 0,
                "recoveryTruncated": False, "cacheStatus": "fresh", "projected": 0, "unreadable": 0}}
        self.adapter.placement = lambda: {"actual": self.service_group, "expected": self.service_group}
        self.adapter.generation = lambda group, census=None: {}
        emitted = []
        self.adapter.emit = emitted.append
        with self.assertRaisesRegex(RuntimeError, "named service start refused"):
            self.adapter.relocate()
        result = self.adapter.relocation
        self.assertFalse(result["stopSubmitted"])
        self.assertEqual(result["outcome"], "stop-incomplete")
        self.assertIn("relocation:RuntimeError", result["diagnostics"])
        self.assertEqual(self.service_commands(), [])
        self.assertIn("relocation:RuntimeError", emitted[0]["relocation"]["diagnostics"])

    def test_final_idle_merger_is_positive_settlement_evidence(self):
        conversation = "conversation_settled_merger"
        host = {"conversationId": conversation, "kind": "standalone-merger", "pid": 104,
                "startIdentity": "104:104", "merger": {"turnState": "idle"}}
        self.recovery_overrides = {"conversations": [{"conversationId": conversation, "turnState": "idle",
            "pipeline": None, "evidenceSource": "transcript",
            "host": {"kind": "structured", "state": "dead", "pid": 104}}]}
        self.assertEqual(self.adapter.stage(host), {
            "kind": "standalone-merger", "conversationId": conversation, "outcome": "unknown"})

    def test_idle_deliverable_successor_is_recovered_when_checkout_receipt_is_present(self):
        conversation = "conversation_idle_recovered_merger"
        host = {"conversationId": conversation, "kind": "standalone-merger", "pid": 104,
                "startIdentity": "104:104", "merger": {"path": str(self.root / "merger.jsonl")}}
        self.recovery_overrides = {"conversations": [{"conversationId": conversation, "turnState": "idle",
            "lifecycle": "running", "pipeline": None, "evidenceSource": "transcript",
            "host": {"kind": "structured", "state": "alive", "pid": 204}}]}
        self.merger_delivery = {"conversationId": conversation, "transcriptPath": host["merger"]["path"],
                                "deliverable": True, "processRecorded": True}
        self.assertEqual(self.adapter.stage(host), {
            "kind": "standalone-merger", "conversationId": conversation, "outcome": "recovered"})

    def test_merger_admitted_during_stop_is_cut_from_its_retired_exit_record(self):
        self.relocating()
        conversation = "conversation_late_retired_merger"
        process = {"pid": 104, "startIdentity": "104:104", "bootEpoch": self.adapter.boot_epoch}
        merger = {"conversationId": conversation, "engine": "codex", "sessionId": "late-merger",
                  "path": str(self.root / "late-merger.jsonl"), "claimEpoch": 3, "process": process,
                  "writer": None, "batch": None, "turnState": "busy"}
        retired = {"conversationId": conversation, "host": {"kind": "structured", "state": "gone",
                   "pid": process["pid"], "process": process}, "turnState": "busy", "evidenceSource": "transcript",
                   "pipeline": None, "merger": merger}
        # Preflight and the immediate pre-stop census stay empty. The retired
        # receipt appears only after the named stop has settled.
        self.inventory_overrides = lambda n: {"conversations": [retired] if n >= 3 else [],
            "selection": {"matched": 1 if n >= 3 else 0, "selected": 1 if n >= 3 else 0, "recoveryPending": 0,
                          "recoveryTruncated": False, "cacheStatus": "fresh", "projected": 0, "unreadable": 0}}
        self.recovery_overrides = {"conversations": [{"conversationId": conversation, "turnState": "busy",
            "lifecycle": "working", "pipeline": None, "evidenceSource": "transcript",
            "host": {"kind": "structured", "state": "alive", "pid": 204}}]}
        self.merger_delivery = {"conversationId": conversation, "transcriptPath": merger["path"],
                                "deliverable": True, "processRecorded": True}
        original_command = self.adapter.command
        def retire_during_submission(command, cwd=None):
            result = original_command(command, cwd)
            if command[:4] == ["systemctl", "--user", "--no-block", "stop"]:
                self.adapter.interrupted = lambda since, hosts: ([{"kind": "standalone-merger",
                    "conversationId": conversation, "boundary": self.adapter.merger_boundary,
                    "state": "delivered"}], [])
            return result
        self.adapter.command = retire_during_submission
        self.adapter.generation = lambda group, rows=None: {}
        result = deploy.run_switch(self.adapter, TARGET, samples=3, interval=2, timeout=2)
        captured, = json.loads((self.state / deploy.CHECKOUT_MERGER_CAPTURE).read_text())
        self.assertEqual(captured["conversationId"], conversation)
        self.assertEqual(captured["process"], process)
        self.assertEqual(captured["writer"], None)
        reader = subprocess.run(["bun", "-e",
            "import { readCheckoutMergerCuts } from './src/lib/runtime/checkoutMergerRecovery.ts'; "
            + "console.log(JSON.stringify(readCheckoutMergerCuts(process.argv[1])))",
            str(self.state)], cwd=pathlib.Path(__file__).resolve().parents[1],
            check=True, capture_output=True, text=True, timeout=15)
        self.assertEqual(json.loads(reader.stdout)[0]["boundary"], captured["boundary"])
        self.assertEqual(result["protected"], [{"kind": "standalone-merger", "conversationId": conversation,
                                                 "outcome": "recovered"}],
                         json.dumps({"protected": result["protected"], "interrupted": result["interrupted"],
                                     "diagnostics": result["diagnostics"], "delivery": self.merger_delivery}))
        self.assertEqual(result["verdict"], "pass", json.dumps({"relocation": result["relocation"],
            "serving": result["serving"], "diagnostics": result["diagnostics"], "protected": result["protected"]}))

    def test_empty_census_still_validates_retained_successor_inventory_before_stop(self):
        destination = self.state / deploy.CHECKOUT_MERGER_CAPTURE
        destination.write_text(json.dumps([{"conversationId": "conversation_bad", "engine": "codex", "sessionId": "old", "path": str(self.root / "old.jsonl"), "claimEpoch": 2, "process": {"pid": 104, "startIdentity": "104:104", "bootEpoch": "fixture-boot"}, "writer": {"pid": "bad", "startIdentity": "invalid"}, "batch": None, "capturedAt": (deploy.parse_time(deploy.utc()) - deploy.datetime.timedelta(minutes=16)).isoformat(), "boundary": "checkout-merger:" + "a" * 32}]))
        self.inventory_overrides = {"conversations": []}
        self.relocating()
        self.adapter.generation = lambda group, rows=None: {}
        result = deploy.run_switch(self.adapter, TARGET, samples=1, timeout=1)
        self.assertFalse(result["relocation"]["stopSubmitted"])
        self.assertEqual(self.service_commands(), [])
        self.assertEqual(result["verdict"], "fail")

    def test_empty_census_retains_an_expired_identity_fence(self):
        legacy = {"conversationId": "conversation_legacy", "engine": "codex", "sessionId": "old",
                  "path": str(self.root / "old.jsonl"), "claimEpoch": 2,
                  "process": {"pid": 104, "startIdentity": "104:104", "bootEpoch": "fixture-boot"},
                  "writer": None, "batch": None,
                  "capturedAt": (deploy.parse_time(deploy.utc()) - deploy.datetime.timedelta(minutes=16)).isoformat(),
                  "boundary": "checkout-merger:" + "a" * 32}
        destination = self.state / deploy.CHECKOUT_MERGER_CAPTURE
        destination.write_text(json.dumps([legacy]))
        self.adapter.custody_rows = []
        self.adapter.merger_observed_at = deploy.utc()
        self.adapter.arm_merger_recovery()
        self.assertEqual(json.loads(destination.read_text()), [legacy])

    def test_successor_inventory_rejects_omitted_contract_fields_before_stop(self):
        for index, missing in enumerate(("writer", "batch")):
            if index:
                self.adapter.close()
                self.doCleanups()
                self.setUp()
            complete = {"conversationId": "conversation_missing_field", "engine": "codex", "sessionId": "old",
                        "path": str(self.root / "old.jsonl"), "claimEpoch": 2,
                        "process": {"pid": 104, "startIdentity": "104:104", "bootEpoch": "fixture-boot"},
                        "writer": None, "batch": None, "capturedAt": deploy.utc(),
                        "boundary": "checkout-merger:" + "a" * 32}
            with self.subTest(missing=missing):
                row = {key: value for key, value in complete.items() if key != missing}
                (self.state / deploy.CHECKOUT_MERGER_CAPTURE).write_text(json.dumps([row]))
                self.inventory_overrides = {"conversations": []}
                self.relocating()
                result = deploy.run_switch(self.adapter, TARGET, samples=1, timeout=1)
                self.assertFalse(result["relocation"]["stopSubmitted"])
                self.assertEqual(self.service_commands(), [])
                self.assertEqual(result["verdict"], "fail")

    def test_future_previous_merger_cut_refuses_stop_before_successor_inventory_write(self):
        conversation = "conversation_clock_step"
        destination = self.state / deploy.CHECKOUT_MERGER_CAPTURE
        process = {"pid": 104, "startIdentity": "104:104", "bootEpoch": self.adapter.boot_epoch}
        previous = {"conversationId": "conversation_previous_cut", "engine": "codex", "sessionId": "fixture-merger",
                    "path": str(self.root / "merger.jsonl"), "claimEpoch": 2, "process": process,
                    "writer": {"pid": 102, "startIdentity": "102:102", "bootEpoch": self.adapter.boot_epoch},
                    "batch": None, "capturedAt": "2099-01-01T00:00:00Z",
                    "boundary": "checkout-merger:" + "a" * 32, "admissionProof": "fresh-cut-v1"}
        destination.write_text(json.dumps([previous]))
        self.adapter.merger_observed_at = "2026-11-20T00:00:00Z"
        current = {**previous, "conversationId": conversation, "capturedAt": "2026-11-20T00:00:00Z",
                   "boundary": "checkout-merger:" + "b" * 32}
        self.adapter.custody_rows = [{"conversationId": conversation, "merger": current}]
        self.adapter.census = lambda *args, **kwargs: {"conversations": [{"conversationId": conversation,
            "host": {"kind": "structured", "state": "alive", "pid": 104, "process": process},
            "turnState": "busy", "pipeline": None, "evidenceSource": "transcript", "merger": current}],
            "unselectedCount": 0, "selection": {"matched": 1, "selected": 1, "recoveryPending": 0,
                "recoveryTruncated": False, "cacheStatus": "fresh", "projected": 0, "unreadable": 0}}
        self.adapter.placement = lambda: {"actual": self.service_group, "expected": self.service_group}
        self.adapter.generation = lambda group, rows=None: {}
        with self.assertRaisesRegex(RuntimeError, "named service start refused"):
            self.adapter.relocate()
        self.assertEqual(self.service_commands(), [])
        self.assertEqual(json.loads(destination.read_text()), [previous])

    def test_merger_admitted_during_stop_submission_gets_a_durable_cut(self):
        self.relocating()
        conversation = "conversation_late_merger"
        process = {"pid": 104, "startIdentity": "104:104", "bootEpoch": self.adapter.boot_epoch}
        merger = {"conversationId": conversation, "engine": "claude", "sessionId": "late-merger",
                  "path": str(self.root / "late-merger.jsonl"), "claimEpoch": 2, "process": process,
                  "writer": {"pid": 102, "startIdentity": "102:102", "bootEpoch": self.adapter.boot_epoch}, "batch": None}
        row = {"conversationId": conversation, "host": {"kind": "structured", "state": "alive", "pid": 104,
                "process": process}, "turnState": "busy", "evidenceSource": "transcript", "pipeline": None, "merger": merger}
        self.inventory_overrides = lambda n: {"conversations": [row] if n >= 3 else [],
            "selection": {"matched": 1 if n >= 3 else 0, "selected": 1 if n >= 3 else 0,
                "recoveryPending": 0, "recoveryTruncated": False}}
        observed_boundaries = []
        census = self.adapter.census
        def bounded_census(timeout=30, cut_boundary=None):
            observed_boundaries.append(cut_boundary)
            return census(timeout, cut_boundary)
        self.adapter.census = bounded_census
        self.recovery_overrides = {"conversations": [{"conversationId": conversation, "turnState": "busy",
            "pipeline": None, "evidenceSource": "transcript", "host": {"kind": "structured", "state": "dead", "pid": 104}}]}
        result = deploy.run_switch(self.adapter, TARGET, samples=1, interval=1, timeout=2)
        cuts = json.loads((self.state / deploy.CHECKOUT_MERGER_CAPTURE).read_text())
        self.assertEqual([cut["conversationId"] for cut in cuts], [conversation])
        self.assertEqual(cuts[0]["admissionProof"], "fresh-cut-v1")
        self.assertTrue(any(boundary is not None for boundary in observed_boundaries))
        self.assertEqual(result["protected"][0]["outcome"], "unknown")
        self.assertEqual(result["verdict"], "needs_decision")

    def test_weaker_post_stop_observation_keeps_durable_merger_custody(self):
        conversation = "conversation_weaker_observation"
        process = {"pid": 104, "startIdentity": "104:104", "bootEpoch": self.adapter.boot_epoch}
        writer = {"pid": 102, "startIdentity": "102:102", "bootEpoch": self.adapter.boot_epoch}
        batch_directory = self.root / "batch"
        batch_directory.mkdir()
        batch_state = batch_directory / "tmp" / "merge-batch.json"
        batch_state.parent.mkdir()
        branch = f"merge-batch/{uuid.UUID(int=2, version=4)}"
        batch_state.write_text(json.dumps({"version": 3, "branch": branch,
                                           "landed": False, "rows": [{"status": "pending"}]}))
        (batch_state.parent / "merge-batch.json.lock").mkdir()
        batch_identity = f"{batch_directory.stat().st_dev}:{batch_directory.stat().st_ino}"
        merger = {"conversationId": conversation, "engine": "codex", "sessionId": "fixture-merger",
                  "path": str(self.root / "merger.jsonl"), "claimEpoch": 2, "process": process,
                  "writer": writer, "batch": {"directory": str(batch_directory), "identity": batch_identity,
                                                  "branch": branch}, "turnState": "busy"}
        durable = {"conversationId": conversation, "host": {"kind": "structured", "state": "gone",
                   "pid": 104, "process": process}, "turnState": "busy", "evidenceSource": "transcript",
                   "pipeline": None, "merger": merger}
        weak = {"conversationId": conversation, "host": {"kind": "structured", "state": "unknown",
                "pid": None, "process": None}, "turnState": "unknown", "evidenceSource": "transcript",
                "pipeline": None, "merger": None}
        answers = iter([{"conversations": [durable], "unselectedCount": 0,
                         "selection": {"matched": 1, "selected": 1, "recoveryPending": 0,
                                       "recoveryTruncated": False, "cacheStatus": "fresh", "projected": 0, "unreadable": 0}},
                        {"conversations": [weak], "unselectedCount": 0,
                         "selection": {"matched": 1, "selected": 1, "recoveryPending": 0,
                                       "recoveryTruncated": False, "cacheStatus": "fresh", "projected": 0, "unreadable": 0}}])
        self.adapter.census = lambda *args, **kwargs: next(answers)
        self.adapter.custody_rows = [durable]
        self.adapter.merger_observed_at = deploy.utc()
        self.adapter.placement = lambda: {"actual": self.service_group, "expected": self.service_group}
        self.adapter.generation = lambda group, rows=None: {}
        self.adapter.await_release = lambda group, timeout: True
        self.adapter.command = lambda command, cwd=None: ""
        self.adapter.jobs = lambda: []
        self.adapter.active_state = lambda: "inactive"
        self.adapter.start = lambda relocation: relocation.update({"started": True, "startAttempts": 1})
        self.adapter.emit = lambda event: None
        result = self.adapter.relocate()
        protected, = self.adapter.merger_hosts(self.adapter.custody_rows)
        self.assertEqual(protected["conversationId"], conversation)
        saved, = json.loads((self.state / deploy.CHECKOUT_MERGER_CAPTURE).read_text())
        self.assertEqual(saved["writer"], writer)
        self.assertEqual(saved["batch"], {"directory": str(batch_directory), "identity": batch_identity, "branch": branch})
        successor = subprocess.run(["bun", "-e",
            "import { readCheckoutMergerCuts, checkoutBatchState } from './src/lib/runtime/checkoutMergerRecovery.ts'; "
            + "const [cut] = readCheckoutMergerCuts(process.argv[1]); "
            + "console.log(JSON.stringify({writer: cut.writer, batch: checkoutBatchState(cut.batch.directory, cut.batch.identity, cut.batch.branch)}))",
            str(self.state)], cwd=pathlib.Path(__file__).resolve().parents[1],
            check=True, capture_output=True, text=True, timeout=15)
        self.assertEqual(json.loads(successor.stdout), {"writer": writer,
            "batch": {"branch": branch, "locked": True, "finished": False, "active": True}})
        self.adapter.mcp.call = lambda tool, args: {"conversations": [weak], "unselectedCount": 0,
            "selection": {"matched": 1, "selected": 1, "recoveryPending": 0, "recoveryTruncated": False,
                          "cacheStatus": "fresh", "projected": 0, "unreadable": 0}}
        self.assertEqual(self.adapter.stage(protected)["outcome"], "unknown")
        self.assertEqual(result["outcome"], "released")

    def test_final_census_failure_leaves_the_original_service_running(self):
        self.relocating()
        self.inventory_overrides = lambda n: {"undescribedHostCount": 1} if n > 1 else {}
        result = deploy.run_switch(self.adapter, TARGET, samples=1, interval=1, timeout=1)
        self.assertEqual(result["verdict"], "fail")
        self.assertFalse(result["relocation"]["stopSubmitted"])
        self.assertEqual(self.service_commands(), [])

    def test_census_failure_refuses_preflight_without_publication(self):
        for answer in [None, [], {"conversations": []}]:
            with self.subTest(answer=answer):
                self.adapter.census_adapter = lambda *args: answer
                with self.assertRaises((RuntimeError, AttributeError)):
                    self.adapter.preflight()
                self.assertEqual(json.loads(self.pointer.read_text()), self.baseline)
                self.assertEqual(self.service_commands(), [])

                output, errors = io.StringIO(), io.StringIO()
                with patch.object(deploy, "Checkout", return_value=self.adapter), patch.object(sys, "argv", ["deploy-checkout.py", "--preflight", "--config", str(self.plan)]), contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
                    self.assertEqual(deploy.main(), 2)
                self.assertEqual(output.getvalue(), "")
                self.assertEqual(json.loads(self.pointer.read_text()), self.baseline)
                self.assertEqual(self.service_commands(), [])

    def test_contradictory_real_census_child_refuses_preflight_without_publication(self):
        self.assertIsNotNone(CENSUS_BUN, "census child tests require Bun")
        with tempfile.TemporaryDirectory(prefix="census-preflight-") as root:
            release = pathlib.Path(root)
            (release / "scripts").mkdir()
            answer = {"targetRevision": TARGET, "registryRevision": 1, "observedAt": "2026-01-01T00:00:00Z",
                      "conversations": [], "unselectedCount": 0, "undescribedHostCount": 0,
                      "selection": {"matched": 1, "selected": 1, "recoveryPending": 0,
                                    "recoveryTruncated": False, "cacheStatus": "hit", "projected": 0, "unreadable": 0}}
            (release / "scripts/protected-host-census.ts").write_text(
                "console.log(" + json.dumps(json.dumps(answer)) + ");")
            self.adapter.census_adapter = lambda _release, _bun, state, target, timeout: deploy.protected_host_census(
                release, CENSUS_BUN, state, target, timeout)
            self.adapter.clock.sleep = lambda seconds: setattr(self.adapter.clock, "value", 30)
            output, errors = io.StringIO(), io.StringIO()
            with patch.object(deploy, "Checkout", return_value=self.adapter), \
                    patch.object(sys, "argv", ["deploy-checkout.py", "--preflight", "--config", str(self.plan)]), \
                    contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
                self.assertEqual(deploy.main(), 2)
            self.assertEqual(output.getvalue(), "")
            self.assertEqual(errors.getvalue(), "Procedure stopped: RuntimeError\n")
            self.assertEqual(json.loads(self.pointer.read_text()), self.baseline)
            self.assertEqual(self.service_commands(), [])

    def test_real_census_child_missing_pipeline_refuses_preflight_without_publication(self):
        self.assertIsNotNone(CENSUS_BUN, "census child tests require Bun")
        with tempfile.TemporaryDirectory(prefix="census-preflight-missing-pipeline-") as root:
            release = pathlib.Path(root)
            (release / "scripts").mkdir()
            answer = {"targetRevision": TARGET, "registryRevision": 1, "observedAt": "2026-01-01T00:00:00Z",
                      "conversations": [{"conversationId": "conversation_protected",
                                         "host": {"state": "alive", "kind": "structured", "pid": 104},
                                         "turnState": "busy", "lifecycle": "running", "evidenceSource": "transcript"}],
                      "unselectedCount": 0, "undescribedHostCount": 0,
                      "selection": {"matched": 1, "selected": 1, "recoveryPending": 0,
                                    "recoveryTruncated": False, "cacheStatus": "hit", "projected": 0, "unreadable": 0}}
            (release / "scripts/protected-host-census.ts").write_text(
                "console.log(" + json.dumps(json.dumps(answer)) + ");")
            self.adapter.census_adapter = lambda _release, _bun, state, target, timeout: deploy.protected_host_census(
                release, CENSUS_BUN, state, target, timeout)
            output, errors = io.StringIO(), io.StringIO()
            with patch.object(deploy, "Checkout", return_value=self.adapter), \
                    patch.object(sys, "argv", ["deploy-checkout.py", "--preflight", "--config", str(self.plan)]), \
                    contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
                self.assertEqual(deploy.main(), 2)
            self.assertEqual(output.getvalue(), "")
            self.assertEqual(errors.getvalue(), "Procedure stopped: RuntimeError\n")
            self.assertEqual(json.loads(self.pointer.read_text()), self.baseline)
            self.assertEqual(self.service_commands(), [])

    def test_baseline_readiness_failure_names_only_the_failed_checks(self):
        observed = self.adapter.serving()
        observed["checks"].update({"mcp": False, "http": False})
        self.adapter.serving = lambda: observed
        with self.assertRaises(deploy.BaselineReadinessError) as failure:
            self.adapter.preflight()
        self.assertEqual(failure.exception.checks, ["http", "mcp"])
        output = io.StringIO()
        with patch.object(deploy, "Checkout", return_value=self.adapter), patch.object(sys, "argv", ["deploy-checkout.py", "--preflight", "--config", str(self.plan)]), contextlib.redirect_stderr(output):
            self.assertEqual(deploy.main(), 2)
        self.assertEqual(output.getvalue(), "Procedure stopped: http, mcp\n")
        self.assertEqual(json.loads(self.pointer.read_text()), self.baseline)
        self.assertEqual(self.service_commands(), [])

    def test_baseline_process_identity_failures_name_their_readiness_check(self):
        cases = [
            # An unreadable launcher is represented by serving() as no SHA and
            # unhealthy; this used to produce an empty public refusal.
            ("launcher", {"sha": None, "healthy": False}, "service"),
            ("viewer", {"sha": "f" * 40}, "http"),
        ]
        for role, changes, expected in cases:
            with self.subTest(role=role):
                observed = self.adapter.serving()
                observed["checks"] = {"http": True, "runtimeSocket": True, "mcp": True, "service": True}
                for process in [observed["launcher"], observed["viewer"], observed["runtimeHost"]]:
                    process.update({"sha": self.baseline["sha"], "healthy": True})
                observed[role].update(changes)
                self.adapter.serving = lambda observed=observed: observed

                output, errors = io.StringIO(), io.StringIO()
                with patch.object(deploy, "Checkout", return_value=self.adapter), patch.object(
                        sys, "argv", ["deploy-checkout.py", "--preflight", "--config", str(self.plan)]), \
                        contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
                    self.assertEqual(deploy.main(), 2)

                self.assertEqual(output.getvalue(), "")
                self.assertEqual(errors.getvalue(), f"Procedure stopped: {expected}\n")
                self.assertNotIn("FileNotFoundError", errors.getvalue())
                self.assertEqual(json.loads(self.pointer.read_text()), self.baseline)
                self.assertEqual(self.service_commands(), [])

    @property
    def expected_group(self):
        return self.slice_group + "/synthetic-viewer.service"

    def write_old_group(self):
        directory = self.cgroup / self.old_group.lstrip("/")
        if self.surviving or self.never_released:
            directory.mkdir(parents=True, exist_ok=True)
            (directory / "cgroup.procs").write_text("".join(str(pid) + "\n" for pid in sorted(self.surviving)))
        elif directory.is_dir():
            shutil.rmtree(directory)

    def exit_survivor(self, pid):
        self.surviving.discard(pid)
        if self.old_group and not self.active:
            self.write_old_group()

    def signal(self, entry, signum, group, read):
        if (entry["pid"] not in self.surviving or deploy.start_identity(read(entry["pid"], "stat")) != entry["startIdentity"]
                or not deploy.within(deploy.kernel_cgroup(read(entry["pid"], "cgroup")), group)):
            return False
        self.signals.append((entry["pid"], entry["startIdentity"], signum))
        if signum == deploy.signal.SIGKILL or entry["pid"] not in self.ignores_term:
            self.exit_survivor(entry["pid"])
        return True

    @property
    def members(self):
        return self._members

    @members.setter
    def members(self, pids):
        self._members = pids
        directory = self.cgroup / self.service_group.lstrip("/")
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "cgroup.procs").write_text("".join(str(pid) + "\n" for pid in pids))

    def set_record(self, sha, launcher_pid=None, **fields):
        offset = 0 if sha == OLD else 100
        def entry(pid):
            return {"pid": pid + offset, "startIdentity": str(pid + offset), "state": "healthy",
                    "revision": sha[:7], "startedAt": "2026-01-01T00:00:00Z"}
        launcher = {**entry(101), "revision": sha, "relaunch": 1, "protocol": deploy.RELAUNCH_PROTOCOL}
        if launcher_pid is not None:
            launcher.update(pid=launcher_pid, startIdentity=str(launcher_pid))
        deploy.write_json(self.record_file, {"checkout": str(self.checkout), "releasePointer": str(self.pointer),
                                            "requestFile": str(self.request_file),
                                            "releasesDir": str(self.releases), "port": 0, "socket": str(self.root / "fake.sock"),
                                            "launcher": {**launcher, **fields}, "web": entry(102), "runtimeHost": entry(103)})

    def process(self, pid, field):
        if self.old_gone and pid < 200 and pid not in self.surviving:
            raise FileNotFoundError("old release and old stage exited")
        root = self.releases / self.current[:12]
        identity = str(pid) + ("-reborn" if self.old_gone and pid in self.reborn else "")
        if field == "stat" and pid in self.moving:
            # A recycled PID: every read finds a different process.
            self.stat_reads += 1
            identity += "-" + str(self.stat_reads)
        self.reads = getattr(self, "reads", 0) + 1
        # CPU time changes on every read of a live process; the start identity does not.
        return {"stat": str(pid) + " (synthetic process) " + " ".join(["S", str(self.parents.get(pid, 1)), str(self.pgroups.get(pid, pid)), str(self.sessions.get(pid, self.pgroups.get(pid, pid)))] + ["0"] * 8 + [str(self.reads)] + ["0"] * 6 + [identity]),
                "cmdline": self.cmdlines.get(pid, "bun\0" + str(root / "bin/cli.mjs") + "\0").encode(), "cwd": str(root),
                "fds": self.descriptors.get(pid, []),
                "cgroup": "0::" + self.groups.get(pid, self.service_group) + "\n"}[field]

    def execute(self, args, cwd=None):
        self.commands.append(args)
        if args[:3] == ["git", "rev-parse", "HEAD"]:
            if cwd == self.checkout:
                return OLD
            return TARGET if pathlib.Path(cwd) == self.target else OLD
        if "list-jobs" in args:
            return self.unit_jobs
        if args[:2] == ["git", "status"]:
            return ""
        state = "ActiveState=" + ("active" if self.active else "inactive")
        if "show" in args:
            if "Id" in args:
                return "\n\n".join("\n".join(key + "=" + value for key, value in self.scopes.get(name, {}).items())
                                   for name in args[3:args.index("-p")])
            if "BoundBy" in args:
                return "BoundBy=" + " ".join(sorted(self.bound))
            if "InvocationID" in args:
                return "\n".join([state, *[key + "=" + value for key, value in {
                    "MainPID": str(self.main_pid), "NRestarts": "0", "InvocationID": "a" * 32,
                    "InactiveEnterTimestampMonotonic": "0", **self.unit_changes}.items()]])
            if "MainPID" in args:
                return "MainPID=" + str(self.main_pid) + "\nControlGroup=" + self.service_group
            if "ControlGroup" in args:
                if args[3].endswith(".slice"):
                    return "ControlGroup=" + ("/user.slice/delegatus.slice" if args[3] == "delegatus.slice" else self.slice_group)
                held = self.active or self.surviving or self.never_released
                weight = "\nCPUWeight=" + (self.weight or "[not set]")
                return "Slice=" + self.slice + "\nControlGroup=" + (self.service_group if held else "") + weight
            return "KillMode=process\n" + state if "KillMode" in args else state
        if args[:4] == ["systemctl", "--user", "--no-block", "stop"]:
            if self.stop_refused:
                raise RuntimeError("command refused")
            self.active = False
            self.old_gone = True
            self.old_group = self.service_group
            for pid in self.surviving:
                self.groups.setdefault(pid, self.old_group)
                if self.parents.get(pid) not in self.surviving:
                    self.parents[pid] = USER_MANAGER
            (self.cgroup / self.old_group.lstrip("/") / "cgroup.procs").write_text("")
            self.write_old_group()
            return ""
        if args[:4] == ["systemctl", "--user", "--no-block", "start"]:
            if self.start_refusals:
                self.start_refusals -= 1
                raise RuntimeError("command refused")
            if self.active:
                return ""
            self.active = True
            # A populated or unreleased old path is reused; otherwise the
            # unit is realized under its configured slice.
            reused = (self.cgroup / self.old_group.lstrip("/")).is_dir()
            self.service_group = self.old_group if reused else self.expected_group
            self.current = TARGET
            self.set_record(TARGET)
            self.members = sorted(self.surviving) + [201, 202, 203]
            if self.weight and self.weight_effective and self.service_group.startswith(self.slice_group + "/"):
                (self.cgroup / self.service_group.lstrip("/") / "cpu.weight").write_text(self.weight + "\n")
            self.main_pid = 201
            self.mcp_failures = 1
            self.http_failures = 1
            return ""
        if args[0] == "ss":
            return "pid=" + str(102 if self.current == OLD else 202)
        raise AssertionError("unplanned command")

    def http(self, port, route, token):
        if self.http_failures:
            self.http_failures -= 1
            raise ConnectionError("HTTP restart")
        if route == "/":
            return b'<script src="/_next/static/synthetic.js"></script>'
        if route.endswith(".js"):
            return b"synthetic"
        if route == "/api/tasks?project=":
            return b'{"tasks":[]}'
        if route == "/api/self-update?work=0&readOnly=1":
            return json.dumps({"auto": {"enabled": False}, "serving": {r: {"sha": self.current} for r in ["web", "runtimeHost"]},
                               "processes": {r: {"state": "healthy"} for r in ["web", "runtimeHost"]}}).encode()
        raise AssertionError("unplanned HTTP read")

    def test_real_adapter_replays_both_restart_failures_with_private_registry(self):
        self.relocating()
        directory = self.state / "interruption-obligations"
        directory.mkdir()
        cut = obligation("cut", "synthetic-stage", "2999-01-01T00:00:00.000Z")
        deploy.write_json(directory / (cut["id"] + ".json"), cut)
        result = deploy.run_switch(self.adapter, TARGET, samples=3, interval=2, timeout=5)
        self.assertEqual(result["verdict"], "pass")
        self.assertEqual([(entry["conversationId"], entry["stage"]) for entry in result["interrupted"]],
                         [("synthetic-stage", {"pipelineId": "synthetic-lane", "stageId": "build", "attempt": 1})])
        self.assertEqual(result["protected"][0]["outcome"], "recovered")
        self.assertEqual(json.loads(self.pointer.read_text())["sha"], TARGET)
        self.assertTrue(all(result["serving"][r]["sha"] == TARGET for r in ["launcher", "viewer", "runtimeHost"]))
        self.assertTrue(all(result["serving"][r]["since"] for r in ["launcher", "viewer", "runtimeHost"]))
        self.assertEqual(self.service_commands(), ["stop", "start"])
        self.assertEqual(self.signals, [])

    def test_missing_launcher_record_recovers_unit_before_fresh_sample(self):
        self.relocating()
        self.adapter.preflight()
        self.adapter.preflight = lambda: ([], [])
        start = self.adapter.start
        starts = []
        def lose_record_after_initial_start(relocation, attempts=deploy.START_ATTEMPTS,
                                            settle_timeout=deploy.STOP_SETTLE):
            start(relocation, attempts, settle_timeout)
            starts.append(self.adapter.clock.now())
            if len(starts) == 1:
                self.record_file.unlink()
                self.active = False
        self.adapter.start = lose_record_after_initial_start
        owner_recoveries = []
        recover = self.adapter.recover_start
        def record_owner_recovery(*args, **kwargs):
            owner_recoveries.append((os.getpid(), self.adapter.clock.now()))
            return recover(*args, **kwargs)
        self.adapter.recover_start = record_owner_recovery
        served_after_starts = []
        serving = self.adapter.serving
        def observe_serving():
            served_after_starts.append(len(starts))
            return serving()
        self.adapter.serving = observe_serving
        result = deploy.run_switch(self.adapter, TARGET, samples=2, interval=1, timeout=5)
        self.assertEqual(len(starts), 2, result)
        self.assertGreaterEqual(len(owner_recoveries), 1)
        self.assertEqual(owner_recoveries[0][0], os.getpid())
        self.assertLessEqual(owner_recoveries[0][1], 1)
        self.assertGreaterEqual(served_after_starts[0], 2)
        self.assertTrue(deploy.ready(result["serving"], TARGET))
        self.assertEqual(self.service_commands(), ["stop", "start", "start"])

    def test_unit_loss_during_serving_read_recovers_owner_promptly_and_rechecks_serving(self):
        switch = Switch()
        switch.relocation.update({"stopSubmitted": True, "started": True})
        switch.active = True
        switch.unit = "synthetic-viewer.service"
        recoveries, fresh_witnesses = [], []
        def recover_start(attempts=deploy.START_ATTEMPTS, settle_timeout=deploy.STOP_SETTLE, command_deadline=None):
            if not switch.active:
                switch.relocation["startAttempts"] += 1
                switch.active = True
                recoveries.append(switch.clock.now())
            switch.relocation["started"] = switch.active
        switch.recover_start = recover_start
        serving = switch.serving
        calls = 0
        def lose_during_first_read():
            nonlocal calls
            calls += 1
            if calls == 1:
                switch.active = False
                raise FileNotFoundError("launcher record disappeared during serving read")
            if not switch.active:
                raise FileNotFoundError("unit stopped")
            fresh_witnesses.append(switch.clock.now())
            return serving()
        switch.serving = lose_during_first_read
        result = deploy.run_switch(switch, TARGET, samples=1, interval=0, timeout=5)
        self.assertEqual(recoveries, [0])
        self.assertTrue(fresh_witnesses)
        self.assertGreaterEqual(fresh_witnesses[0], recoveries[0])
        self.assertEqual(result["verdict"], "pass", result)

    def test_owner_recovery_bounds_all_systemctl_calls_to_its_deadline(self):
        binary = self.root / "slow-systemctl"
        binary.mkdir()
        systemctl = binary / "systemctl"
        systemctl.write_text("#!/usr/bin/env python3\nimport time\ntime.sleep(2)\n")
        systemctl.chmod(0o700)
        self.adapter.command = deploy.command
        self.adapter.relocation = {"stopSubmitted": True, "started": True, "startAttempts": 0,
                                   "outcome": "previously-confirmed", "diagnostics": []}
        started = time.monotonic()
        with patch.dict(os.environ, {"PATH": str(binary) + os.pathsep + os.environ.get("PATH", "")}):
            self.adapter.recover_start(settle_timeout=0.25, command_deadline=started + 0.15)
        self.assertLess(time.monotonic() - started, 0.25)
        self.assertTrue(self.adapter.relocation["started"])
        self.assertEqual(self.adapter.relocation["outcome"], "previously-confirmed")
        self.assertEqual(self.adapter.relocation["startAttempts"], 0)
        self.assertIn("recovery:command-deadline", self.adapter.relocation["diagnostics"])

    def test_expired_recovery_does_not_launch_or_mutate_confirmed_state(self):
        marker = self.root / "systemctl-launched"
        binary = self.root / "expired-systemctl"
        binary.mkdir()
        systemctl = binary / "systemctl"
        systemctl.write_text("#!/usr/bin/env python3\nimport pathlib,sys\npathlib.Path(" + repr(str(marker)) + ").write_text('launched')\n")
        systemctl.chmod(0o700)
        self.adapter.command = deploy.command
        self.adapter.relocation = {"stopSubmitted": True, "started": True, "startAttempts": 4,
                                   "outcome": "confirmed", "diagnostics": []}
        with patch.dict(os.environ, {"PATH": str(binary) + os.pathsep + os.environ.get("PATH", "")}):
            self.adapter.recover_start(command_deadline=time.monotonic() - 1)
        self.assertFalse(marker.exists())
        self.assertEqual((self.adapter.relocation["started"], self.adapter.relocation["startAttempts"],
                          self.adapter.relocation["outcome"]), (True, 4, "confirmed"))

    def test_timed_out_start_keeps_confirmed_state_and_marks_launch_unknown(self):
        binary = self.root / "slow-start-systemctl"
        binary.mkdir()
        systemctl = binary / "systemctl"
        systemctl.write_text("#!/usr/bin/env python3\nimport sys,time\n"
                             "if 'start' in sys.argv: time.sleep(2)\n"
                             "elif 'show' in sys.argv: print('ActiveState=inactive')\n")
        systemctl.chmod(0o700)
        self.adapter.command = deploy.command
        self.adapter.relocation = {"stopSubmitted": True, "started": True, "startAttempts": 0,
                                   "outcome": "previously-confirmed", "stopOutcome": "released",
                                   "diagnostics": []}
        started = time.monotonic()
        with patch.dict(os.environ, {"PATH": str(binary) + os.pathsep + os.environ.get("PATH", "")}):
            self.adapter.recover_start(settle_timeout=0.25, command_deadline=started + 0.15)
        self.assertLess(time.monotonic() - started, 0.25)
        self.assertEqual((self.adapter.relocation["started"], self.adapter.relocation["startAttempts"],
                          self.adapter.relocation["outcome"]), (True, 1, "previously-confirmed"))
        self.assertEqual((self.adapter.relocation["launchEvidence"],
                          self.adapter.relocation["settlementEvidence"]), ("unknown", "unknown"))
        self.assertIn("recovery:start-unconfirmed", self.adapter.relocation["diagnostics"])

    def test_an_incomplete_interruption_record_keeps_a_healthy_switch_from_passing(self):
        self.relocating()
        directory = self.state / "interruption-obligations"
        directory.mkdir()
        deploy.write_json(directory / "interruption-continuation-broken.json",
                          {"id": "interruption-continuation-broken", "recordedAt": "2999-01-01T00:00:00Z"})
        result = deploy.run_switch(self.adapter, TARGET, samples=3, interval=2, timeout=5)
        self.assertEqual(result["verdict"], "needs_decision")
        self.assertEqual(result["interrupted"], [])
        self.assertEqual(result["interruptedUnreadable"], ["interruption-continuation-broken:version"])

    def assert_stage_verdict(self, attempts, verdict, outcome, attempt):
        self.relocating()
        self.attempts = attempts
        self.adapter.run_dir = self.state / "deploy-verdicts/synthetic-stage-run"
        self.adapter.run_dir.mkdir(parents=True, mode=0o700)
        result = deploy.run_switch(self.adapter, TARGET, samples=3, interval=2, timeout=18)
        self.assertEqual(result["verdict"], verdict)
        self.assertEqual(len(result["protected"]), 1)
        row = result["protected"][0]
        self.assertEqual((row["pipelineId"], row["stageId"], row["attempt"], row["outcome"]),
                         ("synthetic-lane", "build", attempt, outcome))
        self.assertEqual(row["captured"]["attempt"], 1)
        self.assertEqual(row["captured"]["conversationId"], "synthetic-stage")
        if outcome == "unknown":
            self.assertIn("reason", row)
        events = [json.loads(line) for line in (self.adapter.run_dir / "switch.log").read_text().splitlines()
                  if line.startswith("{")]
        samples = [event for event in events if "sample" in event]
        self.assertEqual([event["sample"] for event in samples], [1, 2, 3])
        first = samples[0]["protected"][0]
        self.assertEqual(first["captured"], row["captured"])
        self.assertEqual((first["outcome"], first["reason"]), ("unknown", "pipeline-unavailable:RuntimeError"))
        self.assertTrue(all(event["protected"] == result["protected"] for event in samples[1:]))
        self.assertEqual(json.loads((self.adapter.run_dir / "verdict.json").read_text())["protected"], result["protected"])
        self.assertTrue(all(result["serving"][role]["sha"] == TARGET and result["serving"][role]["since"]
                            for role in ["launcher", "viewer", "runtimeHost"]))
        self.assertNotIn("KeyError", result["diagnostics"])

    # A restart leaves every process KillMode=process spares in the service
    # cgroup, and systemd then starts the replacement in that old cgroup path
    # instead of the configured slice (2026-10-10: a Telegram connector runner
    # of an earlier generation, re-parented to the user manager).
    def leftover_members(self):
        self.members = [101, 102, 103, 150, 151, 152, 153, 160, 161]
        connector = str(self.releases / "2d611c2bc3b2" / "bin" / "telegram-mcp-server.py")
        self.cmdlines.update({
            150: "/state/telegram/venv/bin/python\0" + connector + "\0",
            151: "tail\0-F\0/private/log\0",
            152: "ugrep\0-r\0secret-pattern\0",
            153: "synthetic-unknown\0",
            # A child of the serving Viewer and a descendant of a live agent host.
            160: "bun\0worker.js\0",
            161: "sleep\0" + "60\0",
        })
        self.parents.update({150: 1, 151: 1, 152: 1, 153: 9999, 160: 102, 161: 170, 170: 104})

    def test_leftover_helpers_in_the_service_cgroup_are_named_and_refuse_before_publication(self):
        self.leftover_members()
        with self.assertRaises(deploy.LeftoverProcesses) as refused:
            deploy.run_switch(self.adapter, TARGET, samples=3, interval=2, timeout=5)
        named = refused.exception.members
        self.assertEqual([member["pid"] for member in named], [150, 151, 152, 153])
        self.assertEqual([member["name"] for member in named],
                         ["python telegram-mcp-server.py", "tail", "ugrep", "synthetic-unknown"])
        self.assertEqual(named[0]["startIdentity"], "150")
        self.assertEqual(named[0]["parentPid"], 1)
        self.assertTrue(all(member["since"] for member in named))
        # Base names only: arguments can carry paths and secrets.
        self.assertNotIn("secret-pattern", json.dumps(named))
        self.assertNotIn("/private/log", json.dumps(named))
        self.assertEqual(json.loads(self.pointer.read_text()), self.baseline)
        self.assertEqual((self.service_commands(), self.signals), ([], []))

    def test_agents_and_the_serving_generation_are_not_leftovers(self):
        self.answer_relaunch()
        self.members = [101, 102, 103, 160, 161]
        self.parents.update({160: 102, 161: 170, 170: 104})
        self.adapter.preflight()
        result = deploy.run_switch(self.adapter, TARGET, samples=3, interval=2, timeout=5)
        self.assertEqual(result["verdict"], "pass")

    def helper_groups(self, count=1, parent=USER_MANAGER):
        rows, groups = [], []
        for index in range(count):
            waiter = 10000 + index * 10
            host = waiter + 6
            pids = list(range(waiter, waiter + 6))
            leader, subshell = waiter + 1, waiter + 2
            directory = self.root / ("wait-" + str(index))
            directory.mkdir(mode=0o700)
            identity = lambda pid: {"pid": pid, "startIdentity": str(pid) + ":" + str(pid), "bootEpoch": "fixture-boot"}
            name = hashlib.sha256(json.dumps([host, str(host) + ":" + str(host), "fixture-boot"],
                                             separators=(",", ":")).encode()).hexdigest()
            exit_file = self.state / "host-exits" / (name + ".exit.json")
            deploy.write_json(exit_file.with_name(name + ".writer.json"), identity(waiter))
            deploy.write_json(directory / "host-exit.json", {"file": str(exit_file)})
            self.cmdlines[waiter] = "\0".join(["bun", "--no-env-file", "-e", "fixture-source", "--", json.dumps({"command": [str(directory), "codex"]})])
            drain = "\0".join(["sh", "-c", "fixture-drain", "sh", str(directory / "startup.fifo"), str(directory / "startup.stderr"), "16384"])
            self.cmdlines.update({leader: drain, subshell: drain, waiter + 3: "dd\0bs=16384", waiter + 4: "tee\0-a", waiter + 5: "wc\0-c"})
            self.parents.update({waiter: parent, host: waiter, leader: parent, subshell: leader,
                                 waiter + 3: subshell, waiter + 4: subshell, waiter + 5: subshell})
            for pid in pids:
                self.pgroups[pid] = waiter if pid == waiter else leader
                self.descriptors[pid] = [(2 if pid == waiter else 3, 9, index + 100, True)]
            scope = "delegatus-agent-codex-" + str(index) + ".scope"
            control = "/user.slice/delegatus-agents.slice/" + scope
            self.groups[host] = control + "/agent"
            self.scopes[scope] = {"Id": scope, "BindsTo": self.adapter.unit, "After": self.adapter.unit,
                                  "ActiveState": "active", "LoadState": "loaded", "InvocationID": "d" * 32,
                                  "ControlGroup": control}
            rows.append({"conversationId": "synthetic-host-" + str(index), "turnState": "busy" if index < 2 else "idle",
                         "lifecycle": "running" if index < 2 else "waiting",
                         "pipeline": None, "evidenceSource": "transcript", "host": {"state": "alive", "kind": "structured",
                         "pid": host, "process": identity(host), "exitWriter": {"process": identity(waiter), "exitFile": str(exit_file)}}})
            groups.append({"pids": pids, "waiter": waiter, "host": host, "leader": leader, "directory": directory, "row": rows[-1], "scope": self.scopes[scope]})
        self.members = self.members + [pid for group in groups for pid in group["pids"]]
        self.custody_fixture_rows = rows
        self.adapter.census_adapter = lambda *args: {"conversations": self.custody_fixture_rows, "unselectedCount": 0,
            "selection": {"matched": len(self.custody_fixture_rows), "selected": len(self.custody_fixture_rows),
                          "recoveryPending": 0, "recoveryTruncated": False, "cacheStatus": "hit", "projected": 0, "unreadable": 0}}
        return groups

    def custody_refusal(self, expected, reason=None):
        with self.assertRaises(deploy.LeftoverProcesses) as refusal:
            self.adapter.preflight()
        self.assertEqual([row["pid"] for row in refusal.exception.members], sorted(expected))
        if reason:
            self.assertTrue(any(row["reason"] == reason for row in refusal.exception.members), refusal.exception.members)
        self.assert_no_switch()
        return refusal.exception.members

    def test_twenty_native_waiters_and_one_hundred_drains_pass_read_only(self):
        groups = self.helper_groups(20)
        # Drive the real /proc parser against an on-disk fixture, including
        # symlinked descriptors sharing actual FIFO device/inode identities.
        proc = self.root / "proc"
        fifos = {}
        for pid in [101, 102, 103, 104, USER_MANAGER, *[pid for group in groups for pid in [*group["pids"], group["host"]]]]:
            directory = proc / str(pid)
            (directory / "fd").mkdir(parents=True)
            for field in ["stat", "cgroup"]:
                (directory / field).write_text(self.process(pid, field))
            (directory / "cmdline").write_bytes(self.process(pid, "cmdline"))
            (directory / "cwd").symlink_to(self.process(pid, "cwd"), target_is_directory=True)
            for fd, dev, inode, fifo in self.descriptors.get(pid, []):
                key = (dev, inode)
                if key not in fifos:
                    fifos[key] = self.root / ("fifo-" + str(inode))
                    os.mkfifo(fifos[key])
                (directory / "fd" / str(fd)).symlink_to(fifos[key])
        self.adapter.process_read = lambda pid, field: deploy.proc_field(pid, field, root=proc)
        output = io.StringIO()
        with patch.object(deploy, "Checkout", return_value=self.adapter), patch.object(sys, "argv", ["deploy-checkout.py", "--preflight", "--config", str(self.plan)]), contextlib.redirect_stdout(output):
            self.assertEqual(deploy.main(), 0)
        self.assertIn("20 wait owners and 100 helpers", output.getvalue())
        self.assertEqual(self.adapter.leftovers_found, [])
        self.assertEqual(len(self.adapter.helper_custody), 120)
        self.assert_no_switch()

    def test_mixed_current_and_orphaned_groups_count_only_new_custody(self):
        groups = self.helper_groups(2)
        for pid in [groups[0]["waiter"], groups[0]["leader"]]:
            self.parents[pid] = 102
        self.adapter.preflight()
        self.assertEqual(len(self.adapter.helper_custody), 6)
        self.assert_no_switch()

    def test_drain_between_blocks_and_after_cap_pass(self):
        group = self.helper_groups()[0]
        for cat in [False, True]:
            self.members = [101, 102, 103, group["waiter"], group["leader"]] + ([group["waiter"] + 3] if cat else [])
            if cat:
                self.cmdlines[group["waiter"] + 3] = "cat"
                self.parents[group["waiter"] + 3] = group["leader"]
            self.adapter.preflight()
            self.assertEqual(len(self.adapter.helper_custody), 3 if cat else 2)

    def test_legacy_launch_and_stdio_waiter_without_fifo_pass(self):
        group = self.helper_groups()[0]
        args = self.cmdlines[group["waiter"]].split("\0")
        args[-1] = json.dumps(json.loads(args[-1])["command"])
        self.cmdlines[group["waiter"]] = "\0".join(args)
        self.adapter.preflight()
        self.assertEqual(len(self.adapter.helper_custody), 6)
        self.members = [101, 102, 103, group["waiter"]]
        self.descriptors[group["waiter"]] = [(2, 9, 100, False)]
        self.adapter.preflight()
        self.assertEqual(list(self.adapter.helper_custody), [group["waiter"]])

    def test_custody_switch_releases_without_signals_and_is_never_captured(self):
        self.relocating()
        group = self.helper_groups()[0]
        self.adapter.preflight()
        captured = self.adapter.generation(self.service_group)
        self.assertTrue(set(captured).isdisjoint(self.adapter.helper_custody))
        self.surviving = set(group["pids"])
        self.leave_at = {pid: 10 for pid in group["pids"]}
        result = deploy.run_switch(self.adapter, TARGET, samples=3, interval=2, timeout=5)
        self.assertEqual(result["verdict"], "pass")
        self.assertEqual((result["relocation"]["outcome"], result["relocation"]["placement"]), ("released", "placed"))
        self.assertEqual((result["relocation"]["survivors"], self.signals), ([], []))

    def test_lingering_custody_refuses_retirement_but_always_starts(self):
        for idle_weight in ["1000", "900"]:
            with self.subTest(idle_weight=idle_weight):
                self.setUp()
                self.relocating(weight=idle_weight)
                group = self.helper_groups()[0]
                self.surviving = {group["waiter"]}
                # Fixture hosts end at the bound scope stop, independently of
                # cgroup membership. Other process reads remain synthetic.
                read = self.adapter.process_read
                def process(pid, field):
                    if self.old_gone and pid == group["host"]:
                        raise FileNotFoundError()
                    return read(pid, field)
                self.adapter.process_read = process
                result = deploy.run_switch(self.adapter, TARGET, samples=3, interval=2, timeout=5)
                relocation = result["relocation"]
                self.assertEqual((result["verdict"], relocation["outcome"], relocation["placement"]),
                                 ("fail", "unproven-survivors", "failed"))
                self.assertFalse(relocation["released"])
                self.assertEqual(relocation["survivors"][0]["reason"], "protected helper custody; host ended")
                self.assertEqual((self.surviving, self.signals), ({group["waiter"]}, []))
                self.assert_back_in_service(result)

    def test_waiter_identity_registry_parent_and_scope_fences(self):
        mutations = ["missing-writer", "missing-field", "missing-host", "duplicate-row", "host-reused", "waiter-reused", "waiter-boot", "boot", "parent", "inside", "no-scope",
                     "BindsTo", "After", "ActiveState", "ControlGroup", "scope-read"]
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                self.setUp()
                group = self.helper_groups()[0]
                host = group["row"]["host"]
                if mutation == "missing-writer": host["exitWriter"] = None
                elif mutation == "missing-field": del host["exitWriter"]
                elif mutation == "missing-host": self.custody_fixture_rows.clear()
                elif mutation == "duplicate-row": self.custody_fixture_rows.append(group["row"])
                elif mutation == "host-reused": host["process"]["startIdentity"] += "-reused"
                elif mutation == "waiter-reused": host["exitWriter"]["process"]["startIdentity"] += "-reused"
                elif mutation == "waiter-boot": host["exitWriter"]["process"]["bootEpoch"] = "other-boot"
                elif mutation == "boot": host["process"]["bootEpoch"] = "other-boot"
                elif mutation == "parent": self.parents[group["host"]] = USER_MANAGER
                elif mutation == "inside": self.groups[group["host"]] = self.service_group
                elif mutation == "no-scope": self.groups[group["host"]] = "/other.slice/other.service"
                elif mutation in ["BindsTo", "After"]: group["scope"][mutation] = "other.service"
                elif mutation == "ActiveState": group["scope"][mutation] = "inactive"
                elif mutation == "ControlGroup": group["scope"][mutation] += "-other"
                elif mutation == "scope-read":
                    execute = self.adapter.command
                    def unavailable(args, cwd=None):
                        if "BindsTo" in args:
                            raise RuntimeError("scope unavailable")
                        return execute(args, cwd)
                    self.adapter.command = unavailable
                reason = ("no registry writer record names it" if mutation in ["missing-writer", "missing-field", "missing-host", "duplicate-row", "waiter-reused", "waiter-boot"]
                          else "host identity differs from registry" if mutation in ["host-reused", "boot"]
                          else "host is not its child" if mutation == "parent"
                          else "host not in an agent scope outside the service" if mutation in ["inside", "no-scope"]
                          else "host scope not bound to the unit")
                self.custody_refusal(group["pids"], "wait owner: " + reason)

    def test_drain_fifo_group_parent_program_and_ambiguity_fences(self):
        for mutation in ["unbound", "fifo", "pgid", "sid", "parent", "program", "two-leaders", "two-subshells", "ambiguous", "shared-fifo"]:
            with self.subTest(mutation=mutation):
                self.setUp()
                groups = self.helper_groups(2 if mutation in ["ambiguous", "shared-fifo"] else 1)
                group = groups[0]
                waiter, leader = group["waiter"], group["leader"]
                expected = [waiter + 3]
                if mutation == "unbound": self.descriptors[waiter + 3] = [(3, 9, 999, True)]
                elif mutation == "fifo":
                    self.descriptors[leader] = [(3, 9, 999, True)]
                    expected = group["pids"][1:]
                elif mutation == "pgid": self.pgroups[waiter + 3] = 888
                elif mutation == "sid": self.sessions[waiter + 3] = 888
                elif mutation == "parent": self.parents[waiter + 3] = USER_MANAGER
                elif mutation == "program": self.cmdlines[waiter + 3] = "unexpected"
                elif mutation == "two-leaders":
                    self.cmdlines[waiter + 3] = self.cmdlines[leader]
                    self.pgroups[waiter + 3] = waiter + 3
                    expected = group["pids"][1:]
                elif mutation == "two-subshells":
                    self.cmdlines[waiter + 3] = self.cmdlines[leader]
                    self.parents[waiter + 3] = leader
                    expected = group["pids"][2:]
                elif mutation == "ambiguous":
                    self.descriptors[waiter + 3].append((4, 9, 101, True))
                elif mutation == "shared-fifo":
                    for pid in groups[1]["pids"]:
                        self.descriptors[pid] = [(2 if pid == groups[1]["waiter"] else 3, 9, 100, True)]
                    expected = group["pids"][1:] + groups[1]["pids"][1:]
                reason = ("no current serving or agent owner" if mutation == "unbound"
                          else "stderr drain: no single leader for the owner's FIFO" if mutation in ["fifo", "two-leaders"]
                          else "stderr drain: process group differs from its leader" if mutation in ["pgid", "sid"]
                          else "stderr drain: parent link outside the group" if mutation in ["parent", "two-subshells"]
                          else "stderr drain: unexpected program" if mutation == "program"
                          else "stderr drain: ambiguous FIFO")
                self.custody_refusal(expected, reason)

    def test_launch_directory_and_exit_slot_fences(self):
        for mutation in ["missing", "discard", "wrong-slot", "symlink-file", "fifo-file", "oversized", "symlink-directory", "public-directory", "fifo-outside"]:
            with self.subTest(mutation=mutation):
                self.setUp()
                group = self.helper_groups()[0]
                directory = group["directory"]
                binding = directory / "host-exit.json"
                expected = group["pids"]
                if mutation == "missing": binding.unlink()
                elif mutation == "discard": deploy.write_json(binding, {"discard": True})
                elif mutation == "wrong-slot": deploy.write_json(binding, {"file": str(self.state / "host-exits/other.exit.json")})
                elif mutation == "symlink-file":
                    other = directory / "other.json"
                    binding.rename(other)
                    binding.symlink_to(other)
                elif mutation == "fifo-file":
                    binding.unlink()
                    os.mkfifo(binding)
                elif mutation == "oversized": binding.write_text(" " * 4097)
                elif mutation == "symlink-directory":
                    other = directory.with_name("other-directory")
                    directory.rename(other)
                    directory.symlink_to(other, target_is_directory=True)
                elif mutation == "public-directory": directory.chmod(0o755)
                elif mutation == "fifo-outside":
                    args = self.cmdlines[group["leader"]].split("\0")
                    args[4] = str(self.root / "startup.fifo")
                    self.cmdlines[group["leader"]] = "\0".join(args)
                    expected = group["pids"][1:]
                self.custody_refusal(expected, "stderr drain: no single leader for the owner's FIFO" if mutation == "fifo-outside"
                                     else "wait owner: launch directory does not name the host's exit record")

    def test_identity_change_during_custody_uses_moving_member_refusal(self):
        group = self.helper_groups()[0]
        execute = self.adapter.command
        def changed(args, cwd=None):
            result = execute(args, cwd)
            if "BindsTo" in args:
                self.moving.add(group["waiter"])
            return result
        self.adapter.command = changed
        refused = self.custody_refusal(group["pids"], "custody evidence changed before final admission")
        self.assertEqual(len(refused), len(group["pids"]))
        self.assert_no_switch()

    def test_host_and_drain_changes_during_descriptor_reads_refuse(self):
        for changed in ["host", "drain", "host-parent"]:
            with self.subTest(changed=changed):
                self.setUp()
                group = self.helper_groups()[0]
                read = self.adapter.process_read
                def process(pid, field):
                    value = read(pid, field)
                    if field == "fds":
                        if changed == "host-parent": self.parents[group["host"]] = USER_MANAGER
                        else: self.moving.add(group["host"] if changed == "host" else group["leader"])
                    return value
                self.adapter.process_read = process
                with self.assertRaises(deploy.LeftoverProcesses) as refusal:
                    self.adapter.preflight()
                self.assertTrue(all(row["reason"] == "custody evidence changed before final admission"
                                    for row in refusal.exception.members))
                self.assert_no_switch()

    def test_mutable_fifo_scope_and_exit_binding_must_survive_final_admission(self):
        for changed in ["fifo", "scope-cgroup", "scope-binding", "exit-binding"]:
            with self.subTest(changed=changed):
                self.setUp()
                group = self.helper_groups()[0]
                read = self.adapter.process_read
                mutated = False

                def process(pid, field):
                    nonlocal mutated
                    value = read(pid, field)
                    if field == "fds" and not mutated:
                        mutated = True
                        if changed == "fifo":
                            # Replace the source table after this read returned
                            # its earlier snapshot; the final proof sees inode drift.
                            self.descriptors[group["waiter"]] = [(2, 9, 9999, True)]
                        elif changed == "scope-cgroup":
                            self.groups[group["host"]] = self.service_group + "/unbound"
                        elif changed == "scope-binding":
                            group["scope"]["BindsTo"] = "other.service"
                        else:
                            deploy.write_json(group["directory"] / "host-exit.json", {"discard": True})
                    return value

                self.adapter.process_read = process
                refused = self.custody_refusal(group["pids"],
                    "custody evidence changed before final admission")
                self.assertTrue(mutated)
                self.assert_no_switch()

    def test_mutable_links_changed_during_second_scan_refuse_final_admission(self):
        for changed in ["fifo", "scope-cgroup", "scope-binding", "exit-binding"]:
            with self.subTest(changed=changed):
                self.setUp()
                group = self.helper_groups()[0]
                read = self.adapter.process_read
                leader_reads = 0

                def process(pid, field):
                    nonlocal leader_reads
                    value = read(pid, field)
                    if pid == group["leader"] and field == "fds":
                        leader_reads += 1
                        if leader_reads == 3:
                            if changed == "fifo":
                                self.descriptors[group["waiter"]] = [(2, 9, 9999, True)]
                            elif changed == "scope-cgroup":
                                self.groups[group["host"]] = self.service_group + "/unbound"
                            elif changed == "scope-binding":
                                group["scope"]["BindsTo"] = "other.service"
                            else:
                                deploy.write_json(group["directory"] / "host-exit.json", {"discard": True})
                    return value

                self.adapter.process_read = process
                self.custody_refusal(group["pids"], "custody evidence changed before final admission")
                self.assertEqual(leader_reads, 3)

    def test_older_release_refusal_never_enters_custody(self):
        group = self.helper_groups(parent=102)[0]
        read = self.adapter.process_read
        self.adapter.process_read = lambda pid, field: str(self.releases / ("d" * 12)) if pid in group["pids"] and field == "cwd" else read(pid, field)
        refused = self.custody_refusal(group["pids"], "older release in service cgroup")
        self.assertTrue(all(row["reason"] == "older release in service cgroup" for row in refused))

    def test_proc_fifo_descriptor_identity_and_table_bound(self):
        fifo = self.root / "descriptor.fifo"
        os.mkfifo(fifo)
        fd = os.open(fifo, os.O_RDWR | os.O_NONBLOCK)
        try:
            info = os.fstat(fd)
            self.assertIn((fd, info.st_dev, info.st_ino, True), deploy.proc_field(os.getpid(), "fds"))
            # Supply numeric descriptor names while keeping the stat real.
            class Descriptor:
                name = "9"
                stat = staticmethod(lambda: info)
            with patch.object(pathlib.Path, "iterdir", return_value=iter([Descriptor()] * 65)):
                with self.assertRaisesRegex(RuntimeError, "exceeds its bound"):
                    deploy.proc_field(os.getpid(), "fds")
        finally:
            os.close(fd)

    def bootstrap_chain(self, intermediate=False):
        self.main_pid = 90
        self.parents[101] = 95 if intermediate else 90
        self.parents.update({95: 90, 90: 1, 102: 101, 103: 101})
        self.members = [90, 95, 101, 102, 103] if intermediate else [90, 101, 102, 103]
        # The bootstrap can keep running from its checkout across releases.
        self.cmdlines[90] = "bun\0" + str(self.checkout / "bin/cli.mjs") + "\0"

    def assert_no_switch(self):
        self.assertEqual(json.loads(self.pointer.read_text()), self.baseline)
        self.assertEqual((self.service_commands(), self.signals), ([], []))

    def test_bootstrap_main_pid_and_only_the_verified_launcher_ancestors_pass(self):
        for intermediate in [False, True]:
            with self.subTest(intermediate=intermediate):
                self.bootstrap_chain(intermediate)
                self.adapter.preflight()
                self.assertTrue(any("MainPID" in c and self.adapter.unit in c for c in self.commands))
                self.assert_no_switch()
        self.answer_relaunch()
        result = deploy.run_switch(self.adapter, TARGET, samples=3, interval=2, timeout=5)
        self.assertEqual(result["verdict"], "pass")
        self.assertEqual(self.service_commands(), [])

    def test_bootstrap_sibling_legacy_runner_and_child_still_refuse_by_identity(self):
        self.bootstrap_chain(intermediate=True)
        self.members = self.members + [150, 151]
        self.parents.update({150: 90, 151: 95})
        self.cmdlines[150] = "/state/telegram/venv/bin/python\0" + str(
            self.releases / "2d611c2bc3b2/bin/telegram-mcp-server.py") + "\0"
        self.cmdlines[151] = "sleep\0" + "60\0"
        with self.assertRaises(deploy.LeftoverProcesses) as refused:
            deploy.run_switch(self.adapter, TARGET, samples=3, interval=2, timeout=5)
        self.assertEqual([row["pid"] for row in refused.exception.members], [150, 151])
        self.assertEqual(refused.exception.members[0]["startIdentity"], "150")
        self.assertEqual(refused.exception.members[0]["name"], "python telegram-mcp-server.py")
        self.assert_no_switch()

    def test_older_release_child_of_current_viewer_is_named_and_refused(self):
        self.bootstrap_chain()
        self.members = self.members + [150]
        self.parents[150] = 102
        for entry in [str(self.releases / "2d611c2bc3b2/bin/telegram-mcp-server.py"),
                      str(self.releases / OLD[:12] / "../2d611c2bc3b2/bin/telegram-mcp-server.py"),
                      "../2d611c2bc3b2/bin/telegram-mcp-server.py"]:
            with self.subTest(entry=entry):
                self.cmdlines[150] = "python\0" + entry + "\0"
                with self.assertRaises(deploy.LeftoverProcesses) as refused:
                    self.adapter.preflight()
                self.assertEqual([row["pid"] for row in refused.exception.members], [150])
                self.assertEqual(refused.exception.members[0]["reason"], "older release in service cgroup")
                self.assertIn("older release", deploy.leftover_lines(refused.exception.members)[0])
                self.assertIn("identity=150", deploy.leftover_lines(refused.exception.members)[0])
                self.assert_no_switch()

    def test_current_release_runner_and_agent_children_pass_with_bootstrap(self):
        self.bootstrap_chain()
        self.members = self.members + [150, 160]
        self.parents.update({150: 102, 160: 104})
        self.cmdlines[150] = "python\0" + str(self.releases / OLD[:12] / "bin/telegram-mcp-server.py") + "\0"
        # Agents may run tools from other release checkouts.
        self.cmdlines[160] = "bun\0" + str(self.releases / "2d611c2bc3b2/bin/tool.mjs") + "\0"
        self.adapter.preflight()
        self.assert_no_switch()

    def test_unrelated_main_pid_cannot_admit_launcher_ancestors(self):
        self.bootstrap_chain()
        self.main_pid = 80
        self.members = self.members + [80]
        with self.assertRaises(RuntimeError):
            self.adapter.preflight()
        self.assert_no_switch()

    def test_unreadable_main_pid_refuses(self):
        execute = self.adapter.command
        for value in [None, "0", "-1", "unknown"]:
            with self.subTest(value=value):
                def unreadable(args, cwd=None):
                    if "MainPID" in args:
                        return "ControlGroup=" + self.service_group + ("\nMainPID=" + value if value is not None else "")
                    return execute(args, cwd)
                self.adapter.command = unreadable
                with self.assertRaises(RuntimeError):
                    self.adapter.preflight()
                self.assert_no_switch()

    def test_recycled_or_outside_launcher_ancestor_refuses(self):
        self.bootstrap_chain(intermediate=True)
        self.moving.add(95)
        with self.assertRaises(RuntimeError):
            self.adapter.preflight()
        self.moving.clear()
        self.groups[95] = self.service_group + "-other"
        with self.assertRaises(RuntimeError):
            self.adapter.preflight()
        self.assert_no_switch()

    def test_recycled_recorded_launcher_cannot_prove_bootstrap_ownership(self):
        self.bootstrap_chain()
        record = json.loads(self.record_file.read_text())
        record["launcher"]["startIdentity"] = "stale"
        deploy.write_json(self.record_file, record)
        self.adapter.agents = {}
        with self.assertRaises(RuntimeError):
            self.adapter.leftovers(self.service_group)
        self.assert_no_switch()

    def test_main_pid_change_during_ancestry_read_refuses(self):
        self.bootstrap_chain()
        execute = self.adapter.command
        observations = 0
        def moving(args, cwd=None):
            nonlocal observations
            if "MainPID" in args:
                observations += 1
                return "MainPID=" + str(90 if observations % 2 else 80) + "\nControlGroup=" + self.service_group
            return execute(args, cwd)
        self.adapter.command = moving
        with self.assertRaises(RuntimeError):
            self.adapter.preflight()
        self.assert_no_switch()

    def test_preflight_refuses_with_the_list_on_the_command_line(self):
        self.leftover_members()
        with self.assertRaises(deploy.LeftoverProcesses):
            self.adapter.preflight()
        lines = deploy.leftover_lines(self.adapter.leftovers_found)
        self.assertEqual(len(lines), 4)
        self.assertIn("pid=150", lines[0])
        self.assertIn("python telegram-mcp-server.py", lines[0])

    def test_an_unreadable_or_moving_service_cgroup_refuses(self):
        (self.cgroup / self.service_group.lstrip("/") / "cgroup.procs").unlink()
        with self.assertRaises(RuntimeError):
            self.adapter.preflight()
        self.members = [101, 102, 103, 150]
        self.moving.add(150)
        with self.assertRaises(RuntimeError):
            self.adapter.preflight()
        self.assertEqual(json.loads(self.pointer.read_text()), self.baseline)
        self.assertEqual(self.service_commands(), [])

    def test_a_healthy_service_in_the_wrong_cgroup_fails_loudly(self):
        self.service_group = "/user.slice/app.slice/synthetic-viewer.service"
        self.members = self.members
        # Emptied, but never pruned: the start reuses the old path.
        self.never_released = True
        result = deploy.run_switch(self.adapter, TARGET, samples=3, interval=2, timeout=5)
        self.assertEqual(result["relocation"]["outcome"], "not-released")
        self.assertEqual(result["relocation"]["placement"], "failed")
        self.assertEqual(self.service_commands(), ["stop", "start"])
        self.assertTrue(result["serving"]["checks"]["http"])
        self.assertFalse(result["serving"]["checks"]["placement"])
        self.assertEqual(result["verdict"], "fail")
        self.assertEqual(result["serving"]["placement"]["expected"], "/user.slice/delegatus.slice/synthetic-viewer.service")
        self.assertEqual(result["serving"]["placement"]["actual"], "/user.slice/app.slice/synthetic-viewer.service")

    def test_a_serving_process_outside_the_service_cgroup_fails_placement(self):
        self.relocating()
        self.groups[202] = "/user.slice/app.slice/other.service"
        result = deploy.run_switch(self.adapter, TARGET, samples=3, interval=2, timeout=5)
        self.assertEqual(result["verdict"], "fail")
        self.assertFalse(result["serving"]["checks"]["placement"])

    def test_missing_placement_reads_fail_closed(self):
        execute = self.adapter.command
        for unit, missing in [("service", "Slice"), ("service", "ControlGroup"), ("slice", "ControlGroup")]:
            with self.subTest(unit=unit, missing=missing):
                def without(args, cwd=None):
                    output = execute(args, cwd)
                    if "ControlGroup" in args and (unit == "slice") == args[3].endswith(".slice"):
                        return "\n".join(line for line in output.splitlines() if not line.startswith(missing + "="))
                    return output
                self.adapter.command = without
                self.assertFalse(self.adapter.serving()["checks"]["placement"])
        self.adapter.command = execute

    # The CPU-slice activation (2026-10-11): a plain restart left the service
    # in app.slice because one old descendant outlived the stop and systemd
    # reused its populated path. The switch now stops, waits for the old
    # cgroup to empty and be released, retires only survivors proven to be
    # the stopped generation, and always starts again.
    def relocating(self, survivors=(), weight="1000"):
        (self.cgroup / self.expected_group.lstrip("/") / "cpu.weight").unlink(missing_ok=True)
        self.service_group = "/user.slice/app.slice/synthetic-viewer.service"
        self.weight = weight
        # A Viewer child present at capture: the serving generation.
        self.parents.update({150: 102, 151: 150})
        self.pgroups.update({150: 102, 151: 102, 161: 104})
        self.cmdlines.update({150: "bun\0worker.js\0--secret-flag\0", 151: "sleep\0" + "60\0", 153: "tail\0-F\0log\0"})
        self.members = [101, 102, 103] + [pid for pid in survivors if pid == 150]
        self.surviving = set(survivors)

    def assert_back_in_service(self, result):
        self.assertTrue(self.active)
        self.assertEqual(self.service_commands()[0], "stop")
        self.assertEqual(self.service_commands()[-1], "start")
        self.assertTrue(result["relocation"]["started"])

    def test_old_cgroup_released_in_time_moves_the_service_into_its_slice(self):
        self.relocating(survivors=[150])
        self.leave_at = {150: self.adapter.clock.now() + 10}
        result = deploy.run_switch(self.adapter, TARGET, samples=3, interval=2, timeout=5)
        self.assertEqual(result["verdict"], "pass")
        self.assert_back_in_service(result)
        self.assertEqual(self.service_commands(), ["stop", "start"])
        relocation = result["relocation"]
        self.assertEqual((relocation["outcome"], relocation["placement"]), ("released", "placed"))
        self.assertEqual(relocation["from"], "/user.slice/app.slice/synthetic-viewer.service")
        self.assertEqual(relocation["to"], self.expected_group)
        self.assertEqual((relocation["survivors"], self.signals), ([], []))
        placement = result["serving"]["placement"]
        self.assertEqual((placement["actual"], placement["weight"], placement["effectiveWeight"]),
                         (self.expected_group, "1000", "1000"))
        self.assertFalse((self.cgroup / "user.slice/app.slice/synthetic-viewer.service").exists())

    def test_proven_survivors_are_retired_by_identity_before_the_start(self):
        for stubborn in [False, True]:
            with self.subTest(stubborn=stubborn):
                self.setUp()
                # 151 was forked after the capture; its parent chain reaches 150.
                self.relocating(survivors=[150, 151])
                self.ignores_term = {150} if stubborn else set()
                result = deploy.run_switch(self.adapter, TARGET, samples=3, interval=2, timeout=5)
                self.assertEqual(result["verdict"], "pass")
                self.assert_back_in_service(result)
                relocation = result["relocation"]
                self.assertEqual((relocation["outcome"], relocation["placement"]), ("released-after-retirement", "placed"))
                self.assertEqual([(row["pid"], row["proven"], row["reason"]) for row in relocation["survivors"]],
                                 [(150, True, "captured serving generation"),
                                  (151, True, "descends from captured serving generation")])
                self.assertEqual(relocation["survivors"][0]["parentPid"], USER_MANAGER)
                self.assertEqual(relocation["survivors"][0]["args"], ["bun", "worker.js", "--secret-flag"])
                expected = [(150, "150", deploy.signal.SIGTERM), (151, "151", deploy.signal.SIGTERM)]
                if stubborn:
                    expected.append((150, "150", deploy.signal.SIGKILL))
                self.assertEqual(self.signals, expected)
                self.assertEqual([row["signal"] for row in relocation["signalled"]],
                                 ["SIGTERM", "SIGTERM"] + (["SIGKILL"] if stubborn else []))

    def test_an_unproven_survivor_signals_nothing_and_starts_anyway_with_placement_failed(self):
        cases = {
            # Not in the capture, re-parented to the user manager.
            "uncaptured": ([150, 153], {}, "no captured owner"),
            # The captured PID now names another process.
            "recycled": ([150], {"reborn": {150}}, "no captured owner"),
            # An agent host and its child left in the service cgroup.
            "agent": ([104, 161], {"parents": {161: 104}}, "agent host or its descendant"),
        }
        for name, (survivors, extra, reason) in cases.items():
            with self.subTest(case=name):
                self.setUp()
                self.relocating(survivors=survivors)
                self.parents.update(extra.get("parents", {}))
                self.reborn = extra.get("reborn", set())
                self.adapter.run_dir = self.state / "deploy-verdicts/synthetic-relocation"
                self.adapter.run_dir.mkdir(parents=True, mode=0o700)
                result = deploy.run_switch(self.adapter, TARGET, samples=3, interval=2, timeout=5)
                self.assert_back_in_service(result)
                self.assertEqual(self.service_commands(), ["stop", "start"])
                self.assertEqual(self.signals, [])
                relocation = result["relocation"]
                self.assertEqual((relocation["outcome"], relocation["placement"], relocation["signalled"]),
                                 ("unproven-survivors", "failed", []))
                unproven = [row for row in relocation["survivors"] if not row["proven"]]
                self.assertEqual(unproven[-1]["reason"], reason)
                self.assertTrue(all(row["parentPid"] and row["startIdentity"] for row in relocation["survivors"]))
                self.assertEqual(result["verdict"], "fail")
                self.assertFalse(result["serving"]["checks"]["placement"])
                self.assertEqual(result["serving"]["placement"]["actual"], "/user.slice/app.slice/synthetic-viewer.service")
                log = (self.adapter.run_dir / "switch.log").read_text()
                self.assertIn('"relocation"', log)
                self.assertIn("placement=FAILED", log)
                self.assertIn("relocation=unproven-survivors", log)

    def test_a_refused_start_is_retried_and_the_service_is_never_left_stopped(self):
        self.relocating()
        self.start_refusals = 2
        result = deploy.run_switch(self.adapter, TARGET, samples=3, interval=2, timeout=5)
        self.assertEqual(result["verdict"], "pass")
        self.assert_back_in_service(result)
        self.assertEqual(self.service_commands(), ["stop", "start", "start", "start"])
        self.assertEqual(result["relocation"]["startAttempts"], 3)
        self.assertEqual(result["relocation"]["placement"], "placed")

    def test_start_recovers_after_the_initial_three_refusals(self):
        self.relocating()
        self.start_refusals = deploy.START_ATTEMPTS
        result = deploy.run_switch(self.adapter, TARGET, samples=3, interval=2, timeout=5)
        self.assert_back_in_service(result)
        self.assertEqual(self.service_commands(), ["stop"] + ["start"] * (deploy.START_ATTEMPTS + 1))
        self.assertEqual(result["verdict"], "pass")
        self.assertEqual(result["relocation"]["placement"], "placed")

    def test_active_unit_with_pending_stop_still_owes_a_start(self):
        self.relocating()
        refusals = deploy.START_ATTEMPTS * 2 + 1
        self.start_refusals = refusals
        execute = self.adapter.command
        pending = False
        def queued(args, cwd=None):
            nonlocal pending
            if args[:4] == ["systemctl", "--user", "--no-block", "stop"]:
                self.commands.append(args)
                pending = True
                return ""
            if "list-jobs" in args and pending:
                return "1 synthetic-viewer.service stop running"
            if args[:4] == ["systemctl", "--user", "--no-block", "start"] and not self.start_refusals:
                pending = False
            return execute(args, cwd)
        self.adapter.command = queued
        result = deploy.run_switch(self.adapter, TARGET, samples=1, interval=2, timeout=0)
        self.assertTrue(self.active)
        self.assertFalse(pending)
        self.assertEqual(self.service_commands(), ["stop"] + ["start"] * (refusals + 1))
        # Cancelling a queued stop kept the old release alive; it is still
        # available, but cannot pass the replacement's health checks.
        self.assertEqual(result["verdict"], "fail")

    def test_a_start_that_keeps_failing_retries_during_health_and_on_exit(self):
        self.relocating()
        self.start_refusals = 1000
        result = deploy.run_switch(self.adapter, TARGET, samples=3, interval=2, timeout=5)
        self.assertGreater(result["relocation"]["startAttempts"], deploy.START_ATTEMPTS * 2)
        relocation = result["relocation"]
        self.assert_back_in_service(result)
        self.assertEqual(relocation["startAttempts"], 1001)
        self.assertEqual(relocation["outcome"], "released")
        self.assertIn("serving:not-ready", result["diagnostics"])
        self.assertEqual(result["verdict"], "fail")
        self.assertFalse(result["serving"]["checks"]["service"])

    def test_recovery_outlives_the_old_final_batch_with_short_and_production_bounds(self):
        for refusals, options in [(7, {"samples": 1, "interval": 0, "timeout": 0}), (3807, {})]:
            with self.subTest(refusals=refusals):
                self.setUp()
                self.relocating()
                self.start_refusals = refusals
                self.adapter.run_dir = self.state / "deploy-verdicts/synthetic-recovery"
                self.adapter.run_dir.mkdir(parents=True, mode=0o700)
                result = deploy.run_switch(self.adapter, TARGET, **options)
                self.assert_back_in_service(result)
                self.assertEqual(result["relocation"]["startAttempts"], refusals + 1)
                self.assertEqual(self.service_commands().count("stop"), 1)
                self.assertEqual(self.signals, [])
                self.assertEqual(result["verdict"], "fail")
                saved = json.loads((self.adapter.run_dir / "verdict.json").read_text())
                self.assertTrue(saved["relocation"]["started"])
                self.assertEqual(saved["recovery"]["state"], "complete")

    def test_failed_verdict_names_the_recovery_owner_before_a_later_start(self):
        self.relocating()
        self.start_refusals = 1000
        self.adapter.run_dir = self.state / "deploy-verdicts/synthetic-pending"
        self.adapter.run_dir.mkdir(parents=True, mode=0o700)
        emit = self.adapter.emit
        pending = []
        def report(event):
            emit(event)
            if event.get("recovery", {}).get("state") == "pending":
                saved = json.loads((self.adapter.run_dir / "verdict.json").read_text())
                latest = json.loads((self.adapter.run_dir.parent / ("latest-" + self.adapter.install + ".json")).read_text())
                pending.append((saved, latest, self.active))
                # Only the test releases the refusal after observing ownership.
                self.start_refusals = 0
        self.adapter.emit = report
        result = deploy.run_switch(self.adapter, TARGET, samples=1, interval=0, timeout=0)
        self.assertEqual(len(pending), 1)
        saved, latest, active = pending[0]
        self.assertFalse(active)
        self.assertFalse(saved["relocation"]["started"])
        self.assertEqual(saved["verdict"], "fail")
        self.assertEqual(saved["recovery"]["ownerPid"], os.getpid())
        self.assertEqual(saved["recovery"]["unit"], "synthetic-viewer.service")
        self.assertNotIn("finishedAt", latest)
        self.assertEqual(latest["recovery"], saved["recovery"])
        self.assert_back_in_service(result)
        self.assertEqual(result["recovery"]["state"], "complete")
        self.assertEqual(self.service_commands().count("stop"), 1)
        latest = json.loads((self.adapter.run_dir.parent / ("latest-" + self.adapter.install + ".json")).read_text())
        self.assertIn("finishedAt", latest)
        self.assertEqual(latest["recovery"]["state"], "complete")

    def test_real_install_lock_refuses_a_contender_until_the_recovery_owner_finishes(self):
        self.relocating()
        self.start_refusals = 1000
        self.adapter.run_dir = self.state / "deploy-verdicts/owner"
        self.adapter.run_dir.mkdir(parents=True)
        contender = self.adapter.run_dir.with_name("contender")
        contender.mkdir()
        latest = contender.parent / ("latest-" + self.adapter.install + ".json")
        next_worker = """import functools, pathlib, runpy, sys
fx = runpy.run_path(sys.argv[1])
deploy = fx["deploy"]
class Candidate(fx["Switch"]):
    target = fx["TARGET"]
    install = "c" * 16
    run_dir = pathlib.Path(sys.argv[2])
    emit = deploy.Checkout.emit
    def publish(self):
        (self.run_dir / "published").touch()
    def close(self):
        pass
deploy.run_switch = functools.partial(deploy.run_switch, samples=1, interval=0, timeout=1)
try:
    sys.exit(deploy.run_worker(Candidate()))
except BlockingIOError:
    sys.exit(17)
"""
        def enter():
            return subprocess.run([sys.executable, "-c", next_worker, __file__, str(contender)],
                                  capture_output=True, text=True, timeout=5)
        emit = self.adapter.emit
        refused = []
        def observe(event):
            emit(event)
            if event.get("recovery", {}).get("state") != "pending":
                return
            self.start_refusals = 0
            original = latest.read_bytes()
            child = enter()
            refused.append((json.loads(original), child.returncode, child.stderr,
                            latest.read_bytes() == original, sorted(p.name for p in contender.iterdir()),
                            json.loads((contender / "status.json").read_text())))
        self.adapter.emit = observe
        short_switch = functools.partial(deploy.run_switch, samples=1, interval=0, timeout=0)
        with patch.object(deploy, "run_switch", short_switch):
            self.assertEqual(deploy.run_worker(self.adapter), 1)
        self.assertEqual(len(refused), 1)
        rejected, code, stderr, kept_latest, writes, status = refused[0]
        self.assertEqual(code, 17, stderr)
        self.assertTrue(kept_latest)
        self.assertEqual(writes, ["status.json"])
        self.assertEqual((status["phase"], status["reason"]), ("finished", "install-lock-held"))
        self.assertEqual(rejected["recovery"]["ownerPid"], os.getpid())
        self.assertEqual(self.service_commands().count("stop"), 1)
        self.assertEqual(json.loads(latest.read_text())["recovery"]["state"], "complete")
        self.assertEqual(json.loads(self.pointer.read_text())["sha"], TARGET)
        child = enter()
        self.assertEqual(child.returncode, 0, child.stderr)
        self.assertTrue((contender / "published").exists())
        self.assertEqual(json.loads(latest.read_text())["run"], contender.name)

    def test_activating_without_a_job_keeps_recovery_owned_until_active(self):
        self.relocating()
        active_state = self.adapter.active_state
        unsettled = 20
        def state():
            nonlocal unsettled
            observed = active_state()
            if self.active and self.old_gone and unsettled:
                unsettled -= 1
                return "activating"
            return observed
        self.adapter.active_state = state
        result = deploy.run_switch(self.adapter, TARGET, samples=1, interval=0, timeout=0)
        self.assertEqual(unsettled, 0)
        self.assert_back_in_service(result)
        self.assertEqual(self.service_commands().count("stop"), 1)

    def test_final_cleanup_recovers_and_the_verdict_records_its_attempts(self):
        self.relocating()
        self.start_refusals = deploy.START_ATTEMPTS + 1
        self.adapter.run_dir = self.state / "deploy-verdicts/synthetic-cleanup"
        self.adapter.run_dir.mkdir(parents=True, mode=0o700)
        result = deploy.run_switch(self.adapter, TARGET, samples=1, interval=2, timeout=0)
        self.assert_back_in_service(result)
        # No healthy sample followed this last start, so the verdict stays fail.
        self.assertEqual(result["verdict"], "fail")
        saved = json.loads((self.adapter.run_dir / "verdict.json").read_text())
        self.assertEqual(saved["relocation"], result["relocation"])
        self.assertEqual(saved["relocation"]["startAttempts"], deploy.START_ATTEMPTS + 2)

    def test_unreadable_control_group_cannot_prove_release(self):
        self.relocating()
        self.never_released = True
        execute = self.adapter.command
        def unreadable(args, cwd=None):
            if not self.active and "show" in args and args[-2:] == ["-p", "ControlGroup"]:
                return ""
            return execute(args, cwd)
        self.adapter.command = unreadable
        result = deploy.run_switch(self.adapter, TARGET, samples=1, interval=2, timeout=0)
        self.assert_back_in_service(result)
        self.assertFalse(result["relocation"]["released"])
        self.assertEqual(result["relocation"]["outcome"], "not-released")
        self.assertEqual(result["verdict"], "fail")

    def test_unit_failure_after_last_health_sample_cannot_keep_a_pass(self):
        self.relocating()
        serving_samples = []
        serving = self.adapter.serving
        def record_serving():
            result = serving()
            serving_samples.append(result)
            return result
        self.adapter.serving = record_serving
        interrupted = self.adapter.interrupted
        def failed(since, hosts):
            answer = interrupted(since, hosts)
            self.active = False
            self.start_refusals = 1000
            return answer
        self.adapter.interrupted = failed
        result = deploy.run_switch(self.adapter, TARGET, samples=1, interval=2, timeout=5)
        self.assertTrue(any(sample["checks"]["service"] for sample in serving_samples))
        self.assertFalse(result["serving"]["checks"]["service"])
        self.assertTrue(self.active, {"remainingStartRefusals": self.start_refusals,
                                      "relocation": result["relocation"]})
        self.assert_back_in_service(result)
        self.assertEqual(result["relocation"]["outcome"], "released")
        self.assertEqual(result["verdict"], "fail")
        self.assertIn("exit-recovery:health-unverified", result["diagnostics"])

    def test_an_exception_during_observation_still_retries_start_on_exit(self):
        self.relocating()
        self.start_refusals = 10
        self.adapter.run_dir = self.state / "deploy-verdicts/synthetic-interrupted"
        self.adapter.run_dir.mkdir(parents=True, mode=0o700)
        # Even an abrupt observation failure retains the recovery obligation.
        original_process = self.adapter.process
        def process(entry):
            if self.old_gone and not self.active:
                raise KeyboardInterrupt()
            return original_process(entry)
        self.adapter.process = process
        with self.assertRaises(KeyboardInterrupt):
            deploy.run_switch(self.adapter, TARGET, samples=3, interval=2, timeout=5)
        self.assertTrue(self.active)
        self.assertEqual(self.service_commands()[-1], "start")
        saved = json.loads((self.adapter.run_dir / "verdict.json").read_text())
        self.assertEqual(saved["verdict"], "fail")
        self.assertTrue(saved["relocation"]["started"])
        self.assertEqual(saved["recovery"]["state"], "complete")

    def test_new_agent_and_child_after_preflight_are_never_signalled(self):
        for parent in [102, 103]:
            for registered in [True, False]:
                with self.subTest(parent=parent, registered=registered):
                    self.setUp()
                    self.relocating()
                    publish = self.adapter.publish
                    def admit():
                        publish()
                        self.parents.update({160: parent, 161: 160})
                        self.pgroups.update({160: 160, 161: 160})
                        self.members = self.members + [160, 161]
                        self.surviving = {160, 161}
                        if registered:
                            self.inventory_overrides = {"conversations": [{"host": {"state": "alive", "pid": 160},
                                                                          "evidenceSource": "transcript"}]}
                    self.adapter.publish = admit
                    result = deploy.run_switch(self.adapter, TARGET, samples=3, interval=2, timeout=5)
                    self.assert_back_in_service(result)
                    self.assertEqual(self.signals, [])
                    self.assertEqual(self.surviving, {160, 161})
                    self.assertTrue(all(not row["proven"] for row in result["relocation"]["survivors"]))
                    self.assertEqual(result["relocation"]["outcome"], "unproven-survivors")
                    self.assertEqual(result["verdict"], "fail")

    def test_agent_admitted_after_inventory_refresh_is_never_signalled(self):
        self.relocating()
        read = self.adapter.census_adapter
        def activity(*args):
            answer = read(*args)
            if self.inventory_reads == 2:
                self.parents.update({160: 103, 161: 160})
                self.pgroups.update({160: 160, 161: 160})
                self.members = self.members + [160, 161]
                self.surviving = {160, 161}
            return answer
        self.adapter.census_adapter = activity
        result = deploy.run_switch(self.adapter, TARGET, samples=3, interval=2, timeout=5)
        self.assert_back_in_service(result)
        self.assertEqual(self.signals, [])
        self.assertEqual(self.surviving, {160, 161})
        self.assertEqual(result["relocation"]["outcome"], "unproven-survivors")
        self.assertEqual(result["verdict"], "fail")

    def test_agent_admitted_between_capture_and_stop_is_never_signalled(self):
        self.relocating()
        execute = self.adapter.command
        def admit(args, cwd=None):
            if args[:4] == ["systemctl", "--user", "--no-block", "stop"]:
                self.parents.update({160: 103, 161: 160})
                self.pgroups.update({160: 160, 161: 160})
                self.members = self.members + [160, 161]
                self.surviving = {160, 161}
            return execute(args, cwd)
        self.adapter.command = admit
        result = deploy.run_switch(self.adapter, TARGET, samples=3, interval=2, timeout=5)
        self.assert_back_in_service(result)
        self.assertEqual(self.signals, [])
        self.assertEqual(self.surviving, {160, 161})
        self.assertEqual(result["relocation"]["outcome"], "unproven-survivors")
        self.assertEqual(result["verdict"], "fail")

    def test_helper_that_leaves_viewer_group_before_pidfd_validation_is_not_signalled(self):
        self.relocating(survivors=[150])
        signal_process = self.adapter.signal_process
        def moved(entry, signum, group, read):
            self.pgroups[entry["pid"]] = entry["pid"]
            return signal_process(entry, signum, group, read)
        self.adapter.signal_process = moved
        result = deploy.run_switch(self.adapter, TARGET, samples=3, interval=2, timeout=5)
        self.assert_back_in_service(result)
        self.assertEqual(self.signals, [])
        self.assertEqual(self.surviving, {150})
        self.assertEqual(result["verdict"], "fail")

    def test_a_refused_stop_still_ends_with_a_start(self):
        self.relocating()
        self.stop_refused = True
        result = deploy.run_switch(self.adapter, TARGET, samples=3, interval=2, timeout=5)
        self.assertEqual(self.service_commands(), ["stop", "start"])
        self.assertTrue(self.active)
        self.assertEqual(result["relocation"]["outcome"], "stop-incomplete")
        self.assertEqual(result["verdict"], "fail")

    def test_a_configured_cpu_weight_that_is_not_in_effect_fails_placement(self):
        self.relocating()
        self.weight_effective = False
        result = deploy.run_switch(self.adapter, TARGET, samples=3, interval=2, timeout=5)
        self.assertEqual(result["relocation"]["placement"], "placed")
        self.assertFalse(result["serving"]["checks"]["placement"])
        self.assertEqual(result["serving"]["placement"]["effectiveWeight"], None)
        self.assertEqual(result["verdict"], "fail")

    def test_missing_invalid_or_lower_configured_cpu_weight_fails_after_start(self):
        for weight in [None, "", "invalid", "[not set]", "100"]:
            with self.subTest(weight=weight):
                self.setUp()
                self.relocating(weight=weight)
                result = deploy.run_switch(self.adapter, TARGET, samples=1, timeout=5)
                self.assert_back_in_service(result)
                self.assertFalse(result["serving"]["checks"]["placement"])
                self.assertEqual(result["verdict"], "fail")

    def test_absent_cpu_weight_property_fails_with_or_without_kernel_weight(self):
        for effective in [False, True]:
            with self.subTest(effective=effective):
                self.setUp()
                self.relocating()
                self.weight_effective = effective
                execute = self.adapter.command
                def without_weight(args, cwd=None):
                    return "\n".join(line for line in execute(args, cwd).splitlines()
                                     if not line.startswith("CPUWeight="))
                self.adapter.command = without_weight
                result = deploy.run_switch(self.adapter, TARGET, samples=1, timeout=5)
                self.assert_back_in_service(result)
                self.assertFalse(result["serving"]["checks"]["placement"])
                self.assertEqual(result["serving"]["placement"]["effectiveWeight"], "1000" if effective else None)
                self.assertEqual(result["verdict"], "fail")

    def test_configured_app_slice_and_matching_actual_path_fail_after_start(self):
        self.relocating()
        self.slice = "app.slice"
        self.slice_group = "/user.slice/app.slice"
        result = deploy.run_switch(self.adapter, TARGET, samples=1, timeout=5)
        self.assert_back_in_service(result)
        self.assertFalse(result["serving"]["checks"]["placement"])
        self.assertEqual(result["verdict"], "fail")

    def test_wrong_invalid_or_unreadable_kernel_cpu_weight_fails_after_start(self):
        for weight in ["100", "invalid", "", None]:
            with self.subTest(weight=weight):
                self.setUp()
                self.relocating()
                execute = self.execute
                def wrong_weight(args, cwd=None):
                    output = execute(args, cwd)
                    if args[:4] == ["systemctl", "--user", "--no-block", "start"]:
                        path = self.cgroup / self.service_group.lstrip("/") / "cpu.weight"
                        if weight is None:
                            path.unlink()
                            path.mkdir()
                        else:
                            path.write_text(weight + "\n")
                    return output
                self.adapter.command = wrong_weight
                result = deploy.run_switch(self.adapter, TARGET, samples=1, timeout=5)
                self.assert_back_in_service(result)
                self.assertFalse(result["serving"]["checks"]["placement"])
                self.assertEqual(result["verdict"], "fail")

    def test_correct_placement_passes(self):
        self.answer_relaunch()
        result = deploy.run_switch(self.adapter, TARGET, samples=3, interval=2, timeout=5)
        self.assertEqual(result["verdict"], "pass")
        self.assertTrue(result["serving"]["checks"]["placement"])
        self.assertEqual(result["serving"]["placement"]["actual"], result["serving"]["placement"]["expected"])
        self.assertEqual(result["serving"]["placement"]["slice"], "delegatus.slice")
        self.assertEqual(result["serving"]["placement"]["weight"], "1000")
        self.assertEqual(result["serving"]["placement"]["effectiveWeight"], "1000")

    def test_the_baseline_may_serve_from_the_old_cgroup_before_its_restart(self):
        self.service_group = "/user.slice/app.slice/synthetic-viewer.service"
        self.members = self.members
        self.adapter.preflight()

    def test_pipeline_runs_reconcile_recovered_attempt(self):
        self.assert_stage_verdict(self.attempts, "pass", "recovered", 1)

    def test_pipeline_runs_reconcile_fresh_attempt_after_loss(self):
        self.assert_stage_verdict([
            {"n": 1, "state": "failed", "error": "stage host was lost while its turn was open"},
            {"n": 2, "state": "running", "conversationId": "synthetic-replacement"}],
            "pass", "fresh attempt started", 2)

    def test_shared_successor_is_read_once_per_sample_and_rechecked_after_exit(self):
        self.old_gone = True
        self.attempts = [{"n": 2, "state": "running", "conversationId": "synthetic-stage"}]
        host = {"pipelineId": "synthetic-lane", "stageId": "build", "attempt": 1}
        inputs = list(enumerate([host] * 12))
        calls = {"pipeline": 0, "census": 0, "process": 0}
        original_call, original_census = self.adapter.mcp.call, self.adapter.read_host_census
        alive = True
        def call(tool, args):
            calls["pipeline"] += 1
            return original_call(tool, args)
        def census():
            calls["census"] += 1
            return original_census()
        def process(entry):
            calls["process"] += 1
            return entry if alive else None
        self.adapter.mcp.call, self.adapter.read_host_census, self.adapter.process = call, census, process
        def sample():
            return [row[1]["outcome"] for kind, row in deploy.evidence_frames(self.adapter, "protected", inputs, self.adapter.clock.now()+30)
                    if kind == "protected"]
        self.assertEqual(sample(), ["fresh attempt started"] * 12)
        self.assertEqual(calls, {"pipeline": 1, "census": 1, "process": 12})
        alive = False
        self.assertEqual(sample(), ["unknown"] * 12)
        self.assertEqual(calls, {"pipeline": 2, "census": 2, "process": 24})

    def test_pipeline_runs_reconcile_completed_attempt(self):
        self.assert_stage_verdict([{"n": 1, "state": "passed", "conversationId": "synthetic-stage"}],
                                  "pass", "completed", 1)

    def test_pipeline_runs_reconcile_lost_attempt(self):
        self.assert_stage_verdict([{"n": 1, "state": "failed", "conversationId": "synthetic-stage",
                                   "error": "stage host was lost while its turn was open"}], "fail", "lost", 1)

    def test_pipeline_runs_reconcile_pending_attempt(self):
        self.assert_stage_verdict([{"n": 1, "state": "spawning", "conversationId": "synthetic-stage"}],
                                  "needs_decision", "unknown", 1)

    def test_terminal_attempt_verdicts_survive_activity_transport_failure(self):
        original = self.adapter.mcp.call
        def read(tool, args):
            if args.get("conversationId"):
                raise ConnectionError("targeted activity unavailable")
            return original(tool, args)
        self.adapter.mcp.call = read
        self.old_gone = True
        host = {"pipelineId": "synthetic-lane", "stageId": "build", "attempt": 1}
        for state, error, expected in [
                ("passed", None, "completed"),
                ("failed", "stage host was lost while its turn was open", "lost")]:
            with self.subTest(outcome=expected):
                self.attempts = [{"n": 1, "state": state, "error": error, "conversationId": "synthetic-stage"}]
                self.assertEqual(self.adapter.stage(host)["outcome"], expected)

    def test_degraded_targeted_activity_cannot_prove_recovery(self):
        self.recovery_overrides = {"evidence": "pending", "unverifiedCount": 1}
        self.assert_stage_verdict(self.attempts, "needs_decision", "unknown", 1)

    def test_unrelated_targeted_activity_cannot_prove_recovery(self):
        self.recovery_overrides = {"conversations": [{"conversationId": "synthetic-other",
            "evidenceSource": "transcript", "host": {"state": "alive", "pid": 204}, "lifecycle": "running"}]}
        self.assert_stage_verdict(self.attempts, "needs_decision", "unknown", 1)

    def assert_incomplete_inventory_refused(self, overrides):
        self.inventory_overrides = overrides
        with self.assertRaisesRegex(RuntimeError, "protected activity capture incomplete"):
            deploy.run_switch(self.adapter, TARGET, samples=3, interval=2, timeout=5)
        self.assertGreater(self.inventory_reads, 1)
        self.assertLessEqual(self.adapter.clock.now(), 30)
        self.assertEqual(json.loads(self.pointer.read_text()), self.baseline)
        self.assertEqual(self.service_commands(), [])

    def test_capped_protected_inventory_never_authorizes_switch(self):
        self.assert_incomplete_inventory_refused({"unselectedCount": 1, "selection": {
            "matched": 201, "selected": 200, "recoveryPending": 0, "recoveryTruncated": False}})

    def test_pending_hosted_recovery_never_authorizes_switch(self):
        self.assert_incomplete_inventory_refused({"selection": {
            "matched": 1, "selected": 1, "recoveryPending": 1, "recoveryTruncated": True}})

    def test_degraded_protected_inventory_never_authorizes_switch(self):
        self.assert_incomplete_inventory_refused({"catalog": "stale", "evidence": "pending", "unverifiedCount": 1})

    def test_each_incomplete_inventory_signal_is_fenced(self):
        selection = {"matched": 1, "selected": 1, "recoveryPending": 0, "recoveryTruncated": False,
                     "cacheStatus": "fresh", "projected": 0, "unreadable": 0}
        signals = [{"unselectedCount": 1}, {"catalog": "pending"}, {"catalog": "stale"},
                   {"evidence": "pending"}, {"unverifiedCount": 1}, {"undescribedHostCount": 1},
                   {"undescribedTargetCount": 1}, {"selection": {}}]
        signals.extend({"conversations": [{"evidenceSource": source}]} for source in ["projection", "unreadable"])
        signals.extend({"selection": {**selection, key: value}} for key, value in [
            ("matched", 2), ("recoveryPending", 1), ("recoveryTruncated", True),
            ("cacheStatus", "pending"), ("cacheStatus", "stale"), ("projected", 1), ("unreadable", 1)])
        for signal in signals:
            with self.subTest(signal=signal):
                self.adapter.clock = FakeClock()
                self.inventory_reads = 0
                self.assert_incomplete_inventory_refused(signal)

    def test_transient_incomplete_inventory_retries_to_complete_capture(self):
        self.relocating()
        self.inventory_overrides = lambda n: {"selection": {
            "matched": 1, "selected": 1, "recoveryPending": 1, "recoveryTruncated": True}} if n < 3 else {}
        result = deploy.run_switch(self.adapter, TARGET, samples=3, interval=2, timeout=5)
        self.assertEqual(result["verdict"], "pass")
        self.assertEqual(result["protected"][0]["outcome"], "recovered")
        self.assertEqual(self.inventory_reads, 5)  # Three preflight reads, retirement refresh and pending-stop census.
        self.assertEqual(self.service_commands(), ["stop", "start"])

    def test_preflight_failure_never_publishes_or_restarts(self):
        deploy.write_json(self.evidence, {"sha": TARGET, "viewer": "pass", "runtimeHost": "fail"})
        with self.assertRaises(RuntimeError):
            deploy.run_switch(self.adapter, TARGET, samples=3, interval=2, timeout=5)
        self.assertEqual(json.loads(self.pointer.read_text()), self.baseline)
        self.assertEqual(self.service_commands(), [])

    @contextlib.contextmanager
    def board_http(self, status=200, body=b'{"tasks":[]}'):
        import http.server
        import threading
        fixture = self
        paths = []
        # Many valid-sized rows make the unfiltered board exceed the read cap.
        full_board = json.dumps({"tasks": [{"text": "x" * 3000}] * 1500}).encode()
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_GET(self):
                paths.append(self.path)
                code = 200
                if self.path == "/api/tasks":
                    answer = full_board
                elif self.path == "/api/tasks?project=":
                    code, answer = status, body
                elif self.path == "/oversized":
                    answer = full_board
                else:
                    answer = fixture.http(0, self.path, "synthetic-secret")
                self.send_response(code)
                self.send_header("Content-Length", str(len(answer)))
                self.end_headers()
                with contextlib.suppress(BrokenPipeError, ConnectionResetError):
                    self.wfile.write(answer)
        with http.server.HTTPServer(("127.0.0.1", 0), Handler) as server:
            thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
            thread.start()
            try:
                record = json.loads(self.record_file.read_text())
                record["port"] = server.server_address[1]
                deploy.write_json(self.record_file, record)
                self.adapter.http = deploy.http_read
                yield record["port"], paths, full_board
            finally:
                server.shutdown()
                thread.join(timeout=2)

    def test_large_board_passes_serving_and_preflight_without_reading_full_board(self):
        with self.board_http() as (port, paths, full_board):
            self.assertGreater(len(full_board), 4 * 1024 * 1024)
            for route in ["/api/tasks", "/oversized"]:
                with self.assertRaisesRegex(RuntimeError, "HTTP health oversized"):
                    deploy.http_read(port, route, "synthetic-secret")
            paths.clear()
            self.assertTrue(self.adapter.serving()["checks"]["http"])
            self.adapter.preflight()
            self.assertEqual(paths.count("/api/tasks?project="), 2)
            self.assertEqual(paths.count("/api/self-update?work=0&readOnly=1"), 2)
            self.assertNotIn("/api/tasks", paths)
            self.assertEqual(json.loads(self.pointer.read_text()), self.baseline)
            self.assertEqual(self.service_commands(), [])

    def test_broken_board_refuses_serving_and_preflight_without_publication_or_restart(self):
        for status, body in [(503, b'{"tasks":[]}'), (200, b'{broken'), (200, b'{}'),
                             (200, b'{"tasks":{}}'), (200, b'{"tasks":null}'), (200, b'[]'),
                             (200, b"x" * (4 * 1024 * 1024 + 1))]:
            with self.subTest(status=status, bodyBytes=len(body)), self.board_http(status, body) as (_, paths, _):
                self.adapter.clock = FakeClock()
                self.assertFalse(self.adapter.serving()["checks"]["http"])
                with self.assertRaisesRegex(RuntimeError, "baseline serving health unavailable"):
                    self.adapter.preflight()
                self.assertIn("/api/tasks?project=", paths)
                self.assertNotIn("/api/tasks", paths)
                self.assertEqual(json.loads(self.pointer.read_text()), self.baseline)
                self.assertEqual(self.service_commands(), [])

    def test_plan_requires_explicit_matching_state(self):
        with patch.dict(os.environ, {"LLV_STATE_DIR": ""}):
            with self.assertRaises(RuntimeError):
                deploy.Checkout(self.plan)

    def test_live_serving_identity_is_independent_of_a_new_pointer(self):
        self.adapter.preflight()
        self.adapter.publish()
        result = self.adapter.serving()
        self.assertEqual(result["viewer"]["sha"], OLD)
        self.assertFalse(deploy.ready(result, TARGET))

    def test_health_reads_continue_when_mcp_is_unavailable(self):
        self.mcp_failures = 1
        result = self.adapter.serving()
        self.assertEqual(result["viewer"]["sha"], OLD)
        self.assertTrue(result["checks"]["http"])
        self.assertTrue(result["checks"]["runtimeSocket"])
        self.assertFalse(result["checks"]["mcp"])

    def test_listener_mismatch_cannot_be_healthy(self):
        execute = self.adapter.command
        self.adapter.command = lambda args, cwd=None: "pid=999" if args[0] == "ss" else execute(args, cwd)
        self.assertFalse(self.adapter.serving()["checks"]["service"])

    def test_terminal_artifacts_are_private_and_readable_after_adapter_closes(self):
        self.answer_relaunch()
        self.adapter.run_dir = self.state / "deploy-verdicts/synthetic-run"
        self.adapter.run_dir.mkdir(parents=True, mode=0o700)
        result = deploy.run_switch(self.adapter, TARGET, samples=3, interval=2, timeout=5)
        self.adapter.close()
        verdict = json.loads((self.adapter.run_dir / "verdict.json").read_text())
        self.assertEqual(verdict["verdict"], result["verdict"])
        latest = json.loads((self.adapter.run_dir.parent / ("latest-" + "c" * 16 + ".json")).read_text())
        self.assertEqual(latest["run"], "synthetic-run")
        log = (self.adapter.run_dir / "switch.log").read_text()
        self.assertEqual(log.count('"sample":'), 3)
        self.assertIn("Verdict: pass launcher=" + TARGET, log)
        self.assertIn("viewer=" + TARGET + " since=2026-01-01T00:00:00Z", log)
        self.assertNotIn("synthetic-secret", log)
        for name in ["switch.log", "verdict.json"]:
            self.assertEqual((self.adapter.run_dir / name).stat().st_mode & 0o777, 0o600)

    def test_stale_activity_alive_row_cannot_prove_recovery(self):
        original = self.adapter.process
        self.adapter.process = lambda entry: None
        outcome = self.adapter.stage({"pipelineId": "synthetic-lane", "stageId": "build", "attempt": 1})
        self.assertEqual((outcome["outcome"], outcome["reason"]), ("unknown", "replacement-process-gone"))
        self.adapter.process = original

    def test_replacement_evidence_must_bind_pipeline_attempt_boot_and_process_identity(self):
        cases = [
            ({"pipeline": {"pipelineId": "other-lane"}}, "replacement-pipeline-mismatch"),
            ({"pipeline": {"stageId": "other-stage"}}, "replacement-pipeline-mismatch"),
            ({"pipeline": {"attempt": 1}}, "replacement-pipeline-mismatch"),
            ({"host": {"process": {"bootEpoch": "other-boot"}}}, "replacement-process-identity-unverified"),
            ({"host": {"process": {"startIdentity": "204:stale"}}}, "replacement-process-identity-unverified"),
            ({"host": {"process": None}}, "replacement-process-identity-unverified"),
        ]
        self.old_gone = True
        self.attempts = [{"n": 1, "state": "failed", "conversationId": "synthetic-stage",
                          "error": "stage host was lost while its turn was open"},
                         {"n": 2, "state": "running", "conversationId": "synthetic-replacement"}]
        for overrides, reason in cases:
            with self.subTest(reason=reason, overrides=overrides):
                self.replacement_overrides = overrides
                outcome = self.adapter.stage({"pipelineId": "synthetic-lane", "stageId": "build", "attempt": 1})
                self.assertEqual((outcome["outcome"], outcome.get("reason")), ("unknown", reason))

    def test_replacement_census_cannot_reuse_the_captured_process_identity(self):
        self.old_gone = True
        self.attempts = [{"n": 1, "state": "failed", "conversationId": "synthetic-stage",
                          "error": "stage host was lost while its turn was open"},
                         {"n": 2, "state": "running", "conversationId": "synthetic-replacement"}]
        captured = {"pipelineId": "synthetic-lane", "stageId": "build", "attempt": 1,
                    "startIdentity": "42"}
        self.replacement_overrides = {"host": {"process": {"startIdentity": "204:42"}}}
        outcome = self.adapter.stage(captured)
        self.assertEqual((outcome["outcome"], outcome.get("reason")),
                         ("unknown", "replacement-process-identity-not-fresh"))

    def test_legacy_capture_without_boot_epoch_still_accepts_verified_replacement(self):
        self.old_gone = True
        self.attempts = [{"n": 1, "state": "failed", "conversationId": "synthetic-stage",
                          "error": "stage host was lost while its turn was open"},
                         {"n": 2, "state": "running", "conversationId": "synthetic-replacement"}]
        captured = {"pipelineId": "synthetic-lane", "stageId": "build", "attempt": 1}
        outcome = self.adapter.stage(captured)
        self.assertEqual((outcome["outcome"], outcome["attempt"]), ("fresh attempt started", 2))


class SampleSupervision(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="checkout-sample-")
        self.addCleanup(temp.cleanup)
        self.root = pathlib.Path(temp.name)
        self.state = self.root / "state"
        self.state.mkdir()
        (self.root / "bin").mkdir()
        token = self.root / "service.env"
        token.write_text("LLV_TOKEN=synthetic\n")
        self.plan = self.root / "plan.json"
        deploy.write_json(self.plan, {"stateDir": str(self.state), "installId": "c" * 16, "target": TARGET,
                                     "checkout": str(self.root), "releaseDir": str(self.root),
                                     "tokenFile": str(token), "verificationFile": str(self.root / "verification"),
                                     "unit": "synthetic-viewer.service", "baselinePointer": {}, "bun": sys.executable})
        env = patch.dict(os.environ, {"LLV_STATE_DIR": str(self.state), "PYTHONDONTWRITEBYTECODE": "1"})
        env.start()
        self.addCleanup(env.stop)
        self.calls = self.root / "calls.jsonl"
        (self.root / "bin/mcp-server.mjs").write_text("""import json, os, pathlib, subprocess, sys, time
def record(*data):
    with open("calls.jsonl", "a") as stream:
        stream.write(json.dumps(data) + "\\n")
for line in sys.stdin:
    request = json.loads(line)
    if "id" not in request:
        continue
    result = {}
    if request["method"] == "tools/list":
        result = {"tools": [{"name": "get_pipeline"}]}
    elif request["method"] == "tools/call":
        tool, args = request["params"]["name"], request["params"]["arguments"]
        name = args.get("pipelineId", args.get("conversationId", "serving"))
        record(tool, name, os.getpid())
        if tool in ["get_pipeline", "list_pipelines"] and "clientRequestId" in args:
            raise AssertionError("read request would write a receipt")
        if name.startswith("late-") or name.startswith("stalled-"):
            child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
            record("descendant", name, child.pid)
            time.sleep(6 if name.startswith("late-") else 60)
            record("late-reply", name, os.getpid())
        if tool == "get_pipeline":
            state = "running" if name.startswith(("dead-", "pending-")) else "passed"
            attempt = {"n": 1, "state": state}
            if name.startswith("dead-"):
                attempt["conversationId"] = name
            result = {"ok": True, "pipeline": {"runs": [{"stageId": "build", "attempts": [attempt]}]}}
        elif tool == "list_pipelines":
            result = {"ok": True, "pipelines": []}
        else:
            raise AssertionError(tool)
        if name.startswith("unavailable-"):
            result = {"ok": False}
    wire = result if request["method"] == "tools/list" else {"structuredContent": result}
    print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": wire}), flush=True)
""")
        self.driver = self.root / "evidence-worker.py"
        self.driver.write_text(f"""import runpy, pathlib, sys, time
fixture = runpy.run_path({str(pathlib.Path(__file__).resolve())!r})
deploy = fixture["deploy"]
class Checkout(deploy.Checkout):
    def read_host_census(self):
        rows = [{{"conversationId": key, "evidenceSource":"transcript", "turnState":"unknown",
                  "lifecycle":"gone", "host":{{"state":"gone"}}}} for key in ("dead-1","dead-3")]
        return {{"ok": True, "conversations": rows, "unselectedCount": 0,
            "selection": {{"matched": len(rows), "selected": len(rows), "recoveryPending": 0,
            "recoveryTruncated": False, "cacheStatus": "hit", "projected": 0, "unreadable": 0}}}}
    def serving(self):
        self.mcp.probe()
        if (self.checkout / "late-serving").exists():
            time.sleep(1.8)
        return fixture["Switch"]().serving()
deploy.Checkout = Checkout
sys.exit(deploy.evidence_worker(sys.argv[2]))
""")

    def run_sample(self, names, *, driver=True, timeout=1.5):
        switch = Switch()
        switch.clock, switch.config_file, switch.old = deploy.Clock(), self.plan, []
        switch.plan = json.loads(self.plan.read_text())
        switch.sample = functools.partial(deploy.collect_sample, switch)
        switch.hosts = [{"pipelineId": name, "stageId": "build", "attempt": 1, "pid": 100 + index,
                         "conversationId": "original-" + name} for index, name in enumerate(names)]
        started = time.monotonic()
        with patch.object(deploy, "__file__", str(self.driver) if driver else deploy.__file__):
            result = deploy.run_switch(switch, TARGET, samples=1, interval=0, timeout=timeout)
        elapsed = time.monotonic() - started
        self.assertLess(elapsed, timeout + 0.15)
        self.assertEqual([row["captured"] for row in result["protected"]], switch.hosts)
        self.assertTrue(switch.published)
        return result

    def recorded(self):
        return [json.loads(line) for line in self.calls.read_text().splitlines()]

    def assert_workers_stopped(self, calls):
        pids = {pid for _, _, pid in calls}
        def stopped(pid):
            try:
                return deploy.proc_field(pid, "stat").split(") ")[-1].split()[0] in ["Z", "X"]
            except FileNotFoundError:
                return True
        self.assertTrue(all(stopped(pid) for pid in pids))

    def test_healthy_keeps_terminal_rows_and_real_cut_inventory(self):
        result = self.run_sample(["complete-" + str(i) for i in range(8)], timeout=5)
        self.assertEqual(result["verdict"], "pass", result)
        self.assertEqual(result["interrupted"], [])
        self.assertTrue(all(row["outcome"] == "completed" for row in result["protected"]))
        calls = self.recorded()
        self.assertTrue(all(tool in ["get_pipeline", "list_pipelines", "descendant"] for tool, _, _ in calls))
        self.assertEqual(len({pid for tool, _, pid in calls if tool == "get_pipeline"}), deploy.PROTECTED_READERS)
        self.assert_workers_stopped(calls)

    def test_post_frame_nonzero_exit_without_worker_done_never_passes_any_lane(self):
        host = {"pipelineId": "synthetic", "stageId": "build", "attempt": 1}
        serving = {**{role: {"sha": TARGET, "healthy": True} for role in ["launcher", "viewer", "runtimeHost"]},
                   "checks": dict.fromkeys(["http", "runtimeSocket", "mcp", "service", "placement"], True)}
        with tempfile.TemporaryDirectory(prefix="checkout-incomplete-worker-") as directory:
            driver = pathlib.Path(directory) / "worker.py"
            driver.write_text(
                "import json,sys\nkind,inputs,deadline,plan=json.load(sys.stdin)\n"
                "frame=(['protected',[inputs[0][0],{'outcome':'completed','attempt':1}]] if kind=='protected' else "
                "['interrupted',[[],[]]] if kind=='interrupted' else ['serving'," + repr(serving) + "])\n"
                "print(json.dumps(frame),flush=True)\nsys.exit(23)\n")
            adapter = type("Adapter", (), {"plan": {}, "config_file": self.plan})()
            lanes = [
                ("protected", [(0, host)]),
                ("serving", [[], TARGET]),
                ("interrupted", ["2026-01-01T00:00:00Z", [host]]),
            ]
            for lane in lanes:
                sample = deploy.EvidenceSample([host])
                with patch.object(deploy, "__file__", str(driver)):
                    deploy.run_evidence_workers(adapter, [lane], sample, time.monotonic() + 1)
                self.assertTrue(sample.incomplete, lane[0])
                self.assertTrue(any(lane[0] + ":worker-exit:23" in item for item in sample.diagnostics), sample.diagnostics)
                if lane[0] == "protected":
                    self.assertEqual(sample.protected[0]["outcome"], "completed")

    def test_premature_eof_keeps_peer_result_and_cleanup_reserve(self):
        host = {"pipelineId": "synthetic", "stageId": "build", "attempt": 1}
        with tempfile.TemporaryDirectory(prefix="checkout-peer-eof-") as directory:
            driver = pathlib.Path(directory) / "worker.py"
            driver.write_text(
                "import json,os,sys,time\nkind,inputs,deadline,plan=json.load(sys.stdin)\n"
                "if kind=='protected':\n print(json.dumps(['reading',0]),flush=True); os.close(1); time.sleep(60)\n"
                "else:\n print(json.dumps(['interrupted',[[],[]]]),flush=True); time.sleep(.25); print(json.dumps(['worker-done']),flush=True)\n")
            adapter = type("Adapter", (), {"plan": {}, "config_file": self.plan})()
            sample = deploy.EvidenceSample([host])
            started = time.monotonic()
            with patch.object(deploy, "__file__", str(driver)):
                deploy.run_evidence_workers(adapter, [
                    ("protected", [(0, host)]), ("interrupted", ["2026-01-01T00:00:00Z", [host]])
                ], sample, started + 1.5)
            self.assertLess(time.monotonic() - started, 1.5)
            self.assertEqual(sample.interrupted, [])
            self.assertEqual(sample.protected[0]["reason"], "worker-exit-unconfirmed", sample.diagnostics)
            self.assertFalse(any("worker-cleanup-pending" in item for item in sample.diagnostics))

    def test_mixed_finishes_while_late_transport_and_descendant_are_stopped(self):
        names = ["pending-0", "dead-1", "unavailable-2", "dead-3",
                 "unavailable-4", "late-5", "stalled-6", "complete-7"]
        result = self.run_sample(names, timeout=5)
        self.assertEqual(result["verdict"], "needs_decision", result)
        self.assertTrue(deploy.ready(result["serving"], TARGET))
        self.assertEqual([row.get("reason") for row in result["protected"]], [
            "stage-conversation-pending", "replacement-pipeline-mismatch", "pipeline-unavailable:RuntimeError",
            "replacement-pipeline-mismatch", "pipeline-unavailable:RuntimeError", "sample-deadline",
            "sample-deadline", None])
        self.assertEqual(result["protected"][-1]["outcome"], "completed")
        calls = self.recorded()
        self.assertTrue(all(tool in ["get_pipeline", "list_pipelines", "descendant"] for tool, _, _ in calls))
        self.assertFalse(any(tool == "late-reply" for tool, _, _ in calls))
        self.assertEqual(sum(tool == "descendant" for tool, _, _ in calls), 2)
        self.assert_workers_stopped(calls)

    def test_stalled_and_queued_hosts_keep_all_identities(self):
        result = self.run_sample(["stalled-" + str(i) for i in range(8)])
        self.assertEqual(result["verdict"], "needs_decision")
        self.assertTrue(all(row["reason"] == "sample-deadline" for row in result["protected"]))
        calls = self.recorded()
        self.assertTrue(all(tool in ["get_pipeline", "list_pipelines", "descendant"] for tool, _, _ in calls))
        self.assertEqual(sum(tool == "get_pipeline" for tool, _, _ in calls), deploy.PROTECTED_READERS)
        self.assert_workers_stopped(calls)

    def test_late_serving_cannot_turn_complete_work_into_a_pass(self):
        (self.root / "late-serving").touch()
        result = self.run_sample(["complete-0"])
        self.assertEqual(result["verdict"], "fail")
        self.assertEqual(result["protected"][0]["outcome"], "completed")
        self.assertIn("serving:sample-deadline", result["diagnostics"])
        self.assert_workers_stopped(self.recorded())

    def test_worker_launch_stall_is_supervised_from_before_exec(self):
        host = {"pipelineId": "synthetic", "stageId": "build", "attempt": 1}
        adapter = type("Adapter", (), {"plan": {}, "config_file": self.plan})()
        sample = deploy.EvidenceSample([host])
        started = time.monotonic()
        with patch.object(deploy.os, "execve", side_effect=lambda *args: time.sleep(60)):
            deploy.run_evidence_workers(adapter, [("protected", [(0, host)])], sample, started + 0.4)
        self.assertLess(time.monotonic() - started, 0.55)
        self.assertEqual(sample.protected[0]["reason"], "sample-deadline")

    def test_unexpected_worker_exits_keep_their_cause_and_prior_frames(self):
        host = {"pipelineId": "synthetic", "stageId": "build", "attempt": 1}
        adapter = type("Adapter", (), {"plan": {}, "config_file": self.plan})()
        with tempfile.TemporaryDirectory(prefix="checkout-worker-exit-") as directory:
            driver = pathlib.Path(directory) / "worker.py"
            for body, expected in [
                    ("import sys; sys.exit(23)\n", "worker-exit:23"),
                    ("import json,os,signal; print(json.dumps(['reading',0]),flush=True); os.kill(os.getpid(),signal.SIGKILL)\n",
                     "worker-signal:SIGKILL")]:
                driver.write_text(body)
                sample = deploy.EvidenceSample([host])
                with patch.object(deploy, "__file__", str(driver)):
                    deploy.run_evidence_workers(adapter, [("protected", [(0, host)])], sample,
                                                time.monotonic() + 1)
                self.assertEqual(sample.protected[0]["reason"], expected)
                if expected == "worker-signal:SIGKILL":
                    self.assertEqual(sample.protected[0]["outcome"], "unknown")

    def test_reap_timeout_is_reported_without_waiting_past_sample_cutoff(self):
        host = {"pipelineId": "synthetic", "stageId": "build", "attempt": 1}
        adapter = type("Adapter", (), {"plan": {}, "config_file": self.plan})()
        with tempfile.TemporaryDirectory(prefix="checkout-worker-reap-") as directory:
            driver = pathlib.Path(directory) / "worker.py"
            driver.write_text("import json; print(json.dumps(['protected',[0,{'outcome':'completed','attempt':1}]]),flush=True); print(json.dumps(['worker-done']),flush=True)\n")
            sample = deploy.EvidenceSample([host])
            started = time.monotonic()
            reaped = []
            waitpid = os.waitpid
            def hold_receipt(pid, options):
                reaped.append(pid)
                return 0, 0
            with patch.object(deploy, "__file__", str(driver)), patch.object(deploy.os, "waitpid", side_effect=hold_receipt):
                deploy.run_evidence_workers(adapter, [("protected", [(0, host)])], sample, started + 0.35)
            self.assertLess(time.monotonic() - started, 0.5)
            self.assertEqual(sample.protected[0]["outcome"], "completed")
            self.assertNotIn("reason", sample.protected[0])
            self.assertTrue(any("worker-cleanup-pending" in item for item in sample.diagnostics))
            for pid in set(reaped):
                with contextlib.suppress(ChildProcessError):
                    waitpid(pid, 0)

    def test_unreaped_workers_keep_their_owned_slots_until_a_later_sample_reaps_them(self):
        deploy.reap_worker_custody()
        host = {"pipelineId": "synthetic", "stageId": "build", "attempt": 1}
        adapter = type("Adapter", (), {"plan": {}, "config_file": self.plan})()
        with tempfile.TemporaryDirectory(prefix="checkout-worker-custody-") as directory:
            driver = pathlib.Path(directory) / "worker.py"
            driver.write_text("import json,sys\nkind,inputs,deadline,plan=json.load(sys.stdin)\n"
                              "print(json.dumps(['protected',[inputs[0][0],{'outcome':'completed','attempt':1}]]),flush=True)\n"
                              "print(json.dumps(['worker-done']),flush=True)\n")
            sample = deploy.EvidenceSample([host] * (deploy.PROTECTED_READERS + 1))
            real_waitpid = os.waitpid
            def defer_reap(_pid, _options):
                return 0, 0
            with patch.object(deploy, "__file__", str(driver)), patch.object(deploy.os, "waitpid", side_effect=defer_reap):
                lanes = [("protected", [(index, host)]) for index in range(deploy.PROTECTED_READERS + 1)]
                deploy.run_evidence_workers(adapter, lanes, sample, time.monotonic() + 0.3)
                owned = dict(deploy.WORKER_CUSTODY)
                self.assertEqual(len(owned), deploy.PROTECTED_READERS + 1)
                self.assertTrue(all(custody["startIdentity"] for custody in owned.values()))
                second = deploy.EvidenceSample([host])
                deploy.run_evidence_workers(adapter, [("protected", [(0, host)])], second,
                                            time.monotonic() + 0.1)
                self.assertEqual(set(deploy.WORKER_CUSTODY), set(owned))
                self.assertEqual(second.protected[0]["reason"], "worker-cleanup-pending")
            for pid in owned:
                with contextlib.suppress(ChildProcessError):
                    real_waitpid(pid, 0)
            deploy.reap_worker_custody()
            self.assertFalse(set(owned) & set(deploy.WORKER_CUSTODY))

    def test_production_worker_entry_reads_only_its_assigned_evidence(self):
        host = {"pipelineId": "complete-0", "stageId": "build", "attempt": 1}
        sample = deploy.EvidenceSample([host])
        adapter = deploy.Checkout(self.plan)
        try:
            deploy.run_evidence_workers(adapter, [("protected", [(0, host)])], sample, time.monotonic() + 1.5)
        finally:
            adapter.close()
        self.assertEqual(sample.protected[0]["outcome"], "completed")
        self.assertEqual([tool for tool, _, _ in self.recorded()], ["get_pipeline"])

    def test_plan_replacement_cannot_redirect_a_protected_read(self):
        host = {"pipelineId": "complete-0", "stageId": "build", "attempt": 1}
        sample = deploy.EvidenceSample([host])
        adapter = deploy.Checkout(self.plan)
        try:
            deploy.write_json(self.plan, {**adapter.plan, "target": OLD})
            deploy.run_evidence_workers(adapter, [("protected", [(0, host)])], sample, time.monotonic() + 1.5)
        finally:
            adapter.close()
        self.assertEqual(sample.protected[0]["outcome"], "unknown")
        self.assertEqual(sample.protected[0]["reason"], "worker:RuntimeError")
        self.assertFalse(self.calls.exists())


class TransportContracts(unittest.TestCase):
    def assert_folded_mcp_environment(self, prefixes):
        import shutil
        alias = pathlib.Path(__file__).resolve().parent.parent / "bin/envAlias.mjs"
        bun = shutil.which("bun")
        self.assertIsNotNone(bun)
        with tempfile.TemporaryDirectory(prefix="delegatus-mcp-env-test-") as root:
            checkout = pathlib.Path(root) / "checkout"
            (checkout / "bin").mkdir(parents=True)
            state = pathlib.Path(root) / "planned-state"
            other_state = pathlib.Path(root) / "inherited-state"
            state.mkdir()
            other_state.mkdir()
            (checkout / "bin/mcp-server.mjs").write_text(
                "import " + json.dumps(alias.as_uri()) + ";\n"
                "import { createInterface } from 'node:readline';\n"
                "for await (const line of createInterface({input: process.stdin})) {\n"
                " const r = JSON.parse(line);\n"
                " if (!('id' in r)) continue;\n"
                " const credentials = Object.fromEntries(Object.entries(process.env).filter(\n"
                "  ([name]) => /^(LLV|DELEGATUS)_SPAWN_(CAPABILITY|CONVERSATION_ID|TRANSCRIPT_PATH)$/.test(name)));\n"
                " const result = r.method === 'tools/call' ? {structuredContent: {ok: true,\n"
                "  stateDir: process.env.LLV_STATE_DIR, token: process.env.LLV_TOKEN, credentials}} : {};\n"
                " console.log(JSON.stringify({jsonrpc: '2.0', id: r.id, result}));\n"
                "}\n")
            inherited = {"LLV_STATE_DIR": str(other_state), "DELEGATUS_STATE_DIR": str(state if prefixes else other_state),
                         "LLV_TOKEN": "synthetic-inherited", "DELEGATUS_TOKEN": "synthetic-alias"}
            for prefix in prefixes:
                for suffix in ["CAPABILITY", "CONVERSATION_ID", "TRANSCRIPT_PATH"]:
                    inherited[prefix + "SPAWN_" + suffix] = "synthetic-" + prefix.lower() + suffix.lower()
            with patch.dict(os.environ, inherited):
                probe = deploy.Mcp(checkout, state, "synthetic-planned", bun)
                try:
                    observed = probe.call("agent_activity", {})
                finally:
                    probe.close()
            self.assertEqual(observed["credentials"], {})
            self.assertEqual(observed["stateDir"], str(state))
            self.assertEqual(observed["token"], "synthetic-planned")

    def test_mcp_entry_alias_fold_preserves_the_planned_state_and_token(self):
        self.assert_folded_mcp_environment([])

    def test_mcp_entry_alias_fold_cannot_restore_spawn_credentials(self):
        for prefixes in [["LLV_"], ["DELEGATUS_"], ["LLV_", "DELEGATUS_"]]:
            with self.subTest(prefixes=prefixes):
                self.assert_folded_mcp_environment(prefixes)

    def test_http_uses_only_its_ephemeral_listener_and_refuses_redirects(self):
        import http.server
        import threading
        import urllib.error
        paths = []
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_GET(self):
                paths.append(self.path)
                if self.path == "/redirect":
                    self.send_response(302)
                    self.send_header("Location", "/credential-destination")
                    self.end_headers()
                else:
                    self.send_response(200 if self.headers.get("Authorization") == "Bearer synthetic" else 403)
                    self.end_headers()
                    self.wfile.write(b"healthy")
        with http.server.HTTPServer(("127.0.0.1", 0), Handler) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                port = server.server_address[1]
                self.assertEqual(deploy.http_read(port, "/", "synthetic"), b"healthy")
                with self.assertRaises(urllib.error.HTTPError):
                    deploy.http_read(port, "/redirect", "synthetic")
                self.assertEqual(paths, ["/", "/redirect"])
            finally:
                server.shutdown()
                thread.join(timeout=2)

    def test_mcp_error_reconnects_and_closes_only_the_children_it_started(self):
        import subprocess
        with tempfile.TemporaryDirectory(prefix="delegatus-mcp-test-") as root:
            checkout = pathlib.Path(root)
            (checkout / "bin").mkdir()
            marker = checkout / "failed-once"
            (checkout / "bin/mcp-server.mjs").write_text(
                "import sys,json,pathlib\n"
                "for line in sys.stdin:\n"
                " r=json.loads(line)\n"
                " if 'id' not in r: continue\n"
                " result={}\n"
                " if r['method']=='tools/call':\n"
                "  p=pathlib.Path('failed-once')\n"
                "  if not p.exists(): p.write_text('synthetic'); result={'isError':True}\n"
                "  else: result={'structuredContent':{'ok':True,'conversations':[]}}\n"
                "  if not r['params']['arguments'].get('clientRequestId'): result={'isError':True}\n"
                " print(json.dumps({'jsonrpc':'2.0','id':r['id'],'result':result}),flush=True)\n")
            children = []
            original = subprocess.Popen
            def start(*args, **kwargs):
                child = original(*args, **kwargs)
                children.append(child)
                return child
            import sys
            probe = deploy.Mcp(checkout, checkout, "synthetic", sys.executable)
            with patch.object(deploy.subprocess, "Popen", start):
                try:
                    with self.assertRaises(RuntimeError):
                        probe.call("agent_activity", {})
                    self.assertTrue(marker.exists())
                    self.assertTrue(probe.call("agent_activity", {})["ok"])
                finally:
                    probe.close()
            self.assertEqual(len(children), 2)
            self.assertTrue(all(child.poll() is not None for child in children))

    def test_mcp_health_probe_requires_a_fresh_round_trip_beyond_cached_tools_list(self):
        with tempfile.TemporaryDirectory(prefix="delegatus-mcp-probe-") as root:
            checkout = pathlib.Path(root)
            (checkout / "bin").mkdir()
            trace = checkout / "requests.jsonl"
            (checkout / "bin/mcp-server.mjs").write_text(
                "import json,sys,pathlib\n"
                "for line in sys.stdin:\n"
                " r=json.loads(line)\n"
                " if 'id' not in r: continue\n"
                " with open('requests.jsonl','a') as f: f.write(json.dumps(r['method'])+'\\n')\n"
                " if r['method']=='tools/list': result={'tools':[{'name':'get_pipeline'}]}\n"
                " elif pathlib.Path('offline').exists(): result={'isError':True,'content':[{'type':'text','text':'offline'}]}\n"
                " else: result={'structuredContent':{'ok':True,'pipelines':[]}}\n"
                " print(json.dumps({'jsonrpc':'2.0','id':r['id'],'result':result}),flush=True)\n")
            probe = deploy.Mcp(checkout, checkout, "synthetic", sys.executable)
            try:
                self.assertTrue(probe.probe())
                (checkout / "offline").touch()
                with self.assertRaises(RuntimeError):
                    probe.probe()
                (checkout / "offline").unlink()
                self.assertTrue(probe.probe())
            finally:
                probe.close()
            methods = [json.loads(line) for line in trace.read_text().splitlines()]
            self.assertEqual(methods.count("tools/list"), 3)
            self.assertEqual(methods.count("tools/call"), 3)


if __name__ == "__main__":
    unittest.main()
