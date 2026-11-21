import { deliveryPullRequestRepository, githubRepositoryOfRemote } from "./workLinks";

export type LandingIdentity = {
  prRepository?: string | null;
  prNumber?: number | null;
  headRepository?: string | null;
  branch?: string | null;
};

export function deliveryLandingIdentity(target: { remote: string; prRepository?: string; pr?: number; branch: string }): LandingIdentity {
  return { prRepository: deliveryPullRequestRepository(target), prNumber: target.pr,
    headRepository: githubRepositoryOfRemote(target.remote), branch: target.branch };
}

export function landingKeys(identity: LandingIdentity): string[] {
  const keys: string[] = [];
  if (identity.prRepository && identity.prNumber) keys.push(`pr:${identity.prRepository.toLowerCase()}#${identity.prNumber}`);
  if (identity.headRepository && identity.branch) keys.push(`ref:${identity.headRepository.toLowerCase()}:${identity.branch}`);
  return keys;
}
