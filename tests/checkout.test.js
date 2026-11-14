const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "address.html"), "utf8");
const start = html.indexOf("        let shippingQuote = null;");
const end = html.indexOf("        document.getElementById('add-address-top')");
assert.ok(start > 0 && end > start);
const checkoutSource = html.slice(start, end);
const apiSource = fs.readFileSync(path.join(root, "api.js"), "utf8");
const bagHtml = fs.readFileSync(path.join(root, 'cart.html'), 'utf8');
const item = {
  name: "Turmeric Powder", itemName: "Turmeric Powder", itemId: "catalog-1",
  brandName: "SpiceBlooms", itemQuantity: "100g", price: 155, mrp: 205,
  quantity: 2, image: "turmeric.png"
};
const address = {
  id: "local-address", name: "Test Customer", line1: "123 Test Street",
  area: "Test Area", city: "Test City", state: "Test State", postcode: "500001",
  country: "India", isDefault: true
};

function storage(initial = []) {
  const values = new Map(initial);
  return {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key)
  };
}

function bagRates(handler, signedIn = true) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { textContent: '' });
    return elements.get(id);
  };
  let items = [{ itemId: 'catalog-1', quantity: 1, price: 1 }];
  const requests = [];
  const context = {
    sessionStorage: storage([['bag_delivery_pin', '500091']]),
    selectedItems: () => items, enrich: (item) => item,
    document: { getElementById: element },
    window: {
      SpicebloomsAuth: { get: () => signedIn ? { token: 'test-jwt', user: { id: 'customer' } } : null },
      SpicebloomsApi: { getShippingRates: async (body) => { requests.push(body); return handler(body); } }
    }
  };
  vm.createContext(context);
  vm.runInContext(bagHtml.slice(bagHtml.indexOf('        function money(value)'), bagHtml.indexOf('        function escapeHtml(value)')), context);
  vm.runInContext(bagHtml.slice(bagHtml.indexOf('        let bagDeliveryPin ='), bagHtml.indexOf('        function renderCart()')), context);
  return {
    element, requests, refresh: () => context.refreshBagDelivery(),
    setPin: (pin) => vm.runInContext('bagDeliveryPin = ' + JSON.stringify(pin), context),
    setItems: (value) => { items = value; }
  };
}

test('bag page inline scripts compile', () => {
  for (const script of bagHtml.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
    if (script[1].trim()) new vm.Script(script[1]);
  }
});

test('bag PIN lookup displays Bruno rate and includes paise in the total', async () => {
  const flow = bagRates(() => ({ deliveryFee: 74.72, pincode: '500091', courierName: 'Shadowfax Surface',
    rateAvailable: true, expiresAt: new Date(Date.now() + 300000).toISOString() }));
  await flow.refresh();
  assert.equal(flow.element('delivery-fee').textContent, 'Rs 74.72/-');
  assert.equal(flow.element('total-price').textContent, 'Rs 75.72/-');
  assert.match(flow.element('pincode-status').textContent, /Shadowfax Surface/);
  assert.deepEqual(JSON.parse(JSON.stringify(flow.requests[0])), { pincode: '500091', items: [{ itemId: 'catalog-1', quantity: 1 }] });
  await flow.refresh();
  assert.equal(flow.requests.length, 1);
});

test('bag missing rates and provider failures stay nonblocking', async () => {
  const missing = bagRates(() => ({ deliveryFee: 0, pincode: '500091', rateAvailable: false,
    expiresAt: new Date(Date.now() + 300000).toISOString() }));
  await missing.refresh();
  assert.equal(missing.element('delivery-fee').textContent, 'Rs 0/-');
  assert.match(missing.element('pincode-status').textContent, /still place your order/);
  const failed = bagRates(() => { throw new Error('Unavailable'); });
  await failed.refresh();
  assert.equal(failed.element('total-price').textContent, 'Rs 1/-');
  assert.match(failed.element('pincode-status').textContent, /still continue/);
});

test('bag stale PIN response cannot overwrite a newer rate; quantity changes requote', async () => {
  let release;
  const flow = bagRates((body) => body.pincode === '500091' ? new Promise((resolve) => { release = resolve; })
    : { deliveryFee: 50, pincode: body.pincode, expiresAt: new Date(Date.now() + 300000).toISOString() });
  const old = flow.refresh();
  flow.setPin('530027');
  await flow.refresh();
  release({ deliveryFee: 74.72, pincode: '500091', expiresAt: new Date(Date.now() + 300000).toISOString() });
  await old;
  assert.equal(flow.element('delivery-fee').textContent, 'Rs 50/-');
  flow.setItems([{ itemId: 'catalog-1', quantity: 2, price: 1 }]);
  await flow.refresh();
  assert.equal(flow.requests.length, 3);
  assert.equal(flow.requests[2].items[0].quantity, 2);
});

