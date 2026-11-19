const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const products = fs.readFileSync(path.join(root, "products.html"), "utf8");
const home = fs.readFileSync(path.join(root, "index.html"), "utf8");
const catalogue = fs.readFileSync(path.join(root, "catalouge.html"), "utf8");
const variants = require("../catalog-variants.js");
const pricing = require("../cart-pricing.js");

test("home page loads the API and pricing helpers before requesting catalog prices", () => {
  const apiScript = home.indexOf('<script src="api.js"></script>');
  const pricingScript = home.indexOf('<script src="cart-pricing.js"></script>');
  const loadPrices = home.indexOf("window.SpicebloomsPricing.loadPrices()");
  assert.ok(apiScript >= 0 && apiScript < pricingScript);
  assert.ok(pricingScript < loadPrices);
  for (const script of home.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (!/\bsrc\s*=/.test(script[1]) && script[2].trim()) new vm.Script(script[2]);
  }
});

test("variant groups select an exact flavour/size and reject ambiguous SKU metadata", () => {
  const items = ["Peri Peri", "Cheese", "Salty"].flatMap(flavor =>
    ["50 g", "250 g", "1 kg"].map(quantity => ({
      id: flavor + quantity, productGroupId: "edamame", productGroupName: "Edamame",
      flavor, quantity, inStock: true, imageUri: quantity === "250 g" ? flavor + ".png" : ""
    })));
  const group = variants.groupItems([...items, { id: "legacy" }]);
  assert.equal(group.length, 1);
  assert.equal(group[0].variants.length, 9);
  const selected = variants.select(group[0].variants, "Cheese", "1 kg");
  assert.equal(selected.id, "Cheese1 kg");
  assert.equal(variants.cartName(selected), "Edamame - Cheese - 1 kg");
  assert.equal(variants.initial(items).id, "Peri Peri250 g");
  assert.equal(variants.select(items, "Cheese", "100 g"), null);
  assert.throws(() => variants.groupItems([...items, items[0]]), /duplicate variants/);
  assert.throws(() => variants.groupItems([{ ...items[0], flavor: "" }]), /missing/);
});

test("variant galleries use only the selected SKU's images and deduplicate its primary image", () => {
  assert.deepEqual(variants.images({ imageUri: "peri-250g.png", imageUris: ["peri-250g.png", "peri-back.png"] }),
    ["peri-250g.png", "peri-back.png"]);
  assert.deepEqual(variants.images({ imageUri: "", imageUris: [] }), []);
});

test("Bag variant lines map back to their product family when moved to the wishlist", () => {
  const bag = fs.readFileSync(path.join(root, "cart.html"), "utf8");
  const start = bag.indexOf("        function enrich(item)");
  const end = bag.indexOf("        let bagDeliveryPin", start);
  const context = { findCatalog: () => null, window: { SpicebloomsVariants: variants, SpicebloomsPricing: pricing } };
  vm.createContext(context);
  vm.runInContext(bag.slice(start, end), context);
  const row = context.enrich({
    name: "Edamame - Cheese - 250 g", productGroupId: "roasted-edamame-beans",
    itemQuantity: "250 g", quantity: 1, price: 250
  });
  assert.equal(row.id, variants.productId("roasted-edamame-beans"));
  assert.equal(row.pack, "250 g");
});

test("product additions and combos reject sold-out items without changing the cart", () => {
  const saved = [];
  const alerts = [];
  const context = {
    localStorage: {
      getItem: () => "[]",
      setItem: (key, value) => saved.push([key, value])
    },
    window: { alert: (message) => alerts.push(message), location: {}, SpicebloomsPricing: pricing },
    updateCartBadge: () => {},
    getCatalogImage: () => "",
    findCatalogItem: () => ({ inStock: false }),
    findComboCatalogItem: (item) => ({ actualPrice: 155, inStock: item.name !== "Sold out" })
  };
  vm.createContext(context);
  const start = products.indexOf("        function getCart()");
  const end = products.indexOf("        function updateCartBadge()", start);
  assert.ok(start > 0 && end > start);
  vm.runInContext(products.slice(start, end), context);
  vm.runInContext('catalogLoaded = true; catalogImageItems = [{ id: "sold-out", inStock: false }]', context);
  context.addToCart("Sold out", 155, "", { itemId: "sold-out" });
  context.addCombo([{ name: "Available" }, { name: "Sold out" }]);
  assert.equal(saved.length, 0);
  assert.equal(alerts.length, 2);
  assert.equal(context.window.location.href, undefined);
});

