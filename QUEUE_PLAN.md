# Queue Service — Implementation Plan

## Problem

When calling an external API that takes time to respond (based on input parameters), we need:
1. A way to accept the job without blocking the HTTP response
2. A queue that processes jobs in order
3. A way for the client to get the result back once the external API responds

---

## All Approaches — Comparison Table

| | Plan A | Plan B | Plan C | Plan D | Plan E |
|---|---|---|---|---|---|
| **Pattern** | Synchronous wait | In-memory + poll | SQLite DB + poll | In-memory + SSE push | External queue service |
| **Client gets result** | Waits in same request | Polls repeatedly | Polls repeatedly | Server pushes instantly | Polls or webhook |
| **External API slow?** | HTTP timeout risk | Safe | Safe | Safe | Safe |
| **Network overhead** | 1 request | N poll requests | N poll requests | 1 request + 1 stream | N poll or 1 webhook |
| **Survives server restart** | No | No | Yes | No | Yes |
| **Works across cluster workers** | No | No (own Map per worker) | Yes (shared DB file) | No (own EventEmitter) | Yes (queue is external) |
| **Extra dependencies** | None | None | `better-sqlite3` | None | Azure SDK / amqplib |
| **Infrastructure needed** | None | None | None | None | Azure / RabbitMQ server |
| **Complexity** | Simplest | Low | Medium | Low | High |
| **Best for** | Fast APIs only | Dev / single process | Low-scale persistence | Low–medium, best UX | Medium–large scale |

---

## Plan A — Synchronous Wait

**Pattern:** Client makes a request, the server calls the external API immediately, and the HTTP connection stays open until the external API responds. Only then is the response sent back.

**How it works:**
- No queue involved — each request runs directly
- The HTTP connection is held open while waiting

**Problems:**
- If the external API takes more than 30 seconds, the HTTP client will timeout before getting the response
- No ordering — all requests run concurrently with no control
- Not scalable — every slow call ties up a live connection

**Verdict:** Only suitable when the external API is guaranteed to be fast (under 5 seconds).

---

## Plan B — In-memory Queue + Short Polling

**Pattern:** Each request is added to an in-memory queue. The client gets a `jobId` immediately and polls a separate endpoint every few seconds until the status changes to `done`.

**How it works:**
- A `Map` stores all jobs keyed by ID
- A `pending[]` array holds the ordered list of job IDs to process
- A `process()` function picks one job at a time, calls the external API, and updates the job status
- Client polls `GET /queue/job/:id` every 2 seconds until `status !== 'pending'`

**Endpoints needed:**
- `POST /queue/task` — add a job, returns `{ jobId }`
- `GET /queue/job/:id` — returns current job status and result
- `GET /queue/status` — returns queue health counts

**Files needed:**
- `src/services/queueService.js` — manages the Map, pending array, and process loop
- `src/services/apiService.js` — thin fetch wrapper for calling the external API
- `src/controllers/queueController.js` — HTTP handlers
- Update `src/routes/index.js`

**No new npm dependencies** — uses built-in `crypto.randomUUID()` and `fetch`.

**Critical limitation with cluster:**
Each cluster worker has its own in-memory `Map`. If Worker 1 creates the job and the OS routes the poll request to Worker 2, Worker 2 returns 404 because it has no record of that job. Plan B only works reliably in a **single-process** setup.

**Is this good for low-scale?** Yes for single-process. Breaks silently in a clustered setup.

---

## Plan C — SQLite-backed Queue + Short Polling

**Pattern:** Same polling approach as Plan B, but job details are stored in a SQLite database file on disk instead of in-memory. All cluster workers share the same file.

**What Plan C adds over Plan B:**
- Jobs survive a server restart (persisted to disk)
- All cluster workers read and write to the same SQLite file — shared state is solved
- The polling pattern for the client remains the same

**How it works:**
- A `jobs` table in SQLite stores each job row (id, status, params, result, error, timestamps)
- On `POST /queue/task` — insert a row with `status = pending`
- The queue service selects the oldest pending job, updates it to `processing`, calls the external API, then updates to `done` or `failed`
- Client polls the same endpoints as Plan B

**Files needed:**
- `src/services/dbService.js` — SQLite setup and query helpers (uses `better-sqlite3`)
- `src/services/queueService.js` — uses dbService instead of in-memory Map
- `src/services/apiService.js` — same as Plan B
- `src/controllers/queueController.js` — same as Plan B
- Update `src/routes/index.js`

**New dependency:** `better-sqlite3` (synchronous SQLite driver, works well with Node.js)

**Is Plan C good for low-scale?**
The database part is fine — SQLite has negligible overhead. The real problem is the **polling pattern**, not the DB. If the external API takes 10 seconds and the client polls every 2 seconds, that is 5 wasted requests just to confirm the status. For a 60-second job that becomes 30 wasted requests. At low scale this is acceptable but it is chatty and not real-time. The advantage over Plan B is that it works correctly in a clustered setup and survives restarts.

---

## Plan D — In-memory Queue + Server-Sent Events (SSE)

**Pattern:** The client opens a single long-lived HTTP connection after submitting a job. The server pushes one event to that connection the moment the job completes. No repeated polling.

**What SSE is:**
- A standard HTTP feature using `Content-Type: text/event-stream`
- The server holds the connection open and writes events to it as they happen
- The browser has a built-in `EventSource` API for this — no library needed
- One-directional: server pushes to client (exactly what we need here)
- Simpler than WebSockets — works over plain HTTP

**How it works:**
- Client posts a job → gets `jobId` immediately
- Client opens `GET /queue/job/:id/events` — server holds this connection open
- `queueService` extends Node's built-in `EventEmitter`
- When a job completes, `queueService` emits a `job:<id>` event
- The SSE handler catches that event and writes the result to the open connection, then closes it
- If the client disconnects early, the listener is cleaned up

