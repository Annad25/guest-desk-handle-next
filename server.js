import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const seed = JSON.parse(readFileSync(new URL('./requests.json', import.meta.url), 'utf8'));
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'application/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= 4096) chunks.push(chunk);
  }
  if (size > 4096) throw Object.assign(new Error('Request is too large.'), { status: 413 });
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Send a JSON object.'), { status: 400 }); }
}

/** Urgency levels from most to least pressing. Unknown values rank after the last one. */
export const URGENCY_ORDER = ['urgent', 'normal', 'low'];

const urgencyRank = urgency => {
  const rank = URGENCY_ORDER.indexOf(urgency);
  return rank === -1 ? URGENCY_ORDER.length : rank;
};
// Parse instead of comparing strings so timezone offsets order correctly; unparseable times sort last.
const createdTime = item => {
  const time = Date.parse(item.createdAt);
  return Number.isNaN(time) ? Infinity : time;
};
const formatTime = item => {
  const time = createdTime(item);
  return Number.isFinite(time) ? `${new Date(time).toISOString().slice(11, 16)} UTC` : 'an unknown time';
};
const listWords = words => words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} or ${words.at(-1)}`;

/**
 * Orders requests for handling: urgency (urgent, normal, low, then unknown),
 * then oldest createdAt, then ascending request ID as the final tie-break.
 * @param {{ id: string, urgency: string, createdAt: string }} a
 * @param {{ id: string, urgency: string, createdAt: string }} b
 * @returns {number} Negative when `a` should be handled first.
 */
export function compareForHandling(a, b) {
  return urgencyRank(a.urgency) - urgencyRank(b.urgency)
    || createdTime(a) - createdTime(b)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Chooses the single request the operator should handle next. Only open requests are eligible.
 * The reason is written for the operator: it says why this request beats the others still open.
 * @param {Array<object>} records All requests, in any order and any status.
 * @returns {{ request: object | null, reason: string }}
 */
export function pickNextRequest(records) {
  const open = records.filter(item => item.status === 'open').toSorted(compareForHandling);
  if (open.length === 0) return { request: null, reason: 'No open requests. Everything is handled for now.' };

  const [next] = open;
  const urgency = next.urgency || 'unspecified';
  const rank = urgencyRank(next.urgency);
  const peers = open.filter(item => urgencyRank(item.urgency) === rank);
  const sentences = [
    rank === 0 ? 'Urgent requests come first.' : `No ${listWords(URGENCY_ORDER.slice(0, rank))} requests are open.`,
    peers.length > 1
      ? `Oldest of ${peers.length} open ${urgency} requests, waiting since ${formatTime(next)}.`
      : `The only open ${urgency} request, waiting since ${formatTime(next)}.`,
  ];
  const tied = peers.filter(item => item !== next && createdTime(item) === createdTime(next));
  if (tied.length) sentences.push(`Same time as ${tied.map(item => item.id).join(', ')}; chosen by lower request ID.`);
  return { request: next, reason: sentences.join(' ') };
}

// A new server starts with independent fictional records. A browser reload keeps changes;
// restarting the process resets them. The exercise does not need a database or credentials.
/**
 * @param {{ requests?: Array<object>, log?: boolean }} [options]
 *   `requests` seeds the in-memory store (copied, never mutated).
 *   `log` prints one access line per request; off by default so tests stay quiet.
 *   Unexpected errors (500s) are always logged to stderr.
 */
export function createStarterServer({ requests = seed, log = false } = {}) {
  const records = structuredClone(requests);
  return createServer(async (req, res) => {
    if (log) {
      const started = performance.now();
      res.on('finish', () => console.log(`${req.method} ${req.url} ${res.statusCode} ${Math.round(performance.now() - started)}ms`));
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && files.has(pathname)) {
        const [file, type] = files.get(pathname);
        res.writeHead(200, { 'Content-Type': type });
        return res.end(readFileSync(new URL(`./public/${file}`, import.meta.url)));
      }
      if (req.method === 'GET' && pathname === '/api/requests') {
        return json(res, 200, { requests: records.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)) });
      }
      if (req.method === 'GET' && pathname === '/api/next-request') {
        return json(res, 200, pickNextRequest(records));
      }
      const match = pathname.match(/^\/api\/requests\/([A-Z0-9-]+)$/);
      if (req.method === 'PATCH' && match) {
        const record = records.find(item => item.id === match[1]);
        if (!record) return json(res, 404, { error: 'Request not found.' });
        const body = await readBody(req);
        if (!body || Array.isArray(body) || !['open', 'resolved'].includes(body.status)) return json(res, 400, { error: 'Status must be open or resolved.' });
        record.status = body.status;
        return json(res, 200, { request: record });
      }
      return json(res, 404, { error: 'This route is not available.' });
    } catch (error) {
      if (!error.status) console.error(`Unhandled error for ${req.method} ${req.url}:`, error);
      json(res, error.status || 500, { error: error.status ? error.message : 'The request could not be completed.' });
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const port = Number(process.env.PORT || 43211);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
  createStarterServer({ log: true }).listen(port, '127.0.0.1', () => console.log(`Guest desk: http://127.0.0.1:${port}`));
}
