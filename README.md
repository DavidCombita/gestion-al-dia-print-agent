# Gestion al Dia Print Agent

Agente local para Windows que permite a la app web de Gestion al Dia imprimir directamente hacia impresoras termicas instaladas en Windows por medio de `http://127.0.0.1:3088`, sin abrir el dialogo del navegador.

## Por que Electron para este caso

- `Electron + Node.js`: mejor equilibrio para un `.exe` instalable, arranque con Windows, bandeja del sistema, servidor local embebido y acceso a librerias de impresion.
- `Tauri`: mas liviano, pero la capa de integracion con impresion RAW/ESC-POS en Windows suele terminar en codigo Rust o plugins propios.
- `.NET`: muy bueno para Windows y spooler, pero aleja la base del stack Node/Angular del equipo actual.
- `Go`: excelente para un servicio liviano, aunque la experiencia de bandeja, autoupdate y tooling de instalacion suele requerir mas trabajo adicional.

## Endpoints

- `GET /health`
- `GET /printers`
- `GET /config`
- `GET /jobs`
- `GET /monitor`
- `POST /config`
- `POST /print/test`
- `POST /print/invoice`
- `POST /print/kitchen-order`

Todos escuchan solo en `127.0.0.1:3088`.

## Seguridad

- CORS restringido a `http://localhost:4200`, `http://127.0.0.1:4200`, `https://aldia-co.com` y `https://www.aldia-co.com` por defecto.
- Las llamadas desde la web publica hacia `127.0.0.1` responden el preflight de acceso local con `Access-Control-Allow-Private-Network: true`.
- Token local configurable por header `X-Gestion-Print-Token` o `Authorization: Bearer ...`.
- El token se guarda en el archivo local del agente para emparejar el navegador con el servicio.
- Si el navegador pierde su copia local del token, la app web autorizada puede recuperarlo de nuevo leyendo `GET /config` desde un origen permitido y seguir imprimiendo sin reemparejar manualmente.

## Configuracion local

El agente guarda un `config.json` en el directorio `userData` de Electron con:

- impresora de facturas
- impresora de comandas
- copias por tipo
- activacion de factura/comanda
- ancho de papel
- token de emparejamiento
- origenes CORS permitidos

Adicionalmente guarda un historial local `print-history.json` con los ultimos trabajos de impresion y su resultado.

## Monitor local

- Desde el icono de la bandeja puedes abrir `Ver historial de impresiones`.
- El monitor muestra el estado del servicio, la cola activa y los ultimos trabajos enviados.
- La vista local tambien queda disponible en `http://127.0.0.1:3088/monitor`.

## Flujo de build

1. Usa Node.js 22 en Windows.

2. Instala dependencias en Windows:

```bash
npm install
```

Si el proyecto sigue intentando resolver dependencias antiguas del modulo `printer`, puedes usar:

```bash
npm install --legacy-peer-deps
```

Despues de instalar, el proyecto aplica automaticamente un parche local sobre `printer` para corregir un error de compilacion en Windows/MSVC. Si necesitas ejecutarlo manualmente:

```bash
npm run patch:printer
```

3. Genera el ejecutable:

```bash
npm run dist:win
```

4. El instalador quedara en `release/`.

## Auto-actualizaciones

La base actual del agente ya es compatible con el objetivo correcto para Windows (`nsis`), que es el recomendado para actualizar con `electron-updater`.

Para dejarlo funcionando de extremo a extremo falta:

1. agregar `electron-updater` como dependencia de la app
2. configurar `publish` en `electron-builder` apuntando a GitHub Releases, S3 o un servidor HTTP generico
3. publicar junto al instalador los metadatos `latest.yml`
4. conectar el `autoUpdater` desde el proceso principal para buscar, descargar e instalar actualizaciones

Mientras no se haga esa integracion, el usuario seguira necesitando descargar nuevas versiones manualmente.

## Nota sobre impresion RAW

El proyecto usa el modulo `printer` para listar impresoras y enviar bytes ESC/POS al spooler de Windows por nombre de impresora. Como es un modulo nativo y ademas es una dependencia vieja, debes:

- instalar y empaquetar el agente directamente en Windows
- preferir Node 22
- usar `npm install --legacy-peer-deps` si aparece conflicto de peer dependencies al instalar
