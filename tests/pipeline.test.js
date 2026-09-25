// tests/pipeline.test.js
// Drives server/server.js through the FDK sandbox with the same event payload
// the "simulate onTicketUpdate" button posts, and with Freshdesk / Anthropic
// stubbed. Asserts the pipeline ends in a PUT to the Freshdesk article.
import { describe, test, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadServer, createRenderData } = require('./sandbox.js');
const tax = require('../server/lib/taxonomy.js');
const eventPayload = require('../server/test_data/support_ticket/onTicketUpdate.json');

const ARTICLE_ID = '5001';
const ARTICLE_TITLE = 'How to Enable Two-Factor Authentication';
// Written the way the knowledge base writes it: a "Step-by-Step Instructions"
// heading rather than "Steps".
const ARTICLE_HTML = `<h2>${ARTICLE_TITLE}</h2>`
  + '<p>Use this guide to add a second sign-in step.</p>'
  + '<h3>Step-by-Step Instructions</h3>'
  + '<ol><li>Go to <b>Settings</b> &rarr; <b>Security</b> &rarr; <b>Authentication</b>.</li>'
  + '<li>Choose <i>Enable two-factor</i>.</li></ol>'
  + '<h3>Troubleshooting</h3><p>Contact IT if the QR code does not scan.</p>';

// Settings -> Security -> Two-Step Verification
const NEW_PATH = ['Settings', 'Security', 'Two-Step Verification'];

function reply(agentId, body) {
  return {
    incoming: false,
    private: false,
    user_id: agentId,
    body: `<p>Go to Settings, open the Security tab, then Two-Step Verification. `
      + `Full guide: https://example.freshdesk.com/support/solutions/articles/${ARTICLE_ID}-enable-2fa</p>`,
    body_text: body
  };
}

const REPLY_TEXT = 'Go to Settings, open the Security tab, then Two-Step Verification '
  + 'and scan the QR code. Reach me at agent@example.com if it fails. - Priya';

// Minimal Freshdesk + Anthropic doubles. anthropicMessages rejects on purpose
// so the run exercises the offline fallbacks (alias scan + template patch),
// which is also what happens in practice when no API key is configured.
function createRequestApi(overrides = {}) {
  const calls = [];
  const article = { id: ARTICLE_ID, title: ARTICLE_TITLE, description: ARTICLE_HTML };

  const handlers = Object.assign({
    anthropicMessages: () => Promise.reject({ status: 401, response: '{"error":"no key"}' }),
    fdGetTicket: (opts) => Promise.resolve({
      response: JSON.stringify({
        id: Number(opts.context.ticket_id),
        status: 4,
        responder_id: 320
      })
    }),
    fdGetConversations: () => Promise.resolve({
      response: JSON.stringify([
        { incoming: true, private: false, body: '<p>Where is the 2FA option?</p>', body_text: 'Where is the 2FA option?' },
        reply(320, REPLY_TEXT)
      ])
    }),
    fdGetArticle: () => Promise.resolve({ response: JSON.stringify(article) }),
    fdUpdateArticle: (opts) => {
      const body = JSON.parse(opts.body);

      article.description = body.description;
      return Promise.resolve({ status: 200, response: JSON.stringify(article) });
    }
  }, overrides);

  return {
    calls,
    article,
    api: {
      invokeTemplate(template, options = {}) {
        calls.push({ template, options });

        if (!handlers[template]) {
          return Promise.reject(new Error(`unknown template ${template}`));
        }

        return handlers[template](options);
      }
    }
  };
}

function ticketEvent(id, status, responderId) {
  const payload = JSON.parse(JSON.stringify(eventPayload));

  payload.data.ticket.id = id;
  payload.data.ticket.status = status;
  payload.data.ticket.responder_id = responderId;
  payload.iparams = { demo_mode: true, publish_mode: 'demo', provision_hedging: true };

  return payload;
}

