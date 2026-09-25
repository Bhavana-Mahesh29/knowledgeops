// test.js - run with `node test.js`. Proves the ported decision logic before
// it goes anywhere near the FDK sandbox: no FDK globals, no network calls.
//
// The modules under server/lib export through both `exports` (what the FDK
// sandbox reads) and `module.exports` (what Node reads), which is what lets
// this file require them directly.
'use strict';
const tax = require('./server/lib/taxonomy');
const { toCanonicalPath, missingEdges } = require('./server/lib/canonical');
const { scoreCluster } = require('./server/lib/scoring');
const { validatePatch } = require('./server/lib/validator');
const { templatePatch } = require('./server/lib/architect');
const {
  htmlToMarkdown, normaliseArticleMarkdown, documentedPathOf, stepsHeadingOf, restoreStepsHeading
} = require('./server/lib/markdown');
const { redact } = require('./server/lib/redact');

let failures = 0;

function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);

  if (a === e) {
    console.log(`  OK   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}\n       got:      ${a}\n       expected: ${e}`);
  }
}

console.log('--- canonical.js ---');
// The route agents walk now for two-step verification.
assertEq(
  toCanonicalPath(['settings', 'security', 'two-step verification']).canonical_path,
  ['node_settings', 'node_security', 'node_two_step'],
  'full path maps cleanly'
);
// Menus above the first named step are filled in (an agent who starts at
// "Security" is standing somewhere); nothing between named steps is.
assertEq(
  toCanonicalPath(['security', 'two-step verification']).canonical_path,
  ['node_settings', 'node_security', 'node_two_step'],
  'menus above the first named step are filled in'
);
assertEq(
  toCanonicalPath(['suraksha', 'two-step verification']).canonical_path.slice(-1),
  ['node_two_step'],
  'regional alias maps'
);
assertEq(toCanonicalPath([]).status, 'no_steps', 'no steps is its own status');
assertEq(toCanonicalPath(['frobnicate', 'wibble']).status, 'has_unknown', 'nothing resolvable -> has_unknown');

// A leftover label no longer discards the ticket; the resolved part still
// counts. Real replies name buttons and form fields that are not menus.
const PARTIAL = toCanonicalPath([
  'settings', 'security', 'two-step verification',
  'scan the qr code', 'enter the 6-digit code'
]);

assertEq(
  PARTIAL.canonical_path,
  ['node_settings', 'node_security', 'node_two_step'],
  'the real agent reply resolves to the full path'
);
assertEq(PARTIAL.status, 'ok', 'partially resolved ticket is still usable evidence');
assertEq(PARTIAL.partial, true, 'partial flag is set');
assertEq(
  PARTIAL.unknown_labels,
  ['scan the qr code', 'enter the 6-digit code'],
  'form actions are reported, not dropped'
);
assertEq(
  toCanonicalPath(['click security'], { aliases: { 'click security': 'node_security' } }).canonical_path,
  ['node_settings', 'node_security'],
  'a learned alias resolves through the overlay'
);

// The learned overlay outlives edits to taxonomy.js. A dangling entry must be
// ignored, not fed into the lineage walk - that returned [] and reported a
// clean ticket as 'inconsistent'.
const DANGLING = toCanonicalPath(
  ['settings', 'security', 'click two-step verification'],
  { aliases: { 'click two-step verification': 'node_gone' } }
);

assertEq(DANGLING.status, 'ok', 'an alias pointing at a deleted node is ignored');
assertEq(
  DANGLING.unknown_labels,
  ['click two-step verification'],
  'the dangling label falls back to unknown, ready to be relearned'
);

console.log('\n--- canonical.js: the graph, and routes it has to learn ---');
// Agents reaching Two-Step Verification straight from Profile. No single
// route joins those up until the graph gains the missing edge - an alias
// cannot fix this, because every label involved already resolved.
const T5 = ['profile', '2fa page'];
const T5_ALIASES = { aliases: { '2fa page': 'node_two_step' } };
const BEFORE = toCanonicalPath(T5, T5_ALIASES);

assertEq(BEFORE.status, 'inconsistent', 'a route the graph cannot join up is inconsistent');
assertEq(
  missingEdges(BEFORE.mapped_nodes, {}),
  [{ from: 'node_profile', to: 'node_two_step' }],
  'the gap is reported as a candidate edge'
);

const T5_LEARNED = {
  aliases: T5_ALIASES.aliases,
  edges: { node_two_step: ['node_profile'] }
};
const AFTER = toCanonicalPath(T5, T5_LEARNED);

