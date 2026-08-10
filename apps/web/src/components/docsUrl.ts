/**
 * Where this app's own documentation lives, derived rather than stored: the
 * repository page for repo apps, the registry page for image apps. A guess is
 * only returned when it's a good one; a private registry gets no link rather
 * than a broken one.
 */
export function docsUrlFor(service: {
  repoUrl?: string | null;
  image?: string | null;
}): string | null {
  if (service.repoUrl) {
    const url = service.repoUrl.replace(/\.git$/, '');
    return url.startsWith('http') ? url : `https://${url}`;
  }

  const image = service.image;
  if (!image) return null;
  let repo = image.split('@')[0]?.split(':')[0] ?? '';
  repo = repo.replace(/^docker\.io\//, '');

  if (repo.startsWith('ghcr.io/')) {
    const [owner, name] = repo.slice('ghcr.io/'.length).split('/');
    return owner && name ? `https://github.com/${owner}/${name}` : null;
  }
  // Some other registry: quay.io, a private one. No page worth guessing at.
  if (repo.split('/')[0]?.includes('.')) return null;

  const parts = repo.replace(/^library\//, '').split('/');
  if (parts.length === 1 && parts[0]) return `https://hub.docker.com/_/${parts[0]}`;
  if (parts.length === 2) return `https://hub.docker.com/r/${parts[0]}/${parts[1]}`;
  return null;
}
