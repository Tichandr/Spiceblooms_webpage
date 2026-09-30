const http = require("http");
const fs = require("fs");
const path = require("path");

const port = 3000;

const server = http.createServer((req, res) => {
  // Handle root path and file paths
  let filePath = "." + req.url;
  if (filePath === "./") {
    filePath = "./index.html"; // Double-check this filename for spaces/typos!
  }

  // Set MIME types
  const extname = path.extname(filePath).toLowerCase();
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

  const contentType = mimeTypes[extname] || "application/octet-stream";
  const isText = contentType.startsWith("text/") || contentType.includes("javascript") || contentType.includes("json") || contentType.includes("svg");

  fs.readFile(filePath, (error, content) => {
    if (error) {
      if (error.code === "ENOENT") {
        // Serve 404 page
        fs.readFile("./404.html", (error404, content404) => {
          res.writeHead(404, { "Content-Type": "text/html" });
          res.end(content404 || "404 Not Found");
        });
      } else {
        res.writeHead(500);
        res.end(`Server Error: ${error.code}`);
      }
    } else {
      res.writeHead(200, { "Content-Type": contentType });
      res.end(content, isText ? "utf-8" : undefined);
    }
  });
});

server.listen(port, () => {
  console.log(`Server running at http://localhost:${port}/`);
});