test("adding variants preserves their exact SKU, photo and independent quantities", () => {
  let saved = "[]";
  const context = {
    localStorage: { getItem: () => saved, setItem: (key, value) => { saved = value; } },
    window: { location: {}, SpicebloomsPricing: pricing },
    updateCartBadge: () => {},
    getCatalogImage: () => "wrong-family-image.png",
    getCatalogImageUri: value => value
  };
  vm.createContext(context);
  const start = products.indexOf("        function getCart()");
  const end = products.indexOf("        function updateCartBadge()", start);
  vm.runInContext(products.slice(start, end), context);
  vm.runInContext(`catalogLoaded = true; catalogImageItems = [
    { id: "peri-250", actualPrice: 250, productGroupId: "edamame", flavor: "Peri Peri", quantity: "250 g", imageUri: "peri.png" },
    { id: "cheese-250", actualPrice: 250, productGroupId: "edamame", flavor: "Cheese", quantity: "250 g", imageUri: "cheese.png" }
  ];`, context);
  context.addToCart("Edamame - Peri Peri - 250 g", 250, "", { itemId: "peri-250", redirect: false });
  context.addToCart("Edamame - Cheese - 250 g", 250, "", { itemId: "cheese-250", redirect: false });
  context.addToCart("Edamame - Peri Peri - 250 g", 250, "", { itemId: "peri-250", redirect: false });
  const cart = JSON.parse(saved);
  assert.equal(cart.length, 2);
  assert.deepEqual(cart.map(item => [item.itemId, item.image, item.quantity]),
    [["peri-250", "peri.png", 2], ["cheese-250", "cheese.png", 1]]);
  assert.equal(cart[0].itemQuantity, "250 g");
});

test("stock buttons show sold out and restore their original label after restocking", () => {
  const context = {};
  vm.createContext(context);
  const start = products.indexOf("        function catalogInStock(");
  const end = products.indexOf("        function addToCart(", start);
  vm.runInContext(products.slice(start, end), context);
  const button = { dataset: {}, innerHTML: "Add to Cart", disabled: false };
  context.setStockButton(button, false);
  assert.equal(button.innerHTML, "Sold out");
  assert.equal(button.disabled, true);
  context.setStockButton(button, true);
  assert.equal(button.innerHTML, "Add to Cart");
  assert.equal(button.disabled, false);
  assert.equal(context.catalogInStock({ InStock: false }), false);
  assert.equal(context.catalogInStock({}), true);
  context.setStockButton(button, false, "Unavailable");
  assert.equal(button.innerHTML, "Unavailable");
});

test("a successfully loaded catalog prevents adding a missing ABC fallback product", () => {
  const alerts = [];
  const context = {
    window: { alert: (message) => alerts.push(message), SpicebloomsPricing: pricing },
    findCatalogItem: () => null
  };
  vm.createContext(context);
  const start = products.indexOf("        let catalogImageItems = [];");
  const end = products.indexOf("        function addProductToCart(", start);
  vm.runInContext(products.slice(start, end), context);
  vm.runInContext("catalogLoaded = true;", context);
  context.addToCart("ABC Health Drink", 199, "", {});
  assert.match(alerts[0], /not available in the current catalog/);
});

test("cart waits for fresh availability and applies it to the current cart after loading", async () => {
  const bag = fs.readFileSync(path.join(root, "cart.html"), "utf8");
  const start = bag.indexOf("        async function refreshBagCatalog()");
  const end = bag.indexOf("        window.addEventListener('pageshow'", start);
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let cart = [{ name: "ABC Health Drink", inStock: true }];
  const context = {
    bagCatalogReady: true, bagCatalogLoading: false,
    getCart: () => cart,
    saveCart: (value) => { cart = value; },
    renderCart: () => {}, showToast: () => {}, console,
    window: { SpicebloomsPricing: {
      loadPrices: async (force) => { assert.equal(force, true); await pending; },
      reprice: async (current) => ({ changed: true, cart: current.map(item => ({ ...item, inStock: false })) })
    } }
  };
  vm.createContext(context);
  vm.runInContext(bag.slice(start, end), context);
  const loading = context.refreshBagCatalog();
  assert.equal(context.bagCatalogReady, false);
  assert.equal(context.bagCatalogLoading, true);
  cart = [];
  release();
  await loading;
  assert.equal(context.bagCatalogReady, true);
  assert.equal(context.bagCatalogLoading, false);
  assert.equal(cart.length, 0);
});

