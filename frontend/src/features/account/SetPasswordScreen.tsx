import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { getLinkDetails, setPasswordWithLink } from '../../api';
import type { SessionInfo } from '../../types';

const MIN_PASSWORD_LENGTH = 8;

export interface SetPasswordScreenProps {
  token: string;
  /** Leave the link page: with the new session once a password is set, or without one to go to the login page. */
  onDone: (session: SessionInfo | null) => void;
}

export function SetPasswordScreen({ token, onDone }: SetPasswordScreenProps) {
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const linkQuery = useQuery({ queryKey: ['link', token], queryFn: () => getLinkDetails(token), retry: false });
  const link = linkQuery.data;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password !== again) {
      setError('The two passwords differ.');
      return;
    }
    setPending(true);
    setError('');
    try {
      onDone(await setPasswordWithLink(token, password));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not set the password.');
    } finally {
      setPending(false);
    }
  }

  if (linkQuery.isError) {
    return (
      <div className="entry-screen">
        <div className="account-gate">
          <p className="account-gate-heading">{linkQuery.error.message.toLocaleLowerCase()}</p>
          <button className="analysis-task-link account-gate-link" onClick={() => onDone(null)} type="button">
            go to the login page
          </button>
        </div>
      </div>
    );
  }

  const tooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH;
  return (
    <div className="entry-screen">
      <form className="account-gate" onSubmit={handleSubmit}>
        <p className="account-gate-heading">
          {link ? (
            <>
              {link.purpose === 'invite' ? 'choose a password for ' : 'choose a new password for '}
              <span className="account-gate-name">{link.name}</span>
            </>
          ) : (
            'checking your link…'
          )}
        </p>
        {/* Lets password managers save the new password under the right name. */}
        <input autoComplete="username" hidden readOnly value={link?.name ?? ''} />
        <input
          aria-label="new password"
          autoComplete="new-password"
          autoFocus
          className="entry-project-input"
          disabled={!link}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="new password"
          type="password"
          value={password}
        />
        <input
          aria-label="new password again"
          autoComplete="new-password"
          className="entry-project-input"
          disabled={!link}
          onChange={(event) => setAgain(event.target.value)}
          placeholder="again"
          type="password"
          value={again}
        />
        <button
          className="entry-enter-button account-gate-submit"
          disabled={!link || password.length < MIN_PASSWORD_LENGTH || !again || pending}
          type="submit"
        >
          {pending ? 'saving…' : 'save'}
        </button>
        {error && <p className="entry-notice error account-gate-message">{error}</p>}
        <p className={`account-gate-hint ${tooShort ? 'warning' : ''}`}>
          at least {MIN_PASSWORD_LENGTH} characters, and not a common password. after this, you log in with{' '}
          {link ? <strong>{link.name}</strong> : 'your name'} and this password.
        </p>
      </form>
    </div>
  );
}
