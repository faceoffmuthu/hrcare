import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

const source = new URL('../dist/', import.meta.url);
const output = new URL('../netlify-dist/', import.meta.url);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(source, output, { recursive: true });

const configUrl = new URL('auth-config.js', output);
let config = await readFile(configUrl, 'utf8');
const localApiUrl = 'apiUrl: window.location.hostname === "localhost" ? "http://localhost:3000" : "",';
if (!config.includes(localApiUrl)) {
  throw new Error('Could not find the expected local API setting in dist/auth-config.js.');
}
config = config.replace(localApiUrl, 'apiUrl: window.location.origin,');
await writeFile(configUrl, config);
console.log('Prepared Netlify static files with the same-origin Node API URL.');
