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
});

test("product and catalogue inline scripts compile", () => {
  for (const html of [products, fs.readFileSync(path.join(root, "catalouge.html"), "utf8")]) {
    for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
      if (script[1].trim()) new vm.Script(script[1]);
    }
  }
});
