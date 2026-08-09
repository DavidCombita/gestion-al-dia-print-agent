const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { PrintHistoryService } = require('../dist/printing/history/print-history.service.js');
const { PrintOrchestratorService } = require('../dist/printing/print-orchestrator.service.js');
const { PrinterQueueService } = require('../dist/printing/queue/printer-queue.service.js');
const { PrintTransportRegistry } = require('../dist/printing/transports/print-transport.registry.js');
const { WindowsDriverTransport } = require('../dist/printing/transports/windows-driver.transport.js');
const { WindowsRawTransport } = require('../dist/printing/transports/windows-raw.transport.js');
const { SpoolJobMonitorService } = require('../dist/printing/windows/spool-job-monitor.service.js');
const { WinSpoolOperationError } = require('../dist/printing/windows/winspool-adapter.js');
const {
  WINDOWS_JOB_STATUS,
  WINDOWS_PRINTER_STATUS,
  mapWindowsJobStatus,
  mapWindowsPrinterAvailability,
} = require('../dist/printing/windows/windows-print-status.mapper.js');

const logger = {
  info() {},
  warn() {},
  error() {},
};

test('persists SUBMITTED and the Windows JobId as soon as submit returns', async (t) => {
  let releaseMonitor;
  let notifyMonitorStarted;
  const monitorStarted = new Promise((resolve) => {
    notifyMonitorStarted = resolve;
  });
  const monitorRelease = new Promise((resolve) => {
    releaseMonitor = resolve;
  });
  const harness = createHarness(t, {
    monitor: {
      async monitor(job) {
        notifyMonitorStarted(job);
        await monitorRelease;
        return completedStatus();
      },
    },
  });

  const execution = harness.orchestrator.execute(printRequest('POS-80C'));
  const submitted = await monitorStarted;
  const stored = harness.history.getRecentJobs()[0];

  assert.equal(submitted.systemJobId, 101);
  assert.equal(stored.status, 'SUBMITTED');
  assert.equal(stored.windowsJobId, 101);

  releaseMonitor();
  assert.equal((await execution).status, 'SPOOL_COMPLETED');
});

test('maps PRINTING followed by PRINTED to SPOOL_COMPLETED', async () => {
  const transport = new FakeTransport({
    statuses: [
      mapWindowsJobStatus({ statusNumber: WINDOWS_JOB_STATUS.PRINTING }),
      mapWindowsJobStatus({ statusNumber: WINDOWS_JOB_STATUS.PRINTED }),
    ],
  });
  const monitor = createClockedMonitor();
  const result = await monitor.monitor(submittedJob(), transport);

  assert.equal(result.state, 'SPOOL_COMPLETED');
  assert.equal(result.observed, true);
});

test('treats disappearance after observation as SPOOL_COMPLETED', async () => {
  const transport = new FakeTransport({
    statuses: [
      printingStatus(),
      {
        state: 'UNKNOWN',
        exists: false,
        observed: false,
        retrySafety: 'UNSAFE_TO_RETRY',
      },
    ],
  });
  const result = await createClockedMonitor().monitor(submittedJob(), transport);

  assert.equal(result.state, 'SPOOL_COMPLETED');
  assert.equal(result.code, 'WINDOWS_JOB_DISAPPEARED_AFTER_OBSERVATION');
});

test('maps PAPEROUT to a terminal STUCK state', () => {
  const result = mapWindowsJobStatus({ statusNumber: WINDOWS_JOB_STATUS.PAPEROUT });

  assert.equal(result.state, 'STUCK');
  assert.equal(result.code, 'PRINTER_PAPEROUT');
  assert.equal(result.retrySafety, 'UNSAFE_TO_RETRY');
});

test('maps COMPLETE to spool completion without claiming physical output', () => {
  const result = mapWindowsJobStatus({
    statusNumber: WINDOWS_JOB_STATUS.COMPLETE,
  });

  assert.equal(result.state, 'SPOOL_COMPLETED');
  assert.equal(
    result.code,
    'WINDOWS_JOB_COMPLETE_NO_PHYSICAL_CONFIRMATION',
  );
  assert.match(result.message, /no confirma salida fisica/i);
});

test('maps numeric Windows printer availability independently from job status', () => {
  assert.equal(
    mapWindowsPrinterAvailability({ statusNumber: WINDOWS_PRINTER_STATUS.OFFLINE }),
    'OFFLINE',
  );
  assert.equal(
    mapWindowsPrinterAvailability({ statusNumber: WINDOWS_PRINTER_STATUS.PAPER_OUT }),
    'ERROR',
  );
  assert.equal(mapWindowsPrinterAvailability({ statusNumber: 0 }), 'READY');
});

