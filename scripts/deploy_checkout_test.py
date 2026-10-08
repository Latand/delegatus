"""Synthetic switch regressions; no installation, service or live state is used."""
import importlib.util
import pathlib
import json
import os
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("deploy_checkout", pathlib.Path(__file__).with_name("deploy-checkout.py"))
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)

TARGET = "a" * 40
OLD = "b" * 40


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

    def test_import_and_cli_help_require_no_state_or_service(self):
        import subprocess
        result = subprocess.run(["python3", str(pathlib.Path(__file__).with_name("deploy-checkout.py")), "--help"],
                                capture_output=True, timeout=5, env={**os.environ, "LLV_STATE_DIR": ""})
        self.assertEqual(result.returncode, 0)
        self.assertIn(b"--preflight", result.stdout)


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
        self.set_record(OLD)
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
                                       execute=self.execute, mcp_factory=Transport)
        self.addCleanup(self.adapter.close)

    def set_record(self, sha):
        offset = 0 if sha == OLD else 100
        def entry(pid):
            return {"pid": pid + offset, "startIdentity": str(pid + offset), "state": "healthy",
                    "revision": sha[:7], "startedAt": "2026-01-01T00:00:00Z"}
        deploy.write_json(self.record_file, {"checkout": str(self.checkout), "releasePointer": str(self.pointer),
                                            "releasesDir": str(self.releases), "port": 0, "socket": str(self.root / "fake.sock"),
                                            "launcher": {**entry(101), "revision": sha}, "web": entry(102), "runtimeHost": entry(103)})

    def process(self, pid, field):
        if self.old_gone and pid < 200:
            raise FileNotFoundError("old release and old stage exited")
        root = self.releases / self.current[:12]
        return {"stat": str(pid) + " (synthetic process) " + " ".join(["S"] + ["0"] * 18 + [str(pid)]),
                "cmdline": ("bun\0" + str(root / "bin/cli.mjs") + "\0").encode(), "cwd": str(root)}[field]

    def execute(self, args, cwd=None):
        self.commands.append(args)
        if args[:3] == ["git", "rev-parse", "HEAD"]:
            if cwd == self.checkout:
                return OLD
            return TARGET if pathlib.Path(cwd) == self.target else OLD
        if args[:2] == ["git", "status"] or "list-jobs" in args:
            return ""
        if "show" in args:
            return "KillMode=process\nActiveState=active" if "KillMode" in args else "ActiveState=active"
        if "restart" in args:
            self.current = TARGET
            self.set_record(TARGET)
            self.old_gone = True
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
        if route == "/api/tasks":
            return b'{"tasks":[]}'
        if route == "/api/self-update":
            return json.dumps({"auto": {"enabled": False}, "serving": {r: {"sha": self.current} for r in ["web", "runtimeHost"]},
                               "processes": {r: {"state": "healthy"} for r in ["web", "runtimeHost"]}}).encode()
        raise AssertionError("unplanned HTTP read")

    def test_real_adapter_replays_both_restart_failures_with_private_registry(self):
        result = deploy.run_switch(self.adapter, TARGET, samples=3, interval=2, timeout=5)
        self.assertEqual(result["verdict"], "pass")
        self.assertEqual(result["protected"][0]["outcome"], "recovered")
        self.assertEqual(json.loads(self.pointer.read_text())["sha"], TARGET)
        self.assertTrue(all(result["serving"][r]["sha"] == TARGET for r in ["launcher", "viewer", "runtimeHost"]))
        self.assertTrue(all(result["serving"][r]["since"] for r in ["launcher", "viewer", "runtimeHost"]))
        self.assertEqual(sum("restart" in c for c in self.commands), 1)
        self.assertTrue(all("stop" not in c and "kill" not in c for c in self.commands))

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
        self.assertFalse(any("restart" in c for c in self.commands))

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
        self.assertEqual(self.inventory_reads, 3)
        self.assertEqual(sum("restart" in c for c in self.commands), 1)

    def test_preflight_failure_never_publishes_or_restarts(self):
        deploy.write_json(self.evidence, {"sha": TARGET, "viewer": "pass", "runtimeHost": "fail"})
        with self.assertRaises(RuntimeError):
            deploy.run_switch(self.adapter, TARGET, samples=3, interval=2, timeout=5)
        self.assertEqual(json.loads(self.pointer.read_text()), self.baseline)
        self.assertFalse(any("restart" in c for c in self.commands))

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
