<h1 align="center">
  <img src="apps/web/src/assets/floway-blue.svg" alt="Floway logo" width="120" height="120"><br>
  Floway
</h1>

Floway is a self-hosted LLM API gateway for coding agents and API clients, with
a web dashboard. It connects GitHub Copilot, ChatGPT, Claude.ai, Azure AI,
custom HTTP providers, and Ollama through OpenAI, Anthropic, and
Gemini-compatible APIs.

## Deployment

### Cloudflare Workers

Ask your agent or follow the
[$deploy-to-cloudflare](.agents/skills/deploy-to-cloudflare/SKILL.md) skill yourself
to configure and deploy Floway to your Cloudflare account.

### Docker

```bash
git clone https://github.com/Menci/Floway.git
cd Floway
ADMIN_KEY='replace-with-a-secret' docker compose -f docker/docker-compose.yml up --build -d
```

Open <http://localhost:8788>, leave the username blank, and log in with
`ADMIN_KEY`. Data persists in the `floway-data` volume.

### Podman/systemd

Ask your agent or follow the [deployment guide](docker/systemd/README.md) yourself
to run Floway as a systemd service with Podman.

### Azure VM

For an existing Azure Linux VM reached over SSH, use the
[Azure VM deployment guide](./docker/azure-vm.md) and its private-port Compose override.

## Usage

Add an upstream under **Providers → Upstreams**, then create a key under
**Services → API Keys**. Use the API key in your client code or configure your
agents to use Floway as provider through **Agent Setup**.

On Windows, Codex Agent Setup reuses an existing Node.js executable for fast
provider-token reads from the protected `floway-token` file. Without Node.js,
it retains a non-interactive PowerShell helper and reports the slower fallback.
Restart existing Codex clients after changing their provider-auth configuration;
this does not require restarting the Floway gateway.

The data-plane and control-plane APIs are also exposed directly at
<http://localhost:8788>. SQLite, file-backed dump bodies, and oversized
Stateful OpenAI Responses item payloads persist in the `floway-data` volume.
### Cursor project agents

For local Cursor project agents, the following aliases assign models by
responsibility. These project-local definitions are not installed by Floway.
Configure matching aliases on your instance before using them; agent files do
not provision aliases or change Cursor's global model settings.
The `floway-cursor-` prefix is a naming convention, not an access-control
boundary: gateway aliases remain visible to callers who can use their targets.

| Role | Floway model ID | Real model | Fixed reasoning effort |
| --- | --- | --- | --- |
| Manager | `floway-cursor-manager-max` | `gpt-6-astra` | `max` |
| Researcher | `floway-cursor-researcher-max` | `gpt-5.6-terra` | `max` |
| Developer | `floway-cursor-developer-max` | `gpt-5.6-sol` | `max` |
| Debugger | `floway-cursor-debugger-max` | `gpt-6-astra` | `max` |
| Reviewer | `floway-cursor-reviewer-xhigh` | `grok-4.7` | `xhigh` |
| Verifier | `floway-cursor-verifier-max` | `gpt-5.6-terra` | `max` |

Use a single real-model target per alias, with chat rules
`{"reasoning":{"effort":"max"}}` (or `xhigh` for the reviewer), and make the
alias visible in the model list. The developer alias also retains
`"serviceTier":"priority"` from the existing Sol configuration. Check the
upstream catalog before applying these levels to another provider or version;
`max` is not universal.

