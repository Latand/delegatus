import { DurableObject, type DurableObjectState } from "cloudflare:workers";
import { StatsCore, type StatsSettings } from "./stats/store";

export { default } from "./worker";

export class StatsStore extends DurableObject<StatsSettings> {
  readonly #core: StatsCore;

  constructor(ctx: DurableObjectState, env: StatsSettings) {
    super(ctx, env);
    const storage = ctx.storage;
    const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual(a: BufferSource, b: BufferSource): boolean };
    this.#core = new StatsCore({
      exec: (sql, ...params) => storage.sql.exec(sql, ...params),
      transactionSync: action => storage.transactionSync(action),
      getAlarm: () => storage.getAlarm(),
      setAlarm: time => storage.setAlarm(time),
    }, env, (a, b) => subtle.timingSafeEqual(a, b));
    void ctx.blockConcurrencyWhile(() => this.#core.start());
  }

  enrollmentOptions(...args: Parameters<StatsCore["enrollmentOptions"]>) { return this.#core.enrollmentOptions(...args); }
  enroll(...args: Parameters<StatsCore["enroll"]>) { return this.#core.enroll(...args); }
  loginOptions() { return this.#core.loginOptions(); }
  login(...args: Parameters<StatsCore["login"]>) { return this.#core.login(...args); }
  session(...args: Parameters<StatsCore["session"]>) { return this.#core.session(...args); }
  snapshot(...args: Parameters<StatsCore["snapshot"]>) { return this.#core.snapshot(...args); }
  revoke(...args: Parameters<StatsCore["revoke"]>) { return this.#core.revoke(...args); }
  recordPing(...args: Parameters<StatsCore["recordPing"]>) { return this.#core.recordPing(...args); }
  recordEvent(...args: Parameters<StatsCore["recordEvent"]>) { return this.#core.recordEvent(...args); }
  alarm() { return this.#core.alarm(); }
}
