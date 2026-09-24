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
    expect(path(['Profile', 'Authentication', 'Security', 'Reset Security Token'])).toMatchObject({
      status: 'ok',
      labels: ['Profile', 'Authentication', 'Security', 'Reset Security Token']
    });
  });

  test('menus above the first named step are filled in', () => {
    expect(path(['Security', 'Reset Security Token'])).toMatchObject({
      status: 'ok',
      labels: ['Profile', 'Authentication', 'Security', 'Reset Security Token']
    });
  });

  // Ticket 12: "1.Settings 2.Profile 3.Security 4.Enter password 5.Reset token".
  test('skipping a menu between named steps is not the documented path', () => {
    const canon = path(['settings', 'profile', 'security', 'enter password', 'reset security token']);

    expect(canon).toMatchObject({
      status: 'inconsistent',
      labels: ['Profile', 'Security', 'Reset Security Token'],
      unknown_labels: ['settings', 'enter password']
    });
    expect(missingEdges(canon.mapped_nodes, {})).toEqual([{ from: 'node_profile', to: 'node_security' }]);
  });

  test('the right steps in the wrong order are not the documented path', () => {
    expect(path(['Profile', 'Security', 'Authentication', 'Reset Security Token'])).toMatchObject({
      status: 'inconsistent',
      labels: ['Profile', 'Security', 'Authentication', 'Reset Security Token']
    });
  });

  test('a learned shortcut edge makes the skip a known route', () => {
    const learned = { aliases: {}, edges: { node_security: ['node_profile'] } };

    expect(path(['Profile', 'Security', 'Reset Security Token'], learned)).toMatchObject({
      status: 'ok',
      labels: ['Profile', 'Security', 'Reset Security Token']
    });
  });
});
