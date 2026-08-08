import type { SshState } from '@derailed/shared';
import { KeyRound, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { endpoints } from '../api/endpoints.ts';
import { useSession } from '../stores/session.ts';
import { ErrorNote, Spinner, Switch } from './ui.tsx';

/**
 * The server's door keys, and the toggle that matters.
 *
 * Turning off password login is the single highest-value hardening act on a VPS,
 * and the reason almost nobody does it is fear of the lockout. So the switch
 * carries its one honest guard (no keys, no switch) and its one honest warning:
 * prove a key works before you turn the handle.
 */
export function SshPanel() {
  const role = useSession((s) => s.user?.role);
  const [state, setState] = useState<SshState | null>(null);
  const [pasted, setPasted] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    endpoints
      .ssh()
      .then(setState)
      .catch(() => undefined);
  }, []);

  if (!state) return null;
  if (!state.available) {
    return (
      <div className="card flex items-center gap-3 p-4">
        <KeyRound className="h-4 w-4 shrink-0 text-ink-faint" />
        <p className="text-[13px] text-ink-muted">
          This machine has no SSH server Derailed can see, so there is nothing to manage here.
        </p>
      </div>
    );
  }

  const owner = role === 'owner';

  async function add() {
    setBusy(true);
    setError(null);
    try {
      const result = await endpoints.addSshKey(pasted.trim());
      setState((current) => (current ? { ...current, keys: result.keys } : current));
      setPasted('');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function remove(fingerprint: string) {
    setError(null);
    try {
      const result = await endpoints.removeSshKey(fingerprint);
      setState((current) => (current ? { ...current, keys: result.keys } : current));
    } catch (err) {
      setError(err);
    }
  }

  async function setPasswords(enabled: boolean) {
    setBusy(true);
    setError(null);
    try {
      const result = await endpoints.setPasswordLogin(enabled);
      setState((current) =>
        current ? { ...current, passwordLogin: result.passwordLogin } : current,
      );
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="card divide-y divide-line">
        {state.keys.length === 0 && (
          <p className="p-4 text-[13px] text-ink-muted">
            No keys yet. Anyone signing in to this machine is typing a password, which is exactly
            what the internet has been guessing at since the machine went online.
          </p>
        )}
        {state.keys.map((key) => (
          <div key={key.fingerprint} className="flex items-center gap-3 p-3.5">
            <KeyRound className="h-4 w-4 shrink-0 text-ink-faint" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] text-ink">{key.comment ?? key.type}</p>
              <p className="truncate font-mono text-[11px] text-ink-faint">
                {key.type} · {key.fingerprint}
              </p>
            </div>
            {owner && (
              <button
                type="button"
                className="btn-ghost shrink-0 text-danger"
                title="Remove this key"
                onClick={() => void remove(key.fingerprint)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        ))}
      </div>

      {owner && (
        <div className="flex gap-2">
          <input
            className="input min-w-0 flex-1 font-mono text-[12px]"
            placeholder="ssh-ed25519 AAAA… you@laptop  (the .pub file, one line)"
            value={pasted}
            onChange={(event) => setPasted(event.target.value)}
          />
          <button
            type="button"
            className="btn-secondary shrink-0"
            disabled={busy || !pasted.trim()}
            onClick={() => void add()}
          >
            {busy ? <Spinner /> : <Plus className="h-3.5 w-3.5" />}
            Add key
          </button>
        </div>
      )}

      <div className="card flex items-start gap-3 p-4">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-ink">Password login</p>
          <p className="mt-0.5 text-[12px] text-ink-muted">
            {state.passwordLogin === 'off'
              ? 'Off. Only the keys above can open this machine, and the dictionary knocking at port 22 is wasting its time.'
              : 'On. Anyone who guesses the password is in. Turning this off is the single most valuable hardening step on a server, once a key above provably works.'}
          </p>
          {state.passwordLogin === 'on' && (
            <p className="mt-1 text-[12px] text-warn">
              Before turning it off: open a second terminal and check `ssh` gets in without asking
              for a password. Keep this tab open until it does.
            </p>
          )}
        </div>
        {owner && (
          <Switch
            checked={state.passwordLogin === 'off'}
            disabled={busy || state.passwordLogin === 'unknown'}
            onChange={(on) => void setPasswords(!on)}
            label="Keys only"
          />
        )}
      </div>
      <ErrorNote error={error} />
    </div>
  );
}
