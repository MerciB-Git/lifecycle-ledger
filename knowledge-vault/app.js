/* ==========================================================================
   คลังความรู้ — Knowledge Vault
   เก็บลิงก์ / ข้อความ / รูปภาพ / PDF / ไฟล์ → Claude สรุปและจัดเข้าหมวดที่ผู้ใช้กำหนด
   ข้อมูลทั้งหมดอยู่ใน IndexedDB ของเบราว์เซอร์ (ไม่มีเซิร์ฟเวอร์ของเราเอง)
   ========================================================================== */

/* ---------------------------------------------------------------- utils -- */
const $ = (sel, root = document) => root.querySelector(sel);
const uid = (p) => p + "_" + (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, "").slice(0, 16) : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDate = (ts) => new Date(ts).toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "numeric" });
const fmtDateTime = (ts) => new Date(ts).toLocaleString("th-TH", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const fmtSize = (n) => n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(0) + " KB" : (n / 1048576).toFixed(1) + " MB";
const isSafeUrl = (u) => /^https?:\/\//i.test(String(u || "").trim());

class UserError extends Error {}

function toast(msg, action) {
  document.querySelectorAll(".toast").forEach((t) => t.remove());
  const el = document.createElement("div");
  el.className = "toast";
  el.setAttribute("role", "status");
  el.innerHTML = `<span>${esc(msg)}</span>`;
  if (action) {
    const b = document.createElement("button");
    b.textContent = action.label;
    b.onclick = () => { el.remove(); action.run(); };
    el.appendChild(b);
  }
  document.body.appendChild(el);
  setTimeout(() => el.remove(), action ? 9000 : 3800);
}

function download(name, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
function base64ToBlob(b64, type) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: type || "application/octet-stream" });
}

/* ------------------------------------------------------------- settings -- */
const SETTINGS_KEY = "kv-settings";
const settings = Object.assign(
  { apiKey: "", model: "claude-opus-5-5", lang: "th", theme: "" },
  (() => { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}"); } catch { return {}; } })()
);
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* storage blocked */ }
  applyTheme();
}
function applyTheme() {
  if (settings.theme) document.documentElement.dataset.theme = settings.theme;
  else delete document.documentElement.dataset.theme;
}
applyTheme();

/* ------------------------------------------------------------ IndexedDB -- */
const db = {
  _p: null,
  open() {
    if (this._p) return this._p;
    this._p = new Promise((resolve, reject) => {
      const req = indexedDB.open("knowledge-vault", 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        d.createObjectStore("items", { keyPath: "id" });
        d.createObjectStore("categories", { keyPath: "id" });
        const f = d.createObjectStore("files", { keyPath: "id" });
        f.createIndex("itemId", "itemId");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this._p;
  },
  async tx(store, mode, fn) {
    const d = await this.open();
    return new Promise((resolve, reject) => {
      const t = d.transaction(store, mode);
      let out;
      Promise.resolve(fn(t.objectStore(store))).then((v) => { out = v; });
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error("transaction aborted"));
    });
  },
  req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  all(store) { return this.tx(store, "readonly", (s) => this.req(s.getAll())); },
  get(store, id) { return this.tx(store, "readonly", (s) => this.req(s.get(id))); },
  put(store, val) { return this.tx(store, "readwrite", (s) => { s.put(val); }); },
  putMany(store, vals) { return this.tx(store, "readwrite", (s) => { vals.forEach((v) => s.put(v)); }); },
  del(store, id) { return this.tx(store, "readwrite", (s) => { s.delete(id); }); },
  clear(store) { return this.tx(store, "readwrite", (s) => { s.clear(); }); },
  filesOf(itemId) { return this.tx("files", "readonly", (s) => this.req(s.index("itemId").getAll(itemId))); },
};

/* ---------------------------------------------------------------- state -- */
const state = {
  items: [],
  categories: [],
  fileMeta: new Map(), // itemId -> [{id,name,type,size}]
  view: "all",         // "all" | "pending" | "uncat" | <categoryId>
  query: "",
  digestExpanded: false,
  busyDigest: new Set(),
};
const thumbUrls = new Map(); // fileId -> objectURL

const PALETTE = ["#2B3A67", "#D98A1F", "#5E8C7A", "#B5403A", "#7A5BA6", "#2F7FA8", "#9C6B3F", "#C2577F"];

const DEFAULT_CATEGORIES = [
  ["เทคโนโลยีและ AI", "ซอฟต์แวร์ AI แกดเจ็ต การเขียนโปรแกรม เครื่องมือดิจิทัล และแนวโน้มเทคโนโลยี"],
  ["ธุรกิจและการตลาด", "กลยุทธ์ธุรกิจ การตลาด การขาย แบรนด์ กรณีศึกษาบริษัท และการบริหารจัดการ"],
  ["การเงินและการลงทุน", "การเงินส่วนบุคคล หุ้น กองทุน เศรษฐกิจ ภาษี และการวางแผนการเงิน"],
  ["สุขภาพและไลฟ์สไตล์", "สุขภาพกาย สุขภาพใจ อาหาร การออกกำลังกาย การนอน และการใช้ชีวิต"],
  ["พัฒนาตนเอง", "ทักษะการทำงาน ความคิด การเรียนรู้ ประสิทธิภาพ หนังสือ และแรงบันดาลใจ"],
];

async function loadAll() {
  const [items, categories, files] = await Promise.all([db.all("items"), db.all("categories"), db.all("files")]);
  if (!categories.length && !localStorage.getItem("kv-seeded")) {
    const now = Date.now();
    DEFAULT_CATEGORIES.forEach(([name, description], i) => categories.push({ id: uid("c"), name, description, color: PALETTE[i % PALETTE.length], order: i, createdAt: now }));
    await db.putMany("categories", categories);
    try { localStorage.setItem("kv-seeded", "1"); } catch { /* ignore */ }
  }
  // งานที่ค้างสถานะ "กำลังสรุป" จากรอบก่อน (เช่นปิดแอประหว่างทำ) → กลับไปเป็น "รอสรุป"
  const stuck = items.filter((i) => i.status === "processing");
  stuck.forEach((i) => { i.status = "pending"; });
  if (stuck.length) await db.putMany("items", stuck);

  state.items = items.sort((a, b) => b.createdAt - a.createdAt);
  state.categories = categories.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  state.fileMeta = new Map();
  files.forEach((f) => {
    if (!state.fileMeta.has(f.itemId)) state.fileMeta.set(f.itemId, []);
    state.fileMeta.get(f.itemId).push({ id: f.id, name: f.name, type: f.type, size: f.size });
  });
}

const catById = (id) => state.categories.find((c) => c.id === id);

async function saveItem(item) {
  item.updatedAt = Date.now();
  await db.put("items", item);
  const i = state.items.findIndex((x) => x.id === item.id);
  if (i >= 0) state.items[i] = item; else state.items.unshift(item);
}

async function thumbFor(fileId) {
  if (thumbUrls.has(fileId)) return thumbUrls.get(fileId);
  const f = await db.get("files", fileId);
  if (!f) return "";
  const url = URL.createObjectURL(f.blob);
  thumbUrls.set(fileId, url);
  return url;
}

/* ================================================================ Claude == */
let _Anthropic = null;
async function getClient() {
  if (!settings.apiKey) throw new UserError("ยังไม่ได้ใส่ Claude API key — ไปที่ ตั้งค่า เพื่อใส่คีย์ก่อน");
  if (!_Anthropic) _Anthropic = (await import("./vendor/anthropic-sdk.mjs")).default;
  return new _Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
}

/* พารามิเตอร์ที่ต่างกันตามรุ่นโมเดล */
function modelConfig(effort) {
  const model = settings.model || "claude-opus-5-5";
  const isHaiku = model.startsWith("claude-haiku");
  const params = { model };
  const betas = [];
  if (isHaiku) {
    betas.push("web-fetch-2025-09-10");
  } else {
    params.output_config = { effort };
    // ถ้าโมเดลปฏิเสธคำขอ (เช่นตัวกรองความปลอดภัยเข้าใจผิด) ให้เซิร์ฟเวอร์ลองโมเดลสำรองให้อัตโนมัติ
    params.fallbacks = "default";
    betas.push("server-side-fallback-2026-07-01");
  }
  return { params, betas, webFetchType: isHaiku ? "web_fetch_20250910" : "web_fetch_20260209" };
}

function explainApiError(err, Anthropic) {
  if (err instanceof UserError) return err.message;
  if (Anthropic) {
    if (err instanceof Anthropic.AuthenticationError) return "API key ไม่ถูกต้อง — ตรวจสอบคีย์ในหน้าตั้งค่า";
    if (err instanceof Anthropic.PermissionDeniedError) return "คีย์นี้ไม่มีสิทธิ์ใช้โมเดลที่เลือก — ลองเปลี่ยนโมเดลในหน้าตั้งค่า";
    if (err instanceof Anthropic.RateLimitError) return "เรียกใช้ถี่เกินไปหรือเครดิตหมด — รอสักครู่แล้วลองใหม่";
    if (err instanceof Anthropic.BadRequestError) return "คำขอไม่ถูกต้อง: " + (err.error?.error?.message || err.message);
    if (err instanceof Anthropic.NotFoundError) return "ไม่พบโมเดลที่เลือก — ลองเปลี่ยนโมเดลในหน้าตั้งค่า";
    if (err instanceof Anthropic.InternalServerError) return "เซิร์ฟเวอร์ของ Claude มีปัญหาชั่วคราว — ลองใหม่อีกครั้ง";
    if (err instanceof Anthropic.APIConnectionError) return navigator.onLine ? "เชื่อมต่อ Claude ไม่ได้ — ตรวจสอบอินเทอร์เน็ต" : "ออฟไลน์อยู่ — จะสรุปได้เมื่อกลับมาออนไลน์";
    if (err instanceof Anthropic.APIError) return "เกิดข้อผิดพลาดจาก Claude API: " + err.message;
  }
  return "เกิดข้อผิดพลาด: " + (err?.message || err);
}

const LANG_RULE = {
  th: "Write every field in Thai (keep proper nouns, product names and technical terms in their original form where natural).",
  en: "Write every field in English.",
  source: "Write every field in the main language of the source material.",
};

const SYSTEM_ITEM = `You are the librarian of a personal knowledge vault. The user saves things they found interesting — web links, pasted text, screenshots/photos, PDFs and other files — and you turn each one into a clean, reusable knowledge entry filed under one of the user's own categories.

How to work:
1. Read everything provided. If a URL is given, fetch it with web_fetch to read the actual content. If fetching fails (paywall, login, video page, blocked), work from whatever else is available — the URL itself, the user's note, attachments — and say in the summary that the full page could not be read.
2. Extract the knowledge, not the marketing: what is claimed, the evidence or reasoning, numbers, frameworks, steps, and practical takeaways. For images, read any text in them and describe what matters.
3. The user's own note may say why they saved it — let that steer emphasis.
4. Choose the single best category by comparing the content with each category's name and description. If nothing fits reasonably, use "none" and propose a short new category name in suggested_new_category.
5. Finish by calling save_knowledge exactly once. Do not write the entry as plain text.

Field guidance:
- title: a specific, descriptive title (not clickbait), under ~90 characters.
- summary: 3–6 sentences a reader could rely on without opening the source.
- key_points: 3–8 self-contained takeaways; each one should still make sense months later.
- tags: 3–7 short topical tags, lowercase where the language has case.
- source_type: the kind of material.`;

function saveKnowledgeTool(categoryIds) {
  return {
    name: "save_knowledge",
    description: "Save the finished knowledge entry for this item into the user's vault. Call exactly once, after reading all material.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["title", "summary", "key_points", "tags", "category_id", "suggested_new_category", "source_type"],
      properties: {
        title: { type: "string", description: "Specific, descriptive title" },
        summary: { type: "string", description: "3-6 sentence summary" },
        key_points: { type: "array", items: { type: "string" }, description: "3-8 self-contained takeaways" },
        tags: { type: "array", items: { type: "string" }, description: "3-7 topical tags" },
        category_id: { type: "string", enum: [...categoryIds, "none"], description: "id of the best-fitting category, or none" },
        suggested_new_category: { type: "string", description: "Short name for a new category if category_id is none, otherwise empty string" },
        source_type: { type: "string", enum: ["article", "video", "social_post", "research_paper", "document", "image", "note", "other"] },
      },
    },
  };
}

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|html?|xml|ya?ml|log|rtf|srt|vtt|js|ts|py|java|c|cpp|cs|go|rb|php|sql|css)$/i;
const MAX_TEXT_CHARS = 400000;

