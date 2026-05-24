// =============================================
// brif - PAGE SUMMARIZER — POPUP CONTROLLER
// Provider: Google Gemini 2.5 Flash
// Key source: config.js (generated from .env)
// =============================================
"use strict";

// ── State ──
let currentTabId     = null;
let currentUrl       = null;
let highlightsActive = false;
let lastSummary      = null;
let currentMode      = "detailed";

// ── DOM refs ──
const $ = (id) => document.getElementById(id);
const els = {
  app:               $("app"),
  // header
  settingsBtn:       $("settingsBtn"),
  themeToggle:       $("themeToggle"),
  providerChip:      $("providerChip"),
  // settings panel
  settingsPanel:     $("settingsPanel"),
  summaryMode:       $("summaryMode"),
  saveSettings:      $("saveSettings"),
  saveStatus:        $("saveStatus"),
  // main view
  mainView:          $("mainView"),
  pageFavicon:       $("pageFavicon"),
  pageTitle:         $("pageTitle"),
  pageUrl:           $("pageUrl"),
  cachedBadge:       $("cachedBadge"),
  refreshCache:      $("refreshCache"),
  summarizeBtn:      $("summarizeBtn"),
  highlightBtn:      $("highlightBtn"),
  loadingState:      $("loadingState"),
  loadingText:       $("loadingText"),
  step1:             $("step1"),
  step2:             $("step2"),
  step3:             $("step3"),
  errorState:        $("errorState"),
  errorMessage:      $("errorMessage"),
  retryBtn:          $("retryBtn"),
  results:           $("results"),
  readingTime:       $("readingTime"),
  wordCount:         $("wordCount"),
  modeTag:           $("modeTag"),
  copyBtn:           $("copyBtn"),
  tldrText:          $("tldrText"),
  bulletList:        $("bulletList"),
  insightsList:      $("insightsList"),
  clearBtn:          $("clearBtn"),
  providerFooterTag: $("providerFooterTag"),
  // email
  emailInput:        $("emailInput"),
  sendEmailBtn:      $("sendEmailBtn"),
  emailStatus:       $("emailStatus"),
  // no-key prompt
  noKeyPrompt:       $("noKeyPrompt"),
};

// ── Config — injected via config.js (generated from .env) ──
function getConfig() {
  return window.APP_CONFIG || { geminiApiKey: "", emailjs: {} };
}

// ── Boot ──
document.addEventListener("DOMContentLoaded", init);

async function init() {
  await loadSettings();
  await loadCurrentTab();
  initEmailJS();
  bindEvents();
}

// ── EmailJS init ──
function initEmailJS() {
  const { publicKey } = getConfig().emailjs || {};
  if (publicKey && window.emailjs) {
    window.emailjs.init({ publicKey });
  }
}

// ── Load settings from storage ──
async function loadSettings() {
  const data = await chrome.storage.local.get(["summaryMode", "theme"]);

  // Theme
  const theme = data.theme || "dark";
  els.app.setAttribute("data-theme", theme);

  // Mode
  currentMode = data.summaryMode || "detailed";
  if (els.summaryMode) els.summaryMode.value = currentMode;

  // Check key
  const { geminiApiKey } = getConfig();
  if (!geminiApiKey) {
    showNoKeyPrompt();
  }
}

// ── Load current tab info ──
async function loadCurrentTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    currentTabId = tab.id;
    currentUrl   = tab.url;

    els.pageTitle.textContent = tab.title || "Untitled Page";
    els.pageUrl.textContent   = extractDomain(tab.url);

    const img    = document.createElement("img");
    img.src      = `https://www.google.com/s2/favicons?domain=${extractDomain(tab.url)}&sz=32`;
    img.alt      = "";
    img.setAttribute("aria-hidden", "true");
    img.onerror  = () => { img.style.display = "none"; };
    els.pageFavicon.appendChild(img);

    await checkCache(tab.url);
  } catch (err) {
    console.error("[Summarizer] Tab error:", err);
  }
}

// ── Cache check ──
async function checkCache(url) {
  const key  = "summary_" + hashUrl(url);
  const data = await chrome.storage.local.get([key]);
  if (data[key]) {
    lastSummary = data[key];
    showResults(lastSummary, true);
  }
}

