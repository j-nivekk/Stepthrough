// The command bar's commands (components/CommandBar.tsx): typed after a slash, completed as they are typed. This file is
// the list of every command, with what it takes, and the pure work of reading and completing what is typed. What a
// command does is given by the part of the page it belongs to, while that part is shown (lib/commandRegistry.tsx): so
// the bar offers only what can be done where one is.

export type CommandGroup = 'everywhere' | 'analysis' | 'parameters' | 'playback' | 'steps' | 'pathway';

/** Where the commands of a group can be used, for a command typed elsewhere ("/zoom works in the pathway"). */
export const GROUP_PLACE: Record<CommandGroup, string> = {
  everywhere: 'everywhere',
  analysis: 'on the analysis page of a project',
  parameters: 'on the analysis page of a project',
  playback: 'while a video is open',
  steps: 'in the steps of a finished run',
  pathway: 'in the pathway',
};

export type ArgKind = 'choice' | 'number' | 'text' | 'steps' | 'time' | 'frames';

export interface ArgSpec {
  /** As shown in the bar, between ‹ and ›. */
  label: string;
  kind: ArgKind;
  /** The choices a choice has always; a handler may add its own (names of runs, of videos). */
  choices?: readonly string[];
  /** For numbers: the unit after them, and the bounds. */
  unit?: string;
  min?: number;
  max?: number;
  /** A number that may also be "fit". */
  fit?: boolean;
  /** May be left out (the command then does its plain thing: toggle, the active step, defaults of the project). */
  optional?: boolean;
}

export interface CommandSpec {
  name: string;
  /** Short forms, typed exactly as they are (/a, /gg, /G). */
  aliases?: readonly string[];
  group: CommandGroup;
  /** A few words on what it does. */
  summary: string;
  arg?: ArgSpec;
}

const ON_OFF = ['on', 'off'] as const;

