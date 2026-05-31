declare module 'electron' {
  export const app: {
    getVersion(): string;
    getPath(name: string): string;
    whenReady(): Promise<void>;
    setLoginItemSettings(settings: { openAtLogin: boolean; args?: string[] }): void;
    on(event: string, listener: (...args: any[]) => void): void;
    quit(): void;
  };

  export class Tray {
    constructor(image: any);
    setToolTip(text: string): void;
    setContextMenu(menu: any): void;
    displayBalloon?(options: { title: string; content: string }): void;
  }

  export const Menu: {
    buildFromTemplate(template: Array<Record<string, unknown>>): any;
  };

  export const nativeImage: {
    createFromDataURL(dataUrl: string): any;
  };

  export const shell: {
    showItemInFolder(fullPath: string): Promise<void>;
  };
}

declare module 'electron-log/main' {
  const log: {
    initialize(): void;
    transports: {
      file: {
        level: string;
        resolvePathFn: () => string;
      };
    };
    info(message: string, ...rest: any[]): void;
    warn(message: string, ...rest: any[]): void;
    error(message: string, ...rest: any[]): void;
  };

  export default log;
}

declare module 'printer' {
  const printer: {
    getPrinters(): Array<{ name: string; isDefault?: boolean; status?: string }>;
    printDirect(options: {
      data: Buffer;
      type: 'RAW';
      printer: string;
      docname: string;
      success: () => void;
      error: (error: unknown) => void;
    }): void;
  };

  export = printer;
}

declare module 'cors' {
  type CorsMiddleware = (request: any, response: any, next: (error?: unknown) => void) => void;

  interface CorsOptions {
    origin?:
      | boolean
      | string
      | string[]
      | ((origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) => void);
    credentials?: boolean;
    methods?: string[];
    allowedHeaders?: string[];
  }

  function cors(options?: CorsOptions): CorsMiddleware;

  export type { CorsOptions };
  export default cors;
}
