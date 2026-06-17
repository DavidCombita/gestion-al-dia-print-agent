import type { CorsOptions } from 'cors';
import { AppConfigService } from '../config/app-config.service';

const LOCAL_AGENT_ALLOWED_ORIGINS = new Set([
  'http://127.0.0.1:3088',
  'http://localhost:3088',
]);

export function createCorsOptions(configService: AppConfigService): CorsOptions {
  return {
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }

      if (LOCAL_AGENT_ALLOWED_ORIGINS.has(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error('Solicitud local no autorizada. Reinicia el agente de impresión e intenta nuevamente.'));
    },
    credentials: false,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Gestion-Print-Token',
      'X-GAD-Print-Token',
    ],
  };
}