/** Every command, in the order the bar lists them when nothing narrows them down. */
export const COMMANDS: readonly CommandSpec[] = [
  // everywhere
  { name: 'top', aliases: ['gg'], group: 'everywhere', summary: 'the top of the page' },
  { name: 'end', aliases: ['G'], group: 'everywhere', summary: 'the end of the page' },
  { name: 'projects', group: 'everywhere', summary: 'the list of projects' },
  { name: 'project', group: 'everywhere', summary: 'open a project', arg: { label: 'name', kind: 'choice' } },
  { name: 'import', group: 'everywhere', summary: 'add videos to this project' },
  { name: 'analysis', group: 'everywhere', summary: 'open analysis for this project' },
  {
    name: 'exportproject',
    group: 'everywhere',
    summary: 'download a project file with its videos and runs',
    arg: { label: 'project name', kind: 'choice', optional: true },
  },
  { name: 'settings', group: 'everywhere', summary: 'open settings' },
  { name: 'about', group: 'everywhere', summary: 'open about' },
  { name: 'help', aliases: ['?'], group: 'everywhere', summary: 'what can be typed here' },
  { name: 'keys', aliases: ['map'], group: 'everywhere', summary: 'the keyboard shortcuts' },
  // the analysis page
  { name: 'video', group: 'analysis', summary: 'select a video', arg: { label: 'name', kind: 'choice' } },
  { name: 'preview', group: 'analysis', summary: 'open the video preview', arg: { label: 'video name', kind: 'choice', optional: true } },
  { name: 'goto', group: 'analysis', summary: 'jump to a section of the analysis page', arg: { label: 'section', kind: 'choice' } },
  {
    name: 'run',
    group: 'analysis',
    summary: 'open a run of the video',
    arg: { label: 'number or name', kind: 'choice', choices: ['next', 'previous'] },
  },
  {
    name: 'tasks',
    group: 'analysis',
    summary: 'which tasks show',
    arg: { label: 'filter', kind: 'choice', choices: ['all', 'active', 'completed', 'failed'] },
  },
  { name: 'compare', group: 'analysis', summary: 'compare the runs of the video' },
  {
    name: 'exportruns',
    group: 'analysis',
    summary: 'download ZIP exports for multiple runs',
    arg: { label: 'selected, video or completed', kind: 'choice', choices: ['selected', 'video', 'completed'] },
  },
  {
    name: 'export',
    aliases: ['exportrun', 'w'],
    group: 'analysis',
    summary: 'download the open run as a ZIP',
    arg: { label: 'accepted or all', kind: 'choice', choices: ['accepted', 'all'] },
  },
  { name: 'fold', group: 'analysis', summary: 'fold the videos, parameters and tasks' },
  { name: 'unfold', group: 'analysis', summary: 'open the videos, parameters and tasks' },
  { name: 'analyse', aliases: ['analyze'], group: 'analysis', summary: 'start an analysis, as "run analysis"' },
  // parameters
  { name: 'type', group: 'parameters', summary: 'recording type', arg: { label: 'type', kind: 'choice', choices: ['phone', 'computer'] } },
  { name: 'min', group: 'parameters', summary: 'minimum time on screen', arg: { label: 'milliseconds', kind: 'number', unit: 'ms', min: 100, max: 10_000 } },
  { name: 'change', group: 'parameters', summary: 'smallest change', arg: { label: 'percent', kind: 'number', unit: '%', min: 0.01, max: 25 } },
  { name: 'statusbar', group: 'parameters', summary: 'phone status bar', arg: { label: 'include or ignore', kind: 'choice', choices: ['include', 'ignore'] } },
  { name: 'scrolling', group: 'parameters', summary: 'each stop, or merge stops', arg: { label: 'each or merge', kind: 'choice', choices: ['each', 'merge'] } },
  { name: 'typing', group: 'parameters', summary: 'group typing', arg: { label: 'on or off', kind: 'choice', choices: ON_OFF, optional: true } },
  { name: 'opening', group: 'parameters', summary: 'opening screen', arg: { label: 'on or off', kind: 'choice', choices: ON_OFF, optional: true } },
  { name: 'text', group: 'parameters', summary: 'read text (asks first)', arg: { label: 'on or off', kind: 'choice', choices: ON_OFF, optional: true } },
  { name: 'threshold', group: 'parameters', summary: 'pixel threshold (advanced)', arg: { label: '× noise', kind: 'number', unit: '× noise', min: 1, max: 20 } },
  { name: 'rate', group: 'parameters', summary: 'analysis rate (advanced)', arg: { label: 'fps', kind: 'number', unit: 'fps', min: 2, max: 30 } },
  { name: 'preset', group: 'parameters', summary: 'load a saved analysis preset', arg: { label: 'preset', kind: 'choice', choices: ['project', 'universal'] } },
  {
    name: 'defaults',
    group: 'parameters',
    summary: 'parameters back to defaults',
    arg: { label: 'whose', kind: 'choice', choices: ['project', 'universal'], optional: true },
  },
  { name: 'hints', group: 'parameters', summary: 'show or hide the hints', arg: { label: 'on or off', kind: 'choice', choices: ON_OFF, optional: true } },
  // playback
  { name: 'play', group: 'playback', summary: 'play the video' },
  { name: 'pause', group: 'playback', summary: 'pause the video' },
  { name: 'seek', group: 'playback', summary: 'go to a moment', arg: { label: 'time, as 1:23 or 83.5', kind: 'time' } },
  { name: 'frame', group: 'playback', summary: 'step frames forward or back', arg: { label: '+n or -n', kind: 'frames', optional: true } },
  { name: 'speed', group: 'playback', summary: 'playback speed', arg: { label: 'speed', kind: 'choice', choices: ['0.5', '1', '1.5', '2'] } },
  { name: 'mark', group: 'playback', summary: 'add a step at this moment' },
  { name: 'player', group: 'playback', summary: 'size of the video', arg: { label: 'size', kind: 'choice', choices: ['small', 'medium', 'large'] } },
  { name: 'closepreview', aliases: ['q'], group: 'playback', summary: 'close the video preview' },
  // steps
  { name: 'step', group: 'steps', summary: 'go to a step (or type its number alone)', arg: { label: 'number', kind: 'steps' } },
  { name: 'nextstep', aliases: ['next'], group: 'steps', summary: 'go to the next visible step' },
  { name: 'prevstep', aliases: ['prev'], group: 'steps', summary: 'go to the previous visible step' },
  { name: 'firststep', group: 'steps', summary: 'go to the first visible step' },
  { name: 'laststep', group: 'steps', summary: 'go to the last visible step' },
  { name: 'pending', group: 'steps', summary: 'the next step not yet decided' },
  { name: 'accept', aliases: ['a'], group: 'steps', summary: 'accept the selected steps, the active one, or these', arg: { label: 'steps', kind: 'steps', optional: true } },
  { name: 'reject', aliases: ['r'], group: 'steps', summary: 'reject the selected steps, the active one, or these', arg: { label: 'steps', kind: 'steps', optional: true } },
  { name: 'reset', aliases: ['u'], group: 'steps', summary: 'back to undecided: the selected steps, the active one, or these', arg: { label: 'steps', kind: 'steps', optional: true } },
  {
    name: 'select',
    aliases: ['x'],
    group: 'steps',
    summary: 'select steps',
    arg: { label: 'steps, all, none, invert or pending', kind: 'steps', choices: ['all', 'none', 'invert', 'pending'], optional: true },
  },
  {
    name: 'filter',
    group: 'steps',
    summary: 'which steps show',
    arg: { label: 'filter', kind: 'choice', choices: ['all', 'pending', 'accepted', 'rejected'] },
  },
  { name: 'view', group: 'steps', summary: 'step layout', arg: { label: 'layout', kind: 'choice', choices: ['grid', 'list', 'gallery'] } },
  { name: 'size', group: 'steps', summary: 'size of the step images', arg: { label: 'pixels or fit', kind: 'number', unit: 'px', min: 120, max: 420, fit: true } },
  { name: 'find', group: 'steps', summary: 'steps with this text on the screen', arg: { label: 'text', kind: 'text', optional: true } },
  { name: 'title', group: 'steps', summary: 'title the active step', arg: { label: 'text', kind: 'text' } },
  { name: 'note', group: 'steps', summary: 'annotate the active step', arg: { label: 'text', kind: 'text' } },
  { name: 'popup', group: 'steps', summary: 'the active step is a pop-up', arg: { label: 'on or off', kind: 'choice', choices: ON_OFF, optional: true } },
  { name: 'same', group: 'steps', summary: 'the active step shows the same screen as that step', arg: { label: 'step', kind: 'steps' } },
  { name: 'newscreen', group: 'steps', summary: 'the active step is a new screen' },
  { name: 'playfrom', aliases: ['p'], group: 'steps', summary: 'play the video from the active step' },
  { name: 'readtext', group: 'steps', summary: 'read the text of the run (asks first)' },
  { name: 'pathway', group: 'steps', summary: 'to the pathway' },
  // pathway
  { name: 'steps', group: 'pathway', summary: 'back to the steps' },
  { name: 'boxes', group: 'pathway', summary: 'what a box stands for', arg: { label: 'screens or steps', kind: 'choice', choices: ['screens', 'steps'] } },
  { name: 'notes', group: 'pathway', summary: 'where notes go', arg: { label: 'under, key or off', kind: 'choice', choices: ['under', 'key', 'off'] } },
  { name: 'detours', group: 'pathway', summary: 'optional detours', arg: { label: 'counted or out', kind: 'choice', choices: ['counted', 'out'] } },
  { name: 'times', group: 'pathway', summary: 'the time of each visit', arg: { label: 'on or off', kind: 'choice', choices: ON_OFF, optional: true } },
  { name: 'legend', group: 'pathway', summary: 'title and legend', arg: { label: 'on or off', kind: 'choice', choices: ON_OFF, optional: true } },
  { name: 'phases', group: 'pathway', summary: 'the list of phases' },
  { name: 'zoom', group: 'pathway', summary: 'size of the figure', arg: { label: 'percent or fit', kind: 'number', unit: '%', min: 25, max: 150, fit: true } },
  { name: 'download', aliases: ['exportfigure'], group: 'pathway', summary: 'download the pathway figure', arg: { label: 'png or svg', kind: 'choice', choices: ['png', 'svg'] } },
  { name: 'tutorial', group: 'pathway', summary: 'the pathway tutorial' },
];

