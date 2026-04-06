#!/usr/bin/env node

/**
 * PageTailor sandbox agent.
 *
 * Runs inside a Vercel Sandbox microVM or standalone with a direct
 * Anthropic API key. All inputs arrive as environment variables.
 * Results are posted back to RESULT_URL.
 *
 * Anthropic access modes:
 *   - Proxied (hosted PageTailor): set ANTHROPIC_BASE_URL + RESULT_API_KEY
 *   - Direct (standalone): set ANTHROPIC_API_KEY
 *
 * See README.md for the full environment variable reference.
 */

import process from "node:process";

import { readFileSync } from "node:fs";

const {
  RUN_ID,
  WORKSPACE_ID,
  COMPANY_ID,
  COMPANY_NAME,
  COMPANY_DOMAIN,
  ARTIFACT_TYPE,
  RESULT_URL,
  RESULT_API_KEY,
  ANTHROPIC_BASE_URL,
  ANTHROPIC_API_KEY,
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
} = process.env;

const DIRECT_MODE = !ANTHROPIC_BASE_URL && !!ANTHROPIC_API_KEY;
const MODEL = ANTHROPIC_MODEL || "claude-sonnet-4-20250514";

function readJsonFile(path) {
  try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return null; }
}

if (!RUN_ID || !WORKSPACE_ID || !COMPANY_ID || !COMPANY_NAME || !RESULT_URL || !RESULT_API_KEY) {
  console.error("Missing required env vars: RUN_ID, WORKSPACE_ID, COMPANY_ID, COMPANY_NAME, RESULT_URL, RESULT_API_KEY");
  process.exit(1);
}

if (!ANTHROPIC_BASE_URL && !ANTHROPIC_API_KEY) {
  console.error("Set either ANTHROPIC_API_KEY (direct) or ANTHROPIC_BASE_URL (proxied).");
  process.exit(1);
}

function getAnthropicUrl() {
  const base = ANTHROPIC_BASE_URL || "https://api.anthropic.com";
  return new URL("v1/messages", `${base}/`).toString();
}

function getAnthropicHeaders() {
  if (DIRECT_MODE) {
    return {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    };
  }

  return {
    "Authorization": `Bearer ${RESULT_API_KEY}`,
    "anthropic-version": "2023-06-01",
    "Content-Type": "application/json",
  };
}

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
// Exa search
// ---------------------------------------------------------------------------

async function searchExa(query, numResults = 8) {
  if (!EXA_API_KEY) return [];
  try {
    const res = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: { "x-api-key": EXA_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        numResults,
        type: "auto",
        contents: { text: { maxCharacters: 2000 } },
      }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.results ?? [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Anthropic (via proxy)
// ---------------------------------------------------------------------------

async function callAnthropic(system, userMessage, maxTokens = 2048) {
  const url = getAnthropicUrl();

  console.log(`[agent] calling anthropic at ${url} (model: ${MODEL})`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: getAnthropicHeaders(),
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        system,
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
    const textBlock = data.content?.find((b) => b.type === "text");
    return textBlock?.text ?? "";
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Research pipeline
// ---------------------------------------------------------------------------

async function runResearch() {
  const goal = GOAL ?? "General company research";
  const notes = COMPANY_NOTES ?? "";
  const context = COMPANY_CONTEXT ? JSON.parse(COMPANY_CONTEXT) : {};

  console.log(`[agent] researching ${COMPANY_NAME} (${COMPANY_DOMAIN})`);
  const exaResults = await searchExa(`${COMPANY_NAME} ${COMPANY_DOMAIN} ${goal}`, 8);
  console.log(`[agent] exa returned ${exaResults.length} results`);

  const sourceSummaries = exaResults
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${(r.text ?? "").slice(0, 800)}`)
    .join("\n\n");

  const system = `You are a B2B company research analyst. Produce a concise, factual research dossier. Return ONLY valid JSON with keys: "summary" (string, 2-4 paragraphs), "keyFacts" (array of strings), "painPoints" (array of strings), "techStack" (array of strings, best guess). Do not include markdown fences.`;

  const prompt = `Research goal: ${goal}\n\nCompany: ${COMPANY_NAME} (${COMPANY_DOMAIN})\nNotes: ${notes}\nContext: ${JSON.stringify(context)}\n\nWeb sources:\n${sourceSummaries || "(no web sources found — use your general knowledge)"}`;

  console.log("[agent] calling anthropic for research synthesis...");
  const llmOutput = await callAnthropic(system, prompt);

  let parsed;
  try {
    parsed = JSON.parse(llmOutput);
  } catch {
    parsed = { summary: llmOutput, keyFacts: [], painPoints: [], techStack: [] };
  }

  return {
    kind: "research_refresh",
    summary: parsed.summary ?? llmOutput.slice(0, 1000),
    payload: parsed,
  };
}

// ---------------------------------------------------------------------------
// Artifact generation pipeline
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

  if (!seller) throw new Error("SELLER_PROFILE env var is required for generation");

  const fieldSpec = fields.length > 0
    ? fields.map((f) => `- "${f.key}" (${f.fieldType}${f.maxLength ? `, max ${f.maxLength} chars` : ""}): ${f.llmDescription}. Examples: ${f.examples.join("; ")}`).join("\n")
    : '- "hero_title" (string): A personalized headline\n- "hero_subtitle" (string): Supporting copy';

  const system = `You are a B2B landing page copywriter. Generate personalized landing page content for a specific prospect company. Return ONLY valid JSON with the requested field keys. No markdown fences. Every value must be a string.`;

  const prompt = `SELLER:\n${seller.companyName} — ${seller.productSummary}\nDifferentiators: ${seller.differentiators.join(", ")}\nStrongest use cases: ${seller.strongestUseCases.join(", ")}\nICP: ${seller.idealCustomerProfile}\n\nPROSPECT:\n${COMPANY_NAME} (${COMPANY_DOMAIN})\nNotes: ${notes}\nContext: ${JSON.stringify(context)}\n\nRESEARCH:\n${research?.summary ?? "(no research available — use general knowledge)"}\n\nINSTRUCTIONS:\n${INSTRUCTIONS ?? "Generate compelling, specific copy that references the prospect by name and connects the seller's value to the prospect's situation."}\n\nGENERATE JSON with these fields:\n${fieldSpec}`;

  console.log("[agent] calling anthropic for artifact generation...");
  const llmOutput = await callAnthropic(system, prompt);

  let content;
  try {
    content = JSON.parse(llmOutput);
  } catch {
    content = { hero_title: llmOutput.slice(0, 120), hero_subtitle: llmOutput.slice(0, 240) };
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
  console.log(`[agent] starting ${kind} for run ${RUN_ID}`);

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
