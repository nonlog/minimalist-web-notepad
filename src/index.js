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
      headers: commonHeaders({ "Allow": "GET, HEAD, POST" }),
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
    headers: commonHeaders({ "Location": target.pathname }),
  });
}

function randomNoteName() {
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => RANDOM_ALPHABET[byte % RANDOM_ALPHABET.length]).join("");
}

async function saveNote(request, env, note) {
  const text = await readTextFromRequest(request);
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

async function readTextFromRequest(request) {
  const contentType = request.headers.get("content-type") || "";

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const form = await request.formData();
    const value = form.get("text");
    return typeof value === "string" ? value : "";
  }

  return request.text();
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

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeNote}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
body {
  margin: 0;
  background: #ebeef1;
}
.container {
  position: absolute;
  inset: 20px;
}
#content {
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  margin: 0;
  padding: 20px;
  overflow-y: auto;
  resize: none;
  border: 1px solid #ddd;
  border-radius: 0;
  outline: none;
  font: 16px/1.5 ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
}
#printable {
  display: none;
}
@media (prefers-color-scheme: dark) {
  body {
    background: #333b4d;
  }
  #content {
    background: #24262b;
    color: #fff;
    border-color: #495265;
  }
}
@media print {
  .container {
    display: none;
  }
  #printable {
    display: block;
    white-space: pre-wrap;
    word-break: break-word;
  }
}
</style>
</head>
<body>
<div class="container">
<textarea id="content" spellcheck="false">${safeText}</textarea>
</div>
<pre id="printable">${safeText}</pre>
<script>
const textarea = document.getElementById("content");
const printable = document.getElementById("printable");
let saved = textarea.value;
let inFlight = false;
let timer = 0;

function scheduleUpload(delay = 700) {
  clearTimeout(timer);
  timer = setTimeout(uploadContent, delay);
}

async function uploadContent() {
  if (inFlight || saved === textarea.value) {
    return;
  }

  const next = textarea.value;
  inFlight = true;
  try {
    const body = new URLSearchParams({ text: next });
    const response = await fetch(location.href, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body
    });
    if (!response.ok) {
      throw new Error("Save failed");
    }
    saved = next;
    printable.textContent = next;
  } catch {
    scheduleUpload(1000);
  } finally {
    inFlight = false;
    if (saved !== textarea.value) {
      scheduleUpload(200);
    }
  }
}

textarea.addEventListener("input", () => {
  printable.textContent = textarea.value;
  scheduleUpload();
});
textarea.focus();
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
