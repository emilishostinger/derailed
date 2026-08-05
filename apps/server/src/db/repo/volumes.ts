import { newId } from '../../util/ids.ts';
import { db } from '../index.ts';

export interface Volume {
  id: string;
  serviceId: string;
  /** The Docker volume name, stable across redeploys. That is the whole point. */
  name: string;
  containerPath: string;
  createdAt: number;
}

interface VolumeRow {
  id: string;
  service_id: string;
  name: string;
  container_path: string;
  created_at: number;
}

const toVolume = (row: VolumeRow): Volume => ({
  id: row.id,
  serviceId: row.service_id,
  name: row.name,
  containerPath: row.container_path,
  createdAt: row.created_at,
});

export function listVolumesFor(serviceId: string): Volume[] {
  return db()
    .query<VolumeRow, [string]>('SELECT * FROM volumes WHERE service_id = ? ORDER BY created_at')
    .all(serviceId)
    .map(toVolume);
}

export function findVolume(id: string): Volume | null {
  const row = db().query<VolumeRow, [string]>('SELECT * FROM volumes WHERE id = ?').get(id);
  return row ? toVolume(row) : null;
}

/** Docker volume names have to be unique across the host, so they carry the id. */
export function volumeNameFor(volumeId: string): string {
  return `derailed-data-${volumeId}`;
}

export function createVolume(serviceId: string, containerPath: string): Volume {
  const id = newId();
  db()
    .query(
      'INSERT INTO volumes (id, service_id, name, container_path, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(id, serviceId, volumeNameFor(id), containerPath, Date.now());
  return findVolume(id)!;
}

export function deleteVolume(id: string): void {
  db().query('DELETE FROM volumes WHERE id = ?').run(id);
}

/** name → path, in the shape `createContainer` wants. */
export function volumeMounts(serviceId: string): Record<string, string> {
  const mounts: Record<string, string> = {};
  for (const volume of listVolumesFor(serviceId)) mounts[volume.name] = volume.containerPath;
  return mounts;
}

/**
 * A path is only useful once. Two mounts at the same place would be ambiguous, and
 * Docker would silently pick one.
 */
export function pathInUse(serviceId: string, containerPath: string): boolean {
  return listVolumesFor(serviceId).some((volume) => volume.containerPath === containerPath);
}
