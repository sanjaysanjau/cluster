const { Worker } = require('node:worker_threads');
const path = require('node:path');

const WORKER_SCRIPT = path.join(__dirname, '../../workers/heavyTask.js');

// Runs a CPU-heavy task in a separate thread so the event loop stays free
exports.runTask = ({ type, input }) => {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SCRIPT, {
      workerData: { type, input },
    });

    worker.on('message', resolve);   // heavyTask.js calls parentPort.postMessage()
    worker.on('error', reject);
    worker.on('exit', (code) => {
      if (code !== 0) reject(new Error(`Worker exited with code ${code}`));
    });
  });
};

