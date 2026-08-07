const NOTE_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const RANDOM_ALPHABET = "234579abcdefghjkmnpqrstwxyz";
const DEFAULT_MAX_BYTES = 256 * 1024;

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },
};

export async function handleRequest(request, env) {
  const url = new URL(request.url);
  const pathname = url.pathname;

  if (pathname === "/robots.txt") {
    return textResponse("User-agent: *\nDisallow: /\n", 200, "text/plain");
  }

  if (pathname === "/favicon.svg") {
    return textResponse(faviconSvg(), 200, "image/svg+xml");
  }

  const note = parseNoteName(pathname);
  if (!note) {
    return redirectToRandomNote(url);
  }

  if (!env?.NOTES) {
    return textResponse("Missing NOTES KV binding.\n", 500, "text/plain");
  }

  if (request.method === "POST") {
    return saveNote(request, env, note);
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, {
      status: 405,
      headers: commonHeaders({ Allow: "GET, HEAD, POST" }),
    });
  }

  const raw = url.searchParams.has("raw") || isCliClient(request);
  const text = await env.NOTES.get(note);

  if (raw) {
    if (text === null) {
      return textResponse("Not found.\n", 404, "text/plain");
    }
    return textResponse(text, 200, "text/plain");
  }

  return htmlResponse(renderPage(note, text ?? ""));
}

function parseNoteName(pathname) {
  const note = pathname.replace(/^\/+|\/+$/g, "");
  return NOTE_RE.test(note) ? note : "";
}

function redirectToRandomNote(url) {
  const target = new URL(`/${randomNoteName()}`, url);
  return new Response(null, {
    status: 302,
    headers: commonHeaders({ Location: target.pathname }),
  });
}

function randomNoteName() {
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => RANDOM_ALPHABET[byte % RANDOM_ALPHABET.length]).join("");
}

async function saveNote(request, env, note) {
  const text = await request.text();
  const maxBytes = parsePositiveInt(env.NOTE_MAX_BYTES, DEFAULT_MAX_BYTES);
  const byteLength = new TextEncoder().encode(text).length;

  if (byteLength > maxBytes) {
    return textResponse(`Note is too large. Limit is ${maxBytes} bytes.\n`, 413, "text/plain");
  }

  if (text.length === 0) {
    await env.NOTES.delete(note);
  } else {
    const ttl = parsePositiveInt(env.NOTE_TTL_SECONDS, 0);
    const options = ttl > 0 ? { expirationTtl: ttl } : undefined;
    await env.NOTES.put(note, text, options);
  }

  return new Response(null, {
    status: 204,
    headers: commonHeaders(),
  });
}

function isCliClient(request) {
  const userAgent = request.headers.get("user-agent") || "";
  return /^curl\//i.test(userAgent) || /^Wget\//.test(userAgent);
}

function htmlResponse(html) {
  return textResponse(html, 200, "text/html");
}

function textResponse(body, status, contentType) {
  return new Response(body, {
    status,
    headers: commonHeaders({
      "Content-Type": `${contentType}; charset=utf-8`,
    }),
  });
}

function commonHeaders(extra = {}) {
  return {
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
    ...extra,
  };
}

function renderPage(note, text) {
  const safeNote = escapeHtml(note);
  const safeText = escapeHtml(text);

  return String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeNote}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
