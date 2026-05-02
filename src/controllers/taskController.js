const clusterService = require('../services/clusterService');
const workerService = require('../services/workerService');
const { parseDuration } = require('../services/durationParser');

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

// GET /worker/delay/:duration
// Examples: /worker/delay/1m  /worker/delay/30s  /worker/delay/1m30s
exports.delayTask = async (req, res) => {
  let ms;
  try {
    ms = parseDuration(req.params.duration);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  try {
    const result = await workerService.runTask({ type: 'delay', input: ms });
    res.json({ ...result, servedByPid: process.pid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
