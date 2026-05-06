const queueService = require('../services/queueService');

// POST /queue/task
// Body: { any params you want passed to apiService.call() }
exports.addTask = (req, res) => {
  if (!req.body || Object.keys(req.body).length === 0) {
    return res.status(400).json({ error: 'Request body must not be empty' });
  }
  const jobId = queueService.enqueue(req.body);
  res.json({ jobId, status: 'pending' });
};

// GET /queue/job/:id
exports.getJob = (req, res) => {
  const job = queueService.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
};

// GET /queue/job/:id/events  — SSE stream
// Server holds this connection open and pushes one event when the job completes
exports.streamJob = (req, res) => {
  const job = queueService.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');

  // Job already finished before the client opened the stream
  if (job.status === 'done' || job.status === 'failed') {
    res.write(`data: ${JSON.stringify(job)}\n\n`);
    return res.end();
  }

  const onDone = (completedJob) => {
    res.write(`data: ${JSON.stringify(completedJob)}\n\n`);
    res.end();
  };

  queueService.onJobDone(req.params.id, onDone);

  // Clean up listener if client disconnects before job finishes
  req.on('close', () => queueService.offJobDone(req.params.id, onDone));
};

// GET /queue/status
exports.getStatus = (req, res) => {
  res.json(queueService.getStatus());
};
