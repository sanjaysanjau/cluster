# Node.js Cluster + Worker Threads — Express Demo

A simple Express app demonstrating two Node.js concurrency primitives:

- **`cluster`** — forks one process per CPU core, all sharing port 4000
- **`worker_threads`** — offloads CPU-heavy tasks to a separate V8 thread

## Project Structure 

```
├── src/
│   ├── cluster.js              # Entry point — master forks workers
│   ├── app.js                  # Express app setup
│   ├── routes/
│   │   └── index.js            # Route definitions
│   ├── controllers/
│   │   └── taskController.js   # Request handlers
│   └── services/
│       ├── clusterService.js   # Cluster/process info
│       └── workerService.js    # Launches worker threads
└── workers/
    └── heavyTask.js            # Runs in an isolated thread
```

## Setup

```bash
npm install
npm start
```

For development with auto-reload:

```bash
npm run dev
```

## API Endpoints

### `GET /`
Health check. Returns the PID of the cluster worker that handled the request.

```json
{ "status": "ok", "pid": 12345 }
```

### `GET /cluster/info`
Returns cluster and system information.

```json
{
  "pid": 12345,
  "workerId": 2,
  "totalWorkers": 8,
  "platform": "linux",
  "nodeVersion": "v20.0.0"
}
```

### `POST /worker/task`
Runs a CPU-heavy task in a worker thread without blocking the event loop.

**Request body:**
```json
{ "type": "fibonacci", "input": 40 }
```
or
```json
{ "type": "prime", "input": 10000 }
```

**Response:**
```json
{ "type": "fibonacci", "input": 40, "result": 102334155, "servedByPid": 12345 }
```

**Supported task types:**
| type | input | description |
|------|-------|-------------|
| `fibonacci` | number n | Computes fibonacci(n) |
| `prime` | number n | Finds largest prime below n |

## How It Works

```
npm start
  └── cluster.js (master process)
        ├── Worker 1 → Express on port 4000
        ├── Worker 2 → Express on port 4000
        └── Worker N → (one per CPU core)

POST /worker/task
  └── workerService.runTask()
        └── new Worker(heavyTask.js)   ← isolated V8 thread
              └── computes result → postMessage back → Promise resolves
```

Each HTTP request shows a different `servedByPid` — that's the cluster distributing load across worker processes. The heavy computation runs in a thread, keeping Express responsive to other requests while it runs.
