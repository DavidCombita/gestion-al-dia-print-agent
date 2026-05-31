import http from 'node:http';
import cors from 'cors';
import express, { NextFunction, Request, Response } from 'express';
import { shell } from 'electron';
import { AppConfigService } from '../config/app-config.service';
import { LoggerService } from '../logs/logger.service';
import { PrintQueueService } from '../printing/print-queue.service';
import { PrinterService } from '../printing/printer.service';
import {
  AgentHealthResponse,
  AgentMutationResponse,
  ReceiptJobPayload,
} from '../shared/contracts';
import { createCorsOptions } from '../security/cors.config';
import { PairingTokenService } from '../security/pairing-token.service';
import { sanitizeAppConfig } from '../config/config.schema';
import { formatInvoice } from '../printing/formatters/invoice.formatter';
import { formatKitchenOrder } from '../printing/formatters/kitchen-order.formatter';
import { formatTestTicket } from '../printing/formatters/test-ticket.formatter';

const HOST = '127.0.0.1';
const PORT = 3088;

export interface LocalServerDependencies {
  version: string;
  configService: AppConfigService;
  logger: LoggerService;
  queueService: PrintQueueService;
  printerService: PrinterService;
  pairingTokenService: PairingTokenService;
}

export class LocalServer {
  private readonly app = express();
  private server: http.Server | null = null;

