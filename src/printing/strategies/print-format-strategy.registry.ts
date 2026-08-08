import {
  BackendPrintJobType,
  BackendPrintPayload,
} from '../../shared/contracts';
import { InventoryReportPrintStrategy } from './inventory-report-print.strategy';
import { InvoicePrintStrategy } from './invoice-print.strategy';
import { KitchenTicketPrintStrategy } from './kitchen-ticket-print.strategy';
import { PrintFormatStrategy } from './print-format.strategy';
import { ShiftReportPrintStrategy } from './shift-report-print.strategy';
import { TestTicketPrintStrategy } from './test-ticket-print.strategy';

const PRINT_FORMAT_STRATEGIES: readonly PrintFormatStrategy[] = [
  new InvoicePrintStrategy('RECEIPT'),
  new InvoicePrintStrategy('CASH_CLOSING'),
  new KitchenTicketPrintStrategy(),
  new InventoryReportPrintStrategy(),
  new ShiftReportPrintStrategy(),
  new TestTicketPrintStrategy(),
];

const STRATEGY_BY_JOB_TYPE = new Map<BackendPrintJobType, PrintFormatStrategy>();

for (const strategy of PRINT_FORMAT_STRATEGIES) {
  if (STRATEGY_BY_JOB_TYPE.has(strategy.jobType)) {
    throw new Error(`Estrategia de impresion duplicada para ${strategy.jobType}.`);
  }

  STRATEGY_BY_JOB_TYPE.set(strategy.jobType, strategy);
}

export function formatBackendPrintJob(
  jobType: BackendPrintJobType,
  payload: BackendPrintPayload,
): Buffer {
  return getPrintFormatStrategy(jobType).format(payload);
}

export function getPrintFormatStrategy(
  jobType: BackendPrintJobType,
): PrintFormatStrategy {
  const strategy = STRATEGY_BY_JOB_TYPE.get(jobType);

  if (!strategy) {
    throw new Error(`No hay estrategia de impresion para ${jobType}.`);
  }

  return strategy;
}
