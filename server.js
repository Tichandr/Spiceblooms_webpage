const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const port = 3000;
const root = __dirname;
const addressStorePath = path.join(root, "data", "addresses.json");

const mimeTypes = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
};

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cross-Origin-Opener-Policy": "same-origin-allow-popups"
  });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 32 * 1024) {
        reject(new Error("too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error("invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

function customerKey(req) {
  const raw = String(req.headers["x-spiceblooms-customer"] || "").trim().toLowerCase();
  if (!raw || raw.length > 200 || /[\\/]/.test(raw)) return "";
  return raw;
}

function clip(value, max) {
  return String(value || "").trim().slice(0, max);
}

function digits(value) {
  return String(value || "").replace(/\D/g, "");
}

function fingerprint(address) {
  return [
    clip(address.name, 80).toLowerCase(),
    digits(address.phone),
    clip(address.line1, 160).toLowerCase(),
    clip(address.postcode, 16).toLowerCase(),
    clip(address.country, 56).toLowerCase()
  ].join("|");
}

function validateAddress(input, countryHint) {
  const country = clip(input.country || countryHint || "India", 56) || "India";
  const address = {
    name: clip(input.name, 80),
    phone: clip(input.phone, 24),
    line1: clip(input.line1, 160),
    line2: clip(input.line2, 160),
    building: clip(input.building, 80),
    area: clip(input.area, 80),
    city: clip(input.city, 80),
    state: clip(input.state, 80),
    postcode: clip(input.postcode, 16),
    country: country,
    type: /^(HOME|WORK|OTHER)$/i.test(input.type) ? String(input.type).toUpperCase() : "HOME",
    isDefault: Boolean(input.isDefault)
  };

  const errors = {};
  if (address.name.length < 2) errors.name = "Enter the full name.";
  const phoneDigits = digits(address.phone);
  if (country.toLowerCase() === "india") {
    if (!/^[6-9]\d{9}$/.test(phoneDigits) && !/^91[6-9]\d{9}$/.test(phoneDigits)) {
      errors.phone = "Enter a valid 10-digit Indian mobile number.";
    }
  } else if (phoneDigits.length < 6 || phoneDigits.length > 15) {
    errors.phone = "Enter a valid mobile number.";
  }
  if (address.line1.length < 4) errors.line1 = "Enter address line 1.";
  if (address.area.length < 2) errors.area = "Enter the locality or area.";
  if (address.city.length < 2) errors.city = "Enter the city.";
  if (address.state.length < 2) errors.state = "Enter the state or region.";
  if (country.toLowerCase() === "india") {
    if (!/^\d{6}$/.test(address.postcode)) errors.postcode = "Enter a valid 6-digit PIN code.";
  } else if (country.toLowerCase() === "australia") {
    if (!/^\d{4}$/.test(address.postcode)) errors.postcode = "Enter a valid 4-digit postcode.";
  } else if (!/^[A-Za-z0-9][A-Za-z0-9\s-]{2,15}$/.test(address.postcode)) {
    errors.postcode = "Enter a valid postcode.";
  }
  if (!address.country) errors.country = "Select a country.";

  if (Object.keys(errors).length) {
    const error = new Error("invalid");
    error.fields = errors;
    throw error;
  }
  return address;
}

function loadStore() {
  try {
    const raw = fs.readFileSync(addressStorePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    return {};
  }
}

function saveStore(store) {
  fs.mkdirSync(path.dirname(addressStorePath), { recursive: true });
  fs.writeFileSync(addressStorePath, JSON.stringify(store, null, 2));
}

function listFor(store, key) {
  return Array.isArray(store[key]) ? store[key] : [];
}

function applyDefault(list, nextId, makeDefault) {
  if (makeDefault || list.length === 1) {
    list.forEach((item) => {
      item.isDefault = item.id === nextId;
    });
  }
}

async function handleAddressApi(req, res, pathname) {
  const key = customerKey(req);
  if (!key) {
    sendJson(res, 401, { error: "Sign in is required to manage addresses." });
    return;
  }

  const match = pathname.match(/^\/api\/addresses(?:\/([^/]+))?$/);
  if (!match) {
    sendJson(res, 404, { error: "Not found." });
    return;
  }

  const id = match[1] ? decodeURIComponent(match[1]) : "";
  const store = loadStore();
  const list = listFor(store, key);

  if (req.method === "GET" && !id) {
    sendJson(res, 200, { addresses: list });
    return;
  }

  if (req.method === "POST" && !id) {
    const body = await readBody(req);
    const data = validateAddress(body);
    const dup = list.find((item) => fingerprint(item) === fingerprint(data));
    if (dup) {
      sendJson(res, 409, { error: "This address is already saved.", address: dup });
      return;
    }
    const now = new Date().toISOString();
    const address = Object.assign({
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now
    }, data);
    list.push(address);
    applyDefault(list, address.id, address.isDefault || list.length === 1);
    store[key] = list;
    saveStore(store);
    sendJson(res, 201, { address: list.find((item) => item.id === address.id), addresses: list });
    return;
  }

  const current = list.find((item) => item.id === id);
  if (!current) {
    sendJson(res, 404, { error: "Address not found." });
    return;
  }

  if (req.method === "PUT") {
    const body = await readBody(req);
    const data = validateAddress(body);
    const dup = list.find((item) => item.id !== id && fingerprint(item) === fingerprint(data));
    if (dup) {
      sendJson(res, 409, { error: "This address is already saved.", address: dup });
      return;
    }
    const next = Object.assign({}, current, data, { id: current.id, createdAt: current.createdAt, updatedAt: new Date().toISOString() });
    store[key] = list.map((item) => item.id === id ? next : item);
    applyDefault(store[key], id, next.isDefault);
    saveStore(store);
    sendJson(res, 200, { address: store[key].find((item) => item.id === id), addresses: store[key] });
    return;
  }

  if (req.method === "DELETE") {
    const remaining = list.filter((item) => item.id !== id);
    if (remaining.length === 1) remaining[0].isDefault = true;
    store[key] = remaining;
    saveStore(store);
    sendJson(res, 200, { addresses: remaining });
    return;
  }

  sendJson(res, 405, { error: "Method not allowed." });
}

const server = http.createServer((req, res) => {
  let pathname = "/";
  try {
    pathname = decodeURIComponent(new URL(req.url || "/", "http://localhost").pathname);
  } catch (err) {
    res.writeHead(400);
    res.end("Bad Request");
    return;
  }

  if (pathname.startsWith("/api/addresses")) {
    handleAddressApi(req, res, pathname).catch((error) => {
      if (error.message === "too_large") {
        sendJson(res, 413, { error: "Request is too large." });
        return;
      }
      if (error.message === "invalid_json") {
        sendJson(res, 400, { error: "Invalid address data." });
        return;
      }
      if (error.message === "invalid") {
        sendJson(res, 422, { error: "Please correct the highlighted fields.", fields: error.fields || {} });
        return;
      }
      sendJson(res, 500, { error: "Address service is unavailable." });
    });
    return;
  }

  if (pathname === "/") {
    pathname = "/index.html";
  }

  if (/^\/blogs\d*\.html$/i.test(pathname)) {
    res.writeHead(301, { Location: "/Blogs" + pathname });
    res.end();
    return;
  }

  const filePath = path.normalize(path.join(root, pathname));
  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  const extname = path.extname(filePath).toLowerCase();
  const contentType = mimeTypes[extname] || "application/octet-stream";
  const isText = contentType.startsWith("text/") || contentType.includes("javascript") || contentType.includes("json") || contentType.includes("svg");

  fs.readFile(filePath, (error, content) => {
    if (error) {
      if (error.code === "ENOENT") {
        fs.readFile(path.join(root, "404.html"), (error404, content404) => {
          res.writeHead(404, { "Content-Type": "text/html" });
          res.end(content404 || "404 Not Found");
        });
      } else {
        res.writeHead(500);
        res.end(`Server Error: ${error.code}`);
      }
    } else {
      res.writeHead(200, {
        "Content-Type": contentType,
        "Cross-Origin-Opener-Policy": "same-origin-allow-popups"
      });
      res.end(content, isText ? "utf-8" : undefined);
    }
  });
});

server.listen(port, () => {
  console.log(`Server running at http://localhost:${port}/`);
});
