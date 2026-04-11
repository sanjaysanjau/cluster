const cluster = require('node:cluster');
const os = require('node:os');

// Returns useful info about the current cluster worker process
exports.getInfo = () => ({
  pid: process.pid,
  workerId: cluster.worker ? cluster.worker.id : 'primary',
  totalWorkers: os.cpus().length,
  platform: process.platform,
  nodeVersion: process.version,
});
