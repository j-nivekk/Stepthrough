// What the command bar's commands do here (lib/commands.ts has the list of them): each part of the page gives the
// commands it can carry out while it is shown, with useCommands. The bar asks the registry when it draws, so it
// offers what can be done where one is; the part shown last wins when two give the same command.

import { createContext, useContext, useId, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';

import type { CommandHandler, HandlerLookup } from './commands';

export type CommandHandlers = Partial<Record<string, CommandHandler>>;

interface Registry {
  add: (id: string, handlers: { current: CommandHandlers | null }) => void;
  remove: (id: string) => void;
  lookup: HandlerLookup;
}

const CommandContext = createContext<Registry | null>(null);

export function CommandProvider({ children }: { children: ReactNode }) {
  const registry = useMemo<Registry>(() => {
    const parts = new Map<string, { current: CommandHandlers | null }>();
    return {
      add: (id, handlers) => {
        parts.delete(id);
        parts.set(id, handlers);
      },
      remove: (id) => {
        parts.delete(id);
      },
      lookup: (name) => {
        let found: CommandHandler | undefined;
        for (const handlers of parts.values()) found = handlers.current?.[name] ?? found;
        return found;
      },
    };
  }, []);
  return <CommandContext.Provider value={registry}>{children}</CommandContext.Provider>;
}

/** Give the commands this part of the page carries out, while it is shown. The handlers may change on every render;
 *  the latest are used. null, or a command left out, gives nothing (for now). */
export function useCommands(handlers: CommandHandlers | null): void {
  const registry = useContext(CommandContext);
  const id = useId();
  const latest = useRef(handlers);
  latest.current = handlers;
  useLayoutEffect(() => {
    if (!registry) return;
    registry.add(id, latest);
    return () => registry.remove(id);
  }, [registry, id]);
}

/** The commands usable here, for the bar. */
export function useCommandLookup(): HandlerLookup {
  const registry = useContext(CommandContext);
  return registry?.lookup ?? (() => undefined);
}
