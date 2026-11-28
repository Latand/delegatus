import { base64url, hex, randomBytes, sha256 } from "../stats/webauthn";

const token = randomBytes(32);
const expires = Math.floor(Date.now() / 1000) + 86_400;
const enrollment = ["v1", expires, hex(await sha256(token))].join(".");
const put = Bun.spawn(["bunx", "wrangler", "secret", "put", "STATS_ENROLLMENT", "--config", "landing/wrangler.jsonc"], {
  stdin: new Blob([enrollment]), stdout: "ignore", stderr: "ignore",
});
if (await put.exited !== 0) {
  console.error("Could not set STATS_ENROLLMENT.");
  process.exit(1);
}
console.log(`https://delegatus.org/stats/enroll#${base64url(token)}`);
