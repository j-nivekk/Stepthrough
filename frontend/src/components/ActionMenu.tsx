import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { isCommandBarInput } from '../lib/utils';

/** The part of the window a menu keeps to, such as the pathway's canvas. */
export interface MenuBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface ActionItem {
  label: string;
  hint?: string;
  /** Optional small screenshot thumbnail shown to the left of screen or step titles. */
  thumb?: string;
  run?: () => void;
  items?: ActionItem[];
  danger?: boolean;
  /** Shown, but not to be chosen: it would change nothing. */
  disabled?: boolean;
  /** Draws a thin rule above this item to separate groups in a menu or submenu. */
  divider?: boolean;
}

/** Clamps a floating menu rectangle to stay completely visible inside its bounds (or the viewport if narrower). */
function clampMenuBounds(width: number, height: number, bounds?: MenuBounds) {
  const viewLeft = 8;
  const viewRight = window.innerWidth - 8;
  const viewTop = 8;
  const viewBottom = window.innerHeight - 8;
  const useCanvasX = Boolean(bounds && bounds.right - bounds.left >= width);
  return {
    minLeft: useCanvasX && bounds ? bounds.left : viewLeft,
    maxRight: useCanvasX && bounds ? bounds.right : viewRight,
    minTop: viewTop,
    maxBottom: viewBottom,
    width,
    height,
  };
}

