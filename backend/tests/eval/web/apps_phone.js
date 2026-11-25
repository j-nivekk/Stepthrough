'use strict';
// Mock apps for a phone; parley and larder also as they look on a computer.
(() => {
  const K = Kit;
  const stage = () => K.$('#stage');
  const bar = (title, { back, right } = {}) => h('div.bar', back ? h('button.plain', { id: 'back', onclick: back }, '‹ Back') : h('span'), h('span.title.cut', title), right || h('span'));

  // ── settings: grouped lists, switches, sheets, going in and back
  const settings = { about: 'phone settings: push and pop, switches, sheets, an alert', devices: ['phone'], theme: (script) => (script === 'b' ? 'dark' : '') };
  settings.build = () => {
    settings.path = [];
    settings.pages = Object.fromEntries(['General', 'Sound', 'Privacy', 'Display', 'Storage'].map((name) => [name, Array.from({ length: 3 }, () => Array.from({ length: K.whole(3, 5) }, () => K.title(1, 3)))]));
    settings.on = {};
    settings.open('Settings', 'cut');
  };
  settings.open = (name, how) => {
    if (how === 'push') settings.path.push(settings.name);
    settings.name = name;
    return K.show(stage(), `settings/${name}`, (root) => {
      const toggle = (key) => h(`span.switch${settings.on[key] ? '.on' : ''}`);
      const groups = name === 'Settings'
        ? [Object.keys(settings.pages), ['Wallpaper', 'Language', 'Time', 'Keyboard'], ['Help', 'About', 'Terms', 'Privacy report', 'Feedback'], ['Account', 'Family', 'Backups', 'Devices']].map((group) => h('div.group', group.map((entry) => h('div.cell', { 'data-press': '', id: `go-${entry.split(' ')[0]}`, onclick: () => (settings.pages[entry] ? settings.open(entry, 'push') : null) }, h('span.grow', entry), h('span.more')))))
        : settings.pages[name].map((group, g) => h('div.group', group.map((entry, i) => {
          const key = `${name} ${g}.${i}`;
          if (g === 2) return h('div.cell', { 'data-press': '', id: `pick${i}`, onclick: () => settings.pick(key, entry) }, h('span.grow', entry), h('span.soft', { id: `value${i}` }, settings.on[key] || 'Automatic'));
          const cell = h('div.cell', { 'data-press': '', id: `sw${g}${i}`, onclick: () => { settings.on[key] = !settings.on[key]; cell.querySelector('.switch').classList.toggle('on', settings.on[key]); K.set(key, settings.on[key]); } }, h('span.grow', entry), toggle(key));
          return cell;
        })));
      root.append(bar(name, { back: settings.path.length ? () => { settings.open(settings.path.pop(), 'pop'); } : null }), h('div.under', { 'data-pane': 'list', 'data-keep': '' }, h('div', { style: 'height:20px' }), groups, name === 'Privacy' ? h('div.group', h('div.cell', { 'data-press': '', id: 'erase', style: 'color:var(--bad)', onclick: () => K.ask('erase', { title: 'Erase history?', text: 'This cannot be undone.', yes: 'Erase', no: 'Cancel', run: () => { K.set('erased', true); K.$('#erase').style.opacity = 0.4; } }) }, 'Erase history')) : null, h('div', { style: 'height:60px' })));
    }, how);
  };
  settings.pick = (key, title) => K.open({ id: 'pick', kind: 'sheet', dim: 0.3, build: (box) => box.append(h('div.bold', { style: 'text-align:center;padding:8px' }, title), ...['Automatic', 'Always', 'Never', 'Ask first'].map((choice, i) => h('div.cell', { 'data-press': '', id: `choice${i}`, style: 'padding:14px 4px;border-top:1px solid var(--line)', onclick: () => { settings.on[key] = choice; K.close('pick', () => { const value = K.$(`#value${key.split('.')[1]}`); if (value) value.textContent = choice; }); K.set(key, choice); } }, choice))) });
  settings.scripts = {
    a: async (u) => {
      await u.scroll('list', 300); await u.rest(900);
      await u.scroll('list', -300); await u.rest(900);
      await u.tap('#go-Display'); await u.rest(1300);
      await u.tap('#sw00'); await u.rest(900);
      await u.tap('#sw01'); await u.rest(800);
      await u.scroll('list', 260); await u.rest(900);
      await u.tap('#pick0'); await u.rest(1200);
      await u.tap('#choice2'); await u.rest(1200);
      await u.tap('#pick1'); await u.rest(1000);
      await u.tap('.scrim'); await u.rest(1100);
      await u.tap('#back'); await u.rest(1100);
      await u.tap('#go-Privacy'); await u.rest(1200);
      await u.scroll('list', 600); await u.rest(800);
      await u.tap('#erase'); await u.rest(1200);
      await u.tap('#no'); await u.rest(900);
      await u.tap('#erase'); await u.rest(900);
      await u.tap('#yes'); await u.rest(1200);
      await u.tap('#back'); await u.rest(1000);
      await u.tap('#go-Display'); await u.rest(1200);
      await u.tap('#back'); await u.rest(900);
    },
    b: async (u) => {
      await u.tap('#go-Sound'); await u.rest(1100);
      await u.tap('#sw02'); await u.rest(700);
      await u.tap('#sw10'); await u.rest(700);
      await u.tap('#sw10'); await u.rest(900);
      await u.tap('#back'); await u.rest(1100);
      await u.scroll('list', 420); await u.rest(1000);
      K.open({ id: 'note', kind: 'toast', className: 'top', build: (box) => box.append(h('div.bold', K.name()), h('div', K.sentence())) });
      K.after(2600, () => K.close('note'));
      await u.rest(3600, 3800);
      await u.scroll('list', -420); await u.rest(800);
      await u.tap('#go-Storage'); await u.rest(1200);
      await u.scroll('list', 320); await u.rest(900);
      await u.tap('#pick1'); await u.rest(900);
      await u.tap('#choice1'); await u.rest(1100);
      await u.tap('#back'); await u.rest(900);
      await u.tap('#go-Sound'); await u.rest(1300);
      await u.tap('#back'); await u.rest(900);
    },
  };
  K.apps.settings = settings;

  // ── reel: a full screen of something that moves, one swipe apart
  const reel = { about: 'short videos: full-screen swipes, clips that never stop, comments over them', devices: ['phone'], theme: () => 'dark' };
  reel.card = (i) => h('div.reelcard', { 'data-card': i }, i % 3 === 1 ? K.picture(300, 650, 100 + i * 17, 'reelpicture') : K.clip(`clip ${i}`, 300, 650), h('div.reeltext', h('div.bold', `@${K.words(1)}${i}`), h('div', K.title(4, 7))), h('div.reelside', h('span.like', { id: `like${i}`, 'data-press': '', onclick: () => { K.$(`#like${i}`).classList.add('on'); K.set(`liked ${i}`, true); } }, '♥'), h('span', { id: `talk${i}`, 'data-press': '', onclick: () => reel.talk(i) }, '●'), h('span', '➤')));
  reel.build = () => {
    reel.i = 0;
    stage().append(h('div#reel', reel.card(0)), h('div.tabs', ['For you', 'Search', 'New', 'You'].map((name, k) => h(k ? 'span' : 'span.on', name))));
    K.at('reel/0');
  };
  reel.swipe = async (by) => {
    const host = K.$('#reel');
    const before = host.firstElementChild;
    reel.i += by;
    const next = reel.seen && reel.seen[reel.i] ? reel.seen[reel.i] : reel.card(reel.i);
    reel.seen = { ...(reel.seen || {}), [reel.i - by]: before, [reel.i]: next };
    host.append(next);
    const height = host.clientHeight;
    K.at(`reel/${reel.i}`, 'swipe');
    await K.tween('swipe', 380, (p) => { before.style.transform = `translateY(${-by * p * height}px)`; next.style.transform = `translateY(${by * (1 - p) * height}px)`; }, K.ease.out);
    before.remove();
    before.style.transform = '';
    next.style.transform = '';
  };
  reel.talk = (i) => K.open({ id: 'comments', kind: 'sheet', dim: 0.25, build: (box) => { box.style.height = '62%'; box.append(h('div.bold', { style: 'text-align:center;padding-bottom:8px' }, 'Comments'), h('div', { 'data-pane': 'comments', style: 'height:calc(100% - 40px)' }, Array.from({ length: 16 }, (_, k) => h('div', { style: 'padding:9px 0' }, h('div.small.soft', K.fixed(`by ${i}.${k}`, () => K.name())), K.fixed(`said ${i}.${k}`, () => K.sentence()))))); } });
  reel.scripts = {
    a: async (u) => {
      await u.rest(1800);
      await reel.swipe(1); await u.rest(2000);
      await u.tap('#like1'); await u.rest(900);
      await reel.swipe(1); await u.rest(2400);
      await u.tap('#talk2'); await u.rest(1300);
      await u.scroll('comments', 260); await u.rest(1100);
      await u.tap('.scrim'); await u.rest(1500);
      await reel.swipe(1); await u.rest(1600);
      await reel.swipe(-1); await u.rest(1700);
      await reel.swipe(1); await u.rest(1200);
      await reel.swipe(1); await u.rest(1700);
    },
    b: async (u) => {
      await u.rest(1400);
      await reel.swipe(1); await u.rest(1500);
      await reel.swipe(1); await u.rest(1300);
      await reel.swipe(1); await u.rest(1800);
      await u.tap('#talk3'); await u.rest(1500);
      await u.tap('.scrim'); await u.rest(1200);
      await reel.swipe(1); await u.rest(1700);
      await u.tap('#like4'); await u.rest(1200);
      await reel.swipe(-1); await u.rest(1500);
      await reel.swipe(-1); await u.rest(1500);
    },
  };
  K.apps.reel = reel;

  // ── feed: posts under each other, with pictures that come in late; into a post and back to the same place
  const feed = { about: 'a feed: scrolling, late pictures, into a post and back, stories, a notification', devices: ['phone'], theme: (script) => (script === 'b' ? 'sand' : '') };
  feed.post = (i) => {
    const post = feed.posts[i];
    const frame = h('div.photo', post.drawn || h('div.bones', { style: 'height:220px;margin:0' }));
    if (!post.drawn) K.after(K.between(300, 1400) + i * 60, () => { post.drawn = K.picture(360, 220, 31 * i + 9); frame.replaceChildren(post.drawn); if (frame.isConnected && i < 3) K.came(`photo ${i}`, 'loaded', 'load'); });
    return h('div.post', { id: `post${i}`, 'data-press': '', onclick: () => feed.open(i) }, h('div.row', h('span.face', { style: `background:hsl(${i * 47} 50% 60%)` }), h('div', h('div.bold', post.name), h('div.small.soft', `${i + 1} h`))), h('p', { style: 'margin:8px 0' }, post.text), i % 2 === 0 ? frame : null, h('div.row.soft.small', { style: 'padding-top:8px' }, h('span.grow', `${post.likes} likes`), h('span', 'share')));
  };
  feed.build = () => {
    feed.posts = Array.from({ length: 16 }, () => ({ name: K.name(), text: K.paragraph(1, 3), likes: K.whole(3, 900), talk: Array.from({ length: 12 }, () => [K.name(), K.sentence()]) }));
    feed.home('cut');
  };
  feed.home = (how) => K.show(stage(), 'feed/home', (root) => root.append(bar('Today', { right: h('span.soft', '✎') }), h('div.under', { 'data-pane': 'feed', 'data-keep': '', style: 'padding-bottom:90px' }, h('div.stories', { 'data-pane': 'stories' }, Array.from({ length: 12 }, (_, i) => h('span.story', { style: `background:hsl(${i * 33} 60% 62%)` }))), feed.posts.map((_, i) => feed.post(i))), h('div.tabs', ['Today', 'Find', 'News', 'You'].map((name, k) => h(k ? 'span' : 'span.on', name, k === 2 ? h('em', '3') : null)))), how);
  feed.open = (i) => K.show(stage(), `feed/post ${i}`, (root) => root.append(bar('Post', { back: () => { feed.home('pop'); } }), h('div.under', { 'data-pane': 'post', style: 'padding-bottom:90px' }, feed.post(i), feed.posts[i].talk.map(([name, text]) => h('div.reply', h('div.small.bold', name), text)))), 'push');
  feed.scripts = {
    a: async (u) => {
      await u.rest(1500);
      await u.scroll('feed', 480); await u.rest(1200);
      await u.scroll('feed', 620); await u.rest(1100);
      await u.tap('#post3'); await u.rest(1500);
      await u.scroll('post', 420); await u.rest(1200);
      await u.tap('#back'); await u.rest(1300);
      await u.scroll('feed', 560); await u.rest(1000);
      await u.scroll('feed', -900); await u.rest(1000);
      K.open({ id: 'note', kind: 'toast', className: 'top', build: (box) => box.append(h('div.bold', K.name()), h('div', K.sentence())) });
      K.after(2400, () => K.close('note'));
      await u.rest(3300, 3500);
      await u.tap('#post2'); await u.rest(1200);
      await u.tap('#back'); await u.rest(1100);
      await u.scroll('feed', -2000); await u.rest(1100);
    },
    b: async (u) => {
      await u.rest(1300);
      await u.scroll('feed', 700); await u.rest(900);
      await u.scroll('feed', 900); await u.rest(1000);
      await u.scroll('feed', 400, 'slow'); await u.rest(1100);
      await u.tap('#post6'); await u.rest(1200);
      await u.tap('#back'); await u.rest(1000);
      await u.scroll('feed', -3000); await u.rest(1000);
      const stories = K.pane('stories');
      await K.tween('scroll', 800, (p) => { stories.scrollLeft = 260 * p; K.touch(); }, K.ease.out); await u.rest(1200);
      await u.tap('#post0'); await u.rest(1300);
      await u.scroll('post', 300); await u.rest(900);
      await u.tap('#back'); await u.rest(1100);
    },
  };
  K.apps.feed = feed;

  // ── parley: an assistant that answers word by word
  const parley = { about: 'assistant chat: a question typed, an answer that streams, earlier chats', devices: ['phone', 'computer'], theme: (script) => (script === 'b' ? 'mint' : '') };
  parley.build = () => {
    parley.chats = [0, 1, 2, 3, 4].map((i) => ({ id: i, title: K.title(3, 5), talk: [['me', K.sentence()], ['it', Array.from({ length: K.phone ? 5 : 9 }, () => K.paragraph()).join('\n\n')], ['me', K.sentence()], ['it', K.paragraph()]] }));
    const history = h('div.history', h('button.main', { id: 'new-chat', onclick: () => { K.close('drawer'); parley.open(null); } }, '+ New chat'), parley.chats.map((chat) => h('div.entry', { 'data-h': `chat ${chat.id}`, 'data-press': '', id: `chat${chat.id}`, onclick: () => { K.close('drawer'); parley.open(chat); } }, h('span.cut', chat.title))));
    parley.history = history;
    const composer = h('div.composer2', h('textarea', { 'data-field': 'question', rows: 1, placeholder: 'Ask anything', oninput: (event) => { const field = event.target; field.style.height = 'auto'; field.style.height = `${Math.min(150, field.scrollHeight + 2)}px`; } }), h('button.main', { id: 'ask', onclick: () => parley.ask() }, '↑'));
    stage().append(K.phone ? h('div.parley', h('div.bar', h('button.plain', { id: 'menu', onclick: () => K.open({ id: 'drawer', kind: 'drawer', dim: 0.35, build: (box) => box.append(history) }) }, '☰'), h('span.title.cut', { id: 'chat-title' }, 'Parley'), h('button.plain', { id: 'more', onclick: () => parley.more() }, '⋯')), h('div#thread'), composer) : h('div.parley', history, h('div.main2', h('div.row.headbar', h('span.bold.cut.grow', { id: 'chat-title' }, 'Parley'), h('button.plain', { id: 'more', onclick: () => parley.more() }, '⋯')), h('div#thread'), composer)));
    parley.open(null);
  };
  parley.more = () => { const at = K.$('#more').getBoundingClientRect(); K.menu('more', [at.right - 210, at.bottom + 6], [{ label: 'Share' }, { label: 'Rename' }, { label: 'Find in chat' }, '-', { label: 'Archive' }, { label: 'Delete' }]); };
  parley.bubble = (who, text) => h(`div.bubble.${who}`, { 'data-bubble': '' }, text);
  parley.open = (chat) => {
    parley.chat = chat || { id: `new ${Math.round(K.now())}`, title: 'New chat', talk: [] };
    K.$('#chat-title').textContent = parley.chat.title;
    parley.history.querySelectorAll('.entry').forEach((entry) => entry.classList.toggle('on', chat && entry.id === `chat${chat.id}`));
    return K.show(K.$('#thread'), chat ? `chat/${chat.id}` : 'chat/welcome', (root) => root.append(h('div.thread.fill', { 'data-pane': 'thread', 'data-keep': '' }, parley.chat.talk.length ? parley.chat.talk.map(([who, text]) => parley.bubble(who, text)) : h('div.welcome', h('h1', 'Where should we start?'), ['Plan a trip', 'Write a letter', 'Learn something'].map((tip) => h('div.tipcard', tip))))), 'cut');
  };
  parley.ask = async () => {
    const field = K.$('[data-field=question]');
    const text = field.value;
    field.value = '';
    field.style.height = 'auto';
    const pane = K.pane('thread');
    if (!parley.chat.talk.length) {
      pane.replaceChildren();
      K.at(`chat/${parley.chat.id}`);
    }
    parley.chat.talk.push(['me', text]);
    pane.append(parley.bubble('me', text));
    K.came(`asked ${parley.chat.id}`, parley.chat.talk.length, 'sent');
    if (K.phone) K.keyboard.hide(); else field.blur();
    const wait = h('div.bubble.it', K.spinner('thinking'));
    pane.append(wait);
    pane.scrollTop = 1e6;
    await K.wait(K.between(700, 1500));
    const answer = Array.from({ length: K.phone ? 5 : 11 }, () => K.paragraph()).join('\n\n');
    const bubble = parley.bubble('it', '');
    wait.replaceWith(bubble);
    parley.chat.talk.push(['it', answer]);
    K.$('#chat-title').textContent = parley.chat.title = text.split(' ').slice(0, 5).join(' ');
    await K.stream(`answer ${parley.chat.id} ${parley.chat.talk.length}`, bubble, answer, pane, { rate: K.phone ? 60 : 90 });
  };
  const asks = { a: 'Can you recommend a few ways to spend a rainy day in a small town?', b: 'what makes a good map of a building' };
  parley.scripts = {
    a: async (u) => {
      await u.focus('question'); await u.rest(700, 1200);
      await u.type('question', asks.a, { pauses: 0.1, pace: 1.2 }); await u.rest(900);
      await u.click('#ask');
      await K.wait(2500);
      while (K.snapshot().streams.length) await K.wait(150);
      await u.rest(1300);
      await u.scroll('thread', -420); await u.rest(1200);
      await u.scroll('thread', -300); await u.rest(1000);
      await u.scroll('thread', 900); await u.rest(1000);
      await u.click('#more'); await u.rest(1100);
      await u.key('Escape'); await u.rest(1000);
      if (K.phone) { await u.tap('#menu'); await u.rest(1200); }
      await u.click('#chat1'); await u.rest(1600);
      await u.scroll('thread', 360); await u.rest(1100);
      if (K.phone) { await u.tap('#menu'); await u.rest(900); }
      await u.click('#new-chat'); await u.rest(1300);
      if (K.phone) { await u.tap('#menu'); await u.rest(900); }
      await u.click('#chat1'); await u.rest(1400);
    },
    b: async (u) => {
      if (K.phone) { await u.tap('#menu'); await u.rest(1000); }
      await u.click('#chat3'); await u.rest(1500);
      await u.scroll('thread', 300); await u.rest(1100);
      await u.focus('question'); await u.rest(600, 900);
      await u.type('question', asks.b, { pauses: 0.16, pace: 1.1, slips: 0.05 }); await u.rest(800);
      await u.click('#ask');
      await K.wait(2500);
      while (K.snapshot().streams.length) await K.wait(150);
      await u.rest(1200);
      await u.scroll('thread', -500); await u.rest(1200);
      if (K.phone) { await u.tap('#menu'); await u.rest(1000); }
      await u.click('#chat0'); await u.rest(1300);
      if (K.phone) { await u.tap('#menu'); await u.rest(1000); }
      await u.click('#chat3'); await u.rest(1500);
    },
  };
  K.apps.parley = parley;

  // ── larder: a shop, with pages that are made alike and a form
  const larder = { about: 'a shop: pages made alike, a basket, a form to fill in', devices: ['phone', 'computer'], theme: (script) => (script === 'b' ? 'slate' : 'mint') };
  larder.build = () => {
    larder.goods = Array.from({ length: 24 }, (_, i) => ({ id: i, name: K.title(1, 3), price: `€ ${K.whole(1, 19)},${K.pick(['25', '50', '95'])}`, text: K.paragraph(2, 4), shot: K.random() }));
    larder.basket = [];
    stage().append(h('div#shop'), K.phone ? h('div.tabs', h('span.on', { id: 'tab-shop', 'data-press': '', onclick: () => larder.list('fade') }, 'Shop'), h('span', 'Recipes'), h('span', { id: 'tab-basket', 'data-press': '', onclick: () => larder.show('fade') }, 'Basket', h('em', { id: 'count', style: 'display:none' })), h('span', 'You')) : h('div.row.shopbar', h('span.bold', '❖ Larder'), h('span.grow'), h('span', { id: 'tab-shop', 'data-press': '', onclick: () => larder.list('cut') }, 'Shop'), h('span', { id: 'tab-basket', 'data-press': '', onclick: () => larder.show('cut') }, 'Basket ', h('em', { id: 'count', style: 'display:none' }))));
    larder.list('cut');
  };
  const shot = (good, w, t) => K.picture(w, t, Math.floor(good.shot * 1e9));
  larder.list = (how) => K.show(K.$('#shop'), 'shop/list', (root) => root.append(K.phone ? bar('Shop') : '', h(`div.${K.phone ? 'under' : 'fill'}.shelf`, { 'data-pane': 'shelf', 'data-keep': '' }, h('div', { style: 'grid-column:1/-1' }, h('input', { 'data-field': 'look', placeholder: 'What are you looking for?', oninput: (event) => larder.look(event.target.value) })), h('div#goods.goods', larder.goods.map(larder.tile)))), how);
  larder.tile = (good) => h('div.good', { 'data-h': `good ${good.id}`, 'data-press': '', id: `good${good.id}`, onclick: () => larder.open(good) }, shot(good, 180, 130), h('div.bold.cut', good.name), h('div.small.soft', good.price));
  larder.look = (query) => { K.$('#goods').replaceChildren(...larder.goods.filter(({ name }) => name.toLowerCase().includes(query.toLowerCase())).map(larder.tile)); };
  larder.open = (good) => K.show(K.$('#shop'), `shop/good ${good.id}`, (root) => root.append(K.phone ? bar(good.name, { back: () => { larder.list('pop'); } }) : '', h(`div.${K.phone ? 'under' : 'fill'}.goodpage`, { 'data-pane': 'good' }, shot(good, 360, 240), h('div', h('h1', good.name), h('p.soft', good.price), h('p', good.text), h('p', h('button.main', { id: 'add', onclick: () => larder.add(good) }, 'Add to basket')), h('h2', { style: 'margin-top:24px' }, 'About this'), [0, 1, 2, 3].map((k) => h('p', K.fixed(`about ${good.id}.${k}`, () => K.paragraph())))))), K.phone ? 'push' : 'cut');
  larder.add = (good) => {
    larder.basket.push(good);
    const count = K.$('#count');
    count.style.display = '';
    count.textContent = String(larder.basket.length);
    K.set('basket', larder.basket.length);
    K.toast(`${good.name} is in your basket`, 1900);
  };
  larder.show = (how) => K.show(K.$('#shop'), 'shop/basket', (root) => root.append(K.phone ? bar('Basket') : '', h(`div.${K.phone ? 'under' : 'fill'}`, { 'data-pane': 'basket', style: 'padding:20px' }, larder.basket.map((good) => h('div.row', { style: 'padding:10px 0;border-bottom:1px solid var(--line)' }, h('span', { style: 'width:70px' }, shot(good, 70, 50)), h('span.grow', good.name), h('span', good.price))), h('p', { style: 'margin-top:20px' }, h('button.main', { id: 'pay', onclick: () => larder.form(K.phone ? 'push' : 'cut') }, 'Order')))), how);
  larder.form = (how) => K.show(K.$('#shop'), 'shop/form', (root) => root.append(K.phone ? bar('Order', { back: () => { larder.show('pop'); } }) : '', h(`div.${K.phone ? 'under' : 'fill'}`, { 'data-pane': 'form', style: 'padding:20px;max-width:560px' }, ['name', 'street', 'town'].map((field) => h('p', h('div.small.soft', field), h('input', { 'data-field': field }))), h('p', h('label.row', { id: 'agree', 'data-press': '', onclick: () => { const on = K.$('#agree .switch').classList.toggle('on'); K.set('agree', on); } }, h('span.grow', 'Send me a message'), h('span.switch'))), h('p', h('button.main', { id: 'order', onclick: () => larder.order() }, 'Place the order')))), how);
  larder.order = async () => {
    K.$('#order').replaceChildren(K.spinner('order'));
    if (K.phone) K.keyboard.hide();
    await K.wait(1300);
    K.ask('sure', { title: 'Place this order?', text: `${larder.basket.length} things, delivered on Thursday.`, yes: 'Yes', no: 'Not yet', dim: 0.42, run: () => K.show(K.$('#shop'), 'shop/done', (root) => root.append(h('div.welcome', { style: 'padding-top:30vh' }, h('h1', 'Thank you'), h('p.soft', K.sentence()))), 'fade') });
  };
  larder.scripts = {
    a: async (u) => {
      await u.scroll('shelf', 420); await u.rest(1100);
      await u.click('#good6'); await u.rest(1500);
      await u.click('#add'); await u.rest(2700);
      if (K.phone) await u.tap('#back'); else await u.click('#tab-shop');
      await u.rest(1200);
      await u.click('#good7'); await u.rest(1300);
      await u.scroll('good', 300); await u.rest(1000);
      await u.scroll('good', -300); await u.rest(700);
      if (K.phone) await u.tap('#back'); else await u.click('#tab-shop');
      await u.rest(1000);
      await u.click('#tab-basket'); await u.rest(1300);
      await u.click('#pay'); await u.rest(1100);
      await u.type('name', 'Ines Costa'); await u.rest(800);
      await u.type('street', 'Harbour Lane 12'); await u.rest(800);
      await u.type('town', 'Leiden'); await u.rest(900);
      if (K.phone) { await K.keyboard.hide(); await u.rest(800); }
      await u.click('#agree'); await u.rest(900);
      await u.click('#order'); await u.rest(2600);
      await u.click('#yes'); await u.rest(1300);
    },
    b: async (u) => {
      await u.type('look', K.pick(larder.goods).name.slice(0, 2).toLowerCase(), { slips: 0 }); await u.rest(1300);
      await u.erase('look', 2); await u.rest(600);
      if (K.phone) await K.keyboard.hide(); else K.$('[data-field=look]').blur();
      await u.rest(900);
      await u.scroll('shelf', 600); await u.rest(1000);
      await u.scroll('shelf', 300); await u.rest(900);
      const mid = larder.goods.find((good) => { const box = K.$(`#good${good.id}`).getBoundingClientRect(); return box.top > 140 && box.bottom < innerHeight - 110; });
      await u.click(`#good${mid.id}`); await u.rest(1300);
      await u.click('#add'); await u.rest(2600);
      await u.click('#tab-basket'); await u.rest(1200);
      await u.click('#tab-shop'); await u.rest(1200);
      await u.click('#tab-basket'); await u.rest(1000);
      await u.click('#pay'); await u.rest(1000);
      await u.type('name', 'Karim Haas', { slips: 0.06 }); await u.rest(1500);
      await u.type('town', 'Utrecht'); await u.rest(1000);
      if (K.phone) { await K.keyboard.hide(); await u.rest(700); }
      await u.click('#order'); await u.rest(2400);
      await u.click('#no'); await u.rest(1200);
    },
  };
  K.apps.larder = larder;
})();
