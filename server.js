const http = require("http");
const fs = require("fs");
const path = require("path");

const port = 3000;
const root = __dirname;

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

const server = http.createServer((req, res) => {
  let pathname = "/";
  try {
    pathname = decodeURIComponent(new URL(req.url || "/", "http://localhost").pathname);
  } catch (err) {
    res.writeHead(400);
    res.end("Bad Request");
    return;
  }

  if (pathname === "/") {
    pathname = "/index.html";
  }

  // Keep old blog URLs working after the files moved into /Blogs
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
