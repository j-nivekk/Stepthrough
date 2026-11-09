import type { UserLink } from '../types';

// One-time links to set a password look like `https://<server>/#link=<token>`. The part after `#` never reaches
// the server, so the token stays out of its logs; the page reads it and sends it in a request body instead.
const LINK_FRAGMENT = '#link=';

export function linkAddress(token: string): string {
  return `${window.location.origin}/${LINK_FRAGMENT}${token}`;
}

export function readLinkToken(): string | null {
  const { hash } = window.location;
  return hash.startsWith(LINK_FRAGMENT) ? hash.slice(LINK_FRAGMENT.length) || null : null;
}

/** Take the token out of the address bar, so it is not left in the history or shared by accident. */
export function forgetLinkToken(): void {
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
}

function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** A `name,link` list to hand out invitations with, for example by mail merge. */
export function linksCsv(rows: { name: string; link: UserLink | null }[]): string {
  const lines = rows.map((row) => [row.name, row.link ? linkAddress(row.link.token) : ''].map(csvField).join(','));
  return ['name,link', ...lines].join('\n') + '\n';
}

export function downloadText(filename: string, text: string, type = 'text/csv'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
