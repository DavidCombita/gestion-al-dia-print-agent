const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { Server } = require('socket.io');
const { BackendPrintClientService } = require('../dist/backend/backend-print-client.service.js');
const { sanitizeAppConfig } = require('../dist/config/config.schema.js');
const { formatInvoice } = require('../dist/printing/formatters/invoice.formatter.js');
const { formatKitchenOrder } = require('../dist/printing/formatters/kitchen-order.formatter.js');

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

test('accepts successful empty backend responses without JSON parse failures', async () => {
  const restoreFetch = global.fetch;

  global.fetch = async () => ({
    ok: true,
    status: 204,
    text: async () => '',
  });

  try {
    const service = createService({ savedConfigs: [], notifications: [], warnings: [] });
    const result = await service.request(
      'https://example.com/',
      '/print-jobs/next-pending',
      { method: 'GET' },
      'device-token',
    );

    assert.equal(result, undefined);
  } finally {
    global.fetch = restoreFetch;
  }
});

test('reports non-json backend responses with a controlled message', async () => {
  const restoreFetch = global.fetch;

  global.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => '<html>not json</html>',
  });

  try {
    const service = createService({ savedConfigs: [], notifications: [], warnings: [] });

    await assert.rejects(
      service.request(
        'https://example.com/',
        '/print-jobs/next-pending',
        { method: 'GET' },
        'device-token',
      ),
      /cuerpo no JSON en \/print-jobs\/next-pending/,
    );
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

test('formats kitchen orders without item prices when showItemPrices is false', () => {
  const buffer = formatKitchenOrder({
    business: {
      name: 'Restaurante Demo',
      nit: '900123456',
    },
    order: {
      id: '42-7',
      tableName: '01',
      waiterName: 'Ana',
      createdAt: '2026-08-08T10:00:00.000Z',
    },
    items: [
      {
        name: 'Hamburguesa clasica',
        quantity: 2,
        unitPrice: 15000,
        total: 30000,
        notes: ['Sin cebolla'],
      },
    ],
    totals: {
      subtotal: 30000,
      tax: 0,
      discount: 0,
      tip: 0,
      total: 30000,
    },
    options: {
      paperWidth: '80mm',
      cutPaper: true,
      openCashDrawer: false,
      showTotals: false,
      showItemPrices: false,
    },
  });
  const text = buffer.toString('latin1');

  assert.equal(text.includes('$'), false);
  assert.equal(text.includes('Hamburguesa clasica'), true);
  assert.equal(text.includes('Sin cebolla'), true);
});

test('formats invoices with tip and payment breakdown', () => {
  const buffer = formatInvoice({
    business: {
      name: 'Restaurante Demo',
      nit: '900123456',
    },
    order: {
      id: '42',
      tableName: '01',
      waiterName: 'Ana',
      createdAt: '2026-08-08T10:00:00.000Z',
    },
    items: [
      {
        name: 'Hamburguesa clasica',
        quantity: 1,
        unitPrice: 15000,
        total: 15000,
      },
    ],
    totals: {
      subtotal: 15000,
      tax: 0,
      discount: 0,
      tip: 2000,
      total: 17000,
    },
    paymentBreakdown: [{ label: 'Efectivo', amount: 17000 }],
    options: {
      paperWidth: '80mm',
      cutPaper: true,
      openCashDrawer: false,
    },
  });
  const text = buffer.toString('latin1');

  assert.equal(text.includes('Propina'), true);
  assert.equal(text.includes('METODOS DE PAGO'), true);
  assert.equal(text.includes('Efectivo'), true);
});

test('routes thermal inventory and shift reports without requiring receipt fields', () => {
  const service = createService({ savedConfigs: [], notifications: [], warnings: [] });
  const payload = {
    version: 1,
    reportKind: 'SHIFT',
    title: 'Cierre de Turno',
    reference: 'shift-1',
    business: {
      name: 'Restaurante Demo',
      nit: '900123456',
    },
    generatedAt: '2026-08-08T10:00:00.000Z',
    generatedBy: 'Ana',
    metadata: [{ label: 'Estado', value: 'Cerrado' }],
    sections: [
      {
        title: 'Resumen',
        rows: [{ label: 'Ventas', value: '$ 10.000' }],
      },
    ],
    options: {
      paperWidth: '80mm',
      cutPaper: true,
      openCashDrawer: false,
    },
  };

  const shiftBuffer = service.formatJob('SHIFT_REPORT', payload);
  const inventoryBuffer = service.formatJob('INVENTORY_REPORT', {
    ...payload,
    reportKind: 'INVENTORY',
    title: 'Gestion de Inventario',
  });

  assert.equal(Buffer.isBuffer(shiftBuffer), true);
  assert.equal(shiftBuffer.length > 100, true);
  assert.equal(Buffer.isBuffer(inventoryBuffer), true);
  assert.equal(inventoryBuffer.length > 100, true);
});

test('rejects payloads that do not match the selected print strategy', () => {
  const service = createService({ savedConfigs: [], notifications: [], warnings: [] });
  const thermalPayload = {
    version: 1,
    reportKind: 'INVENTORY',
    title: 'Gestion de Inventario',
    reference: 'inventory-1',
    business: {
      name: 'Restaurante Demo',
      nit: '900123456',
    },
    generatedAt: '2026-08-08T10:00:00.000Z',
    generatedBy: 'Ana',
    metadata: [{ label: 'Productos activos', value: '12' }],
    sections: [
      {
        title: 'Conteo',
        rows: [{ label: 'Cafe', value: '10 unidades' }],
      },
    ],
    options: {
      paperWidth: '80mm',
      cutPaper: true,
      openCashDrawer: false,
    },
  };

  assert.throws(
    () => service.formatJob('SHIFT_REPORT', thermalPayload),
    /SHIFT_REPORT.*shift/i,
  );
  assert.throws(
    () => service.formatJob('RECEIPT', thermalPayload),
    /RECEIPT.*factura/i,
  );
});

test('does not report failed after Windows accepts a raw job but backend printed ack fails', async () => {
  const restoreFetch = global.fetch;
  const requests = [];

  global.fetch = async (url, options = {}) => {
    const requestUrl = new URL(url);
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({
      path: requestUrl.pathname,
      method: options.method,
      body,
    });

    if (requestUrl.pathname.endsWith('/printed')) {
      return {
        ok: false,
        status: 500,
        json: async () => ({ message: 'ack failed' }),
      };
    }

    return {
      ok: true,
      status: 200,
      json: async () => ({ accepted: true }),
    };
  };

  try {
    const service = createService({
      savedConfigs: [],
      notifications: [],
      warnings: [],
      configOverrides: {
        backendBaseUrl: 'http://127.0.0.1:4321',
      },
    });
    const result = await service.printClaimedJob(
      {
        id: 'job-1',
        type: 'KITCHEN_TICKET',
        status: 'CLAIMED',
        payload: {
          business: {
            name: 'Restaurante Demo',
            nit: '900123456',
          },
          order: {
            id: '42-7',
            tableName: '01',
            waiterName: 'Ana',
            createdAt: '2026-08-08T10:00:00.000Z',
          },
          items: [
            {
              name: 'Hamburguesa clasica',
              quantity: 1,
              total: 15000,
            },
          ],
          options: {
            paperWidth: '80mm',
            copies: 1,
            cutPaper: true,
            openCashDrawer: false,
            showTotals: false,
            showItemPrices: false,
          },
        },
        printer: {
          id: 'printer-1',
          name: 'POS-80C',
          systemName: 'POS-80C',
          paperWidth: 80,
          copies: 1,
        },
      },
      'device-token',
    );

    const failedRequests = requests.filter((request) => request.path.endsWith('/failed'));
    const eventStages = requests
      .filter((request) => request.path.endsWith('/events'))
      .map((request) => request.body.stage);

    assert.equal(result, false);
    assert.equal(failedRequests.length, 0);
    assert.equal(requests.filter((request) => request.path.endsWith('/printed')).length, 3);
    assert.equal(eventStages.includes('SPOOL_ACCEPTED'), true);
    assert.equal(eventStages.includes('BACKEND_ACK_FAILED'), true);
  } finally {
    global.fetch = restoreFetch;
  }
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
      markFailed() {},
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