/** What a command does here; given by the part of the page it belongs to (lib/commandRegistry.tsx). */
export interface CommandHandler {
  /** Do it. A text says what was done; { problem } why it was not. */
  run: (arg: string) => CommandOutcome | Promise<CommandOutcome>;
  /** Choices beyond the command's own (names of runs, videos, projects), with a note on each. */
  choices?: () => Array<{ value: string; note?: string; suggest?: boolean }>;
  /** The value now, shown while the argument is typed and put in with Tab. */
  current?: () => string | null;
  /** The value restored by resetting this control. */
  defaultValue?: () => string;
  /** Why this argument will not do, before Enter. */
  check?: (arg: string) => string | null;
  /** What this argument will touch ("steps 3 to 7, 5 steps"). */
  describe?: (arg: string) => string | null;
}

export type CommandOutcome = string | void | { problem: string };

export type HandlerLookup = (name: string) => CommandHandler | undefined;

// ── reading what is typed ──────────────────────────────────────────────────────────────────────────────────────────

/** A command line: its name (without the slash) and its argument, and whether a space ended the name. */
export function parseLine(line: string): { name: string; arg: string; named: boolean } {
  const text = line.replace(/^\s*\/?/, '');
  const space = text.search(/\s/);
  if (space < 0) return { name: text, arg: '', named: false };
  return { name: text.slice(0, space), arg: text.slice(space).trim(), named: true };
}