/** Actions as a menu, at the pointer; an item with items of its own opens them beside it. */
export function ActionMenu({
  items,
  heading,
  x,
  y,
  flipY,
  bounds,
  onClose,
}: {
  items: ActionItem[];
  /** What the actions are for, when that is more than what was clicked: "4 selected steps". */
  heading?: string;
  x: number;
  y: number;
  flipY?: number;
  bounds?: MenuBounds;
  onClose: () => void;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const [openAnchor, setOpenAnchor] = useState<HTMLElement | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y });
  const bLeft = bounds?.left;
  const bRight = bounds?.right;
  const bTop = bounds?.top;
  const bBottom = bounds?.bottom;
  // Keep the menu completely visible inside its bounds & the viewport (flipping left/up when near edges).
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const box = element.getBoundingClientRect();
    const rectBounds =
      bLeft !== undefined && bRight !== undefined && bTop !== undefined && bBottom !== undefined
        ? { left: bLeft, right: bRight, top: bTop, bottom: bBottom }
        : undefined;
    const { minLeft, maxRight, minTop, maxBottom } = clampMenuBounds(box.width, box.height, rectBounds);
    let left = x;
    if (left + box.width > maxRight) {
      const flipped = x - box.width;
      left = flipped >= minLeft ? flipped : maxRight - box.width;
    }
    left = Math.round(Math.max(minLeft, Math.min(left, Math.max(minLeft, maxRight - box.width))));
    let top = y;
    if (top + box.height > maxBottom) {
      top = flipY !== undefined && flipY - box.height >= minTop ? flipY - box.height : maxBottom - box.height;
    }
    top = Math.round(Math.max(minTop, Math.min(top, Math.max(minTop, maxBottom - box.height))));
    setPos((current) => (current.left === left && current.top === top ? current : { left, top }));
  }, [x, y, flipY, bLeft, bRight, bTop, bBottom, items.length]);
  /** Whether the open submenu was opened with the keyboard, and so takes the focus. */
  const [byKey, setByKey] = useState(false);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, []);

  function onKey(event: KeyboardEvent<HTMLDivElement>) {
    // Keys pressed in the menu stay in it: the page's own (P, A, Enter, the arrows) would act on what is behind it.
    event.stopPropagation();
    const submenu = document.activeElement instanceof Element ? document.activeElement.closest('.pathway-submenu') : null;
    const scope = submenu ?? ref.current;
    const buttons = [...(scope?.querySelectorAll<HTMLButtonElement>(':scope > div > button:not(:disabled)') ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const current = submenu ? -1 : Number((document.activeElement as HTMLElement | null)?.dataset.item ?? -1);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length];
      next?.focus();
    } else if (event.key === 'ArrowRight' && items[current]?.items) {
      event.preventDefault();
      setByKey(true);
      setOpenAnchor((document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.pathway-menu-row') ?? null);
      setOpen(current);
    } else if (event.key === 'ArrowLeft' && submenu) {
      event.preventDefault();
      submenu.parentElement?.querySelector<HTMLButtonElement>(':scope > button')?.focus();
      setOpen(null);
      setOpenAnchor(null);
    } else if (event.key === 'Escape') {
      onClose();
    }
  }

  return (
    <div
      className="pathway-menu"
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={onKey}
      onMouseDown={(event) => event.preventDefault()} // the focus stays in the menu, also after a click beside the items
      onPointerDown={(event) => event.stopPropagation()}
      ref={ref}
      role="menu"
      style={{ left: pos.left, top: pos.top }}
    >
      {heading ? <p className="pathway-menu-heading">{heading}</p> : null}
      {items.map((item, index) => (
        <div
          className="pathway-menu-row"
          key={item.label}
          onPointerEnter={(event) => {
            setByKey(false);
            const opens = item.items && !item.disabled;
            setOpen(opens ? index : null);
            setOpenAnchor(opens ? event.currentTarget : null);
          }}
        >
          {item.divider ? <div aria-hidden="true" className="pathway-menu-divider" /> : null}
          <button
            aria-expanded={item.items ? open === index : undefined}
            aria-haspopup={item.items ? 'menu' : undefined}
            className={`pathway-menu-item ${item.danger ? 'is-danger' : ''}`}
            data-item={index}
            disabled={item.disabled}
            onClick={(event) => {
              if (item.items) {
                // Enter or Space (a click with no pointer) opens it with its first item in focus.
                setByKey(event.detail === 0);
                const nextOpen = open === index ? null : index;
                setOpen(nextOpen);
                setOpenAnchor(nextOpen !== null ? event.currentTarget.closest<HTMLElement>('.pathway-menu-row') : null);
                return;
              }
              onClose();
              item.run?.();
            }}
            role="menuitem"
            title={item.label}
            type="button"
          >
            <span className="pathway-menu-main">
              {item.thumb ? <img alt="" className="pathway-menu-thumb" loading="lazy" src={item.thumb} /> : null}
              <span className="pathway-menu-label">{item.label}</span>
            </span>
            <span className="pathway-menu-hint">{item.items ? '▸' : item.hint ?? ''}</span>
          </button>
          {item.items && open === index ? (
            <ActionSubmenu anchor={openAnchor} bounds={bounds} focusFirst={byKey} items={item.items} onClose={onClose} />
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** The items of a menu item, placed fixed beside its parent row and clamped strictly inside the bounds & viewport. */
function ActionSubmenu({
  anchor,
  bounds,
  focusFirst,
  items,
  onClose,
}: {
  anchor: HTMLElement | null;
  bounds?: MenuBounds;
  focusFirst: boolean;
  items: ActionItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>(() => {
    const row = anchor?.getBoundingClientRect();
    return row ? { left: row.right + 2, top: row.top - 4 } : { left: 8, top: 8 };
  });
  const bLeft = bounds?.left;
  const bRight = bounds?.right;
  const bTop = bounds?.top;
  const bBottom = bounds?.bottom;
  useLayoutEffect(() => {
    const element = ref.current;
    const row = anchor?.getBoundingClientRect();
    if (!element || !row) return;
    const box = element.getBoundingClientRect();
    const rectBounds =
      bLeft !== undefined && bRight !== undefined && bTop !== undefined && bBottom !== undefined
        ? { left: bLeft, right: bRight, top: bTop, bottom: bBottom }
        : undefined;
    const { minLeft, maxRight, minTop, maxBottom } = clampMenuBounds(box.width, box.height, rectBounds);
    let left = row.right + 2;
    if (left + box.width > maxRight) {
      const flipped = row.left - box.width - 2;
      left = flipped >= minLeft ? flipped : maxRight - box.width;
    }
    left = Math.round(Math.max(minLeft, Math.min(left, Math.max(minLeft, maxRight - box.width))));
    const top = Math.round(Math.max(minTop, Math.min(row.top - 4, Math.max(minTop, maxBottom - box.height))));
    setPos((current) => (current.left === left && current.top === top ? current : { left, top }));
  }, [anchor, bLeft, bRight, bTop, bBottom, items.length]);
  useEffect(() => {
    if (focusFirst) ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [focusFirst]);
  return (
    <div
      className="pathway-menu pathway-submenu"
      ref={ref}
      role="menu"
      style={{ left: pos.left, top: pos.top }}
    >
      {items.map((child) => (
        <div className="pathway-menu-row" key={child.label}>
          {child.divider ? <div aria-hidden="true" className="pathway-menu-divider" /> : null}
          <button
            className="pathway-menu-item"
            disabled={child.disabled}
            onClick={() => {
              onClose();
              child.run?.();
            }}
            role="menuitem"
            title={child.label}
            type="button"
          >
            <span className="pathway-menu-main">
              {child.thumb ? <img alt="" className="pathway-menu-thumb" loading="lazy" src={child.thumb} /> : null}
              <span className="pathway-menu-label">{child.label}</span>
            </span>
            {child.hint ? <span className="pathway-menu-hint">{child.hint}</span> : null}
          </button>
        </div>
      ))}
    </div>
  );
}

/** A menu on its own, at the pointer: over the page, and gone with a click elsewhere, a scroll or Escape. */
export function FloatingActionMenu({ items, heading, x, y, onClose }: { items: ActionItem[]; heading?: string; x: number; y: number; onClose: () => void }) {
  // The focus goes back to where it was: before the action chosen, which may take it elsewhere.
  const [before] = useState(() => document.activeElement);
  const goBack = useCallback(() => {
    if (before instanceof HTMLElement && before.isConnected) before.focus({ preventScroll: true });
  }, [before]);
  const withFocus = (item: ActionItem): ActionItem => ({
    ...item,
    items: item.items?.map(withFocus),
    run: item.run && (() => {
      goBack();
      item.run?.();
    }),
  });
  useEffect(() => {
    const inside = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest('.pathway-menu'));
    const closeOutside = (event: Event) => {
      if (!inside(event.target)) onClose();
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || isCommandBarInput(event.target)) return;
      event.stopPropagation(); // it closes the menu, and leaves the selection behind it
      goBack();
      onClose();
    };
    // Only the page itself: the gallery's filmstrip moves on its own, to the thumbnail the menu is for.
    const closeOnScroll = (event: Event) => {
      if (event.target === document) onClose();
    };
    window.addEventListener('pointerdown', closeOutside, true);
    window.addEventListener('wheel', closeOutside, { capture: true, passive: true });
    window.addEventListener('scroll', closeOnScroll, true);
    window.addEventListener('resize', onClose);
    document.addEventListener('keydown', closeOnEscape, true);
    return () => {
      window.removeEventListener('pointerdown', closeOutside, true);
      window.removeEventListener('wheel', closeOutside, true);
      window.removeEventListener('scroll', closeOnScroll, true);
      window.removeEventListener('resize', onClose);
      document.removeEventListener('keydown', closeOnEscape, true);
    };
  }, [goBack, onClose]);
  // anew wherever it is opened, so the first item has the focus again
  return createPortal(<ActionMenu heading={heading} items={items.map(withFocus)} key={`${x},${y}`} onClose={onClose} x={x} y={y} />, document.body);
}
