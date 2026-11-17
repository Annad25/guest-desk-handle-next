# Handle next — plan and assumptions

## Who I'm helping
A front-desk operator working a busy guest inbox alone. Today they scan every card to decide what matters most. Their worry: a guest stuck outside while they handle extra towels.

## What success looks like
- When the inbox opens, the operator sees **one recommended request** and a plain reason for it, without reading the whole list.
- They can mark it handled in one click and the **next recommendation appears straight away**, chosen by the server.
- When nothing is open, they're told so clearly. When something fails, they're told it failed, and nothing looks done when it isn't.
- The existing inbox (filters, Refresh, Mark handled / Reopen) works exactly as before.

## What I'll change
1. **Backend: `GET /api/next-request`** in `server.js`
   - Considers only `status === "open"`.
   - Sort order: urgency rank (urgent 0, normal 1, low 2), then oldest `createdAt`, then ascending `id`.
   - Returns `{ request, reason }`. The reason names the urgency and why this request beat the others, e.g. *"Urgent and waiting the longest (since 08:30 UTC). Tied on time with GD-105; picked by request ID."*
   - Empty queue: `{ request: null, reason: "No open requests. Everything is handled." }` with status 200.
2. **Frontend: "Handle next" panel** above the inbox list (`index.html`, `app.js`, `style.css`)
   - Shows the recommended request (title, guest, room, urgency, time) and the server's reason, shown as-is.
   - A **Mark handled** button sends the existing `PATCH /api/requests/:id`, then fetches both the list and `/api/next-request` again.
   - States:
     - Loading: "Finding the next request…"
     - Empty: the server's reason, no button
     - Error: a message in the panel, and the old recommendation is not kept as if it were current
   - Uses the same `busy` flag as the inbox, so you can't fire two updates at once.
   - Inbox actions (Mark handled / Reopen on a card, Refresh) also refresh the recommendation, so the two never disagree.
3. **Tests** in `test/server.test.js`:
   - Seed-data pick (GD-103)
   - Equal-time tie (GD-103 beats GD-105)
   - Resolved-item exclusion (GD-104 is urgent and oldest but never picked)
   - Full urgency ordering as items are handled one by one
   - Empty queue (`request: null` with a reason)
   - A request becomes eligible again after being reopened
4. **Usability improvement: Undo after "Mark handled" in the panel.** After handling, the panel briefly shows "Marked GD-103 handled · Undo", which reopens it through the existing PATCH.
   - *Benefit:* the panel is a fast one-click flow, so mis-clicks will happen. Without undo, a mis-clicked urgent request disappears from the queue and the operator has to hunt for it under the Handled filter.
   - *Tradeoff:* a little extra UI state. It only covers the most recent action, and undo is just a reopen, with no real transaction history.

5. **Code quality**
   - The selection rules live in one exported, JSDoc'd function (`pickNextRequest`). The endpoint is a thin wrapper, so the rules are tested directly and over HTTP.
   - New frontend functions get short JSDoc describing what they fetch and how they change state.
   - **Logging:** unexpected 500s are logged with method, path and stack. Today they are swallowed silently. When run with `npm start`, the server also logs one line per request (`GET /api/next-request 200 2ms`). Per-request logging is off by default in `createStarterServer`, so `npm test` output stays clean.
   - No unrelated reformatting or docstrings added to the starter code, to keep the diff focused.

## Assumptions
- One operator and no concurrent editors. Recommendations come from whatever the server holds when you ask. No locking or claiming.
- `createdAt` values are parsed as timestamps (not compared as text), so a timezone offset would still order correctly.
- IDs are compared as plain text. That's fine for `GD-1xx`, but `GD-99` would sort after `GD-100`. I'm noting it rather than solving it.
- An unknown urgency value is ranked after `low` instead of crashing.
- The existing inbox keeps its "oldest first" order. The recommendation lives in its own panel and doesn't re-sort the list.
- In-memory storage stays as it is. Restarting the server resets the data.

## Left for later
- Assigning or claiming requests for multiple operators, and SLA timers or "waiting for X min" ages (the seed timestamps are fixed in the past, so ages would be misleading).
- Keyboard shortcuts, notifications, auto-refresh / polling.
- API polish: `405 Method Not Allowed` + `Allow` header for wrong methods (the starter returns 404 for all of these; I'm keeping that consistent), and a machine-readable `basis` field alongside the human `reason`.
- Configurable prioritisation rules or AI triage (out of scope per the brief).
- Browser-level automated tests. I'll check the UI by hand in a browser and report what I actually saw.