Astra handles coordination and difficult diagnosis; Sol handles implementation;
Terra provides a balanced choice for investigation and test-result analysis;
Grok provides an independent review perspective. These are routing choices,
not a claim that one model is best for every task. Model selection is grounded
in the live upstream catalog, [Cursor's model descriptions](https://cursor.com/docs/models-and-pricing),
and [Grok 4.7's coding and verification focus](https://x.ai/news/grok-4-7).

In Cursor, configure the Floway OpenAI-compatible base URL ending in `/v1`,
add the six exact IDs as custom models, and select
`floway-cursor-manager-max` for the main conversation. Reload the project after
adding its agents. The `manager` subagent does not set the main conversation's model; select that
model separately in Cursor's main conversation.

[Cursor supports model parameters in agent frontmatter](https://cursor.com/docs/subagents#model-parameters),
but manually added IDs do not necessarily have the built-in model's options,
and a [custom-base-URL reasoning-effort forwarding issue](https://forum.cursor.com/t/165529/13)
has been reported. Floway alias rules override the outgoing effort after
translation, including when the client omits it or requests a lower value.
Pinned aliases deliberately omit a selectable effort from their catalog
metadata: a missing level dropdown does not mean reasoning is disabled.
Highest reasoning effort may increase latency and usage; it does not change
the context-window limit and is not Cursor's separate Max Mode setting.

## Compatibility

### Client APIs

| API | Routes |
| --- | --- |
| OpenAI Completions | `POST /v1/completions` |
| OpenAI Chat Completions | `POST /v1/chat/completions` |
| OpenAI Responses | `POST /v1/responses`, `POST /v1/responses/compact`, WebSocket `GET /v1/responses` |
| OpenAI Embeddings | `POST /v1/embeddings` |
| OpenAI Images | `POST /v1/images/generations`, `POST /v1/images/edits` |
| OpenAI Audio Transcriptions | `POST /v1/audio/transcriptions` |
| OpenAI Models | `GET /v1/models`, `GET /models` |
| Anthropic Messages | `POST /v1/messages`, `POST /v1/messages/count_tokens` |
| Google Gemini | `GET /v1beta/models`, `GET /v1beta/models/{model}`, `POST /v1beta/models/{model}:generateContent`, `POST /v1beta/models/{model}:streamGenerateContent`, `POST /v1beta/models/{model}:countTokens` |
| Cohere Rerank v1 | `POST /v1/rerank` |
| Cohere Rerank v2 | `POST /v2/rerank` |
| Jina Rerank | `POST /jina/v1/rerank` |
| Voyage Rerank | `POST /voyage/v1/rerank` |

`/v1/models` and `/models` return Floway's public model superset to ordinary
callers and select the Codex or Claude Code discovery shape for those clients'
User-Agent.

Rerank models are manual Custom models. Each model selects its outbound Cohere,
Jina, Voyage, DashScope-compatible, or DashScope-native protocol and may
override that protocol's canonical path; there is no upstream-wide rerank path.

Audio transcription is a buffered multipart passthrough for Custom, Azure, and
Ollama-compatible upstreams. JSON, text, subtitle, and transcription SSE
responses retain their upstream wire shape.

### Upstreams

| Provider | Connection | Model catalog |
| --- | --- | --- |
| GitHub Copilot | GitHub device OAuth on `github.com` or a `*.ghe.com` tenant | Fetched live from Copilot |
| Codex | ChatGPT subscription through the Codex CLI OAuth client | Live inference catalog plus the account's built-in GPT Image capability |
| Claude Code | Claude.ai Pro, Max, Team, or Enterprise subscription through the Claude Code CLI OAuth client | Fetched live from Anthropic |
| Custom | Configurable multi-protocol HTTP endpoint, credential, and per-header ingress passthrough/overwrite rules | Live `/models` (OpenAI, Anthropic, or superset shapes), manual models, or both |
| Azure | Azure AI resource or Foundry project endpoint and API key | Configured models |
| Ollama | ollama.com or a self-hosted Ollama-compatible server | Fetched live from Ollama, with optional manual overrides |

Copilot model prices come automatically from its authenticated model catalog,
including newly published models, explicit free rates, context bands, and
accelerated variants. Floway converts GitHub's AI credits to USD at
[one credit = $0.01](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing);
these are Copilot's published rates, not notional model-vendor API prices.
Model reads use the stored catalog while execution cells refresh stale or
missing catalogs in the background. Automatic refreshes become due after ten
minutes, and failed refreshes retain the last published catalog with visible
error metadata and retry backoff. Refresh the saved upstream's models in the
dashboard to update immediately. No
per-model code edit or deployment is needed for new catalog prices.
Absent rates remain unpriced rather than becoming zero or borrowing another
model's price. Recorded usage keeps its original unit-price snapshot;
historical backfills are explicit and require a current cached Copilot catalog.

### Smart subscription account pools

Under **Providers → Account Pools**, group independently authorized **Codex**
or **Claude Code** upstreams of the same provider. Each upstream represents one
distinct account and can belong to one pool only. Existing API-key/user
upstream permissions still apply; a pool never grants access to another member.
Keep member model IDs addressable in the same way, or use existing model aliases
to expose the desired compatible targets.

New pools default to **50 concurrent model requests per account**, configurable
to another positive integer or **Unlimited**. This counts active requests, not
idle sessions. Unlimited disables only Floway's local limit; it does not bypass
provider quotas, authorization, or server capacity. Use only accounts and
subscription access permitted by the upstream provider.

Enabled pools skip inactive credentials and fresh, provider-confirmed account
restrictions, then select compatible accounts atomically by current load,
observed quota utilization, and selection history. Quota observations older
than five minutes are unknown rather than permanently blocking an account.
Codex active-limit families are not model identities: their utilization guides
ranking, while a real 429 establishes a cooldown for the requested model, operation, and alias rules. Upstream `Retry-After` is honored; without it, 429 uses a 30-second
gateway cooldown, 401/403 uses 60 seconds, and upstream 5xx uses five seconds.
These are local retry policies, not estimates of vendor quota recovery.

Caller-carried affinity takes priority over load balancing. A pinned or opaque
stateful conversation may have only one compatible account, and cannot be
moved just because another member is idle. Once streaming opens, Floway never
replays that request on another account. Active request leases are renewed
until completion or cancellation; crashed owners expire after two minutes.
If every compatible visible account is busy or restricted, requests receive
an explicit 429 without queuing, with a known retry time when available.
Credential-only unavailability returns 503. When actual attempts all fail,
the last upstream response remains unchanged.

Stable Claude Code and Codex session/thread identities now create durable,
API-key-isolated conversation bindings. Existing sessions stay on their actual
account, including across idle periods and gateway restarts. New sessions favor
accounts with fewer recently active bindings before request load, fresh quota
and selection history. A busy owner produces an explicit error instead of
temporarily borrowing another account. Clients without stable identity retain
request-level scheduling; Floway never guesses a session from prompt text.
Generic clients can supply `x-floway-conversation-id`, optionally
`x-floway-conversation-branch` for independent branches and `x-floway-turn-id`
for duplicate-turn protection. These are not the dashboard authentication
header `x-floway-session`. Codex per-turn body metadata outranks frozen
WebSocket handshake headers.
An explicit Floway turn ID identifies one model request. Native agent turn IDs
can span several tool continuations, so those are deduplicated together with
their exact request fingerprint rather than blocking a legitimate next tool
step.

Migration is fidelity-first and only happens after definite account
unavailability, or an explicitly requested safe handoff. The new request must
contain the entire completed history, matching directives, tool definitions,
model/rules and generation settings, complete tool-call/result pairs, and
replayable attachment bytes. Floway stores a keyed context proof, not another
copy of message bodies, and does not append history to an already complete
request. Native opaque compaction, signed thinking, account-owned files,
missing history and incompatible models prevent migration and preserve the
original binding. An existing gateway-readable checkpoint can be replayed
unchanged; Floway does not generate a new summary to make a migration pass.

Dispatch and completion are durable, versioned boundaries. Prepared requests
whose owners disappear can recover without pretending they ran; dispatched
requests with unknown execution results become **uncertain** and are never
automatically repeated. A trustworthy terminal result commits the new binding
before it reaches the caller. Provider-owned account/device metadata is rebuilt
for the destination instead of copying the source account's authenticated
package. Readonly token measurements do not create, advance or migrate
bindings. If a real upstream rejection prevents a safe handoff, its status,
headers and body are retained and `x-floway-conversation-error` explains the
additional routing constraint.

Native image requests and gateway-hosted image generation use the same pool
capacity controls. Operator-pinned OpenAI search continuations remain on their
configured account while obeying its concurrency and cooldown state. Catalog
refreshes, OAuth refreshes, and quota probes are not inference requests and do
not consume pool slots.

The dashboard shows active requests, credential health, quota observation
freshness, and model cooldowns. **Clear gateway cooldowns** does not replenish
upstream quotas. Disable a pool to restore normal ordering for unbound requests; existing
conversation bindings remain sticky. Pause an account's **Accept new sessions**
switch to drain incoming sessions without moving its existing conversations.
Use **View conversations → Check / details** to inspect durable phase, blocked
reason, pending destination and committed migration history. **Request safe
handoff next turn** only records intent; it cannot bypass the next request's
full-context checks. Closing an uncertain branch additionally requires explicit
confirmation that the upstream stopped, creates no replay, and leaves the old
identifier unusable. Removing
members requires their active requests to finish; deleting a pool also
requires its conversations to be closed.
Version 22 backups include pool configuration, intake flags, context proofs and
turn/migration journals, but never reusable lease or request-owner tokens.
Restore quarantines every non-closed imported binding as **uncertain**: a
historical snapshot cannot prove whether later requests executed. Merge imports
preserve existing bindings instead of overwriting their newer history. Replace
imports require incoming model traffic to be stopped and requests drained;
active or uncertain execution ownership cannot be deleted. They cannot discard open bindings missing from
the backup. Versions 20 and 21 remain supported for older configuration exports.
These JSON backups do not contain client message histories or native opaque
context; restoring them does not manufacture either.

## Other Deployment Options

### Cloudflare Workers

Requires Node.js 22.5+, pnpm 10.x, and a Cloudflare account.

```bash
pnpm install
pnpm wrangler login
cp wrangler.example.jsonc wrangler.jsonc

# Follow the comments in wrangler.jsonc to create the required resources and
# replace every <YOUR_*> placeholder.
pnpm run db:migrate
pnpm run dev
```

The local dashboard runs at <http://localhost:5174>. For an agent-assisted
production deployment, invoke `$deploy-to-cloudflare`. It uses the established
update and rollback flow by default. A deployment named as new first runs an
isolated binding-probe bootstrap and requires its `Hello World` response before
publishing Floway.

For a manual production update, configure the admin secret, apply the remote
migrations, and deploy:

```bash
pnpm wrangler secret put ADMIN_KEY
pnpm run db:migrate:remote
pnpm run deploy
```

### Node.js

The Node.js target applies SQLite migrations automatically and defaults to
`./data/floway.db`, `./data/files`, and port `8788`:

```bash
pnpm install
ADMIN_KEY='replace-with-a-secret' pnpm run dev:node
```

The Node.js start command builds and serves the dashboard alongside the
data-plane and control-plane APIs. Prebuilt production deployments can use
`pnpm --filter @floway-dev/platform-node run start:built` after building the web
assets.
Production Node.js deployments must set both `NODE_ENV=production` and a
non-empty `ADMIN_KEY`.

Context compaction defaults to the gateway summarization shim for every
provider. Upstream and manual-model flag overrides remain authoritative;
operators can disable `openai-responses-compact-shim` on a Responses target to
use native compaction instead. This does not increase the model's context
window.

## Development

```bash
pnpm install
pnpm run dev:node
pnpm run verify
```

## License

MIT
