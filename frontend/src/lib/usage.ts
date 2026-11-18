// The usage report (backend/app/usage.py): this browser reports what only it can see, such as which page is open
// and how far the pathway tutorial goes. Queued and sent every 15 seconds, and when the page is left. Off unless the
// server records usage for this account (a server with logins, not an administrator).

import { sendUsage } from '../api';
import type { UsageEvent } from '../types';

const SEND_EVERY_MS = 15_000;
let enabled = false;
let queue: UsageEvent[] = [];
let timer: number | undefined;

function send(keepalive = false) {
  window.clearTimeout(timer);
  timer = undefined;
  if (!queue.length) return;
  const events = queue.slice(0, 50);
  queue = queue.slice(50);
  void sendUsage(events, keepalive).catch(() => {});
  if (queue.length) send(keepalive);
}

export function enableUsage(on: boolean): void {
  enabled = on;
  if (!on) queue = [];
}

export function track(event: UsageEvent): void {
  if (!enabled) return;
  queue.push(event);
  if (timer === undefined) timer = window.setTimeout(() => send(), SEND_EVERY_MS);
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => send(true));
}
