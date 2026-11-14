/*
 * Shared cart pricing: identifies products across the different names each page
 * stores in the cart, and re-prices cart lines from the catalog API so the cart,
 * address page, and payment amount all use the same prices.
 */
(function () {
  const CACHE_KEY = "spiceblooms_catalog_prices";
  const CACHE_MS = 10 * 60 * 1000;

  const PRODUCT_KEYWORDS = {
    moringa: ["moringa instant rice mix", "moringa instant ricemix", "moringa rice mix"],
    dhanya: ["dhaniya", "dhanya", "dhanaya"],
    pesara: ["pesara podi"],
    turmeric: ["turmeric powder"],
    kandi: ["kandi podi"],
    "masala-karam": ["masala karam", "masal karam"],
    "garam-21": ["21 garam masala"],
    sambar: ["sambar powder"],
    royya: ["royya karam"],
    idli: ["idli karam podi"],
    karivepaku: ["karivepaku podi", "curryleaf", "curry leaf"],
    rasam: ["rasam powder"],
    chicken: ["chicken powder"],
    abc: ["abc health drink"],
    "podi-combo": ["podi combo"]
  };

  const normalize = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

  function productKey(name) {
    const normalized = normalize(name);
    const id = Object.keys(PRODUCT_KEYWORDS).find((key) =>
      PRODUCT_KEYWORDS[key].some((word) => normalized.indexOf(word) !== -1)
    );
    return id || normalized;
  }

  const toNumber = (value) => {
    const number = parseFloat(String(value === undefined || value === null ? "" : value).replace(/[^0-9.]/g, ""));
    return Number.isFinite(number) && number > 0 ? number : null;
  };

  function readCache() {
    try {
      const cached = JSON.parse(sessionStorage.getItem(CACHE_KEY) || "null");
      if (cached && cached.at && Date.now() - cached.at < CACHE_MS && cached.prices) return cached.prices;
    } catch (error) {
      return null;
    }
    return null;
  }

  async function loadPrices(force) {
    const cached = readCache();
    if (!force && cached && Object.values(cached).every((item) => item.itemId && typeof item.inStock === "boolean")) return cached;
    if (!window.SpicebloomsApi || !window.SpicebloomsApi.getCatalogItems) {
      throw new Error("Prices are unavailable right now.");
    }
    const pageSize = 50;
    const items = [];
    let page = 1;
    let total = Infinity;
    while (items.length < total) {
      const result = await window.SpicebloomsApi.getCatalogItems({ page: page, pageSize: pageSize });
      if (!result || !Array.isArray(result.itemList)) throw new Error("Prices are unavailable right now.");
      items.push(...result.itemList);
      total = Number(result.totalListCount) || items.length;
      if (!result.itemList.length) break;
      page += 1;
    }
    const prices = {};
    items.forEach((item) => {
      const key = productKey(item.itemName || item.ItemName);
      const price = toNumber(item.actualPrice !== undefined ? item.actualPrice : item.ActualPrice);
      if (!key || price === null) return;
      const current = prices[key];
      if (current && current.price >= price) return;
      const mrp = toNumber(item.oldPrice !== undefined ? item.oldPrice : item.OldPrice);
      prices[key] = {
        price: price,
        inStock: (item.inStock !== undefined ? item.inStock : item.InStock) !== false,
        mrp: mrp && mrp > price ? mrp : 0,
        itemId: item.id,
        brandName: item.brandName || "",
        itemName: item.itemName,
        itemQuantity: item.quantity || "",
        imageUri: item.imageUri || ""
      };
    });
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), prices: prices }));
    return prices;
  }

  /** Returns { cart, changed } with each known product priced from the catalog API. */
  async function reprice(cart, force) {
    const prices = await loadPrices(force);
    let changed = false;
    const next = cart.map((item) => {
      const match = prices[productKey(item.name)];
      if (!match) return item;
      if (Number(item.price) === match.price && Number(item.mrp || 0) === match.mrp
        && item.itemId === match.itemId && item.brandName === match.brandName
        && item.itemName === match.itemName && item.itemQuantity === match.itemQuantity
        && item.imageUri === match.imageUri && item.inStock === match.inStock) return item;
      changed = true;
      return Object.assign({}, item, match);
    });
    return { cart: next, changed: changed };
  }

  const api = { productKey: productKey, loadPrices: loadPrices, reprice: reprice, toNumber: toNumber };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.SpicebloomsPricing = api;
})();