test('does not retry automatically after Windows reports OFFLINE', async (t) => {
  const offline = mapWindowsJobStatus({ statusNumber: WINDOWS_JOB_STATUS.OFFLINE });
  const transport = new FakeTransport({ statuses: [offline] });
  const harness = createHarness(t, { transport });
  const result = await harness.orchestrator.execute(printRequest('POS-80C'));

  assert.equal(result.status, 'STUCK');
  assert.equal(result.retrySafety, 'UNSAFE_TO_RETRY');
  assert.equal(transport.submitCalls.length, 1);
});

test('resolves a job that exceeds the polling deadline as STUCK', async () => {
  const transport = new FakeTransport({ statusFactory: () => printingStatus() });
  const monitor = createClockedMonitor({ completionTimeoutMs: 1_500 });
  const result = await monitor.monitor(submittedJob(), transport);

  assert.equal(result.state, 'STUCK');
  assert.equal(result.code, 'SPOOL_MONITOR_TIMEOUT');
});

test('opens the circuit breaker for the affected printer after STUCK', async (t) => {
  const transport = new FakeTransport({ statuses: [stuckStatus()] });
  const harness = createHarness(t, { transport });

  await harness.orchestrator.execute(printRequest('POS-80C'));
  const rejected = await harness.orchestrator.execute(printRequest('POS-80C'));

  assert.equal(harness.queue.getPrinterSnapshot('POS-80C').health, 'BLOCKED');
  assert.equal(rejected.status, 'FAILED');
  assert.equal(rejected.attempts[0].errorCode, 'PRINTER_CIRCUIT_OPEN');
  assert.equal(transport.submitCalls.length, 1);
});

test('keeps another printer operational when one printer is blocked', async (t) => {
  const transport = new FakeTransport({
    statusFactory(job) {
      return job.printerName === 'CAJA' ? stuckStatus() : completedStatus();
    },
  });
  const harness = createHarness(t, { transport });

  const caja = await harness.orchestrator.execute(printRequest('CAJA'));
  const cocina = await harness.orchestrator.execute(printRequest('COCINA'));

  assert.equal(caja.status, 'STUCK');
  assert.equal(cocina.status, 'SPOOL_COMPLETED');
  assert.equal(harness.queue.getPrinterSnapshot('COCINA').health, 'HEALTHY');
});

test('executes two jobs for the same printer sequentially', async () => {
  const queue = new PrinterQueueService(logger, 10);
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const first = queue.enqueue('POS-80C', 'A', async () => {
    events.push('A:start');
    await firstGate;
    events.push('A:end');
  });
  const second = queue.enqueue('POS-80C', 'B', async () => {
    events.push('B:start');
    events.push('B:end');
  });

  await nextTurn();
  assert.deepEqual(events, ['A:start']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['A:start', 'A:end', 'B:start', 'B:end']);
});

test('allows different printers to execute independently', async () => {
  const queue = new PrinterQueueService(logger, 10);
  const started = new Set();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const first = queue.enqueue('CAJA', 'A', async () => {
    started.add('CAJA');
    await gate;
  });
  const second = queue.enqueue('COCINA', 'B', async () => {
    started.add('COCINA');
    await gate;
  });

  await nextTurn();
  assert.deepEqual([...started].sort(), ['CAJA', 'COCINA']);
  release();
  await Promise.all([first, second]);
});

test('reconciles an accepted job after restart without submitting it again', async (t) => {
  const transport = new FakeTransport({
    statuses: [
      {
        state: 'UNKNOWN',
        exists: false,
        observed: false,
        retrySafety: 'UNSAFE_TO_RETRY',
      },
    ],
  });
  const harness = createHarness(t, { transport });
  const record = harness.history.createJob({
    printerName: 'POS-80C',
    documentName: 'GAD-restart-1',
    jobType: 'RECEIPT',
    copyNumber: 1,
    copies: 1,
    transport: 'WINDOWS_RAW',
    windowsJobId: 777,
    windowsJobObserved: true,
    submittedAt: new Date().toISOString(),
    retrySafety: 'UNSAFE_TO_RETRY',
    status: 'SUBMITTED',
  });

  const results = await harness.orchestrator.reconcilePendingJobs();

  assert.equal(results[0].status, 'SPOOL_COMPLETED');
  assert.equal(transport.submitCalls.length, 0);
  assert.equal(harness.history.getJob(record.localJobId).status, 'SPOOL_COMPLETED');
});

