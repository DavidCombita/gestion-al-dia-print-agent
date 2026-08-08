import { BackendPrintPayload } from '../../shared/contracts';
import { formatShiftReport } from '../formatters/thermal-report.formatter';
import { requireThermalReportPayload } from './payload-guards';
import { PrintFormatStrategy } from './print-format.strategy';

export class ShiftReportPrintStrategy implements PrintFormatStrategy {
  readonly jobType = 'SHIFT_REPORT';

  format(payload: BackendPrintPayload): Buffer {
    return formatShiftReport(
      requireThermalReportPayload(payload, this.jobType, 'SHIFT'),
    );
  }
}
