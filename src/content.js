// =============================================
// brif - PAGE SUMMARIZER v0 — CONTENT SCRIPT
// Runs in the context of the page.
// Handles: content extraction, in-page highlighting
// =============================================
"use strict";

// Guard against duplicate injection
if (!window.__aiSummarizerV0) {
  window.__aiSummarizerV0 = true;

  const HIGHLIGHT_CLS  = "__ai-sum-mark__";
  const HIGHLIGHT_STYLE = "__ai-sum-style__";

  // ── Message router ──
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "EXTRACT_CONTENT") {
      try {
        sendResponse(extractContent());
      } catch (e) {
        sendResponse({ title: document.title, content: null, error: String(e) });
      }
      return true;
    }

    if (msg.type === "HIGHLIGHT") {
      try {
        applyHighlights(msg.payload?.highlights ?? []);
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
      return true;
    }

    if (msg.type === "CLEAR_HIGHLIGHTS") {
      clearHighlights();
      sendResponse({ ok: true });
      return true;
    }
  });

  // =============================================
  // CONTENT EXTRACTION
  // Priority chain:
  //  1. Semantic: <article>, [role=article]
  //  2. Structural: <main>, [role=main]
  //  3. CMS-specific class selectors
  //  4. Heuristic: densest text block
  //  5. Fallback: cleaned <body>
  // =============================================
  function extractContent() {
    const title = document.title || "";
    const url   = location.href;

    const el  = findPrimaryElement();
    const raw = el ? extractFromEl(el) : extractFromBody();
    const content = cleanText(raw);

    if (content.length < 100) {
      return { title, url, content: null, error: "Page content is too short to summarize." };
    }
    return { title, url, content };
  }

  function findPrimaryElement() {
    // Ordered selector list — first match with enough text wins
    const selectors = [
      "article",
      '[role="article"]',
      "main",
      '[role="main"]',
      // Common blogging / CMS patterns
      ".post-content",
      ".article-content",
      ".article-body",
      ".entry-content",
      ".post-body",
      ".story-body",
      ".content-body",
      ".page-content",
      ".body-content",
      "#article-body",
      "#main-content",
      ".main-content",
      // Platform-specific
      ".postArticle-content",   // Medium
      ".markup",                 // Substack
      ".post__content",
      ".prose",
      ".rich-text",
      '[itemprop="articleBody"]',
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && textLength(el) > 200) return el;
    }

    return findDensestBlock();
  }

  function findDensestBlock() {
    let best = null, bestScore = 0;

    document.querySelectorAll("div, section").forEach(el => {
      if (isNoisy(el)) return;
      const total = textLength(el);
      if (total < 300) return;
      const links = linkTextLength(el);
      // Score: penalize link-heavy blocks (navbars, footers)
      const score = total * ((total - links) / Math.max(total, 1));
      if (score > bestScore) { bestScore = score; best = el; }
    });

    return best;
  }

  function extractFromEl(el) {
    const clone = el.cloneNode(true);
    removeNoisy(clone);
    return clone.innerText || clone.textContent || "";
  }

  function extractFromBody() {
    const clone = document.body.cloneNode(true);
    removeNoisy(clone);
    return clone.innerText || clone.textContent || "";
  }

  function removeNoisy(root) {
    const sel = [
      "nav", "header", "footer", "aside",
      "script", "style", "noscript", "iframe",
      ".nav", ".navbar", ".navigation", ".breadcrumb",
      ".sidebar", ".widget", ".ad", ".ads", ".advertisement",
      ".cookie", ".cookie-banner", ".cookie-notice",
      ".popup", ".modal", ".overlay", ".dialog",
      ".social", ".share", ".share-buttons",
      ".comment", ".comments", ".discussion",
      ".related", ".recommended", ".more-stories",
      '[role="navigation"]', '[role="complementary"]',
      '[role="banner"]', '[aria-hidden="true"]',
    ].join(",");

    root.querySelectorAll(sel).forEach(n => {
      try { n.remove(); } catch { /* skip */ }
    });
  }

  function cleanText(raw) {
    return raw
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/^\s+$/gm, "")
      .trim();
  }

  function textLength(el) {
    return ((el.innerText || el.textContent || "")).trim().length;
  }

  function linkTextLength(el) {
    return Array.from(el.querySelectorAll("a"))
      .reduce((acc, a) => acc + (a.innerText || a.textContent || "").length, 0);
  }

  function isNoisy(el) {
    const tag = (el.tagName || "").toLowerCase();
    if (["nav","header","footer","aside","script","style"].includes(tag)) return true;

    const cls = ((el.className && typeof el.className === "string") ? el.className : "").toLowerCase();
    const id  = (el.id || "").toLowerCase();
    const noisy = /nav|menu|sidebar|footer|header|cookie|popup|modal|overlay|banner|advert/;
    if (noisy.test(cls) || noisy.test(id)) return true;

    try {
      const st = window.getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden" || st.opacity === "0") return true;
    } catch { /* skip */ }

    return false;
  }

  // =============================================
  // HIGHLIGHTING
  // Uses TreeWalker to safely find and wrap
  // exact phrase occurrences in text nodes.
  // No innerHTML — XSS-safe.
  // =============================================
  function applyHighlights(phrases) {
    clearHighlights();
    if (!phrases?.length) return;
    injectStyles();
    phrases.forEach(phrase => {
      if (phrase && phrase.length > 4) highlightPhrase(phrase);
    });
  }

  function injectStyles() {
    if (document.getElementById(HIGHLIGHT_STYLE)) return;
    const style = document.createElement("style");
    style.id = HIGHLIGHT_STYLE;
    style.textContent = `
      .${HIGHLIGHT_CLS} {
        background: rgba(251,191,36,0.32) !important;
        border-bottom: 2px solid rgba(251,191,36,0.72) !important;
        border-radius: 2px !important;
        padding: 0 2px !important;
        cursor: default !important;
        transition: background 0.15s !important;
        display: inline !important;
      }
      .${HIGHLIGHT_CLS}:hover {
        background: rgba(251,191,36,0.52) !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function highlightPhrase(phrase) {
    // No entity decoding needed — background.js no longer encodes apostrophes/quotes.
    // Just use the phrase directly for matching.
    const decoded = phrase;

    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const p = node.parentElement;
          if (!p) return NodeFilter.FILTER_REJECT;
          if (p.classList?.contains(HIGHLIGHT_CLS))          return NodeFilter.FILTER_REJECT;
          if (["SCRIPT","STYLE","TEXTAREA","INPUT","SELECT"].includes(p.tagName)) return NodeFilter.FILTER_REJECT;
          if (p.isContentEditable) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      }
    );

    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent || "";
      const idx  = text.toLowerCase().indexOf(decoded.toLowerCase());
      if (idx === -1) continue;

      try {
        const before = text.slice(0, idx);
        const match  = text.slice(idx, idx + decoded.length);
        const after  = text.slice(idx + decoded.length);

        const mark = document.createElement("mark");
        mark.className   = HIGHLIGHT_CLS;
        mark.textContent = match;

        const frag = document.createDocumentFragment();
        if (before) frag.appendChild(document.createTextNode(before));
        frag.appendChild(mark);
        if (after)  frag.appendChild(document.createTextNode(after));

        node.parentNode.replaceChild(frag, node);
      } catch { /* DOM changed — skip */ }

      break; // one occurrence per phrase
    }
  }

  function clearHighlights() {
    document.querySelectorAll("." + HIGHLIGHT_CLS).forEach(el => {
      const parent = el.parentNode;
      if (parent) {
        parent.replaceChild(document.createTextNode(el.textContent || ""), el);
        try { parent.normalize(); } catch { /* skip */ }
      }
    });
    document.getElementById(HIGHLIGHT_STYLE)?.remove();
  }
}