import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';

export interface ContextMenuState {
  id: string;
  x: number;
  y: number;
  alignRight?: boolean;
  anchorTop?: number;
}

export interface ContextMenuItem {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
  /** Afterwards focus returns to the trigger button (skip for rename, whose input takes focus, or delete dialogs). */
  refocus?: boolean;
  run: () => void;
}

/** Keeps the browser's native text menu while editing text inline. */
export function shouldIgnoreContextMenu(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('input, textarea'));
}

/** Whether a place in the window is on selected text, where the browser's own menu is to copy it with. */
export function onSelectedText(x: number, y: number): boolean {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.toString().trim()) return false;
  return [...selection.getRangeAt(0).getClientRects()].some((box) => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom);
}

/** Computes a floating menu anchor aligned to a row's `⋯` trigger (or the row itself) for keyboard ContextMenu / Shift+F10. */
export function keyboardMenuAnchor(row: HTMLElement, triggerSelector: string, id: string): ContextMenuState {
  const trigger = row.querySelector<HTMLElement>(triggerSelector);
  const rect = (trigger ?? row).getBoundingClientRect();
  return { id, x: rect.right, y: rect.bottom + 4, alignRight: true, anchorTop: rect.top - 4 };
}

/** Computes a floating menu anchor from a clicked `⋯` trigger button. */
export function triggerMenuAnchor(button: HTMLElement, id: string): ContextMenuState {
  const rect = button.getBoundingClientRect();
  return { id, x: rect.right, y: rect.bottom + 4, alignRight: true, anchorTop: rect.top - 4 };
}

export interface ContextMenuProps {
  alignRight?: boolean;
  anchorTop?: number;
  className?: string;
  items: ContextMenuItem[];
  onClose: (refocus?: boolean) => void;
  /** Selector for the `⋯` button that opened this menu, so clicking it toggles closed rather than re-opening. */
  triggerSelector?: string;
  x: number;
  y: number;
}

/** Compact floating context menu, matching PathwayMenu's visual language at list scale. */
export function ContextMenu({
  alignRight = false,
  anchorTop,
  className,
  items,
  onClose,
  triggerSelector,
  x,
  y,
}: ContextMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number }>({ left: x, top: y });

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const { width, height } = element.getBoundingClientRect();
    const rawLeft = alignRight ? x - width : x;
    const flippedLeft = rawLeft + width > window.innerWidth - 8 ? x - width : rawLeft;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, flippedLeft));
    const flippedTop = y + height > window.innerHeight - 8 ? (anchorTop ?? y) - height : y;
    const top = Math.max(8, Math.min(window.innerHeight - height - 8, flippedTop));
    setPosition({ left, top });
  }, [x, y, alignRight, anchorTop]);

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [x, y]);

  useEffect(() => {
    const close = () => onClose(false);
    function handlePointerDown(event: globalThis.PointerEvent) {
      const target = event.target instanceof Element ? event.target : null;
      if (ref.current?.contains(target)) return;
      if (triggerSelector && target?.closest(triggerSelector)) return;
      onClose(false);
    }
    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose(true);
      }
    }
    window.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose, triggerSelector]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // Keys pressed in the menu stay in the menu, rather than triggering page shortcuts behind it.
    event.stopPropagation();
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    if (!buttons.length) return;
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const nextIndex = index < 0 ? (step > 0 ? 0 : buttons.length - 1) : (index + step + buttons.length) % buttons.length;
      buttons[nextIndex]?.focus();
    } else if (event.key === 'Home') {
      event.preventDefault();
      buttons[0]?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      buttons[buttons.length - 1]?.focus();
    } else if (event.key === 'Escape') {
      onClose(true);
    }
  }

  return (
    <div
      className={className ? `pathway-menu is-compact ${className}` : 'pathway-menu is-compact'}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={handleKeyDown}
      onPointerDown={(event) => event.stopPropagation()}
      ref={ref}
      role="menu"
      style={{ left: position.left, top: position.top }}
    >
      {items.map((item) => (
        <div className="pathway-menu-row" key={item.label}>
          <button
            className={`pathway-menu-item ${item.danger ? 'is-danger' : ''}`}
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return;
              onClose(item.refocus);
              item.run();
            }}
            role="menuitem"
            title={item.title}
            type="button"
          >
            <span>{item.label}</span>
          </button>
        </div>
      ))}
    </div>
  );
}
