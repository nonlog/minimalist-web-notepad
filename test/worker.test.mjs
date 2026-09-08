import assert from "node:assert/strict";
import test from "node:test";
import {
  canUseUnderscoreEmphasis,
  cleanupExpiredFiles,
  getMarkdownListEdit,
  handleRequest,
  isMarkdownHorizontalRule,
  normalizeViewMode,
  parseMarkdownListItem,
  sanitizeFilename,
} from "../src/index.js";

test("root redirects to a random note path", async () => {
  const response = await handleRequest(new Request("https://example.com/"), env());

  assert.equal(response.status, 302);
  assert.match(response.headers.get("location"), /^\/[234579abcdefghjkmnpqrstwxyz]{5}$/);
});

test("saves, reads, and deletes note content", async () => {
  const bindings = env();

  const save = await handleRequest(
    new Request("https://example.com/demo", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ text: "hello\nworld" }),
    }),
    bindings,
  );
  assert.equal(save.status, 204);

  const raw = await handleRequest(new Request("https://example.com/demo?raw"), bindings);
  assert.equal(raw.status, 200);
  assert.equal(await raw.text(), "hello\nworld");

  await bindings.NOTES.put("@view:demo", "split");
  const del = await handleRequest(
    new Request("https://example.com/demo", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ text: "" }),
    }),
    bindings,
  );
  assert.equal(del.status, 204);
  assert.equal(await bindings.NOTES.get("@view:demo"), null);

  const missing = await handleRequest(new Request("https://example.com/demo?raw"), bindings);
  assert.equal(missing.status, 404);
});

test("renders stored text safely in the page", async () => {
  const bindings = env();
  await bindings.NOTES.put("xss", "<script>alert(1)</script>");

  const response = await handleRequest(new Request("https://example.com/xss"), bindings);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<textarea[^>]*><script>/);
});

test("renders valid client-side Markdown editor code", async () => {
  const response = await handleRequest(new Request("https://example.com/shortcuts"), env());
  const html = await response.text();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];

  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));
  assert.match(script, /addEventListener\("keydown",handleListEnter\)/);
  assert.match(script, /isMarkdownHorizontalRule\(line\).*createElement\("hr"\)/s);
  assert.match(script, /function renderList\(/);
  assert.match(script, /function persistViewMode\(/);
  assert.doesNotMatch(script, /localStorage/);
  assert.ok(script.indexOf("const fence=") < script.indexOf("if(isMarkdownHorizontalRule(line))"));
});

test("includes mobile viewport and responsive layout safeguards", async () => {
  const response = await handleRequest(new Request("https://example.com/mobile"), env());
  const html = await response.text();

  assert.match(html, /viewport-fit=cover,interactive-widget=resizes-content/);
  assert.match(html, /safe-area-inset-top/);
  assert.match(html, /@media\(pointer:coarse\)\{\.view-button,\.share-link\{min-height:44px\}\}/);
  assert.match(html, /@media\(max-width:760px\).*grid-template-rows:minmax\(0,1fr\) minmax\(0,1fr\)/s);
  assert.match(html, /orientation:landscape.*grid-template-columns:minmax\(0,1fr\) minmax\(0,1fr\)/s);
  assert.match(html, /function syncAppHeight\(\)/);
  assert.match(html, /visualViewport\?\.addEventListener\("resize",syncAppHeight/);
  assert.match(html, /setMode\(initialMode,false,false\)/);
});

test("serves the protected file-share UI only on the note host", async () => {
  const bindings = env();
  const response = await handleRequest(new Request("https://note.414222.xyz/share"), bindings);
  const html = await response.text();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];

  assert.equal(response.status, 200);
  assert.match(html, /Temporary file share/);
  assert.match(html, /95 MiB/);
  assert.match(html, /value="1h"/);
  assert.match(html, /value="24h" selected/);
  assert.match(html, /value="7d"/);
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));

  const bypass = await handleRequest(new Request("https://minimalist-web-notepad.example.workers.dev/share"), bindings);
  assert.equal(bypass.status, 404);
});

test("uploads to R2 and downloads from the isolated file host", async () => {
  const bindings = env();
  const upload = await handleRequest(
    new Request("https://note.414222.xyz/api/share?ttl=1h&name=hello%20world.txt", {
      method: "PUT",
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: "hello file",
    }),
    bindings,
  );

  assert.equal(upload.status, 200);
  const data = await upload.json();
  assert.match(data.url, /^https:\/\/file\.414222\.xyz\/f\/[0-9a-z]+-[0-9a-f]{32}\/hello%20world\.txt$/);
  assert.equal(data.markdown, `[hello world.txt](${data.url})`);
  assert.equal(bindings.TEMP_FILES.size, 1);

  const download = await handleRequest(new Request(data.url), bindings);
  assert.equal(download.status, 200);
  assert.equal(await download.text(), "hello file");
  assert.equal(download.headers.get("content-type"), "text/plain");
  assert.match(download.headers.get("content-disposition"), /^attachment;/);
  assert.equal(download.headers.get("x-content-type-options"), "nosniff");
  assert.equal(download.headers.get("cache-control"), "no-store");

  const head = await handleRequest(new Request(data.url, { method: "HEAD" }), bindings);
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String("hello file".length));
  assert.equal(await head.text(), "");
});

