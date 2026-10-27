#!/usr/bin/env python3
"""Manual isolated observation of the Codex skills catalogue override.

Run with TMPDIR set to an owned scratch directory. The installed skill roots
are copied; config, sessions and provider traffic stay in that scratch
root. Only byte counts leave the probe. No credentials or live hosts are used.
"""
import os, pathlib, json, subprocess, selectors, time, threading, http.server
import argparse, shutil, tempfile
parser = argparse.ArgumentParser(description='Measure the first rollout developer message using a local response stub; no model service is contacted.')
parser.add_argument('--output', type=pathlib.Path, required=True)
args = parser.parse_args()
binary = shutil.which('codex')
version = subprocess.check_output([binary, '--version'], text=True, timeout=30).strip()
if version != 'codex-cli 0.162.1':
    raise RuntimeError('This observation requires codex-cli 0.162.1')
source_home = pathlib.Path.home()
root = pathlib.Path(tempfile.mkdtemp(prefix='codex-skills-observation-', dir=os.environ['TMPDIR']))
home = root / 'home'
ch = home / '.codex'
cwd = root / 'work'
ch.mkdir(parents=True)
cwd.mkdir()
(home / '.agents').mkdir()
for source, target in [(source_home / '.codex/skills', ch / 'skills'), (source_home / '.agents/skills', home / '.agents/skills')]:
    if source.exists():
        shutil.copytree(source, target, symlinks=False)
captures = []

class Handler(http.server.BaseHTTPRequestHandler):

    def do_POST(self):
        captures.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        self.wfile.write(b'event: response.completed\ndata: {"type":"response.completed","response":{"id":"observation","status":"completed","output":[],"usage":{"input_tokens":0,"output_tokens":0,"total_tokens":0}}}\n\n')

    def log_message(self, *a):
        pass
server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
(ch / 'config.toml').write_text(f'model_provider = "observation"\n[model_providers.observation]\nname = "Local observation"\nbase_url = "http://127.0.0.1:{server.server_port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n')
env = {**os.environ, 'HOME': str(home), 'CODEX_HOME': str(ch), 'TMPDIR': str(root), 'XDG_CONFIG_HOME': str(root / 'config'), 'LLV_STATE_DIR': str(root / 'state'), 'LLV_VIEWER_CONTROL_URL': 'http://127.0.0.1:1'}
p = subprocess.Popen([binary, 'app-server', '--stdio'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=open(root / 'stderr-turn.log', 'w'), text=True, env=env, cwd=cwd)
s = selectors.DefaultSelector()
s.register(p.stdout, selectors.EVENT_READ)
read_buffer = b''

def read_until(predicate, label):
    global read_buffer
    end = time.monotonic() + 40
    while time.monotonic() < end:
        if b'\n' not in read_buffer:
            if not s.select(max(0, end - time.monotonic())):
                break
            chunk = os.read(p.stdout.fileno(), 65536)
            if not chunk:
                raise RuntimeError('app-server exited')
            read_buffer += chunk
            continue
        line, read_buffer = read_buffer.split(b'\n', 1)
        r = json.loads(line)
        if predicate(r):
            return r
    raise RuntimeError('deadline ' + label)

def rpc(i, m, params):
    p.stdin.write(json.dumps({'id': i, 'method': m, 'params': params}) + '\n')
    p.stdin.flush()
    r = read_until(lambda r: r.get('id') == i, m)
    if 'error' in r:
        raise RuntimeError(r['error'])
    return r['result']
try:
    rpc(1, 'initialize', {'clientInfo': {'name': 'skills-observation', 'version': '1'}, 'capabilities': {'experimentalApi': True}})
    p.stdin.write(json.dumps({'method': 'initialized'}) + '\n')
    p.stdin.flush()
    effective = rpc(900, 'config/read', {'cwd': str(cwd), 'includeLayers': False})
    builder = '''
import { headlessCodexThreadConfig } from "./src/lib/codexHeadlessConfig";
const effective = await Bun.stdin.json();
console.log(JSON.stringify([false, true].map(omit => {
  const config = headlessCodexThreadConfig(effective, false, [], [], "stdio", [], false, omit);
  // The probe never connects to a real MCP server.
  for (const server of Object.values(config.mcp_servers)) server.enabled = false;
  return config;
})));
'''
    configs = json.loads(subprocess.check_output(['bun', '-e', builder], input=json.dumps(effective),
        text=True, env=env, cwd=pathlib.Path(__file__).resolve().parent.parent, timeout=30))
    results = []
    for n, setting in enumerate([None, False, None, False]):
        config = configs[0 if setting is None else 1]
        r = rpc(n * 3 + 2, 'thread/start', {'cwd': str(cwd), 'model': 'gpt-6.1-sol', 'approvalPolicy': 'never', 'sandbox': 'read-only', 'developerInstructions': 'Observation: preserve the repository instructions.', 'config': config})
        tid = r['thread']['id']
        rpc(n * 3 + 3, 'turn/start', {'threadId': tid, 'input': [{'type': 'text', 'text': 'Reply OK without tools.'}]})
        read_until(lambda r: r.get('method') == 'turn/completed', 'turn/completed')
        request = captures[-1]
        dev = [x for x in request['input'] if x.get('role') == 'developer']
        texts = [''.join((c.get('text', '') for c in x.get('content', []))) for x in dev]
        rows = [json.loads(line) for line in pathlib.Path(r['thread']['path']).read_text().splitlines()]
        first_record = next((row['payload'] for row in rows if row.get('type') == 'response_item' and row['payload'].get('role') == 'developer'))
        first = ''.join((part.get('text', '') for part in first_record['content']))
        result = {'skills.include_instructions': setting, 'first_developer_bytes': len(first.encode()), 'skills_block_present': '<skills_instructions>' in first, 'developer_messages': len(dev), 'skills_block_bytes': sum((len(t.split('<skills_instructions>', 1)[1].split('</skills_instructions>', 1)[0].encode()) + len('<skills_instructions></skills_instructions>') for t in texts if '<skills_instructions>' in t))}
        results.append(result)
        print(json.dumps(result), flush=True)
    args.output.write_text(json.dumps({'version': version, 'transport': 'app-server stdio, thread/start config override', 'runs': results}, indent=2) + '\n')
finally:
    p.terminate()
    try:
        p.wait(timeout=10)
    except subprocess.TimeoutExpired:
        p.kill()
        p.wait(timeout=10)
    s.close()
    server.shutdown()
    server.server_close()