// ── Bind all events ──
function bindEvents() {
  els.settingsBtn.addEventListener("click", () => toggleSettings());
  els.themeToggle.addEventListener("click", toggleTheme);
  els.saveSettings.addEventListener("click", saveSettings);
  els.summarizeBtn.addEventListener("click", () => handleSummarize());
  els.retryBtn.addEventListener("click", () => handleSummarize());
  els.clearBtn.addEventListener("click", handleClear);
  els.copyBtn.addEventListener("click", handleCopy);
  els.highlightBtn.addEventListener("click", handleHighlight);
  els.refreshCache.addEventListener("click", () => handleSummarize(true));
  els.sendEmailBtn.addEventListener("click", handleSendEmail);
}

// ── Settings panel toggle ──
function toggleSettings(forceOpen = false) {
  const isOpen = els.settingsPanel.classList.contains("open");
  if (forceOpen || !isOpen) {
    els.settingsPanel.classList.add("open");
    els.settingsPanel.setAttribute("aria-hidden", "false");
  } else {
    closeSettings();
  }
}

function closeSettings() {
  els.settingsPanel.classList.remove("open");
  els.settingsPanel.setAttribute("aria-hidden", "true");
}

// ── Save settings ──
async function saveSettings() {
  const mode = els.summaryMode.value;
  currentMode = mode;
  await chrome.storage.local.set({ summaryMode: mode });
  showSaveStatus("✓ Settings saved");
  setTimeout(closeSettings, 900);
}

function showSaveStatus(msg, type = "success") {
  els.saveStatus.textContent = msg;
  els.saveStatus.style.color = type === "error" ? "var(--error)" : "var(--success)";
  setTimeout(() => { els.saveStatus.textContent = ""; }, 3500);
}

// ── Theme toggle ──
async function toggleTheme() {
  const cur  = els.app.getAttribute("data-theme") || "dark";
  const next = cur === "dark" ? "light" : "dark";
  els.app.setAttribute("data-theme", next);
  await chrome.storage.local.set({ theme: next });
}

// ── Main summarize flow ──
async function handleSummarize(forceRefresh = false) {
  const { geminiApiKey } = getConfig();

  if (!geminiApiKey) {
    showNoKeyPrompt();
    return;
  }

  const data = await chrome.storage.local.get(["summaryMode"]);
  const mode = data.summaryMode || "detailed";

  // Reset UI
  els.cachedBadge.style.display = "none";
  hideResults();
  hideError();
  showLoading();
  setStep(1);

  try {
    // Step 1: extract content
    const extracted = await extractPageContent();
    if (!extracted || !extracted.content) {
      throw new Error(
        "Could not extract readable content from this page. " +
        "Try scrolling to load content first, or try a different page."
      );
    }

    setStep(2);
    els.loadingText.textContent = "Sending to Gemini 2.5 Flash…";

    // Step 2: AI summarise via background
    const summaryResp = await chrome.runtime.sendMessage({
      type: "SUMMARIZE",
      payload: {
        content:     extracted.content,
        title:       extracted.title,
        url:         currentUrl,
        geminiKey:   geminiApiKey,
        mode:        mode,
      },
    });

    setStep(3);

    if (!summaryResp || summaryResp.error) {
      throw new Error(summaryResp?.error || "AI request failed. Please try again.");
    }

    // Cache result
    const cacheKey = "summary_" + hashUrl(currentUrl);
    await chrome.storage.local.set({ [cacheKey]: summaryResp.summary });
    lastSummary = summaryResp.summary;
    currentMode = mode;

    await sleep(350);
    hideLoading();
    showResults(lastSummary, false, mode);

  } catch (err) {
    console.error("[Summarizer] Error:", err);
    hideLoading();
    showError(err.message || "An unexpected error occurred.");
  }
}

// ── Extract content from active tab ──
async function extractPageContent() {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(currentTabId, { type: "EXTRACT_CONTENT" }, (response) => {
      if (chrome.runtime.lastError) {
        chrome.scripting.executeScript(
          { target: { tabId: currentTabId }, files: ["src/content.js"] },
          () => {
            if (chrome.runtime.lastError) {
              reject(new Error("Cannot access this page. Chrome system pages and the Web Store cannot be summarized."));
              return;
            }
            setTimeout(() => {
              chrome.tabs.sendMessage(currentTabId, { type: "EXTRACT_CONTENT" }, (resp2) => {
                if (chrome.runtime.lastError) {
                  reject(new Error("Could not read this page's content."));
                } else {
                  resolve(resp2);
                }
              });
            }, 300);
          }
        );
      } else {
        resolve(response);
      }
    });
  });
}