test("rejects invalid or oversized temporary-file uploads", async () => {
  const bindings = env({ FILE_MAX_BYTES: "3" });
  const invalidTtl = await handleRequest(
    new Request("https://note.414222.xyz/api/share?ttl=forever&name=a.txt", { method: "PUT", body: "a" }),
    bindings,
  );
  assert.equal(invalidTtl.status, 400);

  const large = await handleRequest(
    new Request("https://note.414222.xyz/api/share?ttl=1h&name=a.txt", {
      method: "PUT",
      headers: { "content-length": "4" },
      body: "1234",
    }),
    bindings,
  );
  assert.equal(large.status, 413);
  assert.equal(bindings.TEMP_FILES.size, 0);
});

test("expired file links return 410 before touching R2", async () => {
  const bindings = env();
  const expired = (Math.floor(Date.now() / 1000) - 1).toString(36);
  const response = await handleRequest(
    new Request(`https://file.414222.xyz/f/${expired}-0123456789abcdef0123456789abcdef/old.txt`),
    bindings,
  );
  assert.equal(response.status, 410);
  assert.match(await response.text(), /expired/i);
});

test("hourly cleanup deletes expired R2 keys and keeps fresh objects", async () => {
  const r2 = new FakeR2();
  const oldKey = "tmp/1000/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const freshKey = "tmp/2000/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  await r2.put(oldKey, "old");
  await r2.put(freshKey, "fresh");

  const deleted = await cleanupExpiredFiles({ TEMP_FILES: r2 }, 1500);
  assert.equal(deleted, 1);
  assert.equal(r2.has(oldKey), false);
  assert.equal(r2.has(freshKey), true);
});

test("sanitizes filenames used in download headers and URLs", () => {
  assert.equal(sanitizeFilename("../bad\\name\u0000.txt"), ".._bad_name.txt");
  assert.equal(sanitizeFilename("   ...   "), "file");
});

test("note pages expose the file-share entry point", async () => {
  const response = await handleRequest(new Request("https://note.414222.xyz/demo"), env());
  const html = await response.text();
  assert.match(html, /href="https:\/\/note\.414222\.xyz\/share"/);
  assert.match(html, />Share<\/a>/);
});

test("recognizes Markdown horizontal rules", () => {
  for (const line of ["---", "***", "___", "- - -", "* * *", "_ _ _", "  ----  "]) {
    assert.equal(isMarkdownHorizontalRule(line), true, line);
  }

  for (const line of ["--", "__", "**", "- item", "--- text", "    ---"]) {
    assert.equal(isMarkdownHorizontalRule(line), false, line);
  }
});

test("parses nested Markdown list indentation", () => {
  assert.deepEqual(parseMarkdownListItem("- parent"), { indent: 0, ordered: false, text: "parent" });
  assert.deepEqual(parseMarkdownListItem("    - child"), { indent: 4, ordered: false, text: "child" });
  assert.deepEqual(parseMarkdownListItem("\t1. child"), { indent: 4, ordered: true, text: "child" });
  assert.equal(parseMarkdownListItem("plain text"), null);
});

test("does not treat intraword underscores as emphasis delimiters", () => {
  const value = "de.kai_morich.serial_bluetooth_terminal";
  const start = value.indexOf("_");
  const end = value.indexOf("_", start + 1);
  assert.equal(canUseUnderscoreEmphasis(value, start, end - start + 1), false);
  assert.equal(canUseUnderscoreEmphasis("_italic_", 0, 8), true);
  assert.equal(canUseUnderscoreEmphasis("a _word_ b", 2, 6), true);
});