/* ย่อรูปให้ด้านยาวไม่เกิน 1568px (ขนาดที่ Claude ใช้จริง) เพื่อประหยัดและไม่ติดลิมิต 5MB */
async function imageForClaude(blob) {
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, 1568 / Math.max(bmp.width, bmp.height));
    if (scale === 1 && IMAGE_TYPES.includes(blob.type) && blob.size < 3.5 * 1048576) {
      bmp.close?.();
      return { media_type: blob.type, data: await blobToBase64(blob) };
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close?.();
    const out = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.86));
    return { media_type: "image/jpeg", data: await blobToBase64(out) };
  } catch {
    return null; // รูปแบบที่เบราว์เซอร์ถอดไม่ได้ (เช่น HEIC บางเครื่อง)
  }
}

async function buildItemContent(item) {
  const files = await db.filesOf(item.id);
  const blocks = [];
  const fileNotes = [];
  let pdfBytes = 0;

  for (const f of files) {
    const type = f.type || "";
    if (type.startsWith("image/")) {
      const img = await imageForClaude(f.blob);
      if (img) {
        blocks.push({ type: "text", text: `Attached image: ${f.name}` });
        blocks.push({ type: "image", source: { type: "base64", media_type: img.media_type, data: img.data } });
        fileNotes.push(`- ${f.name} (image, shown above)`);
      } else {
        fileNotes.push(`- ${f.name} (image in a format that could not be decoded — not shown)`);
      }
    } else if (type === "application/pdf" || /\.pdf$/i.test(f.name)) {
      if (pdfBytes + f.size > 22 * 1048576) {
        fileNotes.push(`- ${f.name} (PDF, ${fmtSize(f.size)} — too large to send in one request, not read)`);
        continue;
      }
      pdfBytes += f.size;
      blocks.push({ type: "document", title: f.name, source: { type: "base64", media_type: "application/pdf", data: await blobToBase64(f.blob) } });
      fileNotes.push(`- ${f.name} (PDF, attached above)`);
    } else if (type.startsWith("text/") || type === "application/json" || TEXT_EXT.test(f.name)) {
      let text = await f.blob.text();
      let cut = "";
      if (text.length > MAX_TEXT_CHARS) { text = text.slice(0, MAX_TEXT_CHARS); cut = ` — only the first ${MAX_TEXT_CHARS.toLocaleString()} characters were included`; }
      blocks.push({ type: "document", title: f.name, source: { type: "text", media_type: "text/plain", data: text || "(empty file)" } });
      fileNotes.push(`- ${f.name} (text file, attached above${cut})`);
    } else {
      fileNotes.push(`- ${f.name} (${type || "unknown type"}, ${fmtSize(f.size)} — content cannot be read; use only the file name as a hint)`);
    }
  }

  const cats = state.categories.map((c) => `- id: ${c.id} | name: ${c.name} | description: ${c.description || "(none)"}`).join("\n") || "(the user has no categories yet — use \"none\")";
  const fixedCat = item.categoryLocked && catById(item.categoryId);
  const lines = [
    `Saved on: ${new Date(item.createdAt).toISOString().slice(0, 10)}`,
    item.url ? `URL: ${item.url}` : "URL: (none)",
    "",
    "User's note / pasted text:",
    item.note ? `"""\n${item.note}\n"""` : "(none)",
    "",
    "Attached files:",
    fileNotes.length ? fileNotes.join("\n") : "(none)",
    "",
    "User's categories:",
    cats,
    fixedCat ? `\nThe user already filed this under "${fixedCat.name}" (id ${fixedCat.id}) — use that category_id.` : "",
    "",
    LANG_RULE[settings.lang] || LANG_RULE.th,
  ];
  blocks.push({ type: "text", text: lines.join("\n") });
  return blocks;
}

