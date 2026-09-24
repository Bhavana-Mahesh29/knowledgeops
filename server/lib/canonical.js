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

function isDirectChild(child, parent, edges) {
  return tax.parentsOf(child, edges).includes(parent);
}

// The path is what the agent said, in the order they said it. Only the menus
// above the first step they named are filled in from the graph (an agent who
// starts at "Security" is standing somewhere). Between named steps nothing is
// filled in: "Profile -> Security" when the graph has Profile -> Authentication
// -> Security is a different walk, not shorthand for the documented one, and
// neither is naming the same steps in another order. Either leaves the ticket
// inconsistent, with the agent's own steps as the path.
function chooseRoute(mapped, edges) {
  const named = mapped.filter((n, i) => n !== mapped[i - 1]);
  const joined = named.every((n, i) => i === 0 || isDirectChild(n, named[i - 1], edges));

  if (!joined) {
    return { route: named, consistent: false };
  }

  const lead = longest(tax.lineages(named[0], edges));

  return { route: [...lead.slice(0, -1), ...named], consistent: true };
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
// straight from `from` to `to`, but `from` is not a parent of `to`. These are
// the candidate parent edges the learning pass votes on.
function missingEdges(mapped, edges) {
  const gaps = [];

  for (let i = 0; i < mapped.length - 1; i++) {
    const [from, to] = [mapped[i], mapped[i + 1]];

    if (from !== to && !isDirectChild(to, from, edges)) {
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
