const $ = id => document.getElementById(id);
let filter = 'open', records = [], busy = false;
// The server's latest recommendation. `state` is 'loading' | 'ready' | 'error'; the browser never picks on its own.
let next = { state: 'loading', request: null, reason: '' };
// The request most recently handled from the Handle next panel, so it can be undone.
let lastHandled = null;

function text(tag, value, className) {
  const element = document.createElement(tag);
  element.textContent = value;
  if (className) element.className = className;
  return element;
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, signal: AbortSignal.timeout(8000), headers: { 'Content-Type': 'application/json', ...options.headers } });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'The request could not be completed.');
  return body;
}

/** Sets a request's status through the existing PATCH endpoint. Throws if the server does not confirm it. */
const setStatus = (item, status) => api(`/api/requests/${encodeURIComponent(item.id)}`, { method: 'PATCH', body: JSON.stringify({ status }) });

/** Builds one request card. Shared by the inbox list and the Handle next panel so they look and behave alike. */
function requestCard(item, label, onClick) {
  const card = document.createElement('article'); card.className = 'request';
  const body = document.createElement('div');
  body.append(text('h3', item.title), text('p', item.detail));
  const meta = text('p', '', 'meta');
  meta.append(text('span', `${item.guest} · Room ${item.room}`), text('span', item.urgency, `pill ${item.urgency}`));
  if (item.status === 'resolved') meta.append(text('span', 'Handled', 'pill resolved'));
  meta.append(text('time', new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC'));
  body.append(meta);
  const button = text('button', label, 'handle');
  button.type = 'button'; button.disabled = busy; button.setAttribute('aria-label', `${label}: ${item.title}`);
  button.addEventListener('click', onClick);
  card.append(text('span', item.guest[0], 'guest-icon'), body, button);
  return { card, body };
}

/** Renders the Handle next panel from `next`: loading, error, empty queue, or the recommended request with its reason. */
function renderNext() {
  const panel = $('next-body');
  if (next.state === 'loading') return panel.replaceChildren(text('p', 'Finding the next request…', 'next-note'));
  if (next.state === 'error') return panel.replaceChildren(text('p', 'No recommendation right now. Refresh the inbox to try again.', 'next-note'));
  if (!next.request) return panel.replaceChildren(text('p', next.reason, 'next-note done'));
  const { card, body } = requestCard(next.request, 'Mark handled', handleNext);
  const reason = text('p', '', 'next-reason');
  reason.append(text('strong', 'Why this one: '), next.reason);
  body.append(reason);
  panel.replaceChildren(card);
}

function render() {
  const shown = records.filter(item => filter === 'all' || item.status === filter);
  $('requests').replaceChildren(...shown.map(item => requestCard(item, item.status === 'open' ? 'Mark handled' : 'Reopen', () => update(item)).card));
  const open = records.filter(item => item.status === 'open').length;
  $('open-count').textContent = `${open} open`; $('nav-count').textContent = open;
  $('empty').hidden = busy || !$('error').hidden || shown.length > 0;
  $('empty').textContent = filter === 'resolved' ? 'Handled requests will appear here.' : 'All caught up. Your guests are in good hands.';
  $('refresh').disabled = busy;
  $('next-undo').hidden = !lastHandled; $('next-undo').disabled = busy;
  for (const button of document.querySelectorAll('[data-filter]')) button.setAttribute('aria-pressed', String(button.dataset.filter === filter));
  renderNext();
}

function errorMessage(error) {
  return error.name === 'TimeoutError' ? 'The request took too long. Refresh the inbox to check its current state.' : error instanceof TypeError ? 'We could not reach the inbox. Check your connection, then refresh.' : error.message;
}

function showError(error, id = 'error') {
  $(id).textContent = errorMessage(error);
  $(id).hidden = false;
}

function clearMessages() {
  $('error').hidden = true; $('next-error').hidden = true; $('status').textContent = ''; $('next-status').textContent = '';
}

/**
 * Re-reads the inbox list and the server's recommendation together, so the panel and list never disagree.
 * Each failure is reported where it happened; a failed recommendation is never left on screen as if current.
 */
async function refresh() {
  const [list, recommendation] = await Promise.allSettled([api('/api/requests'), api('/api/next-request')]);
  if (list.status === 'fulfilled') records = list.value.requests; else showError(list.reason);
  if (recommendation.status === 'fulfilled') next = { state: 'ready', ...recommendation.value };
  else { next = { state: 'error', request: null, reason: '' }; showError(recommendation.reason, 'next-error'); }
}

async function load() {
  if (busy) return;
  busy = true; clearMessages(); $('status').textContent = 'Refreshing your inbox…'; lastHandled = null; next = { ...next, state: 'loading' }; render();
  await refresh();
  busy = false; $('status').textContent = ''; render();
}

/** Inbox card action (Mark handled / Reopen). Also refreshes the recommendation, since it may have changed. */
async function update(item) {
  if (busy) return;
  busy = true; clearMessages(); render();
  try {
    await setStatus(item, item.status === 'open' ? 'resolved' : 'open');
    lastHandled = null;
    await refresh();
    $('status').textContent = item.status === 'open' ? 'Request marked handled.' : 'Request reopened.';
  } catch (error) { showError(error); }
  finally { busy = false; render(); }
}

/**
 * Marks the recommended request handled, then shows the server's next recommendation.
 * If the update fails, the same recommendation stays with an error, so nothing looks done that isn't.
 */
async function handleNext() {
  const item = next.request;
  if (busy || !item) return;
  busy = true; clearMessages(); $('next-status').textContent = `Marking “${item.title}” handled…`; render();
  try {
    await setStatus(item, 'resolved');
    lastHandled = item;
    next = { ...next, state: 'loading' }; render();
    await refresh();
    $('next-status').textContent = `Marked “${item.title}” handled.`;
  } catch (error) { $('next-status').textContent = ''; showError(error, 'next-error'); }
  finally { busy = false; render(); }
}

/** Reopens the request last handled from the panel (one level of undo). On failure, Undo stays available to retry. */
async function undo() {
  const item = lastHandled;
  if (busy || !item) return;
  busy = true; clearMessages(); render();
  try {
    await setStatus(item, 'open');
    lastHandled = null;
    await refresh();
    $('next-status').textContent = `Reopened “${item.title}”.`;
  } catch (error) { showError(error, 'next-error'); }
  finally { busy = false; render(); }
}

for (const button of document.querySelectorAll('[data-filter]')) button.addEventListener('click', () => { filter = button.dataset.filter; render(); });
$('refresh').addEventListener('click', load);
$('next-undo').addEventListener('click', undo);
void load();
