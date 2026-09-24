# KnowledgeOps

Detects when support agents have quietly stopped following what a Freshdesk
solution article says, drafts a patch for the article, and publishes it back to
Freshdesk once a human approves it.

## The pipeline

Every time a ticket is resolved or closed (`onTicketUpdate`):

0. **Match** — `server/lib/matcher.js` decides which solution article the
   ticket was resolved with (see *Matching a resolved ticket to an article*
   below). A match goes on to step 1; a ticket no article describes is
   recorded as a **knowledge gap** and never enters drift analysis.
1. **Redact** — `server/lib/redact.js` strips email, phone, Aadhaar (Verhoeff
   checked), PAN and agent sign-offs from the reply text. This runs before the
   text reaches any model or the datastore. Regex-based, not NER-grade.
2. **Extract** — `server/lib/extractor.js` asks Haiku, via a forced tool call,
   for the ordered UI labels the agent named. If the API is unreachable it
   falls back to a deterministic scan of the taxonomy's own aliases.
3. **Canonicalise** — `server/lib/canonical.js` resolves those labels to a
   single taxonomy path, auto-filling levels the agent skipped and flagging
   paths that contradict themselves. Labels it cannot place are logged rather
   than thrown away, and the resolved part of the ticket still counts as
   evidence — real replies almost always contain a button or a form field
   that is not a menu node.
4. **Cluster and score** — `server/server.js` groups the article's tickets by
   the path their agent walked and runs each group through
   `server/lib/scoring.js`. The gates, in order: at least N explicitly linked
   tickets, at least K distinct agents, a minimum share X of the article's
   traffic, and a reopen-rate veto. Only what survives becomes an alert.
5. **Draft** — `server/lib/architect.js` has Sonnet rewrite the Steps section,
   retrying with the validator's own errors fed back. If the model keeps
   failing, a deterministic template patch takes over.
6. **Validate** — `server/lib/validator.js` is the gate both modes pass
   through: section headings unchanged, nothing outside Steps modified, every
   bold span a live taxonomy node, and the bold spans spelling out the target
   path exactly.
7. **Review** — nothing reaches Freshdesk without a click in the app's action
   board. An approver can publish the draft as-is, edit it first, or reject
   it. An edited patch goes through the same validator, so editing cannot
   smuggle a change past the checks. Approving PUTs the article back and
   records who did it.

Between 3 and 4 the graph teaches itself, in two ways, both behind the same
convergence gate that guards alerts — seen N times, by K different agents:

- **Aliases.** A label the graph cannot place is matched against existing
  nodes by content-word overlap, and attached as an alias if exactly one node
  fits. "click security" resolves to Security, "api details" to API & Security
  Details. Two equally good matches or a lone partial overlap mean no
  promotion.
- **Routes.** When an agent walks straight from one menu node to another the
  graph says is unreachable from it, that gap is recorded as a candidate
  parent edge. Enough tickets and the edge is added. This is the only thing
  that can fix an `inconsistent` ticket — an alias cannot, because the labels
  involved already resolved.

Both live in `$db`, apply retroactively to tickets already on file, and can be
dropped wholesale from the board. Neither invents a node: aliases recognise a
rewording of a node that exists, routes connect two nodes that exist. An edge
that would close a loop is refused, and if one ever slipped through, the walk
shortens the route rather than losing the node.

## Matching a resolved ticket to an article

Drift is only meaningful against the article the agent actually followed, so
every resolved ticket is matched first. Three stages, cheapest and most
certain first; each stops the funnel as soon as it decides:

1. **Deterministic linkage** (`server/lib/linkage.js`) — an
   `associated_solution_article_id` (or equivalent field), then a
   Freshdesk/Freshservice solution URL in the resolution, notes or replies,
   then a category/subcategory that maps to exactly one KB article. Links to
   two different articles, or two articles in one category, are ambiguity and
   fall through — nothing is picked at random.
2. **Semantic retrieval** (`embeddings.js`, `vectorstore.js`, `query.js`) —
   the ticket's subject + final resolution note (greetings, signatures,
   quoted history and boilerplate stripped, PII redacted) is embedded and
   compared by cosine similarity against every article's title, category and
   procedure. The top 3 at or above the threshold go on; none means
   `KNOWLEDGE_GAP` (`no_semantic_match`).
3. **Relevance gate** (`relevance.js`) — Claude gets the redacted ticket and
   those ≤3 candidates, **never the knowledge base**, and must say which one
   describes the exact procedure performed, via a forced tool call. The
   answer is validated: an article id that was not offered or malformed output
   is never read as a match. `NO_MATCH` or a match below
   `relevance_min_confidence` is a `KNOWLEDGE_GAP` (`no_relevant_article` /
   `low_confidence_llm_gate`).

