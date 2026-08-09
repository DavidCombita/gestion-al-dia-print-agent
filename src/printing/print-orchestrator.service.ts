import crypto from 'node:crypto';
import { LoggerService } from '../logs/logger.service';
import { PrintExecutionRequest } from './contracts/print-request';
import {
  PrintCopyResult,
  PrintExecutionResult,
  PrintExecutionResultStatus,
  PrintJobRecord,
} from './contracts/print-result';
import {
  PrintTerminalStatus,
  PrintTransportError,
  PrintTransportJobStatus,
  RetrySafety,
  SubmittedPrintJob,
} from './contracts/print-transport';
import { PrintFormatterRegistry } from './formatters/print-formatter.registry';
import { PrintHistoryService } from './history/print-history.service';
import { PrinterDiscoveryService } from './printers/printer-discovery.service';
import { PrinterProfileService } from './printers/printer-profile.service';
import {
  PrinterQueueBlockedError,
  PrinterQueueService,
} from './queue/printer-queue.service';
import { PrintTransportRegistry } from './transports/print-transport.registry';
import { SpoolJobMonitorService } from './windows/spool-job-monitor.service';

export interface PrintOrchestratorDependencies {
  formatterRegistry: PrintFormatterRegistry;
  profileService: PrinterProfileService;
  queueService: PrinterQueueService;
  historyService: PrintHistoryService;
  transportRegistry: PrintTransportRegistry;
  monitorService: SpoolJobMonitorService;
  printerDiscoveryService: PrinterDiscoveryService;
  logger: LoggerService;
}

export class PrintOrchestratorService {
  constructor(private readonly dependencies: PrintOrchestratorDependencies) {}

  async execute(request: PrintExecutionRequest): Promise<PrintExecutionResult> {
    const printerName = requirePrinterName(request.printerName);

    if (!(await this.dependencies.printerDiscoveryService.printerExists(printerName))) {
      throw new Error(`La impresora "${printerName}" no existe en Windows.`);
    }

    if (request.transportOverride && request.source !== 'DIAGNOSTIC') {
      throw new Error(
        'Solo las pruebas diagnosticas pueden seleccionar un transporte temporal.',
      );
    }

    const profile = this.dependencies.profileService.resolveProfile(
      printerName,
      request.paperWidth,
    );
    const transportType = request.transportOverride ?? profile.transport;
    const copies = normalizeCopies(request.copies ?? request.payload?.options?.copies);
    const records: PrintJobRecord[] = [];

    for (let copyNumber = 1; copyNumber <= copies; copyNumber += 1) {
      const documentName = buildDocumentName(request, copyNumber);
      const record = this.dependencies.historyService.createJob({
          backendJobId: request.backendJobId,
          printerName,
          documentName,
          jobType: request.jobType,
          copyNumber,
          copies,
          transport: transportType,
          retrySafety: 'SAFE_TO_RETRY',
        });
      records.push(record);
      this.logStage(record, 'PRINT_QUEUED', Date.now());
    }

    const attempts = await Promise.all(
      records.map((record) =>
        Promise.resolve()
          .then(() => this.enqueueAttempt(record, request, profile))
          .catch((error) => this.finalizeUnsubmittedFailure(record, error)),
      ),
    );

    return aggregateResult(printerName, transportType, copies, attempts);
  }

  async reconcilePendingJobs(): Promise<PrintCopyResult[]> {
    const records = this.dependencies.historyService.getRecoverableJobs();
    const results = await Promise.all(
      records.map(async (record) => {
        if (
          record.status === 'QUEUED' ||
          record.status === 'FORMATTING' ||
          record.status === 'READY'
        ) {
          return this.finalizeInterruptedBeforeSubmit(record);
        }

        if (!record.windowsJobId) {
          if (wasAcceptedWithoutJobId(record)) {
            return this.finalizeAcceptedWithoutJobId(record).result;
          }

          const result = this.finalizeInterruptedSubmit(record);
          this.blockPrinter(record, result);
          return result;
        }

        const submittedJob = toSubmittedJob(record);
        const transport = this.dependencies.transportRegistry.get(record.transport);
        const startedAt = Date.now();
        const status = await this.dependencies.monitorService.monitor(
          submittedJob,
          transport,
          {
            previouslyObserved: record.windowsJobObserved,
            onStatus: (snapshot, elapsedMs) => {
              this.persistWindowsStatus(record, snapshot, elapsedMs);
            },
          },
        );
        const result = this.finalizeObservedResult(record, submittedJob, status, startedAt);

        if (result.status === 'STUCK' || result.status === 'UNKNOWN') {
          this.blockPrinter(record, result);
        }

        this.logStage(record, 'PRINT_RECOVERED_AFTER_RESTART', startedAt, {
          status: result.status,
          windowsJobId: result.systemJobId,
        });
        return result;
      }),
    );

    return results;
  }

