# electron-main.ts

Ruta: `src/main/electron-main.ts`

Este archivo es el punto de entrada del proceso principal de Electron. Su responsabilidad no es imprimir directamente, sino orquestar el agente local: inicializa servicios, levanta el servidor HTTP en loopback, conecta el cliente backend, crea el icono de bandeja, activa auto-arranque, arranca auto-updates y mantiene mecanismos de recuperacion cuando el servidor local cae.

## Estado global del proceso

- `tray`: referencia al icono de bandeja de Electron. Se usa para menu, salida y notificaciones.
- `localServer`: instancia del servidor HTTP local que expone endpoints como `/health`, `/printers`, `/config`, `/monitor` y endpoints de impresion.
- `backendPrintClient`: cliente que conecta el agente con el backend remoto para recibir o reportar trabajos de impresion.
- `printTransportRegistry`: registro compartido de transportes RAW y DRIVER. Se conserva para liberar el helper WinSpool al cerrar.
- `isQuitting`: bandera de apagado ordenado. Evita reinicios automaticos mientras la app esta cerrando.
- `shutdownCompleted` y `shutdownPromise`: hacen idempotente el cierre asincrono y evitan liberar dos veces los mismos recursos.
- `loggerInstance`: logger compartido para registrar fallas incluso desde handlers globales.
- `restartTimer`: temporizador de reinicio diferido. Evita reinicios duplicados ante varias fallas cercanas.
- `watchdogTimer`: intervalo que revisa si el servidor local sigue corriendo.
- `stopAutoUpdater`: funcion de limpieza devuelta por `startAutoUpdater`.
- `runtimeStartedAt`: timestamp usado para reportar desde cuando corre esta instancia del agente.
- `SINGLE_INSTANCE_LOCK`: bloqueo de Electron para garantizar una sola instancia del agente.
- `SERVER_WATCHDOG_INTERVAL_MS`: frecuencia del watchdog, actualmente 15 segundos.

## Flujo de arranque

1. Electron toma un lock de instancia unica con `app.requestSingleInstanceLock()`.
2. Si otra instancia ya tiene el lock, esta instancia llama `app.quit()`.
3. `bootstrap()` espera `app.whenReady()`.
4. Se habilita auto-arranque con Windows.
5. Se crean rutas bajo `app.getPath('userData')` para configuracion e historial.
6. Se inicializan configuracion, historial atomico, adapter WinSpool, discovery, perfiles y cola por impresora.
7. Se crean `WindowsRawTransport`, `WindowsDriverTransport`, su registro y el monitor de JobId.
8. Se crea el unico `PrintOrchestratorService` y el servicio de diagnosticos.
9. Se crea `BackendPrintClientService` usando discovery y orchestrator.
10. Se crea `LocalServer` usando exactamente el mismo orchestrator.
11. Se inicia el servidor, el watchdog y el tray para que el monitor quede disponible.
12. Se registra el runtime efectivo de impresion.
13. Se reconcilian trabajos interrumpidos antes de reclamar trabajos nuevos del backend.
14. Si la reconciliacion fue segura, se arranca el cliente backend; despues se inicia el auto-updater.

## Funciones

### `bootstrap(): Promise<void>`

Inicializa el proceso principal del agente. Es idempotente: si `localServer` y `tray` ya existen, no reconstruye los servicios; solo reactiva el watchdog y asegura que el servidor local este iniciado.

En el primer arranque hace el cableado completo:

- espera a que Electron este listo;
- habilita auto-arranque;
- crea logger, configuracion, historial y cola por impresora;
- construye adapter, discovery, perfiles, formatters, transportes y monitor del spooler;
- inyecta el mismo orquestador al cliente backend y al servidor local;
- registra modulo nativo, binario, versiones y arquitectura;
- reconcilia JobIds persistidos sin reenviar;
- inicia servidor, cliente backend y watchdog;
- construye el tray;
- configura el auto-updater;
- registra handlers de `window-all-closed`, `before-quit` y `activate`.

### `ensureLocalServerStarted(): Promise<void>`

Intenta iniciar `localServer` si existe. Si el servidor no esta construido, retorna sin hacer nada.

Cuando `localServer.start()` falla, registra el error y llama `scheduleRestart('startup-failure')`. Esto permite que el agente se recupere sin dejar bloqueado el arranque principal.

### `shutdownRuntime(): Promise<void>`

