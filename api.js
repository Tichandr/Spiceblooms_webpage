/*
 * Spiceblooms API client (framework-agnostic).
 * Plain fetch-based functions with no DOM access, so this can be moved into a
 * React/Angular service with minimal changes.
 */
(function () {
  const API_BASE_URL = "https://localhost:7100";
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

  async function request(path, { method = "GET", body, token } = {}) {
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = "Bearer " + token;

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
      throw new ApiError(
        extractMessage(data, "Something went wrong (" + response.status + "). Please try again."),
        response.status,
        data
      );
    }
    return data;
  }

  const toApiPhone = (tenDigitNumber) => PHONE_PREFIX + tenDigitNumber;

  window.SpicebloomsApi = {
    ApiError,

    /** POST /api/Auth/otp/send -> { sessionId, message } */
    sendOtp(phone) {
      return request("/api/Auth/otp/send", {
        method: "POST",
        body: { phone: toApiPhone(phone) }
      });
    },

    /** POST /api/Auth/otp/verify -> { token, refreshToken, expiry, user } */
    verifyOtp({ phone, sessionId, otp }) {
      return request("/api/Auth/otp/verify", {
        method: "POST",
        body: { phone: toApiPhone(phone), sessionId, otp }
      });
    },

    /** PUT /api/Auth/profile (requires bearer token) -> UserInfo */
    completeProfile(token, { fullName, email, phone }) {
      return request("/api/Auth/profile", {
        method: "PUT",
        token,
        body: { fullName, email, phone: phone ? toApiPhone(phone) : undefined }
      });
    }
  };
})();
