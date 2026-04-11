const cluster = require('node:cluster');
const os = require('node:os');

const PORT = 4000;

if (cluster.isPrimary) {
  // Master process: fork one worker per CPU core
  const cpuCount = os.cpus().length;
  console.log(`Master PID ${process.pid} — forking ${cpuCount} workers`);

  for (let i = 0; i < cpuCount; i++) {
    cluster.fork();
  }

  // Auto-restart a worker if it crashes
  cluster.on('exit', (worker) => {
    console.log(`Worker ${worker.process.pid} died. Restarting...`);
    cluster.fork();
  });

} else {
  // Worker process: each worker runs its own Express server
  const app = require('./app');
  app.listen(PORT, () => {
    console.log(`Worker PID ${process.pid} listening on port ${PORT}`);
  });
}
