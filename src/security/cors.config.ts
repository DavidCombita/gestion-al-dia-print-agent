import type { CorsOptions } from 'cors';
import { AppConfigService } from '../config/app-config.service';

export function createCorsOptions(configService: AppConfigService): CorsOptions {
  return {
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }

      const allowedOrigins = configService.getConfig().allowedOrigins;
      if (allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error('Origen no autorizado para Gestion al Dia Print Agent.'));
    },
    credentials: false,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Gestion-Print-Token'],
  };
}
