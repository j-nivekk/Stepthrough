'use strict';
// Mock apps for a computer. Each app has two scripts: `a` to develop the engine with, `b` kept apart to check it on.
(() => {
  const K = Kit;
  const stage = () => K.$('#stage');
  const menuItems = (box, id, items) => items.forEach((item) => {
    if (item === '-') { box.append(h('div.rule')); return; }
    const row = h('div.item', { 'data-h': `${id} ${item.label}`, onclick: () => { K.closeAll(); if (item.run) item.run(); } }, h('span', item.label), h('span.soft', item.items ? '▸' : item.hint || ''));
    if (item.items) {
      row.onclick = null;
      row.addEventListener('hovered', () => {
        if (K.isOpen(`${id} sub`)) return;
        K.after(160, () => {
          if (!K.isOpen(id) || K.isOpen(`${id} sub`)) return;
          const at = row.getBoundingClientRect();
          K.open({ id: `${id} sub`, kind: 'submenu', at: [at.right + 3, at.top - 5], build: (sub) => menuItems(sub, `${id} sub`, item.items) });
        });
      });
    }
    box.append(row);
  });
  K.menu = (id, at, items) => K.open({ id, kind: 'menu', at, build: (box) => menuItems(box, id, items) });
  K.ask = (id, { title, text, yes, no = 'cancel', dim = 0.4, run }) => K.open({
    id, kind: 'dialog', dim, width: K.phone ? undefined : 400,
    build: (box) => box.append(h('h2', title), h('p.soft', { style: 'margin:10px 0 0' }, text),
      h('div.buttons.row', { style: K.phone ? '' : 'justify-content:flex-end;margin-top:18px' },
        h('button', { id: 'no', 'data-press': '', onclick: () => K.close(id) }, no),
        h('button.main', { id: 'yes', 'data-press': '', onclick: () => { K.close(id); if (run) run(); } }, yes))),
  });

  // ── console: an admin page with rows that react to the pointer, undimmed menus, and messages that push the page down
  const console_ = { about: 'admin console: hover, menus, pop-overs, a dialog, long page', devices: ['computer'], theme: (script) => (script === 'b' ? 'slate' : '') };
  console_.build = () => {
    console_.names = Array.from({ length: 6 }, () => K.title(1, 2));
    console_.home('cut');
  };
  console_.home = (how) => K.show(stage(), 'console/home', (root) => root.append(
    h('div.console.fill', { 'data-pane': 'page', 'data-keep': '' },
      h('div.row.crumb', h('span.pill', 'projects'), h('span.grow'), h('span.small.soft', '2 warnings'), h('a.small', 'dismiss')),
      h('div.home',
        h('input.grow', { 'data-field': 'new project', placeholder: 'create a project' }),
        h('div.list', console_.names.map((name, i) => h('div.prow', { 'data-h': `project ${i}`, 'data-press': '', onclick: () => console_.project(i, 'load') },
          h('div.grow', h('div.bold', name), h('div.small.soft', K.fixed(`videos ${i}`, () => `${K.whole(1, 4)} videos and ${K.whole(2, 20)} runs`))),
          h('span.acts.small', ['import', 'analysis', 'download', 'delete'].map((act) => h('a', act)))))))),
  ), how);
  console_.project = (i, how) => {
    console_.open = i;
    const option = (label, choices) => h('div.row.option', h('span.grow', label), choices.map((choice, k) => h('span.choice', { 'data-press': '', class: k === 0 ? 'choice on' : 'choice', onclick: (event) => {
      event.target.parentElement.querySelectorAll('.choice').forEach((each) => each.classList.remove('on'));
      event.target.classList.add('on');
      K.set(`option ${label}`, choice);
    } }, choice)));
    return K.show(stage(), `console/project ${i}`, (root) => root.append(
      h('div.console.fill', { 'data-pane': 'page', 'data-keep': '' },
        h('div.row.crumb', h('span.pill', { 'data-press': '', id: 'crumb', onclick: () => console_.home('cut') }, 'analysis'), h('span.small.soft', console_.names[i]), h('span.grow'), h('span.small.soft', '2 warnings')),
        h('div#message'),
        h('div.three',
          h('div', h('h3', 'videos'), [0, 1, 2].map((k) => h('div.vrow', { 'data-h': `video ${k}` }, h('span.grow.cut.bold', K.fixed(`video ${i}.${k}`, () => `recording-${k + 1}-${K.words(1)}.mp4`)), h('span.small.soft', `00:0${k + 1}:2${k}`), h('span.acts.small', h('a', 'preview'))))),
          h('div', h('div.row', h('h3.grow', 'parameters'), h('button.loud', { id: 'reset', onclick: console_.reset }, 'reset')),
            h('div.grey', option('recording type', ['phone', 'computer']), option('scrolling', ['each stop', 'merge']), option('group typing', ['on', 'off']), option('opening screen', ['on', 'off']), option('read text', ['off', 'on']),
              h('div.row.fold', { id: 'fold', 'data-press': '', onclick: console_.fold }, h('span.grow', 'advanced'), h('span', '▾')), h('div#folded'))),
          h('div', h('h3', 'tasks'), [0, 1, 2, 3, 4].map((k) => h('div.trow', { 'data-h': `task ${k}`, 'data-press': '', id: `task${k}`, onclick: () => console_.run(k) }, h('div.grow', h('div.bold', `run ${5 - k}`), h('div.small.soft', K.fixed(`date ${i}.${k}`, () => `${K.whole(1, 29)} march, 21:3${k}`))), h('span.small', K.fixed(`reviewed ${i}.${k}`, () => `${K.whole(0, 9)}/9 reviewed`)))))),
        h('div#work'))), how);
  };
  console_.reset = () => {
    if (K.isOpen('reset')) return K.close('reset');
    const at = K.$('#reset').getBoundingClientRect();
    return K.open({ id: 'reset', kind: 'popover', className: 'loud', width: 210, at: [at.right - 210, at.bottom + 12], build: (box) => box.append(h('div', 'choose which defaults should replace the active parameters.'), h('p', h('a', { id: 'reset-project', style: 'color:#fff', 'data-press': '', onclick: () => { K.close('reset'); K.after(60, () => console_.say('reset the current settings to this project’s defaults.')); } }, 'reset to project defaults')), h('p', h('a', { style: 'color:#fff' }, 'reset to universal defaults'))) });
  };
  console_.say = (text) => { K.$('#message').replaceChildren(h('div.message', text)); K.set('message', text, 'shift'); };
  console_.fold = () => {
    const folded = K.$('#folded');
    const open = !folded.firstChild;
    folded.replaceChildren(...(open ? [h('div.row.option', h('span.grow', 'pixel threshold'), h('span', '4 × noise')), h('div.row.option', h('span.grow', 'analysis rate'), h('span', '15 fps'))] : []));
    K.$('#fold').classList.toggle('open', open);
    K.set('advanced', open, 'expand');
  };
  console_.cards = (view) => h(`div.cards.${view}`, console_.shots.map((shot, k) => {
    const card = h('div.card', { 'data-h': `card ${k}`, id: `card${k}` }, shot, h('div.about', h('div.bold', `step ${k + 1}`), h('div.small.soft', K.fixed(`status ${console_.task} ${k}`, () => K.pick(['accepted', 'pending', 'rejected'])))), h('div.tools', h('button.small', 'accept'), h('button.small', 'reject')));
    card.addEventListener('menu', (event) => console_.cardMenu(k, event.detail));
    card.onclick = () => { document.querySelectorAll('.card').forEach((each) => each.classList.remove('active')); card.classList.add('active'); K.set('active card', k); };
    return card;
  }));
  console_.cardMenu = (k, at) => {
    K.$(`#card${k}`).click();
    K.menu(`card menu ${k}`, at, [{ label: 'accept', hint: 'A' }, { label: 'reject', hint: 'R' }, { label: 'reset', hint: 'U' }, '-', { label: 'play from here', hint: 'P' }, { label: 'annotate' }, { label: 'open screenshot' }, '-', { label: 'stacking', items: [{ label: 'automatic' }, { label: 'a new screen' }, { label: 'same as 2' }] }, { label: 'phase', items: [{ label: 'sign up' }, { label: 'no phase' }, { label: 'new phase…' }] }, '-', { label: 'select', hint: 'X' }]);
  };
  console_.run = async (k) => {
    document.querySelectorAll('.trow').forEach((row, each) => row.classList.toggle('on', each === k));
    await K.wait(180);
    console_.shots = Array.from({ length: 11 }, () => K.picture(200, 280));
    console_.task = `console/project ${console_.open}/run ${k}`;
    K.$('#work').replaceChildren(h('div.row', { style: 'margin-top:26px' }, h('h1.grow', `recording-${k + 1}.mp4`), h('button.main', { id: 'export' }, 'export')),
      h('div.row.worktabs', h('span.worktab.on', { id: 'tab-steps', 'data-press': '', onclick: () => console_.tab('steps') }, 'steps'), h('span.worktab', { id: 'tab-pathway', 'data-press': '', onclick: () => console_.tab('pathway') }, 'pathway'), h('span.grow'), h('span.choice.on', { id: 'view-grid', 'data-press': '', onclick: () => console_.view('grid') }, 'grid'), h('span.choice', { id: 'view-list', 'data-press': '', onclick: () => console_.view('list') }, 'list')),
      h('div#panel', console_.cards('grid')));
    K.at(console_.task);
    const pane = K.pane('page');
    const to = Math.min(pane.scrollHeight - pane.clientHeight, K.$('#work').offsetTop - 60);
    const from = pane.scrollTop;
    await K.wait(120);
    await K.tween('scroll', 420, (p) => K.scrollTo(pane, from + (to - from) * p));
  };
  console_.tab = (name) => {
    K.$('#tab-steps').classList.toggle('on', name === 'steps');
    K.$('#tab-pathway').classList.toggle('on', name === 'pathway');
    K.$('#panel').replaceChildren(name === 'steps' ? console_.cards('grid') : h('div.pathway', h('div.row.tip', h('span.grow', 'new to pathways? a tutorial shows how to read one.'), h('button.main.small', { id: 'tutorial', onclick: console_.tutorial }, 'start the tutorial')), h('div.boxes', console_.shots.slice(0, 5).map((shot, k) => h('div.box', h('div.bold.small', `Screen ${k + 1}`), shot, h('span.number', String(k)))))));
    K.at(name === 'steps' ? console_.task : `${console_.task}/pathway`);
  };
  console_.view = (view) => {
    K.$('#view-grid').classList.toggle('on', view === 'grid');
    K.$('#view-list').classList.toggle('on', view === 'list');
    K.$('#panel').replaceChildren(console_.cards(view));
    K.set('view', view, 'update');
  };
  console_.tutorial = () => K.open({ id: 'tutorial', kind: 'dialog', dim: 0.46, width: 760, build: (box) => box.append(h('div.row', h('h2.grow', 'working with pathways'), h('button', { id: 'close-tutorial', onclick: () => K.close('tutorial') }, '×')), h('div.row', { style: 'gap:24px;margin-top:14px;align-items:flex-start' }, h('p', { style: 'width:240px' }, K.fixed('tutorial', () => K.paragraph(2, 3))), h('div.grow.row', { style: 'background:#fff;padding:18px' }, console_.shots.slice(5, 10).map((shot) => h('div', { style: 'width:72px' }, shot))))) });
  console_.scripts = {
    a: async (u) => {
      for (const i of [2, 0, 1]) { await u.move(`[data-h="project ${i}"]`); await u.rest(300, 900); }
      await u.click('[data-h="project 1"]');
      await u.rest(2200);
      await u.click('#reset'); await u.rest(1000);
      await u.click('#reset-project'); await u.rest(1500);
      await u.click('#fold'); await u.rest(800);
      await u.click('#fold'); await u.rest(1200);
      await u.move('[data-h="video 1"]'); await u.rest(700);
      await u.click('#task2'); await u.rest(1600);
      await u.rightClick('#card1'); await u.rest(900);
      await u.move('[data-h$="menu 1 phase"]'); await u.rest(1200);
      await u.key('Escape'); await u.rest(1000);
      await u.move('#card3'); await u.rest(700);
      await u.rightClick('#card4'); await u.rest(900);
      await u.move([900, 840]); await u.key('Escape'); await u.rest(1100);
      await u.scroll('page', -260); await u.rest(1000);
      await u.click('#tab-pathway'); await u.rest(1500);
      await u.scroll('page', -900); await u.rest(900);
      await u.scroll('page', 500); await u.rest(800);
      await u.click('#tutorial'); await u.rest(1500);
      await u.click('#close-tutorial'); await u.rest(1300);
      await u.click('#tab-steps'); await u.rest(1100);
    },
    b: async (u) => {
      for (const i of [1, 3]) { await u.move(`[data-h="project ${i}"]`); await u.rest(400, 1100); }
      await u.click('[data-h="project 3"]'); await u.rest(1600);
      await u.click('.option:nth-of-type(2) .choice:not(.on)'); await u.rest(900);
      await u.click('#task0'); await u.rest(1400);
      for (const k of [0, 2, 5]) { await u.move(`#card${k}`); await u.rest(350, 700); }
      await u.click('#card2'); await u.rest(1000);
      await u.scroll('page', 320); await u.rest(1200);
      await u.scroll('page', -320); await u.rest(1000);
      await u.click('#view-list'); await u.rest(1300);
      await u.scroll('page', 700); await u.rest(1100);
      await u.scroll('page', -700); await u.rest(800);
      await u.click('#export');
      K.ask('export', { title: 'Export the steps?', text: K.sentence(), yes: 'export', run: () => K.toast('exported 11 steps') });
      await u.rest(1400);
      await u.click('#yes'); await u.rest(1800);
      await u.scroll('page', -2000); await u.rest(800);
      await u.click('#crumb'); await u.rest(1300);
      await u.move('[data-h="project 0"]'); await u.rest(800);
      await u.click('[data-h="project 3"]'); await u.rest(1500);
    },
  };
  K.apps.console = console_;

  // ── workshop: a window in two halves, of which one fills itself while the other is used
  const shop = { about: 'two panes: an assistant at work beside a review and a browser', devices: ['computer'], theme: (script) => (script === 'b' ? 'dark' : '') };
  shop.build = () => {
    shop.lines = 0;
    shop.chat = h('div.chat.fill', { 'data-pane': 'chat' });
    stage().append(h('div.workshop', h('div.half', h('div.row.headbar', h('span.bold.cut', K.title()), h('span.grow'), h('span.soft', '⋯')), shop.chat, h('div.composer', h('span.soft', 'Ask for a change'), h('span.grow'), h('span.soft.small', 'high'))), h('div.half.right', h('div.row.headbar.tabs2', h('span.tab2', { id: 't-review', 'data-press': '', onclick: () => shop.review() }, 'Review'), h('span.tab2', { id: 't-web', 'data-press': '', style: 'display:none', onclick: () => shop.web(shop.page, 'cut') }, 'Browser'), h('span.tab2', { id: 't-new', 'data-press': '', onclick: () => shop.fresh() }, '+')), h('div#right'))));
    for (let i = 0; i < 22; i += 1) shop.say(true);
    shop.chat.scrollTop = 1e6;
    shop.diff = Array.from({ length: 46 }, (_, i) => ({ kind: K.pick(['', '', '', 'add', 'cut']), text: K.words(K.whole(3, 9)), n: i + 10 }));
    shop.pages = Object.fromEntries(['start', 'plans', 'launch', 'faq'].map((page) => [page, { title: K.title(), parts: Array.from({ length: 9 }, () => [K.title(), K.paragraph()]) }]));
    shop.review();
  };
  shop.say = (silent) => {
    const kind = K.pick(['said', 'did', 'did', 'code']);
    shop.chat.append(kind === 'said' ? h('p', K.paragraph(1, 2)) : kind === 'did' ? h('p.soft.small', `▸ ${K.title(3, 5)}`) : h('pre', `{\n  "${K.words(1)}": ${K.whole(1, 90)},\n  "${K.words(1)}": "${K.words(2)}"\n}`));
    shop.lines += 1;
    K.came('chat lines', shop.lines, silent ? 'silent' : 'stream');
    if (shop.chat.dataset.follow !== 'off') shop.chat.scrollTop = 1e6;
    K.touch();
  };
  const tab = (id) => document.querySelectorAll('.tab2').forEach((each) => each.classList.toggle('on', each.id === id));
  shop.review = () => {
    tab('t-review');
    return K.show(K.$('#right'), 'workshop/review', (root) => root.append(h('div.diff.fill', { 'data-pane': 'review', 'data-keep': '' }, h('div.bold', { style: 'padding:8px 14px' }, `${K.words(1)}/${K.words(2).replace(' ', '_')}.md  +12 −4`), shop.diff.map(({ kind, text, n }, i) => (i === 17 ? h('div.unfold', { id: 'unfold', 'data-press': '', onclick: () => { K.$('#unfold').replaceWith(...Array.from({ length: 8 }, (_, k) => h('div.dline', h('span.soft', String(27 + k)), K.words(6)))); K.set('unfolded', true, 'expand'); } }, '14 unmodified lines') : h(`div.dline${kind ? `.${kind}` : ''}`, h('span.soft', String(n)), text))))), 'cut');
  };
  shop.fresh = () => {
    tab('t-new');
    return K.show(K.$('#right'), 'workshop/new tab', (root) => root.append(h('div.fresh', ['Files', 'Side chat', 'Browser', 'Terminal'].map((name) => h('div.tile', { 'data-h': `tile ${name}`, 'data-press': '', id: `tile-${name.split(' ')[0]}`, onclick: () => (name === 'Browser' ? shop.web('blank') : null) }, h('div.bold', name), h('div.small.soft', K.fixed(`tile ${name}`, () => K.words(3))))))), 'cut');
  };
  shop.web = (page, how) => {
    K.$('#t-web').style.display = '';
    tab('t-web');
    shop.page = page;
    return K.show(K.$('#right'), `workshop/web ${page}`, (root) => {
      const at = h('div.row.address', h('span.soft', '←  →  ⟳'), h('span.grow.small', { style: 'text-align:center' }, page === 'blank' ? 'Enter a URL' : `example.org/${page}`));
      if (page === 'blank') { root.append(at, h('div.grow')); return; }
      const { title, parts } = shop.pages[page];
      root.append(at, h('div.site.fill', { 'data-pane': 'web', 'data-keep': '' }, h('div.row.sitebar', h('span.bold', '◆ Example'), h('span.grow'), h('span', '≡')), h('h1', title), page === 'launch' ? K.clip('launch clip', 640, 360) : K.picture(640, 260, 7 + title.length), parts.map(([head, text], i) => [h('h2', head), h('p', text), h('a', { id: `to-${['plans', 'launch', 'faq', 'start'][i % 4]}${i}`, 'data-press': '', onclick: () => shop.web(['plans', 'launch', 'faq', 'start'][i % 4], 'load') }, K.fixed(`link ${page} ${i}`, () => K.title()))])));
    }, how || 'load');
  };
  shop.work = (times, low = 600, high = 1500) => { let t = 0; for (let i = 0; i < times; i += 1) { t += K.between(low, high); K.after(t, () => shop.say()); } };
  shop.scripts = {
    a: async (u) => {
      await u.scroll('chat', -260); await u.rest(1000);
      shop.chat.dataset.follow = 'off';
      await u.scroll('chat', 260); await u.rest(900);
      shop.chat.dataset.follow = '';
      shop.work(4); await u.rest(5200, 5600);
      await u.click('#t-new'); await u.rest(1200);
      await u.click('#tile-Browser'); await u.rest(1300);
      await shop.web('start', 'load'); await u.rest(1500);
      await u.scroll('web', 420); await u.rest(1100);
      await u.scroll('web', 380); await u.rest(1000);
      await u.click('#to-faq2'); await u.rest(2100);
      await u.scroll('web', 300); await u.rest(900);
      await shop.web('launch', 'load');
      shop.work(3, 1200, 2400); await u.rest(6500, 7000);
      await u.click('#t-review'); await u.rest(1300);
      await u.scroll('review', 360); await u.rest(1000);
      await u.click('#unfold'); await u.rest(1100);
      await u.click('#t-web'); await u.rest(2200);
      await u.click('#t-review'); await u.rest(1200);
    },
    b: async (u) => {
      shop.work(3, 900, 1700);
      await u.scroll('review', 240); await u.rest(1200);
      await u.scroll('review', 200, 'slow'); await u.rest(900);
      await u.click('#t-new'); await u.rest(1100);
      await u.click('#tile-Browser'); await u.rest(900);
      await shop.web('plans', 'load'); await u.rest(1200);
      shop.work(5, 700, 1300);
      await u.scroll('web', 500); await u.rest(1400);
      await u.scroll('web', 250); await u.rest(1600);
      await shop.web('start', 'load'); await u.rest(1500);
      await u.click('#t-review'); await u.rest(1000);
      await u.scroll('chat', -400); shop.chat.dataset.follow = 'off'; await u.rest(1300);
      await u.scroll('chat', -200); await u.rest(900);
      await u.scroll('chat', 900); shop.chat.dataset.follow = ''; await u.rest(1000);
      await u.click('#t-web'); await u.rest(1400);
      await u.scroll('web', 600); await u.rest(1200);
    },
  };
  K.apps.workshop = shop;

  // ── inbox: folders, a long list of rows that look alike, and letters that look alike
  const inbox = { about: 'mail: uniform list, letters that look alike, a letter to write', devices: ['computer'], theme: (script) => (script === 'b' ? 'sand' : '') };
  inbox.build = () => {
    inbox.folders = Object.fromEntries(['Inbox', 'Archive', 'Sent'].map((folder) => [folder, Array.from({ length: folder === 'Sent' ? 12 : 40 }, (_, i) => ({ id: `${folder.toLowerCase()} ${i}`, from: K.name(), about: K.title(2, 5), start: K.sentence(), text: Array.from({ length: K.whole(11, 16) }, () => K.paragraph(3, 6)) }))]));
    stage().append(h('div.mail',
      h('div.folders', h('button.main', { id: 'write', onclick: () => inbox.write() }, 'Write'), Object.keys(inbox.folders).map((name) => h('div.folder', { 'data-h': `folder ${name}`, 'data-press': '', id: `f-${name}`, onclick: () => inbox.folder(name) }, name))),
      h('div.letters.column', h('div', { style: 'padding:10px' }, h('input', { 'data-field': 'search', placeholder: 'Search', oninput: (event) => inbox.list(event.target.value) })), h('div.grow', { 'data-pane': 'letters', id: 'letters', style: 'position:relative' })),
      h('div#letter')));
    inbox.folder('Inbox');
  };
  inbox.list = (query = '') => {
    const found = inbox.folders[inbox.at].filter(({ from, about }) => `${from} ${about}`.toLowerCase().includes(query.toLowerCase()));
    K.$('#letters').replaceChildren(...found.map((letter) => h('div.letter', { 'data-h': `letter ${letter.id}`, 'data-press': '', onclick: () => inbox.open(letter) }, h('div.row', h('span.bold.grow.cut', letter.from), h('span.small.soft', K.fixed(`time ${letter.id}`, () => `${K.whole(8, 18)}:${K.whole(10, 59)}`))), h('div.cut', letter.about), h('div.small.soft.cut', letter.start))));
  };
  inbox.folder = (name) => {
    inbox.at = name;
    document.querySelectorAll('.folder').forEach((each) => each.classList.toggle('on', each.id === `f-${name}`));
    inbox.list();
    K.$('#letters').scrollTop = 0;
    K.show(K.$('#letter'), `mail/${name}`, (root) => root.append(h('div.nothing.soft', 'No letter selected')), 'cut');
  };
  inbox.open = (letter) => {
    document.querySelectorAll('.letter').forEach((each) => each.classList.toggle('on', each.dataset.h === `letter ${letter.id}`));
    return K.show(K.$('#letter'), `mail/${inbox.at}/${letter.id}`, (root) => root.append(h('div.reader.fill', { 'data-pane': 'reader' }, h('h1', letter.about), h('div.row.soft', h('span.grow', `from ${letter.from}`), h('button.small', { id: 'reply' }, 'Reply'), h('button.small', { id: 'bin', onclick: () => K.ask('bin', { title: 'Delete this letter?', text: 'It stays in the bin for 30 days.', yes: 'Delete', run: () => { inbox.folder(inbox.at); K.toast('Letter deleted'); } }) }, 'Delete')), letter.text.map((text) => h('p', text)), h('div', { style: 'height:40px' }))), 'cut');
  };
  inbox.write = () => K.open({ id: 'write', kind: 'panel', build: (box) => box.append(h('div.row.panelhead', h('span.grow.bold', 'New letter'), h('span', { id: 'close-write', 'data-press': '', onclick: () => K.close('write') }, '×')), h('div', { style: 'padding:10px;display:grid;gap:8px' }, h('input', { 'data-field': 'to', placeholder: 'To' }), h('input', { 'data-field': 'about', placeholder: 'Subject' }), h('textarea', { 'data-field': 'body', rows: 8 }), h('div.row', h('span.grow'), h('button.main', { id: 'send', onclick: () => { K.close('write'); K.toast('Letter sent'); } }, 'Send')))) });
  inbox.scripts = {
    a: async (u) => {
      await u.scroll('letters', 380); await u.rest(900);
      await u.scroll('letters', 420); await u.rest(800);
      await u.scroll('letters', -800); await u.rest(800);
      await u.click('#letters > :nth-child(2)'); await u.rest(1600);
      await u.scroll('reader', 340); await u.rest(1200);
      await u.click('#letters > :nth-child(4)'); await u.rest(1400);
      await u.click('#letters > :nth-child(2)'); await u.rest(1200);
      await u.click('#write'); await u.rest(900);
      await u.type('to', 'bram dekker'); await u.rest(600, 1100);
      await u.type('about', 'the plan for thursday'); await u.rest(700, 1200);
      await u.type('body', 'Dear Bram, could you bring the paper we talked about? I will be there at two.', { pauses: 0.12 }); await u.rest(1200);
      await u.click('#send'); await u.rest(1600);
      await u.click('#f-Archive'); await u.rest(1200);
      await u.scroll('letters', 500); await u.rest(1000);
      await u.click('#f-Inbox'); await u.rest(1200);
      await u.click('#letters > :nth-child(2)'); await u.rest(1200);
    },
    b: async (u) => {
      for (const k of [1, 3, 5]) { await u.move(`#letters > :nth-child(${k})`); await u.rest(250, 600); }
      await u.click('#letters > :nth-child(3)'); await u.rest(1400);
      await u.scroll('reader', 260); await u.rest(1000);
      await u.scroll('reader', -260); await u.rest(800);
      await u.type('search', 'da', { slips: 0 }); await u.rest(1200);
      await u.click('#letters > :nth-child(1)'); await u.rest(1300);
      await u.erase('search', 2); K.$('[data-field=search]').blur(); await u.rest(1100);
      await u.click('#f-Sent'); await u.rest(1200);
      await u.click('#letters > :nth-child(2)'); await u.rest(1300);
      await u.click('#bin'); await u.rest(1200);
      await u.click('#no'); await u.rest(1000);
      await u.click('#bin'); await u.rest(900);
      await u.click('#yes'); await u.rest(2400);
      await u.click('#f-Inbox'); await u.rest(1200);
      await u.scroll('letters', 600, 'wheel'); await u.rest(1200);
      await u.scroll('letters', -600, 'page'); await u.rest(1000);
    },
  };
  K.apps.inbox = inbox;

  // ── docs: pages in one frame, a search box over the page, dark and light
  const docs = { about: 'documentation: pages in one frame, a search dialog, dark mode', devices: ['computer'], theme: (script) => (script === 'b' ? 'mint' : '') };
  docs.build = () => {
    docs.pages = Array.from({ length: 9 }, (_, i) => ({ id: `page ${i}`, title: K.title(2, 4), parts: Array.from({ length: 8 }, () => [K.title(), K.paragraph(), K.random() < 0.4 ? `${K.words(3)}\n${K.words(4)}` : '']) }));
    stage().append(h('div.docs', h('div.row.sitebar', h('span.bold', '▲ Handbook'), h('span.grow'), h('span.find.soft.small', { id: 'find', 'data-press': '', onclick: docs.find }, 'Search   ⌘K'), h('button.small', { id: 'theme', onclick: () => { const dark = document.body.classList.toggle('dark'); K.set('theme', dark ? 'dark' : 'light', 'theme'); } }, '◐')), h('div.docbody', h('div.side', { 'data-pane': 'side' }, docs.pages.map((page, i) => h('div.entry', { 'data-h': `entry ${i}`, 'data-press': '', id: `e${i}`, onclick: () => docs.go(i, 'cut') }, page.title))), h('div#doc'))));
    docs.go(0, 'cut');
  };
  docs.go = (i, how) => {
    document.querySelectorAll('.entry').forEach((each, k) => each.classList.toggle('on', k === i));
    const page = docs.pages[i];
    return K.show(K.$('#doc'), `docs/${page.id}`, (root) => root.append(h('div.article.fill', { 'data-pane': 'doc', 'data-keep': '' }, h('h1', page.title), page.parts.map(([head, text, code], k) => [h('h2', head), h('p', text), code ? h('div.code', h('pre', code), h('button.small', { id: `copy${k}`, 'data-h': `copy ${k}`, onclick: () => { const at = K.$(`#copy${k}`).getBoundingClientRect(); K.open({ id: 'copied', kind: 'tooltip', at: [at.left - 10, at.top - 34], build: (box) => box.append('Copied') }); K.after(1300, () => K.close('copied')); } }, 'copy')) : null]), h('div', { style: 'height:60px' }))), how);
  };
  docs.find = () => {
    const box = K.open({ id: 'find', kind: 'dialog', dim: 0.35, width: 560, build: (inner) => inner.append(h('input', { 'data-field': 'find', placeholder: 'Search the handbook', oninput: (event) => docs.found(event.target.value) }), h('div#found', { style: 'height:230px;margin-top:10px' })) });
    docs.found('');
    box.querySelector('input').focus({ preventScroll: true });
  };
  docs.found = (query) => {
    const found = docs.pages.map((page, i) => [page, i]).filter(([page]) => `${page.title} ${page.parts.map(([head]) => head).join(' ')}`.toLowerCase().includes(query.toLowerCase())).slice(0, 5);
    K.$('#found').replaceChildren(...found.map(([page, i], k) => h('div.item.hit', { 'data-h': `hit ${k}`, 'data-press': '', id: `hit${k}`, onclick: () => { K.close('find'); docs.go(i, 'cut'); } }, h('span.bold', page.title), h('div.small.soft.cut', page.parts[0][1]))));
  };
  docs.scripts = {
    a: async (u) => {
      await u.scroll('doc', 420); await u.rest(1100);
      await u.scroll('doc', 380); await u.rest(1200);
      await u.click('#e3'); await u.rest(1500);
      await u.scroll('doc', 300, 'wheel'); await u.rest(1000);
      await u.click('#find'); await u.rest(900);
      await u.type('find', 'ma', { slips: 0 }); await u.rest(1200);
      await u.click('#hit1'); await u.rest(1400);
      await u.click('#e0'); await u.rest(1200);
      await u.click('#e3'); await u.rest(1200);
      await u.scroll('doc', -2000); await u.rest(900);
      await u.click('#theme'); await u.rest(1400);
      await u.scroll('doc', 500); await u.rest(1200);
      await u.click('#theme'); await u.rest(1100);
      await u.click('#e5'); await u.rest(1200);
      await u.click('#find'); await u.rest(800);
      await u.key('Escape'); await u.rest(1200);
    },
    b: async (u) => {
      for (const k of [1, 2, 4]) { await u.move(`#e${k}`); await u.rest(200, 500); }
      await u.click('#e4'); await u.rest(1300);
      await u.scroll('doc', 260, 'slow'); await u.rest(1200);
      await u.scroll('doc', 600); await u.rest(900);
      await u.click('#e6'); await u.rest(1100);
      const copy = document.querySelector('#doc [id^=copy]');
      if (copy) { await u.scroll('doc', Math.max(0, copy.getBoundingClientRect().top - 420)); await u.rest(800); await u.click(copy); await u.rest(2100); }
      await u.click('#find'); await u.rest(700);
      await u.type('find', 'ri', { slips: 0 }); await u.rest(1000);
      await u.erase('find', 2); await u.type('find', 'op', { slips: 0 }); await u.rest(1100);
      await u.click('#hit0'); await u.rest(1300);
      await u.click('#e4'); await u.rest(1300);
      await u.scroll('doc', -900); await u.rest(1000);
      await u.click('#theme'); await u.rest(1300);
      await u.click('#e1'); await u.rest(1200);
    },
  };
  K.apps.docs = docs;
})();
