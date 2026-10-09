(function () {
  const KEY = "spiceblooms_session";

  const read = () => {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      return data && (data.phone || data.email || data.uid) ? data : null;
    } catch (error) {
      return null;
    }
  };

  const loadGoogleAuth = () => new Promise((resolve) => {
    if (window.SpicebloomsGoogleAuth) {
      resolve(window.SpicebloomsGoogleAuth);
      return;
    }
    const load = (src, next) => {
      const script = document.createElement("script");
      script.src = src;
      script.onload = next;
      script.onerror = () => resolve(null);
      document.head.appendChild(script);
    };
    load("firebase-config.js", () => {
      load("firebase-auth.js", () => resolve(window.SpicebloomsGoogleAuth || null));
    });
  });

  window.SpicebloomsAuth = {
    get: read,
    set(session) {
      localStorage.setItem(KEY, JSON.stringify(session));
    },
    clear() {
      localStorage.removeItem(KEY);
    }
  };

  const session = read();
  document.querySelectorAll("[data-sign-out]").forEach((btn) => {
    if (!session) return;
    btn.classList.remove("hidden");
    btn.addEventListener("click", async () => {
      const current = window.SpicebloomsAuth.get();
      window.SpicebloomsAuth.clear();
      document.querySelectorAll("[data-sign-out]").forEach((el) => el.classList.add("hidden"));
      if (current && current.provider === "google") {
        try {
          const googleAuth = await loadGoogleAuth();
          if (googleAuth) await googleAuth.signOut();
        } catch (error) {
          // Local session is already cleared.
        }
      }
      window.location.reload();
    });
  });
})();
