'use strict';
/*
 * The kit every mock app of the web tester is made with: a clock, a person to use the app (pointer, finger, keyboard),
 * screens, overlays, panes that scroll, and a log of what is on the screen.
 *
 * Three ways to run it (?mode=):
 *   record  the recorder (webrec.py) turns the clock, frame by frame, so a frame's time is exact however long drawing
 *           it takes, and the same recording can be made again anywhere
 *   play    the script plays by itself, in real time, to watch
 *   free    a person uses the app, in any browser, and downloads the log afterwards
 *
 * In all three the app says what it shows (`Kit.snapshot`), so what a recording should give follows from the log and
 * not from anybody's eye: which screen it is, what lies over it, how far every pane is scrolled, what is in the fields,
 * and what is moving. See webtruth.py.
 */

const h = (spec, props, ...kids) => {
  const [, tag, rest] = /^([a-z0-9]*)(.*)$/i.exec(spec);
  const el = document.createElement(tag || 'div');
  for (const part of rest.match(/[.#][^.#]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1));
    else el.id = part.slice(1);
  }
  if (props !== undefined && (props === null || typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    kids.unshift(props);
    props = null;
  }
  for (const [key, value] of Object.entries(props || {})) {
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'style') el.style.cssText = value;
    else if (key === 'html') el.innerHTML = value;
    else if (key.includes('-') || !(key in el)) el.setAttribute(key, value);
    else el[key] = value;
  }
  el.append(...kids.flat(9).filter((kid) => kid !== null && kid !== undefined && kid !== false));
  return el;
};

const Kit = (() => {
  const params = new URLSearchParams(location.search);
  const K = {
    mode: params.get('mode') || 'play',
    device: params.get('device') || (Math.min(innerWidth, screen.width) < 600 ? 'phone' : 'computer'),
    scenario: params.get('scenario'),
    seed: Number(params.get('seed') || 1),
    apps: {},
  };
  K.phone = K.device === 'phone';
  const $ = (selector) => (selector instanceof Element ? selector : document.querySelector(selector));
  K.$ = $;

  // ── chance, the same every time ──
  let state32 = (K.seed * 2654435761) >>> 0;
  const random = () => {
    state32 = (state32 + 0x6d2b79f5) >>> 0;
    let t = state32;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  K.random = random;
  K.between = (low, high) => low + (high - low) * random();
  K.whole = (low, high) => Math.floor(K.between(low, high + 1));
  K.pick = (list) => list[Math.floor(random() * list.length)];
  const made = new Map();
  /** Something left to chance once, and the same whenever the screen is drawn again. */
  K.fixed = (key, make) => {
    if (!made.has(key)) made.set(key, make());
    return made.get(key);
  };
  K.shuffle = (list) => list.map((item) => [random(), item]).sort((a, b) => a[0] - b[0]).map(([, item]) => item);

  // ── the clock ──
  let now = 0;
  let order = 0;
  const queue = [];
  const tweens = new Set();
  const loops = new Map();
  const held = new WeakMap();
  let dirty = true;
  K.now = () => now;
  K.touch = () => { dirty = true; };
  K.after = (ms, run) => {
    queue.push({ at: now + ms, order: order++, run });
    queue.sort((a, b) => a.at - b.at || a.order - b.order);
  };
  K.wait = (ms) => new Promise((resolve) => K.after(ms, resolve));
  const ease = {
    linear: (p) => p,
    inOut: (p) => (p < 0.5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2),
    out: (p) => 1 - (1 - p) ** 3,
    spring: (p) => 1 - Math.exp(-6 * p) * Math.cos(5 * p) * (1 - p),
  };
  K.ease = ease;
  /** Runs `draw` with 0 to 1 over a time. `kind` says what moves; "noise" is nothing the person did or the app means. */
  K.tween = (kind, ms, draw, curve = ease.inOut) =>
    new Promise((done) => {
      draw(0);
      tweens.add({ kind, start: now, ms, draw, curve, done });
    });
  /** Something that never stops moving: `draw(now)` every frame while its element is on the page. */
  K.loop = (id, element, draw) => { loops.set(id, { element, draw }); };
  const flush = () => new Promise((resolve) => { const channel = new MessageChannel(); channel.port1.onmessage = () => resolve(); channel.port2.postMessage(0); });

  function runTweens() {
    for (const tween of [...tweens]) {
      const p = Math.min(1, (now - tween.start) / tween.ms);
      tween.draw(tween.curve(p));
      dirty = true;
      if (p >= 1) {
        tweens.delete(tween);
        tween.done();
      }
    }
  }

  /** CSS transitions and animations, moved on by hand so that they keep to the clock. */
  function scrub(dt) {
    for (const animation of document.getAnimations()) {
      const end = animation.effect.getComputedTiming().endTime;
      if (!held.has(animation)) {
        animation.pause();
        animation.currentTime = 0;
        held.set(animation, 0);
        dirty = true;
        continue;
      }
      const at = held.get(animation) + dt;
      held.set(animation, at);
      dirty = true;
      if (Number.isFinite(end) && at >= end) animation.finish();
      else animation.currentTime = at;
    }
  }

  async function advance(dt) {
    const target = now + dt;
    while (queue.length && queue[0].at <= target) {
      const item = queue.shift();
      now = Math.max(now, item.at);
      item.run();
      dirty = true;
      await flush();
    }
    now = target;
    runTweens();
    await flush();
    if (K.mode === 'record') scrub(dt);
    for (const [id, loop] of loops) {
      if (!loop.element.isConnected) loops.delete(id);
      else {
        loop.draw(now);
        dirty = true;
      }
    }
    hover();
    caret();
    await flush();
  }

  // ── what is on the screen ──
  let screenId = '';
  const overlays = [];
  const marks = {};
  const content = {};
  const streams = new Set();
  const events = [];
  K.event = (kind, detail = {}) => events.push({ t: Math.round(now), kind, ...detail });
  /** The screen shown is now this one. `how`: "swipe" for the next card of a feed, otherwise a navigation. */
  K.at = (id, how = 'cut') => {
    if (id === screenId) return;
    K.event(how === 'swipe' ? 'feed_swap' : 'navigation', { from: screenId, to: id, how });
    screenId = id;
  };
  K.screen = () => screenId;
  /** Something small on the screen that is part of its state: a switch, a badge, what is folded open. */
  K.set = (key, value, kind = 'small') => {
    if (marks[key] === value) return;
    if (marks[key] !== undefined || kind !== 'silent') K.event(kind === 'silent' ? 'small' : kind, { key, value });
    marks[key] = value;
  };
  K.unset = (key) => { delete marks[key]; };
  /** What has come in: "loading", then "loaded", or the number of characters of an answer so far. */
  K.came = (key, value, kind = 'load') => {
    if (content[key] === value) return;
    if (kind !== 'silent') K.event(kind, { key, value });
    content[key] = value;
  };
  K.gone = (key) => { delete content[key]; };

  const shown = (element) => {
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < innerHeight && box.right > 0 && box.left < innerWidth;
  };
  const area = (element) => {
    const box = element.getBoundingClientRect();
    const left = Math.max(0, box.left);
    const top = Math.max(0, box.top);
    return [Math.round(left), Math.round(top), Math.round(Math.min(innerWidth, box.right) - left), Math.round(Math.min(innerHeight, box.bottom) - top)];
  };

  K.snapshot = () => {
    const panes = {};
    const fields = {};
    const areas = {};
    for (const pane of document.querySelectorAll('[data-pane]')) {
      if (!shown(pane)) continue;
      panes[pane.dataset.pane] = [Math.round(pane.scrollLeft), Math.round(pane.scrollTop)];
      areas[`pane ${pane.dataset.pane}`] = area(pane);
    }
    for (const field of document.querySelectorAll('[data-field]')) {
      if (!shown(field)) continue;
      fields[field.dataset.field] = field.value;
      areas[`field ${field.dataset.field}`] = area(field);
    }
    for (const overlay of overlays) if (overlay.element.isConnected) areas[`overlay ${overlay.id}`] = area(overlay.box);
    const turning = [];
    for (const element of document.querySelectorAll('[data-loop]')) {
      if (!shown(element)) continue;
      turning.push(element.dataset.loop);
      areas[`loop ${element.dataset.loop}`] = area(element);
    }
    const moving = new Set([...tweens].map((tween) => tween.kind));
    for (const animation of document.getAnimations()) {
      const target = animation.effect.target;
      if (animation.playState === 'finished' || !Number.isFinite(animation.effect.getComputedTiming().endTime)) continue;
      if (target && !target.closest('[data-noise]')) moving.add(target.closest('[data-layer]') ? 'overlay' : 'animation');
    }
    if (K.mode === 'free' && performance.now() - scrolledAt < 120) moving.add('scroll');
    if (flashing) moving.add('flash');
    const noise = moving.delete('noise');
    return {
      t: Math.round(now),
      screen: screenId,
      overlays: overlays.filter((overlay) => !overlay.leaving).map(({ id, kind, dim }) => ({ id, kind, dim })),
      panes,
      fields,
      marks: { ...marks },
      content: { ...content },
      hover: hovered ? hovered.dataset.h : null,
      pointer: pointer.visible ? [Math.round(pointer.x), Math.round(pointer.y)] : null,
      loops: turning,
      streams: [...streams],
      moving: [...moving].sort(),
      noise,
      areas,
    };
  };

  // ── screens ──
  /** Puts a screen in a host element, in the way an app does. */
  K.show = async (host, id, build, how = 'cut') => {
    const next = h('div.screen');
    const previous = host.firstElementChild;
    const top = () => next.querySelectorAll('[data-keep]').forEach((pane) => { pane.scrollTop = kept[`${id} ${pane.dataset.pane}`] || 0; });
    if (previous) previous.querySelectorAll('[data-keep]').forEach((pane) => { kept[`${previous.dataset.id} ${pane.dataset.pane}`] = pane.scrollTop; });
    next.dataset.id = id;
    if (how === 'load') {
      // a page of the web: first nothing, then all of it, and the pictures last
      host.replaceChildren(next);
      K.at(id, how);
      K.came(`page ${id}`, 'loading', 'load');
      await K.wait(K.between(350, 1300));
      build(next);
      K.gone(`page ${id}`);
      K.event('load', { key: id });
      top();
      return;
    }
    build(next);
    if (how === 'push' || how === 'pop') {
      if (how === 'pop') host.insertBefore(next, previous);
      else host.append(next);
      top();
      K.at(id, how);
      const width = host.clientWidth;
      const [front, back] = how === 'push' ? [next, previous] : [previous, next];
      front.style.boxShadow = '-6px 0 24px rgba(0,0,0,.14)';
      await K.tween('navigation', 360, (p) => {
        const x = how === 'push' ? 1 - p : p;
        front.style.transform = `translateX(${x * width}px)`;
        back.style.transform = `translateX(${(x - 1) * width * 0.3}px)`;
      }, ease.out);
      front.style.boxShadow = '';
      next.style.transform = '';
      previous.remove();
    } else if (how === 'fade') {
      host.append(next);
      top();
      K.at(id, how);
      await K.tween('navigation', 240, (p) => { next.style.opacity = p; }, ease.linear);
      next.style.opacity = '';
      if (previous) previous.remove();
    } else {
      host.replaceChildren(next);
      top();
      K.at(id, how);
    }
  };
  const kept = {};

  // ── overlays ──
  /** kind: menu, submenu, popover, dialog, sheet, drawer, panel, toast, tooltip. Opens with a short animation. */
  K.open = ({ id, kind, dim = 0, at, width, build, className = '' }) => {
    const box = h(`div.overlay.${kind}`, { 'data-layer': '' });
    if (className) box.classList.add(...className.split(' '));
    if (width) box.style.width = `${width}px`;
    build(box);
    const layer = h('div.layer', { 'data-layer': '' }, dim ? h('div.scrim', { style: `--dim:${dim}`, onclick: () => K.close(id) }) : null, box);
    layer.dataset.kind = kind;
    $('#layers').append(layer);
    if (at) {
      const { width: w, height: t } = box.getBoundingClientRect();
      box.style.left = `${Math.round(Math.max(8, Math.min(at[0], innerWidth - w - 8)))}px`;
      box.style.top = `${Math.round(Math.max(8, Math.min(at[1], innerHeight - t - 8)))}px`;
    }
    overlays.push({ id, kind, dim: Boolean(dim), element: layer, box });
    if (kind !== 'tooltip' && kind !== 'toast') K.event('overlay_open', { id, overlay: kind, dim });
    else K.event(kind, { id });
    layer.offsetWidth; // so that the opening is a transition
    layer.classList.add('in');
    return box;
  };
  K.close = (id, done) => {
    const overlay = overlays.find((each) => each.id === id && !each.leaving);
    if (!overlay) return;
    overlay.leaving = true;
    if (overlay.kind !== 'tooltip' && overlay.kind !== 'toast') K.event('overlay_close', { id, overlay: overlay.kind });
    overlay.element.classList.remove('in');
    const ms = { menu: 110, submenu: 90, popover: 120, dialog: 190, sheet: 300, drawer: 280, panel: 180, toast: 220, tooltip: 90 }[overlay.kind];
    K.after(ms + 20, () => {
      overlay.element.remove();
      overlays.splice(overlays.indexOf(overlay), 1);
      if (done) done();
    });
  };
  K.isOpen = (id) => overlays.some((each) => each.id === id && !each.leaving);
  K.closeAll = () => [...overlays].reverse().forEach((overlay) => K.close(overlay.id));
  K.toast = (text, ms = 2200) => {
    const id = `toast ${Math.round(now)}`;
    K.open({ id, kind: 'toast', build: (box) => box.append(text) });
    K.after(ms, () => K.close(id));
  };

  // ── panes, and the scroll bar that shows for a moment ──
  let barPane = null;
  let barStill = 0;
  const showBar = (pane) => {
    if (K.mode !== 'record') return; // a real browser has its own
    const bar = $('#sbar');
    const box = pane.getBoundingClientRect();
    if (pane.scrollHeight <= pane.clientHeight + 1) return;
    const thumb = Math.max(36, (pane.clientHeight / pane.scrollHeight) * box.height);
    const top = box.top + (pane.scrollTop / (pane.scrollHeight - pane.clientHeight)) * (box.height - thumb - 6) + 3;
    bar.style.cssText = `left:${Math.min(innerWidth, box.right) - (K.phone ? 6 : 10)}px;top:${top}px;height:${thumb}px;width:${K.phone ? 3 : 7}px;opacity:1`;
    barPane = pane;
    const mine = ++barStill;
    K.after(900, () => {
      if (mine !== barStill) return;
      K.tween('noise', 260, (p) => { if (mine === barStill) bar.style.opacity = String(1 - p); }, ease.linear);
    });
  };
  K.scrollTo = (pane, y) => {
    pane.scrollTop = y;
    dirty = true;
    showBar(pane);
  };
  let scrolledAt = -1e9; // by a person, in their own browser
  const paneOf = (name) => (name instanceof Element ? name : document.querySelector(`[data-pane="${name}"]`));
  K.pane = paneOf;

  // ── the person: pointer or finger, and keys ──
  const pointer = { x: 0, y: 0, visible: !K.phone, kind: 'arrow' };
  let hovered = null;
  function drawPointer() {
    const el = $('#pointer');
    if (!el) return;
    el.style.display = pointer.visible ? 'block' : 'none';
    el.style.transform = `translate(${pointer.x}px, ${pointer.y}px)`;
    el.dataset.kind = pointer.kind;
  }
  function hover() {
    if (K.phone) return;
    const over = pointer.visible ? document.elementFromPoint(pointer.x, pointer.y) : null;
    const next = over ? over.closest('[data-h]') : null;
    const kind = over && over.closest('button, a, [data-press], [data-h]') ? 'hand' : over && over.closest('input, textarea') ? 'text' : 'arrow';
    if (kind !== pointer.kind) {
      pointer.kind = kind;
      drawPointer();
    }
    if (next === hovered) return;
    if (hovered) hovered.removeAttribute('data-hover');
    hovered = next;
    if (hovered) {
      hovered.setAttribute('data-hover', '');
      hovered.dispatchEvent(new CustomEvent('hovered'));
    }
    dirty = true;
  }
  let lastKey = 0;
  function caret() {
    const field = document.activeElement;
    if (!field || !field.matches || !field.matches('[data-field]') || K.mode !== 'record') return;
    const on = (now - lastKey) % 1060 < 530;
    if ((field.dataset.caret === 'on') === on) return;
    field.dataset.caret = on ? 'on' : 'off';
    dirty = true;
  }

  const U = {};
  K.user = U;
  U.rest = (low = 900, high = low * 1.9) => K.wait(K.between(low, high));
  const centre = (target) => {
    const box = $(target).getBoundingClientRect();
    return [box.left + box.width * K.between(0.35, 0.65), box.top + box.height * K.between(0.35, 0.65)];
  };
  /** Moves the pointer along a slightly bent path, quickly in the middle, as hands do. */
  U.move = async (target, ms) => {
    if (K.phone) return;
    const [x, y] = Array.isArray(target) ? target : centre(target);
    const from = [pointer.x, pointer.y];
    const distance = Math.hypot(x - from[0], y - from[1]);
    const bend = K.between(-0.12, 0.12) * distance;
    const side = distance ? [-(y - from[1]) / distance, (x - from[0]) / distance] : [0, 0];
    await K.tween('noise', ms || 220 + distance * K.between(0.5, 0.9), (p) => {
      const arc = Math.sin(Math.PI * p) * bend;
      pointer.x = from[0] + (x - from[0]) * p + side[0] * arc;
      pointer.y = from[1] + (y - from[1]) * p + side[1] * arc;
      drawPointer();
    });
  };
  const press = (el) => {
    el.setAttribute('data-down', '');
    K.after(110, () => el.removeAttribute('data-down'));
  };
  U.click = async (target, { still = true } = {}) => {
    const el = $(target);
    if (!el) throw new Error(`nothing to click: ${target}`);
    if (!K.phone) {
      await U.move(el);
      if (still) await K.wait(K.between(60, 160));
    }
    press(el);
    await K.wait(K.phone ? 60 : 30);
    el.click();
  };
  U.tap = U.click;
  U.rightClick = async (target) => {
    const el = $(target);
    await U.move(el);
    await K.wait(K.between(60, 140));
    el.dispatchEvent(new CustomEvent('menu', { bubbles: true, detail: [pointer.x, pointer.y] }));
  };

  /** Scrolls a pane by so many pixels. style: flick (finger or trackpad, with momentum), wheel, slow, page. */
  U.scroll = async (name, dy, style = K.phone ? 'flick' : K.pick(['flick', 'wheel'])) => {
    const pane = paneOf(name);
    if (!K.phone && pointer.visible) {
      const box = pane.getBoundingClientRect();
      const inside = pointer.x > box.left && pointer.x < box.right && pointer.y > box.top && pointer.y < box.bottom;
      if (!inside) await U.move([box.left + box.width * K.between(0.3, 0.7), box.top + Math.min(box.height, innerHeight) * K.between(0.3, 0.7)]);
    }
    const to = Math.max(0, Math.min(pane.scrollHeight - pane.clientHeight, pane.scrollTop + dy));
    const glide = async (distance, ms, curve) => {
      const from = pane.scrollTop;
      await K.tween('scroll', ms, (p) => K.scrollTo(pane, from + distance * p), curve);
    };
    const total = to - pane.scrollTop;
    if (Math.abs(total) < 1) return;
    if (style === 'slow') await glide(total, Math.abs(total) * K.between(7, 11), ease.linear);
    else if (style === 'page') await glide(total, 170, ease.inOut);
    else if (style === 'wheel') {
      const notches = Math.max(1, Math.round(Math.abs(total) / 110));
      for (let i = 0; i < notches; i += 1) {
        await glide(total / notches, 110, ease.out);
        if (i + 1 < notches) await K.wait(K.between(10, 90));
      }
    } else {
      const drag = total * 0.3;
      await glide(drag, K.between(120, 190), ease.linear);
      await glide(total - drag, K.between(700, 1100), (p) => 1 - (Math.exp(-5 * p) - Math.exp(-5) * p) * 1);
    }
    K.scrollTo(pane, to);
  };

  U.focus = async (name) => {
    const field = document.querySelector(`[data-field="${name}"]`);
    await U.click(field);
    field.focus({ preventScroll: true });
    lastKey = now;
    if (K.phone) await K.keyboard.show();
  };
  /** Types in a field: at a person's pace, with pauses for thought and the odd slip that is put right. */
  U.type = async (name, text, { pace = 1, slips = 0.02, pauses = 0.05 } = {}) => {
    const field = document.querySelector(`[data-field="${name}"]`);
    if (document.activeElement !== field) await U.focus(name);
    const put = (value) => {
      field.value = value;
      field.setSelectionRange(value.length, value.length);
      field.scrollTop = field.scrollHeight;
      lastKey = now;
      field.dispatchEvent(new Event('input', { bubbles: true }));
    };
    for (const letter of text) {
      const gap = 1 / pace * (K.phone ? 150 : 110) * Math.exp(K.between(-0.5, 0.6));
      await K.wait(gap);
      if (random() < slips && /[a-z]/.test(letter)) {
        const wrong = K.pick('asdfghjklertyuio'.split(''));
        if (K.phone) K.keyboard.tap(wrong);
        put(field.value + wrong);
        await K.wait(K.between(250, 600));
        if (K.phone) K.keyboard.tap('⌫');
        put(field.value.slice(0, -1));
        await K.wait(gap);
      }
      if (K.phone) K.keyboard.tap(letter);
      put(field.value + letter);
      if (letter === ' ' && random() < pauses) await K.wait(K.between(700, 2100));
    }
  };
  U.erase = async (name, count) => {
    const field = document.querySelector(`[data-field="${name}"]`);
    for (let i = 0; i < count; i += 1) {
      await K.wait(K.between(45, 80));
      field.value = field.value.slice(0, -1);
      lastKey = now;
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }
  };
  U.key = async (key) => {
    await K.wait(K.between(80, 200));
    if (K.phone && key === 'Enter') K.keyboard.tap('return');
    (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    if (key === 'Escape') {
      const top = [...overlays].reverse().find((overlay) => !overlay.leaving && overlay.kind !== 'toast');
      if (top) {
        K.close(top.id);
        if (top.kind === 'submenu') overlays.filter((each) => each.kind === 'menu').forEach((each) => K.close(each.id));
      }
    }
  };

  // ── the keyboard of a phone ──
  const rows = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
  K.keyboard = {
    up: false,
    async show() {
      if (this.up) return;
      this.up = true;
      const board = $('#keyboard');
      K.set('keyboard', 'letters', 'keyboard');
      board.style.display = 'block';
      document.body.dataset.keyboard = '';
      await K.tween('keyboard', 260, (p) => { board.style.transform = `translateY(${(1 - p) * 100}%)`; document.body.style.setProperty('--keys', `${Math.round(p * board.offsetHeight)}px`); }, ease.out);
    },
    async hide() {
      if (!this.up) return;
      this.up = false;
      const board = $('#keyboard');
      if (document.activeElement) document.activeElement.blur();
      K.set('keyboard', null, 'keyboard');
      await K.tween('keyboard', 260, (p) => { board.style.transform = `translateY(${p * 100}%)`; document.body.style.setProperty('--keys', `${Math.round((1 - p) * board.offsetHeight)}px`); }, ease.out);
      board.style.display = 'none';
      delete document.body.dataset.keyboard;
    },
    tap(letter) {
      const key = letter === ' ' ? 'space' : letter.toLowerCase();
      const el = document.querySelector(`#keyboard [data-key="${CSS.escape(key)}"]`);
      if (!el) return;
      el.setAttribute('data-down', '');
      K.after(130, () => el.removeAttribute('data-down'));
      if (key === 'space') {
        const words = ['the', 'and', 'for', 'with', 'that', 'this', 'have', 'from'];
        document.querySelectorAll('#keyboard .guess').forEach((guess) => { guess.textContent = K.pick(words); });
      }
    },
    build() {
      const key = (name, label = name, extra = '') => h(`span.key${extra}`, { 'data-key': name }, h('b', label), h('i', label));
      return h('div#keyboard', { 'data-noise': '' },
        h('div.guesses', ['I', 'the', 'we'].map((word) => h('span.guess', word))),
        h('div.keys', rows[0].split('').map((letter) => key(letter))),
        h('div.keys.inset', rows[1].split('').map((letter) => key(letter))),
        h('div.keys', key('shift', '⇧', '.wide'), rows[2].split('').map((letter) => key(letter)), key('⌫', '⌫', '.wide')),
        h('div.keys', key('123', '123', '.wide'), key('space', 'space', '.space'), key('return', 'return', '.wide2')));
    },
  };

  // ── pictures, words and things that move ──
  K.hue = () => Math.floor(random() * 360);
  /** A picture that looks like a photograph from a distance: a sky, some ground, a few shapes. */
  K.picture = (width, height, seed = Math.floor(random() * 1e9), className = 'picture') => {
    const canvas = h(`canvas.${className}`);
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext('2d');
    let s = seed >>> 0;
    const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
    const base = rnd() * 360;
    const sky = g.createLinearGradient(0, 0, rnd() * width, height);
    sky.addColorStop(0, `hsl(${base} 55% ${40 + rnd() * 35}%)`);
    sky.addColorStop(1, `hsl(${base + 40 + rnd() * 80} 50% ${25 + rnd() * 30}%)`);
    g.fillStyle = sky;
    g.fillRect(0, 0, width, height);
    for (let i = 0; i < 9; i += 1) {
      g.fillStyle = `hsl(${base + rnd() * 120} ${30 + rnd() * 40}% ${20 + rnd() * 60}% / ${0.35 + rnd() * 0.5})`;
      g.beginPath();
      if (rnd() < 0.5) g.ellipse(rnd() * width, rnd() * height, (0.05 + rnd() * 0.3) * width, (0.05 + rnd() * 0.25) * height, rnd() * 3, 0, 7);
      else { g.moveTo(rnd() * width, rnd() * height); for (let k = 0; k < 4; k += 1) g.lineTo(rnd() * width, rnd() * height); }
      g.fill();
    }
    return canvas;
  };
  /** A clip that plays and never ends. */
  K.clip = (id, width, height) => {
    const canvas = h('canvas.clip', { 'data-loop': id, 'data-noise': '' });
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext('2d');
    const base = K.hue();
    K.loop(id, canvas, (t) => {
      const s = t / 1000;
      g.fillStyle = `hsl(${base + Math.sin(s * 0.5) * 30} 45% ${30 + 12 * Math.sin(s * 0.9)}%)`;
      g.fillRect(0, 0, width, height);
      for (let i = 0; i < 6; i += 1) {
        g.fillStyle = `hsl(${base + i * 40} 60% 60% / .8)`;
        g.beginPath();
        g.arc(width * (0.5 + 0.42 * Math.sin(s * (0.4 + i * 0.13) + i)), height * (0.5 + 0.4 * Math.cos(s * (0.5 + i * 0.1) + 2 * i)), width * (0.05 + 0.02 * i), 0, 7);
        g.fill();
      }
    });
    return canvas;
  };
  K.spinner = (id) => h('span.spinner', { 'data-loop': id, 'data-noise': '' });

  const words = ('account change notes market summer paper river window answer garden morning letter travel paint signal bridge corner ticket '
    + 'planet silver kitchen record winter simple quiet bright sudden early common public narrow yellow gentle careful open distant every '
    + 'between across under before after again often later nearly almost while because until although should would could might moves keeps '
    + 'finds shows brings takes makes holds turns opens carries follows begins leaves').split(' ');
  K.words = (count) => Array.from({ length: count }, () => K.pick(words)).join(' ');
  K.sentence = (low = 6, high = 14) => { const text = K.words(K.whole(low, high)); return `${text[0].toUpperCase()}${text.slice(1)}.`; };
  K.paragraph = (low = 3, high = 6) => Array.from({ length: K.whole(low, high) }, () => K.sentence()).join(' ');
  K.title = (low = 2, high = 4) => { const text = K.words(K.whole(low, high)); return `${text[0].toUpperCase()}${text.slice(1)}`; };
  K.name = () => `${K.pick(['Anna', 'Bram', 'Chen', 'Dora', 'Eli', 'Femke', 'Goran', 'Hana', 'Ines', 'Jonas', 'Karim', 'Lena'])} ${K.pick(['Adams', 'Bakker', 'Costa', 'Dekker', 'Evers', 'Fischer', 'Green', 'Haas'])}`;

  /** An answer that comes in word by word, in bursts, and keeps its end in view. */
  K.stream = async (key, element, text, pane, { rate = 26 } = {}) => {
    const parts = text.match(/\S+\s*/g);
    streams.add(key);
    K.event('stream', { key, value: 'begin' });
    let soFar = '';
    for (let i = 0; i < parts.length;) {
      const burst = K.whole(1, 4);
      soFar += parts.slice(i, i + burst).join('');
      i += burst;
      element.textContent = soFar;
      content[key] = soFar.length;
      if (pane && pane.dataset.follow !== 'off') pane.scrollTop = pane.scrollHeight;
      dirty = true;
      await K.wait((1000 / rate) * burst * K.between(0.6, 1.6));
      if (random() < 0.02) await K.wait(K.between(500, 1200));
    }
    streams.delete(key);
    K.event('stream', { key, value: 'end' });
  };

  // ── a flash, by which webreal.py finds the log's moments in a video that something else recorded ──
  let flashing = false;
  K.flash = async () => {
    flashing = true;
    const card = h('div#flash', { style: 'position:fixed;inset:0;z-index:999;background:rgb(255,0,255)' });
    document.body.append(card);
    await K.wait(500);
    card.style.background = 'rgb(0,255,0)';
    await K.wait(0);
    K.event('flash');
    await K.wait(500);
    card.remove();
    flashing = false;
  };

  // ── running it ──
  let script = null;
  let finished = false;
  const log = [];
  function frame() {
    document.body.className = `${K.device} ${K.mode} ${K.theme || ''}`;
    document.body.replaceChildren(
      K.phone ? h('div#status', h('span', '9:41'), h('span.island'), h('span.right', h('i.bars'), h('i.wifi'), h('i.battery'))) : '',
      h('div#stage'),
      h('div#layers'),
      K.phone ? K.keyboard.build() : '',
      K.phone ? h('div#home') : '',
      h('div#sbar', { 'data-noise': '' }),
      h('div#pointer', { 'data-noise': '', html: '<svg class="a" viewBox="0 0 16 22" width="16" height="22"><path d="M1 1v16.5l4-3.8 2.6 6.2 2.7-1.1-2.6-6.1h5.6z" fill="#000" stroke="#fff" stroke-width="1.4"/></svg><svg class="p" viewBox="0 0 20 22" width="20" height="22"><path d="M7 1.6c1 0 1.6.7 1.6 1.7v6.2l5.8 1.2c1.6.4 2.4 1.5 2.1 3.1l-.9 4.6c-.3 1.7-1.4 2.6-3.1 2.6H9c-1.2 0-2.1-.5-2.8-1.5l-4-6c-.7-1.1-.5-2 .3-2.4.7-.4 1.5-.2 2.2.6l.8.9V3.3c0-1 .6-1.7 1.5-1.7z" fill="#000" stroke="#fff" stroke-width="1.3"/></svg>' }),
    );
    pointer.x = innerWidth * 0.55;
    pointer.y = innerHeight * 0.6;
    drawPointer();
  }
  new MutationObserver(() => { dirty = true; }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });

  K.begin = (name) => {
    const [appName, scriptName] = name.split('_');
    const app = K.apps[appName];
    K.theme = app.theme ? app.theme(scriptName) : '';
    frame();
    app.build($('#stage'), scriptName);
    if (K.mode === 'free') return Promise.resolve();
    const flash = K.mode === 'play' || params.has('flash');
    script = (async () => {
      if (flash) await K.flash();
      await U.rest(700, 1300);
      await app.scripts[scriptName](U);
      await U.rest(900, 1400);
      if (flash) await K.flash();
    })();
    script.then(() => { finished = true; }, (error) => { finished = true; K.error = String(error && error.stack || error); });
    return Promise.resolve();
  };
  /** For the recorder: moves the clock on and says what is on the screen. */
  K.step = async (dt) => {
    dirty = false;
    await advance(dt);
    const out = { dirty, done: finished, error: K.error || null, snapshot: K.snapshot(), events: events.splice(0) };
    return JSON.stringify(out);
  };

  /** Watching or using it, in real time. */
  K.live = () => {
    let last = performance.now();
    let lastTold = '';
    if (K.mode === 'free') {
      if (!K.phone) addEventListener('mousemove', (event) => { pointer.x = event.clientX; pointer.y = event.clientY; pointer.visible = true; drawPointer(); });
      addEventListener('contextmenu', (event) => { event.preventDefault(); event.target.dispatchEvent(new CustomEvent('menu', { bubbles: true, detail: [event.clientX, event.clientY] })); });
      addEventListener('keydown', (event) => { if (event.key === 'Escape') U.key('Escape'); });
      document.addEventListener('scroll', (event) => {
        if (!(event.target instanceof Element) || !event.target.matches('[data-pane]')) return;
        scrolledAt = performance.now();
        showBar(event.target);
      }, true);
      if (window.visualViewport) visualViewport.addEventListener('resize', () => K.set('keyboard', visualViewport.height < innerHeight - 100 ? 'up' : null, 'keyboard'));
      $('#pointer').style.visibility = 'hidden';
      pointer.visible = false; // until their own moves
    }
    const turn = async () => {
      const time = performance.now();
      const dt = Math.min(100, time - last);
      last = time;
      await advance(dt);
      const snapshot = K.snapshot();
      const { t: _t, pointer: _pointer, areas: _areas, ...rest } = snapshot;
      const told = JSON.stringify(rest);
      if (told !== lastTold || events.length) log.push({ snapshot, ...(events.length ? { events: events.splice(0) } : {}) });
      lastTold = told;
      requestAnimationFrame(turn);
    };
    requestAnimationFrame(turn);
  };
  K.saved = () => ({ scenario: K.scenario, device: K.device, seed: K.seed, css: [innerWidth, innerHeight], duration_ms: Math.round(now), log });
  K.finished = () => finished;
  K.download = () => {
    const blob = new Blob([JSON.stringify(K.saved())], { type: 'application/json' });
    const link = h('a', { href: URL.createObjectURL(blob), download: `${K.scenario}__${K.device}__log.json` });
    link.click();
  };
  return K;
})();
