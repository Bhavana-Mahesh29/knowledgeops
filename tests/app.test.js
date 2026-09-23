// tests/app.test.js
// Front-end tests. app/scripts/app.js runs on import, so each case rebuilds
// the DOM, installs a fresh `app` global and resets the module registry.
import { describe, test, expect, beforeEach, vi } from 'vitest';

const ALERT = {
  alertId: '5001-1-abcd',
  articleId: '5001',
  articleTitle: 'Reset your security token',
  band: 'critical',
  confidence: 0.88,
  share: 0.8,
  density: 1,
  documentedPathLabels: ['Settings', 'Global Reset'],
  targetPathLabels: ['Settings', 'Security', 'Authentication', 'Reset Token'],
  evidenceTicketIds: ['201', '202', '203', '204'],
  agents: ['320', '321', '322'],
  patch: { passed: true, mode: 'template', attempts: 3, errors: [], markdown: '## Steps\n1. Go to **Reset Token**.' }
};

const DEFAULT_RESPONSES = {
  listAlerts: [ALERT],
  getAlertDetail: ALERT,
  listLearning: {
    labels: [
      { label: 'frobnicate', entries: [{ ticketId: '205', agentId: '320' }], promotedTo: null },
      {
        label: 'api details',
        entries: [{ ticketId: '205', agentId: '320' }],
        promotedTo: 'node_api_security',
        promotedToLabel: 'API & Security Details'
      }
    ],
    routes: [
      { from: 'API & Security Details', to: 'Reset Security Token', tickets: 1, promoted: true }
    ]
  },
  resetLearning: { aliases: 1, edges: 1 },
  approveAlert: {
    alertId: ALERT.alertId, articleId: '5001', published: true, publishedStatus: 2,
    approvedBy: 'lead@example.com'
  },
  updatePatch: {
    ...ALERT,
    patch: { passed: true, mode: 'manual', attempts: 0, errors: [], markdown: '## Steps\n1. Edited.' }
  },
  rejectAlert: { alertId: ALERT.alertId, rejected: true },
  ingestTicketById: { ticketId: '205', articleId: '5001', canonicalStatus: 'ok', alerts: [] }
};

const MARKUP = `
  <p id="status" class="status" hidden></p>
  <input id="ticketId" type="text" />
  <button id="ingest" type="button"></button>
  <button id="forget" type="button"></button>
  <div id="board"></div>
  <div id="detail"></div>
  <pre id="unknown"></pre>
`;

async function boot(overrides = {}, who = {}) {
  document.body.innerHTML = MARKUP;

  const loggedIn = who.email === undefined ? 'lead@example.com' : who.email;
  const iparams = { admin_emails: who.approvers === undefined ? '' : who.approvers };
  const responses = { ...DEFAULT_RESPONSES, ...overrides };
  const invoke = vi.fn((method) => {
    const value = responses[method];

    return value instanceof Error
      ? Promise.reject(value)
      : Promise.resolve({ status: 200, response: value });
  });

  const client = {
    events: { on: vi.fn() },
    request: { invoke },
    iparams: { get: vi.fn(() => Promise.resolve(iparams)) },
    data: {
      get: vi.fn(() => (loggedIn === null
        ? Promise.reject(new Error('no user'))
        : Promise.resolve({ loggedInUser: { contact: { email: loggedIn } } })))
    }
  };

  global.app = { initialized: vi.fn(() => Promise.resolve(client)) };

  vi.resetModules();
  await import('../app/scripts/app.js');
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('listAlerts', {}));

  return { client, invoke };
}

function byId(id) {
  return document.getElementById(id);
}