test('reports PARTIAL_FAILURE without resubmitting a completed copy', async (t) => {
  const transport = new FakeTransport({
    statusFactory(job) {
      return job.documentName.endsWith('-1')
        ? completedStatus()
        : failedStatus('SECOND_COPY_FAILED');
    },
  });
  const harness = createHarness(t, { transport });
  const result = await harness.orchestrator.execute({
    ...printRequest('POS-80C'),
    copies: 2,
  });

  assert.equal(result.status, 'PARTIAL_FAILURE');
  assert.deepEqual(result.attempts.map((attempt) => attempt.status), [
    'SPOOL_COMPLETED',
    'FAILED',
  ]);
  assert.equal(transport.submitCalls.length, 2);
});

test('propagates Electron failureReason from the driver transport', async () => {
  const transport = new WindowsDriverTransport(
    () => ({
      async loadURL() {},
      webContents: {
        print(_options, callback) {
          callback(false, 'Invalid printer settings');
        },
      },
      destroy() {},
    }),
    1_000,
  );

  await assert.rejects(
    transport.submit({
      printer: { systemName: 'POS-80C' },
      documentName: 'driver-test',
      html: '<html><body>Test</body></html>',
      payloadBytes: 30,
      driverOptions: { usePrinterDefaultPageSize: true },
    }),
    (error) => {
      assert.equal(error.message, 'Invalid printer settings');
      assert.equal(error.code, 'DRIVER_SUBMIT_FAILED');
      return true;
    },
  );
});

test('classifies a RAW failure after possible Windows acceptance as unsafe', async () => {
  const transport = new WindowsRawTransport({
    async submitRaw() {
      throw new WinSpoolOperationError(
        'StartPagePrinter fallo despues de crear el trabajo.',
        'WINSPOOL_SUBMITRAW_FAILED',
        'submitRaw',
        true,
      );
    },
  });

  await assert.rejects(
    transport.submit({
      printer: { systemName: 'POS-80C' },
      documentName: 'raw-test',
      rawData: Buffer.from('test', 'ascii'),
      payloadBytes: 4,
    }),
    (error) => {
      assert.equal(error.acceptedByWindows, true);
      assert.equal(error.retrySafety, 'UNSAFE_TO_RETRY');
      return true;
    },
  );
});

test('keeps an unexpected post-submit failure unsafe and does not retry', async (t) => {
  const transport = new FakeTransport();
  const harness = createHarness(t, {
    transport,
    monitor: {
      async monitor() {
        throw new Error('Fallo inesperado consultando el spooler.');
      },
    },
  });

  const result = await harness.orchestrator.execute(printRequest('POS-80C'));

  assert.equal(result.status, 'UNKNOWN');
  assert.equal(result.retrySafety, 'UNSAFE_TO_RETRY');
  assert.equal(result.attempts[0].submitted, true);
  assert.equal(result.attempts[0].systemJobId, 101);
  assert.equal(transport.submitCalls.length, 1);
});

test('refreshes a stuck JobId and resolves it when Windows no longer lists it', async (t) => {
  const transport = new FakeTransport({
    statuses: [
      {
        state: 'UNKNOWN',
        exists: false,
        observed: false,
        retrySafety: 'UNSAFE_TO_RETRY',
      },
    ],
  });
  const harness = createHarness(t, { transport });
  const record = harness.history.createJob({
    printerName: 'POS-80C',
    documentName: 'GAD-stuck-refresh',
    jobType: 'RECEIPT',
    copyNumber: 1,
    copies: 1,
    transport: 'WINDOWS_RAW',
    windowsJobId: 889,
    windowsJobObserved: true,
    status: 'STUCK',
    retrySafety: 'UNSAFE_TO_RETRY',
  });
  harness.queue.blockPrinter('POS-80C', record.localJobId, 'Trabajo atascado.');

  const refreshed = await harness.orchestrator.refreshJobStatus(record.localJobId);

  assert.equal(refreshed.status, 'SPOOL_COMPLETED');
  assert.equal(
    refreshed.errorCode,
    'WINDOWS_JOB_DISAPPEARED_AFTER_OBSERVATION',
  );
  assert.equal(harness.queue.getPrinterSnapshot('POS-80C').health, 'HEALTHY');
});

test('cancels only the known Windows JobId and unblocks that printer', async (t) => {
  const transport = new FakeTransport({
    statuses: [
      {
        state: 'CANCELLED',
        exists: false,
        observed: true,
        retrySafety: 'SAFE_TO_RETRY',
      },
    ],
  });
  const harness = createHarness(t, { transport });
  const record = harness.history.createJob({
    printerName: 'POS-80C',
    documentName: 'GAD-stuck-1',
    jobType: 'RECEIPT',
    copyNumber: 1,
    copies: 1,
    transport: 'WINDOWS_RAW',
    windowsJobId: 888,
    status: 'STUCK',
    retrySafety: 'UNSAFE_TO_RETRY',
  });
  harness.queue.blockPrinter('POS-80C', record.localJobId, 'Trabajo atascado.');

  const cancelled = await harness.orchestrator.cancelJob(record.localJobId);

  assert.deepEqual(transport.cancelCalls, [888]);
  assert.equal(cancelled.status, 'CANCELLED');
  assert.equal(harness.queue.getPrinterSnapshot('POS-80C').health, 'HEALTHY');
});