test("product and catalogue inline scripts compile", () => {
  for (const html of [products, fs.readFileSync(path.join(root, "catalouge.html"), "utf8")]) {
    for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
      if (script[1].trim()) new vm.Script(script[1]);
    }
  }
});

test("product descriptions collapse to three lines and expand from Read more", () => {
  const start = products.indexOf("        function setProductDescriptionExpanded(");
  const end = products.indexOf("        // Cart Management Functions", start);
  const context = { document: { createElement: () => { throw new Error("Unexpected button creation"); } } };
  vm.createContext(context);
  vm.runInContext(products.slice(start, end), context);
  const classes = new Set();
  const description = {
    classList: {
      add: value => classes.add(value),
      remove: value => classes.delete(value),
      toggle: value => classes.has(value) ? (classes.delete(value), false) : (classes.add(value), true)
    },
    scrollHeight: 120,
    clientHeight: 60,
    nextElementSibling: null
  };
  const attributes = {};
  const button = {
    tagName: "BUTTON",
    dataset: {},
    matches: () => false,
    setAttribute: (name, value) => { attributes[name] = value; }
  };
  description.nextElementSibling = button;
  context.initializeProductReadMore({ querySelector: () => description });
  assert.equal(classes.has("line-clamp-3"), true);
  assert.equal(button.hidden, false);
  button.onclick();
  assert.equal(classes.has("line-clamp-3"), false);
  assert.equal(button.textContent, "Read less");
  assert.equal(attributes["aria-expanded"], "true");
  button.onclick();
  assert.equal(classes.has("line-clamp-3"), true);
  assert.equal(button.textContent, "Read more");
});

test("catalogue descriptions include an expandable Read more control", () => {
  assert.match(catalogue, /catalog-description-collapsed[\s\S]*?-webkit-line-clamp:\s*3/);
  assert.match(catalogue, /data-catalog-description/);
  assert.match(catalogue, /data-catalog-read-more aria-expanded="false">Read more/);
  assert.match(catalogue, /button\.textContent = collapsed \? 'Read more' : 'Read less'/);
  assert.match(catalogue, /initializeCatalogReadMore\(categoriesContainer\)/);
});

test("pending catalog blocks purchases and current API data replaces an existing stale cart price/name", () => {
  let saved = JSON.stringify([{ name: "Old name", itemId: "curry", price: 199, quantity: 1 }]);
  const alerts = [];
  const context = {
    localStorage: { getItem: () => saved, setItem: (key, value) => { saved = value; } },
    window: { alert: value => alerts.push(value), SpicebloomsPricing: pricing, location: {} },
    updateCartBadge: () => {}, getCatalogImageUri: value => value || "",
    findComboCatalogItem: () => null
  };
  vm.createContext(context);
  vm.runInContext(products.slice(products.indexOf("        function getCart()"),
    products.indexOf("        function updateCartBadge()")), context);
  context.addToCart("Old name", 199, "old.png", { itemId: "curry" });
  context.addCombo([{ name: "Old name", price: 199 }]);
  assert.equal(JSON.parse(saved)[0].quantity, 1);
  assert.equal(alerts.length, 2);
  assert.ok(alerts.every(message => /have not loaded/.test(message)));
  vm.runInContext(`catalogLoaded = true; catalogImageItems = [
    { id: "curry", brandName: "SpiceBlooms", itemName: "Curry Leaf Powder", actualPrice: 129, imageUri: "current.png" },
    { id: "retired", brandName: "MADURI", itemName: "Royya Karam", actualPrice: 199 }
  ]`, context);
  context.addToCart("Old name", 199, "old.png", { itemId: "curry", redirect: false });
  const cart = JSON.parse(saved);
  assert.deepEqual(cart.map(item => [item.name, item.price, item.quantity, item.image]),
    [["Curry Leaf Powder", 129, 2, "current.png"]]);
  context.addToCart("Royya Karam", 199, "", { itemId: "retired" });
  assert.equal(saved, JSON.stringify(cart));
  assert.match(alerts.at(-1), /not available/);
});

