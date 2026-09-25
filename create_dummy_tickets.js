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

const testScenarios = [
  // --------------------------------------------------------------------------
  // CASE 1: HIGH KNOWLEDGE DRIFT (Triggers CRITICAL Alert + Proposed Patch)
  // Target Article: "How to Enable Two-Factor Authentication"
  // Documented in KB: Settings -> Security -> Authentication
  // Agent's Actual Path: Settings -> Security -> Authentication -> Reset Token
  // --------------------------------------------------------------------------
  {
    category: 'High Knowledge Drift (Critical)',
    subject: 'Cannot find 2FA reset button or security token options',
    customerQuery: '<p>Hello, I need to reset my authenticator and generate a new security token, but the options under Authentication look different from the help guide.</p>',
    customerEmail: 'alex.drift1@example.com',
    agentResolution: `
      <p>Hello Alex,</p>
      <p>The security UI was updated recently. To reset your authenticator and token, follow these steps:</p>
      <ol>
        <li>Go to <strong>Settings</strong></li>
        <li>Click on <strong>Security</strong></li>
        <li>Select <strong>Authentication</strong></li>
        <li>Click on <strong>Reset Token</strong></li>
        <li>Enter your account password and click <strong>Confirm and generate new token</strong></li>
      </ol>
      <p>Your new token will be displayed immediately.</p>
    `
  },

  // --------------------------------------------------------------------------
  // CASE 2: SLIGHT / EMERGING DRIFT (Triggers WARNING Alert)
  // Target Article: "How to Update Your Profile Information"
  // Documented in KB: Settings -> Profile -> Edit
  // Agent's Actual Path: Direct shortcut to Profile -> Edit (skipping Settings)
  // --------------------------------------------------------------------------
  {
    category: 'Slight Knowledge Drift (Warning)',
    subject: 'How do I update my profile department and display name?',
    customerQuery: '<p>Hi team, my department changed from Marketing to Product. How can I reflect this on my user profile?</p>',
    customerEmail: 'sam.drift2@example.com',
    agentResolution: `
      <p>Hi Sam,</p>
      <p>You can update your profile directly without going through the main settings menu:</p>
      <ol>
        <li>Click directly on your <strong>Profile</strong> icon at the top</li>
        <li>Click <strong>Edit</strong> next to Department</li>
        <li>Update the value and click <strong>Save</strong></li>
      </ol>
      <p>Let me know if you run into any issues!</p>
    `
  },

  // --------------------------------------------------------------------------
  // CASE 3: KNOWLEDGE GAP (Triggers Knowledge Gap Alert & Auto-Drafting)
  // Target Article: None (Topic absent from the 10 articles)
  // --------------------------------------------------------------------------
  {
    category: 'Knowledge Gap (No Matching KB Article)',
    subject: 'Requesting AWS cloud sandbox and Docker container access',
    customerQuery: '<p>Hi IT team, I am onboarding as a backend engineer and need access to our cloud development sandbox and Docker registry. How do I request this?</p>',
    customerEmail: 'dev.gap1@example.com',
    agentResolution: `
      <p>Welcome to the engineering team!</p>
      <p>Here is how to provision your cloud sandbox:</p>
      <ol>
        <li>Navigate to the internal <strong>Cloud Console</strong> portal</li>
        <li>Go to <strong>Access Management</strong> and select <strong>Developer Sandbox</strong></li>
        <li>Choose <strong>AWS Sandbox & Docker Registry</strong></li>
        <li>Enter your project cost-center code and click <strong>Submit Request</strong></li>
      </ol>
      <p>Your engineering manager will receive an approval notification within 24 hours.</p>
    `
  },

  // --------------------------------------------------------------------------
  // BONUS CASE: HIGH DRIFT ON PASSWORD RESET
  // Target Article: "How to Reset Your Account Password"
  // Documented in KB: Login -> Forgot Password
  // Agent's Actual Path: Settings -> Security -> Authentication
  // --------------------------------------------------------------------------
  {
    category: 'High Knowledge Drift (Critical)',
    subject: 'Password reset link expired, need to change credentials',
    customerQuery: '<p>Hi, I am already logged into my workstation but my password expired. Where do I reset it from inside the dashboard?</p>',
    customerEmail: 'taylor.drift3@example.com',
    agentResolution: `
      <p>Hi Taylor,</p>
      <p>If you are already logged in, do not use the login page. Instead:</p>
      <ol>
        <li>Go to <strong>Settings</strong></li>
        <li>Click <strong>Security</strong></li>
        <li>Select <strong>Authentication</strong></li>
        <li>Choose <strong>Reset Token</strong> and update your password</li>
      </ol>
      <p>Your session will remain authenticated.</p>
    `
  }
];

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTicketGenerator() {
  console.log(`Starting automated test ticket creation on ${FRESHDESK_DOMAIN}...\n`);

  for (const [index, scenario] of testScenarios.entries()) {
    console.log(`[${index + 1}/${testScenarios.length}] Generating: ${scenario.category}`);
    console.log(`   Subject: "${scenario.subject}"`);

    try {
      // 1. Create the initial customer ticket
      const ticketRes = await axios.post(
        `https://${FRESHDESK_DOMAIN}/api/v2/tickets`,
        {
          subject: scenario.subject,
          description: scenario.customerQuery,
          email: scenario.customerEmail,
          priority: 2,
          status: 2 // Open
        },
        authHeader
      );

      const ticketId = ticketRes.data.id;
      console.log(`   -> Ticket #${ticketId} created (Open).`);

      // 2. Add the agent resolution reply
      await axios.post(
        `https://${FRESHDESK_DOMAIN}/api/v2/tickets/${ticketId}/reply`,
        {
          body: scenario.agentResolution
        },
        authHeader
      );
      console.log(`   -> Agent resolution reply posted.`);

      // 3. Update status to Resolved (triggers the Freshdesk Automation Webhook)
      await axios.put(
        `https://${FRESHDESK_DOMAIN}/api/v2/tickets/${ticketId}`,
        {
          status: 4 // 4 = Resolved
        },
        authHeader
      );
      console.log(`   -> Status changed to Resolved (Webhook triggered!).\n`);

      // Small delay between tickets to avoid rate limits
      await sleep(2500);
    } catch (err) {
      console.error(
        `   ❌ Error processing "${scenario.subject}":`,
        err.response?.status,
        err.response?.data || err.message
      );
    }
  }

  console.log('Finished generating all test scenarios!');
}

runTicketGenerator();