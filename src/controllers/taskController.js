const clusterService = require('../services/clusterService');
const workerService = require('../services/workerService');

// GET /
exports.healthCheck = (req, res) => {
  res.json({ status: 'ok', pid: process.pid });
};

// GET /cluster/info
exports.clusterInfo = (req, res) => {
  res.json(clusterService.getInfo());
};

// POST /worker/task
// Body: { "type": "fibonacci", "input": 40 }  OR  { "type": "prime", "input": 10000 }
exports.runWorkerTask = async (req, res) => {
  const { type = 'fibonacci', input = 10 } = req.body;
  try {
    const result = await workerService.runTask({ type, input });
    res.json({ ...result, servedByPid: process.pid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
