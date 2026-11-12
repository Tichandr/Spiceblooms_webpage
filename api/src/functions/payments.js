const { app } = require("@azure/functions");
const pricing = require("../../shared/cart-pricing.js");
const createPayments = require("../../shared/payments.js");

const payments = createPayments({
  productKey: pricing.productKey,
  toNumber: pricing.toNumber,
  missingKeysMessage: "Payments are not configured. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to the Static Web App environment variables."
});

async function readJson(request) {
  const raw = await request.text();
  if (raw.length > 32 * 1024) throw new Error("too_large");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error("invalid_json");
  }
}

function handle(action) {
  return async (request, context) => {
    try {
      const result = await action(await readJson(request));
      return { status: result.status, jsonBody: result.payload };
    } catch (error) {
      if (error.message === "invalid_json" || error.message === "too_large") {
        return { status: 400, jsonBody: { error: "Invalid payment request." } };
      }
      context.error("Payment API error:", error);
      return { status: 502, jsonBody: { error: "Payment service is unavailable. Try again." } };
    }
  };
}

app.http("paymentsOrder", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "payments/order",
  handler: handle(payments.createOrder)
});

app.http("paymentsVerify", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "payments/verify",
  handler: handle(payments.verifyPayment)
});
