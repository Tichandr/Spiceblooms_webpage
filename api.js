/*
 * Spiceblooms API client (framework-agnostic).
 * Plain fetch-based functions with no DOM access, so this can be moved into a
 * React/Angular service with minimal changes.
 */
(function () {
  const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
  const API_BASE_URL = isLocal
    ? "https://localhost:7100"
    : "https://spiceblooms-api-dev.azurewebsites.net";
  const PHONE_PREFIX = "91";

  class ApiError extends Error {
    constructor(message, status, details) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.details = details;
    }
  }

  const extractMessage = (body, fallback) => {
    if (!body) return fallback;
    if (typeof body === "string") return body;
    if (body.message) return body.message;
    if (body.title) return body.title;
    if (body.errors) {
      const first = Object.values(body.errors).flat()[0];
      if (first) return first;
    }
    return fallback;
  };

  const getAuthSession = () => {
    return window.SpicebloomsAuth && window.SpicebloomsAuth.get
      ? window.SpicebloomsAuth.get()
      : null;
  };

  let refreshPromise = null;

  async function refreshAuthSession(session) {
    const currentSession = getAuthSession() || session;
    if (!currentSession || !currentSession.refreshToken) {
      if (currentSession && currentSession.token && window.SpicebloomsAuth && window.SpicebloomsAuth.clear) {
        window.SpicebloomsAuth.clear();
      }
      throw new ApiError("Your sign-in session has expired. Sign in again to continue.", 401);
    }

    if (!refreshPromise) {
      refreshPromise = request("/api/Auth/refresh", {
        method: "POST",
        body: { refreshToken: currentSession.refreshToken },
        attachSessionToken: false,
        retryUnauthorized: false
      }).then((auth) => {
        if (!auth || !auth.token) {
          throw new ApiError("Could not refresh your sign-in session. Sign in again to continue.", 401, auth);
        }
        const latestSession = getAuthSession() || currentSession;
        const refreshedSession = Object.assign({}, latestSession, {
          token: auth.token,
          refreshToken: auth.refreshToken || latestSession.refreshToken,
          expiry: auth.expiry || latestSession.expiry,
          user: auth.user || latestSession.user
        });
        if (window.SpicebloomsAuth && window.SpicebloomsAuth.set) {
          window.SpicebloomsAuth.set(refreshedSession);
        }
        return refreshedSession;
      }).catch((error) => {
        if (error instanceof ApiError && [400, 401, 403].includes(error.status)) {
          if (window.SpicebloomsAuth && window.SpicebloomsAuth.clear) {
            window.SpicebloomsAuth.clear();
          }
          throw new ApiError("Your sign-in session has expired. Sign in again to continue.", error.status, error.details);
        }
        throw error;
      }).finally(() => {
        refreshPromise = null;
      });
    }

    return refreshPromise;
  }

  async function request(path, {
    method = "GET",
    body,
    token,
    attachSessionToken = true,
    retryUnauthorized = true
  } = {}) {
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const session = attachSessionToken ? getAuthSession() : null;
    const accessToken = token || (session && session.token);
    if (accessToken) headers.Authorization = "Bearer " + accessToken;

    let response;
    try {
      response = await fetch(API_BASE_URL + path, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined
      });
    } catch (error) {
      throw new ApiError("Network error. Please check your connection and try again.", 0, error);
    }

    const text = await response.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch (error) { data = text; }
    }

    if (!response.ok) {
      if (response.status === 401 && retryUnauthorized && accessToken) {
        const refreshedSession = await refreshAuthSession(session);
        return request(path, {
          method,
          body,
          token: refreshedSession.token,
          attachSessionToken: false,
          retryUnauthorized: false
        });
      }
      throw new ApiError(
        extractMessage(data, "Something went wrong (" + response.status + "). Please try again."),
        response.status,
        data
      );
    }
    return data;
  }

  function authenticatedRequest(path, options = {}) {
    const session = getAuthSession();
    const token = options.token || (session && session.token);
    if (!token) {
      return Promise.reject(new ApiError("Sign in to continue.", 401));
    }
    return request(path, Object.assign({}, options, { token }));
  }

  const toApiPhone = (tenDigitNumber) => PHONE_PREFIX + tenDigitNumber;

  window.SpicebloomsApi = {
    ApiError,

    /** POST /api/Auth/otp/send -> { sessionId, message } */
    sendOtp(phone) {
      return request("/api/Auth/otp/send", {
        method: "POST",
        body: { phone: toApiPhone(phone) },
        attachSessionToken: false,
        retryUnauthorized: false
      });
    },

    /** POST /api/Auth/otp/verify -> { token, refreshToken, expiry, user } */
    verifyOtp({ phone, sessionId, otp }) {
      return request("/api/Auth/otp/verify", {
        method: "POST",
        body: { phone: toApiPhone(phone), sessionId, otp },
        attachSessionToken: false,
        retryUnauthorized: false
      });
    },

    /** POST /api/Auth/firebase -> { token, refreshToken, expiry, user } */
    firebaseLogin(firebaseIdToken) {
      return request("/api/Auth/firebase", {
        method: "POST",
        body: { firebaseIdToken },
        attachSessionToken: false,
        retryUnauthorized: false
      });
    },

    /** PUT /api/Auth/profile (requires bearer token) -> UserInfo */
    completeProfile(token, { fullName, email, phone }) {
      return authenticatedRequest("/api/Auth/profile", {
        method: "PUT",
        token,
        body: { fullName, email, phone: phone ? toApiPhone(phone) : undefined }
      });
    },

    /** GET /api/Catalog/categories -> category list */
    getCatalogCategories() {
      return request("/api/Catalog/categories");
    },

    /** GET /api/Catalog/categories/{categoryId}/subcategories -> subcategory list */
    getCatalogSubCategories(categoryId) {
      return request("/api/Catalog/categories/" + encodeURIComponent(categoryId) + "/subcategories");
    },

    /** GET /api/Catalog/items with optional category/subcategory filters */
    getCatalogItems({ categoryId, subCategoryId, page = 1, pageSize = 20 } = {}) {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (categoryId) params.set("categoryId", categoryId);
      if (subCategoryId) params.set("subCategoryId", subCategoryId);
      return request("/api/Catalog/items?" + params.toString());
    },

    /** GET/POST /api/Users/me/addresses (requires bearer token) */
    getAddresses(token) {
      return authenticatedRequest("/api/Users/me/addresses", { token });
    },

    createAddress(token, address) {
      return authenticatedRequest("/api/Users/me/addresses", {
        method: "POST",
        token,
        body: address
      });
    },

    getShippingQuote(quote) {
      return authenticatedRequest("/api/Shipping/quote", { method: "POST", body: quote });
    },

    getShippingRates(requestBody) {
      return authenticatedRequest("/api/Shipping/rates", { method: "POST", body: requestBody });
    },

    /** POST /api/Orders (requires bearer token) */
    createOrder(token, order) {
      return authenticatedRequest("/api/Orders", {
        method: "POST",
        token,
        body: order
      });
    },

    /** POST /api/Orders/verify-payment (requires bearer token) */
    verifyOrderPayment(token, payment) {
      return authenticatedRequest("/api/Orders/verify-payment", {
        method: "POST",
        token,
        body: payment
      });
    },

    /** GET /api/Orders (requires bearer token) */
    getOrders(token, { fromDate, toDate } = {}) {
      const params = new URLSearchParams();
      if (fromDate) params.set("fromDate", fromDate);
      if (toDate) params.set("toDate", toDate);
      const query = params.toString();
      return authenticatedRequest("/api/Orders" + (query ? "?" + query : ""), { token });
    },

    /** GET /api/Orders/{orderId} (requires bearer token) */
    getOrder(token, orderId) {
      return authenticatedRequest("/api/Orders/" + encodeURIComponent(orderId), { token });
    },

    getCheckout(checkoutId) {
      return authenticatedRequest("/api/Orders/checkout/" + encodeURIComponent(checkoutId));
    }
  };
})();
