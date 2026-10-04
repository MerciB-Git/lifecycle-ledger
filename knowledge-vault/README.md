# คลังความรู้ — Knowledge Vault

When you find an interesting article, post, or file, you can **attach a link, paste text, or add images, PDFs, or other files**.
Claude then reads it, **summarizes it, pulls out the key points, adds tags, and files it under a category you defined**.
It can also **synthesize every item in a category into a single overview**, with references back to each item.

It's a PWA, so you can install it on your phone or computer like an app. Your data stays in your own browser.

---

## Features

**Saving knowledge**
- Links (articles, websites, videos, social posts). Claude fetches the page content itself with `web_fetch`
- Text and notes (paste content, or write down why you saved it)
- Images and screenshots (Claude reads text inside images). They're shrunk automatically before sending
- PDFs (Claude reads the full document, including tables and charts)
- Text files: `.txt .md .csv .json .html` and so on
- Other files are stored as attachments, but Claude only gets the file name as a hint
- **Ctrl/⌘+V** anywhere on the page to paste a link or image, or drag files onto the page
- **Share from other apps** (Android/desktop, once installed): share a link, image, or PDF from Chrome, LINE, X, and so on, straight into the app

**Summarizing with AI** (each item becomes)
- A clear title, a 3–6 sentence summary, 3–8 key points, and 3–7 tags
- A category picked by comparing the content with each **category's name and description**
- If nothing fits, Claude suggests a new category name, and one click creates it
- You can pick a category yourself while saving, move an item later, or edit the summary by hand

**Categories**
- Create, rename, recolor, reorder, and delete categories, and write a description so the AI files things accurately
- **Category knowledge overview**: Claude merges every item in the category into one structured page
  (overview → themed sections → key conclusions → contradictions and open questions). Every claim has a
  `[n]` citation you can click to open the source item, and you'll see a notice when the category changed after the last summary

**Other**
- Searches titles, summaries, key points, tags, notes, and file names
- Items you save without summarizing, or that fail, wait in the "รอสรุป" (to summarize) list, and you can summarize them all at once
- Back up and restore everything (including attachments) as `.json`, or export as Markdown
- Works offline: everything already saved can be opened (new summaries need internet)
- Light and dark themes, works on both mobile and desktop

---

## Getting started

1. Open the app, then go to **Settings** (⚙︎) and paste your Claude API key
   (create one at [console.anthropic.com](https://console.anthropic.com) → API Keys)
2. Pick a model:
   - **Claude Opus 5.5**: most detailed summaries (default)
   - **Claude Sonnet 5.5**: faster and cheaper
   - **Claude Haiku 4.5**: fastest and cheapest
3. Go to **จัดการหมวด** (manage categories) and adjust the categories and their descriptions to fit you. There are 5 starter categories
4. Press **เพิ่มความรู้** (add knowledge), then attach a link, text, or files

> **About the API key:** it's stored in this browser's `localStorage` and sent straight to
> `api.anthropic.com` (there's no server of ours in between). Each summary is billed to that key,
> so use it on your own devices only.

---

## Running locally / deploying

No build step needed. Any static web server works (service workers don't run from `file://`):

```bash
cd knowledge-vault
python -m http.server 8000
# open http://localhost:8000
```

You can also deploy the `knowledge-vault/` folder to GitHub Pages, Netlify, Cloudflare Pages, or similar.
Share Target and app installation need HTTPS.

---

## Project layout

```
knowledge-vault/
  index.html               markup + styles (design tokens, light/dark themes)
  app.js                   all app logic: IndexedDB, Claude calls, UI
  sw.js                    service worker: offline cache + receives shared content (Share Target)
  manifest.webmanifest     PWA metadata + share_target
  vendor/anthropic-sdk.mjs official Anthropic TypeScript SDK (@anthropic-ai/sdk 0.131.0) bundled as one ESM file
  icons/                   app icons
```

### How the AI works

- **Per-item summary**: a single `messages.create` request with the content (images, PDFs, and text files as
  content blocks), the `web_fetch` server tool when there's a link, and a `save_knowledge` tool (`strict: true`)
  that pins the result shape: title, summary, key points, tags, and a `category_id` limited to the user's category
  ids (or `none`). If `web_fetch` returns `pause_turn`, the request is sent again until it finishes.
- **Category overview**: sends the summaries of every item in the category, and gets back Markdown with `[#n]`
  citations that the app turns into links to each item.
- Opus/Sonnet use `output_config.effort: "medium"` and `fallbacks: "default"`, so that if a request is
  refused by mistake, the server tries a backup model automatically.

### Data storage

IndexedDB database `knowledge-vault`:
`items` (knowledge entries) · `categories` (categories + overview summaries) · `files` (attachments as Blobs)

The `kv-share-inbox` database briefly holds content shared from other apps until the app picks it up.

### Updating the SDK

```bash
npm i @anthropic-ai/sdk esbuild
echo 'export { default } from "@anthropic-ai/sdk";' > entry.mjs
npx esbuild entry.mjs --bundle --format=esm --minify --platform=browser --outfile=knowledge-vault/vendor/anthropic-sdk.mjs
```

Then bump `CACHE` in `sw.js` so installed copies pick up the new version.
