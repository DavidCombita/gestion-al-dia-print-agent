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
  backendDeviceToken: string | null;
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
  backendDeviceToken: null,
};

export function sanitizeAppConfig(value: unknown): AppConfig {
  const record = isRecord(value) ? value : {};

  return {
    invoicePrinterName: normalizeNullableString(record.invoicePrinterName),
    kitchenPrinterName: normalizeNullableString(record.kitchenPrinterName),
    invoiceCopies: normalizeCopies(record.invoiceCopies),
    kitchenCopies: normalizeCopies(record.kitchenCopies),
    invoiceEnabled: normalizeBoolean(record.invoiceEnabled, true),
    kitchenEnabled: normalizeBoolean(record.kitchenEnabled, true),
    paperWidth: normalizePaperWidth(record.paperWidth),
    pairingToken: normalizeNullableString(record.pairingToken),
    allowedOrigins: normalizeAllowedOrigins(record.allowedOrigins),
    backendBaseUrl: null,
    backendAgentId: normalizeNullableString(record.backendAgentId),
    backendBusinessId: normalizeNullableString(record.backendBusinessId),
    backendDeviceToken: normalizeNullableString(record.backendDeviceToken),
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
