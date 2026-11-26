// The command bar: a slash, outside a text field, opens a line at the bottom of the window to type a command in
// (lib/commands.ts lists them). What is typed is completed as it goes: the commands, then what the command takes.
// Enter runs it, Esc closes the bar; up in an empty bar goes back through earlier commands.

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';

import {
  COMMANDS,
  GROUP_PLACE,
  KEYS,
  argProblem,
  argTemplate,
  barState,
  choicesOf,
  findCommand,
  matchChoice,
  parseLine,
  type CommandGroup,
  type CommandSpec,
} from '../lib/commands';
import { useCommandLookup, useCommands } from '../lib/commandRegistry';

const HISTORY_KEY = 'stepthrough.command-history.v1';
const HISTORY_LENGTH = 50;
/** How long what a command did stays on screen. */
const SAID_MS = 2600;

const GROUP_TITLE: Record<CommandGroup, string> = {
  everywhere: 'everywhere',
  analysis: 'videos and tasks',
  parameters: 'parameters',
  playback: 'the video',
  steps: 'the steps',
  pathway: 'the pathway',
};

function readHistory(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

function keepInHistory(line: string) {
  try {
    const history = [line, ...readHistory().filter((entry) => entry !== line)].slice(0, HISTORY_LENGTH);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {
    // a private window: no history, the bar works the same
  }
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || Boolean(target.closest('input, textarea, select, [role="textbox"]'));
}

type Panel = 'help' | 'keys' | null;

export function CommandBar() {
  const lookup = useCommandLookup();
  const [open, setOpen] = useState(false);
  const [line, setLine] = useState('/');
  const [highlight, setHighlight] = useState(-1);
  const [panel, setPanel] = useState<Panel>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState<{ text: string; key: number } | null>(null);
  const [historyAt, setHistoryAt] = useState(-1);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const running = useRef(false);
  const session = useRef(0);
  const listId = useId();

  // /help and /keys are the bar's own
  useCommands({ help: { run: () => undefined }, keys: { run: () => undefined } });

  const close = useCallback(() => {
    session.current += 1;
    setOpen(false);
    setPanel(null);
    setProblem(null);
    setHighlight(-1);
    setHistoryAt(-1);
    const back = returnFocusRef.current;
    returnFocusRef.current = null;
    if (back && back.isConnected && back !== document.body) back.focus({ preventScroll: true });
  }, []);

  // a slash outside a text field opens the bar (not over a dialog that holds the page)
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (open || event.defaultPrevented || event.isComposing || event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
      if (isTyping(event.target) || document.querySelector('[aria-modal="true"], dialog[open]')) return;
      if (event.target instanceof Element && event.target.closest('[role="menu"]')) return;
      event.preventDefault();
      returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setLine('/');
      setPanel(null);
      setProblem(null);
      setHighlight(-1);
      setHistoryAt(-1);
      setOpen(true);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  useEffect(() => {
    if (open) inputRef.current?.focus({ preventScroll: true });
  }, [open]);

  // a click elsewhere closes it
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (event.target instanceof Element && event.target.closest('[aria-modal="true"], dialog[open]')) return;
      if (barRef.current && !barRef.current.contains(event.target as Node)) close();
    }
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open, close]);

  useEffect(() => {
    if (!said) return;
    const timer = window.setTimeout(() => setSaid(null), SAID_MS);
    return () => window.clearTimeout(timer);
  }, [said]);

  const state = open ? barState(line, lookup) : null;
  const { arg } = parseLine(line);
  const items = state?.items ?? [];
  const available = open && panel === 'help' ? COMMANDS.filter((command) => lookup(command.name)) : [];
  const optionCount = panel === 'help' ? available.length : panel === 'keys' ? 0 : items.length;
  const optionId = highlight >= 0 && highlight < optionCount ? `${listId}-${highlight}` : undefined;

  useEffect(() => {
    if (optionId) document.getElementById(optionId)?.scrollIntoView({ block: 'nearest' });
  }, [optionId]);

  function say(text: string) {
    setSaid({ text, key: Date.now() });
  }

  async function run(text: string) {
    if (running.current) return;
    const { name, arg: rawArg } = parseLine(text);
    const spec = findCommand(name);
    if (!name) return;
    if (!spec) {
      setProblem(`there is no /${name}`);
      return;
    }
    const handler = lookup(spec.name);
    if (!handler) {
      setProblem(`/${spec.name} works ${GROUP_PLACE[spec.group]}`);
      return;
    }
    // a number alone is a step: /30
    const shorthand = /^\d+$/.test(name) && spec.name === 'step';
    if (shorthand && rawArg) {
      setProblem(`/${name} takes nothing after it`);
      return;
    }
    const value = shorthand ? name : rawArg;
    const choices = choicesOf(spec, handler).map((choice) => choice.value);
    const taken = spec.arg?.kind === 'choice' || spec.arg?.kind === 'steps' ? matchChoice(value, choices) ?? value : value;
    const wrong = argProblem(spec, value, choices) ?? handler.check?.(taken) ?? null;
    if (wrong) {
      setProblem(wrong);
      return;
    }
    if (spec.name === 'help' || spec.name === 'keys') {
      setPanel(spec.name);
      setLine('/');
      setProblem(null);
      setHighlight(-1);
      keepInHistory(`/${spec.name}`);
      return;
    }
    const opened = session.current;
    running.current = true;
    try {
      const outcome = await handler.run(taken);
      if (outcome && typeof outcome === 'object') {
        if (opened === session.current) setProblem(outcome.problem);
        else say(outcome.problem);
        return;
      }
      // Keep shortcuts and settings in history without storing annotation text or OCR queries.
      if (spec.arg?.kind !== 'text') keepInHistory(text.trim());
      if (opened === session.current) close();
      if (typeof outcome === 'string' && outcome) say(outcome);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'that did not work';
      if (opened === session.current) setProblem(message);
      else say(message);
    } finally {
      running.current = false;
    }
  }

  function take(index: number): string | null {
    if (panel === 'help') {
      const command = available[index];
      return command ? `/${command.name}${command.arg ? ' ' : ''}` : null;
    }
    const item = items[index];
    return item && !item.elsewhere ? item.line : null;
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      const chosen = highlight >= 0 ? take(highlight) : null;
      const first = take(0);
      const current = state?.mode === 'argument' && !arg && state.spec ? lookup(state.spec.name)?.current?.() : null;
      if (chosen) {
        setLine(chosen);
      } else if (state?.ghost) {
        const spec = state.mode === 'commands' ? findCommand(parseLine(line + state.ghost).name) : null;
        setLine(line + state.ghost + (spec?.arg ? ' ' : ''));
      } else if (current) {
        setLine(line.replace(/\s*$/, ' ') + current);
      } else if (first) {
        setLine(first);
      }
      setHighlight(-1);
      setPanel(null);
      setProblem(null);
      return;
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      const up = event.key === 'ArrowUp';
      // up in an empty bar (or while going through it) is the history
      if ((!panel && line === '/' && highlight < 0 && up) || historyAt >= 0) {
        const history = readHistory();
        const next = up ? Math.min(history.length - 1, historyAt + 1) : historyAt - 1;
        if (next < 0) {
          setHistoryAt(-1);
          setLine('/');
        } else if (history[next]) {
          setHistoryAt(next);
          setLine(history[next]);
        }
        setProblem(null);
        return;
      }
      if (!optionCount) return;
      setHighlight((current) =>
        up ? (current <= 0 ? optionCount - 1 : current - 1) : current >= optionCount - 1 ? 0 : current + 1,
      );
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.repeat) return;
      // Only an explicit choice can resolve ambiguous arguments.
      const { name, named } = parseLine(line);
      const command = findCommand(name);
      const chosen = highlight >= 0 ? take(highlight) : null;
      if (chosen && chosen.trim() !== line.trim()) {
        choose(chosen, state?.mode === 'commands' || panel === 'help');
        return;
      }
      // Complete an unfinished name before running it, so a prefix like /exp cannot download a project.
      if (name && !command && state?.mode === 'commands' && items[0] && !items[0].elsewhere) {
        setLine(items[0].line);
        setHighlight(-1);
        setProblem(null);
        return;
      }
      if (command?.arg && !command.arg.optional && !named && state?.mode === 'commands' && lookup(command.name)) {
        setLine(line + ' ');
        setHighlight(-1);
        setProblem(null);
        return;
      }
      void run(line);
    }
  }

  /** Take a suggestion: a command that still needs something waits for it, anything else runs. */
  function choose(chosen: string, isCommand: boolean) {
    const spec = findCommand(parseLine(chosen).name);
    setHighlight(-1);
    setPanel(null);
    if (isCommand && spec?.arg && !spec.arg.optional) {
      setLine(chosen);
      inputRef.current?.focus();
      return;
    }
    void run(chosen);
  }

  const placeholder =
    state?.mode === 'argument' && state.spec?.arg && !arg && !/^\/\d+$/.test(line.trim())
      ? `‹${state.spec.arg.label}›`
      : '';
  const status = problem ?? state?.problem ?? null;
  const showProblem = Boolean(problem) || (Boolean(state?.problem) && (arg.length > 0 || state?.mode === 'commands') && line.trim() !== '/');
  const info = state?.detail ?? state?.hint ?? null;

  return (
    <>
      {open ? (
        <div aria-label="command bar" className="command-bar" ref={barRef} role="region">
          {panel === 'help' ? (
            <div className="command-bar-list" id={listId} role="listbox">
              {(Object.keys(GROUP_TITLE) as CommandGroup[]).map((group) => {
                const here = available.filter((command) => command.group === group);
                if (!here.length) return null;
                return (
                  <div className="command-bar-group" key={group} role="group" aria-label={GROUP_TITLE[group]}>
                    <p className="command-bar-group-title">{GROUP_TITLE[group]}</p>
                    {here.map((command) => (
                      <CommandItem
                        active={available.indexOf(command) === highlight}
                        command={command}
                        id={`${listId}-${available.indexOf(command)}`}
                        key={command.name}
                        onChoose={() => choose(`/${command.name}${command.arg ? ' ' : ''}`, true)}
                      />
                    ))}
                  </div>
                );
              })}
            </div>
          ) : panel === 'keys' ? (
            <div className="command-bar-list" id={listId}>
              {KEYS.map(([keys, does]) => (
                <div className="command-bar-item" key={keys}>
                  <span className="command-bar-label">{keys}</span>
                  <span className="command-bar-note">{does}</span>
                </div>
              ))}
            </div>
          ) : items.length ? (
            <div className="command-bar-list" id={listId} role="listbox">
              {items.map((item, index) => (
                <div
                  aria-disabled={item.elsewhere ? true : undefined}
                  aria-selected={index === highlight}
                  className={`command-bar-item ${item.elsewhere ? 'is-elsewhere' : ''}`}
                  id={`${listId}-${index}`}
                  key={item.line + item.label}
                  onClick={() => (item.elsewhere ? undefined : choose(item.line, state?.mode === 'commands'))}
                  onPointerDown={(event) => event.preventDefault()}
                  role="option"
                >
                  <CommandLabel aliases={item.aliases} label={item.label} />
                  <span className="command-bar-note">{item.note}</span>
                  {item.elsewhere ? <span className="command-bar-where">{item.elsewhere}</span> : null}
                </div>
              ))}
            </div>
          ) : null}
          <div className="command-bar-line">
            <div className="command-bar-field">
              <span aria-hidden="true" className="command-bar-ghost">
                <span className="command-bar-typed">{line}</span>
                {state?.ghost ? state.ghost : placeholder}
              </span>
              <input
                aria-activedescendant={optionId}
                aria-autocomplete="both"
                aria-controls={optionCount ? listId : undefined}
                aria-expanded={optionCount > 0}
                aria-describedby={`${listId}-status`}
                aria-label="command"
                autoCapitalize="off"
                autoComplete="off"
                autoCorrect="off"
                className="command-bar-input"
                data-command-input=""
                onChange={(event) => {
                  const next = event.target.value;
                  if (!next.startsWith('/')) {
                    // the slash taken away: the bar goes, as in vim
                    if (!next) close();
                    else setLine(`/${next}`);
                    return;
                  }
                  setLine(next);
                  setHighlight(-1);
                  setHistoryAt(-1);
                  setPanel(null);
                  setProblem(null);
                }}
                onKeyDown={onKeyDown}
                ref={inputRef}
                role="combobox"
                spellCheck={false}
                value={line}
              />
            </div>
            {status && showProblem ? (
              <span aria-live="polite" className="command-bar-status is-problem" id={`${listId}-status`}>
                {status}
              </span>
            ) : info ? (
              <span className="command-bar-status" id={`${listId}-status`}>{info}</span>
            ) : (
              <span className="command-bar-status" id={`${listId}-status`}>
                {panel === 'keys' ? 'the keyboard shortcuts' : 'tab completes, enter runs, esc closes'}
              </span>
            )}
          </div>
        </div>
      ) : null}
      <div aria-live="polite" className="sr-only" role="status">{said?.text ?? ''}</div>
      {said && !open ? (
        <div aria-hidden="true" className="command-bar-said" key={said.key}>
          {said.text}
        </div>
      ) : null}
    </>
  );
}

function CommandItem({ command, active, id, onChoose }: { command: CommandSpec; active: boolean; id: string; onChoose: () => void }) {
  return (
    <div
      aria-selected={active}
      className="command-bar-item"
      id={id}
      onClick={onChoose}
      onPointerDown={(event) => event.preventDefault()}
      role="option"
    >
      <CommandLabel aliases={command.aliases} label={argTemplate(command)} />
      <span className="command-bar-note">{command.summary}</span>
    </div>
  );
}

function CommandLabel({ aliases, label }: { aliases?: readonly string[]; label: string }) {
  return (
    <span className="command-bar-label">
      {label}
      {aliases?.length ? <span className="command-bar-aliases">{aliases.map((alias) => `/${alias}`).join(' ')}</span> : null}
    </span>
  );
}
