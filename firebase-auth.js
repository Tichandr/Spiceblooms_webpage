(function () {
  const SDK = "https://www.gstatic.com/firebasejs/13.0.0";
  const cfg = () => window.SPICEBLOOMS_FIREBASE || {};
  const isReady = () => {
    const c = cfg();
    return !!(c.apiKey && c.authDomain && c.projectId && c.appId);
  };

  let firebasePromise = null;
  let firebaseClient = null;

  async function writeSession(user) {
    if (!window.SpicebloomsAuth || !user) return;
    if (!window.SpicebloomsApi || typeof window.SpicebloomsApi.firebaseLogin !== "function") {
      throw new Error("The SpiceBlooms API client is unavailable. Reload the page and try again.");
    }
    const firebaseIdToken = await user.getIdToken(true);
    const apiSession = await window.SpicebloomsApi.firebaseLogin(firebaseIdToken);
    if (!apiSession || !apiSession.token) {
      throw new Error("Could not sign in to the SpiceBlooms service. Please try again.");
    }
    window.SpicebloomsAuth.set({
      provider: "google",
      uid: user.uid,
      email: user.email || "",
      name: user.displayName || "",
      photo: user.photoURL || "",
      at: Date.now(),
      token: apiSession.token,
      refreshToken: apiSession.refreshToken,
      expiry: apiSession.expiry,
      user: apiSession.user || {}
    });
  }

  async function loadFirebase() {
    if (!isReady()) {
      const error = new Error("Firebase is not configured yet.");
      error.code = "auth/not-configured";
      throw error;
    }
    if (!firebasePromise) {
      firebasePromise = Promise.all([
        import(SDK + "/firebase-app.js"),
        import(SDK + "/firebase-auth.js")
      ]).then(([appMod, authMod]) => {
        const app = appMod.getApps().length ? appMod.getApp() : appMod.initializeApp(cfg());
        firebaseClient = {
          auth: authMod.getAuth(app),
          GoogleAuthProvider: authMod.GoogleAuthProvider,
          signInWithPopup: authMod.signInWithPopup,
          signInWithRedirect: authMod.signInWithRedirect,
          getRedirectResult: authMod.getRedirectResult,
          firebaseSignOut: authMod.signOut
        };
        return firebaseClient;
      }).catch((error) => {
        firebasePromise = null;
        throw error;
      });
    }
    return firebasePromise;
  }

  function isIOS() {
    const ua = navigator.userAgent || "";
    return /iPhone|iPad|iPod/i.test(ua) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }

  function preferRedirect() {
    return !isIOS() && /Android/i.test(navigator.userAgent || "");
  }

  window.SpicebloomsGoogleAuth = {
    isReady: isReady,
    async completeRedirect() {
      if (!isReady()) return null;
      const { auth, getRedirectResult } = await loadFirebase();
      const result = await getRedirectResult(auth);
      if (result && result.user) {
        await writeSession(result.user);
        return result.user;
      }
      return null;
    },
    async signIn() {
      // Keep the prepared popup call in the click gesture on iOS.
      const { auth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, firebaseSignOut } = firebaseClient || await loadFirebase();
      const provider = new GoogleAuthProvider();
      provider.addScope("email");
      provider.addScope("profile");
      provider.setCustomParameters({ prompt: "select_account" });
      if (preferRedirect()) {
        await signInWithRedirect(auth, provider);
        return null;
      }
      try {
        const result = await signInWithPopup(auth, provider);
        try {
          await writeSession(result.user);
        } catch (error) {
          await firebaseSignOut(auth).catch(() => {});
          throw error;
        }
        return result.user;
      } catch (error) {
        const code = error && error.code;
        if (!isIOS() && (code === "auth/popup-blocked" || code === "auth/operation-not-supported-in-this-environment")) {
          await signInWithRedirect(auth, provider);
          return null;
        }
        throw error;
      }
    },
    async signOut() {
      if (!isReady()) return;
      const { auth, firebaseSignOut } = await loadFirebase();
      await firebaseSignOut(auth);
    }
  };
})();
