// server/lib/scoring.js
// Stage 3b/3c: the convergence rule. Pure functions, direct port of
// engine/scoring.py - same gate order, same weights, same test results.
'use strict';

const DEFAULT_CFG = {
  N: 4, K: 3, X: 0.35,
  W_SHARE: 0.60, W_AGENT: 0.40,
  WARN: 0.50, CRIT: 0.85,
  REOPEN_MARGIN: 0.05, MIN_VETO_CLUSTER: 4,
  AGENT_DENSITY_TARGET: 4
};

function blocked(reason, confidence = null) {
  return { band: 'blocked', confidence, reason };
}

// The hard gates, in the order the spec fixes them: enough explicitly linked
// tickets (N), enough distinct agents (K), then a usable denominator.
function failedGate({ explicit, agents, denom }, cfg) {
  if (explicit < cfg.N) {
    return 'N';
  }
  if (agents < cfg.K) {
    return 'K';
  }
  if (denom <= 0) {
    return 'X';
  }
  return null;
}

// A cluster whose tickets get reopened materially more often than the article's
// baseline is evidence the "new" path does not actually work.
function isVetoed({ total, reopens, baselineReopen }, cfg) {
  if (total < cfg.MIN_VETO_CLUSTER) {
    return false;
  }
  return (reopens / total - baselineReopen) >= cfg.REOPEN_MARGIN;
}

function band(confidence, cfg) {
  if (confidence >= cfg.CRIT) {
    return { band: 'critical', confidence, reason: null };
  }
  if (confidence >= cfg.WARN) {
    return { band: 'warning', confidence, reason: null };
  }
  return blocked('below_warning', confidence);
}

function shareOf(total, denom) {
  return denom > 0 ? Math.min(1.0, total / denom) : 0;
}

function densityOf(agents, cfg = DEFAULT_CFG) {
  return Math.min(1.0, agents / cfg.AGENT_DENSITY_TARGET);
}

function scoreCluster(input, cfg = DEFAULT_CFG) {
  const gate = failedGate(input, cfg);

  if (gate !== null) {
    return blocked(gate);
  }

  const share = shareOf(input.total, input.denom);

  if (share < cfg.X) {
    return blocked('X');
  }

  if (isVetoed(input, cfg)) {
    return { band: 'vetoed', confidence: 0.0, reason: 'reopen' };
  }

  return band(cfg.W_SHARE * share + cfg.W_AGENT * densityOf(input.agents, cfg), cfg);
}

const api = { scoreCluster, shareOf, densityOf, DEFAULT_CFG };

// FDK's serverless sandbox exposes `exports` but no `module`; plain Node needs
// `module.exports`. Supporting both keeps these files loadable by `node test.js`.
exports = api;
if (typeof module === 'object') {
  module.exports = api;
}