  private finalizeInterruptedBeforeSubmit(record: PrintJobRecord): PrintCopyResult {
    const completedAt = new Date().toISOString();
    const result: PrintCopyResult = {
      localJobId: record.localJobId,
      attemptId: record.attemptId,
      copyNumber: record.copyNumber,
      status: 'FAILED',
      retrySafety: 'SAFE_TO_RETRY',
      submitted: false,
      printerName: record.printerName,
      documentName: record.documentName,
      transport: record.transport,
      completedAt,
      errorCode: 'AGENT_RESTARTED_BEFORE_SUBMIT',
      errorMessage:
        'El agente se reinicio antes de que Windows aceptara este trabajo.',
      elapsedMs: 0,
    };
    this.dependencies.historyService.updateJob(record.localJobId, {
      status: result.status,
      completedAt,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
      retrySafety: result.retrySafety,
    });
    this.logStage(record, 'PRINT_FAILED_AFTER_RESTART', Date.now(), {
      errorCode: result.errorCode,
      retrySafety: result.retrySafety,
    });
    return result;
  }

  private finalizeInterruptedSubmit(record: PrintJobRecord): PrintCopyResult {
    const completedAt = new Date().toISOString();
    const result: PrintCopyResult = {
      localJobId: record.localJobId,
      attemptId: record.attemptId,
      copyNumber: record.copyNumber,
      status: 'UNKNOWN',
      retrySafety: 'UNSAFE_TO_RETRY',
      submitted: true,
      printerName: record.printerName,
      documentName: record.documentName,
      transport: record.transport,
      completedAt,
      errorCode: 'AGENT_RESTARTED_DURING_SUBMIT',
      errorMessage:
        'El agente se reinicio durante el submit y no conservo un Windows JobId. No es seguro reintentar.',
      elapsedMs: 0,
    };
    this.dependencies.historyService.updateJob(record.localJobId, {
      status: result.status,
      completedAt,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
      retrySafety: result.retrySafety,
    });
    this.logStage(record, 'PRINT_UNKNOWN_AFTER_RESTART', Date.now(), {
      errorCode: result.errorCode,
      retrySafety: result.retrySafety,
    });
    return result;
  }

  private finalizeAcceptedWithoutJobId(record: PrintJobRecord): {
    record: PrintJobRecord;
    result: PrintCopyResult;
  } {
    const completedAt = new Date().toISOString();
    const errorCode = 'WINDOWS_JOB_ID_UNAVAILABLE_ACCEPTED';
    const errorMessage =
      'Windows acepto el trabajo, pero no entrego un JobId para seguirlo. El agente lo da por completado y continua.';
    const result: PrintCopyResult = {
      localJobId: record.localJobId,
      attemptId: record.attemptId,
      copyNumber: record.copyNumber,
      status: 'SPOOL_COMPLETED',
      retrySafety: 'UNSAFE_TO_RETRY',
      submitted: true,
      printerName: record.printerName,
      documentName: record.documentName,
      transport: record.transport,
      submittedAt: record.submittedAt ?? record.updatedAt,
      completedAt,
      payloadBytes: record.payloadBytes,
      errorCode,
      errorMessage,
      elapsedMs: record.elapsedMs ?? 0,
    };
    const updated = this.dependencies.historyService.updateJob(record.localJobId, {
      status: result.status,
      completedAt,
      errorCode,
      errorMessage,
      retrySafety: result.retrySafety,
    });
    this.dependencies.queueService.unblockPrinterIfBlockedBy(
      record.printerName,
      record.localJobId,
    );
    this.logStage(record, 'WINDOWS_JOB_ACCEPTED_WITHOUT_JOB_ID', Date.now(), {
      status: result.status,
      errorCode,
    });
    return { record: updated, result };
  }