test('bag guests are prompted to sign in without exposing merchant credentials', async () => {
  const flow = bagRates(() => { throw new Error('Must not call merchant API'); }, false);
  await flow.refresh();
  assert.equal(flow.requests.length, 0);
  assert.match(flow.element('pincode-status').textContent, /Sign in/);
});

test('bag free-delivery response replaces a paid rate and quantity changes restore normal charges', async () => {
  const flow = bagRates((body) => ({
    deliveryFee: body.items[0].quantity >= 3 ? 0 : 74.72,
    freeDeliveryApplied: body.items[0].quantity >= 3,
    rateAvailable: body.items[0].quantity < 3,
    pincode: '500091', expiresAt: new Date(Date.now() + 300000).toISOString()
  }));
  const products = (quantity) => [{ itemId: 'catalog-1', quantity, price: 159, mrp: 205 }];
  flow.setItems(products(2));
  await flow.refresh();
  assert.equal(flow.element('delivery-fee').textContent, 'Rs 74.72/-');
  flow.setItems(products(3));
  await flow.refresh();
  assert.equal(flow.element('delivery-fee').textContent, 'Rs 0/-');
  assert.equal(flow.element('total-price').textContent, 'Rs 477/-');
  assert.match(flow.element('pincode-status').textContent, /Free delivery on orders of Rs 477 or more/);
  flow.setItems(products(2));
  await flow.refresh();
  assert.equal(flow.element('delivery-fee').textContent, 'Rs 74.72/-');
  assert.equal(flow.element('total-price').textContent, 'Rs 392.72/-');
  assert.doesNotMatch(flow.element('pincode-status').textContent, /Free delivery/);
});

