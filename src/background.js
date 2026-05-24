// =============================================
// brif - PAGE SUMMARIZER — BACKGROUND SERVICE WORKER
// Provider: Google Gemini 2.5 Flash
// API key is passed in from popup via message payload
// (sourced from config.js which is generated from .env)
// =============================================
"use strict";

// ── Rate limiter: 10 req / 60s ──
const RL = { requests: [], max: 10, windowMs: 60_000 };

function checkRateLimit() {
  const now = Date.now();
  RL.requests = RL.requests.filter(t => now - t < RL.windowMs);
  if (RL.requests.length >= RL.max) return false;
  RL.requests.push(now);
  return true;
}

// ── Message listener ──
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "SUMMARIZE") {
    handleSummarize(message.payload)
      .then(result => sendResponse(result))
      .catch(err   => sendResponse({ error: err.message }));
    return true; // keep channel open for async response
  }
});

// ── Main handler ──
async function handleSummarize(payload) {
  const { content, title, url, geminiKey, mode } = payload;

  if (!geminiKey?.trim())
    throw new Error("Gemini API key is not configured. Run: node scripts/build-config.js");

  if (!content || content.trim().length < 80)
    throw new Error("Page content is too short or empty to summarize.");

  if (!checkRateLimit())
    throw new Error("Too many requests. Please wait a moment before trying again.");

  // Truncate to ~14k chars — well within Gemini's free-tier token limits
  const truncated = content.length > 14_000
    ? content.slice(0, 14_000) + "\n\n[Content truncated — showing first ~14,000 characters]"
    : content;

  const prompt  = buildPrompt(truncated, title, url, mode);
  const rawText = await callGemini(geminiKey, prompt);
  const summary = parseAndSanitize(rawText, content);
  return { summary };
}

// ── Prompt builder ──
function buildPrompt(content, title, url, mode) {
  const modeMap = {
    detailed: "Provide a comprehensive summary with 5-7 key bullet points and 3-4 key insights.",
    brief:    "Provide a concise summary with exactly 3 key bullet points and 2 insights.",
    academic: "Use precise analytical language. Provide 5-6 bullet points focusing on arguments, methodology, and implications.",
    tldr:     "Ultra-brief. Max 3 bullet points. TL;DR must be one sentence only.",
  };
  const instruction = modeMap[mode] || modeMap.detailed;

  return `You are an expert content analyst. Analyze the following webpage and produce a structured JSON summary.

Page Title: ${title || "Unknown"}
Page URL: ${url || "Unknown"}

CONTENT:
${content}

---

${instruction}

Respond ONLY with a raw JSON object — no markdown fences, no explanation, no text before or after the JSON. Use this exact schema:

{
  "tldr": "One sentence capturing the page's core message",
  "bullets": [
    "Key point starting with a strong verb or noun",
    "Another key point"
  ],
  "insights": [
    "Deeper implication or significance — not just a restatement",
    "Another insight"
  ],
  "highlights": [
    "exact short phrase from the source text (6-14 words)",
    "another exact phrase worth in-page highlighting"
  ]
}

Rules:
- tldr: plain English, one sentence, captures everything
- bullets: actionable takeaways; never start with "The article" or "This page"
- insights: why it matters, what it implies, broader context
- highlights: copy EXACT phrases directly from the source text (used for in-page highlighting)
- No HTML, no markdown in any value
- Return valid JSON only`;
}

