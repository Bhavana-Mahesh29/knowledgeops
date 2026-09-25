// server/lib/taxonomy.js
// The versioned UI navigation graph. Pure JS, no FDK dependency - testable
// with plain node.
//
// THIS FILE IS PRODUCT CONFIGURATION, NOT SAMPLE DATA. Every later stage
// reasons over it: canonical.js resolves agent wording against it,
// scoring.js clusters on paths drawn from it, and validator.js refuses any
// patch whose bold steps are not nodes in it.
//
// It is a graph, not a tree, because real UIs reach the same destination by
// more than one route - a page can sit under one menu on the current route
// and another on a superseded one. A single-parent model forced those two
// facts to contradict each other and reported honest tickets as
// 'inconsistent'. Routes the app learns from tickets become extra parents.
//
// Two things here are learned rather than authored, and live in $db instead
// of this file: extra aliases for nodes, and extra parent edges. Both are
// layered on per call, so editing this file is always safe.
'use strict';

// Modelled on the menus the knowledge base at knowledgeopshack.freshdesk.com
// documents. Only navigation menus are nodes - buttons such as Save, Verify
// or Submit are not, so they never count as a step.
//
// Aliases are kept specific on purpose. The offline extractor scans reply
// text for every alias, so a bare everyday word ("account", "file") would
// turn up in replies that never mention that menu.
//
// Set is_deprecated on a node only when that menu item is genuinely gone
// from the product. Doing so is a deliberate statement, not a guess - the
// validator will then refuse to publish any patch containing it, which makes
// every alert targeting that route unapprovable by design.
const TAXONOMY = {
  version: '2026-09-26',
  nodes: {
    node_settings:        { parents: [],                  label: 'Settings',              aliases: ['settings', 'settings menu'], is_deprecated: false },

    // Settings -> Security: where sign-in protection lives. Authentication is
    // the page the articles document for 2FA; Two-Step Verification is the
    // page the current release moved it to.
    node_security:        { parents: ['node_settings'],   label: 'Security',              aliases: ['security', 'security tab', 'suraksha'], is_deprecated: false },
    node_auth:            { parents: ['node_security'],   label: 'Authentication',        aliases: ['authentication', 'auth'], is_deprecated: false },
    node_two_step:        { parents: ['node_security'],   label: 'Two-Step Verification', aliases: ['two-step verification', 'two step verification', '2-step verification', 'two-step verification page'], is_deprecated: false },

    // Settings -> Profile is the documented way to change personal details;
    // Settings -> Account Center -> Personal Info is the newer one.
    node_profile:         { parents: ['node_settings'],   label: 'Profile',               aliases: ['profile', 'my profile', 'user profile'], is_deprecated: false },
    node_edit:            { parents: ['node_profile'],    label: 'Edit',                  aliases: ['edit', 'edit profile'], is_deprecated: false },
    node_account_center:  { parents: ['node_settings'],   label: 'Account Center',        aliases: ['account center', 'account centre'], is_deprecated: false },
    node_personal_info:   { parents: ['node_account_center'], label: 'Personal Info',     aliases: ['personal info', 'personal information', 'personal details'], is_deprecated: false },

    node_wifi:            { parents: ['node_settings'],   label: 'Wi-Fi',                 aliases: ['wi-fi', 'wifi', 'wireless'], is_deprecated: false },

    node_login:           { parents: [],                  label: 'Login',                 aliases: ['login', 'login page', 'sign-in page'], is_deprecated: false },
    node_forgot_password: { parents: ['node_login'],      label: 'Forgot Password',       aliases: ['forgot password', 'forgot your password'], is_deprecated: false },

    node_help_portal:     { parents: [],                  label: 'Help Portal',           aliases: ['help portal', 'support portal', 'it help portal'], is_deprecated: false },
    node_new_ticket:      { parents: ['node_help_portal'], label: 'New Ticket',           aliases: ['new ticket', 'raise a ticket'], is_deprecated: false },
    node_software_catalog: { parents: ['node_help_portal'], label: 'Software Catalog',    aliases: ['software catalog', 'software catalogue'], is_deprecated: false },

    node_onedrive:        { parents: [],                  label: 'OneDrive',              aliases: ['onedrive', 'one drive'], is_deprecated: false },
    node_recycle_bin:     { parents: ['node_onedrive'],   label: 'Recycle Bin',           aliases: ['recycle bin'], is_deprecated: false },
  },
};

function normalise(label) {
  return String(label).toLowerCase().trim().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ');
}

function buildAliasIndex() {
  const index = {};

  for (const [nodeId, node] of Object.entries(TAXONOMY.nodes)) {
    for (const alias of node.aliases) {
      index[normalise(alias)] = nodeId;
    }
    index[normalise(node.label)] = nodeId;
  }

  return index;
}
const ALIAS_INDEX = buildAliasIndex();

function node(nodeId) {
  return TAXONOMY.nodes[nodeId] || null;
}

function lookup(label) {
  return ALIAS_INDEX[normalise(label)] || null;
}

