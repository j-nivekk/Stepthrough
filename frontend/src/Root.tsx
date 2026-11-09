import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import App from './App';
import { SIGNED_OUT_EVENT, getSession } from './api';
import { AppWatermark } from './components/AppWatermark';
import { LoginScreen } from './features/account/LoginScreen';
import { SetPasswordScreen } from './features/account/SetPasswordScreen';
import { forgetLinkToken, readLinkToken } from './lib/accountLinks';
import type { SessionInfo } from './types';

const SESSION_KEY = ['session'];

/** Shows the login page or a link's set-password page when needed, and the app once someone is logged in. */
export function Root() {
  const queryClient = useQueryClient();
  const [linkToken, setLinkToken] = useState(() => readLinkToken());
  const sessionQuery = useQuery({ queryKey: SESSION_KEY, queryFn: getSession, retry: false, staleTime: Infinity });

  useEffect(() => {
    // A request found the session gone (logged out elsewhere, expired, switched off): check, then show the login.
    const recheck = () => void queryClient.invalidateQueries({ queryKey: SESSION_KEY });
    const followLink = () => setLinkToken(readLinkToken());
    window.addEventListener(SIGNED_OUT_EVENT, recheck);
    window.addEventListener('hashchange', followLink);
    return () => {
      window.removeEventListener(SIGNED_OUT_EVENT, recheck);
      window.removeEventListener('hashchange', followLink);
    };
  }, [queryClient]);

  /** Start over as whoever is now logged in (or nobody), so nothing from the previous person stays cached. */
  function enter(session: SessionInfo) {
    queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== SESSION_KEY[0] });
    queryClient.setQueryData(SESSION_KEY, session);
  }

  if (linkToken) {
    return (
      <>
        <SetPasswordScreen
          onDone={(session) => {
            forgetLinkToken();
            setLinkToken(null);
            if (session) enter(session);
          }}
          token={linkToken}
        />
        <AppWatermark />
      </>
    );
  }

  const session = sessionQuery.data ?? null;
  if (sessionQuery.isPending) {
    return <div className="entry-screen" />;
  }
  if (session?.mode === 'password' && !session.user) {
    return (
      <>
        <LoginScreen onLoggedIn={enter} />
        <AppWatermark />
      </>
    );
  }
  // Without an answer (the backend is not running yet), the app's own notices explain what is wrong.
  return <App onSessionChange={enter} session={session} />;
}
