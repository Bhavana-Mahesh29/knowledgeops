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

// 10 realistic support inquiries directly matching your KB articles
const articleTickets = [
  {
    article: "How to Reset Your Account Password",
    subject: "Forgot account password and unable to log in",
    description: "<p>Hello, I have forgotten my account password and got locked out after multiple attempts. How can I reset it?</p>",
    email: "user.pwd@example.com"
  },
  {
    article: "How to Enable Two-Factor Authentication",
    subject: "Need help setting up Two-Factor Authentication (2FA)",
    description: "<p>Hi Support, I would like to enable two-factor authentication on my account using Google Authenticator. Could you guide me through the setup?</p>",
    email: "user.2fa@example.com"
  },
  {
    article: "How to Set Up VPN Access on Windows",
    subject: "Assistance configuring company VPN on Windows laptop",
    description: "<p>Hi, I received my new Windows workstation today and need to configure the SecureConnect VPN client for remote access.</p>",
    email: "user.vpn@example.com"
  },
  {
    article: "How to Submit a New IT Support Ticket",
    subject: "How do I raise a new support ticket in the portal?",
    description: "<p>Hello, I need to log an issue regarding my monitor display. Where can I find the ticket form on the portal?</p>",
    email: "user.portal@example.com"
  },
  {
    article: "How to Request Software Installation Approval",
    subject: "Requesting approval to install software on company device",
    description: "<p>Hi team, I need to install a developer tool for my upcoming project. What is the process for submitting an approval request to my manager?</p>",
    email: "user.software@example.com"
  },
  {
    article: "How to Connect to the Office Wi-Fi Network",
    subject: "Cannot connect to the office Wi-Fi network",
    description: "<p>Hi, I am visiting the main office today. Which network should I connect to and do I need a certificate?</p>",
    email: "user.wifi@example.com"
  },
  {
    article: "How to Update Your Profile Information",
    subject: "Updating department and contact phone number on profile",
    description: "<p>Hello, my contact number and team department changed recently. How can I update these details on my account profile?</p>",
    email: "user.profile@example.com"
  },
  {
    article: "How to Recover a Deleted File from OneDrive",
    subject: "Accidentally deleted a project document from OneDrive",
    description: "<p>Hi IT, I accidentally removed an important spreadsheet from my OneDrive folder this morning. Can it be restored from the recycle bin?</p>",
    email: "user.onedrive@example.com"
  },
  {
    article: "How to Configure Email Signature in Outlook",
    subject: "Need steps to set up standard company email signature",
    description: "<p>Hello, I need to format my default email signature in Outlook desktop to match the company branding. Where are the settings located?</p>",
    email: "user.outlook@example.com"
  },
  {
    article: "How to Escalate a Ticket to a Senior Agent",
    subject: "Procedure for escalating high-priority ticket to senior team",
    description: "<p>Hi, I have a complex technical ticket pending and need the procedure to reassign it to the senior support queue.</p>",
    email: "agent.escalate@example.com"
  }
];

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createTickets() {
  console.log(`Creating ${articleTickets.length} support tickets on ${FRESHDESK_DOMAIN}...\n`);

  for (const [index, item] of articleTickets.entries()) {
    try {
      const res = await axios.post(
        `https://${FRESHDESK_DOMAIN}/api/v2/tickets`,
        {
          subject: item.subject,
          description: item.description,
          email: item.email,
          priority: 2, // Medium
          status: 2    // Open
        },
        authHeader
      );

      console.log(`[${index + 1}/${articleTickets.length}] ✅ Ticket #${res.data.id} created`);
      console.log(`   Topic: "${item.article}"`);
      console.log(`   Subject: "${item.subject}"\n`);

      await sleep(1000); // 1-second delay between requests
    } catch (err) {
      console.error(
        `❌ Failed to create ticket for "${item.article}":`,
        err.response?.status,
        err.response?.data || err.message
      );
    }
  }

  console.log('All tickets generated successfully.');
}

createTickets();