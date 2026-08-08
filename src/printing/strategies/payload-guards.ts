import {
  BackendPrintJobType,
  BackendPrintPayload,
  ReceiptJobPayload,
  ThermalReportJobPayload,
} from '../../shared/contracts';

type ThermalReportKind = ThermalReportJobPayload['reportKind'];

export function requireReceiptPayload(
  payload: BackendPrintPayload,
  jobType: BackendPrintJobType,
): ReceiptJobPayload {
  if (!isReceiptPayload(payload)) {
    throw new Error(`El trabajo ${jobType} no contiene una factura valida.`);
  }

  return payload;
}

export function requireThermalReportPayload(
  payload: BackendPrintPayload,
  jobType: BackendPrintJobType,
  reportKind: ThermalReportKind,
): ThermalReportJobPayload {
  if (!isThermalReportPayload(payload) || payload.reportKind !== reportKind) {
    throw new Error(
      `El trabajo ${jobType} no contiene un reporte ${reportKind.toLowerCase()} valido.`,
    );
  }

  return payload;
}

function isReceiptPayload(payload: BackendPrintPayload): payload is ReceiptJobPayload {
  const value = payload as unknown as Record<string, unknown>;
  const order = value.order as Record<string, unknown> | undefined;

  return (
    isRecord(payload) &&
    isBusinessPayload(value.business) &&
    isRecord(order) &&
    typeof order.id === 'string' &&
    typeof order.createdAt === 'string' &&
    Array.isArray(value.items)
  );
}

function isThermalReportPayload(
  payload: BackendPrintPayload,
): payload is ThermalReportJobPayload {
  const value = payload as unknown as Record<string, unknown>;

  return (
    isRecord(payload) &&
    (value.reportKind === 'INVENTORY' || value.reportKind === 'SHIFT') &&
    typeof value.title === 'string' &&
    isBusinessPayload(value.business) &&
    typeof value.generatedAt === 'string' &&
    typeof value.generatedBy === 'string' &&
    Array.isArray(value.metadata) &&
    Array.isArray(value.sections)
  );
}

function isBusinessPayload(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.nit === 'string'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