describe('onTicketUpdate -> alert -> publish', () => {
  let env;
  let requests;
  let renderData;

  beforeEach(() => {
    requests = createRequestApi();
    renderData = createRenderData();
    env = loadServer({ $request: requests.api, renderData });
  });

  test('server.js loads in the FDK sandbox', () => {
    expect(Object.keys(env.methods)).toContain('onTicketUpdateHandler');
    expect(Object.keys(env.methods)).toContain('listAlerts');
  });

  test('a resolved ticket is ingested and raises an alert', async () => {
    await env.methods.onTicketUpdateHandler(ticketEvent(205, 4, 320));

    const alerts = await renderData.call(() => env.methods.listAlerts({}));

    expect(alerts).toHaveLength(1);
    expect(alerts[0].band).toBe('critical');
    expect(alerts[0].targetPathLabels).toEqual(NEW_PATH);
    expect(alerts[0].documentedPathLabels).toEqual(['Settings', 'Security', 'Authentication']);
    expect(alerts[0].patch.passed).toBe(true);
  });

  test('PII is stripped before the text is stored as evidence', async () => {
    await env.methods.onTicketUpdateHandler(ticketEvent(205, 4, 320));

    const alerts = await renderData.call(() => env.methods.listAlerts({}));
    const evidence = alerts[0].patch.markdown;

    expect(evidence).not.toContain('agent@example.com');

    const stored = [...env.db.rows.values()].map((r) => r.value).join('');

    expect(stored).toContain('[ANONYMIZED_EMAIL]');
    expect(stored).not.toContain('agent@example.com');
  });

  test('approving an alert PUTs the rewritten article back to Freshdesk', async () => {
    await env.methods.onTicketUpdateHandler(ticketEvent(205, 4, 320));

    const alerts = await renderData.call(() => env.methods.listAlerts({}));
    const result = await renderData.call(() => env.methods.approveAlert({
      alertId: alerts[0].alertId,
      actor: 'lead@example.com',
      iparams: { publish_mode: 'demo' }
    }));

    expect(result.published).toBe(true);
    expect(result.publishedStatus).toBe(2);
    expect(result.approvedBy).toBe('lead@example.com');

    const put = requests.calls.filter((c) => c.template === 'fdUpdateArticle');

    expect(put).toHaveLength(1);
    expect(requests.article.description).toContain('<b>Two-Step Verification</b>');
    expect(requests.article.description).not.toContain('<b>Authentication</b>');
  });

  test("publishing keeps the author's own procedure heading", async () => {
    await env.methods.onTicketUpdateHandler(ticketEvent(205, 4, 320));

    const alerts = await renderData.call(() => env.methods.listAlerts({}));

    expect(alerts[0].patch.markdown).toContain('## Steps\n');

    await renderData.call(() => env.methods.approveAlert({
      alertId: alerts[0].alertId,
      actor: 'lead@example.com',
      iparams: { publish_mode: 'demo' }
    }));

    expect(requests.article.description).toContain('<h2>Step-by-Step Instructions</h2>');
    expect(requests.article.description).not.toContain('<h2>Steps</h2>');
  });

  // What a helpdesk with a Freddy AI Agent really produces: Freshdesk's own
  // acknowledgement, then Freddy answering from the (stale) article, then the
  // human agent's actual fix. Only the last one is evidence.
  test('system acknowledgements and Freddy AI answers are not counted as the resolution', async () => {
    const withBots = createRequestApi({
      fdGetConversations: () => Promise.resolve({
        response: JSON.stringify([
          { incoming: true, private: false, body: '<p>Where is the 2FA option?</p>', body_text: 'Where is the 2FA option?' },
          { incoming: false, private: false, user_id: 0, body: '<p>We received your request.</p>', body_text: 'We received your request. Check Settings for updates.' },
          {
            incoming: false,
            private: false,
            user_id: 68010984081,
            body: '<p>Go to Settings, then Security, then Authentication.</p><p>Disclaimer: This email was generated by Freddy AI Agent.</p>',
            body_text: 'Go to Settings, then Security, then Authentication. Disclaimer: This email was generated by Freddy AI Agent.'
          },
          reply(320, REPLY_TEXT)
        ])
      })
    });
    const local = loadServer({ $request: withBots.api, renderData });

    await local.methods.onTicketUpdateHandler(ticketEvent(205, 4, 320));

    const alerts = await renderData.call(() => local.methods.listAlerts({}));

    expect(alerts).toHaveLength(1);
    expect(alerts[0].targetPathLabels).toEqual(NEW_PATH);
    expect(JSON.parse(local.db.rows.get('tickets:205').value).redactedText).not.toContain('Freddy');
  });

  test('a ticket that is not resolved is skipped rather than failing', async () => {
    await env.methods.onTicketUpdateHandler(ticketEvent(999, 2, 320));

    const alerts = await renderData.call(() => env.methods.listAlerts({}));

    expect(alerts).toHaveLength(0);
  });

  test('checkFreshness hedges on a critical alert when hedging is enabled', async () => {
    await env.methods.onTicketUpdateHandler(ticketEvent(205, 4, 320));

    const answer = await renderData.call(() => env.methods.checkFreshness({
      articleId: ARTICLE_ID,
      provisionHedging: true,
      iparams: {}
    }));

    expect(answer.status).toBe('critical');
    expect(answer.recommended_action).toBe('answer_with_provisional_notice');
    expect(answer.provisional_path_labels).toEqual(NEW_PATH);
    expect(answer.bot_message).toContain('Settings → Security → Two-Step Verification');
  });

  // The shape of a real extraction: menus named with filler words around
  // them, plus buttons and form fields that are not menus at all. One
  // unmapped label used to discard the whole ticket.
  describe('taxonomy learning', () => {
    const WORDY_STEPS = [
      'open settings', 'click security', 'click two-step verification',
      'scan the qr code', 'enter the 6-digit code'
    ];

    // Here Haiku *succeeds*, unlike the other cases in this file: the point is
    // the label-resolution stage, not the fallback. Drafting still falls
    // through to the template, since only the extractor sends `tools`.
    function wordyRequests() {
      return createRequestApi({
        anthropicMessages: (opts) => {
          if (!JSON.parse(opts.body).tools) {
            return Promise.reject({ status: 401, response: '{"error":"no key"}' });
          }

          return Promise.resolve({
            response: JSON.stringify({
              content: [{
                type: 'tool_use',
                name: 'record_steps',
                input: { steps: WORDY_STEPS }
              }]
            })
          });
        },
        fdGetConversations: () => Promise.resolve({
          response: JSON.stringify([reply(320, 'Steps to be followed: go to settings ...')])
        })
      });
    }

    test('an unrecognised label no longer discards the ticket', async () => {
      const wordy = wordyRequests();
      const local = loadServer({ $request: wordy.api, renderData });

      await local.methods.onTicketUpdateHandler(ticketEvent(205, 4, 320));

      const alerts = await renderData.call(() => local.methods.listAlerts({}));

      expect(alerts).toHaveLength(1);
      expect(alerts[0].targetPathLabels).toEqual(NEW_PATH);
    });

    test('a reworded label is promoted to an alias, the rest stay candidates', async () => {
      const wordy = wordyRequests();
      const local = loadServer({ $request: wordy.api, renderData });

      await local.methods.onTicketUpdateHandler(ticketEvent(205, 4, 320));

      const { labels } = await renderData.call(() => local.methods.listLearning({}));
      const learned = labels.filter((l) => l.promotedTo !== null);
      const candidates = labels.filter((l) => l.promotedTo === null);

      expect(learned.map((l) => l.label).sort()).toEqual([
        'click security', 'click two-step verification', 'open settings'
      ]);
      expect(candidates.map((l) => l.label).sort()).toEqual([
        'enter the 6-digit code', 'scan the qr code'
      ]);
    });

    test('a promoted alias resolves on later tickets and can be undone', async () => {
      const wordy = wordyRequests();
      const local = loadServer({ $request: wordy.api, renderData });

      await local.methods.onTicketUpdateHandler(ticketEvent(205, 4, 320));

      const aliases = await local.sandbox.$db.get('learned:aliases');

      expect(JSON.parse(aliases.value)).toEqual({
        'open settings': 'node_settings',
        'click security': 'node_security',
        'click twostep verification': 'node_two_step'
      });

      const undone = await renderData.call(() => local.methods.resetLearning({}));

      expect(undone.aliases).toBe(3);

      const after = await renderData.call(() => local.methods.listLearning({}));

      expect(after.labels.every((l) => l.promotedTo === null)).toBe(true);
    });

    // taxonomy.js gets edited; the aliases learned before the edit point at
    // node ids that no longer exist. The run must recover on its own.
    test('aliases left dangling by a taxonomy edit are relearned', async () => {
      const wordy = wordyRequests();
      const local = loadServer({ $request: wordy.api, renderData });

      local.db.rows.set('learned:aliases', {
        value: JSON.stringify({
          'click security': 'node_gone',
          'click twostep verification': 'node_also_gone'
        })
      });

      await local.methods.onTicketUpdateHandler(ticketEvent(205, 4, 320));

      expect(JSON.parse(local.db.rows.get('learned:aliases').value)).toEqual({
        'open settings': 'node_settings',
        'click security': 'node_security',
        'click twostep verification': 'node_two_step'
      });

      const alerts = await renderData.call(() => local.methods.listAlerts({}));

      expect(alerts).toHaveLength(1);
      expect(alerts[0].targetPathLabels).toEqual(NEW_PATH);
    });

    test('re-simulating the same ticket does not inflate the sighting count', async () => {
      const wordy = wordyRequests();
      const local = loadServer({ $request: wordy.api, renderData });

      await local.methods.onTicketUpdateHandler(ticketEvent(205, 4, 320));
      await local.methods.onTicketUpdateHandler(ticketEvent(205, 4, 320));

      const { labels } = await renderData.call(() => local.methods.listLearning({}));

      expect(labels.every((l) => l.entries.length === 1)).toBe(true);
    });
  });

  // The agent reached Two-Step Verification straight from Profile. Every
  // label resolves, yet no single route joins them up - the graph is missing
  // an edge, and only structure learning can add it.
  describe('route learning', () => {
    const OLD_ROUTE_STEPS = ['profile', 'two-step verification'];

    function oldRouteRequests() {
      return createRequestApi({
        anthropicMessages: (opts) => {
          if (!JSON.parse(opts.body).tools) {
            return Promise.reject({ status: 401, response: '{"error":"no key"}' });
          }

          return Promise.resolve({
            response: JSON.stringify({
              content: [{ type: 'tool_use', name: 'record_steps', input: { steps: OLD_ROUTE_STEPS } }]
            })
          });
        }
      });
    }

    test('the missing edge is learned and the ticket stops being inconsistent', async () => {
      const reqs = oldRouteRequests();
      const local = loadServer({ $request: reqs.api, renderData });

      await local.methods.onTicketUpdateHandler(ticketEvent(205, 4, 320));

      expect(JSON.parse(local.db.rows.get('learned:edges').value)).toEqual({
        node_two_step: ['node_profile']
      });

      const ticket = JSON.parse(local.db.rows.get('tickets:205').value);

      expect(ticket.status).toBe('ok');
      expect(tax.displayPath(ticket.canonicalPath)).toEqual(['Settings', 'Profile', 'Two-Step Verification']);
    });

    test('the learned route is reported and can be undone', async () => {
      const reqs = oldRouteRequests();
      const local = loadServer({ $request: reqs.api, renderData });

      await local.methods.onTicketUpdateHandler(ticketEvent(205, 4, 320));

      const report = await renderData.call(() => local.methods.listLearning({}));

      expect(report.routes).toEqual([{
        from: 'Profile',
        to: 'Two-Step Verification',
        tickets: 1,
        promoted: true
      }]);

      const undone = await renderData.call(() => local.methods.resetLearning({}));

      expect(undone.edges).toBe(1);

      const after = await renderData.call(() => local.methods.listLearning({}));

      expect(after.routes.every((r) => r.promoted === false)).toBe(true);
    });

    test('a ticket on the current route is unaffected by the learned edge', async () => {
      const reqs = oldRouteRequests();
      const local = loadServer({ $request: reqs.api, renderData });

      await local.methods.onTicketUpdateHandler(ticketEvent(205, 4, 320));

      const current = loadServer({ $request: createRequestApi().api, renderData });

      current.db.rows.set('learned:edges', {
        value: JSON.stringify({ node_two_step: ['node_profile'] })
      });

      await current.methods.onTicketUpdateHandler(ticketEvent(206, 4, 321));

      const alerts = await renderData.call(() => current.methods.listAlerts({}));

      expect(alerts[0].targetPathLabels).toEqual(NEW_PATH);
    });
  });

  // The route-learning case now produces an approvable patch: nothing in the
  // graph ships deprecated, so an alert aimed at the other route is a normal
  // rewrite rather than something the validator has to refuse.
  describe('approval, editing and who may do it', () => {
    async function openAlert(local) {
      await local.methods.onTicketUpdateHandler(ticketEvent(205, 4, 320));

      const alerts = await renderData.call(() => local.methods.listAlerts({}));

      return alerts[0];
    }

    test('an alert on the other route is approvable', async () => {
      const alert = await openAlert(env);

      expect(alert.patch.passed).toBe(true);
      expect(alert.finding).toBe('article_stale');
      expect(alert.deprecatedSteps).toEqual([]);
    });

    test('a hand edit is revalidated and can then be published', async () => {
      const alert = await openAlert(env);
      const edited = alert.patch.markdown.replace(
        'Choose *Enable two-factor*.',
        'Choose *Enable two-factor* and save the backup codes.'
      );

      const updated = await renderData.call(() => env.methods.updatePatch({
        alertId: alert.alertId,
        markdown: edited,
        actor: 'lead@example.com',
        iparams: {}
      }));

      expect(updated.patch.mode).toBe('manual');
      expect(updated.patch.passed).toBe(true);
      expect(updated.patch.editedBy).toBe('lead@example.com');

      const published = await renderData.call(() => env.methods.approveAlert({
        alertId: alert.alertId,
        actor: 'lead@example.com',
        iparams: { publish_mode: 'demo' }
      }));

      expect(published.published).toBe(true);
      expect(requests.article.description).toContain('save the backup codes');
    });

    test('an edit that breaks the rules fails the same validator', async () => {
      const alert = await openAlert(env);
      const broken = alert.patch.markdown.replace(/\*\*Security\*\* \u2192 /, '');

      const updated = await renderData.call(() => env.methods.updatePatch({
        alertId: alert.alertId,
        markdown: broken,
        actor: 'lead@example.com',
        iparams: {}
      }));

      expect(updated.patch.passed).toBe(false);
      expect(updated.patch.errors.join(' ')).toContain('path mismatch');

      await expect(renderData.call(() => env.methods.approveAlert({
        alertId: alert.alertId,
        actor: 'lead@example.com',
        iparams: { publish_mode: 'demo' }
      }))).rejects.toMatchObject({ message: expect.stringContaining('no validated patch') });
    });

    test('a non-approver is refused once the approver list is set', async () => {
      const alert = await openAlert(env);
      const iparams = { admin_emails: 'lead@example.com, head@example.com', publish_mode: 'demo' };

      await expect(renderData.call(() => env.methods.approveAlert({
        alertId: alert.alertId,
        actor: 'junior@example.com',
        iparams
      }))).rejects.toMatchObject({ message: expect.stringContaining('not an approver') });

      expect(requests.calls.filter((c) => c.template === 'fdUpdateArticle')).toHaveLength(0);

      const ok = await renderData.call(() => env.methods.approveAlert({
        alertId: alert.alertId,
        actor: 'HEAD@example.com',
        iparams
      }));

      expect(ok.published).toBe(true);
    });

    test('an unset approver list leaves the app open', async () => {
      const alert = await openAlert(env);

      const ok = await renderData.call(() => env.methods.approveAlert({
        alertId: alert.alertId,
        actor: 'anyone@example.com',
        iparams: { admin_emails: '', publish_mode: 'demo' }
      }));

      expect(ok.published).toBe(true);
    });
  });

  test('a Freshdesk outage is reported, not thrown as an unhandled rejection', async () => {
    const failing = createRequestApi({
      fdGetConversations: () => Promise.reject({ status: 401, response: 'Unauthorized' })
    });
    const env2 = loadServer({ $request: failing.api, renderData: createRenderData() });

    await expect(env2.methods.onTicketUpdateHandler(ticketEvent(205, 4, 320))).resolves.toBeUndefined();
  });
});
