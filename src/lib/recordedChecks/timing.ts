// Standalone gate observations, including foreground checks without custody.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";

const span = z.object({ start: z.number().finite(), end: z.number().finite() }).strict().refine(value => value.end >= value.start);
export const checkTimingSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/), queue: z.array(span).max(256), runners: z.array(span).max(256),
}).strict();
export type CheckTiming = z.infer<typeof checkTimingSchema>;
const clockSchema = z.object({ start: z.number().finite(), end: z.number().finite().nullable(), owner: z.string() }).strict();
const direct = (directory: string, identity: string) => {
  const stat = fs.lstatSync(directory);
  return stat.isDirectory() && !stat.isSymbolicLink() && fs.realpathSync(directory) === directory && `${stat.dev}:${stat.ino}` === identity;
};
function smallJson(filename: string): unknown {
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 65536 || stat.nlink !== 1) throw new Error("invalid timing observation");
    return JSON.parse(fs.readFileSync(fd, "utf8"));
  } finally { fs.closeSync(fd); }
}

/** Observation failures never change the command or its exit receipt. */
export function observeCheckProducer(kind: string, execution: { executionStartedAt?: number; executionEndedAt?: number }, owner: string, env = process.env): void {
  try {
    if (!["namespace", "portable", "service"].includes(kind) || !/^[a-f0-9]{64}$/.test(owner)) return;
    const { executionStartedAt: start, executionEndedAt: end } = execution;
    if (start === undefined || end === undefined || !Number.isFinite(start) || !Number.isFinite(end) || end < start) return;
    const directory = env.LLV_GATE_TIMING_DIRECTORY, identity = env.LLV_GATE_TIMING_DIRECTORY_IDENTITY;
    if (!directory || !identity || !direct(directory, identity)) return;
    const filename = path.join(directory, `clock-${kind}-${owner}.json`);
    const value = { start, end, owner };
    if (!direct(directory, identity)) return;
    fs.writeFileSync(`${filename}.next`, JSON.stringify(value), { mode: 0o600 }); fs.renameSync(`${filename}.next`, filename);
  } catch { /* An unavailable clock leaves time unknown. */ }
}

export function retainForegroundCheckTiming(directory: string, queue: { start: number; end: number }[] = [], env = process.env): void {
  try {
    const root = env.LLV_ATTEMPT_TIMING_ROOT, identity = env.LLV_ATTEMPT_TIMING_ROOT_IDENTITY;
    if (!root || !identity || !direct(root, identity) || !directory.startsWith(root + path.sep)) return;
    const runners: CheckTiming["runners"] = [];
    for (const name of fs.readdirSync(directory).filter(name => /^clock-(namespace|portable|service)-[a-f0-9]{64}\.json$/.test(name)).sort().slice(0, 256)) {
      try {
        const clock = clockSchema.parse(smallJson(path.join(directory, name)));
        if (clock.end !== null) runners.push(span.parse({ start: clock.start, end: clock.end }));
      } catch { /* An unfinished producer has no closed interval. */ }
    }
    const stat = fs.lstatSync(directory);
    const id = createHash("sha256").update(`${directory}:${stat.dev}:${stat.ino}`).digest("hex");
    const record = checkTimingSchema.parse({ id, queue, runners });
    const destination = path.join(root, "accounting-checks");
    fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
    const observed = fs.lstatSync(destination);
    if (observed.isSymbolicLink() || fs.realpathSync(destination) !== destination || !direct(root, identity)) return;
    const filename = path.join(destination, `${id}.json`);
    const fd = fs.openSync(filename, "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch { /* Missing or replaced evidence is never estimated. */ }
}

export function foregroundCheckTiming(directory: string, identity: string): CheckTiming[] {
  try {
    if (!direct(directory, identity)) return [];
    const source = path.join(directory, "accounting-checks");
    if (fs.realpathSync(source) !== source || fs.lstatSync(source).isSymbolicLink()) return [];
    const rows = fs.readdirSync(source).filter(file => /^[a-f0-9]{64}\.json$/.test(file)).sort().slice(0, 256).flatMap(file => {
      try { return [checkTimingSchema.parse(smallJson(path.join(source, file)))]; } catch { return []; }
    });
    return direct(directory, identity) ? rows : [];
  } catch { return []; }
}