  async cancelJob(localJobId: string): Promise<PrintJobRecord> {
    const record = this.dependencies.historyService.getJob(localJobId);

    if (!record) {
      throw new Error(`No existe el trabajo local ${localJobId}.`);
    }

    if (!record.windowsJobId) {
      throw new Error('El trabajo no tiene Windows JobId y no se puede cancelar de forma segura.');
    }

    const transport = this.dependencies.transportRegistry.get(record.transport);

    if (!transport.cancel) {
      throw new Error(`El transporte ${record.transport} no permite cancelar por JobId.`);
    }

    const submittedJob = toSubmittedJob(record);
    await transport.cancel(submittedJob);
    const cancellationDeadline = Date.now() + 10_000;

    while (Date.now() <= cancellationDeadline) {
      const status = await transport.getJobStatus(submittedJob);

      if (status.exists === false || status.state === 'CANCELLED') {
        const updated = this.dependencies.historyService.updateJob(localJobId, {
          status: 'CANCELLED',
          completedAt: new Date().toISOString(),
          errorCode: undefined,
          errorMessage: undefined,
          retrySafety: 'SAFE_TO_RETRY',
        });
        this.dependencies.queueService.unblockPrinterIfBlockedBy(
          record.printerName,
          record.localJobId,
        );
        return updated;
      }

      await wait(500);
    }

    this.dependencies.historyService.updateJob(localJobId, {
      status: 'STUCK',
      errorCode: 'WINDOWS_JOB_DELETE_UNCONFIRMED',
      errorMessage:
        'Windows acepto la orden de eliminar, pero el trabajo sigue visible.',
      retrySafety: 'UNSAFE_TO_RETRY',
    });
    throw new Error('No fue posible confirmar la eliminacion del trabajo en Windows.');
  }

  unblockPrinter(printerName: string): void {
    this.dependencies.queueService.unblockPrinter(requirePrinterName(printerName));
  }

  async preparePrinterForManualTest(printerName: string): Promise<void> {
    const normalizedPrinterName = requirePrinterName(printerName);
    const queue = this.dependencies.queueService.getPrinterSnapshot(
      normalizedPrinterName,
    );

    if (queue.health !== 'BLOCKED') {
      return;
    }

    const blockingJobId = queue.blockedByLocalJobId;
    if (!blockingJobId) {
      this.dependencies.queueService.unblockPrinter(normalizedPrinterName);
      return;
    }

    let refreshError: unknown;

    try {
      await this.refreshJobStatus(blockingJobId);
      if (!this.dependencies.queueService.isBlocked(normalizedPrinterName)) {
        return;
      }
    } catch (error) {
      refreshError = error;
    }

    const blockingJob = this.dependencies.historyService.getJob(blockingJobId);
    if (!blockingJob?.windowsJobId) {
      this.dependencies.queueService.unblockPrinter(normalizedPrinterName);
      return;
    }

    try {
      await this.cancelJob(blockingJobId);
    } catch (cancelError) {
      const refreshDetail = refreshError
        ? ` Consulta previa: ${describeError(refreshError)}`
        : '';
      throw new Error(
        `No fue posible liberar el Windows JobId ${blockingJob.windowsJobId} antes de la prueba. ${describeError(cancelError)}${refreshDetail}`,
      );
    }
  }

