#!/usr/bin/env node

/**
 * PageTailor agent.
 *
 * Runs standalone or inside a Vercel Sandbox microVM. All inputs arrive
 * as environment variables. Results are posted back to RESULT_URL.
 *
 * Two execution modes:
 *   - SDK mode (standalone): uses the Claude Agent SDK with agentic
 *     tool loops, WebSearch/WebFetch, and structured output.
 *     Requires: npm install @anthropic-ai/claude-agent-sdk
 *   - Fetch mode (sandbox): direct HTTP calls to Anthropic's Messages
 *     API. No external dependencies. Used when the SDK is not installed.
 *
 * Anthropic access:
 *   - Set ANTHROPIC_API_KEY for direct access (SDK reads it automatically)
 *   - Set ANTHROPIC_BASE_URL for proxied access (fetch mode only)
 *
 * See README.md for the full environment variable reference.
 */

import process from "node:process";
import { readFileSync } from "node:fs";

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
// Detect SDK availability
// ---------------------------------------------------------------------------

let sdkQuery = null;
try {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  sdkQuery = sdk.query;
  console.log("[agent] Claude Agent SDK detected — using agentic mode");
} catch {
  console.log("[agent] Claude Agent SDK not available — using fetch mode");
}

const USE_SDK = sdkQuery !== null;

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
// Exa pre-research (optional, used by both modes)
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
          query: q, type: "auto", numResults: 6,
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
// Fetch-mode Anthropic calls (sandbox / no SDK)
// ---------------------------------------------------------------------------

function getAnthropicUrl() {
  const base = ANTHROPIC_BASE_URL || "https://api.anthropic.com";
  return new URL("v1/messages", `${base}/`).toString();
}

