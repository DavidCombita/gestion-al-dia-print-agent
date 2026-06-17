import type { CorsOptions } from 'cors';

export const LOCAL_AGENT_ALLOWED_ORIGINS = new Set([
  'http://127.0.0.1:3088',
  'http://localhost:3088',
]);

export const OFFICIAL_WEB_ALLOWED_ORIGINS = new Set([
  'https://aldia-co.com',
  'https://www.aldia-co.com',
]);

const ALLOWED_AGENT_ORIGINS = new Set([
  ...LOCAL_AGENT_ALLOWED_ORIGINS,
  ...OFFICIAL_WEB_ALLOWED_ORIGINS,
]);

export const AGENT_CORS_ERROR_MESSAGE =
  'Solicitud no autorizada para el agente local. Verifica que estés usando Gestión al Día desde el dominio oficial.';

export function isAllowedAgentOrigin(origin: string | undefined | null): boolean {
  return typeof origin === 'string' && ALLOWED_AGENT_ORIGINS.has(origin);
}

export function isOfficialWebAgentOrigin(origin: string | undefined | null): boolean {
  return typeof origin === 'string' && OFFICIAL_WEB_ALLOWED_ORIGINS.has(origin);
}

export function createCorsOptions(): CorsOptions {
  return {
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }

      if (isAllowedAgentOrigin(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error(AGENT_CORS_ERROR_MESSAGE));
    },
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Agent-App',
      'X-Agent-Version',
      'X-Gestion-Print-Token',
      'X-GAD-Print-Token',
    ],
  };
}