// ── Highlight toggle ──
function handleHighlight() {
  if (!lastSummary?.highlights?.length) return;
  highlightsActive = !highlightsActive;
  els.highlightBtn.classList.toggle("active", highlightsActive);
  els.highlightBtn.setAttribute("aria-pressed", highlightsActive);
  chrome.tabs.sendMessage(currentTabId, {
    type:    highlightsActive ? "HIGHLIGHT" : "CLEAR_HIGHLIGHTS",
    payload: { highlights: lastSummary.highlights },
  });
}

// ── Clear everything ──
async function handleClear() {
  const cacheKey = "summary_" + hashUrl(currentUrl);
  await chrome.storage.local.remove([cacheKey]);

  lastSummary      = null;
  highlightsActive = false;
  els.highlightBtn.classList.remove("active");
  els.highlightBtn.style.display = "none";

  chrome.tabs.sendMessage(currentTabId, { type: "CLEAR_HIGHLIGHTS" }, () => {});
  hideResults();
  hideError();
  els.cachedBadge.style.display = "none";
  clearEmailStatus();
}

// ── Copy to clipboard ──
async function handleCopy() {
  if (!lastSummary) return;
  const text = buildCopyText(lastSummary);

  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity  = "0";
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  }

  const original = els.copyBtn.innerHTML;
  els.copyBtn.classList.add("copied");
  els.copyBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><polyline points="20 6 9 17 4 12" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg> Copied!`;
  setTimeout(() => {
    els.copyBtn.classList.remove("copied");
    els.copyBtn.innerHTML = original;
  }, 2200);
}

// ── Send email via EmailJS ──
async function handleSendEmail() {
  const email = els.emailInput.value.trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    setEmailStatus("Please enter a valid email address.", "error");
    return;
  }
  if (!lastSummary) {
    setEmailStatus("No summary to send yet.", "error");
    return;
  }

  const cfg = getConfig().emailjs || {};
  if (!cfg.serviceId || !cfg.templateId || !cfg.publicKey) {
    setEmailStatus("EmailJS not configured. Check your .env file.", "error");
    return;
  }

  if (!window.emailjs) {
    setEmailStatus("EmailJS SDK not loaded.", "error");
    return;
  }

  setEmailStatus("Sending…", "info");
  els.sendEmailBtn.disabled = true;

  try {
    const bulletsText   = (lastSummary.bullets  || []).map((b, i) => `${i + 1}. ${b}`).join("\n");
    const insightsText  = (lastSummary.insights || []).map((ins, i) => `${i + 1}. ${ins}`).join("\n");
    const modeLabels    = { detailed: "Detailed", brief: "Brief", academic: "Academic", tldr: "TL;DR" };
    
    const formattedBullets = Array.isArray(bulletsText)
      ? bulletsText.map((item, index) => `${index + 1}. ${item}`).join("\n\n")
      : bulletsText;

    const formattedInsights = Array.isArray(insightsText)
      ? insightsText.map((item, index) => `${index + 1}. ${item}`).join("\n\n")
      : insightsText;

    const message = `
    Summary of "${els.pageTitle.textContent}"

    ━━━━━━━━━━━━━━━━━━

    🔗 Page URL:
    ${currentUrl}

    🕒 Time:
    ${new Date().toLocaleString()}

    📖 Reading Time:
    ~ ${lastSummary.readingTime ? `${lastSummary.readingTime} min read` : "N/A"}

    ━━━━━━━━━━━━━━━━━━

    📝 TL;DR

    ${lastSummary.tldr || "No summary available"}

    ━━━━━━━━━━━━━━━━━━

    📌 Points

    ${formattedBullets || "No points available"}

    ━━━━━━━━━━━━━━━━━━

    💡 Insights

    ${formattedInsights || "No insights available"}

    ━━━━━━━━━━━━━━━━━━

    ⚙️ Summary Mode:
    ${modeLabels[currentMode] || currentMode}

    📊 Word Count:
    ${lastSummary.wordCount || "N/A"}
    `;

    await window.emailjs.send(cfg.serviceId, cfg.templateId, {
      email,
      name: email,
      username: "VeeCee Tech Solutions",
      subject: `${els.pageTitle.textContent} - The Summary`,
      message,
    });
    
    setEmailStatus("✓ Summary sent!", "success");
    els.emailInput.value = "";
  } catch (err) {
    console.error("[Summarizer] Email error:", err);
    setEmailStatus("Failed to send. Check your EmailJS config.", "error");
  } finally {
    els.sendEmailBtn.disabled = false;
  }
}

function setEmailStatus(msg, type = "info") {
  els.emailStatus.textContent = msg;
  els.emailStatus.dataset.type = type;
}

function clearEmailStatus() {
  els.emailStatus.textContent = "";
  delete els.emailStatus.dataset.type;
}

function buildCopyText(summary) {
  const lines = [];
  lines.push("📄 " + (summary.title || els.pageTitle.textContent || "Page Summary"));
  lines.push("🔗 " + currentUrl);
  lines.push("");
  if (summary.tldr) { lines.push("TL;DR"); lines.push(summary.tldr); lines.push(""); }
  if (summary.bullets?.length) {
    lines.push("Key Points");
    summary.bullets.forEach(b => lines.push("• " + b));
    lines.push("");
  }
  if (summary.insights?.length) {
    lines.push("Key Insights");
    summary.insights.forEach((ins, i) => lines.push((i + 1) + ". " + ins));
  }
  return lines.join("\n");
}

// ── UI state helpers ──
function showLoading() {
  els.loadingState.style.display = "flex";
  els.summarizeBtn.disabled      = true;
  els.loadingText.textContent    = "Extracting page content…";
  resetSteps();
}
function hideLoading() {
  els.loadingState.style.display = "none";
  els.summarizeBtn.disabled      = false;
}
function showError(msg) {
  els.errorState.style.display = "flex";
  els.errorMessage.textContent = msg;
}
function hideError() {
  els.errorState.style.display = "none";
}

function showResults(summary, fromCache, mode) {
  els.tldrText.textContent = summary.tldr || "";

  els.bulletList.innerHTML = "";
  (summary.bullets || []).forEach(b => {
    const li = document.createElement("li");
    li.textContent = b;
    els.bulletList.appendChild(li);
  });

  els.insightsList.innerHTML = "";
  (summary.insights || []).forEach((ins, i) => {
    const li  = document.createElement("li");
    const num = document.createElement("span");
    num.className   = "insight-num";
    num.textContent = String(i + 1).padStart(2, "0");
    li.appendChild(num);
    li.appendChild(document.createTextNode(ins));
    els.insightsList.appendChild(li);
  });

  els.readingTime.textContent = (summary.readingTime || "?") + " min read";
  els.wordCount.textContent   = (summary.wordCount   || "?") + " words";

  if (els.modeTag && mode) {
    const labels = { detailed: "Detailed", brief: "Brief", academic: "Academic", tldr: "TL;DR" };
    els.modeTag.textContent = labels[mode] || mode;
  }

  els.cachedBadge.style.display = fromCache ? "flex" : "none";

  if (summary.highlights?.length) {
    els.highlightBtn.style.display = "flex";
    els.highlightBtn.setAttribute("aria-pressed", "false");
  } else {
    els.highlightBtn.style.display = "none";
  }

  els.results.style.display      = "flex";
  els.summarizeBtn.style.display = "none";
}

function hideResults() {
  els.results.style.display      = "none";
  els.summarizeBtn.style.display = "flex";
}

function showNoKeyPrompt() {
  els.mainView.style.display    = "none";
  els.noKeyPrompt.style.display = "flex";
}

function setStep(n) {
  [els.step1, els.step2, els.step3].forEach((s, i) => {
    s.classList.remove("active", "done");
    if (i + 1 < n)  s.classList.add("done");
    if (i + 1 === n) s.classList.add("active");
  });
}

function resetSteps() {
  [els.step1, els.step2, els.step3].forEach(s => s.classList.remove("active", "done"));
}

// ── Utilities ──
function extractDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return url || ""; }
}

function hashUrl(url) {
  let h = 0;
  for (let i = 0; i < url.length; i++) h = (Math.imul(31, h) + url.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
