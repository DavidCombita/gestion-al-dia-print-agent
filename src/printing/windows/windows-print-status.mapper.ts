import {
  PrintTransportJobStatus,
  RetrySafety,
} from '../contracts/print-transport';

export const WINDOWS_JOB_STATUS = {
  PAUSED: 0x00000001,
  ERROR: 0x00000002,
  DELETING: 0x00000004,
  SPOOLING: 0x00000008,
  PRINTING: 0x00000010,
  OFFLINE: 0x00000020,
  PAPEROUT: 0x00000040,
  PRINTED: 0x00000080,
  DELETED: 0x00000100,
  BLOCKED_DEVQ: 0x00000200,
  USER_INTERVENTION: 0x00000400,
  RESTART: 0x00000800,
  COMPLETE: 0x00001000,
  RETAINED: 0x00002000,
} as const;

export const WINDOWS_PRINTER_STATUS = {
  PAUSED: 0x00000001,
  ERROR: 0x00000002,
  PENDING_DELETION: 0x00000004,
  PAPER_JAM: 0x00000008,
  PAPER_OUT: 0x00000010,
  MANUAL_FEED: 0x00000020,
  PAPER_PROBLEM: 0x00000040,
  OFFLINE: 0x00000080,
  OUTPUT_BIN_FULL: 0x00000800,
  NOT_AVAILABLE: 0x00001000,
  NO_TONER: 0x00040000,
  USER_INTERVENTION: 0x00100000,
  OUT_OF_MEMORY: 0x00200000,
  DOOR_OPEN: 0x00400000,
  SERVER_UNKNOWN: 0x00800000,
} as const;

export interface WindowsJobStatusInput {
  statusNumber?: number;
  status?: string | string[];
}

export type PrinterAvailability = 'READY' | 'OFFLINE' | 'ERROR' | 'UNKNOWN';

export interface WindowsPrinterStatusInput {
  statusNumber?: number;
  status?: string | string[];
}

export function mapWindowsJobStatus(
  input: WindowsJobStatusInput,
): PrintTransportJobStatus {
  const statusNumber = normalizeStatusNumber(input.statusNumber);
  const labels = normalizeLabels(input.status);
  const retrySafety: RetrySafety = 'UNSAFE_TO_RETRY';
  const has = (flag: number, ...names: string[]) =>
    (statusNumber & flag) !== 0 || names.some((name) => labels.includes(name));

  if (has(WINDOWS_JOB_STATUS.DELETED, 'DELETED')) {
    return result('CANCELLED', statusNumber, labels, 'WINDOWS_JOB_DELETED', retrySafety);
  }

  if (has(WINDOWS_JOB_STATUS.OFFLINE, 'OFFLINE')) {
    return result('STUCK', statusNumber, labels, 'PRINTER_OFFLINE', retrySafety);
  }

  if (has(WINDOWS_JOB_STATUS.PAPEROUT, 'PAPEROUT', 'PAPER-OUT')) {
    return result('STUCK', statusNumber, labels, 'PRINTER_PAPEROUT', retrySafety);
  }

  if (has(WINDOWS_JOB_STATUS.BLOCKED_DEVQ, 'BLOCKED-DEVQ')) {
    return result('STUCK', statusNumber, labels, 'WINDOWS_QUEUE_BLOCKED', retrySafety);
  }

  if (has(WINDOWS_JOB_STATUS.USER_INTERVENTION, 'USER-INTERVENTION')) {
    return result('STUCK', statusNumber, labels, 'USER_INTERVENTION_REQUIRED', retrySafety);
  }

  if (has(WINDOWS_JOB_STATUS.PAUSED, 'PAUSED')) {
    return result('STUCK', statusNumber, labels, 'WINDOWS_JOB_PAUSED', retrySafety);
  }

  if (has(WINDOWS_JOB_STATUS.PRINTED, 'PRINTED')) {
    return result('SPOOL_COMPLETED', statusNumber, labels, undefined, retrySafety);
  }

  if (has(WINDOWS_JOB_STATUS.COMPLETE, 'COMPLETE')) {
    return {
      ...result(
        'SPOOL_COMPLETED',
        statusNumber,
        labels,
        'WINDOWS_JOB_COMPLETE_NO_PHYSICAL_CONFIRMATION',
        retrySafety,
      ),
      message:
        'Windows envio el trabajo al dispositivo, pero COMPLETE no confirma salida fisica.',
    };
  }

  if (has(WINDOWS_JOB_STATUS.RETAINED, 'RETAINED')) {
    const retainedWithError = has(WINDOWS_JOB_STATUS.ERROR, 'ERROR');
    return {
      ...result(
        'SPOOL_COMPLETED',
        statusNumber,
        labels,
        retainedWithError
          ? 'WINDOWS_JOB_RETAINED_WITH_ERROR_FLAG'
          : 'WINDOWS_JOB_RETAINED_AFTER_PRINT',
        retrySafety,
      ),
      message: retainedWithError
        ? 'Windows conservo el trabajo despues de imprimirlo; se ignora el indicador generico ERROR porque el trabajo ya fue retenido.'
        : 'Windows conservo el trabajo en la cola despues de imprimirlo.',
    };
  }

  if (has(WINDOWS_JOB_STATUS.ERROR, 'ERROR')) {
    return result('FAILED', statusNumber, labels, 'WINDOWS_JOB_ERROR', retrySafety);
  }

  if (has(WINDOWS_JOB_STATUS.DELETING, 'DELETING')) {
    return result('PRINTING', statusNumber, labels, 'WINDOWS_JOB_DELETING', retrySafety);
  }

  if (has(WINDOWS_JOB_STATUS.SPOOLING, 'SPOOLING')) {
    return result('SPOOLING', statusNumber, labels, undefined, retrySafety);
  }

  if (
    has(WINDOWS_JOB_STATUS.PRINTING, 'PRINTING') ||
    has(WINDOWS_JOB_STATUS.RESTART, 'RESTART')
  ) {
    return result('PRINTING', statusNumber, labels, undefined, retrySafety);
  }

  return result('SUBMITTED', statusNumber, labels, undefined, retrySafety);
}