/** The command a typed name stands for: a short form as typed, else a name in any case, else a number as /step. */
export function findCommand(name: string): CommandSpec | null {
  if (!name) return null;
  const byAlias = COMMANDS.find((command) => command.aliases?.includes(name));
  if (byAlias) return byAlias;
  const lower = name.toLowerCase();
  const byName = COMMANDS.find((command) => command.name === lower);
  if (byName) return byName;
  if (/^\d+$/.test(name)) return COMMANDS.find((command) => command.name === 'step') ?? null;
  return null;
}

/** "1:23", "1:02:03" or "83.5" (seconds) as milliseconds. */
export function parseTime(text: string): number | null {
  const parts = text.trim().split(':');
  if (!parts.length || parts.length > 3 || parts.some((part) => !/^\d+(\.\d+)?$/.test(part))) return null;
  const seconds = parts.reduce((total, part) => total * 60 + Number(part), 0);
  const milliseconds = Math.round(seconds * 1000);
  return Number.isSafeInteger(milliseconds) ? milliseconds : null;
}

/** "+5", "-3" or "5" as a number of frames; nothing typed is one forward. */
export function parseFrames(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return 1;
  const frames = Number(trimmed);
  return /^[+-]?\d+$/.test(trimmed) && Number.isSafeInteger(frames) ? frames : null;
}

/** "3-7, 9" or "3,5,9" as the numbers, in order and once each; null when it is not such a list. */
export function parseStepList(text: string): number[] | null {
  const pieces = text.trim().replace(/\s*-\s*/g, '-').split(/[,\s]+/).filter(Boolean);
  if (!pieces.length) return null;
  const numbers = new Set<number>();
  for (const piece of pieces) {
    const range = /^(\d+)(?:-(\d+))?$/.exec(piece);
    if (!range) return null;
    const from = Number(range[1]);
    const to = range[2] === undefined ? from : Number(range[2]);
    const [low, high] = from <= to ? [from, to] : [to, from];
    if (!Number.isSafeInteger(high) || high - low > 10_000) return null;
    for (let value = low; value <= high; value += 1) numbers.add(value);
    if (numbers.size > 10_001) return null;
  }
  return [...numbers];
}

/** Resolve the opening screen, or numbers in the step or candidate namespace. */
export function parseStepReference(text: string): { numbers: number[]; candidates: boolean } | null {
  const value = text.trim().toLowerCase();
  const candidates = /^candidates?\s+/.test(value);
  const numbers = parseStepList(value.replace(/^candidates?\s+/, '').replace(/\bstart\b/g, '0'));
  return numbers ? { numbers, candidates } : null;
}

/** A choice typed in full, or the beginning of exactly one choice. */
export function matchChoice(text: string, choices: readonly string[]): string | null {
  const lower = text.trim().toLowerCase();
  if (!lower) return null;
  const exact = choices.filter((choice) => choice.toLowerCase() === lower);
  if (exact.length) return exact.find((choice) => choice === text.trim()) ?? (exact.length === 1 ? exact[0] : null);
  const starting = choices.filter((choice) => choice.toLowerCase().startsWith(lower));
  return starting.length === 1 ? starting[0] : null;
}

function formatBound(value: number): string {
  return Number.isInteger(value) ? value.toLocaleString('en-GB') : String(value);
}