**Endpoints needed:**
- `POST /queue/task` — same as Plan B
- `GET /queue/job/:id/events` — new SSE stream endpoint
- `GET /queue/status` — same as Plan B

**Advantages over Plan C:**
- Zero wasted poll requests — the result arrives the instant the job is done
- No extra npm dependencies
- Client experience is simpler — open a stream, wait, get the result

**Cluster caveat:**
The EventEmitter is per-process, just like the in-memory Map in Plan B. If the SSE connection lands on a different cluster worker than the one processing the job, the event never arrives. To fully solve this, combine Plan D with Plan C: store jobs in SQLite (for shared state across workers) and use SSE for real-time push delivery. This is the recommended pattern for a clustered setup.

**Is this good for low-to-medium scale?** Yes — it is the most efficient approach for a single-process or sticky-session setup. For a clustered setup, combine with Plan C.

---

## Plan E — External Queue Service (Azure Service Bus / RabbitMQ)

**Pattern:** Instead of managing a queue inside the Node.js process, the queue lives in a dedicated external message broker. The Express app publishes jobs to the broker; one or more consumer workers (separate processes or services) pick up jobs, call the external API, and publish results back.

**What this means:**
- The queue is completely outside your Node.js app
- Your Express server only publishes messages — it does not process them
- Consumers can be scaled independently from the HTTP server
- The broker guarantees delivery, ordering, and retries

---

### Option E1 — RabbitMQ

**What it is:** An open-source message broker that runs as a separate server. Messages are sent to exchanges, routed to queues, and consumed by workers.

**How it fits here:**
- Express publishes a job message to a RabbitMQ queue
- A separate consumer process (could be another Node.js file) subscribes to that queue, calls the external API, and publishes the result to a reply queue
- Express subscribes to the reply queue and matches results back to the original request via `correlationId`
- This is called the **RPC over message queue** pattern

**Key characteristics:**
- Self-hosted — you run the RabbitMQ server (Docker image available)
- Supports complex routing (fanout, topic, direct exchanges)
- Acknowledgement-based — a message is not removed until the consumer confirms it was processed
- Built-in retry and dead-letter queue support
- Protocol: AMQP 0-9-1
- Node.js SDK: `amqplib`

**When to use:**
- When you need fine-grained control over routing and message patterns
- When you want to self-host and avoid cloud vendor lock-in
- When multiple different consumers need to receive the same message (pub/sub)

**Infrastructure required:** RabbitMQ server (local Docker or self-managed VM)

---

### Option E2 — Azure Service Bus

**What it is:** A fully managed cloud message broker from Microsoft Azure. No server to manage — you create a namespace and queue via the Azure portal.

**How it fits here:**
- Express sends a job message to an Azure Service Bus queue using the Azure SDK
- A consumer (could be an Azure Function, a separate Node.js process, or a worker role) picks up the message, calls the external API, and sends the result back via a reply queue or directly updates a shared store
- Azure handles delivery guarantees, scaling, and dead-lettering automatically

**Key characteristics:**
- Fully managed — no infrastructure to set up or maintain
- At-least-once delivery with message lock (message is locked while being processed, released if the consumer crashes)
- Built-in dead-letter queue for failed messages
- Supports sessions (ordered processing per key)
- Max message size: 256 KB (standard tier) / 100 MB (premium)
- Node.js SDK: `@azure/service-bus`

**When to use:**
- When you are already on Azure and want managed infrastructure
- When you need guaranteed delivery with no ops overhead
- When you need to scale consumers independently (e.g. Azure Functions triggered by the queue)
- When the team does not want to manage a RabbitMQ server

**Infrastructure required:** Azure subscription, Service Bus namespace (billed per operation)

---

### How the client gets the result in Plan E

Since processing happens outside the Express app, sending the result back to the original HTTP client requires one of these patterns:

| Sub-pattern | How it works | Best for |
|---|---|---|
| **Poll a shared store** | Consumer writes result to DB; client polls REST endpoint | Simplest, works anywhere |
| **Webhook / callback URL** | Client provides a callback URL in the job; consumer POSTs result to it when done | Server-to-server, no polling |
| **Reply queue (RPC)** | Express subscribes to a reply queue; consumer sends result back there | Low latency, same-process result delivery |
| **SignalR / WebSocket push** | Consumer publishes result; SignalR hub pushes to browser client | Real-time browser apps (Azure only) |

For this project, the recommended sub-pattern is **Poll a shared store** (combine with Plan C's SQLite for simplicity) or **Webhook** if the caller is another server.

---

### Plan E vs Plan D — When to switch

| Situation | Stay with Plan D | Move to Plan E |
|---|---|---|
| Number of jobs | Low to medium | High volume |
| Processing location | Same Node.js process | Separate worker / microservice |
| Infrastructure team | None | DevOps or cloud team available |
| Retry / dead-letter needed | Manual | Built-in |
| Multi-consumer fan-out | Not needed | Required |
| Cloud lock-in concern | Not a concern | Prefer self-hosted → use RabbitMQ |

---

## Final Recommendation by Use Case

| Situation | Best Plan | Reason |
|---|---|---|
| Learning / local dev | Plan B | Zero deps, simple to understand |
| Low-scale, single process | Plan D | Best client UX, no polling overhead |
| Low-scale, clustered | Plan C + D | SQLite for shared state, SSE for push |
| Medium-scale, self-hosted | Plan E — RabbitMQ | Dedicated broker, no cloud dependency |
| Medium-to-large, Azure cloud | Plan E — Azure Service Bus | Fully managed, scales automatically |
| High-scale, multi-consumer | Plan E — Azure Service Bus or RabbitMQ | Built-in delivery guarantees and retries |
