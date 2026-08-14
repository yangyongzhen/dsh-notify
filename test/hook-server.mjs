// Local webhook receiver for dsh-notify end-to-end tests.
// Prints every POST body and appends it to hook-received.jsonl.
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';

const PORT = Number(process.env.PORT ?? 9999);
const LOG = new URL('./hook-received.jsonl', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    const line = JSON.stringify({ time: new Date().toISOString(), method: req.method, url: req.url, body: raw });
    appendFileSync(LOG, line + '\n');
    console.log('HOOK ' + line);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`hook server listening on ${PORT}`));
