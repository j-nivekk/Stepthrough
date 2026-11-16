// Shared accounts: many people signed in to one account at once. This keeps a browser up to date with the
// others (backend/app/live.py): it waits on the account's live feed, applies each change to the cached data, and
// tells the others what it is doing itself (presence). Regular accounts get none of this.

import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { CLIENT_ID, sendPresence, waitForChanges } from '../../api';
import { patchCandidate, staleQueries, type QueryKeyPrefix } from '../../lib/live';
import type { LiveBusy, LivePresence, LivePresenceTarget, RunDetail } from '../../types';

/** How long the server waits for a change before answering, in seconds; the browser then asks again. */
const WAIT_SECONDS = 25;
/** Presence lasts 25 s on the server; repeat it well within that. */
const PRESENCE_REPEAT_MS = 10_000;
/** After a step changes elsewhere, what is derived from it (accepted steps, the pathway) is loaded again this
 *  long after the last such change, so a burst of decisions costs one reload, not one per step. */
const RECONCILE_MS = 1200;

interface LiveValue {
  enabled: boolean;
  clientId: string;
  presence: LivePresence[];
  busy: LiveBusy[];
  /** Say (or, with null, stop saying) what this browser is doing under `key`. */
  setPresence: (key: string, target: LivePresenceTarget | null) => void;
}

const DISABLED: LiveValue = { enabled: false, clientId: CLIENT_ID, presence: [], busy: [], setPresence: () => {} };
const LiveContext = createContext<LiveValue>(DISABLED);

export function useLive(): LiveValue {
  return useContext(LiveContext);
}

function sameState(a: { presence: LivePresence[]; busy: LiveBusy[] }, b: { presence: LivePresence[]; busy: LiveBusy[] }) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function LiveProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<{ presence: LivePresence[]; busy: LiveBusy[] }>({ presence: [], busy: [] });

  // ── the feed ──────────────────────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let controller: AbortController | null = null;
    let after: number | null = null;
    let epoch: string | null = null;
    const reconcile = new Map<string, QueryKeyPrefix>();
    let reconcileTimer: number | undefined;

    function invalidate(keys: QueryKeyPrefix[]) {
      for (const queryKey of keys) void queryClient.invalidateQueries({ queryKey: [...queryKey] });
    }

    function reconcileSoon(keys: QueryKeyPrefix[]) {
      for (const key of keys) reconcile.set(JSON.stringify(key), key);
      window.clearTimeout(reconcileTimer);
      reconcileTimer = window.setTimeout(() => {
        const due = [...reconcile.values()];
        reconcile.clear();
        invalidate(due);
      }, RECONCILE_MS);
    }

    function apply(events: Awaited<ReturnType<typeof waitForChanges>>['events']) {
      const stale = new Map<string, QueryKeyPrefix>();
      for (const event of events) {
        // This browser shows its own changes already.
        if (event.kind === 'state' || event.by === CLIENT_ID) continue;
        if (event.kind === 'candidate' && event.candidate && event.run_id) {
          const candidate = event.candidate;
          queryClient.setQueryData<RunDetail>(['run', event.run_id], (detail) => patchCandidate(detail, candidate));
          reconcileSoon(staleQueries(event));
          continue;
        }
        for (const key of staleQueries(event)) stale.set(JSON.stringify(key), key);
      }
      invalidate([...stale.values()]);
    }

    async function listen() {
      let failures = 0;
      while (!stopped) {
        controller = new AbortController();
        const request = controller;
        // a little longer than the server waits, in case a proxy holds the answer back
        const timeout = window.setTimeout(() => request.abort(), (WAIT_SECONDS + 15) * 1000);
        try {
          const live = await waitForChanges(after, epoch, request.signal, after === null ? 0 : WAIT_SECONDS);
          if (stopped) return;
          failures = 0;
          if (after !== null && (live.reset || live.epoch !== epoch)) {
            // Too much missed, or the server restarted: load everything again.
            void queryClient.invalidateQueries();
          } else {
            apply(live.events);
          }
          after = live.seq;
          epoch = live.epoch;
          const next = { presence: live.presence, busy: live.busy };
          setState((previous) => (sameState(previous, next) ? previous : next));
        } catch {
          if (stopped) return;
          failures += 1;
          // offline, asleep or a restart: try again, less often the longer it lasts, and catch up then
          await new Promise((resolve) => window.setTimeout(resolve, Math.min(15_000, 1000 * 2 ** Math.min(failures, 4))));
        } finally {
          window.clearTimeout(timeout);
        }
      }
    }

    void listen();
    return () => {
      stopped = true;
      controller?.abort();
      window.clearTimeout(reconcileTimer);
      setState({ presence: [], busy: [] });
    };
  }, [enabled, queryClient]);

  // ── presence: what this browser is doing ─────────────────────────────────────────────────────────────────
  const targets = useRef(new Map<string, LivePresenceTarget>());
  const sendTimer = useRef<number | undefined>(undefined);
  const repeatTimer = useRef<number | undefined>(undefined);

  const send = useCallback(() => {
    window.clearTimeout(sendTimer.current);
    window.clearTimeout(repeatTimer.current);
    const list = [...targets.current.values()];
    void sendPresence(list).catch(() => {});
    if (list.length) repeatTimer.current = window.setTimeout(send, PRESENCE_REPEAT_MS);
  }, []);

  const setPresence = useCallback(
    (key: string, target: LivePresenceTarget | null) => {
      if (!enabled) return;
      const before = targets.current.get(key);
      if (target) targets.current.set(key, target);
      else if (before) targets.current.delete(key);
      else return;
      // a moment's grace, so that focusing one field after another sends one message
      window.clearTimeout(sendTimer.current);
      sendTimer.current = window.setTimeout(send, 150);
    },
    [enabled, send],
  );

  useEffect(() => {
    if (!enabled) return;
    const clear = () => {
      if (!targets.current.size) return;
      targets.current.clear();
      void sendPresence([], true).catch(() => {});
    };
    window.addEventListener('pagehide', clear);
    return () => {
      window.removeEventListener('pagehide', clear);
      window.clearTimeout(sendTimer.current);
      window.clearTimeout(repeatTimer.current);
      clear();
    };
  }, [enabled]);

  const value = useMemo<LiveValue>(
    () => (enabled ? { enabled, clientId: CLIENT_ID, presence: state.presence, busy: state.busy, setPresence } : DISABLED),
    [enabled, setPresence, state],
  );
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}
