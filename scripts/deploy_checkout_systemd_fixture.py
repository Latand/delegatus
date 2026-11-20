"""Drive the real checkout CLI against one owned systemd rehearsal."""
import importlib.util
import json
import os
import pathlib
import re
import sys


def main():
    source, *args = sys.argv[1:]
    state = pathlib.Path(os.environ["LLV_STATE_DIR"])
    fixture = json.loads((state / "fixture-plan.json").read_text())
    unit = fixture["unit"]
    if not re.fullmatch(r"llvswitchtest[0-9a-f]+\.service", unit):
        raise RuntimeError("private rehearsal unit required")
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location("tested_checkout", source)
    deploy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(deploy)
    production_command = deploy.command
    production_detach = deploy.detached_command
    production_switch = deploy.run_switch
    deploy.CPU_SLICE = unit.replace(".service", ".slice")
    sys.argv = [source, *args]

    def command(command_args, cwd=None):
        if command_args[0] in {"systemctl", "systemd-run"}:
            # Audit every manager command, including failed submissions.
            with (state / "fixture-systemctl.jsonl").open("a") as stream:
                stream.write(json.dumps(command_args) + "\n")
        return production_command(command_args, cwd)

    def detach(script, config, state_dir, run_id):
        cli = production_detach(script, config, state_dir, run_id)
        child = cli.index(sys.executable)
        isolated = ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "TMPDIR", "PATH",
                    "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR"]
        env = ["--setenv=" + key + "=" + os.environ[key] for key in isolated if key in os.environ]
        return [*cli[:child], *env, cli[child], __file__, *cli[child + 1:]]

    class Mcp:
        def __init__(self, *_):
            pass

        def close(self):
            pass

        def call(self, tool, _):
            if tool == "get_pipeline":
                return {"pipeline": {"runs": [{"stageId": stage, "attempts": [
                    {"n": 1, "state": "passed", "conversationId": "fixture-" + stage}
                ]} for stage in ["socket", "stdio"]]}}
            return {"ok": True}

    def census(*_):
        rows = []
        for row in json.loads((state / "fixture-hosts.json").read_text()):
            host = row["host"]
            process = host["process"]
            try:
                stat = deploy.proc_field(process["pid"], "stat")
                if process["startIdentity"] != str(process["pid"]) + ":" + deploy.start_identity(stat):
                    host["state"] = "gone"
            except FileNotFoundError:
                host["state"] = "gone"
            rows.append(row)
        return {"conversations": rows, "unselectedCount": 0,
                "selection": {"matched": len(rows), "selected": len(rows), "recoveryPending": 0,
                              "recoveryTruncated": False, "cacheStatus": "hit", "projected": 0, "unreadable": 0}}

    # The stub Viewer serves real HTTP for the launcher. Board status and the
    # runtime health envelope are supplied by the rehearsal's stub processes.
    def http(port, route, token):
        if route.startswith("/api/tasks"):
            return b'{"tasks":[]}'
        if route.startswith("/api/self-update"):
            install = fixture["installId"]
            record = json.loads((state / "self-update" / ("launcher-" + install + ".json")).read_text())
            def head(role):
                return production_command(["git", "rev-parse", "HEAD"], cwd=deploy.proc_field(record[role]["pid"], "cwd"))
            return json.dumps({"auto": {"enabled": False}, "processes": record,
                               "serving": {role: {"sha": head(role)} for role in ["web", "runtimeHost"]}}).encode()
        body = deploy.http_read(port, "/" if route == "/_next/static/fixture.js" else route, token)
        return body + b'<script src="/_next/static/fixture.js"></script>'

    def runtime_health(record):
        # The launcher fixture's runtime host exercises the real socket, and
        # implements only the launch probe's health envelope.
        import socket
        with socket.socket(socket.AF_UNIX) as sock:
            sock.settimeout(2)
            sock.connect(record["socket"])
            sock.sendall(b'{"id":"fixture"}\n')
            health = json.loads(sock.makefile("rb").readline())
        if health["id"] != "fixture" or health["result"]["pid"] != record["runtimeHost"]["pid"]:
            raise RuntimeError("runtime socket identity mismatch")

    class Checkout(deploy.Checkout):
        def __init__(self, *args):
            super().__init__(*args, execute=command, census=census, http=http,
                             runtime=runtime_health, mcp_factory=Mcp)

    deploy.Checkout = Checkout
    deploy.detached_command = detach
    deploy.command = command
    # Exercise every phase with shorter observations and the real wall clock.
    deploy.run_switch = lambda adapter, target: production_switch(adapter, target, samples=3, interval=1, timeout=3)
    if hasattr(deploy, "REQUEST_WAIT"):
        deploy.REQUEST_WAIT = 6
    return deploy.main()


if __name__ == "__main__":
    sys.exit(main())
