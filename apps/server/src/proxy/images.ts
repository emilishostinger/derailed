import { caddy as caddyConfig } from '../config.ts';
import { listProjects } from '../db/repo/projects.ts';
import { listServices } from '../db/repo/services.ts';
import {
  connectToNetwork,
  createContainer,
  findContainerByName,
  startContainer,
} from '../docker/containers.ts';
import { imageExists, pullImage } from '../docker/images.ts';
import { managedLabels } from '../docker/labels.ts';
import { projectNetworkName } from '../docker/networks.ts';

/**
 * Pictures the right size.
 *
 * `/_img/photo.jpg?w=800` comes back resized and re-encoded, WebP for browsers
 * that take it, without the picture's owner learning what WebP is. The work is
 * done by one imgproxy sidecar (libvips underneath): Caddy rewrites the request
 * and dials the sidecar, the sidecar fetches the original from the app's own
 * container over the project network, and nothing new is exposed to the internet.
 * Long-lived Cache-Control headers mean each visitor's browser does the caching,
 * so the same picture is resized once per person, not once per view.
 */

export const IMAGES_CONTAINER = 'derailed-images';
/** Pinned to a major, like Caddy: v3 is years-stable and the options below are its. */
export const IMAGES_IMAGE = process.env.DERAILED_IMGPROXY_IMAGE ?? 'darthsim/imgproxy:v3';
export const IMAGES_PORT = 8080;

/** Whether any app on the server has the switch on. */
export function anyImagesEnabled(): boolean {
  return listServices().some((service) => service.kind === 'app' && service.imgResize);
}

/**
 * Starts (or adopts) the sidecar and attaches it to every project network that
 * needs it. Idempotent, cheap when nothing changed, called from the toggle and
 * from boot.
 */
export async function ensureImagesSidecar(): Promise<void> {
  if (!anyImagesEnabled()) return;

  let existing = await findContainerByName(IMAGES_CONTAINER);
  if (!existing) {
    if (!(await imageExists(IMAGES_IMAGE))) await pullImage(IMAGES_IMAGE);
    await createContainer({
      name: IMAGES_CONTAINER,
      image: IMAGES_IMAGE,
      env: {
        IMGPROXY_BIND: `:${IMAGES_PORT}`,
        // WebP for browsers that say they take it, originals for the rest.
        IMGPROXY_ENABLE_WEBP_DETECTION: 'true',
        // A year: a resized picture at a URL is immutable in practice, and the
        // browser doing the caching is what keeps the sidecar idle.
        IMGPROXY_TTL: '31536000',
        // The only sources it will fetch are Derailed-managed containers, whose
        // names all begin d_. A crafted request cannot walk the sidecar to the
        // cloud metadata address or a neighbour's port: not a URL shape it takes.
        IMGPROXY_ALLOWED_SOURCES: 'http://d_',
        // Refuses absurd sources before decoding them; a 50-megapixel original
        // is a memory spike wearing a beach photo's name.
        IMGPROXY_MAX_SRC_RESOLUTION: '50',
      },
      labels: managedLabels({ role: 'images' }),
      // Caddy's own network, so Caddy can dial it by name. No published ports:
      // the internet reaches it through Caddy or not at all.
      network: caddyConfig.network,
      ports: {},
      volumes: {},
    });
    existing = await findContainerByName(IMAGES_CONTAINER);
  }
  if (existing && existing.State !== 'running') {
    await startContainer(existing.Id);
  }

  // The sidecar fetches originals from app containers, which live on their
  // project's network. Attach wherever the switch is on; already-attached is a
  // cheap no-op error swallowed inside connectToNetwork's caller.
  const projects = listProjects();
  for (const service of listServices()) {
    if (service.kind !== 'app' || !service.imgResize) continue;
    const project = projects.find((entry) => entry.id === service.projectId);
    if (!project) continue;
    const container = await findContainerByName(IMAGES_CONTAINER);
    if (!container) return;
    await connectToNetwork(container.Id, projectNetworkName(service.projectId)).catch(
      () => undefined,
    );
  }
}
