# Queue Service — Implementation Plan

## Problem
When calling an external API that takes time to respond (based on input parameters), we need:
1. A way to accept the job without blocking the HTTP response
2. A queue that processes jobs in order
3. A way for the client to get the result back once the external API responds

---

## All Approaches — Comparison Table

| | Plan A | Plan B | Plan C | Plan D |
|---|---|---|---|---|
| **Pattern** | Synchronous wait | In-memory queue + poll | DB-backed queue + poll | In-memory queue + SSE push |
| **Client experience** | Waits in same request | Gets jobId, polls repeatedly | Gets jobId, polls repeatedly | Gets jobId, server pushes result |
| **External API slow?** | HTTP timeout risk | Safe — job lives in queue | Safe — job lives in DB | Safe — job lives in queue |
| **Network overhead** | 1 request | N poll requests | N poll requests | 1 request + 1 SSE stream |
| **Survives server restart** | — | No (in-memory lost) | Yes (stored in DB) | No (in-memory lost) |
| **Works across cluster workers** | — | No (each worker has own Map) | Yes (shared DB file) | No (same Map problem) |
| **Extra dependencies** | None | None | `better-sqlite3` | None |
| **Complexity** | Simplest | Low | Medium | Low |
| **Best for** | Simple, fast APIs | Dev / single-process | Low-scale, needs persistence | Low-to-medium scale, best UX |

---

## Plan A — Synchronous Wait (Simple, risky for slow APIs)

Client calls the API and the HTTP connection stays open until the external API responds.

```
POST /queue/task  { params }
        │  calls external API directly (blocking)
        │  waits...
        ▼
res.json(result)   ← sent only after external API responds
```

**Problems:**
- If external API takes 30s+, the HTTP client may timeout
- Cluster worker is not blocked but the connection lingers
- No queue — all requests run concurrently with no ordering

---

## Plan B — In-memory Queue + Short Polling (No dependencies, dev-friendly)

```
POST /queue/task  { params }
        │
        ▼
queueController.addTask()
        │  creates a Job { id, status: 'pending', params }
        │  adds to in-memory Map + pending[]
        │  returns { jobId } immediately
        ▼
[Queue processes in background]
        │
        ▼
queueService.process()
        │  picks next pending job
        │  calls apiService.call(params)  ← fetch to external API
        │  on success → job.status = 'done',  job.result = response
        │  on failure → job.status = 'failed', job.error = message
        ▼
GET /queue/job/:id  ← client polls every 2s until status != 'pending'
        │
        ▼
queueController.getJob()
        │  returns { id, status, result, error, createdAt, completedAt }
```

**Critical limitation with cluster:** Each cluster worker has its own in-memory `Map`. If Worker 1 creates the job and the OS routes the poll request to Worker 2, Worker 2 has no record of that job — returns 404. Plan B only works reliably in a single-process setup.

---

## Plan C — SQLite-backed Queue + Short Polling

> **Is this good for low-scale?** It works, but the polling pattern is the weak point — not the DB. If the external API takes 10s and the client polls every 2s, that's 5 wasted requests just to check status. The DB cost is minor; the chatty polling is the real overhead. For low-scale it's acceptable but not elegant.

**What Plan C adds over Plan B:**
- Jobs stored in a SQLite file — survives server restarts
- All cluster workers read/write the same DB file → shared state solved
- Still uses the same polling pattern for the client

```
POST /queue/task  { params }
        │
        ▼
queueController.addTask()
        │  INSERT job row into SQLite (status = 'pending')
        │  returns { jobId } immediately
        ▼
[Queue processes in background]
        │
        ▼
queueService.process()
        │  SELECT oldest pending job
        │  UPDATE status = 'processing'
        │  calls apiService.call(job.params)
        │  on success → UPDATE status = 'done', result = JSON
        │  on failure → UPDATE status = 'failed', error = message
        ▼
GET /queue/job/:id  ← client polls every 2s
        │  SELECT * FROM jobs WHERE id = ?
        ▼
res.json(job row)
```

**New file: `src/services/dbService.js`** — wraps SQLite