function catalogLoader(getCatalogItems) {
  const status = {};
  const retry = {};
  const state = {};
  const context = {
    document: { documentElement: { dataset: state },
      getElementById: id => id === "catalog-retry" ? retry : status,
      querySelector: () => null,
      querySelectorAll: () => [] },
    window: { SpicebloomsApi: { getCatalogItems }, SpicebloomsVariants: variants, SpicebloomsPricing: pricing },
    PRODUCT_CATALOG: [], API_CATALOG_PRODUCTS: {},
    catalogActualPrice: item => Number(item.actualPrice),
    initializeProductReadMore: () => {},
    console: { error: () => {} }
  };
  for (const name of ["applyCatalogImages", "addMissingCatalogCards", "mountCardHearts",
    "renderWishlist", "applyCatalogFilters", "syncProductFromHash", "refreshStockControls"]) context[name] = () => {};
  vm.createContext(context);
  vm.runInContext("let catalogRequestId = 0, catalogLoaded = false, catalogImageItems = [];\n" +
    products.slice(products.indexOf("        async function loadCatalogProductImages()"),
      products.indexOf("        function getProductById(")), context);
  return { context, state, status, retry,
    load: () => context.loadCatalogProductImages(),
    items: () => JSON.parse(vm.runInContext("JSON.stringify(catalogImageItems)", context)),
    ready: () => vm.runInContext("catalogLoaded", context) };
}

test("slow/failed catalog stays gated; retry restores current prices without retired brands", async () => {
  let fail;
  const pending = new Promise((resolve, reject) => { fail = reject; });
  let result = pending;
  const flow = catalogLoader(() => result);
  const loading = flow.load();
  assert.equal(flow.state.catalogState, "loading");
  assert.equal(flow.ready(), false);
  fail(new Error("offline"));
  await loading;
  assert.equal(flow.state.catalogState, "error");
  assert.equal(flow.retry.hidden, false);
  assert.match(flow.status.textContent, /Purchasing is paused/);
  result = { itemList: [
    { id: "current", itemName: "Royya Karam", brandName: "SpiceBlooms", actualPrice: 179 },
    { id: "retired", itemName: "MADHURI Royya Karam", actualPrice: 199 },
    { id: "retired-brand", brandName: "Maduri Spices", itemName: "Masala Karam", actualPrice: 199 }
  ], totalListCount: 3 };
  await flow.load();
  assert.equal(flow.state.catalogState, "ready");
  assert.equal(flow.ready(), true);
  assert.deepEqual(flow.items().map(item => item.id), ["current"]);
});

test("an older catalog response cannot overwrite a newer refresh", async () => {
  const releases = [];
  const flow = catalogLoader(() => new Promise(resolve => releases.push(resolve)));
  const older = flow.load();
  const newer = flow.load();
  releases[1]({ itemList: [{ id: "curry", actualPrice: 129 }], totalListCount: 1 });
  await newer;
  releases[0]({ itemList: [{ id: "curry", actualPrice: 199 }], totalListCount: 1 });
  await older;
  assert.equal(flow.items()[0].actualPrice, 129);
  assert.equal(flow.state.catalogState, "ready");
});

test("a missing named combo component cannot fall back to another rice mix or replace an exact SKU", () => {
  const context = {
    catalogImageItems: [{ id: "moringa-current", itemName: "Moringa Instant Rice Mix", actualPrice: 149 }],
    normalizeCatalogName: value => value.toLowerCase(),
    getCatalogItemName: item => item.itemName,
    findCatalogItem: () => { throw new Error("Known combo component must not use fuzzy matching"); }
  };
  vm.createContext(context);
  vm.runInContext(products.slice(products.indexOf("        const API_CATALOG_PRODUCTS ="),
    products.indexOf("        function getCatalogPriceElements(")), context);
  vm.runInContext(products.slice(products.indexOf("        function findComboCatalogItem("),
    products.indexOf("        function renderComboItemPrice(")), context);
  assert.equal(context.findComboCatalogItem({ name: "Chicken Powder Instant Rice Mix" }), null);
  assert.equal(context.findComboCatalogItem({ name: "Moringa Instant Rice Mix" }).id, "moringa-current");
  assert.equal(context.findComboCatalogItem({ name: "Moringa Instant Rice Mix", itemId: "retired-sku" }), null);
});