export function mapWindowsPrinterAvailability(
  input: WindowsPrinterStatusInput,
): PrinterAvailability {
  const statusNumber = normalizeStatusNumber(input.statusNumber);
  const labels = normalizeLabels(input.status);
  const has = (flag: number, ...names: string[]) =>
    (statusNumber & flag) !== 0 || names.some((name) => labels.includes(name));

  if (
    has(WINDOWS_PRINTER_STATUS.OFFLINE, 'OFFLINE') ||
    has(WINDOWS_PRINTER_STATUS.NOT_AVAILABLE, 'NOT-AVAILABLE')
  ) {
    return 'OFFLINE';
  }

  if (
    has(WINDOWS_PRINTER_STATUS.PAUSED, 'PAUSED') ||
    has(WINDOWS_PRINTER_STATUS.PENDING_DELETION, 'PENDING-DELETION') ||
    has(WINDOWS_PRINTER_STATUS.ERROR, 'ERROR') ||
    has(WINDOWS_PRINTER_STATUS.PAPER_JAM, 'PAPER-JAM') ||
    has(WINDOWS_PRINTER_STATUS.PAPER_OUT, 'PAPER-OUT') ||
    has(WINDOWS_PRINTER_STATUS.PAPER_PROBLEM, 'PAPER-PROBLEM') ||
    has(WINDOWS_PRINTER_STATUS.OUTPUT_BIN_FULL, 'OUTPUT-BIN-FULL') ||
    has(WINDOWS_PRINTER_STATUS.NO_TONER, 'NO-TONER') ||
    has(WINDOWS_PRINTER_STATUS.USER_INTERVENTION, 'USER-INTERVENTION') ||
    has(WINDOWS_PRINTER_STATUS.OUT_OF_MEMORY, 'OUT-OF-MEMORY') ||
    has(WINDOWS_PRINTER_STATUS.DOOR_OPEN, 'DOOR-OPEN') ||
    has(WINDOWS_PRINTER_STATUS.SERVER_UNKNOWN, 'SERVER-UNKNOWN')
  ) {
    return 'ERROR';
  }

  if (labels.length === 0 && statusNumber === 0 && !Number.isFinite(input.statusNumber)) {
    return 'UNKNOWN';
  }

  return 'READY';
}

function result(
  state: PrintTransportJobStatus['state'],
  statusNumber: number,
  labels: string[],
  code: string | undefined,
  retrySafety: RetrySafety,
): PrintTransportJobStatus {
  return {
    state,
    exists: true,
    observed: true,
    windowsStatusNumber: statusNumber,
    windowsStatusLabels: labels,
    code,
    retrySafety,
  };
}

function normalizeStatusNumber(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;
}

function normalizeLabels(value: string | string[] | undefined): string[] {
  return (Array.isArray(value) ? value : [value])
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim().toUpperCase().replace(/_/g, '-'))
    .filter(Boolean);
}
