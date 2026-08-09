# Checklist manual de impresion Windows

Registrar para cada prueba: fecha, version del agente, impresora, driver, puerto, transporte, `localJobId`, Windows JobId, estado final y observaciones.

## Preparacion

- [ ] Instalar el build en Windows con la POS-80C registrada en el sistema.
- [ ] Confirmar que el monitor muestra la ruta del modulo nativo sin errores en `/health` y el diagnostico exportado.
- [ ] Confirmar nombre exacto, driver, puerto, print processor y datatype.
- [ ] Configurar el ancho de rollo correcto en el driver.
- [ ] Configurar perfil `WINDOWS_RAW`, ancho y columnas de la impresora.

## Casos

- [ ] **A. Normal RAW:** ejecutar **Prueba RAW minima**. Debe crear JobId, salir de la cola en tiempo acotado y terminar `SPOOL_COMPLETED` si Windows lo permite.
- [ ] **B. Impresora apagada:** apagar antes del submit. Debe terminar `FAILED`, `STUCK` o `UNKNOWN`, nunca permanecer procesando indefinidamente.
- [ ] **C. Sin papel:** retirar papel. Cuando el driver reporte `PAPEROUT`, debe terminar `STUCK`, bloquear solo esa impresora y no reintentar.
- [ ] **D. USB desconectado:** desconectar durante un trabajo. Debe terminar con estado controlado y sin copia automatica.
- [ ] **E. Recuperacion:** reconectar USB, resolver o cancelar el JobId, confirmar eliminacion, desbloquear y probar conscientemente.
- [ ] **F. Tres tickets:** enviar tres trabajos a la misma impresora. Deben conservar orden y no ejecutarse simultaneamente.
- [ ] **G. Caja y cocina:** enviar trabajos simultaneos a dos impresoras. Una no debe bloquear el avance de la otra.
- [ ] **H. Reinicio:** cerrar el agente despues de crear JobId y antes del estado final. Al iniciar debe reconciliar el mismo JobId sin reenviar.
- [ ] **I. RAW falla:** exportar diagnostico y ejecutar RAW minimo antes de atribuir el problema al formatter.
- [ ] **J. Driver:** seleccionar manualmente `WINDOWS_DRIVER` o ejecutar su diagnostico. Debe usar el driver y el tamaño configurado en Windows; documentar que el resultado local puede quedar `UNKNOWN` por falta de JobId.

## Cancelacion controlada

- [ ] Seleccionar un trabajo con `localJobId` y Windows JobId conocidos.
- [ ] Pulsar **Cancelar este trabajo**.
- [ ] Verificar que solo desaparece ese JobId.
- [ ] Verificar estado local `CANCELLED` y circuit breaker `HEALTHY`.
- [ ] Confirmar que otros trabajos y otras impresoras no fueron purgados.

## Evidencia final

- [ ] Adjuntar export diagnostico de la POS-80C.
- [ ] Adjuntar logs correlacionados por `backendJobId`, `localJobId`, `attemptId` y Windows JobId.
- [ ] Registrar si el port monitor realmente reporta `PRINTED`/TrueEndOfJob o si solo se pudo observar desaparicion del spooler.
- [ ] No describir ningun resultado como impresion fisica confirmada sin evidencia del hardware/port monitor.
