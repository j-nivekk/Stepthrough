import { useState } from 'react';
import { logIn } from '../../api';
import type { SessionInfo } from '../../types';

export interface LoginScreenProps {
  onLoggedIn: (session: SessionInfo) => void;
}

export function LoginScreen({ onLoggedIn }: LoginScreenProps) {
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
        <p className="account-gate-hint">forgot your password? ask an administrator for a new link.</p>
      </form>
    </div>
  );
}