// Same lookup, plus aliases the app has learned at runtime.
//
// The learned map outlives edits to this file, so an entry can end up
// pointing at a node id that no longer exists. Such an entry is ignored
// rather than returned: a dangling id would otherwise flow into the lineage
// walk, come back empty, and turn a good ticket into 'inconsistent'. Ignoring
// it also lets the promotion pass relearn the label against the current tree.
function lookupWith(label, aliases) {
  const key = normalise(label);
  const learned = aliases ? aliases[key] : null;

  return ALIAS_INDEX[key] || (node(learned) === null ? null : learned);
}

function isDeprecated(nodeId) {
  const n = node(nodeId);

  return n === null ? false : n.is_deprecated;
}

// Falls back to the raw id so a stale node id stored on an old alert renders
// as something readable instead of throwing.
function displayLabel(nodeId) {
  const n = node(nodeId);

  return n === null ? String(nodeId) : n.label;
}

function displayPath(nodeIds) {
  return (nodeIds || []).map(displayLabel);
}

// ---- Navigation graph ---------------------------------------------------

function parentsOf(nodeId, edges) {
  const n = node(nodeId);
  const learned = (edges && edges[nodeId]) || [];

  return [...n.parents, ...learned.filter((p) => node(p) !== null)];
}

// Every route from a root down to this node. `seen` drops any branch that
// loops back on itself, which a learned edge could otherwise create.
function lineagesFrom(nodeId, edges, seen) {
  if (node(nodeId) === null || seen.has(nodeId)) {
    return [];
  }

  const walked = new Set(seen).add(nodeId);
  const routes = [];

  for (const parent of parentsOf(nodeId, edges)) {
    for (const chain of lineagesFrom(parent, edges, walked)) {
      routes.push([...chain, nodeId]);
    }
  }

  // Nothing usable upwards: either this is a root, or every parent branch
  // looped back on itself. The node is still a valid starting point either
  // way - a bad learned edge should shorten a route, never delete the node
  // and take every ticket that mentions it down with it.
  return routes.length ? routes : [[nodeId]];
}

function lineages(nodeId, edges) {
  return lineagesFrom(nodeId, edges, new Set());
}

// True when `ancestorId` sits on any route down to `nodeId` - i.e. adding it
// as a parent would close a loop, or it is already reachable.
function hasAncestor(nodeId, ancestorId, edges) {
  return lineages(nodeId, edges).some((chain) => chain.includes(ancestorId));
}

// ---- Alias learning -----------------------------------------------------

// Words that carry no menu meaning. Agents write "go to the security tab and
// then click reset token"; only 'security', 'tab', 'reset', 'token' matter.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'from', 'your',
  'my', 'then', 'new', 'go', 'goto', 'click', 'tap', 'select', 'open', 'choose',
  'hit', 'press', 'page', 'screen', 'option', 'button', 'menu'
]);

function contentTokens(label) {
  const all = normalise(label).split(' ').filter((t) => t !== '');
  const kept = all.filter((t) => !STOPWORDS.has(t));

  return kept.length ? kept : all;
}

// A single matched token is how coincidences get in ("export your data" would
// otherwise claim Export), so a candidate needs at least two.
const MIN_ALIAS_SCORE = 2;

function overlapScore(labelTokens, term) {
  const termTokens = contentTokens(term);

  if (termTokens.length === 0) {
    return 0;
  }

  // The node's whole name appears in the label: "click security" -> Security.
  // Once filler words are gone an exact match is not a coincidence, so it
  // clears the bar on its own.
  if (termTokens.every((t) => labelTokens.includes(t))) {
    return termTokens.length === labelTokens.length
      ? Math.max(termTokens.length, MIN_ALIAS_SCORE)
      : termTokens.length;
  }

  // The label is an abbreviation of the node: "api details" -> API & Security
  // Details.
  return labelTokens.every((t) => termTokens.includes(t)) ? labelTokens.length : 0;
}

function nodeScore(labelTokens, nodeId) {
  const n = node(nodeId);

  return Math.max(...[n.label, ...n.aliases].map((term) => overlapScore(labelTokens, term)));
}

// Deliberately narrow: this recognises a rewording of a node the taxonomy
// already has. It never invents a node, and it refuses outright when two
// nodes match equally well.
//
// Deprecated nodes ARE valid targets. Recognising that an agent walked the
// old route is the whole mechanism by which drift gets noticed; refusing to
// *publish* a deprecated step is a separate concern, enforced by the
// validator. Conflating the two made the superseded branch invisible.
function bestNodeFor(label) {
  const labelTokens = contentTokens(label);
  const ranked = Object.keys(TAXONOMY.nodes)
    .map((nodeId) => ({ nodeId, score: nodeScore(labelTokens, nodeId) }))
    .filter((scored) => scored.score >= MIN_ALIAS_SCORE)
    .sort((a, b) => b.score - a.score);

  if (ranked.length === 0) {
    return null;
  }

  if (ranked.length > 1 && ranked[1].score === ranked[0].score) {
    return null;
  }

  return ranked[0];
}

const api = {
  TAXONOMY,
  lookup,
  lookupWith,
  bestNodeFor,
  contentTokens,
  node,
  parentsOf,
  lineages,
  hasAncestor,
  isDeprecated,
  displayLabel,
  displayPath,
  normalise
};

// FDK's serverless sandbox exposes `exports` but no `module`; plain Node needs
// `module.exports`. Supporting both keeps these files loadable by `node test.js`.
exports = api;
if (typeof module === 'object') {
  module.exports = api;
}
