import assert from "node:assert/strict";
import test from "node:test";
import {
  canUseUnderscoreEmphasis,
  getMarkdownListEdit,
  handleRequest,
  isMarkdownHorizontalRule,
  normalizeViewMode,
  parseMarkdownListItem,
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
  assert.match(html, /@media\(pointer:coarse\)\{\.view-button\{min-height:44px\}\}/);
  assert.match(html, /@media\(max-width:760px\).*grid-template-rows:minmax\(0,1fr\) minmax\(0,1fr\)/s);
  assert.match(html, /orientation:landscape.*grid-template-columns:minmax\(0,1fr\) minmax\(0,1fr\)/s);
  assert.match(html, /function syncAppHeight\(\)/);
  assert.match(html, /visualViewport\?\.addEventListener\("resize",syncAppHeight/);
  assert.match(html, /setMode\(initialMode,false,false\)/);
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
    NOTE_MAX_BYTES: "262144",
    NOTE_TTL_SECONDS: "0",
    ...overrides,
  };
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
