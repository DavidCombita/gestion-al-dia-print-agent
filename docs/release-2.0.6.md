# Gestion al Dia Print Agent 2.0.6

## Problema corregido

El agente 2.0.5 intentaba interpretar como JSON todas las respuestas exitosas del backend. Cuando `GET /print-jobs/next-pending` respondia `200` sin cuerpo para indicar que no habia trabajos pendientes, `response.json()` generaba `SyntaxError: Unexpected end of JSON input` en cada ciclo de polling.

El mensaje aparecia despues de enviar una factura y podia confundirse con un error del payload o de la impresora, aunque el trabajo ya hubiera quedado completado en el spooler de Windows.

## Comportamiento en 2.0.6

- Una respuesta vacia de `next-pending` se interpreta como `null`: no hay trabajo pendiente.
- Heartbeats y confirmaciones de estado aceptan respuestas exitosas sin cuerpo.
- Un cuerpo JSON incompleto en una operacion ya confirmada no provoca una segunda impresion fisica.
- Las respuestas que deben contener datos, como registro, pairing, claim o sincronizacion de impresoras, siguen siendo estrictas.
- Los JSON invalidos se registran con endpoint, estado HTTP, tipo de contenido y cantidad de bytes, sin guardar el contenido sensible de la respuesta.
- Los errores reales de red, como `fetch failed`, siguen reportandose y se reintentan mediante el polling y heartbeat existentes.

## Verificacion

La suite cubre:

1. polling exitoso con cuerpo vacio;
2. rechazo de respuestas vacias cuando el JSON es obligatorio;
3. confirmaciones con JSON incompleto;
4. una sola impresion fisica cuando `/printing` y `/printed` responden sin cuerpo;
5. autenticacion 401/403, pairing y reconexion por WebSocket.

Comando de validacion:

```bash
npm test
```

## Publicacion

1. Confirmar que `package.json` y `package-lock.json` indiquen `2.0.6`.
2. Ejecutar `npm test`.
3. Crear y empujar el tag `v2.0.6` o ejecutar manualmente el workflow `Release Print Agent`.
4. Verificar que la release contenga el instalador, `latest.yml` y el archivo `.blockmap`.
5. Instalar o actualizar el agente de Patio Bolivar y comprobar que, sin trabajos pendientes, el log ya no repita `Unexpected end of JSON input`.