function checkout(mode = "success") {
  const calls = [];
  const localStorage = storage([["cart", JSON.stringify([item, { name: "Unpurchased item", quantity: 1 }])]]);
  const sessionStorage = storage();
  let session = mode === "no-session" ? null : { token: "jwt-test", refreshToken: "refresh-test", user: { id: "customer-1" } };
  let options;
  let destination;
  let refreshed = false;
  let now = Date.now();
  let timerId = 0;
  let closed = false;
  let opened;
  const ready = new Promise((resolve) => { opened = resolve; });
  const timers = new Map();
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { textContent: '', hidden: false, disabled: false, classList: { toggle: () => {} } });
    return elements.get(id);
  };
  let selectedItems = [item];
  let activeAddress = address;
  let quoteHandler;
  let fee = mode === 'no-rates' ? 0 : 49.5;
  let subtotal = 310;
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const context = {
    URL, URLSearchParams, localStorage, sessionStorage, crypto, Date: ClockDate, setInterval, clearInterval,
    setTimeout: (callback) => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: (id) => timers.delete(id),
    document: { addEventListener: () => {}, removeEventListener: () => {}, getElementById: element },
    CART_KEY: "cart", SELECTED_ITEMS_KEY: "cart_selected", continuing: false,
    selectedCartItems: () => selectedItems, selectedAddress: () => activeAddress, enrich: (value) => value,
    money: (value) => 'Rs ' + value + '/-',
    paymentPhone: () => "9999999999", paymentDeliveryAddress: () => "Test delivery",
    loadRazorpayScript: async () => {},
    getCart: () => JSON.parse(localStorage.getItem("cart")),
    window: {
      location: { hostname: "localhost", href: "http://localhost:3000/address.html", replace: (url) => { destination = url; } },
      SpicebloomsAuth: { get: () => session, set: (value) => { session = value; }, clear: () => { session = null; } }
    },
    fetch: async (url, request) => {
      const body = request.body ? JSON.parse(request.body) : undefined;
      calls.push({ url, request, body });
      let payload;
      let status = 200;
      if (url.endsWith("/api/Auth/refresh")) {
        refreshed = true;
        payload = { token: "jwt-refreshed", refreshToken: "next-refresh" };
      } else if (url.endsWith("/api/Users/me/addresses")) {
        payload = request.method === "POST" ? { id: "backend-address" } : [];
        if (mode === "existing-address" && request.method === "GET") {
          payload = [{ id: "backend-address", blockNumber: "", houseNumber: address.line1,
            street: "Test Area, Test State, India", city: address.city, pincode: address.postcode }];
        }
      } else if (url.endsWith("/api/Shipping/quote")) {
        payload = quoteHandler ? await quoteHandler(body) : { quoteId: "signed-shipping-quote", deliveryFee: fee, pincode: activeAddress.postcode,
          rateAvailable: mode !== 'no-rates',
          courierName: "Test courier", estimatedDeliveryDate: new Date(now + 259200000).toISOString(), expiresAt: new Date(now + 300000).toISOString() };
        fee = payload.deliveryFee;
      } else if (url.includes("/api/Orders/checkout/") || url.endsWith("/api/Orders/backend-order")) {
        payload = { id: "backend-order", paymentStatus: mode === "paid-on-return" ? "Paid"
          : mode === "expired-on-return" ? "Expired" : mode === "processing-on-return" ? "Processing" : "Pending",
          status: "Confirmed", total: subtotal + fee, razorpayPaymentId: mode === "paid-on-return" ? "pay_test" : null };
      } else if (url.endsWith("/api/Orders/verify-payment")) {
        payload = { id: "backend-order", paymentStatus: mode === "unconfirmed" ? "Pending" : "Paid", total: subtotal + fee,
          status: mode === "late-review" ? "PaymentReview" : "Confirmed" };
        if (mode === "verify-failure") {
          status = 503;
          payload = { message: "Verification temporarily unavailable." };
        }
      } else if (url.endsWith("/api/Orders")) {
        if (mode === "lost-response") throw new TypeError("Order response lost");
        subtotal = body.subTotal;
        payload = { orderId: "backend-order", razorpayOrderId: "order_test", amount: subtotal + fee,
          currency: "INR", keyId: "rzp_test_public", description: "Test order", paymentExpiresAt: new Date(now + 1800000).toISOString() };
        if (mode === "refresh" && !refreshed) status = 401;
        if (mode === "missing-key") delete payload.keyId;
      } else {
        throw new Error("Unexpected request: " + url);
      }
      return { ok: status < 400, status, text: async () => JSON.stringify(payload) };
    }
  };
  context.window.Razorpay = function (settings) {
    options = settings;
    let failed;
    this.on = (event, callback) => { if (event === "payment.failed") failed = callback; };
    this.close = () => { closed = true; settings.modal.ondismiss(); };
    this.open = () => { opened(); if (mode === "idle") return; queueMicrotask(() => {
      if (mode === "cancel") return settings.modal.ondismiss();
      if (mode === "payment-failed") return failed({ error: { description: "Declined" } });
      settings.handler({ razorpay_order_id: mode === "mismatch" ? "other-order" : "order_test",
        razorpay_payment_id: "pay_test", razorpay_signature: "signature_test" });
    }); };
  };
  vm.createContext(context);
  vm.runInContext(apiSource, context);
  vm.runInContext(checkoutSource, context);
  vm.runInContext(html.slice(html.indexOf('        function renderPrices()'), html.indexOf('        function cardHtml(')), context);
  return {
    calls, localStorage, sessionStorage,
    options: () => options, destination: () => destination,
    ready, closed: () => closed, recover: () => context.recoverPendingCheckout(),
    setMode: (value) => { mode = value; },
    setOwner: (id) => { session.user.id = id; },
    element,
    advance: (milliseconds) => { now += milliseconds; },
    selectAddress: (value) => { activeAddress = value; },
    setQuoteHandler: (handler) => { quoteHandler = handler; },
    setItems: (items) => { selectedItems = items; },
    quote: () => context.ensureShippingQuote(selectedItems, activeAddress),
    expire: async () => { now += 1800001; await [...timers.values()][0](); },
    run: (items = [item], displayedFee) => { selectedItems = items; return context.openRazorpayCheckout(items, activeAddress, "test@example.com", displayedFee); }
  };
}

test("address page inline scripts compile", () => {
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
    if (script[1].trim()) new vm.Script(script[1]);
  }
});

