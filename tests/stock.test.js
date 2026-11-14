const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const products = fs.readFileSync(path.join(root, "products.html"), "utf8");
const variants = require("../catalog-variants.js");

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
  const context = { findCatalog: () => null, window: { SpicebloomsVariants: variants } };
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

test("adding variants preserves their exact SKU, photo and independent quantities", () => {
  let saved = "[]";
  const context = {
    localStorage: { getItem: () => saved, setItem: (key, value) => { saved = value; } },
    window: { location: {} },
    updateCartBadge: () => {},
    getCatalogImage: () => "wrong-family-image.png",
    getCatalogImageUri: value => value
  };
  vm.createContext(context);
  const start = products.indexOf("        function getCart()");
  const end = products.indexOf("        function updateCartBadge()", start);
  vm.runInContext(products.slice(start, end), context);
  vm.runInContext(`catalogLoaded = true; catalogImageItems = [
    { id: "peri-250", productGroupId: "edamame", flavor: "Peri Peri", quantity: "250 g", imageUri: "peri.png" },
    { id: "cheese-250", productGroupId: "edamame", flavor: "Cheese", quantity: "250 g", imageUri: "cheese.png" }
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
