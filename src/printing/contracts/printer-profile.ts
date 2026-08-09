import type { PaperWidth } from '../../shared/contracts';

export type PrintTransportType = 'WINDOWS_RAW' | 'WINDOWS_DRIVER';

export interface PrinterProfile {
  systemName: string;
  transport: PrintTransportType;
  paperWidth: PaperWidth;
  charactersPerLine?: number;
  raw?: {
    codePage?: 'CP850';
    cutPaper?: boolean;
    openCashDrawer?: boolean;
  };
  driver?: {
    usePrinterDefaultPageSize: boolean;
  };
}
