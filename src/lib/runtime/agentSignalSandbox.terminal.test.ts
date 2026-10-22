import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { terminalSignalSandboxCommand } from "./agentSignalSandbox";
import { captureProcessIdentity, processIdentityStatus } from "@/lib/processIdentity";

const binary = process.env.LLV_TMUX_TEST_BINARY;
test.skipIf(!binary)("a private tmux pane retains raw input, controlling tty, resize, Ctrl-C and native exit status", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "signal-tty-"));
  const socket = path.join(root, "tmux.sock");
  const marker = path.join(root, "tty.json"), done = path.join(root, "exit");
  const script = path.join(root, "terminal.py");
  fs.writeFileSync(script, String.raw`
import fcntl,json,os,signal,struct,sys,termios,tty
fd=os.open('/dev/tty',os.O_RDWR)
initial=termios.tcgetattr(fd)
state={'tty':True,'raw':True,'interrupt':False}
def report(*_):
    state['raw']=(termios.tcgetattr(fd)[3] & (termios.ICANON|termios.ISIG))==0
    state['size']=list(struct.unpack('HHHH',fcntl.ioctl(fd,termios.TIOCGWINSZ,b'\0'*8)))[:2]
    open(sys.argv[1],'w').write(json.dumps(state))
signal.signal(signal.SIGWINCH,report)
tty.setraw(fd)
report()
try:
    while True:
        value=os.read(fd,1)
        if value==b'\x03': state['interrupt']=True;report()
        if value==b'q': break
finally: termios.tcsetattr(fd,termios.TCSANOW,initial)
sys.exit(7)
`);
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const run = (...args: string[]) => {
    const result = spawnSync(binary!, ["-S", socket, ...args], { encoding: "utf8", timeout: 5_000,
      env: { ...process.env, HOME: root, XDG_CONFIG_HOME: path.join(root, "config"), LLV_STATE_DIR: path.join(root, "state"), LLV_GATE_SLOT_LEASE: "" } });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  let server: ReturnType<typeof captureProcessIdentity> | undefined;
  try {
    run("-f", "/dev/null", "new-session", "-d", "-s", "fixture", "-x", "80", "-y", "24", "/bin/bash", "--noprofile", "--norc");
    server = captureProcessIdentity(Number(run("display-message", "-p", "#{pid}")));
    const command = terminalSignalSandboxCommand(["python3", script, marker].map(quote).join(" "));
    run("send-keys", "-t", "fixture:0.0", "-l", `${command}; printf '%s' "$?" > ${quote(done)}`);
    run("send-keys", "-t", "fixture:0.0", "Enter");
    const wait = async (check: () => boolean) => {
      const deadline = Date.now() + 10_000;
      while (!check() && Date.now() < deadline) await Bun.sleep(25);
      expect(check(), run("capture-pane", "-p", "-t", "fixture:0.0")).toBeTrue();
    };
    const state = () => { try { return JSON.parse(fs.readFileSync(marker, "utf8")); } catch { return {}; } };
    await wait(() => state().tty === true);
    expect(state().raw).toBeTrue();
    run("resize-window", "-t", "fixture:0", "-x", "91", "-y", "33");
    const height = Number(run("display-message", "-p", "-t", "fixture:0.0", "#{pane_height}"));
    await wait(() => state().size?.[0] === height && state().size?.[1] === 91);
    run("send-keys", "-t", "fixture:0.0", "C-c");
    await wait(() => state().interrupt === true);
    run("send-keys", "-t", "fixture:0.0", "-l", "q");
    await wait(() => fs.existsSync(done));
    expect(fs.readFileSync(done, "utf8")).toBe("7");
  } finally {
    if (server && processIdentityStatus(server) === "alive") process.kill(server.pid, "SIGTERM");
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 45_000);
