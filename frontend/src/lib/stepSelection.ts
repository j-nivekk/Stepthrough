// Choosing several steps of the step review to act on at once (accept, reject or reset them). The choice is made among
// the steps shown, in their order: a box toggles one step, shift with a box sets every step from the last one clicked
// to this one, and all, none and invert act on the shown steps. Pure functions, so they can be tested without a
// browser.

/** The selection kept to the steps shown, in their order. */
export function keepShown(selected: string[], shown: string[]): string[] {
  const chosen = new Set(selected);
  return shown.filter((id) => chosen.has(id));
}

/**
 * The selection after a click on a step's box. Without shift it toggles that step. With shift, and a step clicked
 * before (`anchor`) still shown, every step from that one to this one is set to what this one becomes, as in a mail
 * program: selected when it was not, cleared when it was.
 */
export function clickSelection(selected: string[], shown: string[], id: string, anchor: string | null, shift: boolean): string[] {
  const chosen = new Set(selected);
  const select = !chosen.has(id);
  const from = anchor ? shown.indexOf(anchor) : -1;
  const to = shown.indexOf(id);
  if (shift && from >= 0 && to >= 0) {
    const [start, end] = from <= to ? [from, to] : [to, from];
    for (const each of shown.slice(start, end + 1)) {
      if (select) chosen.add(each);
      else chosen.delete(each);
    }
  } else if (select) {
    chosen.add(id);
  } else {
    chosen.delete(id);
  }
  return keepShown([...chosen], shown);
}

/** Every shown step that is not selected, and none that is. */
export function invertSelection(selected: string[], shown: string[]): string[] {
  const chosen = new Set(selected);
  return shown.filter((id) => !chosen.has(id));
}

/** What a box over all the shown steps says: all of them selected, some, or none. */
export function selectionState(selected: string[], shown: string[]): 'all' | 'some' | 'none' {
  const count = keepShown(selected, shown).length;
  if (!count) return 'none';
  return count === shown.length ? 'all' : 'some';
}
