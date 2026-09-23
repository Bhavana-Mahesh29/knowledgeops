# KnowledgeOps

Detects when support agents have quietly stopped following what a Freshdesk
solution article says, drafts a patch for the article, and publishes it back to
Freshdesk once a human approves it.

## The pipeline

Every time a ticket is resolved or closed (`onTicketUpdate`):

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

A ticket is skipped (not an error) when it is not resolved/closed, or when no
public agent reply links to a solution article. The console says which.

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
    ├── data                         Reference datasets from the original prototype (not used at runtime)
    ├── server
    │   ├── server.js                Event handler, rescoring, serverless methods
    │   ├── lib/                     Pure-logic modules, all dual-exported (see below)
    │   └── test_data/               Payloads the "simulate event" page uses
    ├── tests
    │   ├── app.test.js              Front-end tests
    │   ├── pipeline.test.js         End-to-end through the sandbox
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
