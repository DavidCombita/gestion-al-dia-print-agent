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
- `POST /config`
- `POST /print/test`
- `POST /print/invoice`
- `POST /print/kitchen-order`

Todos escuchan solo en `127.0.0.1:3088`.

## Seguridad

- CORS restringido a `http://localhost:4200` y `https://aldia-co.com` por defecto.
- Token local configurable por header `X-Gestion-Print-Token` o `Authorization: Bearer ...`.
- El token se guarda en el archivo local del agente para emparejar el navegador con el servicio.

## Configuracion local

El agente guarda un `config.json` en el directorio `userData` de Electron con:

- impresora de facturas
- impresora de comandas
- copias por tipo
- activacion de factura/comanda
- ancho de papel
- token de emparejamiento
- origenes CORS permitidos

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

## Nota sobre impresion RAW

El proyecto usa el modulo `printer` para listar impresoras y enviar bytes ESC/POS al spooler de Windows por nombre de impresora. Como es un modulo nativo y ademas es una dependencia vieja, debes:

- instalar y empaquetar el agente directamente en Windows
- preferir Node 22
- usar `npm install --legacy-peer-deps` si aparece conflicto de peer dependencies al instalar