:root { color-scheme: light dark; }
html, body { width: 100%; height: 100%; }
body { margin: 0; background: #ebeef1; }
.container {
  position: absolute;
  inset: 20px;
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  gap: 10px;
}
.toolbar {
  display: flex;
  flex: 0 0 auto;
  justify-content: flex-end;
  gap: 4px;
}
.view-button {
  padding: 5px 9px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: #5b6472;
  font: 12px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  cursor: pointer;
}
.view-button:hover { background: rgba(255,255,255,.55); }
.view-button[aria-pressed="true"] {
  border-color: #cfd5dc;
  background: #fff;
  color: #1f2937;
}
.workspace {
  display: grid;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
}
.workspace[data-mode="edit"] { grid-template-columns: minmax(0,1fr); }
.workspace[data-mode="edit"] #preview { display: none; }
.workspace[data-mode="preview"] { grid-template-columns: minmax(0,1fr); }
.workspace[data-mode="preview"] #content { display: none; }
.workspace[data-mode="split"] {
  grid-template-columns: minmax(0,1fr) minmax(0,1fr);
  gap: 12px;
}
#content, #preview {
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  margin: 0;
  overflow: auto;
  border: 1px solid #ddd;
  border-radius: 0;
  background: #fff;
  color: #111827;
}
#content {
  padding: 20px;
  resize: none;
  outline: none;
  font: 16px/1.5 ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
}
#preview {
  padding: 20px 28px 40px;
  font: 16px/1.65 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  overflow-wrap: anywhere;
}
#preview:empty::before { content: "Nothing to preview"; color: #9ca3af; }
#preview > :first-child { margin-top: 0; }
#preview > :last-child { margin-bottom: 0; }
#preview h1, #preview h2, #preview h3, #preview h4, #preview h5, #preview h6 {
  margin: 1.25em 0 .55em;
  line-height: 1.25;
}
#preview h1 { font-size: 2em; }
#preview h2 { padding-bottom: .25em; border-bottom: 1px solid #e5e7eb; font-size: 1.55em; }
#preview h3 { font-size: 1.25em; }
#preview p, #preview ul, #preview ol, #preview blockquote, #preview pre { margin: 0 0 1em; }
#preview ul, #preview ol { padding-left: 1.7em; }
#preview li + li { margin-top: .25em; }
#preview blockquote { padding: 0 0 0 1em; border-left: 3px solid #cbd5e1; color: #5b6472; }
#preview code {
  padding: .12em .35em;
  border-radius: 4px;
  background: #f1f5f9;
  font: .92em/1.5 ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
}
#preview pre { padding: 14px 16px; overflow: auto; border-radius: 6px; background: #f1f5f9; }
#preview pre code { padding: 0; background: transparent; }
#preview a { color: #2563eb; text-decoration: none; }
#preview a:hover { text-decoration: underline; }
#preview hr { margin: 1.5em 0; border: 0; border-top: 1px solid #d1d5db; }
#preview input[type="checkbox"] { margin: 0 .45em 0 -1.35em; vertical-align: middle; }
#printable { display: none; }
@media (max-width: 760px) {
  .container { inset: 10px; }
  .toolbar { justify-content: center; }
  .workspace[data-mode="split"] {
    grid-template-columns: minmax(0,1fr);
    grid-template-rows: minmax(0,1fr) minmax(0,1fr);
  }
  #preview { padding: 18px 20px 32px; }
}
@media (prefers-color-scheme: dark) {
  body { background: #333b4d; }
  .view-button { color: #b9c1cd; }
  .view-button:hover { background: rgba(255,255,255,.08); }
  .view-button[aria-pressed="true"] { border-color: #596274; background: #24262b; color: #fff; }
  #content, #preview { border-color: #495265; background: #24262b; color: #fff; }
  #preview h2 { border-bottom-color: #495265; }
  #preview blockquote { border-left-color: #64748b; color: #cbd5e1; }
  #preview code, #preview pre { background: #17191d; }
  #preview pre code { background: transparent; }
  #preview a { color: #93c5fd; }
  #preview hr { border-top-color: #495265; }
}
@media print {
  .container { display: none; }
  #printable { display: block; white-space: pre-wrap; word-break: break-word; }
}
</style>
</head>
<body>
<div class="container">
  <div class="toolbar" role="toolbar" aria-label="View mode">
    <button class="view-button" type="button" data-mode-button="edit" aria-pressed="true">Edit</button>
    <button class="view-button" type="button" data-mode-button="split" aria-pressed="false">Split</button>
    <button class="view-button" type="button" data-mode-button="preview" aria-pressed="false">Preview</button>
  </div>
  <div class="workspace" data-mode="edit">
    <textarea id="content" spellcheck="false" aria-label="Note editor">${safeText}</textarea>
    <article id="preview" aria-label="Markdown preview"></article>
  </div>
</div>
<pre id="printable">${safeText}</pre>
<script>
const textarea = document.getElementById("content");
const printable = document.getElementById("printable");
const preview = document.getElementById("preview");
const workspace = document.querySelector(".workspace");
const modeButtons = Array.from(document.querySelectorAll("[data-mode-button]"));
const modeKey = "minimalist-web-notepad:view-mode";
let saved = textarea.value;
let inFlight = false;
let timer = 0;
let renderQueued = false;

function scheduleUpload(delay = 700) {
  clearTimeout(timer);
  timer = setTimeout(uploadContent, delay);
}

async function uploadContent() {
  if (inFlight || saved === textarea.value) return;
  const next = textarea.value;
  inFlight = true;
  try {
    const response = await fetch(location.href, {
      method: "POST",
      headers: { "Content-Type": "text/plain; charset=UTF-8" },
      body: next,
    });
    if (!response.ok) throw new Error("Save failed");
    saved = next;
    printable.textContent = next;
  } catch {
    scheduleUpload(1000);
  } finally {
    inFlight = false;
    if (saved !== textarea.value) scheduleUpload(200);
  }
}

function getStoredMode() {
  try {
    const mode = localStorage.getItem(modeKey);
    return mode === "edit" || mode === "split" || mode === "preview" ? mode : null;
  } catch { return null; }
}
function storeMode(mode) {
  try { localStorage.setItem(modeKey, mode); } catch {}
}
function setMode(mode, persist = true) {
  workspace.dataset.mode = mode;
  for (const button of modeButtons) {
    button.setAttribute("aria-pressed", String(button.dataset.modeButton === mode));
  }
  if (mode !== "edit") {
    renderMarkdown(textarea.value);
    syncPreviewScroll();
  }
  if (persist) storeMode(mode);
  if (mode !== "preview") textarea.focus();
}
function schedulePreview() {
  if (workspace.dataset.mode === "edit" || renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderMarkdown(textarea.value);
    syncPreviewScroll();
  });
}
function syncPreviewScroll() {
  if (workspace.dataset.mode !== "split") return;
  const editorRange = textarea.scrollHeight - textarea.clientHeight;
  const previewRange = preview.scrollHeight - preview.clientHeight;
  if (editorRange <= 0 || previewRange <= 0) {
    preview.scrollTop = 0;
    return;
  }
  preview.scrollTop = (textarea.scrollTop / editorRange) * previewRange;
}

function renderMarkdown(source) {
  const fragment = document.createDocumentFragment();
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (/^\s*$/.test(line)) { index += 1; continue; }
    const fence = line.match(/^\s*\x60\x60\x60([^\x60]*)$/);
    if (fence) {
      const codeLines = [];
      index += 1;
      while (index < lines.length && !/^\s*\x60\x60\x60\s*$/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      const language = fence[1].trim();
      if (language) code.dataset.language = language;
      code.textContent = codeLines.join("\n");
      pre.append(code);
      fragment.append(pre);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const element = document.createElement("h" + heading[1].length);
      appendInline(element, heading[2]);
      fragment.append(element);
      index += 1;
      continue;
    }
    if (/^\s{0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/.test(line)) {
      fragment.append(document.createElement("hr"));
      index += 1;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote = document.createElement("blockquote");
      while (index < lines.length) {
        const match = lines[index].match(/^\s*>\s?(.*)$/);
        if (!match) break;
        if (quote.childNodes.length) quote.append(document.createElement("br"));
        appendInline(quote, match[1]);
        index += 1;
      }
      fragment.append(quote);
      continue;
    }
    const list = parseListItem(line);
    if (list) {
      const listElement = document.createElement(list.ordered ? "ol" : "ul");
      while (index < lines.length) {
        const item = parseListItem(lines[index]);
        if (!item || item.ordered !== list.ordered) break;
        const li = document.createElement("li");
        const task = item.text.match(/^\[( |x|X)\]\s+(.*)$/);
        if (task) {
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.disabled = true;
          checkbox.checked = task[1].toLowerCase() === "x";
          li.append(checkbox);
          appendInline(li, task[2]);
        } else {
          appendInline(li, item.text);
        }
        listElement.append(li);
        index += 1;
      }
      fragment.append(listElement);
      continue;
    }
    const paragraphLines = [];
    while (index < lines.length && !/^\s*$/.test(lines[index]) && !isBlockStart(lines[index])) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    if (paragraphLines.length === 0) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    const paragraph = document.createElement("p");
    paragraphLines.forEach((paragraphLine, lineIndex) => {
      if (lineIndex > 0) paragraph.append(document.createElement("br"));
      appendInline(paragraph, paragraphLine);
    });
    fragment.append(paragraph);
  }
  preview.replaceChildren(fragment);
}
function isBlockStart(line) {
  return /^\s*\x60\x60\x60/.test(line) ||
    /^(#{1,6})\s+/.test(line) ||
    /^\s*>/.test(line) ||
    /^\s{0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/.test(line) ||
    Boolean(parseListItem(line));
}
function parseListItem(line) {
  const unordered = line.match(/^\s{0,3}[-+*]\s+(.*)$/);
  if (unordered) return { ordered: false, text: unordered[1] };
  const ordered = line.match(/^\s{0,3}\d+[.)]\s+(.*)$/);
  if (ordered) return { ordered: true, text: ordered[1] };
  return null;
}
function appendInline(parent, text) {
  const tokenPattern = /(\x60[^\x60\n]+\x60|\[[^\]\n]+\]\([^\s)]+\)|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\*[^*\n]+\*|_[^_\n]+_)/g;
  let cursor = 0;
  for (const match of text.matchAll(tokenPattern)) {
    if (match.index > cursor) parent.append(document.createTextNode(text.slice(cursor, match.index)));
    const token = match[0];
    if (token.charCodeAt(0) === 96) {
      const code = document.createElement("code");
      code.textContent = token.slice(1, -1);
      parent.append(code);
    } else if (token.startsWith("[")) {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      const href = link ? safeHref(link[2]) : "";
      if (link && href) {
        const anchor = document.createElement("a");
        anchor.href = href;
        anchor.rel = "noopener noreferrer";
        appendInline(anchor, link[1]);
        parent.append(anchor);
      } else parent.append(document.createTextNode(token));
    } else if (token.startsWith("**") || token.startsWith("__")) {
      const strong = document.createElement("strong");
      appendInline(strong, token.slice(2, -2));
      parent.append(strong);
    } else if (token.startsWith("~~")) {
      const del = document.createElement("del");
      appendInline(del, token.slice(2, -2));
      parent.append(del);
    } else {
      const em = document.createElement("em");
      appendInline(em, token.slice(1, -1));
      parent.append(em);
    }
    cursor = match.index + token.length;
  }
  if (cursor < text.length) parent.append(document.createTextNode(text.slice(cursor)));
}
function safeHref(value) {
  try {
    const url = new URL(value, location.href);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:" ? url.href : "";
  } catch { return ""; }
}
textarea.addEventListener("input", () => {
  printable.textContent = textarea.value;
  scheduleUpload();
  schedulePreview();
});
textarea.addEventListener("scroll", syncPreviewScroll, { passive: true });
for (const button of modeButtons) button.addEventListener("click", () => setMode(button.dataset.modeButton));
window.addEventListener("beforeprint", () => { printable.textContent = textarea.value; });
setMode(getStoredMode() || "edit", false);
</script>
</body>
</html>`;
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function faviconSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="8" fill="#ebeef1"/>
  <path d="M18 14h28v38H18z" fill="#fff" stroke="#9aa4b2" stroke-width="3"/>
  <path d="M24 24h20M24 32h20M24 40h14" stroke="#475569" stroke-width="3" stroke-linecap="round"/>
</svg>`;
}
