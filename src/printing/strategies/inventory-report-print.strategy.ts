import { BackendPrintPayload } from '../../shared/contracts';
import { formatInventoryReport } from '../formatters/thermal-report.formatter';
import { requireThermalReportPayload } from './payload-guards';
import { PrintFormatStrategy } from './print-format.strategy';

export class InventoryReportPrintStrategy implements PrintFormatStrategy {
  readonly jobType = 'INVENTORY_REPORT';

  format(payload: BackendPrintPayload): Buffer {
    return formatInventoryReport(
      requireThermalReportPayload(payload, this.jobType, 'INVENTORY'),
    );
  }
}
