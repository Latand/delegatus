"""Run a check with private homes, provider roots, state and short temporary paths.
The directories are retained for inspection; no operator state is read or cleaned.
Usage: python3 scripts/run-isolated-performance.py bun test <specific-test-file>
"""
import os, pathlib, subprocess, sys, tempfile
root=pathlib.Path(tempfile.mkdtemp(prefix="lvpf-"))
env={k:v for k,v in os.environ.items() if k in ["PATH","LANG","TZ"]}
for key,sub in {"HOME":"h", "XDG_CONFIG_HOME":"c", "XDG_CACHE_HOME":"cache", "XDG_RUNTIME_DIR":"r", "TMPDIR":"t", "TMP":"t", "TEMP":"t", "LLV_STATE_DIR":"s", "LLV_CLAUDE_HOME":"claude", "CLAUDE_CONFIG_DIR":"claude", "LLV_CODEX_HOME":"codex", "CODEX_HOME":"codex"}.items():
 d=root/sub; d.mkdir(exist_ok=True); env[key]=str(d)
env.update(NEXT_TELEMETRY_DISABLED="1",LLV_ACCOUNT_CONTROLLER_DISABLED="1",LLV_REAPER_ENABLED="0",LLV_RUNTIME_EVENTS="0")
result=subprocess.run(sys.argv[1:],env=env)
sys.exit(result.returncode)