/** Why an argument will not do for the command, from what it takes; null when it will (or the handler is to say). */
export function argProblem(spec: CommandSpec, arg: string, choices: readonly string[]): string | null {
  const take = spec.arg;
  if (!take) return arg ? `/${spec.name} takes nothing after it` : null;
  if (!arg) return take.optional ? null : `/${spec.name} needs ${take.label}`;
  switch (take.kind) {
    case 'choice': {
      if (matchChoice(arg, choices)) return null;
      if (choices.some((choice) => choice.toLowerCase().startsWith(arg.toLowerCase()))) return 'choose a match with the arrow keys or type its full name';
      const examples = choices.length > SUGGESTIONS ? choices.slice(0, SUGGESTIONS).join(', ') + ', …' : choices.join(', ');
      return `${arg} is not one of: ${examples}`;
    }
    case 'number': {
      if (take.fit && 'fit'.startsWith(arg.toLowerCase())) return null;
      const value = Number(arg.replace(/\s*(ms|%|px|fps)$/i, ''));
      if (!Number.isFinite(value)) return `${arg} is not a number`;
      if (take.min !== undefined && value < take.min) return `at least ${formatBound(take.min)}${take.unit ? ` ${take.unit}` : ''}`;
      if (take.max !== undefined && value > take.max) return `at most ${formatBound(take.max)}${take.unit ? ` ${take.unit}` : ''}`;
      return null;
    }
    case 'time':
      return parseTime(arg) === null ? 'a time, as 1:23 or 83.5' : null;
    case 'frames':
      return parseFrames(arg) === null ? 'a number of frames, as +5 or -3' : null;
    case 'steps':
      if (take.choices && matchChoice(arg, take.choices)) return null;
      return parseStepReference(arg) === null ? 'step numbers, as 12, 3-7 or 3,5,9' : null;
    default:
      return null;
  }
}

/** A number argument as a number ("450", "450 ms"), or "fit" as null. */
export function argNumber(arg: string): number | null {
  if ('fit'.startsWith(arg.trim().toLowerCase()) && arg.trim()) return null;
  return Number(arg.replace(/\s*(ms|%|px|fps)$/i, ''));
}

// ── completing what is typed ───────────────────────────────────────────────────────────────────────────────────────

export interface Suggestion {
  /** The line the bar holds once this is taken (Tab, or Enter on it). */
  line: string;
  /** What the list shows, in the mono face: "/accept ‹steps›", or a choice. */
  label: string;
  /** Short forms shown under the command name. */
  aliases?: readonly string[];
  /** A few words, in Inter. */
  note: string;
  /** Not usable here: shown dimmed, with where it is. */
  elsewhere?: string;
}

export interface BarState {
  /** Commands while the name is typed; the argument's choices once it is followed by a space. */
  mode: 'commands' | 'argument';
  spec: CommandSpec | null;
  items: Suggestion[];
  /** The rest of the best match, shown in grey after what is typed and added with Tab. */
  ghost: string;
  /** What the argument takes, and the value now ("milliseconds, 100 to 10,000 ms; now 450"). */
  hint: string | null;
  /** What the argument will touch. */
  detail: string | null;
  /** Why Enter will not run it, when it will not. */
  problem: string | null;
}

/** How many suggestions the list shows at most. */
export const SUGGESTIONS = 8;

export function argTemplate(spec: CommandSpec): string {
  if (!spec.arg) return `/${spec.name}`;
  return spec.arg.optional ? `/${spec.name} [‹${spec.arg.label}›]` : `/${spec.name} ‹${spec.arg.label}›`;
}

