const express = require('express');
const routes = require('./routes/index');

const app = express();
app.use(express.json());
app.use('/', routes);

module.exports = app;

// When run directly (node src/app.js), start listening on its own
if (require.main === module) {
  const PORT = process.env.PORT || 4000;
  app.listen(PORT, () => console.log(`Single-process server running on port ${PORT}`));
}
