/*
 * Shared cart pricing: identifies products across the different names each page
 * stores in the cart, and re-prices cart lines from the catalog API so the cart,
 * address page, and payment amount all use the same prices.
 */
(function () {
  const CACHE_KEY = "spiceblooms_catalog_prices";
  let currentPrices = null;

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

  function isCatalogItemAllowed(item) {
    return !!item && ![item.brandName, item.BrandName, item.itemName, item.ItemName, item.name]
      .some(value => /madhuri|maduri/i.test(String(value || "")));
  }

  async function loadPrices(force) {
    if (force === false && currentPrices) return currentPrices;
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
      if (!isCatalogItemAllowed(item)) return;
      const key = productKey(item.itemName || item.ItemName);
      const price = toNumber(item.actualPrice !== undefined ? item.actualPrice : item.ActualPrice);
      if (!key || price === null) return;
      const mrp = toNumber(item.oldPrice !== undefined ? item.oldPrice : item.OldPrice);
      const entry = {
        price: price,
        inStock: (item.inStock !== undefined ? item.inStock : item.InStock) !== false,
        catalogUnavailable: false,
        mrp: mrp && mrp > price ? mrp : 0,
        itemId: item.id,
        brandName: item.brandName || "",
        itemName: item.itemName,
        itemQuantity: item.quantity || "",
        imageUri: item.imageUri || "",
        image: item.imageUri || "",
        productGroupId: item.productGroupId || "",
        flavor: item.flavor || ""
      };
      prices["id:" + item.id] = entry;
      if (!item.productGroupId && (!prices[key] || prices[key].price < price)) prices[key] = entry;
    });
    currentPrices = prices;
    sessionStorage.removeItem(CACHE_KEY);
    return prices;
  }

  /** Returns { cart, changed } with each known product priced from the catalog API. */
  async function reprice(cart, force) {
    const prices = await loadPrices(force);
    let changed = false;
    const next = cart.map((item) => {
      const match = item.itemId ? prices["id:" + item.itemId]
        : isCatalogItemAllowed(item) ? prices[productKey(item.name)] : null;
      if (!match) {
        if (item.catalogUnavailable === true && item.inStock === false) return item;
        changed = true;
        return Object.assign({}, item, { inStock: false, catalogUnavailable: true });
      }
      const name = isCatalogItemAllowed(item) ? item.name : match.itemName;
      if (Number(item.price) === match.price && Number(item.mrp || 0) === match.mrp
        && item.name === name && item.image === match.image
        && item.itemId === match.itemId && item.brandName === match.brandName
        && item.itemName === match.itemName && item.itemQuantity === match.itemQuantity
        && item.imageUri === match.imageUri && item.inStock === match.inStock
        && item.catalogUnavailable === match.catalogUnavailable
        && item.productGroupId === match.productGroupId && item.flavor === match.flavor) return item;
      changed = true;
      return Object.assign({}, item, match, { name: name });
    });
    return { cart: next, changed: changed };
  }

  const api = { productKey: productKey, loadPrices: loadPrices, reprice: reprice, toNumber: toNumber,
    isCatalogItemAllowed: isCatalogItemAllowed };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.SpicebloomsPricing = api;
})();
