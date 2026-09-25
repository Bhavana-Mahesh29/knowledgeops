// demo_scenarios.js
// The KnowledgeOps demo data set, shared by create_articles_tickets.js
// (creates the tickets) and reslove_tickets.js (posts the agent resolutions).
// Tickets are left Open - resolving one in Freshdesk is what makes
// KnowledgeOps analyse it.
//
// Designed against the live knowledge base and server/lib/taxonomy.js so it
// clears the real (production) scoring gates as well as demo mode:
//
//   HIGH KNOWLEDGE DRIFT - "How to Enable Two-Factor Authentication"
//     documented : Settings -> Security -> Authentication
//     agents use : Settings -> Security -> Two-Step Verification
//     5 tickets, 4 different agents, all linking the article -> confidence 1.00
//
//   EMERGING KNOWLEDGE DRIFT - "How to Update Your Profile Information"
//     documented : Settings -> Profile -> Edit
//     agents use : Settings -> Account Center -> Personal Info
//     4 of 7 tickets (3 agents) take the new route, 3 follow the article
//     -> share 57%, confidence ~0.64 (production) / ~0.74 (demo mode)
//
//   KNOWLEDGE GAP - requesting an AWS developer sandbox: no article covers
//     it, so KnowledgeOps drafts a new one.
//
// Resolve the three "follows the article" profile tickets BEFORE the four
// Account Center ones. Resolved the other way round, the profile article
// briefly looks like high drift (4 of 4 tickets) until the rest arrive.
'use strict';

const DOMAIN = 'knowledgeopshack.freshdesk.com';
const TAG = 'knowledgeops-demo';

const ARTICLES = {
  twoFactor: { id: '68000037325', title: 'How to Enable Two-Factor Authentication' },
  profile: { id: '68000037330', title: 'How to Update Your Profile Information' }
};

// Freshdesk agents on the account. Distinct responders are what the
// "confirmed by N agents" gate counts.
const AGENTS = {
  bhavana: 68010675512,
  dhanishka: 68010675502,
  mohith: 68010675526,
  ramanan: 68010581307
};

function articleLink(article) {
  return `https://${DOMAIN}/support/solutions/articles/${article.id}`;
}

// The link text is the bare URL, not the article title: a title such as
// "How to Enable Two-Factor Authentication" names a menu, and would be read
// as a step the agent took.
function reply(greeting, lines, closing, article) {
  const steps = lines.map((l) => `<li>${l}</li>`).join('');
  const link = article
    ? `<p>Reference: <a href="${articleLink(article)}">${articleLink(article)}</a></p>`
    : '';

  return `<p>${greeting}</p><ol>${steps}</ol><p>${closing}</p>${link}`;
}

