(function () {
  const KEY = "spiceblooms_session";

  const read = () => {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      return data && data.phone ? data : null;
    } catch (error) {
      return null;
    }
  };

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
    btn.addEventListener("click", () => {
      window.SpicebloomsAuth.clear();
      document.querySelectorAll("[data-sign-out]").forEach((el) => el.classList.add("hidden"));
      window.location.reload();
    });
  });
})();
