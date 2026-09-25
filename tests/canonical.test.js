// @vitest-environment node
// tests/canonical.test.js
// The agent's path is what the agent said, in order: menus above the first
// named step are filled in, nothing between named steps is.
import { describe, test, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { toCanonicalPath, missingEdges } = require('../server/lib/canonical.js');
const tax = require('../server/lib/taxonomy.js');

const NONE = { aliases: {}, edges: {} };
const path = (steps, learned = NONE) => {
  const canon = toCanonicalPath(steps, learned);

  return Object.assign(canon, { labels: tax.displayPath(canon.canonical_path) });
};

describe('toCanonicalPath', () => {
  test('the full documented walk is ok', () => {
    expect(path(['Settings', 'Security', 'Authentication'])).toMatchObject({
      status: 'ok',
      labels: ['Settings', 'Security', 'Authentication']
    });
  });

  test('menus above the first named step are filled in', () => {
    expect(path(['Security', 'Authentication'])).toMatchObject({
      status: 'ok',
      labels: ['Settings', 'Security', 'Authentication']
    });
  });

  // "1.Settings 2.My account 3.Authentication 4.Enter password".
  test('skipping a menu between named steps is not the documented path', () => {
    const canon = path(['settings', 'my account', 'authentication', 'enter password']);

    expect(canon).toMatchObject({
      status: 'inconsistent',
      labels: ['Settings', 'Authentication'],
      unknown_labels: ['my account', 'enter password']
    });
    expect(missingEdges(canon.mapped_nodes, {})).toEqual([{ from: 'node_settings', to: 'node_auth' }]);
  });

  test('the right steps in the wrong order are not the documented path', () => {
    expect(path(['Settings', 'Authentication', 'Security'])).toMatchObject({
      status: 'inconsistent',
      labels: ['Settings', 'Authentication', 'Security']
    });
  });

  test('a learned shortcut edge makes the skip a known route', () => {
    const learned = { aliases: {}, edges: { node_auth: ['node_settings'] } };

    expect(path(['Settings', 'Authentication'], learned)).toMatchObject({
      status: 'ok',
      labels: ['Settings', 'Authentication']
    });
  });
});
