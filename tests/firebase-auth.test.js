const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "firebase-auth.js"), "utf8");
const loginHtml = fs.readFileSync(path.join(root, "login.html"), "utf8");

function googleAuth(navigator, popupError, backendError) {
  const calls = [];
  const tokenRefreshes = [];
  let session;
  const user = {
    uid: "google-user", email: "customer@example.com", displayName: "Customer",
    getIdToken: async (forceRefresh) => {
      tokenRefreshes.push(forceRefresh);
      return "firebase-token";
    }
  };
  const appModule = { getApps: () => [], initializeApp: () => ({}) };
  const authModule = {
    getAuth: () => ({}),
    GoogleAuthProvider: class {
      addScope() {}
      setCustomParameters() {}
    },
    getRedirectResult: async () => null,
    signInWithPopup: async () => {
      calls.push("popup");
      if (popupError) throw popupError;
      return { user };
    },
    signInWithRedirect: async () => { calls.push("redirect"); },
    signOut: async () => { calls.push("signout"); }
  };
  const window = {
    SPICEBLOOMS_FIREBASE: { apiKey: "test", authDomain: "test.firebaseapp.com", projectId: "test", appId: "test" },
    SpicebloomsApi: {
      firebaseLogin: async (token) => {
        calls.push(token);
        if (backendError) throw backendError;
        return { token: "backend-token", refreshToken: "refresh-token", expiry: 123 };
      }
    },
    SpicebloomsAuth: { set: (value) => { session = value; } }
  };
  const context = {
    window, navigator,
    loadModule: async (url) => url.endsWith("/firebase-app.js") ? appModule : authModule
  };
  vm.runInNewContext(source.replace(/\bimport\(/g, "loadModule("), context);
  return { auth: window.SpicebloomsGoogleAuth, calls, tokenRefreshes, session: () => session };
}

test("prepared iOS sign-in opens the popup synchronously and exchanges the backend token", async () => {
  for (const navigator of [
    { userAgent: "Mozilla/5.0 (iPhone) Version/17.0 Mobile Safari" },
    { userAgent: "Mozilla/5.0 (iPhone) CriOS/120.0 Mobile" },
    { userAgent: "Mozilla/5.0 (Macintosh) Version/17.0 Safari", platform: "MacIntel", maxTouchPoints: 5 }
  ]) {
    const flow = googleAuth(navigator);
    await flow.auth.completeRedirect();
    const signIn = flow.auth.signIn();
    assert.deepEqual(flow.calls, ["popup"]);
    assert.equal((await signIn).uid, "google-user");
    assert.deepEqual(flow.calls, ["popup", "firebase-token"]);
    assert.deepEqual(flow.tokenRefreshes, [true]);
    assert.equal(flow.session().token, "backend-token");
    assert.equal(flow.session().refreshToken, "refresh-token");
  }
});

test("prepared iOS sign-in signs out Firebase when the backend session exchange fails", async () => {
  const error = new Error("Backend authentication unavailable");
  const flow = googleAuth({ userAgent: "Mozilla/5.0 (iPhone)" }, undefined, error);
  await flow.auth.completeRedirect();
  const signIn = flow.auth.signIn();
  assert.deepEqual(flow.calls, ["popup"]);
  await assert.rejects(signIn, (actual) => actual === error);
  assert.deepEqual(flow.calls, ["popup", "firebase-token", "signout"]);
  assert.equal(flow.session(), undefined);
});

test("iOS popup failures remain visible without a cross-site redirect fallback", async () => {
  for (const code of ["auth/popup-blocked", "auth/operation-not-supported-in-this-environment", "auth/popup-closed-by-user"]) {
    const error = Object.assign(new Error("Popup failed"), { code });
    const flow = googleAuth({ userAgent: "Mozilla/5.0 (iPad)" }, error);
    await flow.auth.completeRedirect();
    await assert.rejects(flow.auth.signIn(), (actual) => actual === error);
    assert.deepEqual(flow.calls, ["popup"]);
    assert.equal(flow.session(), undefined);
  }
});

test("Android redirects and desktop popup fallback retain existing behavior", async () => {
  const android = googleAuth({ userAgent: "Mozilla/5.0 (Linux; Android 14)" });
  await android.auth.completeRedirect();
  assert.equal(await android.auth.signIn(), null);
  assert.deepEqual(android.calls, ["redirect"]);

  const desktop = googleAuth({ userAgent: "Mozilla/5.0 (Windows NT 10.0)" });
  await desktop.auth.completeRedirect();
  assert.equal((await desktop.auth.signIn()).uid, "google-user");
  assert.deepEqual(desktop.calls, ["popup", "firebase-token"]);

  const blocked = googleAuth({ userAgent: "Mozilla/5.0 (Windows NT 10.0)" },
    Object.assign(new Error("Blocked"), { code: "auth/popup-blocked" }));
  await blocked.auth.completeRedirect();
  assert.equal(await blocked.auth.signIn(), null);
  assert.deepEqual(blocked.calls, ["popup", "redirect"]);
});

test("login disables Google sign-in until Firebase redirect initialization completes", async () => {
  const button = { disabled: false };
  const errorElement = { textContent: "" };
  let release;
  const initialization = new Promise((resolve) => { release = resolve; });
  const destinations = [];
  const start = loginHtml.indexOf('    const googleBtn = document.getElementById("google-btn");');
  const end = loginHtml.indexOf('    const title = document.getElementById("auth-title");', start);
  assert.ok(start > 0 && end > start);
  vm.runInNewContext(loginHtml.slice(start, end), {
    document: { getElementById: (id) => id === "google-btn" ? button : errorElement },
    window: {
      SpicebloomsAuth: { get: () => null },
      SpicebloomsGoogleAuth: { completeRedirect: () => initialization },
      location: { replace: (url) => destinations.push(url) }
    },
    safeNext: "address.html?continue=pay",
    googleMessage: (error) => error.message
  });
  assert.equal(button.disabled, true);
  release({ uid: "google-user" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(button.disabled, false);
  assert.deepEqual(destinations, ["address.html?continue=pay"]);
});

test("login inline scripts compile", () => {
  for (const script of loginHtml.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
    if (script[1].trim()) new vm.Script(script[1]);
  }
});
