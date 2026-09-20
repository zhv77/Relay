'use strict';
const { parentPort } = require('node:worker_threads');
const inventory = require('./inventory');
const { findPid } = require('./memory');

parentPort.on('message', (request) => {
  try {
    let result;
    if (request.op === 'pid') result = { pid: findPid() };
    else if (request.op === 'plan') result = inventory.plan();
    else result = inventory.readTasks(request.pid, request.tasks);
    parentPort.postMessage({ id: request.id, result });
  } catch (error) {
    parentPort.postMessage({ id: request.id, error: error.message });
  }
});
