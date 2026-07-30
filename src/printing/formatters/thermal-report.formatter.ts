import { ThermalReportJobPayload } from "../../shared/contracts";
import { buildEscPosReport } from "../escpos-builder";

export function formatThermalReport(payload: ThermalReportJobPayload): Buffer {
  return buildEscPosReport(payload);
}