async function summarizeItem(item) {
  const client = await getClient();
  const { params, betas, webFetchType } = modelConfig("medium");
  const tools = [];
  if (item.url) tools.push({ type: webFetchType, name: "web_fetch", max_uses: 3 });
  tools.push(saveKnowledgeTool(state.categories.map((c) => c.id)));

  const messages = [{ role: "user", content: await buildItemContent(item) }];
  for (let round = 0; round < 6; round++) {
    const res = await client.beta.messages.create(
      { ...params, max_tokens: 16000, system: SYSTEM_ITEM, tools, tool_choice: { type: "auto" }, messages, betas },
      { timeout: 6 * 60 * 1000 }
    );
    if (res.stop_reason === "refusal") throw new UserError("Claude ปฏิเสธการสรุปเนื้อหานี้" + (res.stop_details?.explanation ? `: ${res.stop_details.explanation}` : ""));
    const call = res.content.find((b) => b.type === "tool_use" && b.name === "save_knowledge");
    if (call) return call.input;
    if (res.stop_reason === "max_tokens") throw new UserError("คำตอบยาวเกินลิมิต — ลองใหม่อีกครั้ง");
    messages.push({ role: "assistant", content: res.content });
    // pause_turn = เครื่องมือฝั่งเซิร์ฟเวอร์ (web_fetch) ยังทำงานไม่เสร็จ → ส่งกลับไปให้ทำต่อ
    if (res.stop_reason !== "pause_turn") messages.push({ role: "user", content: "Please finish now by calling save_knowledge with the entry." });
  }
  throw new UserError("AI ไม่ได้ส่งผลสรุปกลับมา — ลองใหม่อีกครั้ง");
}

