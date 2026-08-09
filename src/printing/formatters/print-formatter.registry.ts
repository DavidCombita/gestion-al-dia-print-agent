import crypto from 'node:crypto';
import {
  BackendPrintJobType,
  BackendPrintPayload,
} from '../../shared/contracts';
import { PreparedPrintDocument } from '../contracts/print-request';
import { PrinterProfile, PrintTransportType } from '../contracts/printer-profile';
import { formatBackendPrintJob } from '../strategies/print-format-strategy.registry';
import { formatPrintJobHtml } from './html-ticket.formatter';

export interface FormattedPrintDocument {
  rawData?: Buffer;
  html?: string;
  payloadBytes: number;
  payloadHash: string;
}

export class PrintFormatterRegistry {
  format(
    jobType: BackendPrintJobType,
    payload: BackendPrintPayload | undefined,
    preparedDocument: PreparedPrintDocument | undefined,
    profile: PrinterProfile,
    transport: PrintTransportType,
    documentName: string,
  ): FormattedPrintDocument {
    if (preparedDocument) {
      return this.fromPreparedDocument(preparedDocument, transport);
    }

    if (!payload) {
      throw new Error(`El trabajo ${jobType} no contiene payload para formatear.`);
    }

    const normalizedPayload: BackendPrintPayload = {
      ...payload,
      options: {
        ...payload.options,
        paperWidth: profile.paperWidth,
        charactersPerLine: profile.charactersPerLine,
        cutPaper: profile.raw?.cutPaper ?? payload.options?.cutPaper,
        openCashDrawer:
          profile.raw?.openCashDrawer ?? payload.options?.openCashDrawer,
      },
    };

    if (transport === 'WINDOWS_RAW') {
      const rawData = formatBackendPrintJob(jobType, normalizedPayload);
      return this.fromRaw(rawData);
    }

    const html = formatPrintJobHtml(jobType, normalizedPayload, documentName);
    return this.fromHtml(html);
  }

  private fromPreparedDocument(
    document: PreparedPrintDocument,
    transport: PrintTransportType,
  ): FormattedPrintDocument {
    if (transport === 'WINDOWS_RAW' && document.rawData) {
      return this.fromRaw(document.rawData);
    }

    if (transport === 'WINDOWS_DRIVER' && document.html) {
      return this.fromHtml(document.html);
    }

    throw new Error(
      `El documento preparado no es compatible con el transporte ${transport}.`,
    );
  }

  private fromRaw(rawData: Buffer): FormattedPrintDocument {
    return {
      rawData,
      payloadBytes: rawData.length,
      payloadHash: crypto.createHash('sha256').update(rawData).digest('hex'),
    };
  }

  private fromHtml(html: string): FormattedPrintDocument {
    return {
      html,
      payloadBytes: Buffer.byteLength(html, 'utf8'),
      payloadHash: crypto.createHash('sha256').update(html, 'utf8').digest('hex'),
    };
  }
}

