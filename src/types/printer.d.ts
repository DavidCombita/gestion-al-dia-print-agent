declare module 'printer' {
  interface PrinterDevice {
    name?: string;
    printerName?: string;
    isDefault?: boolean;
    status?: string | string[];
    statusNumber?: number;
    jobs?: PrinterJob[];
  }

  interface PrinterJob {
    id: number;
    document?: string;
    status?: string | string[];
    statusNumber?: number;
    size?: number;
    totalPages?: number;
  }

  interface PrintDirectOptions {
    data: Buffer | string;
    type?: string;
    printer?: string;
    docname?: string;
    options?: Record<string, unknown>;
    success?(jobId: number): void;
    error?(error?: Error): void;
  }

  interface GestionAlDiaModuleInfo {
    modulePath: string;
    binaryPath: string;
    mode: 'package-wrapper';
  }

  const printer: {
    getPrinters(): PrinterDevice[];
    getPrinter(printerName?: string): PrinterDevice;
    getDefaultPrinterName(): string;
    printDirect(options: PrintDirectOptions): number | null;
    getSupportedPrintFormats(): string[];
    getJob(printerName: string, jobId: number): PrinterJob;
    setJob(printerName: string, jobId: number, command: string): boolean;
    getSupportedJobCommands(): string[];
    __gestionAlDiaModuleInfo?: GestionAlDiaModuleInfo;
  };

  export = printer;
}