// Replies on each route stay clear of the other route's menu names, so step
// extraction - including its offline fallback - cannot mix the two up.
const SCENARIOS = [
  // ---- EMERGING DRIFT: follows the article (resolve these first) -------
  {
    key: 'profile-follow-1',
    group: 'Emerging drift - follows the article',
    article: ARTICLES.profile,
    responder: AGENTS.bhavana,
    requester: 'nisha.rao@example.com',
    subject: 'Need to change the phone number on my account',
    description: '<p>Hi, I have a new mobile number. Where do I update it so the team can reach me?</p>',
    resolution: reply('Hi Nisha,', [
      'Open <strong>Settings</strong>.',
      'Select <strong>Profile</strong>.',
      'Click <strong>Edit</strong> next to Phone, enter the new number and click <em>Save</em>.'
    ], 'The new number shows straight away.', ARTICLES.profile)
  },
  {
    key: 'profile-follow-2',
    group: 'Emerging drift - follows the article',
    article: ARTICLES.profile,
    responder: AGENTS.ramanan,
    requester: 'arjun.mehta@example.com',
    subject: 'How do I correct the spelling of my name?',
    description: '<p>My surname is misspelt on my account. Can I fix it myself?</p>',
    resolution: reply('Hello Arjun,', [
      'Go to <strong>Settings</strong>, then <strong>Profile</strong>.',
      'Click <strong>Edit</strong> beside your name.',
      'Correct the spelling and click <em>Save</em>.'
    ], 'You can change it yourself any time.', ARTICLES.profile)
  },
  {
    key: 'profile-follow-3',
    group: 'Emerging drift - follows the article',
    article: ARTICLES.profile,
    responder: AGENTS.mohith,
    requester: 'fatima.khan@example.com',
    subject: 'Update my department after team transfer',
    description: '<p>I moved from Sales to Customer Success. My department still shows Sales.</p>',
    resolution: reply('Hi Fatima,', [
      'Open <strong>Settings</strong> and choose <strong>Profile</strong>.',
      'Click <strong>Edit</strong> next to Department.',
      'Pick Customer Success and click <em>Save</em>.'
    ], 'Congratulations on the move!', ARTICLES.profile)
  },

  // ---- HIGH DRIFT: 2FA moved to Two-Step Verification ----------------
  {
    key: '2fa-drift-1',
    group: 'High drift - new route',
    article: ARTICLES.twoFactor,
    responder: AGENTS.bhavana,
    requester: 'rahul.verma@example.com',
    subject: 'Cannot find the option to turn on 2FA',
    description: '<p>I followed the help article to enable two-factor sign-in, but the option it mentions is not there.</p>',
    resolution: reply('Hi Rahul,', [
      'Go to <strong>Settings</strong>.',
      'Click <strong>Security</strong>.',
      'Open <strong>Two-Step Verification</strong> and click <em>Turn on</em>.',
      'Scan the QR code with your authenticator app and enter the 6-digit code.'
    ], 'The option moved in the latest release, so the article is a little behind.', ARTICLES.twoFactor)
  },
  {
    key: '2fa-drift-2',
    group: 'High drift - new route',
    article: ARTICLES.twoFactor,
    responder: AGENTS.dhanishka,
    requester: 'meera.iyer@example.com',
    subject: 'Two-factor setup steps in the guide do not match my screen',
    description: '<p>The guide says to enable two-factor sign-in from a page I cannot find. What changed?</p>',
    resolution: reply('Hello Meera,', [
      'Open <strong>Settings</strong> and select <strong>Security</strong>.',
      'Choose <strong>Two-Step Verification</strong>.',
      'Click <em>Turn on</em>, scan the QR code and confirm with the code from your app.'
    ], 'You are all set once the code is accepted.', ARTICLES.twoFactor)
  },
  {
    key: '2fa-drift-3',
    group: 'High drift - new route',
    article: ARTICLES.twoFactor,
    responder: AGENTS.mohith,
    requester: 'vikram.singh@example.com',
    subject: 'Security team asked me to enable 2FA - where is it?',
    description: '<p>I was asked to switch on two-factor sign-in today but cannot locate the setting.</p>',
    resolution: reply('Hi Vikram,', [
      'Click <strong>Settings</strong>.',
      'Go to <strong>Security</strong>.',
      'Select <strong>Two-Step Verification</strong>, click <em>Turn on</em> and scan the QR code.'
    ], 'Keep the backup codes somewhere safe.', ARTICLES.twoFactor)
  },
  {
    key: '2fa-drift-4',
    group: 'High drift - new route',
    article: ARTICLES.twoFactor,
    responder: AGENTS.ramanan,
    requester: 'ananya.das@example.com',
    subject: 'Enable two-step sign-in for my new laptop login',
    description: '<p>Setting up my new laptop and want to add the second sign-in step to my account.</p>',
    resolution: reply('Hello Ananya,', [
      'Go to <strong>Settings</strong>, then <strong>Security</strong>.',
      'Open <strong>Two-Step Verification</strong>.',
      'Click <em>Turn on</em> and follow the QR code prompt in your authenticator app.'
    ], 'It only takes a minute.', ARTICLES.twoFactor)
  },
  {
    key: '2fa-drift-5',
    group: 'High drift - new route',
    article: ARTICLES.twoFactor,
    responder: AGENTS.dhanishka,
    requester: 'karthik.nair@example.com',
    subject: 'Where did the 2FA settings move?',
    description: '<p>After the update I cannot see where to turn on two-factor sign-in any more.</p>',
    resolution: reply('Hi Karthik,', [
      'Open <strong>Settings</strong>.',
      'Select <strong>Security</strong>.',
      'Click <strong>Two-Step Verification</strong>, then <em>Turn on</em>, and scan the QR code.'
    ], 'Let us know if the code is not accepted.', ARTICLES.twoFactor)
  },

  // ---- EMERGING DRIFT: the newer Account Center route -----------------
  {
    key: 'profile-drift-1',
    group: 'Emerging drift - new route',
    article: ARTICLES.profile,
    responder: AGENTS.dhanishka,
    requester: 'sneha.pillai@example.com',
    subject: 'Change my job title shown to colleagues',
    description: '<p>I was promoted to Team Lead. How do I update the title others see?</p>',
    resolution: reply('Hi Sneha,', [
      'Open <strong>Settings</strong>.',
      'Go to <strong>Account Center</strong>.',
      'Select <strong>Personal Info</strong>, update Job title and click <em>Save changes</em>.'
    ], 'Congratulations on the promotion!', ARTICLES.profile)
  },
  {
    key: 'profile-drift-2',
    group: 'Emerging drift - new route',
    article: ARTICLES.profile,
    responder: AGENTS.bhavana,
    requester: 'rohan.gupta@example.com',
    subject: 'Updating my contact number on the account',
    description: '<p>My work phone changed. Please tell me how to update it.</p>',
    resolution: reply('Hello Rohan,', [
      'Go to <strong>Settings</strong>, then <strong>Account Center</strong>.',
      'Choose <strong>Personal Info</strong>.',
      'Enter the new phone number and click <em>Save changes</em>.'
    ], 'The change is immediate.', ARTICLES.profile)
  },
  {
    key: 'profile-drift-3',
    group: 'Emerging drift - new route',
    article: ARTICLES.profile,
    responder: AGENTS.mohith,
    requester: 'divya.menon@example.com',
    subject: 'Name change after marriage',
    description: '<p>I need my surname updated on my account after getting married.</p>',
    resolution: reply('Hi Divya,', [
      'Click <strong>Settings</strong>.',
      'Open <strong>Account Center</strong> and select <strong>Personal Info</strong>.',
      'Update your surname and click <em>Save changes</em>.'
    ], 'Congratulations!', ARTICLES.profile)
  },
  {
    key: 'profile-drift-4',
    group: 'Emerging drift - new route',
    article: ARTICLES.profile,
    responder: AGENTS.dhanishka,
    requester: 'aditya.joshi@example.com',
    subject: 'How do I update my office location?',
    description: '<p>I moved to the Bengaluru office. Where can I change my location?</p>',
    resolution: reply('Hello Aditya,', [
      'Open <strong>Settings</strong>.',
      'Go to <strong>Account Center</strong>, then <strong>Personal Info</strong>.',
      'Set Office to Bengaluru and click <em>Save changes</em>.'
    ], 'Welcome to the Bengaluru office.', ARTICLES.profile)
  },

  // ---- KNOWLEDGE GAP ----------------------------------------------------
  {
    key: 'gap-aws-sandbox',
    group: 'Knowledge gap',
    article: null,
    responder: AGENTS.ramanan,
    requester: 'dev.onboarding@example.com',
    subject: 'Requesting AWS developer sandbox and Docker registry access',
    description: '<p>Hi IT team, I am onboarding as a backend engineer and need a cloud development sandbox and Docker registry access. How do I request these?</p>',
    resolution: reply('Welcome to the engineering team!', [
      'Sign in to the internal Cloud Console.',
      'Go to Access Management and choose Developer Sandbox.',
      'Select the AWS Sandbox and Docker Registry bundle.',
      'Enter your project cost-center code and click Submit Request.'
    ], 'Your engineering manager approves the request, usually within 24 hours, and you get the sandbox credentials by email.', null)
  }
];

module.exports = { DOMAIN, TAG, ARTICLES, AGENTS, SCENARIOS };
