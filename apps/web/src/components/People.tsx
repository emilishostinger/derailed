import type { User, UserRole } from '@derailed/shared';
import { Trash2, UserPlus } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { endpoints } from '../api/endpoints.ts';
import { useToasts } from '../stores/toasts.ts';
import { ErrorNote, Field, Spinner } from './ui.tsx';

/**
 * Who else can get in.
 *
 * Three roles and no more. Every extra one is a permission matrix somebody has to hold
 * in their head, and the questions people actually ask are only ever "can they break
 * it?" and "can they see it?".
 */
const ROLES: { value: UserRole; label: string; hint: string }[] = [
  { value: 'owner', label: 'Owner', hint: 'Everything, including the server and who else is here' },
  { value: 'member', label: 'Member', hint: 'Runs the apps: deploy, logs, variables, backups' },
  { value: 'viewer', label: 'Viewer', hint: 'Can look at everything, and change nothing' },
];

function roleHint(role: UserRole): string {
  return ROLES.find((entry) => entry.value === role)?.hint ?? '';
}

export function People() {
  const [people, setPeople] = useState<User[]>([]);
  const [you, setYou] = useState('');
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(() => {
    endpoints
      .people()
      .then((result) => {
        setPeople(result.people);
        setYou(result.you);
      })
      .catch(setError)
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  if (loading) return <Spinner />;

  return (
    <div className="space-y-3">
      <ul className="space-y-2">
        {people.map((person) => (
          <PersonRow
            key={person.id}
            person={person}
            isYou={person.id === you}
            onChanged={load}
            onError={setError}
          />
        ))}
      </ul>

      {adding ? (
        <AddPerson
          onDone={() => {
            setAdding(false);
            load();
          }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <button type="button" className="btn-secondary" onClick={() => setAdding(true)}>
          <UserPlus className="h-3.5 w-3.5" />
          Add someone
        </button>
      )}

      <ErrorNote error={error} />
    </div>
  );
}

function PersonRow({
  person,
  isYou,
  onChanged,
  onError,
}: {
  person: User;
  isYou: boolean;
  onChanged: () => void;
  onError: (err: unknown) => void;
}) {
  const [busy, setBusy] = useState(false);
  const push = useToasts((s) => s.push);

  async function change(role: UserRole) {
    setBusy(true);
    onError(null);
    try {
      await endpoints.setPersonRole(person.id, role);
      push({ message: `${person.email} is now a ${role}.`, tone: 'ok' });
      onChanged();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    onError(null);
    try {
      await endpoints.removePerson(person.id);
      push({ message: `${person.email} no longer has access.`, tone: 'ok' });
      onChanged();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex items-center gap-3 rounded-lg border border-line p-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] text-ink">
          {person.email}
          {isYou && <span className="ml-2 text-[11px] text-ink-faint">you</span>}
        </p>
        <p className="mt-0.5 text-[11px] text-ink-faint">{roleHint(person.role)}</p>
      </div>

      {/* Your own row is fixed on purpose. Stepping down from the only owner account
          leaves a server nobody can administer, and that is not a thing to find out
          about after pressing a dropdown. */}
      <select
        className="input h-8 w-[7.5rem] text-[12px]"
        value={person.role}
        disabled={busy || isYou}
        title={isYou ? 'You cannot change your own access.' : undefined}
        onChange={(event) => void change(event.target.value as UserRole)}
      >
        {ROLES.map((role) => (
          <option key={role.value} value={role.value}>
            {role.label}
          </option>
        ))}
      </select>

      <button
        type="button"
        className="btn-ghost"
        disabled={busy || isYou}
        title={isYou ? 'You cannot remove your own account.' : `Remove ${person.email}`}
        onClick={() => void remove()}
      >
        {busy ? <Spinner /> : <Trash2 className="h-3.5 w-3.5" />}
      </button>
    </li>
  );
}

function AddPerson({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<UserRole>('member');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function add() {
    setBusy(true);
    setError(null);
    try {
      await endpoints.addPerson(email.trim(), password, role);
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-line p-4">
      <Field label="Their email address">
        <input
          className="input"
          value={email}
          placeholder="them@example.com"
          onChange={(event) => setEmail(event.target.value)}
        />
      </Field>

      <Field
        label="A password to start with"
        hint="There is no invitation email, because this server may have no way to send one. Pass this on however you already talk to them, and they can change it once they are in."
      >
        <input
          className="input"
          type="password"
          value={password}
          autoComplete="new-password"
          onChange={(event) => setPassword(event.target.value)}
        />
      </Field>

      <div>
        <p className="eyebrow mb-1.5">What they can do</p>
        <div className="space-y-1.5">
          {ROLES.map((entry) => (
            <label key={entry.value} className="flex cursor-pointer items-start gap-2">
              <input
                type="radio"
                name="new-person-role"
                className="mt-1"
                checked={role === entry.value}
                onChange={() => setRole(entry.value)}
              />
              <span>
                <span className="block text-[13px] text-ink">{entry.label}</span>
                <span className="block text-[11px] text-ink-faint">{entry.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <ErrorNote error={error} />

      <div className="flex gap-2">
        <button
          type="button"
          className="btn-primary"
          disabled={busy || !email.trim() || !password}
          onClick={() => void add()}
        >
          {busy && <Spinner />}
          Add them
        </button>
        <button type="button" className="btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
