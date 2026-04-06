#!/usr/bin/env node

/**
 * PageTailor agent — powered by the Claude Agent SDK.
 *
 * Runs inside a Vercel Sandbox microVM or standalone. All inputs arrive
 * as environment variables. Results are posted back to RESULT_URL.
 *
 * The agent uses Claude's agentic loop with WebSearch and WebFetch tools
 * for research, and structured JSON output for both pipelines.
 *
 * Anthropic access:
 *   - Set ANTHROPIC_API_KEY (the SDK reads it automatically)
 *   - For proxied mode (hosted PageTailor), set ANTHROPIC_BASE_URL
 *
 * See README.md for the full environment variable reference.
 */

import process from "node:process";
import { readFileSync } from "node:fs";
import { query } from "@anthropic-ai/claude-agent-sdk";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const {
  RUN_ID,
  WORKSPACE_ID,
  COMPANY_ID,
  COMPANY_NAME,
  COMPANY_DOMAIN,
  ARTIFACT_TYPE,
  RESULT_URL,
  RESULT_API_KEY,
  ANTHROPIC_API_KEY,
  ANTHROPIC_BASE_URL,
  ANTHROPIC_MODEL,
  EXA_API_KEY,
  INSTRUCTIONS,
  GOAL,
  RUN_KIND,
  SELLER_PROFILE,
  CONTRACT_FIELDS,
  RESEARCH_CONTEXT,
  COMPANY_NOTES,
  COMPANY_CONTEXT,
  SELLER_PROFILE_FILE,
  RESEARCH_CONTEXT_FILE,
  CONTRACT_FIELDS_FILE,
  AGENT_MAX_TURNS,
  AGENT_EFFORT,
} = process.env;

const MODEL = ANTHROPIC_MODEL || "claude-sonnet-4-20250514";
const MAX_TURNS = Number.parseInt(AGENT_MAX_TURNS ?? "18", 10) || 18;
const EFFORT = AGENT_EFFORT || "medium";

function readJsonFile(path) {
  try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return null; }
}

if (!RUN_ID || !WORKSPACE_ID || !COMPANY_ID || !COMPANY_NAME || !RESULT_URL || !RESULT_API_KEY) {
  console.error("Missing required env vars: RUN_ID, WORKSPACE_ID, COMPANY_ID, COMPANY_NAME, RESULT_URL, RESULT_API_KEY");
  process.exit(1);
}