assertEq(AFTER.status, 'ok', 'once the edge is learned the same ticket resolves');
assertEq(
  AFTER.canonical_path,
  ['node_settings', 'node_profile', 'node_two_step'],
  'and canonicalises onto the learned route'
);
assertEq(
  toCanonicalPath(['settings', 'security', 'two-step verification'], T5_LEARNED).canonical_path,
  ['node_settings', 'node_security', 'node_two_step'],
  'the authored route still wins for tickets that walk it'
);
assertEq(
  tax.lineages('node_two_step', T5_LEARNED.edges).length,
  2,
  'the destination is reachable two ways'
);
assertEq(
  tax.lineages('node_two_step', { node_settings: ['node_two_step'] }).length,
  1,
  'a cyclic edge shortens the route rather than deleting the node'
);

console.log('\n--- taxonomy.js: alias promotion targets ---');
assertEq(tax.bestNodeFor('click two-step verification').nodeId, 'node_two_step', 'reworded label finds its node');
assertEq(tax.bestNodeFor('click security').nodeId, 'node_security', 'filler words alone still resolve');
assertEq(tax.bestNodeFor('go to profile').nodeId, 'node_profile', 'a one-word node is reachable');
assertEq(tax.bestNodeFor('step verification').nodeId, 'node_two_step', 'an abbreviated label finds its node');
assertEq(
  tax.bestNodeFor('the authentication page').nodeId,
  'node_auth',
  'a superseded page is still recognisable - the validator, not the matcher, refuses to publish a deprecated one'
);
assertEq(tax.bestNodeFor('enter password'), null, 'a label matching nothing is refused');
assertEq(tax.bestNodeFor('confirm and generate new token'), null, 'one shared token is not enough');
assertEq(tax.bestNodeFor('token'), null, 'a single-token overlap is refused');

console.log('\n--- scoring.js: the four-article result ---');
const A = scoreCluster({ explicit: 4, total: 4, agents: 4, denom: 5, reopens: 0, baselineReopen: 0.0 });

assertEq(A.band, 'critical', 'Article A -> critical');
assertEq(Math.round(A.confidence * 100) / 100, 0.88, 'Article A -> confidence 0.88');

const B = scoreCluster({ explicit: 4, total: 4, agents: 1, denom: 4, reopens: 0, baselineReopen: 0.0 });

assertEq([B.band, B.reason], ['blocked', 'K'], 'Article B -> blocked at K');

const C = scoreCluster({ explicit: 4, total: 4, agents: 3, denom: 4, reopens: 1, baselineReopen: 0.0 });

assertEq([C.band, C.confidence], ['vetoed', 0.0], 'Article C -> vetoed');

const D = scoreCluster({ explicit: 4, total: 4, agents: 3, denom: 12, reopens: 0, baselineReopen: 0.0 });

assertEq([D.band, D.reason], ['blocked', 'X'], 'Article D -> blocked at X');

console.log('\n--- validator.js ---');

// An article documenting the current route, and a patch aiming at the other
// one - the shape that exercises the deprecation check either way.
const SEEDED_STALE = `# How to enable two-factor authentication
## Steps
1. Go to **Settings** → **Security** → **Two-Step Verification**.
`;
const RETIRED_TARGET = ['node_settings', 'node_security', 'node_auth'];

const ORIGINAL = `# How to enable two-factor authentication
## Overview
Use this guide to add a second sign-in step.
## Steps
1. Go to **Settings** → **Security** → **Authentication**.
2. Click *Enable Two-Factor Authentication*.
## Troubleshooting
Contact IT if the QR code does not scan.
`;
const EXPECTED = ['node_settings', 'node_security', 'node_two_step'];
const OLD_BOLD = '**Settings** → **Security** → **Authentication**';
const NEW_BOLD = '**Settings** → **Security** → **Two-Step Verification**';
const GOOD_PATCH = ORIGINAL.replace(OLD_BOLD, NEW_BOLD);

assertEq(validatePatch(ORIGINAL, GOOD_PATCH, EXPECTED).passed, true, 'well-formed patch passes');

const SKIPPED = ORIGINAL.replace(OLD_BOLD, '**Two-Step Verification**');

assertEq(validatePatch(ORIGINAL, SKIPPED, EXPECTED).passed, false, 'patch that skips levels is rejected');

const EDITED_OTHER = GOOD_PATCH.replace('Use this guide', 'Use this handy guide!!');

assertEq(validatePatch(ORIGINAL, EDITED_OTHER, EXPECTED).passed, false, 'patch editing another section is rejected');

