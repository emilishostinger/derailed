import type { CostComparison, CostElsewhere } from '@derailed/shared';
import { listProjects } from '../db/repo/projects.ts';
import { listServices } from '../db/repo/services.ts';
import { listVolumesFor } from '../db/repo/volumes.ts';

/**
 * What this would cost somewhere else.
 *
 * A party trick, and a useful one. The value of a self-hosted server is invisible:
 * nothing arrives every month to remind you it is worth having. Adding up what is
 * actually running and pricing it against the places people would otherwise put it
 * makes that value legible, and it is exactly the number people screenshot.
 *
 * Every figure below is a published list price, and the estimate is deliberately
 * conservative: the cheapest plan that could hold what is running, no bandwidth
 * overages, no support tier, nothing invented. A number that flatters itself is worth
 * nothing, because the first person to check it stops believing the rest of the app.
 */

/**
 * Published list prices, in US dollars per month, as of early 2026.
 *
 * Kept as data with a date on it rather than pulled from anywhere: prices move, and a
 * server phoning a pricing API to draw a fun number would be an outbound request
 * nobody asked for and a promise in the FAQ broken.
 */
export const PRICES_CHECKED = '2026-02';

interface Provider {
  name: string;
  /** What you pay before running anything at all. */
  base: number;
  /** Per always-on web service. */
  perApp: number;
  /** Per managed database, cheapest plan that is not a free trial. */
  perDatabase: number;
  /** Per GB of persistent disk. */
  perStorageGb: number;
  note?: string;
}

const PROVIDERS: Provider[] = [
  {
    name: 'Vercel',
    base: 20,
    perApp: 0,
    // Vercel has no database of its own worth pricing here; the usual pairing is a
    // managed Postgres from a marketplace partner, at roughly this.
    perDatabase: 25,
    perStorageGb: 0.15,
    note: 'Pro, plus a managed database alongside it',
  },
  {
    name: 'Railway',
    base: 20,
    perApp: 5,
    perDatabase: 10,
    perStorageGb: 0.25,
    note: 'Pro, plus usage',
  },
  {
    name: 'Render',
    base: 0,
    perApp: 7,
    perDatabase: 19,
    perStorageGb: 0.25,
    note: 'Starter instances, smallest paid database',
  },
  {
    name: 'Heroku',
    base: 0,
    perApp: 7,
    perDatabase: 9,
    perStorageGb: 0,
    note: 'Basic dynos and Essential Postgres',
  },
  {
    name: 'DigitalOcean App Platform',
    base: 0,
    perApp: 5,
    perDatabase: 15,
    perStorageGb: 0.1,
    note: 'Basic apps, smallest managed database',
  },
];

/** Rounded up, because a fraction of a gigabyte still costs a gigabyte. */
function storageGb(): number {
  let volumes = 0;
  for (const service of listServices()) volumes += listVolumesFor(service.id).length;
  // Derailed does not measure how full a volume is, and a guess dressed up as a
  // measurement is worse than a stated assumption. One gigabyte apiece is the
  // smallest anyone sells.
  return volumes;
}

export function costComparison(): CostComparison {
  const services = listServices();
  const apps = services.filter((service) => service.kind === 'app').length;
  const databases = services.filter((service) => service.kind === 'database').length;
  const storage = storageGb();

  const elsewhere: CostElsewhere[] = PROVIDERS.map((provider) => ({
    name: provider.name,
    monthly: Math.round(
      provider.base +
        apps * provider.perApp +
        databases * provider.perDatabase +
        storage * provider.perStorageGb,
    ),
    note: provider.note ?? null,
  })).sort((a, b) => a.monthly - b.monthly);

  const cheapest = elsewhere[0]?.monthly ?? 0;
  const dearest = elsewhere[elsewhere.length - 1]?.monthly ?? 0;

  return {
    apps,
    databases,
    projects: listProjects().length,
    storageGb: storage,
    elsewhere,
    cheapestMonthly: cheapest,
    dearestMonthly: dearest,
    pricesCheckedAt: PRICES_CHECKED,
    summary: summaryFor(apps, databases, cheapest, dearest),
  };
}

function summaryFor(apps: number, databases: number, cheapest: number, dearest: number): string {
  if (apps === 0 && databases === 0) {
    return 'Nothing running yet. Deploy something and this will say what it would have cost elsewhere.';
  }
  const what = [
    apps ? `${apps} app${apps === 1 ? '' : 's'}` : null,
    databases ? `${databases} database${databases === 1 ? '' : 's'}` : null,
  ]
    .filter(Boolean)
    .join(' and ');

  if (cheapest === dearest) return `${what}, which would be about $${cheapest} a month elsewhere.`;
  return `${what}, which would be $${cheapest} to $${dearest} a month elsewhere.`;
}
