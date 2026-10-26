/** Operator credentials stay out of agent processes and native CLI probes. */
export const OPERATOR_CREDENTIAL_ENV = ["LLV_TOKEN", "DELEGATUS_TOKEN", "LLV_OPERATOR_TOKEN", "DELEGATUS_OPERATOR_TOKEN"] as const;

export function withoutOperatorCredentials(source: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  const environment = { ...source };
  for (const name of OPERATOR_CREDENTIAL_ENV) delete environment[name];
  return environment;
}