// =============================================
// GEMINI 2.5 FLASH
// Free tier: 15 RPM, 1M tokens/day
// Get key: https://aistudio.google.com/app/apikey
// thinkingBudget:0 — disables chain-of-thought,
// which we don't need for JSON summarization and
// which would otherwise break JSON parsing.
// =============================================
async function callGemini(apiKey, prompt) {
  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  let response;
  try {
    response = await fetch(endpoint, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature:     0.3,
          maxOutputTokens: 1400,
          thinkingConfig:  { thinkingBudget: 0 },
        },
        safetySettings: [
          { category: "HARM_CATEGORY_HARASSMENT",        threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_HATE_SPEECH",       threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
        ],
      }),
    });
  } catch (networkErr) {
    throw new Error("Network error contacting Gemini API. Check your internet connection.");
  }

  if (!response.ok) {
    const err    = await response.json().catch(() => ({}));
    const status = response.status;
    const msg    = err?.error?.message || "";

    if (status === 400) throw new Error("Gemini: Bad request — " + (msg || "check your API key format."));
    if (status === 403) throw new Error("Gemini: API key invalid or API not enabled. Visit aistudio.google.com to verify.");
    if (status === 429) throw new Error("Gemini: Rate limit reached. Free tier allows 15 requests/minute. Please wait.");
    if (status === 500 || status === 503) throw new Error("Gemini API is temporarily unavailable. Please try again.");
    throw new Error(`Gemini API error (${status}): ${msg || "unknown error"}`);
  }

  const data = await response.json();

  // Gemini 2.5 Flash may return multiple parts (thinking + response).
  // Collect ALL text parts — the JSON will be in one of them.
  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  const text  = parts
    .filter(p => typeof p.text === "string")
    .map(p => p.text)
    .join("\n");

  if (!text.trim()) {
    const reason = data?.candidates?.[0]?.finishReason;
    if (reason === "SAFETY") throw new Error("Gemini blocked this content for safety reasons. Try a different page.");
    throw new Error("Gemini returned an empty response. Please try again.");
  }

  return text;
}

// ── Parse + sanitize AI response ──
function parseAndSanitize(rawText, originalContent) {
  let parsed;

  // Strategy 1: strip markdown fences and try direct parse
  const stripped = rawText
    .replace(/^```json\s*/im, "")
    .replace(/^```\s*/im,    "")
    .replace(/```\s*$/im,    "")
    .trim();

  try {
    parsed = JSON.parse(stripped);
  } catch {
    // Strategy 2: find ALL {...} blocks, try largest first
    // Handles thinking preamble + JSON output mixed together
    const candidates = [];
    let depth = 0, start = -1;
    for (let i = 0; i < rawText.length; i++) {
      if (rawText[i] === "{") {
        if (depth === 0) start = i;
        depth++;
      } else if (rawText[i] === "}") {
        depth--;
        if (depth === 0 && start !== -1) {
          candidates.push(rawText.slice(start, i + 1));
          start = -1;
        }
      }
    }

    candidates.sort((a, b) => b.length - a.length);

    let parseOk = false;
    for (const candidate of candidates) {
      try {
        parsed = JSON.parse(candidate);
        if (parsed.tldr || parsed.bullets || parsed.insights) {
          parseOk = true;
          break;
        }
      } catch { /* try next */ }
    }

    if (!parseOk) {
      console.error("[Summarizer] Raw response that failed parsing:\n", rawText.slice(0, 500));
      throw new Error("Could not parse the AI response as JSON. Please try again.");
    }
  }

  function sanitize(val) {
    if (typeof val !== "string") return "";
    return val.replace(/<[^>]*>/g, "").trim();
  }

  function sanitizeArr(arr) {
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(s => typeof s === "string" && s.trim().length > 0)
      .map(sanitize);
  }

  const wordCount   = countWords(originalContent);
  const readingTime = Math.max(1, Math.ceil(wordCount / 238));

  return {
    tldr:        sanitize(parsed.tldr   || ""),
    bullets:     sanitizeArr(parsed.bullets),
    insights:    sanitizeArr(parsed.insights),
    highlights:  sanitizeArr(parsed.highlights),
    wordCount:   wordCount.toLocaleString(),
    readingTime: readingTime,
    title:       sanitize(parsed.title  || ""),
  };
}

function countWords(text) {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(w => w.length > 0).length;
}