  async refreshJobStatus(localJobId: string): Promise<PrintJobRecord> {
    const record = this.dependencies.historyService.getJob(localJobId);

    if (!record) {
      throw new Error(`No existe el trabajo local ${localJobId}.`);
    }

    if (!record.windowsJobId) {
      if (wasAcceptedWithoutJobId(record)) {
        return this.finalizeAcceptedWithoutJobId(record).record;
      }

      throw new Error('El trabajo no tiene Windows JobId para consultar.');
    }

    const transport = this.dependencies.transportRegistry.get(record.transport);
    const snapshot = await transport.getJobStatus(toSubmittedJob(record));
    const observed = record.windowsJobObserved === true || snapshot.observed;
    let nextStatus = snapshot.state;
    let errorCode = snapshot.code;
    let errorMessage = snapshot.message;

    if (snapshot.exists === false) {
      nextStatus = observed ? 'SPOOL_COMPLETED' : 'UNKNOWN';
      errorCode = observed
        ? 'WINDOWS_JOB_DISAPPEARED_AFTER_OBSERVATION'
        : 'WINDOWS_JOB_NOT_FOUND_WITHOUT_OBSERVATION';
      errorMessage = observed
        ? 'Windows dejo de mostrar el trabajo despues de haber sido observado.'
        : 'Windows no muestra el trabajo y no existe evidencia de que haya sido observado.';
    } else if (
      (record.status === 'STUCK' || record.status === 'UNKNOWN') &&
      (snapshot.state === 'SUBMITTED' ||
        snapshot.state === 'SPOOLING' ||
        snapshot.state === 'PRINTING')
    ) {
      nextStatus = record.status;
    }

    const isTerminal =
      nextStatus === 'SPOOL_COMPLETED' ||
      nextStatus === 'FAILED' ||
      nextStatus === 'STUCK' ||
      nextStatus === 'CANCELLED' ||
      nextStatus === 'UNKNOWN';
    const updated = this.dependencies.historyService.updateJob(localJobId, {
      status: nextStatus,
      completedAt: isTerminal ? new Date().toISOString() : record.completedAt,
      lastWindowsStatus: snapshot.windowsStatusLabels,
      lastWindowsStatusNumber: snapshot.windowsStatusNumber,
      windowsJobObserved: observed,
      errorCode,
      errorMessage,
      retrySafety: snapshot.retrySafety,
    });

    if (nextStatus === 'STUCK' || nextStatus === 'UNKNOWN') {
      this.blockPrinter(record, {
        status: nextStatus,
        errorMessage,
      });
    } else if (nextStatus === 'SPOOL_COMPLETED' || nextStatus === 'CANCELLED') {
      this.dependencies.queueService.unblockPrinterIfBlockedBy(
        record.printerName,
        record.localJobId,
      );
    }

    this.logStage(record, 'WINDOWS_STATUS_REFRESHED', Date.now(), {
      windowsJobId: record.windowsJobId,
      windowsStatus: snapshot.windowsStatusLabels,
      windowsStatusNumber: snapshot.windowsStatusNumber,
      status: nextStatus,
    });
    return updated;
  }

  private enqueueAttempt(
    record: PrintJobRecord,
    request: PrintExecutionRequest,
    profile: ReturnType<PrinterProfileService['resolveProfile']>,
  ): Promise<PrintCopyResult> {
    return this.dependencies.queueService.enqueue(
      record.printerName,
      record.documentName,
      () => this.executeAttempt(record, request, profile),
    );
  }

