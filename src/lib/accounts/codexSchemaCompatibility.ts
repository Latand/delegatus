/* Is an unreviewed Codex app-server schema an additive extension of a pinned
 * one? Every payload valid under the pin must stay valid, and every reply
 * shape the adapter reads must keep its fields. Allowed: new definitions,
 * new optional properties, new enum values and new union variants. A new
 * server-request method is refused: Codex can hold a turn on a request the
 * adapter was never reviewed to answer. Everything else counts as a break.
 * Pure over parsed JSON; reports paths only, never schema values. */

type Json = unknown;
type Row = Record<string, Json>;
const ANNOTATIONS = new Set(["description", "title"]);
const MAX_BREAKS = 3;

function isRow(value: Json): value is Row {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The generator nests v2 definitions one level down; validation flattens them the same way. */
function definitions(bundle: Json): Row {
  const source = isRow(bundle) && isRow(bundle.definitions) ? bundle.definitions : {};
  return Object.fromEntries(Object.entries(source).flatMap(([name, value]) =>
    name === "v2" && isRow(value) ? Object.entries(value).map(([child, row]) => [`v2.${child}`, row]) : [[name, value]]));
}

/* Annotation keywords are ignored only where a key is a schema keyword: a
 * property literally named `title` inside `properties` still counts, and so
 * do the values listed by `enum`, `const` or `default`. */
const MAPS = new Set(["properties", "definitions", "patternProperties", "$defs"]);
const VALUES = new Set(["enum", "const", "default", "examples", "required"]);
type Position = "schema" | "map" | "value";

function equal(left: Json, right: Json, position: Position = "schema"): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => equal(item, right[index], position === "value" ? "value" : "schema"));
  }
  if (!isRow(left) || !isRow(right)) return false;
  const keys = (row: Row) => Object.keys(row).filter(key => position !== "schema" || !ANNOTATIONS.has(key));
  const leftKeys = keys(left), rightKeys = keys(right);
  const child = (key: string): Position => position === "value" ? "value" : position === "map" ? "schema" : MAPS.has(key) ? "map" : VALUES.has(key) ? "value" : "schema";
  return leftKeys.length === rightKeys.length && leftKeys.every(key => Object.prototype.hasOwnProperty.call(right, key) && equal(left[key], right[key], child(key)));
}

/** Single-value enum properties name a variant: `method`, `type`, `kind`. */
function discriminator(variant: Json): string | null {
  if (!isRow(variant) || !isRow(variant.properties)) return null;
  const tags = Object.entries(variant.properties).flatMap(([name, shape]) =>
    isRow(shape) && Array.isArray(shape.enum) && shape.enum.length === 1 ? [`${name}=${JSON.stringify(shape.enum[0])}`] : []);
  return tags.length ? tags.sort().join("&") : null;
}

function types(value: Json): string {
  return JSON.stringify((Array.isArray(value) ? [...value] : [value]).sort());
}

export function codexSchemaBreaks(pinned: Json, candidate: Json): string[] {
  const breaks: string[] = [];
  const report = (path: string, reason: string) => { if (breaks.length < MAX_BREAKS) breaks.push(`${path}: ${reason}`); };
  const compare = (before: Json, after: Json, path: string, newVariants?: (tags: string) => void) => {
    if (breaks.length >= MAX_BREAKS || equal(before, after)) return;
    if (!isRow(before) || !isRow(after)) return report(path, "changed");
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (ANNOTATIONS.has(key)) continue;
      const left = before[key], right = after[key];
      if (key === "properties" && isRow(left) && isRow(right)) {
        for (const [name, shape] of Object.entries(left)) {
          if (!Object.prototype.hasOwnProperty.call(right, name)) report(`${path}.${name}`, "removed");
          else compare(shape, right[name], `${path}.${name}`);
        }
        // Added properties are additive unless `required` names them below.
      } else if (key === "properties" && isRow(right) && left === undefined) {
        // A closed shape gaining properties is still additive when nothing became required.
      } else if (key === "required") {
        const was = new Set(Array.isArray(left) ? left : []), now = new Set(Array.isArray(right) ? right : []);
        for (const name of now) if (!was.has(name)) report(`${path}.${String(name)}`, "became required");
        for (const name of was) if (!now.has(name)) report(`${path}.${String(name)}`, "became optional");
      } else if (key === "enum" && Array.isArray(left) && Array.isArray(right)) {
        for (const value of left) if (!right.some(item => equal(item, value, "value"))) report(path, "enum value removed");
      } else if ((key === "oneOf" || key === "anyOf") && Array.isArray(left) && Array.isArray(right)) {
        const unmatched = new Set(right.map((_, index) => index));
        for (const variant of left) {
          const exact = right.findIndex((candidate, index) => unmatched.has(index) && equal(variant, candidate));
          const tag = discriminator(variant);
          const tagged = exact >= 0 ? exact : tag ? right.findIndex((candidate, index) => unmatched.has(index) && discriminator(candidate) === tag) : -1;
          if (tagged < 0) { report(`${path}.${key}`, `variant ${tag ?? "untagged"} removed or changed`); continue; }
          unmatched.delete(tagged);
          compare(variant, right[tagged], `${path}.${key}[${tag ?? tagged}]`);
        }
        for (const index of unmatched) newVariants?.(discriminator(right[index]) ?? "untagged");
      } else if (key === "type") {
        if (types(left) !== types(right)) report(path, "type changed");
      } else if (key === "items" || key === "additionalProperties") {
        if (isRow(left) && isRow(right)) compare(left, right, `${path}.${key}`);
        else if (!equal(left, right, "schema")) report(`${path}.${key}`, "changed");
      } else if (!equal(left, right, MAPS.has(key) ? "map" : VALUES.has(key) ? "value" : "schema")) {
        report(`${path}.${key}`, left === undefined ? "added" : right === undefined ? "removed" : "changed");
      }
    }
  };
  const before = definitions(pinned), after = definitions(candidate);
  for (const [name, shape] of Object.entries(before)) {
    if (breaks.length >= MAX_BREAKS) break;
    if (!Object.prototype.hasOwnProperty.call(after, name)) { report(name, "definition removed"); continue; }
    compare(shape, after[name], name, name === "ServerRequest" ? tags => report(name, `new server request ${tags}`) : undefined);
  }
  return breaks;
}
