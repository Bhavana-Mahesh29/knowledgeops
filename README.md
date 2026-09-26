# KnowledgeOps

**Keeps a Freshdesk knowledge base accurate by learning from how agents actually resolve tickets, drafting fixes when articles drift, and publishing them after one human approval.**

## What it is

KnowledgeOps is a Freshworks (FDK Platform 3.0) app for Freshdesk. It watches resolved
tickets, compares the steps support agents really used with the steps each solution
article documents, and flags articles that have fallen out of date ("knowledge
drift"). It drafts the corrected article, gets it approved by a human, publishes it
back to Freshdesk, and phones the people who need to know.

It also runs as a tool for Freddy AI Agent: Freddy can call it as a freshness checker
when a ticket is resolved.

## What it does (business objective)

**Objective:** keep help-center articles and AI-agent answers correct as the product
changes, without manual audits. That raises self-service deflection and stops
customers and bots from repeating outdated steps.

- **Detects knowledge drift.** On every resolved ticket it matches the ticket to its
  article (explicit link → semantic search → Claude relevance check on the top 3
  candidates), extracts the agent's steps, and compares them with the documented path.
- **Scores evidence before alerting.** It needs at least N tickets from K distinct
  agents plus a minimum share of the article's traffic, and vetoes the alert if tickets
  on the new route keep being reopened. The result is **High** or **Emerging**
  Knowledge Drift.
- **Drafts validated fixes.** Claude rewrites only the steps section. A strict
  validator rejects anything else (other sections changed, skipped menu levels,
  retired steps), and there's a deterministic template fallback.
- **Keeps a human in the loop.** A Freshdesk-style board shows the Published path and
  the Proposed path side by side, with Approve / Edit / Reject. Approval publishes to
  Freshdesk and records who approved it.
- **Finds knowledge gaps.** When no article covers a resolution, it drafts a new
  article (title, steps, verification). Approval creates it in Freshdesk Solutions.
- **Sends voice alerts.**
  - The admin is phoned when a High Knowledge Drift alert is raised (once per drift).
  - The head of the department that owns the article is phoned after an approved
    update.
- **Integrates with Freddy AI.** The `checkTicketFreshness` and `getArticleFreshness`
  AI actions return a structured verdict: fresh, emerging drift, high drift or
  knowledge gap.
- **Uses human evidence only.** It ignores Freshdesk's automatic acknowledgements and
  Freddy AI's own answers, which quote the old article.
- **Protects privacy.** Emails, phone numbers, Aadhaar, PAN and sign-offs are redacted
  before any text reaches a model or storage.
- **Learns new routes.** It learns new menu wordings and routes from tickets, behind
  the same evidence gates, and the learning can be undone.

## What it doesn't do (out of scope)

- **Doesn't publish without a human.** Every article change needs an approver.
- **Doesn't answer customers.** It keeps the knowledge accurate; Freddy and agents do
  the answering.
- **Doesn't analyse open tickets.** Only resolved or closed tickets count as evidence.
- **Doesn't learn from AI-written replies,** such as Freddy AI Agent's answers.
- **Doesn't handle other languages yet.** It works on English articles and replies
  (multi-language is future work).
- **Isn't built for enterprise volume yet.** The prototype's storage is demo-scale;
  high-volume storage is planned.
- **Doesn't include a hosted relay.** The voice relay runs on your own machine or
  server (for example, behind ngrok while developing).

## Product integrations

| Product | Used for |
|---|---|
| **Freshdesk: Tickets & Conversations API** | Reading resolved tickets and the agent replies that serve as evidence |
| **Freshdesk: Solutions API** | Reading articles, publishing approved patches (PUT), creating gap articles (POST) |
| **Freshdesk: `onTicketUpdate` event and automation webhook** | Triggering analysis the moment a ticket is resolved |
| **Freshworks FDK Platform 3.0** | Serverless functions, the full-page app, `$db` storage, request templates, secure install settings |
| **Freddy AI Agent / AI Agent Studio** | The `actions.json` AI actions that let Freddy call KnowledgeOps as a freshness checker |
| **Anthropic Claude: Haiku 4.5** | Extracting navigation steps from agent replies (forced tool call) |
| **Anthropic Claude: Sonnet 5** | Relevance check on the top 3 candidate articles; drafting patches and new gap articles |
| **Voyage AI (`voyage-3.5`)** *(optional)* | Semantic embeddings for matching tickets to articles; a free built-in embedder is the default |
| **Vobiz Voice API** | Outbound phone calls to the admin (High drift) and department heads (article updated) |
| **KnowledgeOps voice relay** (Node.js) | Serves Vobiz `<Speak>` call scripts and forwards Freshdesk webhooks to the app, so one public URL covers both |
| **ngrok** *(development)* | Public HTTPS URL for the relay while running locally |

**Not currently integrated (possible future work):**
- **Sarvam AI:** Indian-language support (multi-language articles and replies, regional-language voice calls).
- **Databricks:** large-scale ticket-evidence storage and knowledge-health analytics across very high ticket volumes
<img width="407" height="230" alt="image" src="https://github.com/user-attachments/assets/5c457da2-0c64-4564-a473-903ce4abd078" />
