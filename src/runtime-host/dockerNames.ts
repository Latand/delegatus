/* The Docker names that carry the product's name (docs/design/rename-delegatus.md
   §6.6). The runtime host that performs a deploy runs the previous release, so
   the switch to `delegatus` takes two releases: this one names everything the
   old way and recognizes both spellings, and the next one switches the names.

   Rollback, cleanup and succession find their targets by the identity they
   recorded (a release record, a rollback target, a handoff intent, a
   container id), by the `dev.live-log-viewer.*` labels and by the fence
   owner's pid, so none of them depends on a spelling. What depends on one is
   collected here: the names new artifacts get, and the few places that pick
   product containers out of `docker ps` by name. */

export interface DockerNameSpelling {
  /** Image repository, before the `:tag`. */
  imageRepository: string;
  /** Runtime-host generation containers: `<prefix><revision>-<generation>`. */
  runtimeHostPrefix: string;
  /** Viewer candidate and release containers: `<prefix><key>`. */
  viewerDeployPrefix: string;
  /** Every container the product starts begins with this. */
  containerPrefix: string;
}

/** The names every release before the rename used. */
export const LEGACY_DOCKER_NAMES: DockerNameSpelling = Object.freeze({
  imageRepository: "agent-log-viewer",
  runtimeHostPrefix: "llv-runtime-host-",
  viewerDeployPrefix: "llv-deploy-",
  containerPrefix: "llv-",
});

/** The names the next release switches to. */
export const DELEGATUS_DOCKER_NAMES: DockerNameSpelling = Object.freeze({
  imageRepository: "delegatus",
  runtimeHostPrefix: "delegatus-runtime-host-",
  viewerDeployPrefix: "delegatus-deploy-",
  containerPrefix: "delegatus-",
});

/** What this release names the images and containers it creates. */
export const DOCKER_NAMES: DockerNameSpelling = LEGACY_DOCKER_NAMES;

/** Every spelling this release recognizes, the one it writes first. */
export const RECOGNIZED_DOCKER_NAMES: readonly DockerNameSpelling[] = Object.freeze([
  LEGACY_DOCKER_NAMES,
  DELEGATUS_DOCKER_NAMES,
]);

/** The compose service tag the runtime-host service runs. */
export function runtimeHostServiceImageTag(names: DockerNameSpelling = DOCKER_NAMES): string {
  return `${names.imageRepository}:node22`;
}

/** Whether a container is one the product started, under either name. */
export function isProductContainer(name: string): boolean {
  const bare = name.replace(/^\//, "");
  return RECOGNIZED_DOCKER_NAMES.some((names) => bare.startsWith(names.containerPrefix));
}
