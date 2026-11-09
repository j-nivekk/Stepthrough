import { useState } from 'react';
import { logIn } from '../../api';
import type { SessionInfo } from '../../types';

export interface LoginScreenProps {
  onLoggedIn: (session: SessionInfo) => void;
  /** Nobody can log in yet: explain how to get started instead of asking for a password reset. */
  setupNeeded?: boolean;
}

export function LoginScreen({ onLoggedIn, setupNeeded = false }: LoginScreenProps) {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError('');
    try {
      onLoggedIn(await logIn(name.trim(), password));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not log in.');
      setPassword('');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="entry-screen">
      <form className="account-gate" onSubmit={handleSubmit}>
        <p className="account-gate-heading">log in to stepthrough</p>
        <input
          aria-label="name"
          autoCapitalize="none"
          autoComplete="username"
          autoFocus
          className="entry-project-input"
          onChange={(event) => setName(event.target.value)}
          placeholder="name"
          spellCheck={false}
          value={name}
        />
        <input
          aria-label="password"
          autoComplete="current-password"
          className="entry-project-input"
          onChange={(event) => setPassword(event.target.value)}
          placeholder="password"
          type="password"
          value={password}
        />
        <button className="entry-enter-button account-gate-submit" disabled={!name.trim() || !password || pending} type="submit">
          {pending ? 'logging in…' : 'log in'}
        </button>
        {error && <p className="entry-notice error account-gate-message">{error}</p>}
        {setupNeeded ? (
          <div className="account-gate-setup">
            <p className="entry-notice warning">nobody can log in yet: this stepthrough has no accounts.</p>
            <p className="account-gate-hint">
              <strong>on your own computer,</strong> stepthrough does not need logins. in your stepthrough folder, type{' '}
              <code className="app-settings-code">echo STEPTHROUGH_AUTH=none&gt;&gt;.env</code> and then{' '}
              <code className="app-settings-code">docker compose up -d</code>, and reload this page.
            </p>
            <p className="account-gate-hint">
              <strong>on a server,</strong> whoever runs it makes the first administrator with{' '}
              <code className="app-settings-code">python -m app.users add NAME --admin --password</code>.
            </p>
          </div>
        ) : (
          <p className="account-gate-hint">forgot your password? ask an administrator for a new link.</p>
        )}
      </form>
    </div>
  );
}