  constructor(private readonly dependencies: LocalServerDependencies) {
    this.configure();
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    await new Promise<void>((resolve) => {
      this.server = this.app.listen(PORT, HOST, () => {
        this.dependencies.logger.info('Servidor local iniciado.', {
          host: HOST,
          port: PORT,
        });
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    const currentServer = this.server;
    this.server = null;

    await new Promise<void>((resolve, reject) => {
      currentServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  private configure(): void {
    this.app.disable('x-powered-by');
    this.app.use(express.json({ limit: '1mb' }));
    this.app.use(cors(createCorsOptions(this.dependencies.configService)));

    this.app.get('/health', async (_request, response) => {
      const config = this.dependencies.configService.getConfig();
      const printerModuleStatus = await this.dependencies.printerService.getModuleStatus();
      const payload: AgentHealthResponse = {
        status: 'ok',
        app: 'Gestion Al Dia Print Agent',
        version: this.dependencies.version,
        platform: process.platform,
        pairingRequired: config.pairingToken !== null,
        configured: Boolean(config.invoicePrinterName || config.kitchenPrinterName),
        printerModuleReady: printerModuleStatus.ready,
        printerModuleError: printerModuleStatus.error,
      };

      response.json(payload);
    });

    this.app.use((request, response, next) => this.requireAuthorizedRequest(request, response, next));

    this.app.get('/printers', async (_request, response, next) => {
      try {
        response.json({
          printers: await this.dependencies.printerService.listPrinters(),
        });
      } catch (error) {
        next(error);
      }
    });

    this.app.get('/config', (_request, response) => {
      response.json({
        config: this.dependencies.configService.getConfig(),
      });
    });

    this.app.post('/config', (request, response, next) => {
      try {
        const currentConfig = this.dependencies.configService.getConfig();
        const candidateConfig = {
          ...currentConfig,
          ...request.body,
          invoicePrinterName: normalizeNullableString(request.body?.invoicePrinterName, currentConfig.invoicePrinterName),
          kitchenPrinterName: normalizeNullableString(request.body?.kitchenPrinterName, currentConfig.kitchenPrinterName),
          pairingToken: normalizeNullableString(request.body?.pairingToken, currentConfig.pairingToken),
          allowedOrigins: Array.isArray(request.body?.allowedOrigins)
            ? request.body.allowedOrigins
            : currentConfig.allowedOrigins,
        };
        const nextConfig = sanitizeAppConfig(candidateConfig);
        response.json({
          success: true,
          message: 'Configuracion local actualizada.',
          config: this.dependencies.configService.saveConfig(nextConfig),
        });
      } catch (error) {
        next(error);
      }
    });

    this.app.post('/config/reveal', async (_request, response, next) => {
      try {
        await shell.showItemInFolder(this.dependencies.configService.getConfigPath());
        this.sendSuccess(response, 'Se abrio la carpeta de configuracion del agente.');
      } catch (error) {
        next(error);
      }
    });

    this.app.post('/print/test', async (_request, response, next) => {
      try {
        const config = this.dependencies.configService.getConfig();
        const payload = buildTestPayload(config.paperWidth);
        const printerName = this.dependencies.printerService.resolvePrinterName('invoice');
        await this.enqueuePrint('ticket-de-prueba', printerName, formatTestTicket(payload));
        this.sendSuccess(response, 'Ticket de prueba enviado a la impresora configurada.');
      } catch (error) {
        next(error);
      }
    });

    this.app.post('/print/invoice', async (request, response, next) => {
      try {
        const config = this.dependencies.configService.getConfig();
        if (!config.invoiceEnabled) {
          throw new Error('La impresion de facturas esta desactivada en este equipo.');
        }

        const payload = request.body as ReceiptJobPayload;
        const copies = payload.options?.copies ?? config.invoiceCopies;
        const printerName = this.dependencies.printerService.resolvePrinterName('invoice');
        const buffer = formatInvoice({
          ...payload,
          options: {
            ...payload.options,
            copies,
            paperWidth: payload.options?.paperWidth ?? config.paperWidth,
          },
        });

        await this.enqueueCopies('factura', printerName, buffer, copies);
        this.sendSuccess(response, 'Factura enviada al agente local.');
      } catch (error) {
        next(error);
      }
    });

    this.app.post('/print/kitchen-order', async (request, response, next) => {
      try {
        const config = this.dependencies.configService.getConfig();
        if (!config.kitchenEnabled) {
          throw new Error('La impresion de comandas esta desactivada en este equipo.');
        }

        const payload = request.body as ReceiptJobPayload;
        const copies = payload.options?.copies ?? config.kitchenCopies;
        const printerName = this.dependencies.printerService.resolvePrinterName('kitchen');
        const buffer = formatKitchenOrder({
          ...payload,
          options: {
            ...payload.options,
            copies,
            paperWidth: payload.options?.paperWidth ?? config.paperWidth,
          },
        });

        await this.enqueueCopies('comanda-cocina', printerName, buffer, copies);
        this.sendSuccess(response, 'Comanda enviada al agente local.');
      } catch (error) {
        next(error);
      }
    });

    this.app.use(
      (
        error: unknown,
        _request: Request,
        response: Response<AgentMutationResponse>,
        _next: NextFunction,
      ) => {
        const message =
          error instanceof Error && error.message.trim()
            ? error.message
            : 'Ocurrio un error inesperado en el agente local.';
        this.dependencies.logger.error('Error en el servidor local.', error);
        response.status(400).json({
          success: false,
          message,
        });
      },
    );
  }

  private requireAuthorizedRequest(
    request: Request,
    response: Response<AgentMutationResponse>,
    next: NextFunction,
  ): void {
    const expectedToken = this.dependencies.configService.getConfig().pairingToken;

    if (!expectedToken) {
      next();
      return;
    }

    const authorizationHeader = request.header('authorization');
    const bearerToken =
      authorizationHeader?.toLowerCase().startsWith('bearer ') === true
        ? authorizationHeader.slice(7).trim()
        : null;
    const token =
      request.header('x-gestion-print-token')?.trim() ??
      request.header('x-gad-print-token')?.trim() ??
      bearerToken;

    if (this.dependencies.pairingTokenService.matches(expectedToken, token ?? null)) {
      next();
      return;
    }

    response.status(401).json({
      success: false,
      message: 'Token local invalido. Vuelve a emparejar el agente con Gestion al Dia.',
    });
  }

  private async enqueuePrint(
    label: string,
    printerName: string,
    buffer: Buffer,
  ): Promise<void> {
    await this.dependencies.queueService.enqueue(label, async () => {
      await this.dependencies.printerService.printRaw(printerName, label, buffer);
    });
  }

  private async enqueueCopies(
    label: string,
    printerName: string,
    buffer: Buffer,
    copies: number,
  ): Promise<void> {
    for (let index = 0; index < Math.max(1, Math.trunc(copies)); index += 1) {
      const currentLabel = copies > 1 ? `${label}-${index + 1}` : label;
      await this.enqueuePrint(currentLabel, printerName, buffer);
    }
  }

  private sendSuccess(response: Response<AgentMutationResponse>, message: string): void {
    response.json({
      success: true,
      message,
    });
  }
}

function buildTestPayload(paperWidth: '58mm' | '80mm'): ReceiptJobPayload {
  return {
    business: {
      name: 'Gestion al Dia',
      nit: '900123456-7',
      address: 'Prueba local del agente',
      phone: '3000000000',
    },
    order: {
      id: 'TEST-001',
      createdAt: new Date().toLocaleString('es-CO'),
      tableName: 'Mesa 1',
      waiterName: 'Sistema',
    },
    items: [
      {
        name: 'Validacion de impresion',
        quantity: 1,
        unitPrice: 0,
        total: 0,
        notes: 'Ticket generado desde el agente local',
      },
    ],
    totals: {
      subtotal: 0,
      tax: 0,
      discount: 0,
      total: 0,
      paid: 0,
      change: 0,
    },
    options: {
      copies: 1,
      cutPaper: true,
      openCashDrawer: false,
      paperWidth,
    },
  };
}

function normalizeNullableString(value: unknown, fallback: string | null): string | null {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmedValue = value.trim();
  return trimmedValue ? trimmedValue : null;
}