```js
// Uses better-sqlite3 (synchronous, perfect for worker threads)
// npm install better-sqlite3

const Database = require('better-sqlite3');
const db = new Database('queue.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id          TEXT PRIMARY KEY,
    status      TEXT DEFAULT 'pending',
    params      TEXT,    -- JSON string
    result      TEXT,    -- JSON string
    error       TEXT,
    created_at  TEXT,
    completed_at TEXT
  )
`);
```

**`queueService.js` changes for Plan C:**

```js
// Instead of in-memory Map:
enqueue(params)  → db.INSERT, return id
getJob(id)       → db.SELECT WHERE id
getStatus()      → db.SELECT COUNT grouped by status
process()        → db.SELECT pending, UPDATE, call API, UPDATE result
```

**Polling problem — client side:**
```
Client polls GET /queue/job/:id every 2 seconds
  → Request 1 (t=0s):  status: 'pending'   — wasted request
  → Request 2 (t=2s):  status: 'pending'   — wasted request
  → Request 3 (t=4s):  status: 'processing' — wasted request
  → Request 4 (t=6s):  status: 'done' ✅   — 3 wasted requests for a 6s job
```

For a 60s external API call, that's **30 wasted requests**. This is why Plan C is not ideal even at low scale.

**New dependency:** `better-sqlite3`

---

## Plan D — In-memory Queue + Server-Sent Events ✅ Recommended

**Core idea:** Instead of the client polling repeatedly, the server pushes one event to the client the moment the job completes. The client opens a single SSE stream and waits. Zero polling.

**SSE (Server-Sent Events):**
- Standard HTTP protocol — just `Content-Type: text/event-stream`
- Server writes `data: {...}\n\n` when ready
- Client uses `EventSource` API in browser, or `curl -N` in terminal
- No WebSocket library needed — works over regular HTTP
- One-directional: server → client (exactly what we need)

```
POST /queue/task  { params }
        │  creates job in memory, returns { jobId } immediately
        ▼

GET /queue/job/:id/events    ← client opens ONE SSE connection and waits
        │  sets headers: Content-Type: text/event-stream
        │  server holds connection open
        │
        ▼
[Queue processes job in background]
        │
        ▼
queueService.process()
        │  job completes → emits 'job:done' event (EventEmitter)
        │
        ▼
SSE handler receives 'job:done' event
        │  writes: data: { "status": "done", "result": {...} }\n\n
        │  closes the SSE stream
        ▼
Client receives the push — done. No polling. No wasted requests.
```

**What changes in Plan D:**

`queueService.js` becomes an **EventEmitter**:
```js
const EventEmitter = require('node:events');
class QueueService extends EventEmitter { ... }

// When job completes:
this.emit(`job:${jobId}`, job);
```

New route:
```js
router.get('/queue/job/:id/events', queueController.streamJob);
```

New controller handler:
```js
exports.streamJob = (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');

  const jobId = req.params.id;
  const job = queueService.getJob(jobId);

  if (!job) return res.status(404).end();

  // If already done, push immediately
  if (job.status === 'done' || job.status === 'failed') {
    res.write(`data: ${JSON.stringify(job)}\n\n`);
    return res.end();
  }

  // Otherwise wait for the event
  const onDone = (completedJob) => {
    res.write(`data: ${JSON.stringify(completedJob)}\n\n`);
    res.end();
  };

  queueService.once(`job:${jobId}`, onDone);

  // Clean up if client disconnects early
  req.on('close', () => queueService.off(`job:${jobId}`, onDone));
};
```

**Client-side usage:**
```js
// Browser
const source = new EventSource('/queue/job/abc123/events');
source.onmessage = (e) => {
  const job = JSON.parse(e.data);
  console.log(job.result);   // arrives exactly when ready
  source.close();
};

// Terminal
curl -N http://localhost:4000/queue/job/abc123/events
```

**Comparison vs Plan C:**

| | Plan C (DB + poll) | Plan D (SSE) |
|---|---|---|
| Requests per job | N poll requests | 1 POST + 1 SSE stream |
| Client waits how? | Polls every 2s | Held open, pushed instantly |
| Extra dep | `better-sqlite3` | None |
| Survives restart | Yes | No (unless combined with DB) |
| Cluster worker issue | Solved (shared DB) | Still present (same EventEmitter problem) |
| Real-time feel | No | Yes |

**Plan D cluster caveat:** The EventEmitter is per-process. To fully solve the cluster problem with Plan D, combine it with Plan C: store jobs in SQLite + emit SSE. That gives you persistence AND real-time push. This is the production pattern.

---

## Recommendation

| Scale | Recommendation | Reason |
|---|---|---|
| Single process / dev | **Plan B** | Zero deps, simple, works fine |
| Low-scale, needs persistence | **Plan C** | DB solves cluster + restart issues; polling overhead is tolerable |
| Low-to-medium scale, best UX | **Plan D** | Zero wasted requests, instant result delivery |
| Low-scale, clustered + real-time | **Plan C + D combined** | SQLite for shared state, SSE for push delivery |
| High scale | Redis + BullMQ + WebSockets | Beyond this project's scope |

---

## New Files (Plan B)

### 1. `src/services/queueService.js`
The heart of the feature. Manages the job store and queue processing.

**Internals:**
```js
const jobStore = new Map()    // id → Job object
const pending  = []           // ordered list of pending job IDs
let isProcessing = false      // prevents concurrent processing
```

**Job object shape:**
```js
{
  id:          string,    // crypto.randomUUID()
  status:      'pending' | 'processing' | 'done' | 'failed',
  params:      object,    // input passed to external API
  result:      any,       // response data from external API
  error:       string,    // error message if failed
  createdAt:   Date,
  completedAt: Date | null
}
```

**Exported functions:**
```js
enqueue(params)     → jobId        // creates job, adds to pending[], triggers process()
getJob(id)          → Job | null   // lookup by id
getStatus()         → { pending, processing, done, failed, total }
```

**`process()` logic (internal):**
```
if (isProcessing || pending.length === 0) return