test("authenticated checkout creates and confirms the backend order", async () => {
  const flow = checkout();
  await flow.run();
  assert.ok(flow.calls.every((call) => call.url.startsWith("https://localhost:7100/")));
  assert.ok(flow.calls.every((call) => call.request.headers.Authorization === "Bearer jwt-test"));
  const order = flow.calls.find((call) => call.url.endsWith("/api/Orders")).body;
  assert.equal(order.deliveryAddressId, "backend-address");
  assert.equal(order.items[0].itemId, "catalog-1");
  assert.equal(order.items[0].itemQuantity, "100g");
  assert.equal(order.subTotal, 310);
  assert.equal(order.total, 359.5);
  assert.equal(order.serviceCharge, 49.5);
  assert.equal(order.shippingQuoteId, 'signed-shipping-quote');
  assert.equal(flow.element('delivery-fee').textContent, 'Rs 49.5/-');
  assert.equal(flow.element('total-price').textContent, 'Rs 359.5/-');
  assert.equal(order.savings, 100);
  assert.match(order.checkoutId, /^[0-9a-f-]{36}$/);
  assert.equal(flow.options().amount, 35950);
  assert.equal(flow.options().order_id, "order_test");
  assert.equal(flow.options().key, "rzp_test_public");
  assert.deepEqual(flow.calls.find((call) => call.url.endsWith("/verify-payment")).body, {
    orderId: "backend-order", razorpayOrderId: "order_test",
    razorpayPaymentId: "pay_test", razorpaySignature: "signature_test"
  });
  assert.equal(flow.destination(), "order-success.html");
  assert.deepEqual(JSON.parse(flow.localStorage.getItem("cart")), [{ name: "Unpurchased item", quantity: 1 }]);
  const receipt = JSON.parse(flow.sessionStorage.getItem("last_order"));
  assert.equal(receipt.orderId, "backend-order");
  assert.equal(receipt.paymentId, "pay_test");
  assert.equal(receipt.amount, 359.5);
  assert.equal(flow.sessionStorage.getItem("checkout_pending_order"), null);
});

test("checkout reuses a matching backend delivery address", async () => {
  const flow = checkout("existing-address");
  await flow.run();
  assert.equal(flow.calls.filter((call) => call.url.endsWith("/addresses")).length, 1);
});

test("expired JWT is refreshed and verification uses the fresh token", async () => {
  const flow = checkout("refresh");
  await flow.run();
  assert.equal(flow.calls.filter((call) => call.url.endsWith("/api/Auth/refresh")).length, 1);
  assert.equal(flow.calls.find((call) => call.url.endsWith("/verify-payment")).request.headers.Authorization, "Bearer jwt-refreshed");
});

for (const mode of ["unconfirmed", "cancel", "mismatch", "payment-failed", "verify-failure", "missing-key"]) {
  test(mode + " does not clear the cart or show order success", async () => {
    const flow = checkout(mode);
    await assert.rejects(flow.run());
    assert.equal(JSON.parse(flow.localStorage.getItem("cart")).length, 2);
    assert.equal(flow.destination(), undefined);
    assert.equal(flow.sessionStorage.getItem("last_order"), null);
    if (["cancel", "mismatch", "payment-failed", "missing-key"].includes(mode)) {
      assert.equal(flow.calls.some((call) => call.url.endsWith("/verify-payment")), false);
    }
  });
}

test("missing session or catalog ID stops checkout before backend requests", async () => {
  const anonymous = checkout("no-session");
  await assert.rejects(anonymous.run(), /Sign in again/);
  assert.equal(anonymous.calls.length, 0);
  const unmatched = checkout();
  await assert.rejects(unmatched.run([{ ...item, itemId: null }]), /backend catalog/);
  assert.equal(unmatched.calls.length, 0);
});

test("repricing preserves backend IDs and refreshes legacy pricing caches", async () => {
  let requests = 0;
  const sessionStorage = storage([["spiceblooms_catalog_prices", JSON.stringify({ at: Date.now(), prices: { turmeric: { price: 199, mrp: 229 } } })]]);
  const context = {
    sessionStorage,
    window: { SpicebloomsApi: { getCatalogItems: async () => {
      requests += 1;
      return { totalListCount: 1, itemList: [{ id: "catalog-1", itemName: "Turmeric Powder",
        brandName: "SpiceBlooms", quantity: "100g", actualPrice: "155", oldPrice: "205", imageUri: "turmeric.png" }] };
    } } }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, "cart-pricing.js"), "utf8"), context);
  const pricing = context.window.SpicebloomsPricing;
  const result = await pricing.reprice([{ name: item.name, price: 199, quantity: 2 }]);
  assert.equal(result.changed, true);
  assert.equal(result.cart[0].itemId, "catalog-1");
  assert.equal(result.cart[0].price, 155);
  assert.equal(result.cart[0].quantity, 2);
  assert.equal((await pricing.reprice(result.cart)).changed, false);
  assert.equal(requests, 1);
  await pricing.reprice(result.cart, true);
  assert.equal(requests, 2);
});

