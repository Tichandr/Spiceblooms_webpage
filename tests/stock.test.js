const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const products = fs.readFileSync(path.join(root, "products.html"), "utf8");

test("product additions and combos reject sold-out items without changing the cart", () => {
  const saved = [];
  const alerts = [];
  const context = {
    localStorage: {
      getItem: () => "[]",
      setItem: (key, value) => saved.push([key, value])
    },
    window: { alert: (message) => alerts.push(message), location: {} },
    updateCartBadge: () => {},
    getCatalogImage: () => "",
    findCatalogItem: () => ({ inStock: false }),
    findComboCatalogItem: (item) => ({ inStock: item.name !== "Sold out" })
  };
  vm.createContext(context);
  const start = products.indexOf("        function getCart()");
  const end = products.indexOf("        function updateCartBadge()", start);
  assert.ok(start > 0 && end > start);
  vm.runInContext(products.slice(start, end), context);
  vm.runInContext('catalogImageItems = [{ id: "sold-out", inStock: false }]', context);
  context.addToCart("Sold out", 155, "", { itemId: "sold-out" });
  context.addCombo([{ name: "Available" }, { name: "Sold out" }]);
  assert.equal(saved.length, 0);
  assert.equal(alerts.length, 2);
  assert.equal(context.window.location.href, undefined);
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
    window: { alert: (message) => alerts.push(message) },
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