test('rejects a printer that does not exist before formatting or submit', async (t) => {
  const transport = new FakeTransport();
  const harness = createHarness(t, {
    transport,
    printerExists: false,
  });

  await assert.rejects(
    harness.orchestrator.execute(printRequest('NO-EXISTE')),
    /no existe en Windows/i,
  );
  assert.equal(transport.submitCalls.length, 0);
  assert.equal(harness.history.getRecentJobs().length, 0);
});

class FakeTransport {
  constructor(options = {}) {
    this.type = 'WINDOWS_RAW';
    this.statuses = [...(options.statuses || [])];
    this.statusFactory = options.statusFactory;
    this.submitCalls = [];
    this.cancelCalls = [];
    this.nextJobId = 101;
  }

  async submit(request) {
    this.submitCalls.push(request);
    return {
      transport: this.type,
      printerName: request.printer.systemName,
      documentName: request.documentName,
      systemJobId: this.nextJobId++,
      submittedAt: new Date().toISOString(),
      payloadBytes: request.payloadBytes,
    };
  }

  async getJobStatus(job) {
    if (this.statusFactory) {
      return this.statusFactory(job);
    }

    return this.statuses.shift() || completedStatus();
  }

  async cancel(job) {
    this.cancelCalls.push(job.systemJobId);
  }
}

function createHarness(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gad-print-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const history = new PrintHistoryService(directory, logger);
  const queue = new PrinterQueueService(logger, 10);
  const transport = options.transport || new FakeTransport();
  const monitor =
    options.monitor ||
    new SpoolJobMonitorService(logger, {
      pollIntervalMs: 1,
      completionTimeoutMs: 20,
      sleep: async () => {},
    });
  const orchestrator = new PrintOrchestratorService({
    formatterRegistry: {
      format() {
        return {
          rawData: Buffer.from('test', 'ascii'),
          payloadBytes: 4,
          payloadHash: 'test-hash',
        };
      },
    },
    profileService: {
      resolveProfile(systemName) {
        return {
          systemName,
          transport: 'WINDOWS_RAW',
          paperWidth: '80mm',
          raw: { codePage: 'CP850', cutPaper: true, openCashDrawer: false },
          driver: { usePrinterDefaultPageSize: true },
        };
      },
    },
    queueService: queue,
    historyService: history,
    transportRegistry: new PrintTransportRegistry([transport]),
    monitorService: monitor,
    printerDiscoveryService: {
      async printerExists() {
        return options.printerExists !== false;
      },
    },
    logger,
  });

  return { history, queue, transport, orchestrator };
}

function createClockedMonitor(options = {}) {
  let now = 0;
  return new SpoolJobMonitorService(logger, {
    pollIntervalMs: 750,
    completionTimeoutMs: options.completionTimeoutMs || 4_500,
    now: () => now,
    sleep: async (milliseconds) => {
      now += milliseconds;
    },
  });
}

function printRequest(printerName) {
  return {
    source: 'LOCAL',
    jobType: 'TEST_PRINT',
    preparedDocument: { rawData: Buffer.from('test', 'ascii') },
    printerName,
    documentName: 'test',
    copies: 1,
  };
}

function submittedJob() {
  return {
    transport: 'WINDOWS_RAW',
    printerName: 'POS-80C',
    documentName: 'test',
    systemJobId: 123,
    submittedAt: new Date().toISOString(),
    payloadBytes: 4,
  };
}

function printingStatus() {
  return {
    state: 'PRINTING',
    exists: true,
    observed: true,
    windowsStatusLabels: ['PRINTING'],
    retrySafety: 'UNSAFE_TO_RETRY',
  };
}

function completedStatus() {
  return {
    state: 'SPOOL_COMPLETED',
    exists: true,
    observed: true,
    windowsStatusLabels: ['PRINTED'],
    retrySafety: 'UNSAFE_TO_RETRY',
  };
}

function stuckStatus() {
  return {
    state: 'STUCK',
    exists: true,
    observed: true,
    code: 'PRINTER_OFFLINE',
    message: 'La impresora esta offline.',
    retrySafety: 'UNSAFE_TO_RETRY',
  };
}

function failedStatus(code) {
  return {
    state: 'FAILED',
    exists: true,
    observed: true,
    code,
    message: 'Windows reporto un error terminal.',
    retrySafety: 'UNSAFE_TO_RETRY',
  };
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}