test("closing unpaid checkout reuses the persisted retry ID", async () => {
  const flow = checkout("cancel");
  await assert.rejects(flow.run());
  const original = JSON.parse(flow.sessionStorage.getItem("checkout_attempt")).checkoutId;
  flow.setMode("success");
  await flow.run();
  const creates = flow.calls.filter((call) => call.url.endsWith("/api/Orders"));
  assert.equal(creates.length, 2);
  assert.equal(creates[0].body.checkoutId, original);
  assert.equal(creates[1].body.checkoutId, original);
  assert.ok(flow.calls.some((call) => call.url.endsWith("/api/Orders/backend-order")));
});

test("lost create response recovers by checkout ID and retries the same intent", async () => {
  const flow = checkout("lost-response");
  await assert.rejects(flow.run());
  const attempt = JSON.parse(flow.sessionStorage.getItem("checkout_attempt"));
  assert.equal(flow.sessionStorage.getItem("checkout_pending_order"), null);
  flow.setMode("success");
  await flow.run();
  const creates = flow.calls.filter((call) => call.url.endsWith("/api/Orders"));
  assert.equal(creates[1].body.checkoutId, attempt.checkoutId);
  assert.ok(flow.calls.some((call) => call.url.endsWith("/api/Orders/checkout/" + attempt.checkoutId)));
});

test("pending verification cannot start another payment and can recover a webhook-confirmed order", async () => {
  const flow = checkout("verify-failure");
  await assert.rejects(flow.run());
  const pending = JSON.parse(flow.sessionStorage.getItem("checkout_pending_order"));
  assert.equal(pending.paymentId, "pay_test");
  flow.setMode("success");
  await assert.rejects(flow.run(), /Do not pay again/);
  flow.setMode("paid-on-return");
  await flow.run();
  assert.equal(flow.calls.filter((call) => call.url.endsWith("/api/Orders")).length, 1);
  assert.equal(flow.destination(), "order-success.html");
});

test("expired checkout clears retry state without removing cart items", async () => {
  const flow = checkout("cancel");
  await assert.rejects(flow.run());
  flow.setMode("expired-on-return");
  assert.equal(await flow.recover(), null);
  assert.equal(flow.sessionStorage.getItem("checkout_attempt"), null);
  assert.equal(flow.sessionStorage.getItem("checkout_pending_order"), null);
  assert.equal(JSON.parse(flow.localStorage.getItem("cart")).length, 2);
});

test("authorized payment still processing blocks a replacement checkout", async () => {
  const flow = checkout("cancel");
  await assert.rejects(flow.run());
  flow.setMode("processing-on-return");
  await assert.rejects(flow.run(), /still processing/);
  assert.equal(flow.calls.filter((call) => call.url.endsWith("/api/Orders")).length, 1);
});

test("idle expiry closes checkout without treating it as paid", async () => {
  const flow = checkout("idle");
  const payment = flow.run();
  const rejected = assert.rejects(payment, /time expired/);
  await flow.ready;
  flow.setMode("expired-on-return");
  await flow.expire();
  await rejected;
  assert.equal(flow.closed(), true);
  assert.equal(flow.destination(), undefined);
  assert.equal(JSON.parse(flow.localStorage.getItem("cart")).length, 2);
});

test("paid recovery is idempotent and preserves quantities added after checkout", async () => {
  const flow = checkout("cancel");
  await assert.rejects(flow.run());
  const pending = flow.sessionStorage.getItem("checkout_pending_order");
  flow.localStorage.setItem("cart", JSON.stringify([{ ...item, quantity: 3 }]));
  flow.setMode("paid-on-return");
  await flow.recover();
  assert.equal(JSON.parse(flow.localStorage.getItem("cart"))[0].quantity, 1);
  flow.sessionStorage.setItem("checkout_pending_order", pending);
  await flow.recover();
  assert.equal(JSON.parse(flow.localStorage.getItem("cart"))[0].quantity, 1);
  assert.equal(flow.sessionStorage.getItem("checkout_pending_order"), null);
});

test("switching accounts discards local checkout state without accessing the previous order", async () => {
  const flow = checkout("cancel");
  await assert.rejects(flow.run());
  const count = flow.calls.length;
  flow.setOwner("other-customer");
  assert.equal(await flow.recover(), null);
  assert.equal(flow.calls.length, count);
  assert.equal(flow.sessionStorage.getItem("checkout_pending_order"), null);
});

