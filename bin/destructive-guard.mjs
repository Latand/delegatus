// One dependency-free policy for engine hooks and inherited command wrappers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const VERSION = 1;
export const inside = (target, root) => target.startsWith(root === '/' ? '/' : root + path.sep);
const sameOrInside = (target, root) => target === root || inside(target, root);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
let nativeHome;
/** Bun's userInfo may use HOME. The policy's home always comes from the OS. */
export function passwdHome() {
  if (nativeHome) return nativeHome;
  if (typeof process.getuid === 'function') {
    try {
      const row = fs.readFileSync('/etc/passwd', 'utf8').split('\n').map(line => line.split(':')).find(fields => Number(fields[2]) === process.getuid() && path.isAbsolute(fields[5] ?? ''));
      if (row) return nativeHome = row[5];
    } catch { /* directory-service accounts need the clean-runtime lookup */ }
  }
  const env = { ...process.env }; delete env.HOME; delete env.USERPROFILE;
  const probe = spawnSync(process.execPath, ['-e', 'process.stdout.write(require("node:os").userInfo().homedir)'], { env, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
  if (probe.status === 0 && path.isAbsolute(probe.stdout)) return nativeHome = probe.stdout;
  if (!process.versions.bun) return nativeHome = os.userInfo().homedir;
  throw Error('operating-system home could not be resolved');
}
export function canonical(value) {
  // Some runtime realpath implementations normalise '..' before traversing a
  // link. Walk components explicitly so this follows kernel pathname order.
  if (!path.isAbsolute(value)) value = process.cwd() + '/' + value;
  const pending = value.split('/'), resolved = [];
  let links = 0;
  while (pending.length) {
    const part = pending.shift();
    if (!part || part === '.') continue;
    if (part === '..') { resolved.pop(); continue; }
    const current = '/' + [...resolved, part].join('/');
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
    if (stat?.isSymbolicLink()) {
      if (++links > 40) throw Error('too many symbolic links');
      const link = fs.readlinkSync(current);
      if (path.isAbsolute(link)) resolved.length = 0;
      pending.unshift(...link.split('/'));
    } else resolved.push(part);
  }
  return '/' + resolved.join('/');
}
export function fallbackPolicy() {
  const home = passwdHome();
  const sealed = ['.config/delegatus', '.config/agent-log-viewer', '.config/live-log-viewer', '.cache/delegatus', '.claude', '.claude.json', '.codex', '.ssh', '.gnupg']
    .map(name => ({ path: path.join(home, name), kind: 'protected account or configuration' }));
  return { v: VERSION, home: [...new Set([home, canonical(home)])], sealed, digest: 'fallback' };
}
export const PROJECT_KIND = 'another project';
/** Temp roots a project entry must never cover: sealing one would refuse
 * every scratch file on the machine. */
export function temporaryRoots(extra = []) {
  const roots = ['/tmp', '/var/tmp', os.tmpdir(), ...extra].filter(value => typeof value === 'string' && path.isAbsolute(value));
  return [...new Set(roots.flatMap(value => [path.resolve(value), canonical(value)]))];
}
/** A recorded project root may be sealed only when it is narrower than the
 * places every agent legitimately writes: never `/`, a top-level directory,
 * the home or one of its ancestors, or a temp root or one of its ancestors.
 * A session started in the home is catalogued as a project; sealing it would
 * refuse every delete under the home. */
export function sealableProject(value, homes, temporary = temporaryRoots()) {
  if (value === '/' || path.dirname(value) === '/') return false;
  return !homes.some(home => sameOrInside(home, value)) && !temporary.some(root => sameOrInside(root, value));
}
/** @param {Readonly<Record<string, string | undefined>>} env */
export function readPolicy(env = process.env) {
  try {
    const policy = JSON.parse(fs.readFileSync(env.LLV_DESTRUCTIVE_GUARD_POLICY, 'utf8'));
    if (policy.v !== VERSION || typeof policy.digest !== 'string' || !/^[a-f0-9]{64}$/.test(policy.digest) || !Array.isArray(policy.home) || !policy.home.every(p => typeof p === 'string' && path.isAbsolute(p))
      || !Array.isArray(policy.sealed) || !policy.sealed.every(p => typeof p.path === 'string' && path.isAbsolute(p.path) && typeof p.kind === 'string')) throw Error('invalid policy');
    // A policy file written before this filter existed is narrowed on read.
    const temporary = temporaryRoots();
    policy.sealed = policy.sealed.filter(entry => entry.kind !== PROJECT_KIND || sealableProject(entry.path, policy.home, temporary));
    return policy;
  } catch { return fallbackPolicy(); }
}
/** The project a session started without a launch working tree is working in:
 * its checkout top level, else the deepest recorded project containing it,
 * else the directory itself. Roots that are a home, `/`, or inside a
 * protected non-project entry are never own. */
export function sessionOwnRoot(cwd, policy) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
  let directory;
  try { directory = canonical(cwd); } catch { return null; }
  let root = null;
  // A dotfiles repository at the home never makes the whole home own.
  for (let candidate = directory; candidate !== '/' && !policy.home.some(home => sameOrInside(home, candidate)); candidate = path.dirname(candidate)) {
    let marker; try { marker = fs.lstatSync(path.join(candidate, '.git'), { throwIfNoEntry: false }); } catch { /* unreadable parent */ }
    if (marker) { root = candidate; break; }
  }
  if (!root) {
    const projects = policy.sealed.filter(entry => entry.kind === PROJECT_KIND && sameOrInside(directory, entry.path)).map(entry => entry.path);
    root = projects.sort((a, b) => b.length - a.length)[0] ?? directory;
  }
  if (root === '/' || path.dirname(root) === '/' || policy.home.some(home => sameOrInside(home, root))) return null;
  if (policy.sealed.some(entry => entry.kind !== PROJECT_KIND && sameOrInside(root, entry.path))) return null;
  return root;
}
export function resolveTarget(given, cwd, follow = false, parents = new Map()) {
  // path.resolve would erase a symlink/.. before realpath can see it.
  const absolute = path.isAbsolute(given) ? given : cwd + path.sep + given;
  if (follow || /(?:\/|\/\.|\/\.\.)$/.test(absolute)) return canonical(absolute);
  const parent = path.dirname(absolute);
  if (!parents.has(parent)) parents.set(parent, canonical(parent));
  return path.join(parents.get(parent), path.basename(absolute));
}
/**
 * @param {string} given
 * @param {{ policy?: { home: string[], sealed: { path: string, kind: string }[] }, own?: string[], cwd?: string, follow?: boolean, noPreserveRoot?: boolean, parents?: Map<string, string>, clearOwnRoots?: string[] }} [options]
 */
export function evaluate(given, { policy, own = [], cwd = process.cwd(), follow = false, noPreserveRoot = false, parents, clearOwnRoots } = {}) {
  policy ??= readPolicy();
  if (given === '' && !noPreserveRoot) return null;
  const resolved = resolveTarget(given, cwd, follow, parents);
  const deny = (rule, entry, kind) => ({ given, resolved, rule, entry, kind });
  if (noPreserveRoot) return deny('no-preserve-root', resolved, 'root preservation disabled');
  if (resolved === '/' || path.dirname(resolved) === '/') return deny('structural', resolved, 'a top-level system directory');
  // Computed once for a command: these owned subtrees contain no sealed entry.
  // Resolution still runs for every operand, including followed final links.
  if (clearOwnRoots?.some(root => inside(resolved, root))) return null;
  for (const home of policy.home) {
    if (resolved === home) return deny('home', home, 'your home directory');
    if (inside(home, resolved)) return deny('ancestor', home, 'an ancestor of your home');
  }
  for (const entry of policy.sealed) {
    if (entry.kind === PROJECT_KIND && own.includes(entry.path)) continue;
    if (resolved === entry.path || inside(entry.path, resolved)) return deny(resolved === entry.path ? 'sealed' : 'ancestor', entry.path, entry.kind);
  }
  const safeOwn = own.filter(root => root !== '/' && !policy.home.some(home => sameOrInside(home, root))
    && !policy.sealed.some(entry => entry.path === root && entry.kind !== 'another project'));
  if (safeOwn.some(root => inside(resolved, root)
    && !policy.sealed.some(entry => inside(entry.path, root) && sameOrInside(resolved, entry.path)))) return null;
  for (const entry of policy.sealed) if (inside(resolved, entry.path)) return deny('sealed', entry.path, entry.kind);
  return null;
}

function findActions(args) {
  const values = new Set(['-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '-lname', '-ilname', '-regex', '-iregex', '-printf', '-fprint', '-fprint0', '-fls', '-type', '-xtype', '-user', '-group', '-uid', '-gid', '-size', '-perm', '-inum', '-links', '-samefile', '-newer', '-anewer', '-cnewer', '-mtime', '-atime', '-ctime', '-mmin', '-amin', '-cmin', '-used', '-fstype', '-context', '-maxdepth', '-mindepth', '-regextype', '-D', '-O', '-f']);
  const result = { delete: false, follow: false, files: [], executions: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-delete') result.delete = true;
    else if (arg === '-follow') result.follow = true;
    else if (arg === '-files0-from') result.files.push(args[++i]);
    else if (['-exec', '-execdir', '-ok', '-okdir'].includes(arg)) {
      const execution = []; while (++i < args.length && ![';', '+'].includes(args[i])) execution.push(args[i]);
      result.executions.push(execution);
    } else if (arg === '-fprintf') i += 2;
    else if (values.has(arg) || /^-newer[a-zA-Z]{2}$/.test(arg)) i++;
  }
  return result;
}
const rsyncDelete = arg => arg === '--del' || arg.startsWith('--delete') || arg.startsWith('--dele') && '--delete'.startsWith(arg)
  || arg.startsWith('--remove-s') && ['--remove-source-files', '--remove-sent-files'].some(option => option.startsWith(arg));

/** Tool argument grammars. All targets are checked before starting a tool. */
export function commandTargets(tool, args, cwd = process.cwd(), context) {
  const targets = [];
  const add = (given, follow = false, uncertain = false) => targets.push({ given, follow, uncertain });
  if (tool === 'dd') {
    for (const arg of args) if (arg.startsWith('of=')) add(arg.slice(3), true);
    return targets;
  }
  if (tool === 'find') {
    const actions = findActions(args);
    if (!actions.delete) return targets;
    let index = 0, mode = '-P'; const explicit = [];
    while (index < args.length) {
      const arg = args[index];
      if (['-H', '-L', '-P'].includes(arg)) { mode = arg; index++; continue; }
      if (/^-O[0-3]$/.test(arg) || ['-E', '-X', '-s', '-d', '-x'].includes(arg)) { index++; continue; }
      if (arg === '-f') { if (args[index + 1]) explicit.push(args[index + 1]); index += 2; continue; }
      if (['-D', '-O', '-files0-from'].includes(arg)) { index += 2; continue; }
      if (arg === '--') index++;
      break;
    }
    const follow = mode !== '-P' || actions.follow;
    for (const given of explicit) add(given, follow);
    let fromFile = false;
    for (const file of actions.files) {
      fromFile = true;
      if (!file || file === '-') { add(file || '<find stdin>', true, true); continue; }
      let descriptor;
      try {
        descriptor = fs.openSync(path.isAbsolute(file) ? file : cwd + '/' + file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
        const stat = fs.fstatSync(descriptor);
        if (!stat.isFile() || stat.size > 1024 * 1024) { add(file, true, true); continue; }
        const names = fs.readFileSync(descriptor, 'utf8').split('\0').filter(Boolean);
        if (names.length > 10000) add(file, true, true); else for (const name of names) add(name, follow);
      } catch { add(file, true, true); }
      finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
    }
    for (; index < args.length && !/^[-!()]/.test(args[index]); index++) add(args[index], follow);
    if (!targets.length && !fromFile) add('.', follow);
    // -L/-follow can reach a sealed tree through a link below a safe start.
    // Default -P never follows those links and keeps its constant-cost check.
    if (mode === '-L' || actions.follow) {
      if (context && targets.some(target => target.uncertain || evaluate(target.given, { ...context, follow: target.follow }))) return targets;
      const visited = new Set(), pending = targets.filter(target => !target.uncertain).map(target => target.given);
      while (pending.length) {
        const given = pending.pop(), absolute = path.isAbsolute(given) ? given : cwd + '/' + given;
        let stat; try { stat = fs.lstatSync(absolute); } catch { continue; }
        if (stat.isSymbolicLink()) add(given, true);
        const resolved = canonical(absolute);
        if (visited.has(resolved)) continue;
        visited.add(resolved);
        if (visited.size > 10000) { targets.push({ given: '/', follow: true }); break; }
        let names; try { names = fs.readdirSync(absolute); } catch { continue; }
        for (const name of names) pending.push(given + '/' + name);
      }
    }
    return targets;
  }
  const operands = [];
  let options = true, destination, directoryTarget = true, deleting = false, removeSource = false;
  const values = { rm: [], mv: ['--suffix'], cp: ['--suffix'], rsync: ['-e', '--rsh', '--exclude', '--include', '--filter', '-f', '--files-from', '--exclude-from', '--include-from', '--backup-dir', '--suffix', '--out-format', '--log-file', '--chmod', '--chown', '--usermap', '--groupmap', '--bwlimit'], truncate: ['-s', '--size', '-r', '--reference'], shred: ['-n', '--iterations', '-s', '--size'] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (options && arg === '--') { options = false; continue; }
    if (options && arg.startsWith('-') && arg !== '-') {
      if ((tool === 'mv' || tool === 'cp') && !arg.startsWith('--')) {
        for (let flag = 1; flag < arg.length; flag++) {
          if (arg[flag] === 'T') directoryTarget = false;
          if (arg[flag] === 't' || arg[flag] === 'S') {
            const value = arg.slice(flag + 1) || args[++i];
            if (arg[flag] === 't') destination = value;
            break;
          }
        }
        continue;
      }
      if ((tool === 'mv' || tool === 'cp') && arg.startsWith('--')) {
        const option = arg.split('=')[0];
        if (option.length > 2 && '--target-directory'.startsWith(option)) {
          destination = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[++i];
          continue;
        }
      }
      if (tool === 'rsync' && rsyncDelete(arg)) { deleting = true; removeSource ||= arg.startsWith('--remove-s'); }
      if (arg === '-T' || arg === '--no-target-directory') directoryTarget = false;
      if (values[tool]?.includes(arg)) i++;
      continue;
    }
    operands.push(arg);
  }
  if (tool === 'mv' || tool === 'cp') {
    destination ??= operands.pop();
    if (tool === 'mv') for (const source of operands) add(source);
    if (destination) {
      let directory = false;
      try { directory = directoryTarget && fs.statSync(path.isAbsolute(destination) ? destination : cwd + '/' + destination).isDirectory(); } catch { /* new destination */ }
      if (directory) for (const source of operands) add(destination + '/' + path.basename(source.replace(/\/+$/, '')), tool === 'cp');
      else add(destination, tool === 'cp');
    }
  } else if (tool === 'rsync') {
    if (!deleting) return targets;
    const remote = value => /^(?:[^/]+:|rsync:\/\/)/.test(value);
    if (removeSource) for (const source of operands.slice(0, -1)) if (!remote(source)) add(source, true);
    const dest = operands.at(-1);
    if (dest && !remote(dest)) add(dest, true);
  } else for (const operand of operands) add(operand, tool === 'truncate');
  return targets;
}
export function checkCommand(tool, args, context) {
  const { policy, own = [] } = context;
  const clearOwnRoots = own.filter(root => root !== '/' && !policy.home.some(home => sameOrInside(home, root))
    && !policy.sealed.some(entry => entry.path === root && entry.kind !== 'another project' || inside(entry.path, root)));
  context = { ...context, parents: new Map(), clearOwnRoots };
  if (tool === 'rm' && args.some(arg => arg === '--no-preserve-root' || arg.startsWith('--no-preserve-root=')))
    return { given: '--no-preserve-root', resolved: '/', rule: 'no-preserve-root', entry: '/', kind: 'root preservation disabled' };
  for (const target of commandTargets(tool, args, context.cwd, context)) {
    if (target.uncertain) return { given: target.given, resolved: '', rule: 'too-broad', entry: target.given, kind: 'unresolvable find start points' };
    const refusal = evaluate(target.given, { ...context, follow: target.follow });
    if (refusal) return refusal;
  }
  return null;
}

/** A bounded shell lexer. It never invokes a shell or evaluates substitutions.
 * Quoting controls expansion; nested executable text is inspected separately. */
export function inspectShell(command, context, vars = {}, depth = 0, expansionsOnly = false) {
  if (depth > 24) throw Error('shell nesting limit');
  let words = [], value = '', quote = '', started = false, glob = false, unknown = false, guarded = false, tilde = false, arrayDepth = 0, quotedWord = false, redirect = '';
  const redirects = [], stdinBodies = [];
  // The working directory follows literal cd/pushd/popd through the command
  // list; a subshell's changes end with it. A directory the hook cannot
  // resolve uses its empty-expansion form, and a refusal of a relative target
  // under it is reported as that expansion.
  let cwd = context.cwd, oldCwd, cwdUnknown = null;
  const directoryStack = [], subshells = [];
  const here = () => ({ ...context, cwd });
  const variables = { HOME: process.env.HOME ?? '', TMPDIR: process.env.TMPDIR ?? '', PWD: context.cwd, ...vars };
  const unresolved = new Map();
  let unknownVariables = [];
  let refusal = null;
  const heredocs = [];
  let heredocStart = 0;
  const flush = () => {
    if (started) {
      const token = { value, glob, unknown, guarded, tilde, unknownVariables, quoted: quotedWord };
      if (redirect) { redirects.push({ ...token, redirect }); redirect = ''; } else words.push(token);
    }
    value = ''; started = glob = unknown = guarded = tilde = quotedWord = false;
    unknownVariables = [];
  };
  const expand = word => {
    if (word.guarded) return [];
    let text = word.tilde ? word.value.replace(/^~(?=\/|$)/, variables.HOME) : word.value;
    if (word.tilde && /^~[^/]+/.test(text)) {
      const user = text.match(/^~([^/]+)/)[1];
      try { const row = fs.readFileSync('/etc/passwd', 'utf8').split('\n').find(row => row.startsWith(user + ':')); if (row) text = row.split(':')[5] + text.slice(user.length + 1); } catch { /* platform without passwd */ }
    }
    if (!word.glob || !/[*?[]/.test(text)) return [text];
    const absolute = path.isAbsolute(text) ? text : cwd + '/' + text;
    let paths = ['/'];
    for (const part of absolute.split('/').filter(Boolean)) {
      const next = [];
      if (!/[*?[]/.test(part)) { paths = paths.map(prefix => prefix + (prefix.endsWith('/') ? '' : '/') + part); continue; }
      const re = new RegExp('^' + part.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.').replace(/\[!/g, '[^') + '$');
      for (const prefix of paths) {
        let names = []; try { names = fs.readdirSync(prefix); } catch { /* absent prefix */ }
        for (const name of names) if ((part.startsWith('.') || !name.startsWith('.')) && re.test(name)) {
          next.push(prefix + (prefix.endsWith('/') ? '' : '/') + name);
          if (next.length > 10000) { refusal = { given: text, resolved: absolute, rule: 'too-broad', entry: absolute, kind: 'more than 10000 glob matches' }; return []; }
        }
      }
      paths = next;
    }
    return paths.length ? paths : [text];
  };
  const changeDirectory = (tool, args) => {
    if (tool === 'popd') {
      if (directoryStack.length) { oldCwd = cwd; ({ cwd, cwdUnknown } = directoryStack.pop()); }
      return;
    }
    let physical = false, noChange = false, options = true; const operands = [];
    for (const arg of args) {
      if (options && arg.value === '--') { options = false; continue; }
      if (options && /^-[LPe@n]+$/.test(arg.value)) { physical ||= arg.value.includes('P'); noChange ||= tool === 'pushd' && arg.value.includes('n'); continue; }
      operands.push(arg);
    }
    if (noChange) return;
    const previous = { cwd, cwdUnknown };
    let next, unresolved = null, inherits = true;
    const word = operands[0];
    if (!word) {
      if (tool === 'pushd') { if (!directoryStack.length) return; next = directoryStack.at(-1).cwd; unresolved = directoryStack.at(-1).cwdUnknown; }
      else next = variables.HOME;
    } else if (tool === 'pushd' && /^[-+]\d+$/.test(word.value)) {
      next = cwd; unresolved = ['pushd ' + word.value];
    } else if (word.value === '-' && !word.quoted) {
      if (oldCwd === undefined) { unresolved = ['$OLDPWD']; next = cwd; } else next = oldCwd;
    } else if (word.guarded) {
      // ${X:?} stops the shell when X is empty; the directory is still unknown.
      next = cwd; unresolved = ['$' + (word.unknownVariables[0] ?? 'X')];
    } else {
      const text = expand(word)[0] ?? '';
      if (word.unknown || word.glob && /[*?[]/.test(text)) unresolved = word.unknownVariables.length ? word.unknownVariables : [text];
      // Bash: an empty unquoted operand is `cd` (the home); a quoted one stays.
      if (text === '') next = word.quoted ? cwd : variables.HOME;
      else next = path.isAbsolute(text) ? text : cwd + '/' + text;
      inherits = next !== variables.HOME && !path.isAbsolute(text);
    }
    if (!word && tool === 'cd') inherits = false;
    if (!next || !path.isAbsolute(next)) { next = cwd; unresolved ??= ['cd']; }
    try { next = physical ? canonical(next) : path.resolve(next); } catch { unresolved ??= [next]; next = path.resolve(next); }
    if (tool === 'pushd') directoryStack.push(previous);
    oldCwd = cwd; cwd = next; variables.PWD = next;
    const base = inherits ? cwdUnknown ?? [] : [];
    cwdUnknown = unresolved || base.length ? [...new Set([...base, ...(unresolved ?? [])])] : null;
  };
  const relativeUnderUnknown = before => {
    if (!before && refusal && cwdUnknown && refusal.given && (!path.isAbsolute(refusal.given) || sameOrInside(refusal.given, cwd))) refusal = { ...refusal, rule: 'empty-expansion', variables: cwdUnknown };
  };
  const inspect = () => {
    flush();
    let args = words; words = [];
    if (expansionsOnly) return;
    const before = refusal;
    try { inspectWords(args); } finally { relativeUnderUnknown(before); }
  };
  const inspectWords = args => {
    while (args.length && (/^[A-Za-z_]\w*=/.test(args[0].value) || ['!', 'if', 'then', 'else', 'do'].includes(args[0].value))) {
      const token = args.shift(), assignment = token.value.match(/^([A-Za-z_]\w*)=(.*)$/s);
      if (assignment) { variables[assignment[1]] = assignment[2]; unresolved.set(assignment[1], token.unknownVariables); }
    }
    for (const word of redirects.splice(0)) {
      if (word.redirect === 'here') stdinBodies.push(word.value);
      if (word.redirect === 'truncate' || word.redirect === 'dup' && !/^(?:\d+|-)$/.test(word.value)) {
        for (const target of expand(word)) refusal ??= evaluate(target, { ...here(), follow: true });
        if (refusal && word.unknown) refusal = { ...refusal, rule: 'empty-expansion', variables: word.unknownVariables };
      }
    }
    while (args.length) {
      const tool = path.basename(args.shift().value);
      if (['cd', 'pushd', 'popd'].includes(tool)) { changeDirectory(tool, args); return; }
      if (['sh', 'bash', 'zsh', 'dash', 'ksh'].includes(tool)) {
        const index = args.findIndex(arg => /^-[^-]*c/.test(arg.value));
        if (index >= 0) refusal ??= inspectShell(args[index + 1]?.value ?? '', here(), variables, depth + 1);
        else if (!args.some(arg => !arg.value.startsWith('-') && arg.value !== '-')) {
          for (const document of heredocs.slice(heredocStart)) document.executable = true;
          for (const body of stdinBodies.splice(0)) refusal ??= inspectShell(body, here(), variables, depth + 1);
        }
        return;
      }
      if (['command', 'builtin', 'exec', 'nohup', 'sudo', 'pkexec', 'env', 'rtk', 'xargs', 'timeout', 'nice', 'ionice', 'time', 'uv', 'poetry'].includes(tool)) {
        if (tool === 'command' && args.some(arg => ['-v', '-V'].includes(arg.value))) return;
        const values = ['-a', '-c', '-C', '-g', '-I', '-k', '-n', '-p', '-P', '-s', '-u', '--user', '--group', '--chdir', '--unset', '--signal', '--kill-after'];
        while (args[0]?.value.startsWith('-') || /^[A-Za-z_]\w*=/.test(args[0]?.value ?? '')) { const flag = args.shift().value; if (values.includes(flag)) args.shift(); }
        if (tool === 'timeout') args.shift();
        if (['proxy', 'run'].includes(args[0]?.value)) args.shift();
        // uv/poetry options can follow the run subcommand.
        if (tool === 'uv' || tool === 'poetry') while (args[0]?.value.startsWith('-')) {
          const flag = args.shift().value;
          if (['--project', '--directory', '--package', '--python', '--with', '--with-requirements'].includes(flag)) args.shift();
        }
        continue;
      }
      if (['rm', 'rmdir', 'unlink', 'shred', 'truncate', 'find', 'rsync', 'mv', 'cp', 'dd'].includes(tool)) {
        if (tool === 'shred' && !args.some(arg => /^--remove|^-[^-]*u/.test(arg.value))) return;
        const expanded = args.flatMap(expand);
        refusal ??= checkCommand(tool, expanded, here());
        if (tool === 'find') for (const execution of findActions(expanded).executions) {
          const nestedTool = path.basename(execution[0] ?? '');
          if (['rm', 'rmdir', 'unlink', 'shred', 'truncate', 'mv', 'rsync', 'cp', 'dd', 'sh', 'bash', 'zsh', 'dash', 'ksh'].includes(nestedTool)) {
            refusal ??= inspectShell(execution.map(word => "'" + word.replaceAll("'", "'\\''") + "'").join(' '), here(), variables, depth + 1);
            if (execution.some(word => word.includes('{}'))) refusal ??= checkCommand('find', [...expanded, '-delete'], here());
          }
        }
        if (refusal && args.some(arg => arg.unknown)) refusal = { ...refusal, rule: 'empty-expansion', variables: [...new Set(args.flatMap(arg => arg.unknownVariables))] };
      }
      return;
    }
  };
  // Bash ANSI-C quoting: $'…' with backslash escapes. Returns the index of
  // the closing quote; the decoded text joins the current word.
  const ansiC = j => {
    const simple = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };
    for (; j < command.length; j++) {
      const t = command[j];
      if (t === "'") return j;
      if (t !== '\\') { value += t; continue; }
      const e = command[++j];
      if (e === undefined) break;
      let digits;
      if (e in simple) value += simple[e];
      else if ((digits = command.slice(j).match(/^[0-7]{1,3}/))) { value += String.fromCharCode(parseInt(digits[0], 8) & 0xff); j += digits[0].length - 1; }
      else if (e === 'x' && (digits = command.slice(j + 1).match(/^[0-9a-fA-F]{1,2}/))) { value += String.fromCharCode(parseInt(digits[0], 16)); j += digits[0].length; }
      else if ((e === 'u' || e === 'U') && (digits = command.slice(j + 1).match(e === 'u' ? /^[0-9a-fA-F]{1,4}/ : /^[0-9a-fA-F]{1,8}/))) {
        const point = parseInt(digits[0], 16); value += point <= 0x10ffff ? String.fromCodePoint(point) : ''; j += digits[0].length;
      } else if (e === 'c' && j + 1 < command.length) { value += String.fromCharCode(command[++j].toUpperCase().charCodeAt(0) & 0x1f); }
      else value += '\\' + e;
    }
    throw Error('unterminated shell quote');
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === '\\' && quote !== "'") { const next = command[++i]; if (next !== '\n') { value += next ?? ''; started = quotedWord = true; } continue; }
    if (!expansionsOnly && c === quote) { quote = ''; continue; }
    if (!expansionsOnly && !quote && c === '$' && command[i + 1] === '"') continue; // $"…" is a translated "…"
    if (!expansionsOnly && !quote && c === '$' && command[i + 1] === "'") { i = ansiC(i + 2); started = quotedWord = true; continue; }
    if (!expansionsOnly && !quote && (c === "'" || c === '"')) { quote = c; started = quotedWord = true; continue; }
    if (quote !== "'" && (c === '`' || c === '$' && command[i + 1] === '(' || !expansionsOnly && !quote && /[<>]/.test(c) && command[i + 1] === '(')) {
      const backtick = c === '`', start = i + (backtick ? 1 : 2);
      let end = start, level = 1, innerQuote = '';
      for (; end < command.length; end++) {
        const t = command[end]; if (t === '\\') { end++; continue; }
        if (backtick) { if (t === '`') break; continue; }
        if (t === innerQuote) { innerQuote = ''; continue; }
        if (!innerQuote && /['"]/.test(t)) { innerQuote = t; continue; }
        if (!innerQuote && t === '(') level++;
        if (!innerQuote && t === ')' && --level === 0) break;
      }
      refusal ??= inspectShell(command.slice(start, end), here(), variables, depth + 1);
      unknownVariables.push(backtick ? '`…`' : '$(…)'); unknown = started = true; i = end; continue;
    }
    if (quote !== "'" && c === '$') {
      const match = command.slice(i).match(/^\$(?:\{([A-Za-z_]\w*|\d+|[@*#?$!_-])([^}]*)\}|([A-Za-z_]\w*|\d|[@*#?$!_-]))/);
      if (match) {
        const name = match[1] ?? match[3], modifier = match[2] ?? '';
        if (modifier.startsWith(':?') || modifier.startsWith('?')) guarded = true;
        else if (modifier.startsWith(':-') || modifier.startsWith('-')) value += variables[name] || modifier.replace(/^:?-/, '');
        else {
          value += variables[name] ?? '';
          if (variables[name] === undefined || unresolved.get(name)?.length) {
            unknown = true; unknownVariables.push(...(unresolved.get(name)?.length ? unresolved.get(name) : ['$' + name]));
          }
        }
        i += match[0].length - 1; started = true; continue;
      }
    }
    if (!quote && c === '(' && /^[A-Za-z_]\w*(?:\[[^\]]+\])?\+?=$/.test(value)) {
      value = ''; started = false; arrayDepth = 1; continue;
    }
    if (arrayDepth) {
      if (!quote && c === '(') arrayDepth++;
      if (!quote && c === ')') arrayDepth--;
      continue;
    }
    if (!quote && !expansionsOnly && command.startsWith('<<', i) && command[i + 2] !== '<') {
      flush();
      const match = command.slice(i).match(/^<<(-?)\s*(?:'([^']*)'|"([^"]*)"|([^\s;|&<>]+))/);
      if (!match) throw Error('unparsed heredoc');
      heredocs.push({ delimiter: (match[2] ?? match[3] ?? match[4]).replaceAll('\\', ''), literal: match[2] !== undefined || match[3] !== undefined || match[4]?.includes('\\'), stripTabs: !!match[1], executable: false });
      i += match[0].length - 1; continue;
    }
    if (!quote && !expansionsOnly && c === '{' && !started) {
      const descriptor = command.slice(i).match(/^\{[A-Za-z_]\w*\}(?=[<>])/);
      if (descriptor) { i += descriptor[0].length - 1; continue; }
    }
    if (!quote && !expansionsOnly && (c === '>' || c === '<' || c === '&' && command[i + 1] === '>')) {
      if (started && !quotedWord && /^\d+$/.test(value)) { value = ''; started = false; }
      flush();
      if (c === '&') i++;
      const operator = command[i];
      redirect = operator === '>' ? 'truncate' : 'ignore';
      if (command[i + 1] === operator) {
        i++; redirect = 'ignore';
        if (operator === '<' && command[i + 1] === '<') { i++; redirect = 'here'; }
      } else if (command[i + 1] === '&') { i++; if (operator === '>') redirect = 'dup'; }
      else if (command[i + 1] === '|' || operator === '<' && command[i + 1] === '>') i++;
      continue;
    }
    if (!quote && c === '#' && !started) { while (i < command.length && command[i] !== '\n') i++; }
    if (!quote && /[;|&\n(){}]/.test(command[i] ?? '')) {
      inspect();
      if (!expansionsOnly && command[i] === '(') subshells.push({ cwd, cwdUnknown, oldCwd, stack: directoryStack.length });
      if (!expansionsOnly && command[i] === ')' && subshells.length) {
        const saved = subshells.pop();
        ({ cwd, cwdUnknown, oldCwd } = saved); directoryStack.length = Math.min(directoryStack.length, saved.stack); variables.PWD = cwd;
      }
      if (command[i] === '\n') {
        let offset = i + 1;
        for (const document of heredocs.splice(0)) {
          let body = '';
          while (offset < command.length) {
            const end = command.indexOf('\n', offset), next = end < 0 ? command.length : end;
            let line = command.slice(offset, next); offset = next + 1;
            if (document.stripTabs) line = line.replace(/^\t+/, '');
            if (line === document.delimiter) break;
            body += line + '\n';
          }
          if (document.executable || !document.literal) refusal ??= inspectShell(body, here(), variables, depth + 1, !document.executable);
        }
        if (offset !== i + 1) i = offset - 1;
        heredocStart = 0; stdinBodies.length = 0;
      } else if (command[i] !== '|') {
        heredocStart = heredocs.length; stdinBodies.length = 0;
      }
      continue;
    }
    if (!quote && /\s/.test(command[i] ?? '')) flush();
    else { if (!quote && !started && c === '~') tilde = true; value += command[i] ?? ''; started = true; if (!quote && /[*?[]/.test(c)) glob = true; }
  }
  if (quote) throw Error('unterminated shell quote');
  inspect(); return refusal;
}

export function stopMessage(refusal, command) {
  return `Delegatus stopped this command: ${command.slice(0, 300)} would delete ${refusal.entry} (${refusal.kind}). Nothing was deleted by it. Stop and ask the operator before you delete, move or overwrite anything outside your worktree and your temp directory. Do not retry it another way.${refusal.rule === 'empty-expansion' ? ` If ${(refusal.variables ?? ['$X']).join(', ')} is empty this deletes ${refusal.resolved}. Guard it with \${X:?} or use a literal path inside your worktree or temp directory.` : ''}`;
}
function parents() {
  const rows = []; let pid = process.ppid;
  if (process.platform !== 'linux') {
    const result = spawnSync('ps', ['-axo', 'pid=,ppid=,comm=,args='], { encoding: 'utf8', timeout: 1000 });
    const all = (result.stdout ?? '').split('\n').map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/)).filter(Boolean);
    while (pid > 1 && rows.length < 12) { const row = all.find(row => Number(row[1]) === pid); if (!row) break; rows.push({ pid, comm: row[3], args: row[4].slice(0, 100) }); pid = Number(row[2]); }
    return rows;
  }
  while (pid > 1 && rows.length < 12) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'), end = stat.lastIndexOf(')'), fields = stat.slice(end + 2).split(' ');
      rows.push({ pid, startTime: fields[19], comm: stat.slice(stat.indexOf('(') + 1, end), args: fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').slice(0, 100) });
      pid = Number(fields[1]);
    } catch { break; }
  }
  return rows;
}
export function journal(layer, tool, command, cwd, refusal, input = {}, env = process.env) {
  const file = env.LLV_DESTRUCTIVE_GUARD_JOURNAL;
  if (!file) return;
  const policy = readPolicy(env);
  const row = { v: VERSION, id: crypto.randomUUID(), at: new Date().toISOString(), layer, tool: String(tool).slice(0, 80), command: command.slice(0, 900), cwd,
    targets: refusal ? [refusal] : [], caller: { capabilityDigest: env.LLV_DESTRUCTIVE_GUARD_CALLER, pipelineId: env.LLV_GATE_LANE_ID, stageId: env.LLV_GATE_STAGE_ID, sessionId: input.session_id, transcriptPath: input.transcript_path, toolUseId: input.tool_use_id },
    parents: parents(), guard: { version: path.basename(path.dirname(fileURLToPath(import.meta.url))), policyDigest: policy.digest, policy: policy.digest === 'fallback' ? 'fallback' : 'file' } };
  // Bound the append in bytes as well as characters.
  while (Buffer.byteLength(JSON.stringify(row)) > 3900 && row.parents.length) row.parents.pop();
  if (Buffer.byteLength(JSON.stringify(row)) > 3900) { row.command = row.command.slice(0, 100); row.targets = row.targets.map(target => Object.fromEntries(Object.entries(target).map(([k, v]) => [k, String(v).slice(0, 240)]))); }
  if (Buffer.byteLength(JSON.stringify(row)) > 3900) {
    const clip = (value, bytes) => Buffer.from(String(value)).subarray(0, bytes).toString('utf8');
    row.cwd = clip(row.cwd, 512); row.command = clip(row.command, 250); row.tool = clip(row.tool, 80);
    row.targets = row.targets.map(target => Object.fromEntries(Object.entries(target).map(([key, value]) => [key, clip(value, key === 'kind' ? 120 : key === 'rule' ? 40 : 256)])));
    row.caller = Object.fromEntries(Object.entries(row.caller).filter(([, value]) => value !== undefined).map(([key, value]) => [key, clip(value, key === 'transcriptPath' ? 256 : 80)]));
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeSync(fd, JSON.stringify(row) + '\n'); } finally { fs.closeSync(fd); }
}
async function main() {
  const [mode, tool, ...rest] = process.argv.slice(2);
  if (mode === 'version') { console.log(VERSION, hash(fs.readFileSync(fileURLToPath(import.meta.url)))); return; }
  const policy = readPolicy(), launchOwn = process.env.LLV_DESTRUCTIVE_GUARD_OWN, own = (launchOwn ?? '').split(':').filter(Boolean);
  // A launch that named no working tree (an operator terminal) marks itself;
  // an account hook in a manual session has no launch environment at all.
  // Both own the project the session is working in, as the engine reports it.
  const sessionRoot = process.env.LLV_DESTRUCTIVE_GUARD_SESSION_ROOT === '1';
  const ownFor = (directory, manual) => {
    const root = sessionRoot || manual ? sessionOwnRoot(directory, policy) : null;
    return root && !own.includes(root) ? [...own, root] : own;
  };
  let input = {}, command = '', cwd = process.cwd();
  try {
    if (mode === 'hook') {
      let raw = ''; for await (const chunk of process.stdin) { raw += chunk; if (raw.length > 1024 * 1024) throw Error('oversized hook input'); }
      const payload = JSON.parse(raw);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw Error('invalid hook payload');
      if (payload.cwd !== undefined && typeof payload.cwd !== 'string') throw Error('invalid hook cwd');
      if (['session_id', 'transcript_path', 'tool_use_id'].some(key => payload[key] !== undefined && typeof payload[key] !== 'string')) throw Error('invalid hook caller');
      input = payload;
      cwd = input.cwd ?? cwd;
      const candidate = input.tool_input?.command ?? input.tool_input?.cmd;
      if (typeof candidate !== 'string') throw Error('invalid hook command');
      command = candidate;
      const refusal = inspectShell(command, { policy, own: ownFor(cwd, launchOwn === undefined), cwd });
      if (refusal) {
        try { journal('hook', input.tool_name ?? 'Bash', command, cwd, refusal, input); } catch (error) { console.error('Delegatus guard journal unavailable:', error.message); }
        console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: stopMessage(refusal, command) } }));
      }
    } else if (mode === 'check') {
      const args = rest[0] === '--' ? rest.slice(1) : rest; command = [tool, ...args].join(' ');
      const refusal = checkCommand(tool, args, { policy, own: ownFor(cwd, false), cwd });
      if (refusal) {
        try { journal('wrapper', tool, command, cwd, refusal); } catch (error) { console.error('Delegatus guard journal unavailable:', error.message); }
        console.error(stopMessage(refusal, command)); process.exitCode = 1;
      }
    } else throw Error('unknown guard mode');
  } catch (error) {
    try { journal('error', tool ?? 'Bash', command || error.message, cwd, null, input); } catch { /* reporting cannot stop a launch */ }
    console.error('Delegatus destructive guard error:', error.message);
  }
}
if (path.basename(fileURLToPath(import.meta.url)) === 'destructive-guard.mjs'
  && process.argv[1] && canonical(process.argv[1]) === canonical(fileURLToPath(import.meta.url))) {
  void main().catch(error => { console.error('Delegatus destructive guard error:', error.message); });
}
