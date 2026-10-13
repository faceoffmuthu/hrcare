import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../dist/', import.meta.url)));
const port = Number(process.env.WEB_PORT || 4173);
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

const send = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  response.end(body);
};

const server = createServer(async (request, response) => {
  if (!['GET', 'HEAD'].includes(request.method || '')) return send(response, 405, 'Method not allowed');

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url || '/', 'http://localhost').pathname);
  } catch {
    return send(response, 400, 'Invalid request path');
  }

  const requested = path.resolve(root, `.${pathname}`);
  const relativePath = path.relative(root, requested);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) return send(response, 403, 'Forbidden');

  let file = requested;
  try {
    if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
  } catch {
    // The browser app uses client-side routes, so fall back to the application shell.
    file = path.join(root, 'index.html');
  }

  try {
    const info = await stat(file);
    if (!info.isFile()) return send(response, 404, 'Not found');
    response.writeHead(200, {
      'content-type': mimeTypes[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': info.size,
    });
    if (request.method === 'HEAD') return response.end();
    createReadStream(file).on('error', () => send(response, 500, 'Could not read file')).pipe(response);
  } catch {
    return send(response, 404, 'Not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Static site available at http://localhost:${port}`);
});