  private async executeAttempt(
    record: PrintJobRecord,
    request: PrintExecutionRequest,
    profile: ReturnType<PrinterProfileService['resolveProfile']>,
  ): Promise<PrintCopyResult> {
    const startedAt = Date.now();
    const transport = this.dependencies.transportRegistry.get(record.transport);
    let submittedJob: SubmittedPrintJob | null = null;

    try {
      this.transition(record, 'FORMATTING');
      const document = this.dependencies.formatterRegistry.format(
        request.jobType,
        request.payload,
        request.preparedDocument,
        profile,
        record.transport,
        record.documentName,
      );
      this.dependencies.historyService.updateJob(record.localJobId, {
        status: 'READY',
        payloadBytes: document.payloadBytes,
        payloadHash: document.payloadHash,
      });
      this.logStage(record, 'PRINT_FORMATTED', startedAt, {
        payloadBytes: document.payloadBytes,
        payloadHash: document.payloadHash,
      });

      this.transition(record, 'SUBMITTING');
      this.logStage(record, 'PRINT_SUBMIT_STARTED', startedAt);
      const acceptedJob = await transport.submit({
        printer: {
          systemName: record.printerName,
          displayName: request.displayPrinterName,
        },
        documentName: record.documentName,
        rawData: document.rawData,
        html: document.html,
        payloadBytes: document.payloadBytes,
        driverOptions: profile.driver,
      });
      submittedJob = acceptedJob;
      this.dependencies.historyService.updateJob(record.localJobId, {
        status: 'SUBMITTED',
        windowsJobId: acceptedJob.systemJobId,
        submittedAt: acceptedJob.submittedAt,
        payloadBytes: acceptedJob.payloadBytes,
        retrySafety: 'UNSAFE_TO_RETRY',
      });
      this.logStage(record, 'WINDOWS_JOB_CREATED', startedAt, {
        windowsJobId: acceptedJob.systemJobId,
        payloadBytes: acceptedJob.payloadBytes,
      });

      const status = await this.dependencies.monitorService.monitor(
        acceptedJob,
        transport,
        {
          onStatus: (snapshot, elapsedMs) => {
            this.persistWindowsStatus(record, snapshot, elapsedMs);
            this.logStage(record, 'WINDOWS_STATUS_CHANGED', startedAt, {
              windowsJobId: acceptedJob.systemJobId,
              windowsStatus: snapshot.windowsStatusLabels,
              windowsStatusNumber: snapshot.windowsStatusNumber,
              status: snapshot.state,
            });
          },
        },
      );
      const result = this.finalizeObservedResult(
        record,
        acceptedJob,
        status,
        startedAt,
      );

      if (result.status === 'STUCK' || result.status === 'UNKNOWN') {
        this.blockPrinter(record, result);
      }

      return result;
    } catch (error) {
      const transportError = error instanceof PrintTransportError ? error : null;
      const acceptedByWindows =
        submittedJob !== null || transportError?.acceptedByWindows === true;
      const status: PrintTerminalStatus = acceptedByWindows ? 'UNKNOWN' : 'FAILED';
      const retrySafety: RetrySafety =
        transportError?.retrySafety ??
        (acceptedByWindows ? 'UNSAFE_TO_RETRY' : 'SAFE_TO_RETRY');
      const errorCode = transportError?.code ?? mapExecutionError(error);
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.dependencies.historyService.updateJob(record.localJobId, {
        status,
        windowsJobId: submittedJob?.systemJobId,
        submittedAt: submittedJob?.submittedAt,
        payloadBytes: submittedJob?.payloadBytes,
        completedAt: new Date().toISOString(),
        errorCode,
        errorMessage,
        elapsedMs: Date.now() - startedAt,
        retrySafety,
      });
      const result: PrintCopyResult = {
        localJobId: record.localJobId,
        attemptId: record.attemptId,
        copyNumber: record.copyNumber,
        status,
        retrySafety,
        submitted: acceptedByWindows,
        printerName: record.printerName,
        documentName: record.documentName,
        transport: record.transport,
        systemJobId: submittedJob?.systemJobId,
        submittedAt: submittedJob?.submittedAt,
        payloadBytes: submittedJob?.payloadBytes,
        completedAt: new Date().toISOString(),
        errorCode,
        errorMessage,
        elapsedMs: Date.now() - startedAt,
      };

      if (status === 'UNKNOWN') {
        this.blockPrinter(record, result);
      }

      this.logStage(record, status === 'UNKNOWN' ? 'PRINT_UNKNOWN' : 'PRINT_FAILED', startedAt, {
        errorCode,
        errorMessage,
        retrySafety,
      });
      return result;
    }
  }

