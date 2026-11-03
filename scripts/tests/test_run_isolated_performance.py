import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest


SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "run-isolated-performance.py"
REPORT = """
import json, os, pathlib
home = pathlib.Path(os.environ['HOME'])
(home / 'evidence').write_text('fixture')
print(json.dumps({key: os.environ.get(key) for key in
    ['HOME', 'LLV_STATE_DIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
     'BUN_INSTALL_CACHE_DIR', 'PRIVATE_PARENT_VALUE']}))
"""


class IsolatedPerformanceTests(unittest.TestCase):
    def setUp(self):
        parent = "/var/tmp" if pathlib.Path("/var/tmp").is_dir() else None
        self.fixture = tempfile.TemporaryDirectory(prefix="lvtest-", dir=parent)
        self.root = pathlib.Path(self.fixture.name)
        self.env = dict(os.environ)
        for key in ["TMP", "TEMP", "BUN_INSTALL_CACHE_DIR", "LLV_PERFORMANCE_ROOT"]:
            self.env.pop(key, None)
        for key, name in [("TMPDIR", "scratch"), ("HOME", "caller"), ("XDG_CACHE_HOME", "shared")]:
            directory = self.root / name
            directory.mkdir()
            self.env[key] = str(directory)
        self.env["PRIVATE_PARENT_VALUE"] = "must stay outside the child"
        self.marker = self.root / "caller" / "existing"
        self.marker.write_text("preserve")

    def tearDown(self):
        self.fixture.cleanup()

    def run_child(self, code=REPORT, flags=(), env=None, cwd=None):
        return subprocess.run(
            [sys.executable, str(SCRIPT), *flags, sys.executable, "-c", code],
            env=env or self.env, cwd=cwd, capture_output=True, text=True,
        )

    def payload(self, result):
        return json.loads(result.stdout.strip())

    def test_success_removes_only_its_private_root(self):
        result = self.run_child()
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = self.payload(result)
        scratch = pathlib.Path(payload["HOME"]).parent
        self.assertFalse(scratch.exists(), f"completed run retained {scratch}")
        self.assertEqual(self.marker.read_text(), "preserve")
        self.assertIsNone(payload["PRIVATE_PARENT_VALUE"])
        self.assertTrue(all(pathlib.Path(payload[key]).parent == scratch
                            for key in ["LLV_STATE_DIR", "CODEX_HOME", "CLAUDE_CONFIG_DIR"]))

    def test_failure_removes_root_and_preserves_exit_code(self):
        result = self.run_child(REPORT + "\nraise SystemExit(7)\n")
        self.assertEqual(result.returncode, 7, result.stderr)
        self.assertFalse(pathlib.Path(self.payload(result)["HOME"]).parent.exists())

    @unittest.skipUnless(os.name == "posix", "POSIX directory permissions")
    def test_read_only_tree_is_removed_without_changing_link_targets(self):
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "data").write_text("preserve")
        (outside / "data").chmod(0o400)
        outside.chmod(0o500)
        for exit_code in (0, 7):
            with self.subTest(exit_code=exit_code):
                code = REPORT + f"""
locked = home / 'read-only'
locked.mkdir()
(locked / 'data').write_text('fixture')
os.symlink({str(outside)!r}, locked / 'outside')
os.link({str(outside / 'data')!r}, locked / 'hardlink')
locked.chmod(0o500)
raise SystemExit({exit_code})
"""
                result = self.run_child(code)
                self.assertEqual(result.returncode, exit_code, result.stderr)
                self.assertFalse(pathlib.Path(self.payload(result)["HOME"]).parent.exists())
                self.assertEqual(outside.stat().st_mode & 0o777, 0o500)
                self.assertEqual((outside / "data").read_text(), "preserve")
                self.assertEqual((outside / "data").stat().st_mode & 0o777, 0o400)

    @unittest.skipUnless(hasattr(os, "O_PATH"), "Linux path handles")
    def test_unreadable_owned_directories_are_removed(self):
        for mode in (0o000, 0o100, 0o300):
            for exit_code in (0, 7):
                with self.subTest(mode=oct(mode), exit_code=exit_code):
                    result = self.run_child(REPORT + f"""
locked = home / 'locked'
locked.mkdir()
(locked / 'data').write_text('fixture')
locked.chmod({mode})
raise SystemExit({exit_code})
""")
                    self.assertEqual(result.returncode, exit_code, result.stderr)
                    self.assertFalse(pathlib.Path(self.payload(result)["HOME"]).parent.exists())

    def test_closed_stderr_does_not_change_the_command_or_cleanup(self):
        for exit_code in (0, 7):
            with self.subTest(exit_code=exit_code):
                read_fd, write_fd = os.pipe()
                os.close(read_fd)
                try:
                    result = subprocess.run(
                        [sys.executable, str(SCRIPT), sys.executable, "-c",
                         REPORT + f"\nraise SystemExit({exit_code})\n"],
                        env=self.env, stdout=subprocess.PIPE, stderr=write_fd, text=True,
                    )
                finally:
                    os.close(write_fd)
                self.assertEqual(result.returncode, exit_code)
                self.assertFalse(pathlib.Path(self.payload(result)["HOME"]).parent.exists())

    @unittest.skipUnless(os.name == "posix", "deleted working directory")
    def test_deleted_cwd_does_not_skip_the_command_or_cleanup(self):
        for exit_code in (0, 7):
            with self.subTest(exit_code=exit_code):
                cwd = self.root / f"deleted-cwd-{exit_code}"
                cwd.mkdir()
                launcher = """
import os, subprocess, sys
os.chdir(sys.argv[1])
os.rmdir(sys.argv[1])
result = subprocess.run([sys.executable, sys.argv[2], "/bin/sh", "-c",
                         "printf child-ran; exit " + sys.argv[3]])
raise SystemExit(result.returncode)
"""
                result = subprocess.run(
                    [sys.executable, "-c", launcher, str(cwd), str(SCRIPT), str(exit_code)],
                    env=self.env, capture_output=True, text=True,
                )
                self.assertEqual(result.returncode, exit_code, result.stderr)
                self.assertEqual(result.stdout, "child-ran")
                self.assertEqual(list((self.root / "scratch").iterdir()), [])

    def test_keep_is_explicit_and_preserves_the_owned_run(self):
        for code in (0, 7):
            with self.subTest(code=code):
                result = self.run_child(REPORT + f"\nraise SystemExit({code})\n", flags=["--keep"])
                self.assertEqual(result.returncode, code, result.stderr)
                scratch = pathlib.Path(self.payload(result)["HOME"]).parent
                self.assertTrue((scratch / "h" / "evidence").exists())
                self.assertIn(str(scratch), result.stderr)

    @unittest.skipUnless(os.name == "posix", "POSIX directory permissions")
    def test_keep_read_only_root_preserves_exit_status(self):
        for exit_code in (0, 7):
            with self.subTest(exit_code=exit_code):
                result = self.run_child(
                    REPORT + f"\nhome.parent.chmod(0o500)\nraise SystemExit({exit_code})\n",
                    flags=["--keep"],
                )
                scratch = pathlib.Path(self.payload(result)["HOME"]).parent
                try:
                    self.assertEqual(result.returncode, exit_code, result.stderr)
                    self.assertTrue((scratch / "h" / "evidence").exists())
                    self.assertIn("retained", result.stderr)
                finally:
                    scratch.chmod(0o700)

    def test_root_option_overrides_the_callers_temp_directory(self):
        selected = self.root / "selected"
        selected.mkdir()
        result = self.run_child(flags=["--root", str(selected)])
        self.assertEqual(result.returncode, 0, result.stderr)
        scratch = pathlib.Path(self.payload(result)["HOME"]).parent
        self.assertEqual(scratch.parent, selected)
        self.assertFalse(scratch.exists())

    def test_relative_root_still_gives_absolute_private_homes(self):
        (self.root / "selected").mkdir()
        result = self.run_child(flags=["--root", "selected"], cwd=self.root)
        self.assertEqual(result.returncode, 0, result.stderr)
        scratch = pathlib.Path(self.payload(result)["HOME"]).parent
        self.assertTrue(scratch.is_absolute())
        self.assertEqual(scratch.parent, self.root / "selected")

    def test_package_cache_is_shared_while_homes_are_private(self):
        code = REPORT.replace("print(json.dumps", "pathlib.Path(os.environ['BUN_INSTALL_CACHE_DIR']).joinpath('cached-package').write_text('cached')\nprint(json.dumps")
        first = self.run_child(code)
        self.assertEqual(first.returncode, 0, first.stderr)
        second = self.run_child()
        self.assertEqual(second.returncode, 0, second.stderr)
        a, b = self.payload(first), self.payload(second)
        self.assertNotEqual(a["HOME"], b["HOME"])
        self.assertEqual(a["BUN_INSTALL_CACHE_DIR"], b["BUN_INSTALL_CACHE_DIR"])
        cache = pathlib.Path(a["BUN_INSTALL_CACHE_DIR"])
        self.assertEqual((cache / "cached-package").read_text(), "cached")
        self.assertNotIn(pathlib.Path(a["HOME"]).parent, cache.parents)

    @unittest.skipUnless(os.name == "posix", "persistent Unix scratch root")
    def test_default_uses_var_tmp(self):
        env = dict(self.env)
        env.pop("TMPDIR", None)
        result = self.run_child(env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        scratch = pathlib.Path(self.payload(result)["HOME"]).parent
        self.assertEqual(scratch.parent, pathlib.Path("/var/tmp"))
        self.assertFalse(scratch.exists())

    @unittest.skipUnless(os.name == "posix", "symlink fixture")
    def test_cleanup_does_not_follow_a_link_outside_the_run(self):
        code = REPORT + f"\nos.symlink({str(self.marker)!r}, home / 'outside-link')\n"
        result = self.run_child(code)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(pathlib.Path(self.payload(result)["HOME"]).parent.exists())
        self.assertEqual(self.marker.read_text(), "preserve")

    @unittest.skipUnless(os.name == "posix", "descriptor-relative cleanup")
    def test_root_replaced_at_first_scan_is_preserved(self):
        launcher = """
import pathlib, runpy, sys
root = None
swapped = False
def observe(event, args):
    global root, swapped
    if event == 'tempfile.mkdtemp':
        root = pathlib.Path(args[0])
    elif event == 'os.scandir' and root is not None and not swapped:
        swapped = True
        root.rename(str(root) + '.moved')
        root.mkdir()
        (root / 'replacement').write_text('preserve replacement')
sys.addaudithook(observe)
sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0], run_name='__main__')
"""
        result = subprocess.run(
            [sys.executable, "-c", launcher, str(SCRIPT), sys.executable, "-c", REPORT],
            env=self.env, capture_output=True, text=True,
        )
        self.assertNotEqual(result.returncode, 0)
        scratch = pathlib.Path(self.payload(result)["HOME"]).parent
        self.assertEqual((scratch / "replacement").read_text(), "preserve replacement")

    def test_replaced_root_is_preserved_and_reported(self):
        code = REPORT + """
root = home.parent
root.rename(str(root) + '.moved')
root.mkdir()
(root / 'replacement').write_text('preserve replacement')
"""
        result = self.run_child(code)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("scratch identity changed", result.stderr)
        scratch = pathlib.Path(self.payload(result)["HOME"]).parent
        self.assertEqual((scratch / "replacement").read_text(), "preserve replacement")
        self.assertTrue(pathlib.Path(str(scratch) + ".moved", "h", "evidence").exists())


if __name__ == "__main__":
    unittest.main()