Outcomes are `ARTICLE_MATCH`, `KNOWLEDGE_GAP`, `INSUFFICIENT_EVIDENCE` (no
resolution text to match on) and `MATCHING_UNAVAILABLE` (the embedding
service, the vector store or Claude failed or answered garbage). An outage is
never reported as a gap. Every result says how it was reached (`method`,
`stage`, `candidates`, `semantic_score`, `confidence`, `reason`) and carries
the funnel (`metrics`, `trace`), which is also logged as
`[knowledgeops] match: {...}` and totalled by `getMatchMetrics`.

Only `associated_solution_article_id` and URL matches count as **explicit**
links for the N gate in scoring. Category and semantic matches add to an
article's traffic and agent count, but cannot raise an alert on their own.

**Serverless methods**

| Method | Does |
| --- | --- |
| `matchResolvedTicket` | The `POST /match-resolved-ticket` equivalent. Takes `ticket_id`, `subject`, `resolution_note`, `conversation`, `associated_solution_article_id`, `category`, `subcategory` (optionally `agent_id`, `run_drift: false`). Returns the match, plus `drift` for a match or `knowledge_gap` for a gap. |
| `indexKnowledgeBase` | Loads `articles` (optional; `{ article_id, title, category, subcategory, body }` or a Freshdesk article payload) and embeds whatever is new or changed. |
| `listKnowledgeGaps` | Gaps recorded so far, with the redacted subject/resolution and the articles ruled out. |
| `getMatchMetrics` | Funnel totals across all matched tickets. |

**Embeddings** are behind one interface (`createEmbedder` → `embedText`,
`embedArticle`). `local` is a deterministic feature-hashing embedder — no key,
no network — and the default; `voyage` calls Voyage AI through the
`voyageEmbeddings` request template. Each article's embedding is stored in
`$db` with its content hash and model, and regenerated only when either
changes. The index is a linear scan: fine for a support KB of a few thousand
articles, and the serverless runtime cannot host a native vector store.

**Configuration** — install page, or the environment when the libraries run
under plain node (`envOverrides(process.env)`):

| iparam | Environment | Default |
| --- | --- | --- |
| `embedding_provider` | `EMBEDDING_PROVIDER` | `local` |
| `voyage_api_key` (secure) | — (`VOYAGE_API_KEY` for the demo script) | — |
| `semantic_match_threshold` | `SEMANTIC_MATCH_THRESHOLD` | `0.80` for voyage, `0.30` for local |
| `semantic_top_k` | `SEMANTIC_TOP_K` | `3` (never more) |
| `embedding_model` | `EMBEDDING_MODEL` | `voyage-3.5` / `hash-512-v1` |
| `relevance_model` | `RELEVANCE_MODEL` | `claude-sonnet-5` |
| `relevance_min_confidence` | `RELEVANCE_MIN_CONFIDENCE` | `0.70` |

Scores are not comparable across embedding models, which is why the default
threshold depends on the provider. Recalibrate when you change models:
`npm run demo:match` prints every ticket's top score against the dataset's
ground truth.

`npm run demo:match` runs `data/beta/resolved_tickets.json` through the real
server code in the FDK sandbox stand-in and prints each ticket's funnel. With
`ANTHROPIC_API_KEY` set, stage 3 calls Claude; without it, an offline
title-overlap stand-in answers instead, and the output says so.

## The taxonomy is configuration, not sample data

`server/lib/taxonomy.js` is the product's navigation graph, and every later
stage reasons over it. If it does not match your product, correctly extracted
tickets come back `inconsistent` and no drift is ever detected. It currently
describes:

    Profile
      Authentication            <- the route agents use now
        Security
          Reset Security Token  <--+
      Profile Settings             |  the same button, reachable both ways
        API & Security Details  ---+  (both retired steps are deprecated, so
                                       the validator rejects any patch that
                                       puts them back)

It is a **graph, not a tree**: a node may have several parents, because real
UIs reach one destination by more than one route. Forcing a single parent made
those two facts contradict each other and reported honest tickets as
`inconsistent`. When several routes reach the destination, canonicalisation
picks the one that accounts for every node the agent actually named.

**No node ships deprecated.** Whether a menu item is genuinely gone is a
statement about your product, not something to infer from one article. Set
`is_deprecated: true` deliberately: the validator will then refuse to publish
any patch containing that step, which makes every alert targeting that route
unapprovable on purpose, and reports it as `retired_route_in_use` with no
draft rather than failing three times to produce one.

Edit it freely. A learned alias or edge whose target node no longer exists is
ignored on lookup and re-resolved against the new graph on the next ingest,
rather than poisoning the walk.