function cleanResult(r) {
  const str = (v) => (typeof v === "string" ? v.trim() : "");
  const arr = (v) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
  return {
    title: str(r.title), summary: str(r.summary), keyPoints: arr(r.key_points),
    tags: [...new Set(arr(r.tags).map((t) => t.replace(/^#/, "")))].slice(0, 10),
    categoryId: str(r.category_id), suggestedCategory: str(r.suggested_new_category), sourceType: str(r.source_type),
  };
}

/* ---------------------------------------------------- processing queue -- */
const queue = [];
let queueRunning = false;

function enqueue(id) {
  if (!queue.includes(id)) queue.push(id);
  runQueue();
}

async function runQueue() {
  if (queueRunning) return;
  queueRunning = true;
  while (queue.length) {
    const id = queue.shift();
    const item = state.items.find((i) => i.id === id);
    if (!item) continue;
    item.status = "processing";
    item.error = "";
    await saveItem(item);
    render();
    try {
      const r = cleanResult(await summarizeItem(item));
      const fresh = state.items.find((i) => i.id === id);
      if (!fresh) continue; // ถูกลบระหว่างสรุป
      Object.assign(fresh, {
        title: r.title || fresh.title, summary: r.summary, keyPoints: r.keyPoints, tags: r.tags,
        sourceType: r.sourceType, suggestedCategory: r.categoryId === "none" ? r.suggestedCategory : "",
        status: "done", error: "", processedAt: Date.now(), model: settings.model,
      });
      if (!fresh.categoryLocked) fresh.categoryId = catById(r.categoryId) ? r.categoryId : null;
      await saveItem(fresh);
    } catch (err) {
      const fresh = state.items.find((i) => i.id === id);
      if (fresh) {
        fresh.status = "error";
        fresh.error = explainApiError(err, _Anthropic);
        await saveItem(fresh);
      }
      if (err instanceof UserError && !settings.apiKey) { queue.length = 0; }
      if (_Anthropic && (err instanceof _Anthropic.AuthenticationError)) { queue.length = 0; }
    }
    render();
    refreshOpenItem(id);
  }
  queueRunning = false;
}

/* ------------------------------------------------------ category digest -- */
const SYSTEM_DIGEST = `You are the editor of a personal knowledge vault. You receive every entry the user has filed under one category (each already summarised). Synthesise them into a single, well-organised knowledge overview of the category — the kind of page someone would re-read to refresh everything they've learned on the topic.

Write Markdown only (no preamble). Structure:
## ภาพรวม / Overview — 2–4 sentences on what this body of knowledge covers.
## Themed sections — group related entries under clear headings you choose; merge overlapping ideas rather than listing entries one by one; keep concrete facts, numbers, frameworks and steps.
## Key takeaways — the most useful, actionable conclusions.
## Contradictions & open questions — where sources disagree or gaps remain (omit if none).

Cite entries inline as [#n] using their numbers, e.g. "…improves retention [#3][#7]". Every substantive claim should carry at least one citation. Use the heading language that matches the requested output language.`;

async function generateDigest(catId) {
  const cat = catById(catId);
  if (!cat || state.busyDigest.has(catId)) return;
  const entries = state.items.filter((i) => i.categoryId === catId && i.status === "done");
  if (!entries.length) { toast("ยังไม่มีความรู้ที่สรุปแล้วในหมวดนี้"); return; }
  state.busyDigest.add(catId);
  render();
  try {
    const client = await getClient();
    const { params, betas } = modelConfig("medium");
    const list = entries.map((e, n) => [
      `[#${n + 1}] ${e.title}`,
      e.url ? `URL: ${e.url}` : "",
      `Summary: ${e.summary}`,
      e.keyPoints?.length ? "Key points:\n" + e.keyPoints.map((p) => `- ${p}`).join("\n") : "",
      e.tags?.length ? `Tags: ${e.tags.join(", ")}` : "",
      e.note ? `User's note: ${e.note.slice(0, 1500)}` : "",
    ].filter(Boolean).join("\n")).join("\n\n");
    const prompt = `Category: ${cat.name}\nCategory description: ${cat.description || "(none)"}\nNumber of entries: ${entries.length}\n\n${list}\n\n${(LANG_RULE[settings.lang] || LANG_RULE.th).replace("every field", "the overview")}`;

    const res = await client.beta.messages.create(
      { ...params, max_tokens: 16000, system: SYSTEM_DIGEST, messages: [{ role: "user", content: prompt }], betas },
      { timeout: 8 * 60 * 1000 }
    );
    if (res.stop_reason === "refusal") throw new UserError("Claude ปฏิเสธการสรุปหมวดนี้");
    const markdown = res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    if (!markdown) throw new UserError("ไม่ได้รับผลสรุปจาก AI — ลองใหม่อีกครั้ง");
    cat.digest = { markdown, refs: entries.map((e) => e.id), updatedAt: Date.now(), itemCount: entries.length, truncated: res.stop_reason === "max_tokens" };
    await db.put("categories", cat);
    state.digestExpanded = true;
    toast("สรุปภาพรวมหมวด \"" + cat.name + "\" เรียบร้อย");
  } catch (err) {
    toast(explainApiError(err, _Anthropic));
  } finally {
    state.busyDigest.delete(catId);
    render();
  }
}

/* ------------------------------------------------------ tiny markdown -- */
function inlineMd(s, refs) {
  let out = esc(s);
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`);
  out = out.replace(/\[#(\d+)\]/g, (m, n) => {
    const id = refs && refs[Number(n) - 1];
    return id ? `<a class="ref" data-ref="${esc(id)}" title="เปิดรายการที่ ${n}">${n}</a>` : m;
  });
  return out;
}
function renderMarkdown(md, refs) {
  const lines = String(md || "").replace(/\r/g, "").split("\n");
  const html = [];
  let list = null; // "ul" | "ol"
  let para = [];
  const flushPara = () => { if (para.length) { html.push(`<p>${inlineMd(para.join(" "), refs)}</p>`); para = []; } };
  const closeList = () => { if (list) { html.push(`</${list}>`); list = null; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { flushPara(); closeList(); continue; }
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      flushPara(); closeList();
      const lvl = Math.min(3, m[1].length);
      html.push(`<h${lvl}>${inlineMd(m[2], refs)}</h${lvl}>`);
    } else if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) {
      flushPara();
      if (list !== "ul") { closeList(); html.push("<ul>"); list = "ul"; }
      html.push(`<li>${inlineMd(m[1], refs)}</li>`);
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      flushPara();
      if (list !== "ol") { closeList(); html.push("<ol>"); list = "ol"; }
      html.push(`<li>${inlineMd(m[1], refs)}</li>`);
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      flushPara(); closeList();
      html.push(`<blockquote>${inlineMd(m[1], refs)}</blockquote>`);
    } else if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      flushPara(); closeList();
    } else {
      closeList();
      para.push(line.trim());
    }
  }
  flushPara(); closeList();
  return html.join("\n");
}

/* ================================================================ render == */
const ICONS = {
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>',
  pdf: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/></svg>',
  text: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
};

function matchesQuery(item, q) {
  if (!q) return true;
  const hay = [item.title, item.summary, item.note, item.url, ...(item.keyPoints || []), ...(item.tags || []),
    ...(state.fileMeta.get(item.id) || []).map((f) => f.name)].join(" \n ").toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

function visibleItems() {
  let list = state.items;
  if (state.view === "pending") list = list.filter((i) => i.status !== "done");
  else if (state.view === "uncat") list = list.filter((i) => !catById(i.categoryId));
  else if (state.view !== "all") list = list.filter((i) => i.categoryId === state.view);
  return list.filter((i) => matchesQuery(i, state.query));
}

function renderSide() {
  const side = $("#side");
  const count = (fn) => state.items.filter(fn).length;
  const pending = count((i) => i.status !== "done");
  const uncat = count((i) => !catById(i.categoryId));
  const btn = (view, label, n, color) => `
    <button class="nav-item ${state.view === view ? "active" : ""}" data-view="${esc(view)}" type="button">
      ${color ? `<span class="dot" style="background:${esc(color)}"></span>` : ""}
      <span class="name">${esc(label)}</span><span class="count">${n}</span>
    </button>`;
  side.innerHTML = [
    btn("all", "ทั้งหมด", state.items.length),
    pending ? btn("pending", "รอสรุป / มีปัญหา", pending) : "",
    uncat ? btn("uncat", "ยังไม่จัดหมวด", uncat) : "",
    `<div class="side-label">หมวดของฉัน</div>`,
    ...state.categories.map((c) => btn(c.id, c.name, count((i) => i.categoryId === c.id), c.color)),
    `<button class="nav-item" type="button" id="manage-cats" style="color:var(--text-muted)">
       <span class="name">⚙︎ จัดการหมวด</span></button>`,
  ].join("");
}

function cardHtml(item) {
  const cat = catById(item.categoryId);
  const files = state.fileMeta.get(item.id) || [];
  const img = files.find((f) => (f.type || "").startsWith("image/"));
  const icons = [
    item.url ? ICONS.link : "",
    files.some((f) => f.type === "application/pdf") ? ICONS.pdf : "",
    img ? ICONS.image : "",
    !item.url && !files.length ? ICONS.text : "",
  ].join("");
  const badge = item.status === "pending" ? `<span class="badge pending">รอสรุป</span>`
    : item.status === "processing" ? `<span class="badge processing"><span class="spin" style="width:10px;height:10px"></span> กำลังสรุป</span>`
    : item.status === "error" ? `<span class="badge error">สรุปไม่สำเร็จ</span>` : "";
  const fallbackTitle = item.title || (item.url ? item.url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 70) : (item.note || files[0]?.name || "ไม่มีชื่อ").slice(0, 70));
  const body = item.summary || item.note || "";
  return `
    <button class="card" type="button" data-item="${esc(item.id)}" style="--cat-color:${esc(cat?.color || "var(--border-strong)")}">
      <div class="card-top">
        <span class="src-icons">${icons}</span>
        <span class="cat">${esc(cat?.name || "ยังไม่จัดหมวด")}</span>
        <span>· ${fmtDate(item.createdAt)}</span>
        ${badge}
      </div>
      ${img ? `<img class="thumb" data-thumb="${esc(img.id)}" alt=""/>` : ""}
      <h3>${esc(fallbackTitle)}</h3>
      ${body ? `<p>${esc(body)}</p>` : ""}
      ${item.tags?.length ? `<div class="tags">${item.tags.slice(0, 5).map((t) => `<span class="tag">#${esc(t)}</span>`).join("")}</div>` : ""}
    </button>`;
}

function renderMain() {
  const main = $("#main");
  const items = visibleItems();
  const cat = catById(state.view);
  const parts = [];

  // แบนเนอร์
  if (!settings.apiKey) {
    parts.push(`<div class="banner"><span>🔑 ใส่ <b>Claude API key</b> เพื่อเปิดใช้การสรุปและจัดหมวดอัตโนมัติ (ระหว่างนี้บันทึกเก็บไว้ก่อนได้)</span>
      <button class="btn btn-sm btn-ink" type="button" data-action="open-settings">ตั้งค่า</button></div>`);
  }
  const waiting = state.items.filter((i) => i.status === "pending" || i.status === "error");
  if (settings.apiKey && waiting.length && (state.view === "all" || state.view === "pending")) {
    parts.push(`<div class="banner"><span>มี <b>${waiting.length}</b> รายการที่ยังไม่ได้สรุป</span>
      <button class="btn btn-sm btn-primary" type="button" data-action="process-all">สรุปทั้งหมดตอนนี้</button></div>`);
  }

  // หัวหน้า
  let title = "ความรู้ทั้งหมด", desc = "ทุกอย่างที่คุณเก็บไว้ เรียงจากใหม่ไปเก่า";
  if (state.view === "pending") { title = "รอสรุป / มีปัญหา"; desc = "รายการที่ยังไม่ได้สรุป หรือสรุปไม่สำเร็จ"; }
  if (state.view === "uncat") { title = "ยังไม่จัดหมวด"; desc = "AI หาหมวดที่เหมาะไม่เจอ — เปิดรายการเพื่อย้ายหมวด หรือสร้างหมวดใหม่ตามที่ AI แนะนำ"; }
  if (cat) { title = cat.name; desc = cat.description || ""; }
  const busy = cat && state.busyDigest.has(cat.id);
  parts.push(`
    <div class="page-head">
      <div><h1>${esc(title)}</h1>${desc ? `<p class="desc">${esc(desc)}</p>` : ""}</div>
      <div class="actions">
        ${cat ? `<button class="btn btn-sm" type="button" data-action="edit-cat">แก้ไขหมวด</button>` : ""}
      </div>
    </div>`);

  // สรุปภาพรวมของหมวด
  if (cat) {
    const doneCount = state.items.filter((i) => i.categoryId === cat.id && i.status === "done").length;
    const d = cat.digest;
    const stale = d && doneCount !== d.itemCount;
    parts.push(`
      <section class="digest" style="--cat-color:${esc(cat.color)}">
        <div class="digest-head">
          <h2>📚 สรุปองค์ความรู้ของหมวด</h2>
          ${d ? `<span class="meta">อัปเดต ${fmtDateTime(d.updatedAt)} · จาก ${d.itemCount} รายการ${stale ? ` · <b style="color:var(--saffron-strong)">มีการเปลี่ยนแปลงหลังสรุปล่าสุด</b>` : ""}</span>` : ""}
          <button class="btn btn-sm ${d && !stale ? "" : "btn-primary"}" type="button" data-action="digest" ${busy || !doneCount ? "disabled" : ""}>
            ${busy ? `<span class="spin"></span> กำลังสังเคราะห์…` : d ? "สรุปใหม่" : "สร้างสรุปภาพรวม"}
          </button>
        </div>
        ${d ? `<div class="digest-body prose ${state.digestExpanded ? "expanded" : ""}">${renderMarkdown(d.markdown, d.refs)}</div>
               <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
                 <button class="btn btn-sm btn-ghost" type="button" data-action="toggle-digest">${state.digestExpanded ? "ย่อ" : "อ่านทั้งหมด"}</button>
                 <button class="btn btn-sm btn-ghost" type="button" data-action="copy-digest">คัดลอก</button>
               </div>`
             : `<p class="digest-empty">${doneCount ? `รวม ${doneCount} รายการในหมวดนี้ให้เป็นบทสรุปเดียว จัดเป็นหัวข้อ พร้อมอ้างอิงกลับไปยังแต่ละรายการ` : "เพิ่มความรู้เข้าหมวดนี้ก่อน แล้วค่อยสร้างสรุปภาพรวม"}</p>`}
      </section>`);
  }

  // รายการ
  if (items.length) {
    parts.push(`<div class="grid">${items.map(cardHtml).join("")}</div>`);
  } else if (state.query) {
    parts.push(`<div class="empty"><h2>ไม่พบผลลัพธ์</h2><p>ไม่มีรายการที่ตรงกับ "${esc(state.query)}"</p></div>`);
  } else if (!state.items.length) {
    parts.push(`<div class="empty">
      <h2>เริ่มสร้างคลังความรู้ของคุณ</h2>
      <p>เจอบทความ โพสต์ หรือไฟล์ที่น่าสนใจ — แนบลิงก์ วางข้อความ ใส่รูปหรือ PDF<br/>แล้วให้ AI สรุปและจัดเข้าหมวดให้อัตโนมัติ</p>
      <p><button class="btn btn-primary" type="button" data-action="add">+ เพิ่มความรู้ชิ้นแรก</button></p>
      <p class="faint" style="font-size:13px">เคล็ดลับ: กด Ctrl/⌘+V ที่หน้านี้เพื่อวางลิงก์หรือรูปได้ทันที • บนมือถือที่ติดตั้งแอปแล้ว สามารถ "แชร์" จากแอปอื่นเข้ามาได้</p>
    </div>`);
  } else {
    parts.push(`<div class="empty"><h2>ยังไม่มีรายการในส่วนนี้</h2></div>`);
  }

  main.innerHTML = parts.join("");
  main.querySelectorAll("img[data-thumb]").forEach(async (img) => { img.src = await thumbFor(img.dataset.thumb); });
}

function render() { renderSide(); renderMain(); }

/* =========================================================== add dialog == */
let pendingFiles = []; // File[]

function categoryOptions(selected, { aiOption } = {}) {
  return [
    aiOption ? `<option value="">✨ ให้ AI เลือกหมวด</option>` : `<option value="">— ยังไม่จัดหมวด —</option>`,
    ...state.categories.map((c) => `<option value="${esc(c.id)}" ${c.id === selected ? "selected" : ""}>${esc(c.name)}</option>`),
  ].join("");
}

function openAdd(prefill = {}) {
  $("#add-url").value = prefill.url || "";
  $("#add-text").value = prefill.text || "";
  pendingFiles = [...(prefill.files || [])];
  const preset = catById(state.view) ? state.view : "";
  $("#add-cat").innerHTML = categoryOptions(preset, { aiOption: true });
  renderPendingFiles();
  $("#dlg-add").showModal();
  setTimeout(() => (prefill.url || prefill.text || prefill.files?.length ? $("#add-submit") : $("#add-url")).focus(), 50);
}

function renderPendingFiles() {
  const list = $("#add-file-list");
  list.innerHTML = pendingFiles.map((f, i) => `
    <div class="file-row">
      ${f.type.startsWith("image/") ? `<img data-idx="${i}" alt=""/>` : `<span style="width:36px;text-align:center">${f.type === "application/pdf" ? "PDF" : "📄"}</span>`}
      <span class="fname">${esc(f.name)}</span><span class="fsize">${fmtSize(f.size)}</span>
      <button class="btn btn-ghost btn-sm" type="button" data-remove="${i}" aria-label="เอาออก">✕</button>
    </div>`).join("");
  list.querySelectorAll("img[data-idx]").forEach((img) => {
    const url = URL.createObjectURL(pendingFiles[Number(img.dataset.idx)]);
    img.src = url;
    img.onload = () => URL.revokeObjectURL(url);
  });
}

function addPendingFiles(files) {
  for (const f of files) {
    if (!f || !f.size) continue;
    if (f.size > 50 * 1048576) { toast(`ไฟล์ ${f.name} ใหญ่เกิน 50 MB`); continue; }
    const name = f.name && f.name !== "image.png" ? f.name : `ภาพ-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${(f.type.split("/")[1] || "png").replace("jpeg", "jpg")}`;
    pendingFiles.push(f.name === name ? f : new File([f], name, { type: f.type }));
  }
  renderPendingFiles();
}

async function submitAdd(summarize) {
  let url = $("#add-url").value.trim();
  let note = $("#add-text").value.trim();
  if (url && !isSafeUrl(url)) {
    if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(url)) url = "https://" + url;
    else { toast("ลิงก์ต้องขึ้นต้นด้วย http:// หรือ https://"); return; }
  }
  // ถ้าไม่ได้ใส่ลิงก์ แต่ข้อความเป็นลิงก์อย่างเดียว → ย้ายไปช่องลิงก์
  if (!url && isSafeUrl(note) && !/\s/.test(note)) { url = note; note = ""; }
  if (!url && !note && !pendingFiles.length) { toast("ใส่ลิงก์ ข้อความ หรือไฟล์อย่างน้อย 1 อย่าง"); return; }

  const catId = $("#add-cat").value;
  const now = Date.now();
  const item = {
    id: uid("k"), createdAt: now, updatedAt: now, url, note, title: "", summary: "", keyPoints: [], tags: [],
    categoryId: catId || null, categoryLocked: !!catId, status: "pending", error: "",
  };
  const fileRecs = pendingFiles.map((f) => ({ id: uid("f"), itemId: item.id, name: f.name, type: f.type || "", size: f.size, blob: f, addedAt: now }));
  try {
    await db.putMany("files", fileRecs);
    await saveItem(item);
  } catch (err) {
    toast("บันทึกไม่สำเร็จ: " + (err?.message || err) + " (พื้นที่เก็บข้อมูลอาจเต็ม)");
    return;
  }
  state.fileMeta.set(item.id, fileRecs.map(({ id, name, type, size }) => ({ id, name, type, size })));
  pendingFiles = [];
  $("#dlg-add").close();
  render();
  if (summarize && settings.apiKey) { enqueue(item.id); toast("บันทึกแล้ว — AI กำลังสรุปให้…"); }
  else if (summarize) toast("บันทึกแล้ว — ใส่ API key ในหน้าตั้งค่าเพื่อให้ AI สรุป", { label: "ตั้งค่า", run: openSettings });
  else toast("บันทึกไว้ในรายการรอสรุปแล้ว");
}

/* ========================================================== item dialog == */
let openItemId = null;

async function openItem(id) {
  openItemId = id;
  await fillItem(id);
  if (!$("#dlg-item").open) $("#dlg-item").showModal();
}
function refreshOpenItem(id) { if (openItemId === id && $("#dlg-item").open) fillItem(id); }

async function fillItem(id) {
  const item = state.items.find((i) => i.id === id);
  if (!item) { $("#dlg-item").close(); return; }
  const files = await db.filesOf(id);
  $("#item-title").textContent = item.title || (item.url ? item.url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 80) : "ความรู้ที่ยังไม่ได้สรุป");
  const host = item.url ? (() => { try { return new URL(item.url).hostname.replace(/^www\./, ""); } catch { return item.url; } })() : "";
  const typeLabel = { article: "บทความ", video: "วิดีโอ", social_post: "โพสต์โซเชียล", research_paper: "งานวิจัย", document: "เอกสาร", image: "รูปภาพ", note: "โน้ต", other: "อื่น ๆ" }[item.sourceType] || "";
  const attachments = await Promise.all(files.map(async (f) => {
    const url = await thumbFor(f.id);
    const isImg = (f.type || "").startsWith("image/");
    const dl = isImg || f.type === "application/pdf" ? "" : ` download="${esc(f.name)}"`;
    return `<a class="attach" href="${url}" target="_blank" rel="noopener"${dl}>
      ${isImg ? `<img src="${url}" alt="${esc(f.name)}"/>` : `<div class="ph">${f.type === "application/pdf" ? "PDF" : esc((f.name.split(".").pop() || "FILE").toUpperCase())}</div>`}
      <span title="${esc(f.name)}">${esc(f.name)}</span></a>`;
  }));

  const body = [];
  body.push(`<div class="detail-meta">
      <select class="input" id="item-cat" style="width:auto;min-width:180px">${categoryOptions(item.categoryId)}</select>
      <span>บันทึก ${fmtDateTime(item.createdAt)}</span>
      ${typeLabel ? `<span class="tag">${typeLabel}</span>` : ""}
      ${item.url ? `<a href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">🔗 ${esc(host)}</a>` : ""}
    </div>`);
  if (item.status === "processing") body.push(`<div class="summary-box"><span class="spin"></span> AI กำลังอ่านและสรุป…</div>`);
  if (item.status === "pending") body.push(`<div class="summary-box muted">ยังไม่ได้สรุป — กด "ให้ AI สรุปใหม่" ด้านล่าง</div>`);
  if (item.status === "error") body.push(`<div class="error-box">${esc(item.error || "สรุปไม่สำเร็จ")}</div>`);
  if (item.suggestedCategory && !catById(item.categoryId)) {
    body.push(`<div class="banner" style="margin:0"><span>AI แนะนำหมวดใหม่: <b>${esc(item.suggestedCategory)}</b></span>
      <button class="btn btn-sm btn-ink" type="button" id="item-create-cat">สร้างหมวดนี้และย้ายเข้าไป</button></div>`);
  }
  if (item.summary) body.push(`<div class="section-title">สรุป</div><div class="summary-box">${esc(item.summary)}</div>`);
  if (item.keyPoints?.length) body.push(`<div class="section-title">ประเด็นสำคัญ</div><ul class="keypoints">${item.keyPoints.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>`);
  if (item.tags?.length) body.push(`<div class="tags">${item.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join("")}</div>`);
  if (item.note) body.push(`<div class="section-title">โน้ต / ข้อความที่บันทึก</div><div class="note-box">${esc(item.note)}</div>`);
  if (attachments.length) body.push(`<div class="section-title">ไฟล์แนบ</div><div class="attach-grid">${attachments.join("")}</div>`);
  if (item.processedAt) body.push(`<div class="faint" style="font-size:12.5px">สรุปเมื่อ ${fmtDateTime(item.processedAt)}${item.model ? " · " + esc(item.model) : ""}</div>`);
  $("#item-body").innerHTML = body.join("");
  $("#item-reprocess").disabled = item.status === "processing";
  $("#item-reprocess").textContent = item.status === "done" ? "ให้ AI สรุปใหม่" : "ให้ AI สรุป";
}

/* ========================================================= categories == */
let catDraft = [];

function openCats() {
  catDraft = state.categories.map((c) => ({ ...c }));
  renderCatDraft();
  $("#dlg-cats").showModal();
}
function renderCatDraft() {
  $("#cat-list").innerHTML = catDraft.map((c, i) => `
    <div class="cat-row" data-i="${i}">
      <input type="color" value="${esc(c.color)}" data-f="color" aria-label="สีของหมวด"/>
      <div class="stack">
        <input class="input" value="${esc(c.name)}" data-f="name" placeholder="ชื่อหมวด"/>
        <textarea class="input" data-f="description" rows="2" style="min-height:58px" placeholder="หมวดนี้เก็บเรื่องอะไร (AI ใช้คำอธิบายนี้จัดหมวด)">${esc(c.description || "")}</textarea>
      </div>
      <div class="row-actions" style="display:flex;flex-direction:column;gap:4px">
        <button class="btn btn-ghost btn-sm" type="button" data-move="-1" ${i === 0 ? "disabled" : ""} aria-label="เลื่อนขึ้น">↑</button>
        <button class="btn btn-ghost btn-sm" type="button" data-move="1" ${i === catDraft.length - 1 ? "disabled" : ""} aria-label="เลื่อนลง">↓</button>
        <button class="btn btn-danger btn-sm" type="button" data-del aria-label="ลบหมวด">ลบ</button>
      </div>
    </div>`).join("") || `<p class="muted">ยังไม่มีหมวด — เพิ่มอย่างน้อย 1 หมวด</p>`;
}
async function saveCats() {
  const cleaned = catDraft.map((c, i) => ({ ...c, name: c.name.trim(), description: (c.description || "").trim(), order: i }));
  if (cleaned.some((c) => !c.name)) { toast("ทุกหมวดต้องมีชื่อ"); return; }
  const removed = state.categories.filter((c) => !cleaned.find((d) => d.id === c.id));
  for (const c of removed) await db.del("categories", c.id);
  await db.putMany("categories", cleaned);
  // รายการในหมวดที่ถูกลบ → ยังไม่จัดหมวด
  const orphans = state.items.filter((i) => removed.some((c) => c.id === i.categoryId));
  orphans.forEach((i) => { i.categoryId = null; i.categoryLocked = false; });
  if (orphans.length) await db.putMany("items", orphans);
  state.categories = cleaned;
  if (removed.some((c) => c.id === state.view)) state.view = "all";
  $("#dlg-cats").close();
  render();
  toast("บันทึกหมวดแล้ว" + (orphans.length ? ` — ${orphans.length} รายการย้ายไป "ยังไม่จัดหมวด"` : ""));
}

/* ============================================================ settings == */
function openSettings() {
  $("#set-key").value = settings.apiKey;
  $("#set-model").value = settings.model;
  $("#set-lang").value = settings.lang;
  $("#set-theme").value = settings.theme;
  $("#set-test-result").textContent = "";
  $("#dlg-settings").showModal();
}
function readSettingsForm() {
  settings.apiKey = $("#set-key").value.trim();
  settings.model = $("#set-model").value;
  settings.lang = $("#set-lang").value;
  settings.theme = $("#set-theme").value;
}
async function testConnection() {
  readSettingsForm();
  const out = $("#set-test-result");
  out.innerHTML = `<span class="spin"></span> กำลังทดสอบ…`;
  try {
    const client = await getClient();
    const { params, betas } = modelConfig("low");
    const res = await client.beta.messages.create({ ...params, max_tokens: 64, messages: [{ role: "user", content: "Reply with: OK" }], betas });
    out.textContent = res.content.some((b) => b.type === "text") ? "✅ เชื่อมต่อสำเร็จ" : "✅ เชื่อมต่อได้";
  } catch (err) {
    out.textContent = "❌ " + explainApiError(err, _Anthropic);
  }
}

/* ------------------------------------------------------ backup/restore -- */
async function exportJson() {
  toast("กำลังเตรียมไฟล์สำรอง…");
  const files = await db.all("files");
  const payload = {
    app: "knowledge-vault", version: 1, exportedAt: new Date().toISOString(),
    categories: state.categories, items: state.items,
    files: await Promise.all(files.map(async (f) => ({ id: f.id, itemId: f.itemId, name: f.name, type: f.type, size: f.size, addedAt: f.addedAt, data: await blobToBase64(f.blob) }))),
  };
  download(`knowledge-vault-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(payload), "application/json");
}

function exportMarkdown() {
  const out = [`# คลังความรู้\n\nส่งออกเมื่อ ${fmtDateTime(Date.now())}\n`];
  const groups = [...state.categories.map((c) => [c, state.items.filter((i) => i.categoryId === c.id)]), [{ name: "ยังไม่จัดหมวด" }, state.items.filter((i) => !catById(i.categoryId))]];
  for (const [cat, items] of groups) {
    if (!items.length && !cat.digest) continue;
    out.push(`\n# ${cat.name}\n`);
    if (cat.description) out.push(`> ${cat.description}\n`);
    if (cat.digest) out.push(`\n${cat.digest.markdown.replace(/\[#(\d+)\]/g, (m, n) => { const it = state.items.find((x) => x.id === cat.digest.refs[n - 1]); return it ? `[${it.title || "#" + n}]` : m; })}\n`);
    for (const i of items) {
      out.push(`\n## ${i.title || i.url || "ไม่มีชื่อ"}\n`);
      const meta = [fmtDate(i.createdAt), i.url ? `<${i.url}>` : "", i.tags?.length ? i.tags.map((t) => "#" + t).join(" ") : ""].filter(Boolean).join(" · ");
      out.push(`_${meta}_\n`);
      if (i.summary) out.push(`\n${i.summary}\n`);
      if (i.keyPoints?.length) out.push("\n" + i.keyPoints.map((p) => `- ${p}`).join("\n") + "\n");
      if (i.note) out.push(`\n**โน้ต:** ${i.note}\n`);
    }
  }
  download(`knowledge-vault-${new Date().toISOString().slice(0, 10)}.md`, out.join(""), "text/markdown");
}

async function importJson(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { toast("ไฟล์ไม่ใช่ JSON ที่ถูกต้อง"); return; }
  if (!data || data.app !== "knowledge-vault" || !Array.isArray(data.items) || !Array.isArray(data.categories)) { toast("ไม่ใช่ไฟล์สำรองของคลังความรู้"); return; }
  if (!confirm(`นำเข้า ${data.items.length} รายการ และ ${data.categories.length} หมวด?\nรายการที่มี id ซ้ำจะถูกเขียนทับ ส่วนรายการอื่นจะยังอยู่`)) return;
  try {
    await db.putMany("categories", data.categories.filter((c) => c && c.id && c.name));
    await db.putMany("items", data.items.filter((i) => i && i.id).map((i) => ({ ...i, status: i.status === "processing" ? "pending" : i.status })));
    const files = (data.files || []).filter((f) => f && f.id && f.itemId && typeof f.data === "string");
    for (let k = 0; k < files.length; k += 20) {
      await db.putMany("files", files.slice(k, k + 20).map((f) => ({ id: f.id, itemId: f.itemId, name: f.name, type: f.type, size: f.size, addedAt: f.addedAt, blob: base64ToBlob(f.data, f.type) })));
    }
  } catch (err) { toast("นำเข้าไม่สำเร็จ: " + (err?.message || err)); return; }
  await loadAll();
  render();
  $("#dlg-settings").close();
  toast("นำเข้าข้อมูลเรียบร้อย");
}

async function wipeAll() {
  if (!confirm("ลบความรู้ หมวด และไฟล์แนบทั้งหมดในเครื่องนี้?\nการลบนี้ย้อนกลับไม่ได้ (แนะนำให้ส่งออกไฟล์สำรองก่อน)")) return;
  await Promise.all([db.clear("items"), db.clear("files"), db.clear("categories")]);
  state.items = []; state.categories = []; state.fileMeta = new Map(); state.view = "all";
  $("#dlg-settings").close();
  render();
  toast("ลบข้อมูลทั้งหมดแล้ว");
}

/* ---------------------------------------------------- share target inbox -- */
async function consumeShareInbox() {
  if (!new URLSearchParams(location.search).has("share")) return;
  history.replaceState(null, "", location.pathname);
  const entries = await new Promise((resolve) => {
    const req = indexedDB.open("kv-share-inbox", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("inbox", { keyPath: "id" });
    req.onerror = () => resolve([]);
    req.onsuccess = () => {
      const d = req.result;
      const tx = d.transaction("inbox", "readwrite");
      const s = tx.objectStore("inbox");
      const g = s.getAll();
      g.onsuccess = () => { s.clear(); };
      tx.oncomplete = () => resolve(g.result || []);
      tx.onerror = () => resolve([]);
    };
  });
  if (!entries.length) return;
  const e = entries[entries.length - 1];
  let url = isSafeUrl(e.url) ? e.url : "";
  let text = [e.title, e.text].filter(Boolean).join("\n").trim();
  if (!url) {
    const m = text.match(/https?:\/\/\S+/);
    if (m) { url = m[0]; text = text.replace(m[0], "").trim(); }
  }
  const files = (e.files || []).map((f) => new File([f.blob], f.name || "shared", { type: f.type || f.blob.type }));
  openAdd({ url, text, files });
}

/* ================================================================ events == */
function bindEvents() {
  // ปิด dialog
  document.querySelectorAll("dialog").forEach((d) => {
    d.addEventListener("click", (e) => {
      if (e.target.closest("[data-close]")) d.close();
      else if (e.target === d) d.close(); // คลิกพื้นหลัง
    });
  });
  $("#dlg-item").addEventListener("close", () => { openItemId = null; });

  $("#add-btn-top").onclick = () => openAdd();
  $("#fab").onclick = () => openAdd();
  $("#settings-btn").onclick = openSettings;

  let searchTimer;
  $("#search").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.query = e.target.value.trim(); renderMain(); }, 120);
  });

  $("#side").addEventListener("click", (e) => {
    if (e.target.closest("#manage-cats")) { openCats(); return; }
    const b = e.target.closest("[data-view]");
    if (!b) return;
    state.view = b.dataset.view;
    state.digestExpanded = false;
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  $("#main").addEventListener("click", async (e) => {
    const ref = e.target.closest("[data-ref]");
    if (ref) { openItem(ref.dataset.ref); return; }
    const card = e.target.closest("[data-item]");
    if (card) { openItem(card.dataset.item); return; }
    const a = e.target.closest("[data-action]");
    if (!a) return;
    const act = a.dataset.action;
    if (act === "add") openAdd();
    if (act === "open-settings") openSettings();
    if (act === "process-all") state.items.filter((i) => i.status === "pending" || i.status === "error").reverse().forEach((i) => enqueue(i.id));
    if (act === "digest") generateDigest(state.view);
    if (act === "toggle-digest") { state.digestExpanded = !state.digestExpanded; renderMain(); }
    if (act === "copy-digest") {
      const c = catById(state.view);
      try { await navigator.clipboard.writeText(c.digest.markdown); toast("คัดลอกแล้ว"); } catch { toast("คัดลอกไม่สำเร็จ"); }
    }
    if (act === "edit-cat") openCats();
  });

  /* --- add dialog --- */
  const drop = $("#drop"), fileInput = $("#add-files");
  drop.onclick = () => fileInput.click();
  drop.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); } };
  fileInput.onchange = () => { addPendingFiles([...fileInput.files]); fileInput.value = ""; };
  ["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => addPendingFiles([...(e.dataTransfer?.files || [])]));
  $("#add-file-list").addEventListener("click", (e) => {
    const r = e.target.closest("[data-remove]");
    if (r) { pendingFiles.splice(Number(r.dataset.remove), 1); renderPendingFiles(); }
  });
  $("#add-form").addEventListener("submit", (e) => { e.preventDefault(); submitAdd(true); });
  $("#add-save-only").onclick = () => submitAdd(false);

  // วาง (paste) รูป/ไฟล์/ลิงก์ — ในหน้าต่างเพิ่ม หรือที่หน้าหลักเพื่อเปิดหน้าต่างเพิ่มทันที
  document.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files || [])];
    const addOpen = $("#dlg-add").open;
    if (addOpen) {
      if (files.length) { e.preventDefault(); addPendingFiles(files); }
      return;
    }
    if (document.querySelector("dialog[open]")) return;
    const tag = (document.activeElement?.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea") return;
    const text = (e.clipboardData?.getData("text") || "").trim();
    if (!files.length && !text) return;
    e.preventDefault();
    const isUrl = isSafeUrl(text) && !/\s/.test(text);
    openAdd({ url: isUrl ? text : "", text: isUrl ? "" : text, files });
  });

  // ลากไฟล์มาวางที่ไหนก็ได้บนหน้า
  document.addEventListener("dragover", (e) => { if (e.dataTransfer?.types?.includes("Files")) e.preventDefault(); });
  document.addEventListener("drop", (e) => {
    if (e.target.closest("#drop") || !e.dataTransfer?.files?.length) return;
    e.preventDefault();
    if ($("#dlg-add").open) addPendingFiles([...e.dataTransfer.files]);
    else if (!document.querySelector("dialog[open]")) openAdd({ files: [...e.dataTransfer.files] });
  });

  /* --- item dialog --- */
  $("#item-body").addEventListener("change", async (e) => {
    if (e.target.id !== "item-cat") return;
    const item = state.items.find((i) => i.id === openItemId);
    if (!item) return;
    item.categoryId = e.target.value || null;
    item.categoryLocked = !!item.categoryId;
    await saveItem(item);
    render();
    fillItem(item.id);
    toast(item.categoryId ? `ย้ายไปหมวด "${catById(item.categoryId).name}" แล้ว` : "นำออกจากหมวดแล้ว");
  });
  $("#item-body").addEventListener("click", async (e) => {
    if (!e.target.closest("#item-create-cat")) return;
    const item = state.items.find((i) => i.id === openItemId);
    if (!item?.suggestedCategory) return;
    const cat = { id: uid("c"), name: item.suggestedCategory, description: "", color: PALETTE[state.categories.length % PALETTE.length], order: state.categories.length, createdAt: Date.now() };
    await db.put("categories", cat);
    state.categories.push(cat);
    item.categoryId = cat.id; item.suggestedCategory = ""; item.categoryLocked = true;
    await saveItem(item);
    render(); fillItem(item.id);
    toast(`สร้างหมวด "${cat.name}" แล้ว — เพิ่มคำอธิบายได้ที่ จัดการหมวด`);
  });
  $("#item-reprocess").onclick = () => {
    const item = state.items.find((i) => i.id === openItemId);
    if (!item) return;
    if (!settings.apiKey) { toast("ใส่ API key ก่อน", { label: "ตั้งค่า", run: openSettings }); return; }
    enqueue(item.id);
    fillItem(item.id);
  };
  $("#item-delete").onclick = async () => {
    const item = state.items.find((i) => i.id === openItemId);
    if (!item || !confirm("ลบความรู้ชิ้นนี้และไฟล์แนบ?")) return;
    const files = await db.filesOf(item.id);
    for (const f of files) {
      await db.del("files", f.id);
      if (thumbUrls.has(f.id)) { URL.revokeObjectURL(thumbUrls.get(f.id)); thumbUrls.delete(f.id); }
    }
    await db.del("items", item.id);
    state.items = state.items.filter((i) => i.id !== item.id);
    state.fileMeta.delete(item.id);
    $("#dlg-item").close();
    render();
    toast("ลบแล้ว");
  };
  $("#item-edit").onclick = () => {
    const item = state.items.find((i) => i.id === openItemId);
    if (!item) return;
    $("#ed-title").value = item.title || "";
    $("#ed-summary").value = item.summary || "";
    $("#ed-points").value = (item.keyPoints || []).join("\n");
    $("#ed-tags").value = (item.tags || []).join(", ");
    $("#ed-note").value = item.note || "";
    $("#dlg-edit").showModal();
  };
  $("#edit-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const item = state.items.find((i) => i.id === openItemId);
    if (!item) { $("#dlg-edit").close(); return; }
    item.title = $("#ed-title").value.trim();
    item.summary = $("#ed-summary").value.trim();
    item.keyPoints = $("#ed-points").value.split("\n").map((s) => s.trim().replace(/^[-•*]\s*/, "")).filter(Boolean);
    item.tags = $("#ed-tags").value.split(",").map((s) => s.trim().replace(/^#/, "")).filter(Boolean);
    item.note = $("#ed-note").value.trim();
    if (item.status !== "done" && (item.summary || item.title)) { item.status = "done"; item.error = ""; }
    await saveItem(item);
    $("#dlg-edit").close();
    render(); fillItem(item.id);
    toast("บันทึกการแก้ไขแล้ว");
  });

  /* --- categories dialog --- */
  $("#cat-list").addEventListener("input", (e) => {
    const row = e.target.closest("[data-i]");
    const f = e.target.dataset.f;
    if (row && f) catDraft[Number(row.dataset.i)][f] = e.target.value;
  });
  $("#cat-list").addEventListener("click", (e) => {
    const row = e.target.closest("[data-i]");
    if (!row) return;
    const i = Number(row.dataset.i);
    if (e.target.closest("[data-del]")) {
      const n = state.items.filter((x) => x.categoryId === catDraft[i].id).length;
      if (n && !confirm(`หมวด "${catDraft[i].name}" มี ${n} รายการ — รายการเหล่านี้จะย้ายไป "ยังไม่จัดหมวด" (ยืนยันเมื่อกดบันทึก)`)) return;
      catDraft.splice(i, 1); renderCatDraft();
    }
    const mv = e.target.closest("[data-move]");
    if (mv) {
      const j = i + Number(mv.dataset.move);
      [catDraft[i], catDraft[j]] = [catDraft[j], catDraft[i]];
      renderCatDraft();
    }
  });
  $("#cat-add").onclick = () => {
    catDraft.push({ id: uid("c"), name: "", description: "", color: PALETTE[catDraft.length % PALETTE.length], createdAt: Date.now() });
    renderCatDraft();
    const inputs = $("#cat-list").querySelectorAll('[data-f="name"]');
    inputs[inputs.length - 1]?.focus();
  };
  $("#cat-save").onclick = saveCats;

  /* --- settings dialog --- */
  $("#set-save").onclick = () => {
    const hadKey = !!settings.apiKey;
    readSettingsForm();
    saveSettings();
    $("#dlg-settings").close();
    render();
    toast("บันทึกการตั้งค่าแล้ว");
    if (!hadKey && settings.apiKey) {
      const n = state.items.filter((i) => i.status === "pending").length;
      if (n) toast(`มี ${n} รายการรอสรุป`, { label: "สรุปเลย", run: () => state.items.filter((i) => i.status === "pending").reverse().forEach((i) => enqueue(i.id)) });
    }
  };
  $("#set-test").onclick = testConnection;
  $("#set-export").onclick = exportJson;
  $("#set-export-md").onclick = exportMarkdown;
  $("#set-import").onclick = () => $("#set-import-file").click();
  $("#set-import-file").onchange = (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) importJson(f); };
  $("#set-wipe").onclick = wipeAll;

  window.addEventListener("online", () => toast("กลับมาออนไลน์แล้ว"));
}

