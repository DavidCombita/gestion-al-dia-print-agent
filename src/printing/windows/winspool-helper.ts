import fs from 'node:fs';
import path from 'node:path';
import printer = require('printer');

interface HelperRequest {
  requestId: string;
  action: string;
  payload?: Record<string, unknown>;
}

const printerModulePath = process.argv[2];
const utilityParentPort = process.parentPort;

if (!printerModulePath) {
  throw new Error('El helper WinSpool no recibio la ruta del modulo printer.');
}

if (!utilityParentPort) {
  throw new Error('El helper WinSpool debe ejecutarse como Electron UtilityProcess.');
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const nativePrinter = require(printerModulePath) as typeof printer;

utilityParentPort.on('message', (event: Electron.MessageEvent) => {
  const request = event.data as HelperRequest;

  try {
    const result = execute(request.action, request.payload ?? {});
    utilityParentPort.postMessage({
      requestId: request.requestId,
      success: true,
      result,
    });
  } catch (error) {
    utilityParentPort.postMessage({
      requestId: request.requestId,
      success: false,
      error: normalizeError(error, request.action),
    });
  }
});

function execute(action: string, payload: Record<string, unknown>): unknown {
  switch (action) {
    case 'runtimeInfo':
      return resolveRuntimeInfo();
    case 'listPrinters':
      return nativePrinter.getPrinters();
    case 'submitRaw':
      return submitRaw(payload);
    case 'getJob':
      return getJob(payload);
    case 'listJobs':
      return listJobs(payload);
    case 'deleteJob':
      return deleteJob(payload);
    default:
      throw new Error(`Operacion WinSpool no soportada: ${action}.`);
  }
}

function submitRaw(payload: Record<string, unknown>): number {
  const printerName = requireString(payload.printerName, 'printerName');
  const documentName = requireString(payload.documentName, 'documentName');
  const dataBase64 = requireString(payload.dataBase64, 'dataBase64');
  const data = Buffer.from(dataBase64, 'base64');
  let callbackJobId: number | undefined;
  let callbackError: unknown;
  const returnedJobId = nativePrinter.printDirect({
    data,
    type: 'RAW',
    printer: printerName,
    docname: documentName,
    success(jobId) {
      callbackJobId = jobId;
    },
    error(error) {
      callbackError = error;
    },
  });

  if (callbackError) {
    throw callbackError;
  }

  const jobId =
    typeof callbackJobId === 'number' ? callbackJobId : returnedJobId;

  if (typeof jobId !== 'number' || !Number.isFinite(jobId) || jobId <= 0) {
    throw new Error('printDirect no devolvio un Windows JobId valido.');
  }

  return Math.trunc(jobId);
}

function getJob(payload: Record<string, unknown>): unknown {
  const printerName = requireString(payload.printerName, 'printerName');
  const systemJobId = requireJobId(payload.systemJobId);

  try {
    return nativePrinter.getJob(printerName, systemJobId);
  } catch (error) {
    if (isMissingJobError(error)) {
      return null;
    }

    throw error;
  }
}

function listJobs(payload: Record<string, unknown>): unknown[] {
  const printerName = requireString(payload.printerName, 'printerName');
  const printerSnapshot = nativePrinter.getPrinter(printerName);
  return Array.isArray(printerSnapshot.jobs) ? printerSnapshot.jobs : [];
}

function deleteJob(payload: Record<string, unknown>): void {
  const printerName = requireString(payload.printerName, 'printerName');
  const systemJobId = requireJobId(payload.systemJobId);
  const supportedCommands = nativePrinter.getSupportedJobCommands();
  const command = supportedCommands.includes('DELETE') ? 'DELETE' : 'CANCEL';
  const deleted = nativePrinter.setJob(printerName, systemJobId, command);

  if (deleted === false) {
    throw new Error(
      `SetJob ${command} no pudo eliminar el trabajo ${systemJobId}.`,
    );
  }
}

function resolveRuntimeInfo(): Record<string, unknown> {
  const moduleInfo = nativePrinter.__gestionAlDiaModuleInfo;
  const packageRoot = path.resolve(path.dirname(printerModulePath), '..');
  const packagePath = path.join(packageRoot, 'package.json');
  let printerPackageVersion: string | undefined;

  if (fs.existsSync(packagePath)) {
    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as {
      version?: string;
    };
    printerPackageVersion = packageJson.version;
  }

  return {
    printerModulePath,
    printerBinaryPath: moduleInfo?.binaryPath,
    printerPackageVersion,
    printerModuleMode: 'package-wrapper',
    helperPid: process.pid,
  };
}

function normalizeError(
  error: unknown,
  action: string,
): { code: string; message: string; outcomeUnknown: boolean } {
  const message =
    error instanceof Error && error.message.trim()
      ? error.message.trim()
      : String(error);
  return {
    code: isMissingJobError(error)
      ? 'WINDOWS_JOB_NOT_FOUND'
      : `WINSPOOL_${action.toUpperCase()}_FAILED`,
    message,
    outcomeUnknown:
      action === 'submitRaw' && !isProvablyPreSubmitFailure(message),
  };
}

function isProvablyPreSubmitFailure(message: string): boolean {
  return /PrinterHandle|StartDocPrinterW|Argument \d|campo .* obligatorio|documento vacio/i.test(
    message,
  );
}

function isMissingJobError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /code:\s*87\b|parameter is incorrect|parametro no es correcto/i.test(message);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`El campo ${field} es obligatorio.`);
  }

  return value.trim();
}

function requireJobId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error('Windows JobId invalido.');
  }

  return Math.trunc(value);
}
