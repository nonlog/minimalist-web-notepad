import assert from "node:assert/strict";
import test from "node:test";
import { getMarkdownListEdit, handleRequest } from "../src/index.js";

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

  const del = await handleRequest(
    new Request("https://example.com/demo", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ text: "" }),
    }),
    bindings,
  );
  assert.equal(del.status, 204);

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

test("renders valid client-side Markdown list shortcut code", async () => {
  const response = await handleRequest(new Request("https://example.com/shortcuts"), env());
  const html = await response.text();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];

  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));
  assert.match(script, /addEventListener\("keydown",handleListEnter\)/);
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
