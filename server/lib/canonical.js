// server/lib/canonical.js
// Stage 3a: turns raw extracted step labels into a canonical taxonomy path.
'use strict';
const tax = require('./taxonomy');

// Splits the raw labels into the ones the taxonomy recognises and the ones it
// does not. Kept separate from toCanonicalPath to keep both under the
// cyclomatic-complexity budget FDK lints for (max 7).
function mapSteps(steps, aliases) {
  const mapped = [];
  const unknown = [];

  for (const step of steps) {
    const node = tax.lookupWith(step, aliases);

    if (node === null) {
      unknown.push(step);
    } else {
      mapped.push(node);
    }
  }

  return { mapped, unknown };
}

function longest(routes) {
  return routes.reduce((best, chain) => (chain.length > best.length ? chain : best), routes[0]);
}

// The destination can be reachable by several routes. The right one is the
// route that accounts for every node the agent actually named; if none does,
// the agent described something the graph cannot join up and the ticket is
// inconsistent.
function chooseRoute(mapped, edges) {
  const routes = tax.lineages(mapped[mapped.length - 1], edges);

  if (routes.length === 0) {
    return { route: [], consistent: false };
  }

  const covering = routes.filter((chain) => mapped.every((n) => chain.includes(n)));

  return covering.length
    ? { route: longest(covering), consistent: true }
    : { route: longest(routes), consistent: false };
}

function result(status, canonicalPath, unknown, mapped) {
  return {
    status,
    canonical_path: canonicalPath,
    unknown_labels: unknown,
    mapped_nodes: mapped,
    // 'ok' but built from only part of what the agent said. The path is
    // usable as evidence; the leftovers are logged as taxonomy candidates.
    partial: status === 'ok' && unknown.length > 0
  };
}

// Statuses:
//   no_steps      nothing was extracted from the reply
//   has_unknown   labels were extracted but none of them resolved
//   inconsistent  no single route joins up the labels that did resolve
//   ok            one route accounts for all of them; `partial` says whether
//                 some labels were left over
//
// Leftover labels used to demote the whole ticket to has_unknown, which threw
// away otherwise clean evidence - real agent replies almost always contain a
// button or a form field that is not a menu node.
//
// `learned` carries the runtime additions to the graph: { aliases, edges }.
function toCanonicalPath(steps, learned) {
  if (!steps || steps.length === 0) {
    return result('no_steps', [], [], []);
  }

  const { aliases, edges } = learned || {};
  const { mapped, unknown } = mapSteps(steps, aliases);

  if (mapped.length === 0) {
    return result('has_unknown', [], unknown, []);
  }

  const { route, consistent } = chooseRoute(mapped, edges);

  return result(consistent ? 'ok' : 'inconsistent', route, unknown, mapped);
}

// The consecutive pairs the graph cannot currently join: the agent went
// straight from `from` to `to`, but no route to `to` passes through `from`.
// These are the candidate parent edges the learning pass votes on.
function missingEdges(mapped, edges) {
  const gaps = [];

  for (let i = 0; i < mapped.length - 1; i++) {
    const [from, to] = [mapped[i], mapped[i + 1]];

    if (from !== to && !tax.hasAncestor(to, from, edges)) {
      gaps.push({ from, to });
    }
  }

  return gaps;
}

const api = { toCanonicalPath, missingEdges };

// FDK's serverless sandbox exposes `exports` but no `module`; plain Node needs
// `module.exports`. Supporting both keeps these files loadable by `node test.js`.
exports = api;
if (typeof module === 'object') {
  module.exports = api;
}
