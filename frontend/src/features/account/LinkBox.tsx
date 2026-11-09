import { useState } from 'react';
import { linkAddress } from '../../lib/accountLinks';
import { formatRunShortTimestamp } from '../../lib/formatters';
import type { UserLink } from '../../types';

export interface LinkBoxProps {
  link: UserLink;
  name: string;
  onDismiss: () => void;
}

/** A fresh link to set a password, ready to copy and pass on. It is shown once: the server keeps only its hash. */
export function LinkBox({ link, name, onDismiss }: LinkBoxProps) {
  const [copied, setCopied] = useState(false);
  const address = linkAddress(link.token);

  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="users-link-box">
      <p className="analysis-parameter-annotation users-link-copy">
        {link.purpose === 'invite' ? 'invitation' : 'password reset'} for <strong>{name}</strong>: usable once, until{' '}
        {formatRunShortTimestamp(link.expires_at)}. it is only shown now; earlier links no longer work.
      </p>
      <div className="users-link-row">
        <input
          aria-label={`link for ${name}`}
          className="users-control users-link-field"
          onFocus={(event) => event.currentTarget.select()}
          readOnly
          value={address}
        />
        <button className="analysis-task-link subtle" onClick={() => void copy()} type="button">
          {copied ? 'copied' : 'copy'}
        </button>
        <button className="analysis-task-link subtle" onClick={onDismiss} type="button">
          done
        </button>
      </div>
    </div>
  );
}