test("late payment review status is retained in the receipt", async () => {
  const flow = checkout("late-review");
  await flow.run();
  assert.equal(JSON.parse(flow.sessionStorage.getItem("last_order")).status, "PaymentReview");
});

test('missing Shiprocket rates display zero delivery fee and do not block checkout', async () => {
  const flow = checkout('no-rates');
  await flow.quote();
  assert.equal(flow.element('continue-order').disabled, false);
  assert.equal(flow.element('delivery-fee').textContent, 'Rs 0/-');
  assert.equal(flow.element('total-price').textContent, 'Rs 310/-');
  assert.match(flow.element('delivery-estimate').textContent, /No delivery fee charged/);
  await flow.run([item], 49.5);
  const order = flow.calls.find((call) => call.url.endsWith('/api/Orders')).body;
  assert.equal(order.serviceCharge, 0);
  assert.equal(order.total, 310);
  assert.equal(order.shippingQuoteId, 'signed-shipping-quote');
  assert.equal(flow.options().amount, 31000);
  assert.equal(flow.destination(), 'order-success.html');
});

test('checkout displays free delivery and submits the signed zero-fee quote unchanged', async () => {
  const flow = checkout();
  const products = [{ ...item, price: 159, quantity: 3 }];
  flow.setItems(products);
  flow.setQuoteHandler(() => ({
    quoteId: 'free-delivery-quote', deliveryFee: 0, pincode: address.postcode,
    freeDeliveryApplied: true, rateAvailable: false, expiresAt: new Date(Date.now() + 300000).toISOString()
  }));
  await flow.quote();
  assert.equal(flow.element('delivery-fee').textContent, 'Rs 0/-');
  assert.match(flow.element('delivery-estimate').textContent, /Free delivery on orders of Rs 477 or more/);
  assert.equal(flow.element('continue-order').disabled, false);
  await flow.run(products, 49.5);
  const order = flow.calls.find((call) => call.url.endsWith('/api/Orders')).body;
  assert.equal(order.subTotal, 477);
  assert.equal(order.serviceCharge, 0);
  assert.equal(order.total, 477);
  assert.equal(order.shippingQuoteId, 'free-delivery-quote');
  assert.equal(flow.element('total-price').textContent, 'Rs 477/-');
  assert.equal(flow.options().amount, 47700);
});

test('an old quote response cannot replace the newly selected address fee', async () => {
  const flow = checkout();
  let releaseOld;
  let notifyRequested;
  const requested = new Promise((resolve) => { notifyRequested = resolve; });
  flow.setQuoteHandler(() => { notifyRequested(); return new Promise((resolve) => { releaseOld = resolve; }); });
  const old = assert.rejects(flow.quote(), /bag or address changed/);
  await requested;
  assert.equal(flow.element('continue-order').disabled, true);
  flow.selectAddress({ ...address, id: 'other-address', postcode: '560001' });
  const quote = (pincode, deliveryFee) => ({ quoteId: 'signed-' + pincode, pincode, deliveryFee,
    rateAvailable: true, expiresAt: new Date(Date.now() + 300000).toISOString() });
  flow.setQuoteHandler(() => quote('560001', 70.25));
  await flow.quote();
  releaseOld(quote('500001', 49.5));
  await old;
  assert.equal(flow.element('delivery-fee').textContent, 'Rs 70.25/-');
  assert.equal(flow.element('total-price').textContent, 'Rs 380.25/-');
  assert.equal(flow.element('continue-order').disabled, false);
});

test('expired quotes refresh and a higher delivery fee is shown before payment', async () => {
  const flow = checkout();
  await flow.quote();
  flow.advance(300001);
  flow.setQuoteHandler(() => ({ quoteId: 'new-quote', pincode: address.postcode, deliveryFee: 60,
    expiresAt: new Date(Date.now() + 900000).toISOString() }));
  await assert.rejects(flow.run([item], 49.5), /Delivery charges have changed/);
  assert.equal(flow.element('delivery-fee').textContent, 'Rs 60/-');
  assert.equal(flow.calls.some((call) => call.url.endsWith('/api/Orders')), false);
});

test('invalid quote payloads do not silently waive a real fee', async () => {
  const flow = checkout();
  flow.setQuoteHandler(() => ({ quoteId: '', pincode: address.postcode, deliveryFee: -1 }));
  await assert.rejects(flow.run(), /valid delivery charges/);
  assert.equal(flow.calls.some((call) => call.url.endsWith('/api/Orders')), false);
  assert.equal(flow.element('retry-delivery').hidden, false);
});