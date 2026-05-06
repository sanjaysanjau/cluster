// TODO: Replace this with your real external API call logic.
// This placeholder simulates a slow API that takes 5 seconds to respond.
exports.call = (params) => {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({
        message:   'Simulated API response',
        echoParams: params,
        timestamp:  new Date(),
      });
    }, 5000);
  });
};
