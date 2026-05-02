const { workerData, parentPort } = require('node:worker_threads');

// This script runs in a completely separate thread
// It receives input via workerData and sends result back via parentPort

function fibonacci(n) {
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}

function largestPrimeBelowN(n) {
  for (let num = n - 1; num >= 2; num--) {
    let isPrime = true;
    for (let i = 2; i <= Math.sqrt(num); i++) {
      if (num % i === 0) { isPrime = false; break; }
    }
    if (isPrime) return num;
  }
  return null;
}

const { type, input } = workerData;

let result;
if (type === 'fibonacci') {
  result = fibonacci(Number(input));
} else if (type === 'prime') {
  result = largestPrimeBelowN(Number(input));
} else if (type === 'delay') {
  // Atomics.wait() blocks this thread (not the event loop) for `input` ms
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, Number(input));
  result = `Waited ${input}ms`;
} else {
  result = null;
}

// Send result back to the main thread
parentPort.postMessage({ type, input, result });
