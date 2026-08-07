const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { Server } = require('socket.io');
const { BackendPrintClientService } = require('../dist/backend/backend-print-client.service.js');
const { sanitizeAppConfig } = require('../dist/config/config.schema.js');

test('preserves a custom backend base URL in the local config schema', () => {
  const parsedConfig = sanitizeAppConfig({
    backendBaseUrl: 'http://127.0.0.1:4310/',
  });

  assert.equal(parsedConfig.backendBaseUrl, 'http://127.0.0.1:4310');
});

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
    headers: { get: () => 'application/json' },
    text: async () =>
      JSON.stringify({
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

test('treats an empty successful polling response as no pending print job', async () => {
  const restoreFetch = global.fetch;
  const warnings = [];

  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => '',
  });

  try {
    const service = createService({ savedConfigs: [], notifications: [], warnings });
    const result = await service.request(
      'https://example.com/',
      '/print-jobs/next-pending',
      { method: 'GET', responseBody: 'optional' },
      'device-token',
    );

    assert.equal(result, null);
    assert.deepEqual(warnings, []);
  } finally {
    global.fetch = restoreFetch;
  }
});

test('keeps required backend responses strict when the body is empty', async () => {
  const restoreFetch = global.fetch;

  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => '   ',
  });

  try {
    const service = createService({ savedConfigs: [], notifications: [], warnings: [] });

    await assert.rejects(
      service.request(
        'https://example.com/',
        '/print-agents/register',
        { method: 'POST' },
        null,
      ),
      /respondio 200 sin contenido JSON en \/print-agents\/register/,
    );
  } finally {
    global.fetch = restoreFetch;
  }
});

test('does not fail an acknowledged operation when its optional response contains invalid JSON', async () => {
  const restoreFetch = global.fetch;
  const warnings = [];

  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    text: async () => '{"status":"PRINTED"',
  });

  try {
    const service = createService({ savedConfigs: [], notifications: [], warnings });
    const result = await service.request(
      'https://example.com/',
      '/print-jobs/job-1/printed',
      { method: 'POST', responseBody: 'optional' },
      'device-token',
    );

    assert.equal(result, null);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].path, '/print-jobs/job-1/printed');
    assert.equal(warnings[0].statusCode, 200);
    assert.equal(warnings[0].contentType, 'application/json');
    assert.equal(warnings[0].responseBytes, 19);
  } finally {
    global.fetch = restoreFetch;
  }
});

