const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const apiService = require('./apiService');

const jobStore = new Map();
const pending  = [];
const emitter  = new EventEmitter();
let isProcessing = false;

async function process() {
  if (isProcessing || pending.length === 0) return;

  isProcessing = true;
  const id  = pending.shift();
  const job = jobStore.get(id);

  job.status = 'processing';

  try {
    job.result      = await apiService.call(job.params);
    job.status      = 'done';
  } catch (err) {
    job.error       = err.message;
    job.status      = 'failed';
  }

  job.completedAt = new Date();
  emitter.emit(`job:${id}`, job);

  isProcessing = false;
  process();
}

exports.enqueue = (params) => {
  const id  = randomUUID();
  const job = {
    id,
    status:      'pending',
    params,
    result:      null,
    error:       null,
    createdAt:   new Date(),
    completedAt: null,
  };
  jobStore.set(id, job);
  pending.push(id);
  process();
  return id;
};

exports.getJob = (id) => jobStore.get(id) ?? null;

exports.getStatus = () => {
  const counts = { pending: 0, processing: 0, done: 0, failed: 0 };
  for (const job of jobStore.values()) counts[job.status]++;
  return { ...counts, total: jobStore.size };
};

exports.onJobDone  = (id, listener) => emitter.once(`job:${id}`, listener);
exports.offJobDone = (id, listener) => emitter.off(`job:${id}`, listener);
