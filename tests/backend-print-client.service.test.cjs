const assert = require('node:assert/strict');
const test = require('node:test');
const { BackendPrintClientService } = require('../dist/backend/backend-print-client.service.js');

test('clears the local token, stops background work, and notifies on backend 401', async () => {
  const restoreFetch = global.fetch;
  const savedConfigs = [];
  const notifications = [];
  const warnings = [];
  let stopCalls = 0;

  global.fetch = async () => ({
    ok: false,
    status: 401,
    json: async () => ({}),
  });

  try {
    const service = createService({ savedConfigs, notifications, warnings });
    service.stop = () => {
      stopCalls += 1;
    };

    await assert.rejects(
      service.request('https://example.com/', '/print-agents/heartbeat', { method: 'POST' }, 'device-token'),
      (error) => {
        assert.equal(error.name, 'BackendAgentAuthExpiredError');
        return true;
      },
    );

    assert.equal(stopCalls, 1);
    assert.deepEqual(savedConfigs, [{ backendDeviceToken: null }]);
    assert.deepEqual(notifications, [
      {
        title: 'Gestion al Dia Print Agent',
        content: 'Sesion expirada. Realiza el pairing nuevamente.',
      },
    ]);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].statusCode, 401);
  } finally {
    global.fetch = restoreFetch;
  }
});

test('clears the local token, stops background work, and notifies on backend 403', async () => {
  const restoreFetch = global.fetch;
  const savedConfigs = [];
  const notifications = [];
  const warnings = [];
  let stopCalls = 0;

  global.fetch = async () => ({
    ok: false,
    status: 403,
    json: async () => ({}),
  });

  try {
    const service = createService({ savedConfigs, notifications, warnings });
    service.stop = () => {
      stopCalls += 1;
    };

    await assert.rejects(
      service.request('https://example.com/', '/print-jobs/next-pending', { method: 'GET' }, 'device-token'),
      (error) => {
        assert.equal(error.name, 'BackendAgentAuthExpiredError');
        return true;
      },
    );

    assert.equal(stopCalls, 1);
    assert.deepEqual(savedConfigs, [{ backendDeviceToken: null }]);
    assert.deepEqual(notifications, [
      {
        title: 'Gestion al Dia Print Agent',
        content: 'Sesion expirada. Realiza el pairing nuevamente.',
      },
    ]);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].statusCode, 403);
  } finally {
    global.fetch = restoreFetch;
  }
});

test('restarts background connectivity after a successful re-pairing', async () => {
  const restoreFetch = global.fetch;
  const savedConfigs = [];
  let startCalls = 0;

  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      agentId: 'agent-2',
      businessId: 'business-2',
      deviceToken: 'new-device-token',
    }),
  });

  try {
    const service = createService({ savedConfigs, notifications: [], warnings: [] });
    service.start = () => {
      startCalls += 1;
    };

    const result = await service.register('123456');

    assert.deepEqual(result, {
      agentId: 'agent-2',
      businessId: 'business-2',
      deviceToken: 'new-device-token',
    });
    assert.deepEqual(savedConfigs, [
      {
        backendBaseUrl: null,
        backendAgentId: 'agent-2',
        backendBusinessId: 'business-2',
        backendDeviceToken: 'new-device-token',
      },
    ]);
    assert.equal(startCalls, 1);
  } finally {
    global.fetch = restoreFetch;
  }
});

test('reconnects on startup when a persisted device token still exists after restart', async () => {
  const service = createService({ savedConfigs: [], notifications: [], warnings: [] });
  let stopCalls = 0;
  let connectSocketCalls = 0;
  let heartbeatCalls = 0;
  let syncCalls = 0;
  let processCalls = 0;

  service.stop = () => {
    stopCalls += 1;
  };
  service.connectSocket = () => {
    connectSocketCalls += 1;
  };
  service.sendHeartbeat = async () => {
    heartbeatCalls += 1;
  };
  service.syncPrinters = async () => {
    syncCalls += 1;
  };
  service.processNextPending = async () => {
    processCalls += 1;
  };

  service.start();
  service.stop();

  assert.equal(stopCalls >= 2, true);
  assert.equal(connectSocketCalls, 1);
  assert.equal(heartbeatCalls, 1);
  assert.equal(syncCalls, 1);
  assert.equal(processCalls, 1);
});

function createService({ savedConfigs, notifications, warnings }) {
  const config = {
    backendDeviceToken: 'device-token',
  };

  return new BackendPrintClientService({
    version: '2.0.3',
    configService: {
      getConfig() {
        return { ...config };
      },
      saveConfig(nextConfig) {
        savedConfigs.push(nextConfig);
        Object.assign(config, nextConfig);
        return { ...config };
      },
    },
    logger: {
      info() {},
      warn(message, payload) {
        warnings.push({ message, ...(payload || {}) });
      },
    },
    printerService: {
      listPrinters: async () => [],
      printRaw: async () => undefined,
    },
    queueService: {
      enqueue: async (_label, task) => task(),
    },
    printHistoryService: {
      recordQueued: () => 'history-1',
      markProcessing() {},
      markCompleted() {},
    },
    notify(title, content) {
      notifications.push({ title, content });
    },
  });
}