(function () {
  const SDK = "https://www.gstatic.com/firebasejs/13.0.0";
  const cfg = () => window.SPICEBLOOMS_FIREBASE || {};
  const isReady = () => {
    const c = cfg();
    return !!(c.apiKey && c.authDomain && c.projectId && c.appId);
  };

  let firebasePromise = null;

  function writeSession(user) {
    if (!window.SpicebloomsAuth || !user) return;
    window.SpicebloomsAuth.set({
      provider: "google",
      uid: user.uid,
      email: user.email || "",
      name: user.displayName || "",
      photo: user.photoURL || "",
      at: Date.now()
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
        return {
          auth: authMod.getAuth(app),
          GoogleAuthProvider: authMod.GoogleAuthProvider,
          signInWithPopup: authMod.signInWithPopup,
          signInWithRedirect: authMod.signInWithRedirect,
          getRedirectResult: authMod.getRedirectResult,
          firebaseSignOut: authMod.signOut
        };
      });
    }
    return firebasePromise;
  }

  function preferRedirect() {
    const ua = navigator.userAgent || "";
    return /iPhone|iPad|iPod|Android/i.test(ua);
  }

  window.SpicebloomsGoogleAuth = {
    isReady: isReady,
    async completeRedirect() {
      if (!isReady()) return null;
      const { auth, getRedirectResult } = await loadFirebase();
      const result = await getRedirectResult(auth);
      if (result && result.user) {
        writeSession(result.user);
        return result.user;
      }
      return null;
    },
    async signIn() {
      const { auth, GoogleAuthProvider, signInWithPopup, signInWithRedirect } = await loadFirebase();
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
        writeSession(result.user);
        return result.user;
      } catch (error) {
        const code = error && error.code;
        if (code === "auth/popup-blocked" || code === "auth/operation-not-supported-in-this-environment") {
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
