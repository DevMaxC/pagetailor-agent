# PageTailor Agent

A standalone Node.js agent that researches a company and generates personalized B2B landing page content using Claude and Exa.

> **Just want personalized pages without any setup?**
> [PageTailor Hosted](https://pagetailor.dev) gets you running in 10 minutes with zero infrastructure. Sign up via your AI agent and start generating immediately.

---

## What it does

This agent takes a target company, researches it using web sources, and produces structured landing page content tailored to that company. It's built on the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) and runs two pipelines:

1. **Research** -- uses Claude's agentic loop with `WebSearch` and `WebFetch` tools to autonomously find and read company pages, docs, and help centers, then synthesizes a structured dossier. Optionally pre-seeds with [Exa](https://exa.ai) results for faster, cheaper research.
2. **Generation** -- takes seller context, research, and a field contract, then generates personalized copy using Claude's structured JSON output. No tools needed -- pure generation.

All inputs arrive as environment variables. Results are posted to a callback URL as structured JSON validated by JSON Schema.

## Requirements

- Node.js 22+
- An [Anthropic API key](https://console.anthropic.com/) for Claude access
- Optionally, an [Exa API key](https://exa.ai) for pre-seeded research (without it, the agent uses `WebSearch`/`WebFetch` tools exclusively)

## Quickstart

```bash
npm install

# Research a company
RUN_ID="run_001" \
WORKSPACE_ID="ws_local" \
COMPANY_ID="co_stripe" \
COMPANY_NAME="Stripe" \
COMPANY_DOMAIN="stripe.com" \
RUN_KIND="research_refresh" \
GOAL="Understand their developer tools strategy" \
ANTHROPIC_API_KEY="sk-ant-..." \
RESULT_URL="https://your-server.com/callback" \
RESULT_API_KEY="your-callback-secret" \
node agent.mjs
```

The agent will:
1. POST `{ "status": "running" }` to your callback URL
2. Use Claude's agentic loop to search the web, read company pages, and gather evidence
3. Synthesize a structured research dossier using JSON Schema output
4. POST `{ "status": "completed", "result": { ... } }` to your callback URL

## Environment variables

### Required

| Variable | Description |
|---|---|
| `RUN_ID` | Unique identifier for this execution |
| `WORKSPACE_ID` | Workspace this run belongs to |
| `COMPANY_ID` | Target company identifier |
| `COMPANY_NAME` | Target company display name |
| `RESULT_URL` | URL to POST status and results to |
| `RESULT_API_KEY` | Bearer token for authenticating callback requests |

### Anthropic configuration

Set **one** of these:

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key (read automatically by the Claude Agent SDK) |
| `ANTHROPIC_BASE_URL` | Base URL override for a proxied Anthropic endpoint (hosted mode) |

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_MODEL` | `claude-sonnet-4-20250514` | Model to use for all LLM calls |
| `AGENT_MAX_TURNS` | `18` | Maximum agentic turns (tool-use round trips) for research |
| `AGENT_EFFORT` | `medium` | Agent effort level: `low`, `medium`, `high`, or `max` |

### Run configuration

| Variable | Default | Description |
|---|---|---|
| `RUN_KIND` | Inferred from `GOAL` | `research_refresh` or `artifact_generation` |
| `GOAL` | `General company research` | Research goal (research runs only) |
| `ARTIFACT_TYPE` | `landing_page` | Type of artifact to generate |
| `INSTRUCTIONS` | _(default prompt)_ | Custom generation instructions |
| `COMPANY_DOMAIN` | | Target company's primary domain |
| `COMPANY_NOTES` | | Freeform notes about the target account |
| `COMPANY_CONTEXT` | `{}` | JSON object with structured context (`audience`, `goal`, `championTeam`, etc.) |

### Optional context (generation runs)

These provide richer input for artifact generation. Each accepts either inline JSON or a file path.

| Variable | Description |
|---|---|
| `SELLER_PROFILE` | JSON string with seller company info (required for generation) |
| `SELLER_PROFILE_FILE` | Path to a JSON file with seller info (alternative to inline) |
| `RESEARCH_CONTEXT` | JSON string with prior research results |
| `RESEARCH_CONTEXT_FILE` | Path to a JSON file with prior research |
| `CONTRACT_FIELDS` | JSON string with field definitions |
| `CONTRACT_FIELDS_FILE` | Path to a JSON file with field definitions |
| `EXA_API_KEY` | Exa API key for web research (optional, falls back to general knowledge) |

## Callback contract

The agent communicates progress and results by POSTing JSON to `RESULT_URL` with an `Authorization: Bearer <RESULT_API_KEY>` header.

### Running

Sent immediately when the agent starts work.

```json
{ "status": "running" }
```

### Completed (research)

```json
{
  "status": "completed",
  "result": {
    "kind": "research_refresh",
    "summary": "Stripe is a financial infrastructure platform...",
    "payload": {
      "summary": "Stripe is a financial infrastructure platform...",
      "keyFacts": ["Founded in 2010", "Processes billions in payments"],
      "painPoints": ["Complex compliance requirements"],
      "techStack": ["Ruby", "Go", "React"]
    }
  }
}
```

### Completed (artifact generation)

```json
{
  "status": "completed",
  "result": {
    "kind": "artifact_generation",
    "artifactType": "landing_page",
    "content": {
      "hero_title": "The compliance platform built for Stripe's scale",
      "hero_subtitle": "Turn payment complexity into a competitive advantage"
    }
  }
}
```

### Failed

```json
{
  "status": "failed",
  "error": "Anthropic error (429): rate limit exceeded"
}
```

## How it works

```
                     ┌──────────────────┐
                     │   Environment    │
                     │    Variables     │
                     └────────┬─────────┘
                              │
                    ┌─────────▼──────────┐
                    │   Run kind?        │
                    └──┬──────────────┬──┘
                       │              │
              research_refresh   artifact_generation
                       │              │
                ┌──────▼──────┐ ┌─────▼───────┐
                │  Exa Search │ │ Load seller  │
                │  (optional) │ │ + research   │
                └──────┬──────┘ │ + fields     │
                       │        └─────┬───────┘
                ┌──────▼──────┐ ┌─────▼───────┐
                │   Claude    │ │   Claude     │
                │  Synthesize │ │  Generate    │
                └──────┬──────┘ └─────┬───────┘
                       │              │
                       └──────┬───────┘
                              │
                    ┌─────────▼──────────┐
                    │  POST to RESULT_URL│
                    │  { status, result }│
                    └────────────────────┘
```

**Research pipeline**: optionally pre-seeds with Exa results, then uses the Claude Agent SDK's agentic loop with `WebSearch` and `WebFetch` tools. Claude autonomously decides what to search, which pages to read, and when it has enough evidence. Output is validated against a JSON Schema for structured, reliable results.

**Generation pipeline**: loads seller profile, prior research, and field contract definitions. Uses the Claude Agent SDK with structured JSON output (no tools) to produce personalized copy matching the exact field contract.

Both pipelines post their results to `RESULT_URL` using the callback contract described above. Cost tracking is available via the SDK's `total_cost_usd` field on result messages.

## Using with PageTailor hosted

This agent is the same runner that powers [PageTailor's hosted API](https://pagetailor.dev). The hosted version manages everything automatically:

- Workspace provisioning and API key management
- Seller profile, page contracts, and field definitions
- Research snapshot storage and artifact versioning
- Vercel Sandbox isolation and Anthropic proxy
- Rate limiting and cost controls

If you want personalized landing pages without managing infrastructure, the hosted API is the fastest path. Hand your AI agent the install URL and it handles the rest.

## License

MIT
