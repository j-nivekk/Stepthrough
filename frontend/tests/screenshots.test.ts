import assert from 'node:assert/strict';
import test from 'node:test';

import { SCREENSHOT_WIDTHS, screenshotUrl, screenshotWidth } from '../src/lib/screenshots';

test('a screenshot is asked for as the smallest copy still sharp at the size and on the screen it is drawn', () => {
  assert.deepEqual([...SCREENSHOT_WIDTHS], [320, 640, 1280]); // as backend/app/thumbnails.py WIDTHS
  assert.equal(screenshotWidth(34, 2), 320); // a menu thumbnail on a retina screen
  assert.equal(screenshotWidth(272, 1), 320); // a pathway box
  assert.equal(screenshotWidth(272, 2), 640);
  assert.equal(screenshotWidth(420, 2), 1280); // the largest step card
  assert.equal(screenshotWidth(816, 1), 1280); // a downloaded figure's screenshots
  assert.equal(screenshotWidth(700, 2), null); // wider than any copy: the screenshot itself
  assert.equal(screenshotWidth(200, 0.5), 320, 'a zoomed-out page still gets at least one pixel per CSS pixel');
});

test('the address asks the asset route for that copy, or for the screenshot itself', () => {
  const url = '/assets/projects/p-1/recordings/r/runs/x/frames/candidate-001.png';
  assert.ok(screenshotUrl(url, 272, 2).endsWith('/frames/candidate-001.png?w=640'));
  assert.ok(screenshotUrl(url).endsWith('/frames/candidate-001.png'));
  assert.ok(screenshotUrl(url, null).endsWith('/frames/candidate-001.png'));
  assert.ok(screenshotUrl(`${url}?v=2`, 34, 1).endsWith('candidate-001.png?v=2&w=320'));
});