Ejecuta una sola vez el apagado compartido: detiene watchdog y reinicios pendientes, desconecta el cliente backend y el auto-updater, cierra el servidor local y libera el registro de transportes junto con el helper WinSpool. Usa `Promise.allSettled` para intentar liberar todos los recursos aunque uno falle.

### `logPrintingRuntime(printerDiscoveryService, logger): Promise<void>`

Inicializa el adapter WinSpool de forma controlada y registra la evidencia del runtime: version del agente, Electron, Node, arquitectura, ruta del wrapper `printer`, ruta del binario nativo, version del paquete y modo de carga. Si el modulo no puede cargarse, registra el error sin ocultarlo.

No ejecuta una impresion. Su objetivo es que un diagnostico pueda determinar exactamente que binario termino cargando el agente.

### `restartLocalServer(reason: string): Promise<void>`

Reinicia el servidor local por una razon identificable, por ejemplo `manual`, `watchdog-server-not-running`, `activate` o `uncaught-exception`.

El flujo es:

- salir si no hay servidor o si la app esta cerrando;
- cancelar reinicios pendientes con `clearScheduledRestart()`;
- registrar la razon;
- intentar detener el servidor actual;
- intentar iniciar el servidor otra vez;
- si el nuevo start falla, registrar el error y agendar `scheduleRestart('restart-failure')`.

Un error al detener el servidor no cancela el intento de arrancarlo, porque la instancia puede estar en un estado parcialmente caido.

### `scheduleRestart(reason: string): void`

Agenda un reinicio automatico del servidor local en 5 segundos.

Tiene dos guardas importantes:

- si ya hay `restartTimer`, no agenda otro;
- si `isQuitting` es `true`, no intenta recuperar nada.

Esta funcion funciona como debounce de fallas: varias senales de error cercanas terminan en un solo reinicio.

### `clearScheduledRestart(): void`

Cancela un reinicio automatico pendiente y limpia `restartTimer`.

Se usa antes de reinicios controlados y durante el cierre del agente para que no quede un temporizador intentando revivir el servidor mientras Electron esta saliendo.

### `startWatchdog(): void`

Arranca un intervalo que cada 15 segundos revisa `localServer.isRunning()`.

Si el servidor ya no esta corriendo, registra una advertencia y agenda `scheduleRestart('watchdog-server-not-running')`.

No hace una peticion HTTP real a `/health`; depende del estado interno expuesto por `LocalServer`.

### `stopWatchdog(): void`

Detiene el intervalo del watchdog y limpia `watchdogTimer`.

Es parte del apagado ordenado y tambien evita que existan dos watchdogs si `bootstrap()` se ejecuta nuevamente sobre una instancia ya inicializada.

## Handlers y callbacks importantes

### `app.on('second-instance', ...)`

Se ejecuta cuando el usuario intenta abrir otra copia del agente. Como ya existe un lock de instancia unica, no se crea otro servidor. Si el servidor actual esta caido, se reinicia; si aun no existe, se llama `bootstrap()`. Tambien muestra una notificacion indicando que el agente ya esta en ejecucion.

### `app.on('before-quit', ...)`

Intercepta cierres que no pasan por el flujo explicito. Previene temporalmente el cierre, espera `shutdownRuntime()` y vuelve a llamar `app.quit()` con `shutdownCompleted` activo. Esto cubre tanto la salida por tray como cierres iniciados por Electron o el auto-updater.

### `process.on('uncaughtException', ...)`

Registra excepciones no controladas del proceso y trata de reiniciar el servidor local. La prioridad es mantener disponible el componente critico para impresion.

### `process.on('unhandledRejection', ...)`

Registra promesas rechazadas sin manejo y agenda un reinicio diferido del servidor local.

### `onServerUnavailable`

Callback pasado a `LocalServer`. Cuando el servidor detecta una condicion recuperable, este archivo registra la razon y agenda reinicio automatico.

### Acciones del tray

- `onOpenMonitor`: asegura que el servidor este iniciado y abre `/monitor`.
- `onQuit`: marca `isQuitting`, apaga watchdog, reinicio pendiente, cliente backend, servidor local, transportes y helper WinSpool, y luego cierra Electron.
- `onRestart`: reinicia el servidor local con razon `manual`.

## Lectura rapida

`electron-main.ts` es el composition root y supervisor del agente. Construye una sola instancia de cada dependencia del pipeline, mantiene vivo el servidor local, reconcilia trabajos al arrancar y libera los recursos de impresion al cerrar. No contiene formato ESC/POS ni llamadas directas a Windows.
