import { schemas } from '@derailed/shared';
import { type FormEvent, useState } from 'react';
import { Logo } from '../components/Logo.tsx';
import { ErrorNote, Field, Spinner } from '../components/ui.tsx';
import { useSession } from '../stores/session.ts';

export function Onboarding() {
  const setup = useSession((s) => s.setup);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError(new Error('Those passwords do not match.'));
      return;
    }
    setBusy(true);
    try {
      await setup(email, password);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title="Welcome to Derailed"
      subtitle="This server is brand new. Create the account you'll use to run it. It's the only one, and it lives on your machine."
    >
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Email">
          <input
            className="input"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            required
          />
        </Field>
        <Field
          label="Password"
          hint={`At least ${schemas.MIN_PASSWORD_LENGTH} characters. There's no reset email, write it down.`}
        >
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </Field>
        <Field label="Password again">
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
        </Field>
        <ErrorNote error={error} />
        <button type="submit" className="btn-primary btn-lg w-full" disabled={busy}>
          {busy && <Spinner />}
          Create my account
        </button>
      </form>
    </AuthShell>
  );
}

export function AuthShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="aurora relative flex min-h-full items-center justify-center overflow-hidden px-4 py-16">
      <div className="rails pointer-events-none absolute inset-0" />
      <div className="relative w-full max-w-[380px]">
        <div className="mb-7 flex flex-col items-center text-center">
          <Logo className="h-11 w-11" />
          <h1 className="mt-4 text-[19px] font-semibold text-ink">{title}</h1>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-muted">{subtitle}</p>
        </div>
        <div className="panel p-6">{children}</div>
      </div>
    </div>
  );
}
