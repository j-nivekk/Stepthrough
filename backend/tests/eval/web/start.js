'use strict';
// Without a scenario: what there is to watch or to use. With one: begin.
(() => {
  const scenarios = Object.entries(Kit.apps).flatMap(([name, app]) => Object.keys(app.scripts).map((script) => ({ name: `${name}_${script}`, devices: app.devices, about: app.about })));
  Kit.scenarios = scenarios;
  if (Kit.scenario) {
    if (Kit.mode !== 'record') {
      Kit.begin(Kit.scenario).then(Kit.live);
      // Start the recording, press start, use the app, press done: the flash at both ends ties the log to the video.
      const button = document.createElement('button');
      button.className = 'save-log';
      button.textContent = Kit.mode === 'free' ? 'start' : 'save the log';
      button.onclick = async () => {
        if (Kit.mode === 'free') await Kit.flash();
        if (button.textContent === 'start') button.textContent = 'done';
        else Kit.download();
      };
      document.documentElement.append(button);
    }
    return;
  }
  document.body.className = 'index';
  document.body.append(
    h('h1', 'Stepthrough web tester'),
    h('p', 'Mock apps with scripted people, to make screen recordings of which is known what happens in them. Watch a script play, or use an app yourself while you record the screen, and save the log when you are done.'),
    h('table', scenarios.flatMap(({ name, devices, about }) => devices.map((device) => h('tr',
      h('td', name), h('td', device), h('td', about),
      h('td', h('a', { href: `?scenario=${name}&device=${device}&mode=play` }, 'watch')),
      h('td', h('a', { href: `?scenario=${name}&device=${device}&mode=free` }, 'use it yourself'))))),
    ),
  );
})();
