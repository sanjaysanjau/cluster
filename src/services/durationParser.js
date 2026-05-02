// Parses a duration string like "1m", "30s", "1m30s" into milliseconds
function parseDuration(str) {
  const minutes = str.match(/(\d+)m/);
  const seconds = str.match(/(\d+)s/);

  const ms =
    (minutes ? parseInt(minutes[1]) * 60 * 1000 : 0) +
    (seconds ? parseInt(seconds[1]) * 1000 : 0);

  if (ms === 0) throw new Error(`Invalid duration "${str}". Use formats like "1m", "30s", "1m30s"`);
  return ms;
}

module.exports = { parseDuration };
