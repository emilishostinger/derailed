/**
 * Docker can't tell us *why* a container stopped. A container we stopped on purpose
 * exits 143 (SIGTERM) or 137 (SIGKILL), indistinguishable from a real crash by exit
 * code alone. So we record the intent just before asking Docker to stop something,
 * and the monitor consults it when the `die` event arrives.
 *
 * Entries expire on their own: if the stop never happens, we must not swallow a later
 * genuine crash of the same container.
 */
const INTENT_TTL_MS = 60_000;

const intended = new Map<string, number>();

export function markIntentionalStop(containerId: string): void {
  if (!containerId) return;
  intended.set(containerId, Date.now() + INTENT_TTL_MS);
  prune();
}

/** True if we asked for this stop. Consumes the marker. */
export function consumeIntentionalStop(containerId: string): boolean {
  const expiresAt = intended.get(containerId);
  if (expiresAt === undefined) return false;
  intended.delete(containerId);
  return expiresAt > Date.now();
}

export function clearIntents(): void {
  intended.clear();
}

function prune(): void {
  if (intended.size < 64) return;
  const now = Date.now();
  for (const [id, expiresAt] of intended) {
    if (expiresAt <= now) intended.delete(id);
  }
}