describe('KnowledgeOps action board', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('initialises the app client and subscribes to app.activated', async () => {
    const { client } = await boot();

    expect(global.app.initialized).toHaveBeenCalled();
    expect(client.events.on).toHaveBeenCalledWith('app.activated', expect.any(Function));
  });

  test('renders one card per open alert and the unknown-label log', async () => {
    await boot();
    await vi.waitFor(() => expect(byId('unknown').textContent).toContain('frobnicate'));

    const cards = byId('board').querySelectorAll('[data-alert-id]');

    expect(cards).toHaveLength(1);
    expect(cards[0].textContent).toContain('Reset your security token');
    expect(cards[0].textContent).toContain('CRITICAL');
    expect(byId('unknown').textContent).toContain('frobnicate');
    expect(byId('unknown').textContent).toContain('not recognised yet');
    expect(byId('unknown').textContent).toContain('learned as API & Security Details');
    expect(byId('unknown').textContent).toContain(
      'route  API & Security Details \u2192 Reset Security Token'
    );
  });

  test('resetting the learned graph reports what was dropped', async () => {
    const { invoke } = await boot();

    byId('forget').click();
    await vi.waitFor(() => expect(byId('status').textContent).toContain('Dropped 1 learned alias'));

    expect(byId('status').textContent).toContain('1 learned route');
    expect(invoke).toHaveBeenCalledWith('resetLearning', {});
  });

  test('shows an empty state when there are no alerts', async () => {
    await boot({ listAlerts: [], listLearning: { labels: [], routes: [] } });
    await vi.waitFor(() => expect(byId('unknown').textContent).toBe('(none)'));

    expect(byId('board').textContent).toContain('No open alerts');
    expect(byId('unknown').textContent).toBe('(none)');
  });

  test('clicking a card loads the diff and enables Approve', async () => {
    await boot();
    await vi.waitFor(() => expect(byId('board').querySelector('[data-alert-id]')).not.toBeNull());

    byId('board').querySelector('[data-alert-id]').click();
    await vi.waitFor(() => expect(byId('detail').textContent).toContain('Reset Token'));

    const detail = byId('detail');

    expect(detail.textContent).toContain('Settings → Security → Authentication → Reset Token');
    expect(detail.textContent).toContain('80%');
    expect(detail.querySelector('[data-action="approve"]').disabled).toBe(false);
  });

  test('Approve is disabled when the validator rejected the patch', async () => {
    const failed = { ...ALERT, patch: { passed: false, mode: 'template', attempts: 3, errors: ['path mismatch'] } };

    await boot({ listAlerts: [failed], getAlertDetail: failed });
    await vi.waitFor(() => expect(byId('board').querySelector('[data-alert-id]')).not.toBeNull());

    byId('board').querySelector('[data-alert-id]').click();
    await vi.waitFor(() => expect(byId('detail').textContent).toContain('path mismatch'));

    expect(byId('detail').querySelector('[data-action="approve"]').disabled).toBe(true);
  });

  test('approving publishes and reports back', async () => {
    const { invoke } = await boot();

    await vi.waitFor(() => expect(byId('board').querySelector('[data-alert-id]')).not.toBeNull());
    byId('board').querySelector('[data-alert-id]').click();
    await vi.waitFor(() => expect(byId('detail').querySelector('[data-action="approve"]')).not.toBeNull());

    byId('detail').querySelector('[data-action="approve"]').click();
    await vi.waitFor(() => expect(byId('status').textContent).toContain('published to Freshdesk'));

    expect(invoke).toHaveBeenCalledWith('approveAlert', {
      alertId: ALERT.alertId, actor: 'lead@example.com'
    });
    expect(byId('status').hidden).toBe(false);
  });

  test('rejecting an alert clears the review pane', async () => {
    const { invoke } = await boot();

    await vi.waitFor(() => expect(byId('board').querySelector('[data-alert-id]')).not.toBeNull());
    byId('board').querySelector('[data-alert-id]').click();
    await vi.waitFor(() => expect(byId('detail').querySelector('[data-action="reject"]')).not.toBeNull());

    byId('detail').querySelector('[data-action="reject"]').click();
    await vi.waitFor(() => expect(byId('status').textContent).toContain('rejected'));

    expect(invoke).toHaveBeenCalledWith('rejectAlert', {
      alertId: ALERT.alertId, actor: 'lead@example.com'
    });
  });

  test('the review pane offers edit alongside approve and reject', async () => {
    await boot();
    await vi.waitFor(() => expect(byId('board').querySelector('[data-alert-id]')).not.toBeNull());

    byId('board').querySelector('[data-alert-id]').click();
    await vi.waitFor(() => expect(byId('detail').querySelector('[data-action="edit"]')).not.toBeNull());

    expect(byId('detail').querySelector('[data-action="edit"]').disabled).toBe(false);
  });

  test('editing a patch revalidates it through the server', async () => {
    const { invoke } = await boot();

    await vi.waitFor(() => expect(byId('board').querySelector('[data-alert-id]')).not.toBeNull());
    byId('board').querySelector('[data-alert-id]').click();
    await vi.waitFor(() => expect(byId('detail').querySelector('[data-action="edit"]')).not.toBeNull());

    byId('detail').querySelector('[data-action="edit"]').click();
    await vi.waitFor(() => expect(byId('patchEdit')).not.toBeNull());

    byId('patchEdit').value = '## Steps\n1. Edited.';
    byId('detail').querySelector('[data-action="save"]').click();

    await vi.waitFor(() => expect(byId('status').textContent).toContain('revalidated'));
    expect(invoke).toHaveBeenCalledWith('updatePatch', {
      alertId: ALERT.alertId,
      markdown: '## Steps\n1. Edited.',
      actor: 'lead@example.com'
    });
  });

  test('an edit that fails validation says so and leaves approve disabled', async () => {
    const failed = {
      ...ALERT,
      patch: { passed: false, mode: 'manual', attempts: 0, errors: ['path mismatch'], markdown: 'x' }
    };

    await boot({ updatePatch: failed });
    await vi.waitFor(() => expect(byId('board').querySelector('[data-alert-id]')).not.toBeNull());
    byId('board').querySelector('[data-alert-id]').click();
    await vi.waitFor(() => expect(byId('detail').querySelector('[data-action="edit"]')).not.toBeNull());

    byId('detail').querySelector('[data-action="edit"]').click();
    await vi.waitFor(() => expect(byId('patchEdit')).not.toBeNull());
    byId('detail').querySelector('[data-action="save"]').click();

    await vi.waitFor(() => expect(byId('status').textContent).toContain('does not validate'));
    expect(byId('detail').querySelector('[data-action="approve"]').disabled).toBe(true);
  });

  test('cancelling an edit restores the read-only view', async () => {
    await boot();
    await vi.waitFor(() => expect(byId('board').querySelector('[data-alert-id]')).not.toBeNull());
    byId('board').querySelector('[data-alert-id]').click();
    await vi.waitFor(() => expect(byId('detail').querySelector('[data-action="edit"]')).not.toBeNull());

    byId('detail').querySelector('[data-action="edit"]').click();
    await vi.waitFor(() => expect(byId('patchEdit')).not.toBeNull());

    byId('detail').querySelector('[data-action="cancel"]').click();
    await vi.waitFor(() => expect(byId('patchEdit')).toBeNull());

    expect(byId('detail').querySelector('[data-action="approve"]')).not.toBeNull();
  });

  test('a non-approver gets no action buttons at all', async () => {
    await boot({}, { email: 'junior@example.com', approvers: 'lead@example.com' });
    await vi.waitFor(() => expect(byId('board').querySelector('[data-alert-id]')).not.toBeNull());

    byId('board').querySelector('[data-alert-id]').click();
    await vi.waitFor(() => expect(byId('detail').textContent).toContain('Only an approver'));

    expect(byId('detail').querySelector('[data-action="approve"]')).toBeNull();
    expect(byId('detail').querySelector('[data-action="edit"]')).toBeNull();
    expect(byId('detail').querySelector('[data-action="reject"]')).toBeNull();
  });

  test('an approver on the list keeps them', async () => {
    await boot({}, { email: 'lead@example.com', approvers: 'lead@example.com, head@example.com' });
    await vi.waitFor(() => expect(byId('board').querySelector('[data-alert-id]')).not.toBeNull());

    byId('board').querySelector('[data-alert-id]').click();
    await vi.waitFor(() => expect(byId('detail').querySelector('[data-action="approve"]')).not.toBeNull());
  });

  // Failing open here would make the approver list meaningless.
  test('an unidentifiable user is locked out when a list is configured', async () => {
    await boot({}, { email: null, approvers: 'lead@example.com' });
    await vi.waitFor(() => expect(byId('board').querySelector('[data-alert-id]')).not.toBeNull());

    byId('board').querySelector('[data-alert-id]').click();
    await vi.waitFor(() => expect(byId('detail').textContent).toContain('Only an approver'));
  });

  test('manual ingest requires a ticket id', async () => {
    const { invoke } = await boot();

    byId('ingest').click();
    await vi.waitFor(() => expect(byId('status').textContent).toContain('Enter a ticket id'));

    expect(invoke).not.toHaveBeenCalledWith('ingestTicketById', expect.anything());
  });

  test('manual ingest forwards the ticket id to the server', async () => {
    const { invoke } = await boot();

    byId('ticketId').value = ' 205 ';
    byId('ingest').click();
    await vi.waitFor(() => expect(byId('status').textContent).toContain('ingested'));

    expect(invoke).toHaveBeenCalledWith('ingestTicketById', { ticketId: '205' });
  });

  test('a server error is surfaced in the status banner', async () => {
    await boot({ listAlerts: new Error('Freshdesk said no') });

    await vi.waitFor(() => expect(byId('status').textContent).toContain('Freshdesk said no'));
    expect(byId('status').className).toContain('error');
  });
});
