# Floway

Floway is a self-hosted LLM API gateway for coding agents and API clients. It
puts subscription-backed and token-backed model providers behind one gateway,
then routes each model through the API shape the client already speaks.

## Highlights

- Use GitHub Copilot, ChatGPT subscriptions, Claude.ai subscriptions, Azure AI,
  configurable multi-protocol HTTP providers, and Ollama from one deployment.
- Serve OpenAI, Anthropic, Gemini-compatible, audio transcription, and rerank
  APIs with cross-protocol translation where needed.
- Discover vendor model catalogs live while retaining manual model configuration
  for providers that require or permit it.
- Manage upstreams, routing order, model aliases, API keys, and web search from
  a dashboard.
- Generate one-command Claude Code and Codex configurations from an API key.
- Run on Cloudflare Workers or Node.js, with Docker Compose provided for a
  self-hosted server and dashboard.

## Quick Start

Docker Compose is the shortest path to a complete local deployment:

```bash
git clone https://github.com/Menci/Floway.git
cd Floway
ADMIN_KEY='replace-with-a-secret' docker compose -f docker/docker-compose.yml up --build -d
```

Open <http://localhost:18088>, leave the username blank, and use `ADMIN_KEY` as
the password. Then:

1. Add at least one provider under **Providers → Upstreams**.
2. Create a key under **Services → API Keys**.
3. Give that key to a client as a bearer token or `x-api-key`, or use **Agent
   Setup** to configure Claude Code or Codex.

On Windows, Codex Agent Setup reuses an existing Node.js executable for fast
provider-token reads from the protected `floway-token` file. Without Node.js,
it retains a non-interactive PowerShell helper and reports the slower fallback.
Restart existing Codex clients after changing their provider-auth configuration;
this does not require restarting the Floway gateway.

The data-plane and control-plane APIs are also exposed directly at
<http://localhost:8788>. SQLite, file-backed dump bodies, and oversized
Stateful OpenAI Responses item payloads persist in the `floway-data` volume.

The dashboard uses Floway's control plane to manage users, keys, upstreams,
routing, and telemetry. Coding agents and API clients call the data plane,
which performs model resolution, upstream dispatch, and any required protocol
translation. Both planes are served by the same gateway process.

### Cursor project agents

The project definitions in [.cursor/agents](.cursor/agents) assign models by
responsibility. Configure matching aliases on your Floway instance before
using these agents; the files do not provision aliases or change Cursor's
global model settings.
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
adding its agents. The `manager` subagent does not set the main conversation's
model; [agent-routing.mdc](.cursor/rules/agent-routing.mdc) describes ownership.

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
The existing catalog cache stays fresh for ten minutes, then refreshes in the
background on traffic, and requires a successful fetch after 24 hours. Refresh
the saved upstream's models in the dashboard to update immediately. No
per-model code edit or deployment is needed for new catalog prices.
Absent rates remain unpriced rather than becoming zero or borrowing another
model's price. Recorded usage keeps its original unit-price snapshot;
historical backfills are explicit and require a current cached Copilot catalog.

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

It serves the data-plane and control-plane APIs but not the dashboard. Use
Docker Compose for the complete self-hosted UI, or serve the web app separately.
Production Node.js deployments must set both `NODE_ENV=production` and a
non-empty `ADMIN_KEY`.

Podman users can instead follow the
[systemd deployment guide](./docker/systemd/README.md).

For an existing Azure Linux VM reached over SSH, use the
[Azure VM deployment guide](./docker/azure-vm.md) and its private-port Compose override.

## Development

```bash
pnpm install
pnpm run dev
pnpm run verify
```

`verify` chains every check `.github/workflows/verify.yaml` runs, so a green run
locally is a green run on a pull request. Each link is also a script of its own,
in the order the chain runs them: `typegen`, `lint`, `typecheck`, `test`,
`test:installers`, `check:agents-md`, `check:generated-assets`,
`check:verify-parity`, and `build:web`, which carries the assertions about the
emitted bundle. `typegen` comes first because the generated route types are not
checked in and the lint configuration is type-aware, so a fresh clone has to
produce them before anything else can read the dashboard's sources.

[AGENTS.md](./AGENTS.md) defines the repository-wide agent requirements and
indexes its CI workflows, skills, workspace packages, and their responsibilities.

## License

MIT