  private finalizeObservedResult(
    record: PrintJobRecord,
    submittedJob: SubmittedPrintJob,
    status: PrintTransportJobStatus,
    startedAt: number,
  ): PrintCopyResult {
    const terminalStatus = asTerminalStatus(status.state);
    const completedAt = new Date().toISOString();
    const elapsedMs = Date.now() - startedAt;
    this.dependencies.historyService.updateJob(record.localJobId, {
      status: terminalStatus,
      completedAt,
      windowsJobId: submittedJob.systemJobId,
      lastWindowsStatus: status.windowsStatusLabels,
      lastWindowsStatusNumber: status.windowsStatusNumber,
      windowsJobObserved: status.observed,
      errorCode: status.code,
      errorMessage: status.message,
      elapsedMs,
      retrySafety: status.retrySafety,
    });
    this.logStage(
      record,
      terminalStatus === 'SPOOL_COMPLETED'
        ? 'WINDOWS_JOB_COMPLETED'
        : terminalStatus === 'STUCK'
          ? 'PRINT_STUCK'
          : terminalStatus === 'UNKNOWN'
            ? 'PRINT_UNKNOWN'
            : terminalStatus === 'CANCELLED'
              ? 'PRINT_CANCELLED'
              : 'PRINT_FAILED',
      startedAt,
      {
        windowsJobId: submittedJob.systemJobId,
        windowsStatus: status.windowsStatusLabels,
        windowsStatusNumber: status.windowsStatusNumber,
        errorCode: status.code,
      },
    );

    return {
      localJobId: record.localJobId,
      attemptId: record.attemptId,
      copyNumber: record.copyNumber,
      status: terminalStatus,
      retrySafety: status.retrySafety,
      submitted: true,
      printerName: record.printerName,
      documentName: record.documentName,
      transport: record.transport,
      systemJobId: submittedJob.systemJobId,
      submittedAt: submittedJob.submittedAt,
      completedAt,
      payloadBytes: submittedJob.payloadBytes,
      errorCode: status.code,
      errorMessage: status.message,
      lastWindowsStatus: status.windowsStatusLabels,
      lastWindowsStatusNumber: status.windowsStatusNumber,
      elapsedMs,
    };
  }

  private finalizeUnsubmittedFailure(
    record: PrintJobRecord,
    error: unknown,
  ): PrintCopyResult {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorCode =
      error instanceof PrinterQueueBlockedError
        ? 'PRINTER_CIRCUIT_OPEN'
        : mapExecutionError(error);
    const completedAt = new Date().toISOString();
    this.dependencies.historyService.updateJob(record.localJobId, {
      status: 'FAILED',
      completedAt,
      errorCode,
      errorMessage,
      retrySafety: 'SAFE_TO_RETRY',
    });
    this.logStage(record, 'PRINT_FAILED', Date.now(), {
      errorCode,
      errorMessage,
      retrySafety: 'SAFE_TO_RETRY',
    });

    return {
      localJobId: record.localJobId,
      attemptId: record.attemptId,
      copyNumber: record.copyNumber,
      status: 'FAILED',
      retrySafety: 'SAFE_TO_RETRY',
      submitted: false,
      printerName: record.printerName,
      documentName: record.documentName,
      transport: record.transport,
      completedAt,
      errorCode,
      errorMessage,
      elapsedMs: 0,
    };
  }

  private persistWindowsStatus(
    record: PrintJobRecord,
    status: PrintTransportJobStatus,
    elapsedMs: number,
  ): void {
    this.dependencies.historyService.updateJob(record.localJobId, {
      status: status.state,
      lastWindowsStatus: status.windowsStatusLabels,
      lastWindowsStatusNumber: status.windowsStatusNumber,
      windowsJobObserved: status.observed,
      errorCode: status.code,
      errorMessage: status.message,
      elapsedMs,
      retrySafety: status.retrySafety,
    });
  }

  private transition(record: PrintJobRecord, status: PrintJobRecord['status']): void {
    this.dependencies.historyService.updateJob(record.localJobId, { status });
    this.logStage(record, `PRINT_${status}`, Date.now());
  }

  private blockPrinter(record: PrintJobRecord, result: Pick<PrintCopyResult, 'status' | 'errorMessage'>): void {
    const reason =
      result.errorMessage ??
      `La impresora ${record.printerName} tiene el trabajo ${record.documentName} en estado ${result.status}. No se enviaran nuevos trabajos automaticamente para evitar duplicados.`;
    this.dependencies.queueService.blockPrinter(
      record.printerName,
      record.localJobId,
      reason,
    );
  }

