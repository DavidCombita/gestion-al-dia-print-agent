import fs from 'node:fs';
import path from 'node:path';
import { AppConfig, defaultAppConfig, sanitizeAppConfig } from './config.schema';
import { LoggerService } from '../logs/logger.service';

export class AppConfigService {
  private readonly configPath: string;
  private configCache: AppConfig;

  constructor(
    basePath: string,
    private readonly logger: LoggerService,
  ) {
    fs.mkdirSync(basePath, { recursive: true });
    this.configPath = path.join(basePath, 'config.json');
    this.configCache = this.loadFromDisk();
  }

  getConfig(): AppConfig {
    return this.configCache;
  }

  saveConfig(nextConfig: Partial<AppConfig>): AppConfig {
    const parsedConfig = sanitizeAppConfig({
      ...this.configCache,
      ...nextConfig,
      allowedOrigins:
        nextConfig.allowedOrigins
          ?.filter((origin: string) => origin.trim().length > 0) ??
        this.configCache.allowedOrigins,
    });
    this.configCache = parsedConfig;
    fs.writeFileSync(this.configPath, `${JSON.stringify(parsedConfig, null, 2)}\n`, 'utf8');
    this.logger.info('Configuracion local actualizada.', {
      configPath: this.configPath,
    });
    return parsedConfig;
  }

  getConfigPath(): string {
    return this.configPath;
  }

  private loadFromDisk(): AppConfig {
    if (!fs.existsSync(this.configPath)) {
      fs.writeFileSync(
        this.configPath,
        `${JSON.stringify(defaultAppConfig, null, 2)}\n`,
        'utf8',
      );
      return defaultAppConfig;
    }

    try {
      const rawConfig = fs.readFileSync(this.configPath, 'utf8');
      return sanitizeAppConfig(JSON.parse(rawConfig));
    } catch (error) {
      this.logger.warn('No fue posible leer la configuracion existente. Se restauran valores por defecto.', error);
      fs.writeFileSync(
        this.configPath,
        `${JSON.stringify(defaultAppConfig, null, 2)}\n`,
        'utf8',
      );
      return defaultAppConfig;
    }
  }
}
