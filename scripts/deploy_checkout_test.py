"""Synthetic switch regressions; no installation, service or live state is used."""
import importlib.util
import contextlib
import pathlib
import json
import shutil
import os
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("deploy_checkout", pathlib.Path(__file__).with_name("deploy-checkout.py"))
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)

TARGET = "a" * 40
OLD = "b" * 40
# Survivors of a stop are re-parented to the user manager, which stays readable.
USER_MANAGER = 7000


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
    def __init__(self):
        self.clock = FakeClock()
        self.published = False
        self.samples = []
        self.events = []
        self.old = [{"pid": 101, "startIdentity": "old"}]
        self.hosts = [{"pid": 102, "startIdentity": "stage", "stageId": "build", "attempt": 1}]
        self.restart_error = None
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

    def process(self, entry):
        if self.process_error:
            raise self.process_error
        return None

    def serving(self):
        self.samples.append(self.clock.now())
        return {role: {"sha": TARGET, "since": "2026-01-01T00:00:00Z", "healthy": True}
                for role in ["launcher", "viewer", "runtimeHost"]}

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
    def test_exited_old_process_after_pointer_publication_still_samples_and_passes(self):
        switch = Switch()
        switch.process_error = FileNotFoundError("old process exited during restart")
        result = deploy.run_switch(switch, TARGET, samples=3, interval=2, timeout=5)
        self.assertEqual(result["verdict"], "pass")
        self.assertEqual(len(switch.samples), 3)
        self.assertEqual(result["serving"]["viewer"]["sha"], TARGET)

    def test_vanished_protected_host_and_mcp_restart_error_are_reconciled(self):
        switch = Switch()
        switch.mcp_errors = 1
        result = deploy.run_switch(switch, TARGET, samples=3, interval=2, timeout=5)
        self.assertEqual(result["verdict"], "pass")
        self.assertEqual(len(switch.samples), 3)
        self.assertEqual(result["protected"][0]["outcome"], "recovered")
        self.assertGreaterEqual(switch.clock.now(), 1)

    def test_restart_submission_error_after_publish_still_runs_every_sample(self):
        switch = Switch()
        switch.restart_error = TimeoutError("submission timed out while restart continued")
        result = deploy.run_switch(switch, TARGET, samples=3, interval=2, timeout=5)
        self.assertEqual(result["verdict"], "pass")
        self.assertEqual(len(switch.samples), 3)
        self.assertEqual(result["serving"]["launcher"]["since"], "2026-01-01T00:00:00Z")

    def test_only_lost_work_fails_a_healthy_switch(self):
        for outcome, expected in [("fresh attempt started", "pass"), ("completed", "pass"), ("lost", "fail"), ("unknown", "needs_decision")]:
            with self.subTest(outcome=outcome):
                switch = Switch()
                switch.outcome = outcome
                result = deploy.run_switch(switch, TARGET, samples=3, interval=2, timeout=5)
                self.assertEqual(result["verdict"], expected)
                self.assertEqual(len(switch.samples), 3)

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
        self.assertEqual(len(switch.samples), 3)
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
        self.assertEqual(len(switch.samples), 3)


