const axios = require('axios');

// ==================== CONFIGURATION ====================
const FRESHDESK_DOMAIN = 'knowledgeopshack.freshdesk.com';
const API_KEY = 'fwapi_1RY2zqkqfM3UjPf447qNK5_1022750354893064294_7b31579f'; // Replace with your Freshdesk API key
// =======================================================

const authHeader = {
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Basic ${Buffer.from(`${API_KEY}:X`).toString('base64')}`
  }
};

// Solutions mapped by topic keywords
const resolutionScenarios = [
  {
    // =========================================================================
    // CASE 1: HIGH DRIFT (Triggers CRITICAL Alert + Proposed Patch)
    // Target Article: "How to Enable Two-Factor Authentication"
    // Documented in KB: Settings -> Security -> Authentication
    // Agent Solution: Diverges deeper into Security -> Authentication -> Reset Token
    // =========================================================================
    keyword: 'Two-Factor',
    type: 'HIGH DRIFT (Critical)',
    agentReply: `
      <p>Hello,</p>
      <p>The 2FA procedure has recently been updated in our latest portal release. Please follow the new steps below:</p>
      <ol>
        <li>Navigate to <strong>Settings</strong> from the main menu.</li>
        <li>Click on <strong>Security</strong>.</li>
        <li>Select <strong>Authentication</strong>.</li>
        <li>Click on <strong>Reset Token</strong>.</li>
        <li>Click <strong>Confirm and generate new token</strong> to pair your authenticator app.</li>
      </ol>
      <p>Your new 2FA profile is now active.</p>
    `
  },
  {
    // =========================================================================
    // CASE 2: HIGH DRIFT #2 (Triggers CRITICAL Alert)
    // Target Article: "How to Reset Your Account Password"
    // Documented in KB: Login -> Forgot Password
    // Agent Solution: Completely routes through Settings -> Security -> Authentication
    // =========================================================================
    keyword: 'password',
    type: 'HIGH DRIFT (Critical)',
    agentReply: `
      <p>Hi there,</p>
      <p>If you are logged into your system and need to update your expired credentials, use the internal settings path:</p>
      <ol>
        <li>Open your browser and navigate to <strong>Settings</strong>.</li>
        <li>Click on <strong>Security</strong>.</li>
        <li>Choose <strong>Authentication</strong>.</li>
        <li>Select <strong>Reset Token</strong> to set your new account password.</li>
      </ol>
      <p>This avoids having to log out to use the public reset link.</p>
    `
  },
  {
    // =========================================================================
    // CASE 3: LOW / SLIGHT DRIFT (Triggers WARNING Alert / Emerging Pattern)
    // Target Article: "How to Update Your Profile Information"
    // Documented in KB: Settings -> Profile -> Edit
    // Agent Solution: Takes a shortcut directly to Profile -> Edit (skips Settings)
    // =========================================================================
    keyword: 'Profile',
    type: 'LOW / SLIGHT DRIFT (Warning)',
    agentReply: `
      <p>Hello,</p>
      <p>You can use the new navigation shortcut to change your profile information quickly:</p>
      <ol>
        <li>Click directly on your <strong>Profile</strong> icon in the header.</li>
        <li>Click <strong>Edit</strong> next to your contact and department fields.</li>
        <li>Enter your new details and click <strong>Save</strong>.</li>
      </ol>
      <p>The changes will reflect immediately across your account.</p>
    `
  },
  {
    // =========================================================================
    // CASE 4: NO DRIFT / BASELINE (Matches KB Article Exactly)
    // Target Article: "How to Set Up VPN Access on Windows"
    // Documented in KB: Download VPN Client -> Install -> Configure Server -> Authenticate
    // Agent Solution: Follows the exact documented path without deviations
    // =========================================================================
    keyword: 'VPN',
    type: 'NO DRIFT (Control / Baseline)',
    agentReply: `
      <p>Hello,</p>
      <p>Here are the standard instructions to configure your VPN connection:</p>
      <ol>
        <li>Download the <strong>SecureConnect Client</strong> from our internal software portal.</li>
        <li>Run the installer using default settings.</li>
        <li>Open the client and enter server address <code>vpn.company.internal</code>.</li>
        <li>Enter your network credentials and click <strong>Connect</strong>.</li>
      </ol>
      <p>The client will show a status of CONNECTED once active.</p>
    `
  }
];

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveOpenTickets() {
  try {
    console.log(`Fetching open tickets from https://${FRESHDESK_DOMAIN}...`);
    const res = await axios.get(
      `https://${FRESHDESK_DOMAIN}/api/v2/tickets?order_by=created_at&order_type=desc`,
      authHeader
    );

    const openTickets = res.data.filter((t) => t.status === 2); // 2 = Open

    if (openTickets.length === 0) {
      console.log('No open tickets found. Run "node create_article_tickets.js" first to create them.');
      return;
    }

    console.log(`Found ${openTickets.length} open tickets. Matching and resolving...\n`);

    for (const ticket of openTickets) {
      // Find matching scenario based on keyword in subject
      const scenario = resolutionScenarios.find((s) =>
        ticket.subject.toLowerCase().includes(s.keyword.toLowerCase())
      );

      if (!scenario) {
        continue;
      }

      console.log(`Processing Ticket #${ticket.id}: "${ticket.subject}"`);
      console.log(`   Applying Scenario: [${scenario.type}]`);

      // 1. Post the agent resolution reply
      await axios.post(
        `https://${FRESHDESK_DOMAIN}/api/v2/tickets/${ticket.id}/reply`,
        { body: scenario.agentReply },
        authHeader
      );
      console.log(`   -> Posted agent resolution reply.`);

      // 2. Set status to Resolved (4), which fires the Automation Rule webhook
      await axios.put(
        `https://${FRESHDESK_DOMAIN}/api/v2/tickets/${ticket.id}`,
        { status: 4 },
        authHeader
      );
      console.log(`   -> Set status to Resolved (Webhook triggered!).\n`);

      // 3-second delay to give FDK and LLM time to process each ticket cleanly
      await sleep(3000);
    }

    console.log('All targeted tickets have been resolved.');
  } catch (err) {
    console.error('Error resolving tickets:', err.response?.status, err.response?.data || err.message);
  }
}

resolveOpenTickets();