test('does not resend a physical print when printing acknowledgements have empty bodies', async () => {
  const restoreFetch = global.fetch;
  const requestedPaths = [];
  let physicalPrints = 0;

  global.fetch = async (url) => {
    requestedPaths.push(new URL(url).pathname);
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => '',
    };
  };

  try {
    const service = createService({ savedConfigs: [], notifications: [], warnings: [] });
    service.dependencies.printerService.printRaw = async () => {
      physicalPrints += 1;
    };

    const printed = await service.printClaimedJob(
      {
        id: 'job-empty-ack',
        type: 'RECEIPT',
        status: 'CLAIMED',
        printer: {
          id: 'printer-1',
          name: 'POS-80C',
          systemName: 'POS-80C',
          paperWidth: 80,
          copies: 1,
        },
        payload: {
          business: { name: 'Patio bolivar', nit: '4151730' },
          order: { id: '717', createdAt: '2026-08-07T01:48:04.153Z' },
          items: [{ name: 'Producto', quantity: 1, unitPrice: 1000, total: 1000 }],
          totals: { subtotal: 1000, tax: 0, discount: 0, total: 1000 },
          options: { copies: 1, paperWidth: '80mm' },
        },
      },
      'device-token',
    );

    assert.equal(printed, true);
    assert.equal(physicalPrints, 1);
    assert.deepEqual(requestedPaths, [
      '/print-jobs/job-empty-ack/printing',
      '/print-jobs/job-empty-ack/printed',
    ]);
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

test('uses the configured backend base URL for registration, revocation handling, and socket reconnection', async () => {
  const notifications = [];
  const savedConfigs = [];
  const warnings = [];
  const backend = await createBackendHarness();

  try {
    const service = createService({
      savedConfigs,
      notifications,
      warnings,
      configOverrides: {
        backendBaseUrl: backend.baseUrl,
        backendDeviceToken: 'token-1',
      },
    });

    service.syncPrinters = async () => {};
    service.processNextPending = async () => {};

    const firstConnection = backend.waitForConnectionCount(1);
    service.start();
    await firstConnection;

    assert.equal(backend.handshakeTokens[0], 'token-1');
    assert.equal(service.dependencies.configService.getConfig().backendBaseUrl, backend.baseUrl);

    backend.revokeToken('token-1');
    backend.disconnectAllSockets();
    await service.sendHeartbeat();

    assert.equal(service.dependencies.configService.getConfig().backendDeviceToken, null);
    assert.deepEqual(notifications, [
      {
        title: 'Gestion al Dia Print Agent',
        content: 'Sesion expirada. Realiza el pairing nuevamente.',
      },
    ]);
    assert.equal(warnings.some((entry) => entry.statusCode === 403), true);

    backend.allowToken('token-2');
    backend.setRegistrationToken('token-2');

    const secondConnection = backend.waitForConnectionCount(2);
    const registration = await service.register('123456');
    await secondConnection;

    assert.deepEqual(registration, {
      agentId: 'agent-2',
      businessId: 'business-2',
      deviceToken: 'token-2',
    });
    assert.equal(backend.registrationRequests, 1);
    assert.deepEqual(backend.handshakeTokens, ['token-1', 'token-2']);
    assert.equal(service.dependencies.configService.getConfig().backendDeviceToken, 'token-2');
    assert.equal(service.dependencies.configService.getConfig().backendBaseUrl, backend.baseUrl);
    assert.deepEqual(savedConfigs, [
      { backendDeviceToken: null },
      {
        backendAgentId: 'agent-2',
        backendBusinessId: 'business-2',
        backendDeviceToken: 'token-2',
      },
    ]);

    service.stop();
  } finally {
    await backend.close();
  }
});

function createService({ savedConfigs, notifications, warnings, configOverrides = {} }) {
  const config = {
    backendBaseUrl: null,
    backendDeviceToken: 'device-token',
    ...configOverrides,
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

async function createBackendHarness() {
  let currentRegistrationToken = 'token-2';
  const validTokens = new Set(['token-1']);
  const sockets = [];
  const handshakeTokens = [];
  let registrationRequests = 0;
  let connectionCount = 0;
  let resolveConnectionWaiter = null;
  let targetConnectionCount = 0;

  const server = http.createServer(async (request, response) => {
    const body = await readRequestBody(request);

    if (request.method === 'POST' && request.url === '/print-agents/register') {
      registrationRequests += 1;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          agentId: 'agent-2',
          businessId: 'business-2',
          deviceToken: currentRegistrationToken,
        }),
      );
      return;
    }

    if (request.method === 'POST' && request.url === '/print-agents/heartbeat') {
      const token = extractBearerToken(request.headers.authorization);

      if (!token || !validTokens.has(token)) {
        response.writeHead(403, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ message: 'forbidden' }));
        return;
      }

      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ accepted: true, body }));
      return;
    }

    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ message: 'not-found' }));
  });

  const io = new Server(server, {
    cors: {
      origin: true,
      credentials: false,
    },
  });
  const namespace = io.of('/print-agents');

  namespace.use((socket, next) => {
    const token = typeof socket.handshake.auth?.token === 'string'
      ? socket.handshake.auth.token
      : extractBearerToken(socket.handshake.headers.authorization);

    handshakeTokens.push(token || null);

    if (!token || !validTokens.has(token)) {
      next(new Error('forbidden'));
      return;
    }

    next();
  });

  namespace.on('connection', (socket) => {
    sockets.push(socket);
    connectionCount += 1;
    socket.emit('print-agent.connected', { ok: true });

    if (resolveConnectionWaiter && connectionCount >= targetConnectionCount) {
      const resolve = resolveConnectionWaiter;
      resolveConnectionWaiter = null;
      resolve();
    }

    socket.on('disconnect', () => {
      const index = sockets.indexOf(socket);
      if (index >= 0) {
        sockets.splice(index, 1);
      }
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();

  if (!address || typeof address === 'string') {
    throw new Error('Unable to resolve test backend address');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    handshakeTokens,
    get registrationRequests() {
      return registrationRequests;
    },
    allowToken(token) {
      validTokens.add(token);
    },
    revokeToken(token) {
      validTokens.delete(token);
    },
    setRegistrationToken(token) {
      currentRegistrationToken = token;
    },
    disconnectAllSockets() {
      sockets.slice().forEach((socket) => socket.disconnect(true));
    },
    waitForConnectionCount(expectedCount) {
      if (connectionCount >= expectedCount) {
        return Promise.resolve();
      }

      targetConnectionCount = expectedCount;
      return new Promise((resolve) => {
        resolveConnectionWaiter = resolve;
      });
    },
    async close() {
      await new Promise((resolve) => io.close(resolve));

      if (!server.listening) {
        return;
      }

      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

function extractBearerToken(authorizationHeader) {
  if (typeof authorizationHeader !== 'string') {
    return null;
  }

  if (!authorizationHeader.toLowerCase().startsWith('bearer ')) {
    return null;
  }

  const token = authorizationHeader.slice(7).trim();
  return token || null;
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    request.on('data', (chunk) => {
      chunks.push(Buffer.from(chunk));
    });
    request.on('end', () => {
      if (chunks.length === 0) {
        resolve(null);
        return;
      }

      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}
