import { PrinterProfile } from '../printing/contracts/printer-profile';

export type PaperWidth = '58mm' | '80mm';

export interface AppConfig {
  invoicePrinterName: string | null;
  kitchenPrinterName: string | null;
  invoiceCopies: number;
  kitchenCopies: number;
  invoiceEnabled: boolean;
  kitchenEnabled: boolean;
  paperWidth: PaperWidth;
  pairingToken: string | null;
  allowedOrigins: string[];
  backendBaseUrl: string | null;
  backendAgentId: string | null;
  backendBusinessId: string | null;
  backendDeviceId: string | null;
  backendDeviceToken: string | null;
  printerProfiles: PrinterProfile[];
  printJobPollIntervalMs: number;
  printJobCompletionTimeoutMs: number;
  maxPendingPrintJobsPerPrinter: number;
}

export const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:4200',
  'http://127.0.0.1:4200',
  'https://aldia-co.com',
  'https://www.aldia-co.com',
];

export const defaultAppConfig: AppConfig = {
  invoicePrinterName: null,
  kitchenPrinterName: null,
  invoiceCopies: 1,
  kitchenCopies: 1,
  invoiceEnabled: true,
  kitchenEnabled: true,
  paperWidth: '80mm',
  pairingToken: null,
  allowedOrigins: DEFAULT_ALLOWED_ORIGINS,
  backendBaseUrl: null,
  backendAgentId: null,
  backendBusinessId: null,
  backendDeviceId: null,
  backendDeviceToken: null,
  printerProfiles: [],
  printJobPollIntervalMs: 750,
  printJobCompletionTimeoutMs: 45_000,
  maxPendingPrintJobsPerPrinter: 50,
};

export function sanitizeAppConfig(value: unknown): AppConfig {
  const record = isRecord(value) ? value : {};
  const paperWidth = normalizePaperWidth(record.paperWidth);

  return {
    invoicePrinterName: normalizeNullableString(record.invoicePrinterName),
    kitchenPrinterName: normalizeNullableString(record.kitchenPrinterName),
    invoiceCopies: normalizeCopies(record.invoiceCopies),
    kitchenCopies: normalizeCopies(record.kitchenCopies),
    invoiceEnabled: normalizeBoolean(record.invoiceEnabled, true),
    kitchenEnabled: normalizeBoolean(record.kitchenEnabled, true),
    paperWidth,
    pairingToken: normalizeNullableString(record.pairingToken),
    allowedOrigins: normalizeAllowedOrigins(record.allowedOrigins),
    backendBaseUrl: normalizeBackendBaseUrl(record.backendBaseUrl),
    backendAgentId: normalizeNullableString(record.backendAgentId),
    backendBusinessId: normalizeNullableString(record.backendBusinessId),
    backendDeviceId: normalizeNullableString(record.backendDeviceId),
    backendDeviceToken: normalizeNullableString(record.backendDeviceToken),
    printerProfiles: normalizePrinterProfiles(record.printerProfiles, paperWidth),
    printJobPollIntervalMs: normalizeInteger(
      record.printJobPollIntervalMs,
      750,
      250,
      5_000,
    ),
    printJobCompletionTimeoutMs: normalizeInteger(
      record.printJobCompletionTimeoutMs,
      45_000,
      5_000,
      180_000,
    ),
    maxPendingPrintJobsPerPrinter: normalizeInteger(
      record.maxPendingPrintJobsPerPrinter,
      50,
      1,
      500,
    ),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizeCopies(value: unknown): number {
  const parsedValue =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : Number.NaN;
  const safeValue = Number.isFinite(parsedValue) ? Math.trunc(parsedValue) : 1;
  return Math.min(5, Math.max(1, safeValue));
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizePaperWidth(value: unknown): PaperWidth {
  return value === '58mm' ? '58mm' : '80mm';
}

function normalizePrinterProfiles(
  value: unknown,
  fallbackPaperWidth: PaperWidth,
): PrinterProfile[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const profiles = new Map<string, PrinterProfile>();

  for (const candidate of value) {
    if (!isRecord(candidate)) {
      continue;
    }

    const systemName = normalizeNullableString(candidate.systemName);

    if (!systemName) {
      continue;
    }

    const raw = isRecord(candidate.raw) ? candidate.raw : {};
    const driver = isRecord(candidate.driver) ? candidate.driver : {};
    const charactersPerLine = normalizeOptionalInteger(
      candidate.charactersPerLine,
      16,
      80,
    );
    const profile: PrinterProfile = {
      systemName,
      transport:
        candidate.transport === 'WINDOWS_DRIVER'
          ? 'WINDOWS_DRIVER'
          : 'WINDOWS_RAW',
      paperWidth:
        candidate.paperWidth === '58mm' || candidate.paperWidth === '80mm'
          ? candidate.paperWidth
          : fallbackPaperWidth,
      charactersPerLine,
      raw: {
        codePage: 'CP850',
        cutPaper: normalizeBoolean(raw.cutPaper, true),
        openCashDrawer: normalizeBoolean(raw.openCashDrawer, false),
      },
      driver: {
        usePrinterDefaultPageSize: normalizeBoolean(
          driver.usePrinterDefaultPageSize,
          true,
        ),
      },
    };

    profiles.set(systemName.toLocaleLowerCase(), profile);
  }

  return Array.from(profiles.values());
}

function normalizeInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const normalized = normalizeOptionalInteger(value, minimum, maximum);
  return normalized ?? fallback;
}

function normalizeOptionalInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number | undefined {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : Number.NaN;

  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

function normalizeAllowedOrigins(value: unknown): string[] {
  const configuredOrigins = Array.isArray(value)
    ? value
        .filter((origin): origin is string => typeof origin === 'string')
        .map(normalizeOrigin)
        .filter((origin): origin is string => origin !== null)
    : [];

  return Array.from(new Set([...DEFAULT_ALLOWED_ORIGINS, ...configuredOrigins]));
}

function normalizeOrigin(value: string): string | null {
  const trimmedValue = value.trim();

  if (!trimmedValue) {
    return null;
  }

  try {
    return new URL(trimmedValue).origin;
  } catch {
    return trimmedValue.replace(/\/+$/, '');
  }
}

function normalizeBackendBaseUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }

  try {
    return new URL(value.trim()).origin;
  } catch {
    return value.trim().replace(/\/+$/, '');
  }
}