  private logStage(
    record: PrintJobRecord,
    stage: string,
    startedAt: number,
    metadata: Record<string, unknown> = {},
  ): void {
    this.dependencies.logger.info(stage, {
      backendJobId: record.backendJobId,
      localJobId: record.localJobId,
      attemptId: record.attemptId,
      copyNumber: record.copyNumber,
      printerName: record.printerName,
      transport: record.transport,
      documentName: record.documentName,
      windowsJobId: record.windowsJobId,
      stage,
      elapsedMs: Math.max(0, Date.now() - startedAt),
      ...metadata,
    });
  }
}

function aggregateResult(
  printerName: string,
  transport: PrintExecutionResult['transport'],
  copies: number,
  attempts: PrintCopyResult[],
): PrintExecutionResult {
  const status = resolveAggregateStatus(attempts);
  return {
    status,
    retrySafety: attempts.every(
      (attempt) => attempt.retrySafety === 'SAFE_TO_RETRY',
    )
      ? 'SAFE_TO_RETRY'
      : 'UNSAFE_TO_RETRY',
    printerName,
    transport,
    copies,
    attempts,
  };
}

function resolveAggregateStatus(
  attempts: PrintCopyResult[],
): PrintExecutionResultStatus {
  const statuses = new Set(attempts.map((attempt) => attempt.status));

  if (statuses.size === 1) {
    return attempts[0]?.status ?? 'UNKNOWN';
  }

  if (statuses.has('SPOOL_COMPLETED')) {
    return 'PARTIAL_FAILURE';
  }

  if (statuses.has('STUCK')) {
    return 'STUCK';
  }

  if (statuses.has('UNKNOWN')) {
    return 'UNKNOWN';
  }

  if (statuses.has('FAILED')) {
    return 'FAILED';
  }

  return 'PARTIAL_FAILURE';
}

function asTerminalStatus(value: PrintTransportJobStatus['state']): PrintTerminalStatus {
  if (
    value === 'SPOOL_COMPLETED' ||
    value === 'FAILED' ||
    value === 'STUCK' ||
    value === 'CANCELLED' ||
    value === 'UNKNOWN'
  ) {
    return value;
  }

  return 'UNKNOWN';
}

function toSubmittedJob(record: PrintJobRecord): SubmittedPrintJob {
  return {
    transport: record.transport,
    printerName: record.printerName,
    documentName: record.documentName,
    systemJobId: record.windowsJobId,
    submittedAt: record.submittedAt ?? record.updatedAt,
    payloadBytes: record.payloadBytes,
  };
}

function wasAcceptedWithoutJobId(record: PrintJobRecord): boolean {
  return (
    Boolean(record.submittedAt) ||
    record.status === 'SUBMITTED' ||
    record.status === 'SPOOLING' ||
    record.status === 'PRINTING'
  );
}

function buildDocumentName(request: PrintExecutionRequest, copyNumber: number): string {
  const base = request.documentName?.trim() || request.jobType;
  const correlation = request.backendJobId?.trim() || crypto.randomUUID().slice(0, 8);
  return sanitizeDocumentName(`GAD-${base}-${correlation}-${copyNumber}`);
}

function sanitizeDocumentName(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function requirePrinterName(value: string): string {
  const normalized = value.trim();

  if (!normalized) {
    throw new Error('El system name de la impresora es obligatorio.');
  }

  return normalized;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeCopies(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 1;
  }

  return Math.min(5, Math.max(1, Math.trunc(value)));
}

function mapExecutionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (/no existe|not found/i.test(message)) {
    return 'PRINTER_NOT_FOUND';
  }

  if (/bloquead|circuit/i.test(message)) {
    return 'PRINTER_CIRCUIT_OPEN';
  }

  if (/limite|backpressure/i.test(message)) {
    return 'PRINTER_QUEUE_FULL';
  }

  return 'PRINT_EXECUTION_FAILED';
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, milliseconds);
    timeout.unref?.();
  });
}