// Deprecation is configuration: no node ships deprecated, because whether a
// menu item is really gone is a statement about the product. Flip one and the
// validator must refuse to publish any patch that reintroduces it.
tax.TAXONOMY.nodes.node_auth.is_deprecated = true;
assertEq(
  validatePatch(SEEDED_STALE, templatePatch(SEEDED_STALE, tax.displayPath(RETIRED_TARGET)), RETIRED_TARGET)
    .passed,
  false,
  'a patch reintroducing a deprecated step is rejected'
);
tax.TAXONOMY.nodes.node_auth.is_deprecated = false;
assertEq(
  validatePatch(SEEDED_STALE, templatePatch(SEEDED_STALE, tax.displayPath(RETIRED_TARGET)), RETIRED_TARGET)
    .passed,
  true,
  'and accepted once that step is live again'
);

console.log('\n--- architect.js: the deterministic fallback ---');
const TEMPLATED = templatePatch(ORIGINAL, tax.displayPath(EXPECTED));

assertEq(
  validatePatch(ORIGINAL, TEMPLATED, EXPECTED).passed,
  true,
  'template patch passes the same validator'
);
assertEq(
  TEMPLATED.includes('## Troubleshooting\nContact IT if the QR code does not scan.'),
  true,
  'template patch leaves other sections untouched'
);

console.log('\n--- markdown.js: the Freshdesk round trip ---');
const HTML = '<h2>Enable two-factor authentication</h2><p>Use this guide to add a second sign-in step.</p>'
  + '<h3>Steps</h3><ol><li>Go to <b>Settings</b> &rarr; <b>Security</b> &rarr; <b>Authentication</b>.</li>'
  + '<li>Click <i>Enable Two-Factor Authentication</i>.</li></ol>'
  + '<h3>Troubleshooting</h3><p>Contact IT if the QR code does not scan.</p>';
const SEEDED = normaliseArticleMarkdown(htmlToMarkdown(HTML), 'Enable two-factor authentication');

assertEq(
  documentedPathOf(SEEDED),
  ['node_settings', 'node_security', 'node_auth'],
  'documented path read from the HTML'
);
assertEq(
  validatePatch(SEEDED, templatePatch(SEEDED, tax.displayPath(EXPECTED)), EXPECTED).passed,
  true,
  'a Freshdesk-sourced article is patchable'
);

// How the knowledge base actually writes it: a "Step-by-Step Instructions"
// heading, labelled steps, buttons in bold, and a menu named again at the end.
const AUTHORED = htmlToMarkdown('<h3>Overview</h3><p>Update your details.</p>'
  + '<h3>Step-by-Step Instructions</h3><ol>'
  + '<li><strong>Access Profile:</strong> Go to <strong>Settings</strong> &rarr; <strong>Profile</strong>.</li>'
  + '<li><strong>Edit Details:</strong> Click <strong>Edit</strong>, then <strong>Save</strong>.</li>'
  + '<li>The details appear on the <strong>Profile</strong> page.</li></ol>');
const AUTHORED_MD = normaliseArticleMarkdown(AUTHORED, 'Update your profile');

assertEq(
  documentedPathOf(AUTHORED_MD),
  ['node_settings', 'node_profile', 'node_edit'],
  'a Step-by-Step Instructions section is read as the Steps, buttons ignored, repeats counted once'
);
assertEq(stepsHeadingOf(AUTHORED), 'Step-by-Step Instructions', 'the authored heading is remembered');
assertEq(
  restoreStepsHeading(AUTHORED_MD, 'Step-by-Step Instructions').includes('## Step-by-Step Instructions\n'),
  true,
  'and put back when publishing'
);

const NO_STEPS = normaliseArticleMarkdown(
  htmlToMarkdown('<h1>Enable 2FA</h1><p>Go to <b>Settings</b> &rarr; <b>Security</b>.</p>'),
  'Enable 2FA'
);

assertEq(
  documentedPathOf(NO_STEPS),
  ['node_settings', 'node_security'],
  'an article with no Steps heading gets one'
);

// The state article 1130000051335 was actually in: template boilerplate, and
// not one taxonomy node among its bold spans.
assertEq(
  documentedPathOf(normaliseArticleMarkdown(
    htmlToMarkdown('<h1>How-to</h1><p>Give an introduction. Click <b>New Article</b>.</p>'),
    'How-to'
  )),
  [],
  'an unwritten article documents no path at all'
);

console.log('\n--- redact.js ---');
const REDACTED = redact('Mail me at agent@example.com or call 98765 43210.\n- Priya');

assertEq(REDACTED.redactedText.includes('agent@example.com'), false, 'email is removed');
assertEq(REDACTED.redactedText.includes('98765 43210'), false, 'phone number is removed');
assertEq(REDACTED.entityCounts.PERSON_SIGNOFF, 1, 'agent sign-off is removed');

console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