/* ================================================================== PWA == */
function setupPwa() {
  let deferred = null;
  const btn = $("#install-btn");
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferred = e; btn.classList.add("show"); });
  btn.onclick = async () => {
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice.catch(() => null);
    deferred = null;
    btn.classList.remove("show");
  };
  window.addEventListener("appinstalled", () => btn.classList.remove("show"));

  if (!("serviceWorker" in navigator) || location.protocol === "file:") return;
  navigator.serviceWorker.register("./sw.js").then((reg) => {
    const ask = (w) => toast("มีเวอร์ชันใหม่ของแอป", { label: "อัปเดต", run: () => w.postMessage({ type: "SKIP_WAITING" }) });
    if (reg.waiting && navigator.serviceWorker.controller) ask(reg.waiting);
    reg.addEventListener("updatefound", () => {
      const w = reg.installing;
      w?.addEventListener("statechange", () => { if (w.state === "installed" && navigator.serviceWorker.controller) ask(w); });
    });
  }).catch(() => { /* ไม่มี SW ก็ยังใช้งานได้ */ });
  // รีโหลดเฉพาะตอน "อัปเดต" เวอร์ชัน — ไม่ใช่ตอนติดตั้ง service worker ครั้งแรก
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (hadController && !reloaded) { reloaded = true; location.reload(); } });
}

/* ================================================================= boot == */
(async function boot() {
  bindEvents();
  setupPwa();
  try {
    await loadAll();
  } catch (err) {
    $("#main").innerHTML = `<div class="empty"><h2>เปิดฐานข้อมูลไม่ได้</h2><p>${esc(err?.message || err)}</p><p class="faint">เบราว์เซอร์อาจปิดการเก็บข้อมูลไว้ (เช่นโหมดส่วนตัวบางแบบ)</p></div>`;
    return;
  }
  render();
  consumeShareInbox();
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
})();
