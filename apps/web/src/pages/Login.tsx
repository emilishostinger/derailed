import { type FormEvent, useState } from 'react';
import { ErrorNote, Field, Spinner } from '../components/ui.tsx';
import { useSession } from '../stores/session.ts';
import { AuthShell } from './Onboarding.tsx';

export function Login() {
  const login = useSession((s) => s.login);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(email, password);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Sign in" subtitle="Welcome back.">
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Email">
          <input
            className="input"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </Field>
        <Field label="Password">
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </Field>
        <ErrorNote error={error} />
        <button type="submit" className="btn-primary btn-lg w-full" disabled={busy}>
          {busy && <Spinner />}
          Sign in
        </button>
        <p className="pt-1 text-center text-xs text-ink-faint">
          Locked out? Run <code className="text-ink-muted">derailed reset-password</code> on your
          server.
        </p>
      </form>
    </AuthShell>
  );
}
