import type { DnsStatus, Domain, DomainKind, TlsStatus } from '@derailed/shared';
import { newId } from '../../util/ids.ts';
import { db } from '../index.ts';

interface DomainRow {
  id: string;
  service_id: string | null;
  hostname: string;
  kind: DomainKind;
  dns_status: DnsStatus;
  tls_status: TlsStatus;
  last_checked_at: number | null;
  created_at: number;
  redirect_to?: string | null;
}

const toDomain = (row: DomainRow): Domain => ({
  id: row.id,
  serviceId: row.service_id,
  hostname: row.hostname,
  kind: row.kind,
  dnsStatus: row.dns_status,
  tlsStatus: row.tls_status,
  lastCheckedAt: row.last_checked_at,
  createdAt: row.created_at,
  redirectTo: row.redirect_to ?? null,
});

/**
 * Makes one name redirect to another, or stops it.
 *
 * A pair is example.com and www.example.com: the same site, one canonical address,
 * the other sending people to it. Two separate rows with no relationship is how you
 * end up with a site that answers on both and agrees with neither.
 */
export function setRedirect(id: string, targetDomainId: string | null): Domain | null {
  db().query('UPDATE domains SET redirect_to = ? WHERE id = ?').run(targetDomainId, id);
  return findDomain(id);
}

export function listDomains(serviceId: string): Domain[] {
  return db()
    .query<DomainRow, [string]>('SELECT * FROM domains WHERE service_id = ? ORDER BY created_at')
    .all(serviceId)
    .map(toDomain);
}

export function allDomains(): Domain[] {
  return db().query<DomainRow, []>('SELECT * FROM domains').all().map(toDomain);
}

export function findDomain(id: string): Domain | null {
  const row = db().query<DomainRow, [string]>('SELECT * FROM domains WHERE id = ?').get(id);
  return row ? toDomain(row) : null;
}

export function findDomainByHostname(hostname: string): Domain | null {
  const row = db()
    .query<DomainRow, [string]>('SELECT * FROM domains WHERE hostname = ?')
    .get(hostname.toLowerCase());
  return row ? toDomain(row) : null;
}

export function createDomain(
  serviceId: string | null,
  hostname: string,
  kind: DomainKind,
  dnsStatus: DnsStatus = 'unchecked',
  tlsStatus: TlsStatus = 'pending',
): Domain {
  const id = newId();
  db()
    .query(
      `INSERT INTO domains (id, service_id, hostname, kind, dns_status, tls_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, serviceId, hostname.toLowerCase(), kind, dnsStatus, tlsStatus, Date.now());
  return findDomain(id)!;
}

export function updateDomainStatus(
  id: string,
  patch: { dnsStatus?: DnsStatus; tlsStatus?: TlsStatus; checked?: boolean },
): Domain | null {
  const assignments: string[] = [];
  const values: (string | number)[] = [];
  if (patch.dnsStatus) {
    assignments.push('dns_status = ?');
    values.push(patch.dnsStatus);
  }
  if (patch.tlsStatus) {
    assignments.push('tls_status = ?');
    values.push(patch.tlsStatus);
  }
  if (patch.checked) {
    assignments.push('last_checked_at = ?');
    values.push(Date.now());
  }
  if (!assignments.length) return findDomain(id);
  db()
    .query(`UPDATE domains SET ${assignments.join(', ')} WHERE id = ?`)
    .run(...values, id);
  return findDomain(id);
}

/** Points a domain at an app, or at nothing. */
export function attachDomain(id: string, serviceId: string | null): Domain | null {
  db().query('UPDATE domains SET service_id = ? WHERE id = ?').run(serviceId, id);
  return findDomain(id);
}

export function unattachedDomains(): Domain[] {
  return db()
    .query<DomainRow, []>('SELECT * FROM domains WHERE service_id IS NULL ORDER BY created_at')
    .all()
    .map(toDomain);
}

/**
 * Removes the addresses Derailed made for a service, keeping the ones you own.
 *
 * A generated address is part of the app and means nothing without it. A domain you
 * added is yours: it goes back to the pool, ready for whatever you point at it next.
 */
export function releaseDomainsFor(serviceId: string): void {
  db().query("DELETE FROM domains WHERE service_id = ? AND kind = 'generated'").run(serviceId);
  db().query('UPDATE domains SET service_id = NULL WHERE service_id = ?').run(serviceId);
}

export function deleteDomain(id: string): void {
  db().query('DELETE FROM domains WHERE id = ?').run(id);
}
