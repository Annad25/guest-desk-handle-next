import test from 'node:test';
import assert from 'node:assert/strict';
import { createStarterServer } from '../server.js';

async function fixture(t, options) {
  const server = createStarterServer(options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return (path, options) => fetch(`http://127.0.0.1:${server.address().port}${path}`, options);
}

test('the starter serves its page, script, and fictional request inbox', async t => {
  const call = await fixture(t);
  assert.match(await (await call('/')).text(), /Small requests/);
  assert.match((await call('/app.js')).headers.get('content-type'), /javascript/);
  const response = await call('/api/requests');
  assert.equal(response.status, 200);
  const { requests } = await response.json();
  assert.equal(requests.length, 6);
  assert.equal(requests.filter(item => item.status === 'open').length, 5);
});

test('handling a request is reflected by the next read and is safe to repeat', async t => {
  const call = await fixture(t);
  for (let i = 0; i < 2; i++) {
    const response = await call('/api/requests/GD-103', { method: 'PATCH', body: JSON.stringify({ status: 'resolved' }) });
    assert.equal(response.status, 200);
  }
  assert.equal((await (await call('/api/requests')).json()).requests.find(item => item.id === 'GD-103').status, 'resolved');
  const other = await fixture(t);
  assert.equal((await (await other('/api/requests')).json()).requests.find(item => item.id === 'GD-103').status, 'open');
});

test('invalid updates and unknown paths do not mutate the inbox or expose source', async t => {
  const call = await fixture(t);
  for (const body of ['null', '{}', 'not-json', '{"status":"missing"}']) assert.equal((await call('/api/requests/GD-103', { method: 'PATCH', body })).status, 400);
  assert.equal((await call('/api/requests/GD-999', { method: 'PATCH', body: '{"status":"resolved"}' })).status, 404);
  assert.equal((await call('/server.js')).status, 404);
  assert.equal((await call('/package.json')).status, 404);
  assert.equal((await call('/api/requests/GD-103', { method: 'PATCH', body: ' '.repeat(4097) })).status, 413);
});

test('an empty inbox remains a successful response', async t => {
  const call = await fixture(t, { requests: [] });
  assert.deepEqual(await (await call('/api/requests')).json(), { requests: [] });
});

const item = (id, urgency, createdAt, status = 'open') => ({ id, guest: 'Test', room: '1', title: `Request ${id}`, detail: '', urgency, status, createdAt });
const next = async call => (await call('/api/next-request')).json();
const resolve = (call, id, status = 'resolved') => call(`/api/requests/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });

test('next request: seed data picks the urgent tie by lower ID and explains why', async t => {
  const call = await fixture(t);
  const response = await call('/api/next-request');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/json/);
  const { request, reason } = await response.json();
  assert.equal(request.id, 'GD-103');
  const listed = (await (await call('/api/requests')).json()).requests.find(r => r.id === 'GD-103');
  assert.deepEqual(request, listed, 'returns the existing request object unchanged');
  assert.match(reason, /Urgent requests come first/);
  assert.match(reason, /Oldest of 2 open urgent requests, waiting since 08:30 UTC/);
  assert.match(reason, /Same time as GD-105; chosen by lower request ID/);
});

test('next request: an exact createdAt tie is broken by ascending ID regardless of input order', async t => {
  const at = '2026-11-03T09:00:00Z';
  const call = await fixture(t, { requests: [item('GD-202', 'normal', at), item('GD-200', 'normal', at), item('GD-201', 'normal', at)] });
  assert.equal((await next(call)).request.id, 'GD-200');
  await resolve(call, 'GD-200');
  assert.equal((await next(call)).request.id, 'GD-201');
});

test('next request: resolved requests are never recommended, even when urgent and oldest', async t => {
  const call = await fixture(t, { requests: [item('GD-301', 'urgent', '2026-11-03T07:00:00Z', 'resolved'), item('GD-302', 'low', '2026-11-03T10:00:00Z')] });
  const { request, reason } = await next(call);
  assert.equal(request.id, 'GD-302');
  assert.match(reason, /No urgent or normal requests are open/);
  assert.match(reason, /The only open low request/);
});

test('next request: handling each recommendation walks the seed queue in priority order, then empties', async t => {
  const call = await fixture(t);
  const order = [];
  for (let body = await next(call); body.request; body = await next(call)) {
    assert.ok(order.length < 10, 'queue should terminate');
    order.push(body.request.id);
    assert.equal((await resolve(call, body.request.id)).status, 200);
  }
  assert.deepEqual(order, ['GD-103', 'GD-105', 'GD-102', 'GD-106', 'GD-101'], 'GD-104 is resolved and never appears');
  const empty = await next(call);
  assert.equal(empty.request, null);
  assert.match(empty.reason, /No open requests/);
});

test('next request: an empty inbox returns request null with a reason', async t => {
  const call = await fixture(t, { requests: [] });
  const response = await call('/api/next-request');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ['reason', 'request']);
  assert.equal(body.request, null);
  assert.ok(body.reason.length > 0);
});

test('next request: a reopened request becomes eligible again', async t => {
  const call = await fixture(t);
  await resolve(call, 'GD-103');
  assert.equal((await next(call)).request.id, 'GD-105');
  await resolve(call, 'GD-103', 'open');
  assert.equal((await next(call)).request.id, 'GD-103');
});

test('next request: unknown urgency ranks after low, and offsets compare as real times', async t => {
  const call = await fixture(t, { requests: [item('GD-401', 'someday', '2026-11-03T00:00:00Z'), item('GD-402', 'low', '2026-11-03T09:00:00+02:00'), item('GD-403', 'low', '2026-11-03T08:00:00Z')] });
  assert.equal((await next(call)).request.id, 'GD-402', '09:00+02:00 is 07:00Z, older than 08:00Z');
  await resolve(call, 'GD-402'); await resolve(call, 'GD-403');
  assert.equal((await next(call)).request.id, 'GD-401');
});