if (!ANTHROPIC_API_KEY && !ANTHROPIC_BASE_URL) {
  console.error("Set either ANTHROPIC_API_KEY (direct) or ANTHROPIC_BASE_URL (proxied).");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Callback
// ---------------------------------------------------------------------------

async function postCallback(body) {
  const response = await fetch(RESULT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${RESULT_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Callback failed (${response.status}): ${text}`);
  }
}

// ---------------------------------------------------------------------------
// Exa pre-research (optional, cheaper than agentic web search)
// ---------------------------------------------------------------------------

async function buildExaResearchPacket(companyName, domain) {
  if (!EXA_API_KEY) return null;

  const queries = [
    `${companyName} company overview product positioning`,
    domain ? `${companyName} documentation help center` : null,
  ].filter(Boolean);

  const items = [];
  const seenUrls = new Set();

  for (const q of queries) {
    try {
      const res = await fetch("https://api.exa.ai/search", {
        method: "POST",
        headers: { "x-api-key": EXA_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          query: q,
          type: "auto",
          numResults: 6,
          contents: { text: { maxCharacters: 1800 } },
        }),
      });
      if (!res.ok) continue;
      const data = await res.json();
      for (const r of data.results ?? []) {
        if (!r.url || seenUrls.has(r.url)) continue;
        seenUrls.add(r.url);
        items.push({ title: r.title ?? "Untitled", url: r.url, snippet: (r.text ?? "").slice(0, 800) });
        if (items.length >= 10) break;
      }
    } catch { /* swallow individual search failures */ }
    if (items.length >= 10) break;
  }

  if (items.length === 0) return null;

  const lines = [
    `Research packet for ${companyName}${domain ? ` (${domain})` : ""}`,
    "Use these verified sources as the primary evidence base.",
  ];
  for (const [i, item] of items.entries()) {
    lines.push(`${i + 1}. ${item.title}\n   URL: ${item.url}\n   Notes: ${item.snippet}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// JSON schemas for structured output
// ---------------------------------------------------------------------------

const RESEARCH_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "2-4 paragraph company research dossier" },
    keyFacts: { type: "array", items: { type: "string" }, description: "Key facts about the company" },
    painPoints: { type: "array", items: { type: "string" }, description: "Likely pain points and challenges" },
    techStack: { type: "array", items: { type: "string" }, description: "Known or inferred technology stack" },
  },
  required: ["summary", "keyFacts", "painPoints", "techStack"],
  additionalProperties: false,
};

const GENERATION_SCHEMA = {
  type: "object",
  additionalProperties: { type: "string" },
  description: "Landing page content fields, all string values",
};

// ---------------------------------------------------------------------------
// Research pipeline (agentic)
// ---------------------------------------------------------------------------

async function runResearch() {
  const goal = GOAL ?? "General company research";
  const notes = COMPANY_NOTES ?? "";
  const context = COMPANY_CONTEXT ? JSON.parse(COMPANY_CONTEXT) : {};

  console.log(`[agent] researching ${COMPANY_NAME} (${COMPANY_DOMAIN})`);

  const exaPacket = await buildExaResearchPacket(COMPANY_NAME, COMPANY_DOMAIN);
  if (exaPacket) {
    console.log("[agent] exa pre-research packet built");
  }

  const promptParts = [
    `You are a B2B company research analyst. Produce a concise, factual research dossier about ${COMPANY_NAME} (${COMPANY_DOMAIN}).`,
    `\nResearch goal: ${goal}`,
  ];

  if (notes) promptParts.push(`\nAccount notes: ${notes}`);
  if (Object.keys(context).length > 0) promptParts.push(`\nAccount context: ${JSON.stringify(context)}`);

  if (exaPacket) {
    promptParts.push(`\nPre-gathered web sources (use as primary evidence, but you may search for more if needed):\n${exaPacket}`);
  } else {
    promptParts.push("\nNo pre-gathered sources. Use WebSearch and WebFetch to find information about this company from their website, docs, help center, and other public sources. Be thorough — check multiple pages.");
  }

  promptParts.push("\nProduce a structured dossier with: summary (2-4 paragraphs), keyFacts, painPoints, and techStack. Cite specific facts from real sources.");

  const useTools = !exaPacket;
  const queryOptions = {
    model: MODEL,
    maxTurns: MAX_TURNS,
    effort: EFFORT,
    persistSession: false,
    outputFormat: {
      type: "json_schema",
      schema: RESEARCH_SCHEMA,
    },
  };

  if (useTools) {
    queryOptions.tools = ["WebSearch", "WebFetch"];
    queryOptions.allowedTools = ["WebSearch", "WebFetch"];
  } else {
    queryOptions.tools = [];
    queryOptions.allowedTools = [];
  }

  let result = null;

  for await (const message of query({
    prompt: promptParts.join("\n"),
    options: queryOptions,
  })) {
    if (message.type === "assistant") {
      const toolUses = message.message?.content?.filter((b) => b.type === "tool_use") ?? [];
      for (const tu of toolUses) {
        console.log(`  [tool] ${tu.name}`);
      }
    }

    if (message.type === "result") {
      if (message.subtype === "success" && message.structured_output) {
        result = message.structured_output;
        console.log(`[agent] research complete (cost: $${(message.total_cost_usd ?? 0).toFixed(4)})`);
      } else if (message.subtype === "success" && message.result) {
        try {
          result = JSON.parse(message.result.replace(/```(?:json)?\s*([\s\S]*?)\s*```/, "$1"));
        } catch { /* fallback below */ }
      }
    }
  }

  if (!result || typeof result.summary !== "string") {
    throw new Error("Agent did not produce valid research output");
  }

  return {
    kind: "research_refresh",
    summary: result.summary,
    payload: result,
  };
}

// ---------------------------------------------------------------------------
// Artifact generation pipeline (structured output, no tools needed)
// ---------------------------------------------------------------------------

async function runGeneration() {
  const seller = SELLER_PROFILE ? JSON.parse(SELLER_PROFILE)
    : SELLER_PROFILE_FILE ? readJsonFile(SELLER_PROFILE_FILE) : null;
  const fields = CONTRACT_FIELDS ? JSON.parse(CONTRACT_FIELDS)
    : CONTRACT_FIELDS_FILE ? readJsonFile(CONTRACT_FIELDS_FILE) ?? [] : [];
  const research = RESEARCH_CONTEXT ? JSON.parse(RESEARCH_CONTEXT)
    : RESEARCH_CONTEXT_FILE ? readJsonFile(RESEARCH_CONTEXT_FILE) : null;
  const notes = COMPANY_NOTES ?? "";
  const context = COMPANY_CONTEXT ? JSON.parse(COMPANY_CONTEXT) : {};

  if (!seller) throw new Error("SELLER_PROFILE is required for generation");

  const fieldSpec = fields.length > 0
    ? fields.map((f) => `- "${f.key}" (${f.fieldType}${f.maxLength ? `, max ${f.maxLength} chars` : ""}): ${f.llmDescription}. Examples: ${f.examples.join("; ")}`).join("\n")
    : '- "hero_title" (string): A personalized headline\n- "hero_subtitle" (string): Supporting copy';

  const fieldSchema = { type: "object", properties: {}, required: [], additionalProperties: false };
  for (const f of fields) {
    fieldSchema.properties[f.key] = { type: "string" };
    fieldSchema.required.push(f.key);
  }
  if (fields.length === 0) {
    fieldSchema.properties = { hero_title: { type: "string" }, hero_subtitle: { type: "string" } };
    fieldSchema.required = ["hero_title", "hero_subtitle"];
  }

  const prompt = [
    "You are a B2B landing page copywriter. Generate personalized landing page content for a specific prospect company.",
    "",
    `SELLER: ${seller.companyName} — ${seller.productSummary}`,
    `Differentiators: ${seller.differentiators.join(", ")}`,
    `Strongest use cases: ${seller.strongestUseCases.join(", ")}`,
    `ICP: ${seller.idealCustomerProfile}`,
    "",
    `PROSPECT: ${COMPANY_NAME} (${COMPANY_DOMAIN})`,
    notes ? `Notes: ${notes}` : null,
    Object.keys(context).length > 0 ? `Context: ${JSON.stringify(context)}` : null,
    "",
    `RESEARCH:\n${research?.summary ?? "(no research available — use general knowledge)"}`,
    "",
    `INSTRUCTIONS:\n${INSTRUCTIONS ?? "Generate compelling, specific copy that references the prospect by name and connects the seller's value to the prospect's situation."}`,
    "",
    `Generate content for these fields (every value must be a string):\n${fieldSpec}`,
  ].filter(Boolean).join("\n");

  console.log("[agent] generating artifact...");

  let content = null;

  for await (const message of query({
    prompt,
    options: {
      model: MODEL,
      maxTurns: 1,
      effort: EFFORT,
      persistSession: false,
      tools: [],
      allowedTools: [],
      outputFormat: {
        type: "json_schema",
        schema: fieldSchema,
      },
    },
  })) {
    if (message.type === "result") {
      if (message.subtype === "success" && message.structured_output) {
        content = message.structured_output;
        console.log(`[agent] generation complete (cost: $${(message.total_cost_usd ?? 0).toFixed(4)})`);
      } else if (message.subtype === "success" && message.result) {
        try {
          content = JSON.parse(message.result.replace(/```(?:json)?\s*([\s\S]*?)\s*```/, "$1"));
        } catch { /* fallback below */ }
      }
    }
  }

  if (!content) {
    throw new Error("Agent did not produce valid generation output");
  }

  return {
    kind: "artifact_generation",
    artifactType: ARTIFACT_TYPE ?? "landing_page",
    content,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const kind = RUN_KIND ?? (GOAL ? "research_refresh" : "artifact_generation");
  console.log(`[agent] starting ${kind} for run ${RUN_ID} (model: ${MODEL})`);

  await postCallback({ status: "running" });

  let result;
  if (kind === "research_refresh") {
    result = await runResearch();
  } else {
    result = await runGeneration();
  }

  console.log("[agent] posting completed result");
  await postCallback({ status: "completed", result });
  console.log("[agent] done");
}

process.on("SIGTERM", () => {
  console.error("[agent] received SIGTERM");
  postCallback({ status: "failed", error: "SIGTERM received — sandbox was terminated externally" })
    .catch(() => {})
    .finally(() => process.exit(143));
});

main().catch(async (error) => {
  const msg = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error("[agent] fatal:", msg);
  try {
    await postCallback({ status: "failed", error: msg });
  } catch {}
  process.exit(1);
});