## Articles need a documented path

Drift is the difference between the path agents walk and the path the article
documents. The article side is read from **bold spans inside a `Steps`
section**, so an article with no bold menu items documents nothing, every
observed path trivially differs from it, and the resulting "drift" is an
artefact. The ingest logs a `warning` when this happens.

Bold is reserved for navigation; buttons, fields and confirmations belong in
italics. Format the article with the editor's own bold/italic controls, or use
its source view — pasting raw HTML as *text* leaves the tags escaped and
visible in the body, and none of it parses as formatting.

The article is re-read from Freshdesk on every ingest, so edits take effect on
the next simulate with no cache to clear.

## Who can approve

`Approvers (agent emails)` in the app settings is a comma-separated list of
Freshdesk agent emails. Leave it blank and anyone who can open the app can
act; fill it in and everyone else sees the review pane read-only. Every
approval, rejection and edit is recorded against the acting email on the
alert.

**This is not a security boundary, and it is worth being precise about why.**
A serverless method receives no authenticated caller — the front end tells
the server who is acting, and anyone able to call the data pipe directly
could claim to be someone else. What the list gives you is the right buttons
for the right people and an attributable record of who published what. The
actual boundary is which agents can open the app at all, which is a Freshdesk
app-placement decision. (The approver list itself cannot be spoofed: FDK
supplies `iparams` to the method from the installed app's configuration, not
from the caller.)

### When the article is ahead of the agents

The app assumes agents are authoritative and the article is stale. Sometimes
it is the other way round: the article documents the current route and a
cluster of tickets is still walking a retired one. That is reported as a
distinct finding, `retired_route_in_use`, and **no patch is drafted** — the
validator refuses deprecated steps by design, so every draft would fail, and
an alert nobody can approve does not belong on an approvals board pretending
to be one. Read it as an enablement gap rather than a documentation bug.

## Setup

1. `npm install`
2. `fdk run`
3. Open <http://localhost:10001/custom_configs> and fill in:

   | Field | Notes |
   | --- | --- |
   | Freshdesk domain | Full domain, e.g. `yourcompany.freshdesk.com` — no `https://`, no trailing slash |
   | Freshdesk API key | From your Freshdesk profile settings. Required to read tickets and publish articles |
   | Anthropic API key | Used for extraction and drafting; the app degrades to deterministic fallbacks without it |
   | Demo mode | ON makes one ticket enough to raise an alert (see below) |
   | Provisional hedging | ON lets the bot answer with an unapproved path on Critical alerts |
   | Publish mode | `demo` publishes immediately, `production` saves a draft |

   The install page must be saved at least once — the request templates read
   the domain and API key from there.

### Automatic detection from Freshdesk

`fdk run` cannot receive real product events. Freshworks dispatches
`onTicketUpdate` to an app's serverless runtime inside its own infrastructure,
and it has no route to your laptop — which is exactly why the simulation page
exists. Resolving a ticket in Freshdesk will not reach a locally running app
no matter how it is configured.

To have resolutions picked up automatically, with no simulation:

1. `fdk pack` — produces `dist/knowledge-final.zip`. Add `--skip-coverage`
   while FDK's own server-side coverage is under 80%; that gate is a
   Marketplace submission requirement, not an install requirement.
2. In Freshdesk, go to **Admin -> Apps -> Get More Apps -> Custom Apps ->
   Upload private app**, and upload the zip.
3. Fill in the same installation parameters.

From then on the flow is hands-off: an agent resolves a ticket, the platform
fires `onTicketUpdate`, the app ingests it, and any alert appears on the board
for an approver. The only manual step left is the approval itself, which is
the point.

### Automatic ingestion while developing with `fdk run`

Product events never reach a local server, but a Freshdesk automation
webhook can, through the ngrok tunnel FDK opens:

1. `fdk run --tunnel --tunnel-auth <your ngrok authtoken>` and copy the
   printed `Tunnel URL`.
2. Open <http://localhost:10001/web/test> once. FDK only loads the app's
   event list when something asks for it; until then every webhook fails with
   `Events not configured for module common`.
3. In Freshdesk: **Admin -> Workflows -> Automations -> Ticket Updates -> New
   rule**. When: *Status is changed to Resolved* (add *Closed* if you want).
   Action: *Trigger webhook*, `POST` to `<Tunnel URL>/event/hook/common`,
   encoding JSON, content `{"ticket_id": "{{ticket.id}}"}`.

The URL must end in **`/common`**: this is a modular (platform 3.0) app, and
FDK answers `/event/hook/freshdesk` with `Events not configured for product
freshdesk`. The handler re-reads the ticket from Freshdesk, so it is ingested
only if it really is resolved. A free ngrok URL changes on every restart;
update the rule when it does. Once the app is installed from the zip, native
`onTicketUpdate` does the same job, so disable the rule then or every ticket
is ingested twice (harmless, but duplicated work).