test("stores view mode per note and defaults to edit", async () => {
  const bindings = env();
  await bindings.NOTES.put("demo", "hello");

  const defaultPage = await handleRequest(new Request("https://example.com/demo"), bindings);
  assert.match(await defaultPage.text(), /class="workspace" data-mode="edit"/);
  assert.equal(normalizeViewMode(null), "edit");

  const saveView = await handleRequest(
    new Request("https://example.com/demo?view=1", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ mode: "split" }),
    }),
    bindings,
  );
  assert.equal(saveView.status, 204);
  assert.equal(await bindings.NOTES.get("@view:demo"), "split");

  const splitPage = await handleRequest(new Request("https://example.com/demo"), bindings);
  const splitHtml = await splitPage.text();
  assert.match(splitHtml, /class="workspace" data-mode="split"/);
  assert.match(splitHtml, /data-mode-button="split" aria-pressed="true"/);

  const otherPage = await handleRequest(new Request("https://example.com/other"), bindings);
  assert.match(await otherPage.text(), /class="workspace" data-mode="edit"/);

  const resetView = await handleRequest(
    new Request("https://example.com/demo?view=1", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ mode: "edit" }),
    }),
    bindings,
  );
  assert.equal(resetView.status, 204);
  assert.equal(await bindings.NOTES.get("@view:demo"), null);
});

test("rejects invalid view modes", async () => {
  const response = await handleRequest(
    new Request("https://example.com/demo?view=1", { method: "POST", body: "fullscreen" }),
    env(),
  );
  assert.equal(response.status, 400);
});

test("continues ordered Markdown lists with the next number", () => {
  const value = "1. first";
  const edit = getMarkdownListEdit(value, value.length, value.length);

  assert.ok(edit);
  assert.equal(applyEdit(value, edit), "1. first\n2. ");
  assert.equal(edit.cursor, "1. first\n2. ".length);
});

test("continues unordered and task Markdown lists", () => {
  const bullet = "  - item";
  const bulletEdit = getMarkdownListEdit(bullet, bullet.length, bullet.length);
  assert.ok(bulletEdit);
  assert.equal(applyEdit(bullet, bulletEdit), "  - item\n  - ");

  const task = "- [x] done";
  const taskEdit = getMarkdownListEdit(task, task.length, task.length);
  assert.ok(taskEdit);
  assert.equal(applyEdit(task, taskEdit), "- [x] done\n- [ ] ");
});

test("exits a Markdown list from an empty item", () => {
  const value = "1. first\n2. ";
  const edit = getMarkdownListEdit(value, value.length, value.length);

  assert.ok(edit);
  assert.equal(applyEdit(value, edit), "1. first\n");
});

test("does not continue list-looking text inside fenced code", () => {
  const value = "```\n1. code";
  assert.equal(getMarkdownListEdit(value, value.length, value.length), null);
});

test("rejects oversized notes", async () => {
  const bindings = env({ NOTE_MAX_BYTES: "3" });
  const response = await handleRequest(
    new Request("https://example.com/large", {
      method: "POST",
      body: "1234",
    }),
    bindings,
  );

  assert.equal(response.status, 413);
});

function applyEdit(value, edit) {
  return value.slice(0, edit.start) + edit.text + value.slice(edit.end);
}

function env(overrides = {}) {
  return {
    NOTES: new FakeKV(),
    TEMP_FILES: new FakeR2(),
    NOTE_MAX_BYTES: "262144",
    NOTE_TTL_SECONDS: "0",
    FILE_UPLOAD_HOST: "note.414222.xyz",
    FILE_DOWNLOAD_HOST: "file.414222.xyz",
    FILE_MAX_BYTES: String(95 * 1024 * 1024),
    ...overrides,
  };
}

class FakeR2 {
  #values = new Map();

  get size() {
    return this.#values.size;
  }

  has(key) {
    return this.#values.has(key);
  }

  async put(key, body, options = {}) {
    const bytes = new Uint8Array(await new Response(body).arrayBuffer());
    this.#values.set(key, {
      bytes,
      httpMetadata: options.httpMetadata || {},
      customMetadata: options.customMetadata || {},
    });
  }

  async get(key) {
    const stored = this.#values.get(key);
    if (!stored) return null;
    return this.#object(stored, true);
  }

  async head(key) {
    const stored = this.#values.get(key);
    if (!stored) return null;
    return this.#object(stored, false);
  }

  async list({ prefix = "", limit = 1000 } = {}) {
    const objects = [...this.#values.keys()]
      .filter((key) => key.startsWith(prefix))
      .sort()
      .slice(0, limit)
      .map((key) => ({ key }));
    return { objects, truncated: false };
  }

  async delete(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.#values.delete(key);
  }

  #object(stored, includeBody) {
    return {
      body: includeBody ? new Response(stored.bytes).body : undefined,
      size: stored.bytes.byteLength,
      httpEtag: '"fake-etag"',
      httpMetadata: stored.httpMetadata,
      customMetadata: stored.customMetadata,
    };
  }
}

class FakeKV {
  #values = new Map();

  async get(key) {
    return this.#values.has(key) ? this.#values.get(key) : null;
  }

  async put(key, value) {
    this.#values.set(key, value);
  }

  async delete(key) {
    this.#values.delete(key);
  }
}