class AdapterContracts(unittest.TestCase):
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
        self.checkout = self.root / "checkout"
        self.checkout.mkdir()
        self.releases = self.root / "releases"
        self.target = self.releases / TARGET[:12]
        (self.target / ".next").mkdir(parents=True)
        (self.target / ".next/BUILD_ID").write_text("synthetic")
        self.token = self.root / "service.env"
        self.token.write_text("LLV_TOKEN=synthetic-secret\n")
        self.evidence = self.root / "verified.json"
        deploy.write_json(self.evidence, {"sha": TARGET, "viewer": "pass", "runtimeHost": "pass"})
        self.pointer = self.state / "self-update" / ("release-" + "c" * 16 + ".json")
        self.record_file = self.pointer.with_name("launcher-" + "c" * 16 + ".json")
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
        # The service's kernel cgroup, under the slice its unit configures.
        self.cgroup = self.root / "cgroup"
        self.slice_group = "/user.slice/synthetic.slice"
        self.service_group = self.slice_group + "/synthetic-viewer.service"
        self.parents = {}
        self.pgroups = {}
        self.cmdlines = {}
        self.groups = {}
        self.moving = set()
        self.stat_reads = 0
        self.main_pid = 101
        self.members = [101, 102, 103]
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
        self.weight = None
        self.weight_effective = True
        self.signals = []
        fixture = self
        class Transport:
            def __init__(self, *args):
                pass
            def close(self):
                pass
            def call(self, tool, args):
                if fixture.mcp_failures:
                    fixture.mcp_failures -= 1
                    raise RuntimeError("MCP tool returned error")
                if tool == "get_pipeline":
                    return {"ok": True, "pipeline": {"stages": [{"id": "build"}], "runs": [
                        {"stageId": "other", "attempts": [{"n": 99, "state": "passed"}]},
                        {"stageId": "build", "attempts": fixture.attempts if fixture.old_gone else [
                            {"n": 1, "state": "running", "conversationId": "synthetic-stage"}]}]}}
                current = fixture.attempts[-1] if fixture.old_gone else {"n": 1, "conversationId": "synthetic-stage"}
                row = {"conversationId": "synthetic-stage", "turnState": "busy", "lifecycle": "running",
                       "evidenceSource": "transcript",
                       "host": {"state": "alive", "pid": 204 if fixture.old_gone else 104},
                       "pipeline": {"pipelineId": "synthetic-lane", "stageId": "build", "attempt": current["n"]}}
                row["conversationId"] = current.get("conversationId", "synthetic-stage")
                answer = {"ok": True, "conversations": [row], "unselectedCount": 0,
                          "selection": {"matched": 1, "selected": 1, "recoveryPending": 0,
                                        "recoveryTruncated": False, "cacheStatus": "fresh", "projected": 0, "unreadable": 0}}
                if args.get("limit") == 200:
                    fixture.inventory_reads += 1
                    overrides = fixture.inventory_overrides
                    if callable(overrides):
                        overrides = overrides(fixture.inventory_reads)
                    answer.update(overrides)
                elif args.get("conversationId"):
                    answer.update(fixture.recovery_overrides)
                return answer
        env = patch.dict(os.environ, {"LLV_STATE_DIR": str(self.state)})
        env.start()
        self.addCleanup(env.stop)
        self.adapter = deploy.Checkout(self.plan, clock=FakeClock(), process_read=self.process,
                                       http=self.http, runtime=lambda record: {"ready": True},
                                       execute=self.execute, mcp_factory=Transport, cgroup_root=self.cgroup,
                                       signal_process=self.signal)
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

    def set_record(self, sha):
        offset = 0 if sha == OLD else 100
        def entry(pid):
            return {"pid": pid + offset, "startIdentity": str(pid + offset), "state": "healthy",
                    "revision": sha[:7], "startedAt": "2026-01-01T00:00:00Z"}
        deploy.write_json(self.record_file, {"checkout": str(self.checkout), "releasePointer": str(self.pointer),
                                            "releasesDir": str(self.releases), "port": 0, "socket": str(self.root / "fake.sock"),
                                            "launcher": {**entry(101), "revision": sha}, "web": entry(102), "runtimeHost": entry(103)})

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
        return {"stat": str(pid) + " (synthetic process) " + " ".join(["S", str(self.parents.get(pid, 1)), str(self.pgroups.get(pid, pid))] + ["0"] * 9 + [str(self.reads)] + ["0"] * 6 + [identity]),
                "cmdline": self.cmdlines.get(pid, "bun\0" + str(root / "bin/cli.mjs") + "\0").encode(), "cwd": str(root),
                "cgroup": "0::" + self.groups.get(pid, self.service_group) + "\n"}[field]

    def execute(self, args, cwd=None):
        self.commands.append(args)
        if args[:3] == ["git", "rev-parse", "HEAD"]:
            if cwd == self.checkout:
                return OLD
            return TARGET if pathlib.Path(cwd) == self.target else OLD
        if args[:2] == ["git", "status"] or "list-jobs" in args:
            return ""
        state = "ActiveState=" + ("active" if self.active else "inactive")
        if "show" in args:
            if "MainPID" in args:
                return "MainPID=" + str(self.main_pid) + "\nControlGroup=" + self.service_group
            if "ControlGroup" in args:
                if args[3].endswith(".slice"):
                    return "ControlGroup=" + self.slice_group
                held = self.active or self.surviving or self.never_released
                weight = "\nCPUWeight=" + (self.weight or "[not set]")
                return "Slice=synthetic.slice\nControlGroup=" + (self.service_group if held else "") + weight
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
        if route == "/api/self-update":
            return json.dumps({"auto": {"enabled": False}, "serving": {r: {"sha": self.current} for r in ["web", "runtimeHost"]},
                               "processes": {r: {"state": "healthy"} for r in ["web", "runtimeHost"]}}).encode()
        raise AssertionError("unplanned HTTP read")

    def test_real_adapter_replays_both_restart_failures_with_private_registry(self):
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

    def test_an_incomplete_interruption_record_keeps_a_healthy_switch_from_passing(self):
        directory = self.state / "interruption-obligations"
        directory.mkdir()
        deploy.write_json(directory / "interruption-continuation-broken.json",
                          {"id": "interruption-continuation-broken", "recordedAt": "2999-01-01T00:00:00Z"})
        result = deploy.run_switch(self.adapter, TARGET, samples=3, interval=2, timeout=5)
        self.assertEqual(result["verdict"], "needs_decision")
        self.assertEqual(result["interrupted"], [])
        self.assertEqual(result["interruptedUnreadable"], ["interruption-continuation-broken:version"])

    def assert_stage_verdict(self, attempts, verdict, outcome, attempt):
        self.attempts = attempts
        self.adapter.run_dir = self.state / "deploy-verdicts/synthetic-stage-run"
        self.adapter.run_dir.mkdir(parents=True, mode=0o700)
        result = deploy.run_switch(self.adapter, TARGET, samples=3, interval=2, timeout=5)
        self.assertEqual(result["verdict"], verdict)
        self.assertEqual(result["protected"], [{"pipelineId": "synthetic-lane", "stageId": "build",
                                              "attempt": attempt, "outcome": outcome}])
        events = [json.loads(line) for line in (self.adapter.run_dir / "switch.log").read_text().splitlines()
                  if line.startswith("{")]
        samples = [event for event in events if "sample" in event]
        self.assertEqual([event["sample"] for event in samples], [1, 2, 3])
        self.assertTrue(all(event["protected"] == result["protected"] for event in samples))
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
        self.members = [101, 102, 103, 160, 161]
        self.parents.update({160: 102, 161: 170, 170: 104})
        self.adapter.preflight()
        result = deploy.run_switch(self.adapter, TARGET, samples=3, interval=2, timeout=5)
        self.assertEqual(result["verdict"], "pass")

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
        result = deploy.run_switch(self.adapter, TARGET, samples=3, interval=2, timeout=5)
        self.assertEqual(result["verdict"], "pass")
        self.assertEqual(self.service_commands(), ["stop", "start"])

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
        self.assertEqual(result["serving"]["placement"]["expected"], "/user.slice/synthetic.slice/synthetic-viewer.service")
        self.assertEqual(result["serving"]["placement"]["actual"], "/user.slice/app.slice/synthetic-viewer.service")

    def test_a_serving_process_outside_the_service_cgroup_fails_placement(self):
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

    def test_a_start_that_keeps_failing_retries_during_health_and_on_exit(self):
        self.relocating()
        self.start_refusals = 1000
        result = deploy.run_switch(self.adapter, TARGET, samples=3, interval=2, timeout=5)
        self.assertGreater(result["relocation"]["startAttempts"], deploy.START_ATTEMPTS * 2)
        relocation = result["relocation"]
        self.assertEqual((relocation["started"], relocation["outcome"]), (False, "start-failed"))
        self.assertIn("RuntimeError", result["diagnostics"])
        self.assertEqual(result["verdict"], "fail")
        self.assertFalse(result["serving"]["checks"]["service"])

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
        interrupted = self.adapter.interrupted
        def failed(since, hosts):
            answer = interrupted(since, hosts)
            self.active = False
            self.start_refusals = 1000
            return answer
        self.adapter.interrupted = failed
        result = deploy.run_switch(self.adapter, TARGET, samples=1, interval=2, timeout=5)
        self.assertTrue(result["serving"]["checks"]["service"])
        self.assertFalse(result["relocation"]["started"])
        self.assertEqual(result["relocation"]["outcome"], "start-failed")
        self.assertEqual(result["verdict"], "fail")
        self.assertIn("exit-recovery:health-unverified", result["diagnostics"])

    def test_an_exception_during_observation_still_retries_start_on_exit(self):
        self.relocating()
        self.start_refusals = deploy.START_ATTEMPTS
        # Even an abrupt observation failure retains the recovery obligation.
        original_process = self.adapter.process
        def process(entry):
            if self.old_gone and not self.active and self.start_refusals == 0:
                raise KeyboardInterrupt()
            return original_process(entry)
        self.adapter.process = process
        with self.assertRaises(KeyboardInterrupt):
            deploy.run_switch(self.adapter, TARGET, samples=3, interval=2, timeout=5)
        self.assertTrue(self.active)
        self.assertEqual(self.service_commands()[-1], "start")

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
                            self.inventory_overrides = {"conversations": [{"host": {"state": "alive", "pid": 160}}]}
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
        read = self.adapter.mcp.call
        def activity(tool, args):
            answer = read(tool, args)
            if tool == "agent_activity" and args.get("limit") == 200 and self.inventory_reads == 2:
                self.parents.update({160: 103, 161: 160})
                self.pgroups.update({160: 160, 161: 160})
                self.members = self.members + [160, 161]
                self.surviving = {160, 161}
            return answer
        self.adapter.mcp.call = activity
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

    def test_correct_placement_passes(self):
        result = deploy.run_switch(self.adapter, TARGET, samples=3, interval=2, timeout=5)
        self.assertEqual(result["verdict"], "pass")
        self.assertTrue(result["serving"]["checks"]["placement"])
        self.assertEqual(result["serving"]["placement"]["actual"], result["serving"]["placement"]["expected"])

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
        self.inventory_overrides = lambda n: {"selection": {
            "matched": 1, "selected": 1, "recoveryPending": 1, "recoveryTruncated": True}} if n < 3 else {}
        result = deploy.run_switch(self.adapter, TARGET, samples=3, interval=2, timeout=5)
        self.assertEqual(result["verdict"], "pass")
        self.assertEqual(result["protected"][0]["outcome"], "recovered")
        self.assertEqual(self.inventory_reads, 4)  # Three preflight reads, then retirement refresh.
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
        with self.assertRaises(RuntimeError):
            self.adapter.stage({"pipelineId": "synthetic-lane", "stageId": "build", "attempt": 1})
        self.adapter.process = original


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


if __name__ == "__main__":
    unittest.main()