Every ingest prints the verdict in the terminal:

    [knowledgeops] drift: ticket 9 -> article 68000037230 "Reset your security token"
      documented path : Profile Settings → API & Security Details → Reset Security Token
      agent's path    : Profile → Authentication → Security → Reset Security Token
      verdict         : PROCEDURAL DRIFT - critical alert raised (confidence 1.00), validated patch drafted, awaiting approval

Other verdicts: `NO DRIFT`, `PROCEDURAL DRIFT observed` (recorded, below the
alert gates), `UNDETERMINED` (steps did not resolve to a path), or
`no drift check: ...` for a knowledge gap or unavailable matching.

### Seeing it end to end

The convergence rule deliberately needs **4 tickets from 3 different agents**
before it will touch an article, so a single simulated ticket produces nothing
in the default configuration. To watch the whole pipeline from one ticket, turn
**Demo mode** on; it relaxes the gates to N=1, K=1, X=0.

Then either:

- **Simulate the event.** Open <http://localhost:10001/web/test>, pick
  `onTicketUpdate`, and edit the payload so `data.ticket.id` is a real resolved
  ticket in your Freshdesk whose public replies link to a solution article
  (`/support/solutions/articles/<id>`). Simulate. The `fdk run` console logs
  `[knowledgeops] onTicketUpdate: {...}` with the alert it raised.
- **Or use the app.** Open the full-page app with `?dev=true` on your Freshdesk
  URL, type a ticket id into the *Ingest ticket* box, and press Ingest.

Either way the alert then shows up on the action board. Open it, read the
evidence and the proposed diff, and press **Approve & publish** — that is the
step that writes to Freshdesk.

A ticket is skipped (not an error) when it is not resolved/closed, when no
article matches it (a knowledge gap, recorded for `listKnowledgeGaps`), or
when matching is unavailable. The console says which, and logs the matching
funnel as `[knowledgeops] match: {...}`.

## Tests

```
npm test          # node test.js (pure logic) + vitest (front end + pipeline)
npm run test:logic
```

`tests/pipeline.test.js` loads `server/server.js` inside a stand-in for the FDK
serverless sandbox — same vm context, same `exports`/`require` rules, same
`renderData` contract — with Freshdesk and Anthropic stubbed. If something
would break under `fdk run`, it breaks there first.

## Files and folders

    .
    ├── app                          Front end (full-page app)
    │   ├── index.html
    │   ├── scripts/app.js           Action board; talks to the server via client.request.invoke
    │   └── styles/
    ├── config
    │   ├── iparams.json             Installation parameters
    │   └── requests.json            Request templates for Freshdesk + Anthropic
    ├── data                         Reference datasets (not used at runtime); beta/resolved_tickets.json
    │                                and ground_truth.json's "matching" section drive the matcher tests
    ├── scripts/match-demo.js        Runs the dataset through matching and prints the funnel
    ├── server
    │   ├── server.js                Event handler, matching I/O, rescoring, serverless methods
    │   ├── lib/                     Pure-logic modules, all dual-exported (see below)
    │   │   ├── matcher.js           The three-stage ticket-to-article matcher
    │   │   ├── linkage.js           Stage 1: associated article, URL, category
    │   │   ├── query.js             Resolution query / article text cleaning
    │   │   ├── embeddings.js        Embedding providers (local, voyage)
    │   │   ├── vectorstore.js       Index, embedding cache, cosine top-K
    │   │   ├── relevance.js         Stage 3: Claude relevance gate
    │   │   └── matchconfig.js       Thresholds and models, one place
    │   └── test_data/               Payloads the "simulate event" page uses
    ├── tests
    │   ├── app.test.js              Front-end tests
    │   ├── pipeline.test.js         End-to-end through the sandbox
    │   ├── matching.test.js         Matcher, stage by stage, and the dataset
    │   ├── matching-pipeline.test.js  Matching wired into the server
    │   └── sandbox.js               FDK sandbox stand-in
    ├── test.js                      Pure-logic assertions, runnable with plain node
    └── manifest.json

### A note on exports

The FDK serverless sandbox injects `exports` as a bare global and does **not**
define `module`. A `module.exports = ...` anywhere under `server/` fails at
load time with `ReferenceError: module is not defined`, which takes the whole
event handler down. Every file in `server/lib` therefore ends with:

```js
exports = api;
if (typeof module === 'object') {
  module.exports = api;
}
```

The guarded second half is what lets `node test.js` require the same files
directly.
