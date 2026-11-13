const crypto = require("crypto");

const CATALOG_API = "https://spiceblooms-api-dev.azurewebsites.net/api/Catalog/items";
const MAX_QTY = 20;
const PRICE_CACHE_MS = 5 * 60 * 1000;

function clip(value, max) {
  return String(value || "").trim().slice(0, max);
}

function razorpayKeys() {
  const keyId = process.env.RAZORPAY_KEY_ID || "";
  const keySecret = process.env.RAZORPAY_KEY_SECRET || "";
  return keyId && keySecret ? { keyId, keySecret } : null;
}

/**
 * Server-side Razorpay checkout shared by the local server and the Azure Functions API.
 * Prices always come from the catalog API; any price sent by the browser is ignored.
 */
function createPayments({ productKey, toNumber, missingKeysMessage = "Payments are not configured." }) {
  let priceCache = { at: 0, prices: null };

  async function catalogPrices() {
    if (priceCache.prices && Date.now() - priceCache.at < PRICE_CACHE_MS) return priceCache.prices;
    const prices = {};
    let page = 1;
    let loaded = 0;
    let total = Infinity;
    while (loaded < total) {
      const response = await fetch(`${CATALOG_API}?page=${page}&pageSize=50`, { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error("catalog_unavailable");
      const data = await response.json();
      const list = Array.isArray(data && data.itemList) ? data.itemList : [];
      list.forEach((item) => {
        const key = productKey(item.itemName || item.ItemName);
        const price = toNumber(item.actualPrice !== undefined ? item.actualPrice : item.ActualPrice);
        if (!key || price === null) return;
        const current = prices[key];
        if (current && current.price >= price) return;
        prices[key] = { price, name: item.itemName || item.ItemName };
      });
      loaded += list.length;
      total = Number(data && data.totalListCount) || loaded;
      if (!list.length) break;
      page += 1;
    }
    priceCache = { at: Date.now(), prices };
    return prices;
  }

  async function createOrder(body) {
    const keys = razorpayKeys();
    if (!keys) return { status: 503, payload: { error: missingKeysMessage } };

    const requested = Array.isArray(body.items) ? body.items.slice(0, 50) : [];
    if (!requested.length) return { status: 422, payload: { error: "Your bag is empty." } };

    const prices = await catalogPrices();
    const lines = {};
    for (const item of requested) {
      const key = productKey(item && item.name);
      const match = prices[key];
      if (!match) return { status: 422, payload: { error: `"${clip(item && item.name, 80)}" is not available for online payment right now.` } };
      const quantity = Math.min(MAX_QTY, Math.max(1, parseInt(item.quantity, 10) || 1));
      if (lines[key]) lines[key].quantity = Math.min(MAX_QTY, lines[key].quantity + quantity);
      else lines[key] = { key, name: match.name, price: match.price, quantity };
    }
    const items = Object.values(lines);
    const total = items.reduce((sum, line) => sum + line.price * line.quantity, 0);
    const amountPaise = Math.round(total * 100);
    if (amountPaise < 100) return { status: 422, payload: { error: "Order total is too low." } };

    const customer = {
      email: clip(body.customer && body.customer.email, 120),
      phone: clip(body.customer && body.customer.phone, 24),
      name: clip(body.customer && body.customer.name, 80),
      address: clip(body.customer && body.customer.address, 400)
    };
    const receipt = "sb_" + Date.now().toString(36) + crypto.randomBytes(3).toString("hex");
    const response = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic " + Buffer.from(keys.keyId + ":" + keys.keySecret).toString("base64")
      },
      body: JSON.stringify({
        amount: amountPaise,
        currency: "INR",
        receipt,
        notes: {
          name: customer.name,
          email: customer.email,
          phone: customer.phone,
          delivery_address: clip(customer.address, 250),
          items: clip(items.map((line) => `${line.name} x${line.quantity}`).join(", "), 250)
        }
      })
    });
    const order = await response.json().catch(() => ({}));
    if (!response.ok || !order.id) {
      const reason = order && order.error && order.error.description;
      return { status: 502, payload: { error: reason ? "Razorpay: " + reason : "Could not start the payment. Try again." } };
    }

    return {
      status: 200,
      payload: { orderId: order.id, amount: amountPaise, currency: "INR", keyId: keys.keyId, receipt, total, items },
      record: { receipt, amount: amountPaise, items, customer, status: "created", createdAt: new Date().toISOString() }
    };
  }

  function verifyPayment(body) {
    const keys = razorpayKeys();
    if (!keys) return { status: 503, payload: { error: missingKeysMessage } };
    const orderId = String(body.razorpay_order_id || "");
    const paymentId = String(body.razorpay_payment_id || "");
    const signature = String(body.razorpay_signature || "");
    if (!orderId || !paymentId || !signature) return { status: 400, payload: { error: "Payment details are incomplete." } };

    const expected = crypto.createHmac("sha256", keys.keySecret).update(orderId + "|" + paymentId).digest("hex");
    const valid = expected.length === signature.length &&
      crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    if (!valid) return { status: 400, payload: { error: "Payment could not be verified." } };

    return { status: 200, payload: { ok: true, orderId, paymentId } };
  }

  return { createOrder, verifyPayment };
}

module.exports = createPayments;