isProcessing = true
pick first id from pending[]
set job.status = 'processing'
call apiService.call(job.params)
  on success → job.status = 'done', job.result = response, job.completedAt = now
  on error   → job.status = 'failed', job.error = err.message, job.completedAt = now
isProcessing = false
call process() again  ← picks up next job in queue
```

---

### 2. `src/services/apiService.js`
A thin wrapper around `fetch` (built-in since Node 18 — no extra dep).

```js
exports.call = async (params) => {
  // params = { url, method, body, headers }
  const response = await fetch(params.url, {
    method:  params.method  || 'GET',
    headers: params.headers || { 'Content-Type': 'application/json' },
    body:    params.body ? JSON.stringify(params.body) : undefined,
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);

  return await response.json();
};
```

The user swaps in their real external API URL via the request body.

---

### 3. `src/controllers/queueController.js`

```js
// POST /queue/task
// Body: { "url": "https://...", "method": "GET", "body": {} }
addTask(req, res)
  → validate req.body.url exists (400 if missing)
  → jobId = queueService.enqueue(req.body)
  → res.json({ jobId, status: 'pending' })

// GET /queue/job/:id
getJob(req, res)
  → job = queueService.getJob(req.params.id)
  → if not found → 404
  → res.json(job)

// GET /queue/status
getStatus(req, res)
  → res.json(queueService.getStatus())
```

---

## Updated File

### `src/routes/index.js`
Add three new routes:
```js
const queueController = require('../controllers/queueController');

router.post('/queue/task',       queueController.addTask);
router.get('/queue/job/:id',     queueController.getJob);
router.get('/queue/status',      queueController.getStatus);
```

---

## Final File Structure

```
src/
├── controllers/
│   ├── taskController.js       (existing)
│   └── queueController.js      ← NEW
├── services/
│   ├── clusterService.js       (existing)
│   ├── workerService.js        (existing)
│   ├── durationParser.js       (existing)
│   ├── queueService.js         ← NEW
│   └── apiService.js           ← NEW
└── routes/
    └── index.js                (updated — add 3 queue routes)
```

No new dependencies — uses `crypto.randomUUID()` and `fetch`, both built into Node 18+.

---

## API Usage

### Step 1 — Add a job to the queue
```
POST /queue/task
{
  "url": "https://jsonplaceholder.typicode.com/posts/1",
  "method": "GET"
}

Response:
{ "jobId": "a1b2c3d4-...", "status": "pending" }
```

### Step 2 — Poll until done
```
GET /queue/job/a1b2c3d4-...

Response (pending):
{ "id": "a1b2c3d4-...", "status": "pending", "result": null }

Response (done):
{ "id": "a1b2c3d4-...", "status": "done", "result": { ...api response... }, "completedAt": "..." }

Response (failed):
{ "id": "a1b2c3d4-...", "status": "failed", "error": "HTTP 404: Not Found" }
```

### Step 3 — Check overall queue health
```
GET /queue/status

{ "pending": 2, "processing": 1, "done": 10, "failed": 1, "total": 14 }
```

---

## Verification Steps

1. `npm start`
2. Add 3 jobs quickly:
   ```bash
   curl -X POST http://localhost:4000/queue/task \
     -H "Content-Type: application/json" \
     -d '{"url":"https://jsonplaceholder.typicode.com/posts/1"}'
   ```
3. Poll `GET /queue/job/:id` — watch status change from `pending` → `processing` → `done`
4. Check `GET /queue/status` — see counts update as queue drains
5. Pass an invalid URL — job should end with `status: 'failed'`