export function choicesOf(spec: CommandSpec, handler: CommandHandler | undefined): Array<{ value: string; note?: string; suggest?: boolean }> {
  const own = (spec.arg?.choices ?? (spec.arg?.fit ? ['fit'] : [])).map((value) => ({ value }));
  const more = handler?.choices?.() ?? [];
  const seen = new Set<string>();
  return [...more, ...own].filter((choice) => {
    const key = choice.value;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function numberHint(take: ArgSpec): string {
  const unit = take.unit ? ` ${take.unit}` : '';
  const range =
    take.min !== undefined && take.max !== undefined ? `${formatBound(take.min)} to ${formatBound(take.max)}${unit}` : take.label;
  return take.fit ? `${range}, or fit` : range;
}

/** What the bar shows for a line: the suggestions, the grey rest of the best one, and what the argument needs. */
export function barState(line: string, lookup: HandlerLookup): BarState {
  const { name, arg, named } = parseLine(line);
  const spec = named || /^\d+$/.test(name) ? findCommand(name) : null;

  if (!spec || (!named && !/^\d+$/.test(name))) {
    // the name is being typed: commands that start with it, those usable here first
    const lower = name.toLowerCase();
    const matching = COMMANDS.filter(
      (command) =>
        command.name.startsWith(lower) ||
        command.aliases?.some((alias) => alias === name || (name.length > 0 && alias.toLowerCase().startsWith(lower))),
    );
    const exact = matching.filter((command) => command.name === lower || command.aliases?.includes(name));
    const prefixes = matching.filter((command) => !exact.includes(command));
    if (name) {
      prefixes.sort((a, b) =>
        Number(b.name.startsWith(lower)) - Number(a.name.startsWith(lower)) || a.name.length - b.name.length,
      );
    }
    const ordered = [...exact, ...prefixes];
    const here = ordered.filter((command) => lookup(command.name));
    // elsewhere only once something is typed, and only when nothing here matches it as well
    const away = name.length >= 2 ? ordered.filter((command) => !lookup(command.name)).slice(0, here.length ? 2 : 4) : [];
    const items: Suggestion[] = [...here, ...away]
      .slice(0, name ? SUGGESTIONS : COMMANDS.length)
      .map((command) => ({
        line: `/${command.name}${command.arg ? ' ' : ''}`,
        label: argTemplate(command),
        aliases: command.aliases,
        note: command.summary,
        elsewhere: away.includes(command) ? GROUP_PLACE[command.group] : undefined,
      }));
    const best = here[0];
    const ghost = best && best.name.startsWith(lower) && name ? best.name.slice(lower.length) : '';
    const typed = findCommand(name);
    const problem = !name
      ? null
      : typed && !lookup(typed.name)
        ? `/${typed.name} works ${GROUP_PLACE[typed.group]}`
        : !matching.length
          ? `there is no /${name}`
          : null;
    return { mode: 'commands', spec: typed, items, ghost, hint: null, detail: null, problem };
  }

  const handler = lookup(spec.name);
  if (!handler) {
    return {
      mode: 'argument',
      spec,
      items: [],
      ghost: '',
      hint: null,
      detail: null,
      problem: `/${spec.name} works ${GROUP_PLACE[spec.group]}`,
    };
  }

  // the argument: a number alone (/30) is the argument of /step
  const shorthand = /^\d+$/.test(name) && spec.name === 'step';
  const value = shorthand ? name : arg;
  const head = shorthand ? '/step ' : `/${name} `;
  const choices = choicesOf(spec, handler);
  const take = spec.arg;
  const current = handler.current?.() ?? null;
  const defaultValue = handler.defaultValue?.();
  let items: Suggestion[] = [];
  let ghost = '';
  let hint: string | null = null;
  if (take) {
    if (take.kind === 'choice' || (take.kind === 'steps' && take.choices) || choices.length) {
      const lower = value.toLowerCase();
      const fitting = choices.filter((choice) => (value || choice.suggest !== false) && choice.value.toLowerCase().startsWith(lower));
      items = fitting.slice(0, SUGGESTIONS).map((choice) => ({
        line: `${head}${choice.value}`,
        label: choice.value,
        note: choice.note ?? (current !== null && choice.value === current ? 'now' : ''),
      }));
      ghost = value && line.endsWith(value) && fitting[0] ? fitting[0].value.slice(value.length) : '';
    }
    if (take.kind === 'number') hint = numberHint(take);
    else if (take.kind !== 'choice') hint = take.label;
    if (take.optional && !value && take.kind !== 'text') hint = hint ? `${hint}; or nothing` : null;
    if (current !== null && take.kind !== 'choice') hint = `${hint ?? take.label}; now ${current}`;
    if (defaultValue !== undefined) hint = `${hint ?? take.label}; default ${defaultValue}`;
  }
  const options = choices.map((choice) => choice.value);
  const taken = take?.kind === 'choice' || take?.kind === 'steps' ? matchChoice(value, options) ?? value : value;
  const problem = shorthand && arg ? `/${name} takes nothing after it` : argProblem(spec, value, options) ?? handler.check?.(taken) ?? null;
  const detail = !problem ? handler.describe?.(taken) ?? null : null;
  return { mode: 'argument', spec, items, ghost, hint, detail, problem };
}

/** The keyboard shortcuts, for /keys. */
export const KEYS: ReadonlyArray<[string, string]> = [
  ['/', 'the command bar'],
  ['a, r, u', 'accept, reject, or reset the active step'],
  ['x, shift+x', 'select the active step, or a range'],
  ['← →', 'the step before or after'],
  ['p', 'play the video from the active step'],
  ['shift+F10', 'a menu of every action on the active step'],
  ['space', 'play or pause the video'],
  [', .', 'a frame back or forward'],
  ['k', 'add a step at this moment of the video'],
  ['esc', 'clear the selection, or close'],
];