function getAnthropicHeaders() {
  if (!ANTHROPIC_BASE_URL && ANTHROPIC_API_KEY) {
    return { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" };
  }
  return { "Authorization": `Bearer ${RESULT_API_KEY}`, "anthropic-version": "2023-06-01", "Content-Type": "application/json" };
}

async function callAnthropicFetch(system, userMessage, maxTokens = 4096) {
  const url = getAnthropicUrl();
  console.log(`[agent] calling anthropic at ${url} (model: ${MODEL})`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: getAnthropicHeaders(),
      body: JSON.stringify({
        model: MODEL, max_tokens: maxTokens, system,
        messages: [{ role: "user", content: userMessage }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Anthropic error (${res.status}): ${text}`);
    }
    const data = await res.json();
    console.log(`[agent] anthropic responded, model: ${data.model}`);
    return data.content?.find((b) => b.type === "text")?.text ?? "";
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// JSON schemas for structured output (SDK mode)
// ---------------------------------------------------------------------------

const RESEARCH_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    keyFacts: { type: "array", items: { type: "string" } },
    painPoints: { type: "array", items: { type: "string" } },
    techStack: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "keyFacts", "painPoints", "techStack"],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Research pipeline
// ---------------------------------------------------------------------------

async function runResearchSdk() {
  const goal = GOAL ?? "General company research";
  const notes = COMPANY_NOTES ?? "";
  const context = COMPANY_CONTEXT ? JSON.parse(COMPANY_CONTEXT) : {};

  const exaPacket = await buildExaResearchPacket(COMPANY_NAME, COMPANY_DOMAIN);
  if (exaPacket) console.log("[agent] exa pre-research packet built");

  const promptParts = [
    `You are a B2B company research analyst. Produce a concise, factual research dossier about ${COMPANY_NAME} (${COMPANY_DOMAIN}).`,
    `\nResearch goal: ${goal}`,
  ];
  if (notes) promptParts.push(`\nAccount notes: ${notes}`);
  if (Object.keys(context).length > 0) promptParts.push(`\nAccount context: ${JSON.stringify(context)}`);

  if (exaPacket) {
    promptParts.push(`\nPre-gathered web sources:\n${exaPacket}`);
  } else {
    promptParts.push("\nUse WebSearch and WebFetch to find information about this company. Be thorough.");
  }
  promptParts.push("\nProduce a structured dossier with: summary (2-4 paragraphs), keyFacts, painPoints, and techStack.");

  const useTools = !exaPacket;
  const options = {
    model: MODEL, maxTurns: MAX_TURNS, effort: EFFORT, persistSession: false,
    outputFormat: { type: "json_schema", schema: RESEARCH_SCHEMA },
    tools: useTools ? ["WebSearch", "WebFetch"] : [],
    allowedTools: useTools ? ["WebSearch", "WebFetch"] : [],
  };

  let result = null;
  for await (const message of sdkQuery({ prompt: promptParts.join("\n"), options })) {
    if (message.type === "assistant") {
      for (const b of message.message?.content?.filter((b) => b.type === "tool_use") ?? []) {
        console.log(`  [tool] ${b.name}`);
      }
    }
    if (message.type === "result" && message.subtype === "success") {
      result = message.structured_output ?? null;
      if (!result && message.result) {
        try { result = JSON.parse(message.result.replace(/```(?:json)?\s*([\s\S]*?)\s*```/, "$1")); } catch {}
      }
      console.log(`[agent] research complete (cost: $${(message.total_cost_usd ?? 0).toFixed(4)})`);
    }
  }
  if (!result?.summary) throw new Error("Agent did not produce valid research output");
  return { kind: "research_refresh", summary: result.summary, payload: result };
}

async function runResearchFetch() {
  const goal = GOAL ?? "General company research";
  const notes = COMPANY_NOTES ?? "";
  const context = COMPANY_CONTEXT ? JSON.parse(COMPANY_CONTEXT) : {};

  console.log(`[agent] researching ${COMPANY_NAME} (${COMPANY_DOMAIN})`);
  const exaPacket = await buildExaResearchPacket(COMPANY_NAME, COMPANY_DOMAIN);

  const system = `You are a B2B company research analyst. Produce a concise, factual research dossier. Return ONLY valid JSON with keys: "summary" (string, 2-4 paragraphs), "keyFacts" (array of strings), "painPoints" (array of strings), "techStack" (array of strings, best guess). Do not include markdown fences.`;
  const prompt = `Research goal: ${goal}\n\nCompany: ${COMPANY_NAME} (${COMPANY_DOMAIN})\nNotes: ${notes}\nContext: ${JSON.stringify(context)}\n\nWeb sources:\n${exaPacket || "(no web sources found — use your general knowledge)"}`;

  const llmOutput = await callAnthropicFetch(system, prompt);
  let parsed;
  try { parsed = JSON.parse(llmOutput); } catch { parsed = { summary: llmOutput, keyFacts: [], painPoints: [], techStack: [] }; }

  return { kind: "research_refresh", summary: parsed.summary ?? llmOutput.slice(0, 1000), payload: parsed };
}

// ---------------------------------------------------------------------------
// Generation pipeline
// ---------------------------------------------------------------------------

function loadGenerationContext() {
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
  for (const f of fields) { fieldSchema.properties[f.key] = { type: "string" }; fieldSchema.required.push(f.key); }
  if (fields.length === 0) {
    fieldSchema.properties = { hero_title: { type: "string" }, hero_subtitle: { type: "string" } };
    fieldSchema.required = ["hero_title", "hero_subtitle"];
  }

  const prompt = [
    "You are a B2B landing page copywriter. Generate personalized landing page content for a specific prospect company.",
    "", `SELLER: ${seller.companyName} — ${seller.productSummary}`,
    `Differentiators: ${seller.differentiators.join(", ")}`,
    `Strongest use cases: ${seller.strongestUseCases.join(", ")}`,
    `ICP: ${seller.idealCustomerProfile}`,
    "", `PROSPECT: ${COMPANY_NAME} (${COMPANY_DOMAIN})`,
    notes ? `Notes: ${notes}` : null,
    Object.keys(context).length > 0 ? `Context: ${JSON.stringify(context)}` : null,
    "", `RESEARCH:\n${research?.summary ?? "(no research available — use general knowledge)"}`,
    "", `INSTRUCTIONS:\n${INSTRUCTIONS ?? "Generate compelling, specific copy that references the prospect by name and connects the seller's value to the prospect's situation."}`,
    "", `Generate content for these fields (every value must be a string):\n${fieldSpec}`,
  ].filter(Boolean).join("\n");

  return { prompt, fieldSpec, fieldSchema, seller };
}

async function runGenerationSdk() {
  const { prompt, fieldSchema } = loadGenerationContext();
  console.log("[agent] generating artifact (SDK)...");

  let content = null;
  for await (const message of sdkQuery({
    prompt,
    options: {
      model: MODEL, maxTurns: 1, effort: EFFORT, persistSession: false,
      tools: [], allowedTools: [],
      outputFormat: { type: "json_schema", schema: fieldSchema },
    },
  })) {
    if (message.type === "result" && message.subtype === "success") {
      content = message.structured_output ?? null;
      if (!content && message.result) {
        try { content = JSON.parse(message.result.replace(/```(?:json)?\s*([\s\S]*?)\s*```/, "$1")); } catch {}
      }
      console.log(`[agent] generation complete (cost: $${(message.total_cost_usd ?? 0).toFixed(4)})`);
    }
  }
  if (!content) throw new Error("Agent did not produce valid generation output");
  return { kind: "artifact_generation", artifactType: ARTIFACT_TYPE ?? "landing_page", content };
}

async function runGenerationFetch() {
  const { prompt, fieldSpec } = loadGenerationContext();
  console.log("[agent] generating artifact (fetch)...");

  const system = `You are a B2B landing page copywriter. Generate personalized landing page content for a specific prospect company. Return ONLY valid JSON with the requested field keys. No markdown fences. Every value must be a string.`;
  const llmOutput = await callAnthropicFetch(system, prompt);

  let content;
  try { content = JSON.parse(llmOutput); } catch { content = { hero_title: llmOutput.slice(0, 120), hero_subtitle: llmOutput.slice(0, 240) }; }
  return { kind: "artifact_generation", artifactType: ARTIFACT_TYPE ?? "landing_page", content };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const kind = RUN_KIND ?? (GOAL ? "research_refresh" : "artifact_generation");
  console.log(`[agent] starting ${kind} for run ${RUN_ID} (model: ${MODEL}, mode: ${USE_SDK ? "sdk" : "fetch"})`);

  await postCallback({ status: "running" });

  let result;
  if (kind === "research_refresh") {
    result = USE_SDK ? await runResearchSdk() : await runResearchFetch();
  } else {
    result = USE_SDK ? await runGenerationSdk() : await runGenerationFetch();
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
  try { await postCallback({ status: "failed", error: msg }); } catch {}
  process.exit(1);
});
