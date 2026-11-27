declare module "cloudflare:workers" {
  export abstract class DurableObject<Env> {
    protected readonly ctx: DurableObjectState;
    protected readonly env: Env;
    constructor(ctx: DurableObjectState, env: Env);
  }

  export interface DurableObjectState {
    storage: {
      sql: Pick<import("./stats/store").StatsStorage, "exec">;
    } & Omit<import("./stats/store").StatsStorage, "exec">;
    blockConcurrencyWhile<T>(initialize: () => Promise<T>): Promise<T>;
  }

  export interface DurableObjectId {
    toString(): string;
    equals(other: DurableObjectId): boolean;
  }
}
