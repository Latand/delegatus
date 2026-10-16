import { readAttribution } from "./readAttribution";
const before = readAttribution.snapshot(1);
if (process.argv[2] === "overflow") {
  for (let i = 0; i < 512; i++) readAttribution.sync(`fixture-${i}`, () => {}, i);
}
console.log(JSON.stringify({ before, after: readAttribution.snapshot(1) }));
