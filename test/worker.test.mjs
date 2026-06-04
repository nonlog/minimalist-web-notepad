import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest } from "../src/index.js";

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
