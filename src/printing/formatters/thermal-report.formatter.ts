import { ThermalReportJobPayload } from '../../shared/contracts';
import { buildEscPosReport } from '../escpos-builder';

export function formatThermalReport(payload: ThermalReportJobPayload): Buffer {
  return buildEscPosReport(payload);
}

export function formatInventoryReport(payload: ThermalReportJobPayload): Buffer {
  return formatThermalReport({
    ...payload,
    title: payload.title.trim() || 'Gestion de Inventario',
  });
}

export function formatShiftReport(payload: ThermalReportJobPayload): Buffer {
  return formatThermalReport({
    ...payload,
    title: payload.title.trim() || 'Cierre de Turno',
  });
}
