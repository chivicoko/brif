# brif - Page Summarizer — Chrome Extension

> A Chrome Extension (Manifest V3) that extracts content from any webpage, sends it to **Google Gemini 2.5 Flash**, and returns a structured summary: TL;DR, key points, key insights, reading time, word count, optional in-page phrase highlighting, and one-click email delivery via EmailJS.

> **Not on the Chrome Web Store** — loaded locally in Developer Mode.

---

## Setup

### 1 — Get the files
Download and unzip this folder, or clone the repo. Keep it in a **permanent location** — Chrome references it by path.

### 2 — Fill in your credentials

Copy the example env file and add your real keys:

```bash
cp .env.example .env
```

Open `.env` and fill in:

| Key | Where to get it |
|---|---|
| `GEMINI_API_KEY` | [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey) — free, no credit card |
| `EMAILJS_SERVICE_ID` | [EmailJS Dashboard](https://dashboard.emailjs.com) → Email Services |
| `EMAILJS_TEMPLATE_ID` | EmailJS Dashboard → Email Templates |
| `EMAILJS_PUBLIC_KEY` | EmailJS Dashboard → Account → API Keys |

> **Gemini free tier:** 15 req/min · 1M tokens/day · No credit card required.
>
> **EmailJS free tier:** 200 emails/month.

### 3 — Generate config.js

```bash
node scripts/build-config.js
```

This reads `.env` and writes `config.js` (which is gitignored — your keys never touch version control).

### 4 — Load in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `brif` folder (the one with `manifest.json`)
5. The icon appears in your toolbar. Pin it via 🧩 if not visible.

---

## EmailJS Template Setup

In your EmailJS template, use these variables:

| Variable | Content |
|---|---|
| `{{to_email}}` | Recipient address (entered by user) |
| `{{page_title}}` | Title of the summarized page |
| `{{page_url}}` | Full URL |
| `{{tldr}}` | One-sentence summary |
| `{{bullets}}` | Key points (numbered, newline-separated) |
| `{{insights}}` | Key insights (numbered, newline-separated) |
| `{{summary_mode}}` | Detailed / Brief / Academic / TL;DR |
| `{{word_count}}` | Word count of the original page |
| `{{reading_time}}` | Estimated reading time |
| `{{sent_at}}` | Timestamp |

Make sure your template's **To Email** field is set to `{{to_email}}`.

---

## Usage

1. Navigate to any article, blog post, or docs page
2. Click the **brif - Page Summarizer** icon
3. Select a Summary Style (optional, in Settings ⚙)
4. Click **Summarize Page**
5. Read your summary — TL;DR, key points, key insights
6. Optionally: enter your email and click **Send** to receive the summary by email

### Controls

| Control | What it does |
|---|---|
| **Highlight** | Toggles yellow underline marks on key phrases in the live page |
| **Copy** | Copies the full summary to clipboard |
| **↺ Refresh** | Forces a fresh API call, bypassing the cache |
| **Clear** | Removes summary and cache entry for this URL |
| **Send (email)** | Sends the summary to an email address via EmailJS |
| **⚙ Settings** | Change Summary Style |
| **Theme toggle** | Switch dark / light mode |

---

## Architecture

```
brif/
├── manifest.json          # Chrome Extension Manifest V3
├── popup.html             # Extension popup UI
├── popup.css              # Styles — dark/light themes, all components
├── popup.js               # Popup controller — state, UI, email
├── config.js              # Generated from .env by build-config.js (gitignored)
├── .env                   # Your secrets — gitignored, never committed
├── .env.example           # Template — safe to commit
├── .gitignore
├── scripts/
│   └── build-config.js    # Node script: .env → config.js
├── vendor/
│   └── emailjs.min.js     # EmailJS SDK v4 (local copy)
├── src/
│   ├── background.js      # Service worker — all Gemini API calls
│   └── content.js         # Content script — extraction + highlighting
└── icons/
    ├── icon16.png
    ├── icon32.png
    ├── icon48.png
    └── icon128.png
```

### Message Passing Flow

```
User clicks "Summarize Page"
        │
        ▼
popup.js
  ├── Reads Gemini key from window.APP_CONFIG (injected by config.js)
  ├── chrome.tabs.sendMessage(EXTRACT_CONTENT)
  │         └──▶ content.js (page context)
  │                  Priority chain: <article> → <main> → CMS selectors
  │                  → heuristic density → <body>
  │                  Strips nav / sidebar / footer / ads
  │                  Returns { title, content, url }
  │
  └── chrome.runtime.sendMessage(SUMMARIZE)
            └──▶ background.js (service worker)
                     Calls Gemini 2.5 Flash
                     Parses JSON (brace-depth scan handles thinking preamble)
                     Returns { summary }

Email flow:
popup.js → window.emailjs.send() → api.emailjs.com → user's inbox
```

---

## Security

| Concern | Implementation |
|---|---|
| API key storage | `config.js` is gitignored and never committed. Keys live only on your local machine. |
| Key access | Only `background.js` uses the Gemini key. `popup.js` reads it from `window.APP_CONFIG` and passes it via Chrome message — it never makes direct API fetch calls. |
| EmailJS SDK | Bundled locally in `vendor/` — no CDN dependency at runtime. |
| AI output | HTML tags stripped before display; all values rendered via `.textContent`, never `innerHTML`. |
| DOM injection | Highlights use `createElement + createTextNode` via TreeWalker — no `innerHTML`, no XSS. |
| CSP | `script-src 'self'` — no inline scripts, no `eval()`. |
| Permissions | `activeTab`, `storage`, `scripting`, `clipboardWrite` — minimal set. |

---

## Content Extraction Strategy

`content.js` uses a priority chain:

1. `<article>`, `[role="article"]`
2. `<main>`, `[role="main"]`
3. Common CMS selectors — `.post-content`, `.entry-content`, `.markup` (Substack), `.postArticle-content` (Medium), `[itemprop="articleBody"]`
4. Heuristic: densest `<div>`/`<section>` by text-to-link-text ratio
5. Fallback: stripped `<body>`

In all cases, `removeNoisy()` strips `<nav>`, `<header>`, `<footer>`, `<aside>`, ads, cookie banners, modals, and comment sections first.

---

## License

MIT
