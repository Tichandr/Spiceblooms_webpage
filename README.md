# Spiceblooms_webpage

## Run locally

1. Start the SpiceBlooms API from `C:\Personal\spiceblooms-app\Service\src\SpiceBlooms.Api` with its HTTPS profile on `https://localhost:7100`.
2. Open `https://localhost:7100/health` and confirm it returns `Healthy`. If the development certificate is not trusted, run `dotnet dev-certs https --trust` yourself and accept the operating system prompt.
3. Run `npm start` in this repository and open `http://localhost:3000/login.html`.

No frontend build step is required. On `localhost`, `127.0.0.1`, or IPv6 loopback, the API client uses `https://localhost:7100`. Deployed sites continue to use the Azure API.

## Authentication

- Google sign-in uses Firebase in the browser, then exchanges the Firebase ID token at `POST /api/Auth/firebase` for the backend's access and refresh tokens. Enable the Google provider, authorize `localhost` in Firebase Authentication, and configure the backend's Firebase Admin credentials for the same project as `firebase-config.js`.
- Phone sign-in calls `POST /api/Auth/otp/send` and `POST /api/Auth/otp/verify`. The backend handles MSG91 and returns the same session token format. Configure `Msg91:AuthKey` and `Msg91:WidgetId` securely in the backend, with its widget set to a 4-digit OTP to match this form.
- Firebase Admin credentials and MSG91 keys belong only in the backend configuration, never in frontend scripts. Successful login also requires the backend's Cosmos DB connection to be available.
- iOS browsers (including iPadOS desktop mode) use Google popup sign-in because Safari can block the cross-site storage required by Firebase redirects. The login page prepares Firebase before enabling the Google button to preserve the popup's click gesture. iOS popup failures are shown instead of falling back to redirects; allow popups, open the site in Safari/Chrome rather than an in-app browser, or use mobile OTP. Android retains redirect sign-in and desktop retains popup sign-in.
- For production, authorize every storefront hostname in Firebase Authentication settings. If redirects are needed on storage-blocking browsers, configure same-origin Firebase auth helpers using the [Firebase redirect best practices](https://firebase.google.com/docs/auth/web/redirect-best-practices); changing `authDomain` alone without hosting/proxying those helpers is not sufficient.
- Test Google sign-in using your account and phone sign-in using your own mobile number. OTP requests send real SMS and are subject to backend rate limits.

## Backend checkout

Checkout registers or reuses the selected delivery address through the authenticated backend, then calls `POST /api/Orders` with catalog item IDs, quantities, and the displayed amounts. The backend returns its order ID, Razorpay order ID, amount in rupees, currency, and public `keyId`. After Razorpay checkout, the frontend calls `POST /api/Orders/verify-payment` using the same bearer-token and refresh flow. It clears purchased cart items only after the backend confirms `Paid`.

Configure `Razorpay:KeyId` and `Razorpay:KeySecret` securely in the .NET backend. This checkout no longer uses the Node server's `/api/payments/*` endpoints or its `.env` payment credentials. Never expose the Razorpay secret in the browser.

Before contacting Razorpay, the backend validates positive quantities, catalog actual prices, original-price savings, and exact totals. The delivery fee comes from a signed backend shipping quote, not an editable client amount. Invalid orders return HTTP 400 without creating a Razorpay order.

### PIN-Code Delivery Fees

The Bag page now calls authenticated `POST /api/Shipping/rates` with an entered PIN and selected catalog item IDs/quantities. It displays the lowest returned rate and includes paise in the total, refreshing on PIN, quantity, or selection changes. Signing in is required for this preview; merchant tokens never reach the browser. The preview creates no address, order, shipment, or pickup and cannot be submitted as a payment quote. The selected delivery address is quoted independently at the Address step. The earlier placeholder Bag PIN message and fixed-zero Bag fee have been removed.

The checkout calls authenticated `POST /api/Shipping/quote` with the selected backend address ID and catalog item IDs/quantities. It displays the returned delivery fee, total, courier and estimated date when available, and refreshes the quote after an address or cart change. Order creation submits `shippingQuoteId` and the quoted fee as `serviceCharge`. Both Google and phone sessions use backend JWTs; Shiprocket merchant tokens stay on the server.

Delivery is free when the selected products' subtotal after discounts is **Rs 477 or more**, excluding delivery. The backend calculates eligibility using current catalog selling prices and quantities, returns `deliveryFee: 0` with `freeDeliveryApplied: true` for both previews and signed checkout quotes, and skips the courier-rate lookup without promising a delivery date. Below Rs 477, normal quoted fees and the existing unavailable-rate fallback still apply. Checkout validates eligibility again before creating the payment; stale quotes require refreshing. Deploy the updated backend and frontend together. This rule does not change existing payment orders.

Configure these values in the .NET backend, using user secrets locally and Key Vault or App Service settings when deployed:

- `ShipRocket:Email` and `ShipRocket:PasswordValue` (legacy `ShipRocket:Password` remains supported).
- `ShipRocket:PickupPostcode`: the merchant's actual 6-digit pickup PIN code.
- `ShipRocket:PackagingWeightKg`: additional parcel/packaging weight, default `0`. Product pack sizes such as `100g` or `1kg` are read from the backend catalog and multiplied by quantity.
- `ShipRocket:ItemWeightsKg:<catalog-item-id>`: weight overrides for items whose pack descriptions are not weights, such as combos or multi-packs. An optional `ShipRocket:DefaultItemWeightKg` can supply a merchant-approved fallback weight. Do not guess these weights.

The backend selects the lowest valid prepaid Shiprocket rate. If rates are absent, configuration or weights are missing, or Shiprocket is unavailable, it issues a signed zero-fee quote instead: checkout shows `Rs 0/-` for delivery and remains available, without promising an estimated delivery date. This is intentionally a merchant-funded shipping fallback. Invalid addresses, authentication failures and invalid catalog items still require correction.

Quotes expire after five minutes and bind the fee to the backend user, owned address/PIN code, and item quantities using the backend signing key. Editing a fee or quote cannot waive a returned charge. The browser refreshes expired quotes and asks for review before a higher fee is used; reductions, including fallback to zero, can proceed directly. Merchant-login endpoints require the `ShippingAdmin` role. Deploy/restart the updated backend together with the frontend; the older order API does not accept this quote contract. No Shiprocket credentials belong in the storefront `.env` or browser scripts.

Restart the .NET API after applying the backend changes, then refresh the checkout page. A successful real checkout also requires backend Cosmos DB access and valid Razorpay credentials.

Run the frontend checkout tests with `npm test`. These tests mock the backend and Razorpay and do not charge payments. Backend anti-tampering tests are in `Service/tests/SpiceBlooms.Api.Tests/Services/OrderServiceTests.cs` in the backend repository.

## Pending Payments And Webhooks

- New orders start as `PendingPayment`. Their payment deadline is controlled by backend `Checkout:PaymentTimeoutMinutes` (default `30`, allowed range `1` to `1440`). Closing the payment window does not mark the order paid or failed.
- The browser stores a UUID `checkoutId` before submitting an order. Retrying an unchanged checkout reuses that ID; the backend reserves its deterministic order ID before contacting Razorpay and reuses matching pending checkouts. A request still being created returns HTTP 409 instead of issuing another gateway order.
- Authenticated `GET /api/Orders/checkout/{checkoutId}` recovers a lost create response. Order retrieval, retry IDs, and delivery addresses are scoped to the backend JWT user. Both Firebase Google and MSG91 phone login exchange their verified credentials for that JWT; raw Firebase ID tokens or MSG91 access tokens are not order API bearer tokens.
- An API background worker runs every minute. It checks overdue orders against Razorpay before marking unpaid orders `Expired`; authorized payments remain `Processing`, provider failures are retried, and paid orders are never overwritten by cleanup. Existing unpaid orders without a deadline use their order date plus the configured timeout. Orders remain in Cosmos for audit; no deletion TTL is applied.
- Payment verification and webhooks require provider-confirmed capture, matching order IDs, INR currency, and the exact stored amount. Duplicate confirmations are idempotent. Cosmos ETag concurrency checks protect payment-versus-expiry updates. Captures discovered after expiry are recorded as `Paid` with order status `PaymentReview`; review fulfillment or refund before shipping.
- Browser recovery checks pending orders on return and every 15 seconds while the address page is open. It preserves cart changes made since checkout and never starts another payment while a submitted payment is awaiting confirmation.

### Enable Razorpay Webhooks

1. Configure a dedicated secret in the backend as `Razorpay:WebhookSecret`, using user secrets locally or a production secret store. The environment-variable form is `Razorpay__WebhookSecret`. Do not reuse the Razorpay API key secret.
2. Register `https://YOUR-PUBLIC-BACKEND/api/payments/razorpay/webhook` in the Razorpay dashboard with the same secret and subscribe to `payment.captured` and `order.paid`. Razorpay cannot reach `localhost`; use an HTTPS development tunnel for local testing or the deployed API URL.
3. Restart the backend. The webhook route does not use customer JWTs; it authenticates the exact request body with `X-Razorpay-Signature`. Other order endpoints require valid signed backend JWTs with a user ID.
4. Keep the API running (for example, App Service Always On) for regular expiry processing. Configure and monitor Razorpay webhook retries and backend reconciliation warnings. Dashboard webhook registration and delivery must be verified separately; unit tests do not configure Razorpay.
