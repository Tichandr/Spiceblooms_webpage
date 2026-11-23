const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "api.js"), "utf8");
const response = (status = 200, text = async () => JSON.stringify({ itemList: [], totalListCount: 0 })) =>
  ({ ok: status >= 200 && status < 300, status, text });

function client(fetch) {
  let now = 0;
  let id = 0;
  const timers = new Map();
  const calls = [];
  const warnings = [];
  const context = {
    URLSearchParams, AbortController,
    window: {},
    console: { warn: (...args) => warnings.push(args) },
    setTimeout: (callback, delay) => {
      timers.set(++id, { callback, at: now + delay });
      return id;
    },
    clearTimeout: id => timers.delete(id),
    fetch: (url, options) => {
      calls.push({ url, options, at: now });
      return fetch(url, options, calls.length);
    }
  };
  vm.runInNewContext(source, context);
  const flush = () => new Promise(resolve => setImmediate(resolve));
  return {
    api: context.window.SpicebloomsApi, calls, warnings, timers, flush,
    tick: async () => {
      await flush();
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      assert.ok(next, "Expected a pending timer");
      timers.delete(next[0]);
      now = next[1].at;
      next[1].callback();
      await flush();
    },
    elapsed: () => now
  };
}

test("hung catalog requests abort and fail within 33 seconds, then allow manual retry", async () => {
  let recover = false;
  const flow = client(() => recover ? response() : new Promise(() => {}));
  const pending = flow.api.getCatalogItems();
  const rejected = assert.rejects(pending, error => error.status === 408 && /timed out/.test(error.message));
  for (let step = 0; step < 5; step += 1) await flow.tick();
  await rejected;
  assert.equal(flow.elapsed(), 33000);
  assert.deepEqual(flow.calls.map(call => call.at), [0, 11000, 23000]);
  assert.ok(flow.calls.every(call => call.options.signal.aborted));
  assert.equal(flow.timers.size, 0);
  recover = true;
  await flow.api.getCatalogItems();
  assert.equal(flow.calls.length, 4);
  assert.equal(flow.timers.size, 0);
});

test("catalog deadline also covers a stalled response body", async () => {
  const flow = client(() => response(200, () => new Promise(() => {})));
  const rejected = assert.rejects(flow.api.getCatalogItems(), error => error.status === 408);
  for (let step = 0; step < 5; step += 1) await flow.tick();
  await rejected;
  assert.equal(flow.elapsed(), 33000);
  assert.ok(flow.calls.every(call => call.options.signal.aborted));
});

test("catalog retries network and transient server failures, then returns fresh prices", async () => {
  const flow = client((url, options, attempt) => {
    if (attempt === 1) throw new TypeError("Network unavailable");
    if (attempt === 2) return response(503);
    return response(200, async () => JSON.stringify({ itemList: [{ id: "item", actualPrice: 155 }] }));
  });
  const pending = flow.api.getCatalogItems();
  await flow.tick();
  await flow.tick();
  assert.equal((await pending).itemList[0].actualPrice, 155);
  assert.deepEqual(flow.calls.map(call => call.at), [0, 1000, 3000]);
  assert.equal(flow.warnings.length, 2);
  assert.equal(flow.timers.size, 0);
});

test("catalog does not retry permanent client errors", async () => {
  const flow = client(() => response(400));
  await assert.rejects(flow.api.getCatalogItems(), error => error.status === 400);
  assert.equal(flow.calls.length, 1);
  assert.equal(flow.timers.size, 0);
});

test("identical in-flight catalog requests share work but completed results are not cached", async () => {
  let release;
  const flow = client(() => new Promise(resolve => { release = resolve; }));
  const first = flow.api.getCatalogItems();
  const second = flow.api.getCatalogItems();
  assert.equal(first, second);
  assert.equal(flow.calls.length, 1);
  release(response());
  await first;
  const fresh = flow.api.getCatalogItems();
  assert.equal(flow.calls.length, 2);
  release(response());
  await fresh;
  assert.ok(flow.calls.every(call => call.options.cache === "no-store" && !call.options.headers.Authorization));
  assert.equal(flow.timers.size, 0);
});

test("order creation is not automatically retried or given the catalog timeout", async () => {
  const flow = client(() => response(503));
  await assert.rejects(flow.api.createOrder("test-token", {}), error => error.status === 503);
  assert.equal(flow.calls.length, 1);
  assert.equal(flow.calls[0].options.method, "POST");
  assert.equal(flow.calls[0].options.signal, undefined);
  assert.equal(flow.timers.size, 0);
});
