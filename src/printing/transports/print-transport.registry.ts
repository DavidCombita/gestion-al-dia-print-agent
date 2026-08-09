import { PrintTransport } from '../contracts/print-transport';
import { PrintTransportType } from '../contracts/printer-profile';

export class PrintTransportRegistry {
  private readonly transports = new Map<PrintTransportType, PrintTransport>();

  constructor(transports: readonly PrintTransport[]) {
    for (const transport of transports) {
      if (this.transports.has(transport.type)) {
        throw new Error(`Transporte de impresion duplicado: ${transport.type}.`);
      }

      this.transports.set(transport.type, transport);
    }
  }

  get(type: PrintTransportType): PrintTransport {
    const transport = this.transports.get(type);

    if (!transport) {
      throw new Error(`No existe transporte de impresion para ${type}.`);
    }

    return transport;
  }

  async dispose(): Promise<void> {
    await Promise.all(
      Array.from(this.transports.values()).map((transport) =>
        Promise.resolve(transport.dispose?.()),
      ),
    );
  }
}

