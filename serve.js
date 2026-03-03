const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8765;
const DIR = __dirname;

http.createServer((req, res) => {
  let filePath = path.join(DIR, req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);
  const mimeTypes = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png' };
  const contentType = mimeTypes[ext] || 'text/plain';
  fs.readFile(filePath, (err, content) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  });
}).listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
