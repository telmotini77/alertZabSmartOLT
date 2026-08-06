# Manual Técnico de Referencia: Middleware Zabbix & Smart OLT

Este manual documenta exhaustivamente la arquitectura, flujos lógicos, APIs y procedimientos de diagnóstico para el integrador que conecta Zabbix, Smart OLT y sistemas de alerta (Telegram y paneles web interactivos).

---

## 🗺️ Mapa Completo de Módulos y Archivos

El sistema está diseñado de manera modular bajo Node.js (usando ES Modules), separando las responsabilidades de enrutamiento HTTP, análisis regex de texto, bases de datos caché en disco e interacciones con APIs externas:

### 1. Punto de Entrada (`src/index.js`)
*   **Ruta:** [src/index.js](file:///c:/Users/USUARIO/Desktop/api_zaSmaOlt/src/index.js)
*   **Función:** Carga el entorno (`dotenv`), monta el servidor Express HTTP en el puerto configurado (ej: `3010`), levanta el servidor de WebSockets adjuntándolo a la misma instancia HTTP, inicializa el almacén de caché en disco y arranca el loop de escucha del Bot de Telegram (usando long polling o configurando el webhook oficial).
*   **Rutina de Caché:** Llama a `initCache()` al arrancar, el cual lee el estado de NAPs del disco y configura un `setInterval` para re-sincronizar los datos dinámicos con Smart OLT cada 30 minutos de forma silenciosa en segundo plano.

### 2. Capa de Enrutamiento (`src/routes/webhook.js`)
*   **Ruta:** [src/routes/webhook.js](file:///c:/Users/USUARIO/Desktop/api_zaSmaOlt/src/routes/webhook.js)
*   **Función:** Define los endpoints HTTP (REST API) del sistema. Realiza la clasificación lógica de alertas, la evaluación temporal para el retraso de fallas de energía (de-bounce), y la validación de corroboración de estados.
*   **Funciones Críticas:**
    *   `processAndSendAlert(payload)`: Procesa, enriquece, valida y notifica alertas individuales de Zabbix.
    *   `syncActiveProblems(chatId)`: Barrido masivo de alarmas Zabbix, cruzándolas en tiempo real contra Smart OLT.

### 3. Servicio Smart OLT (`src/services/smartOlt.js`)
*   **Ruta:** [src/services/smartOlt.js](file:///c:/Users/USUARIO/Desktop/api_zaSmaOlt/src/services/smartOlt.js)
*   **Función:** Cliente HTTP que encapsula las peticiones a la API REST de Smart OLT (`https://<subdomain>.smartolt.com/api`).
*   **Métodos Clave:**
    *   `findOnuBySn(sn)`: Obtiene los detalles físicos del cliente (Nombre, Dirección, Slot, Puerto PON, OLT, ID ONU).
    *   `getOnuStatus(externalId)`: Consulta en la OLT el estado dinámico actual, potencia óptica de Rx y razón de la última desconexión.
    *   `findOnusByAddressQuery(query)`: Agrupa clientes asociados a un NAP Box específico.
    *   `findOnusByPort(oltId, board, port, fallbackOltName)`: Lista todas las ONUs conectadas al mismo puerto PON para calcular puntos de corte en cascada de fibra.

### 4. Servicio Zabbix API (`src/services/zabbix.js`)
*   **Ruta:** [src/services/zabbix.js](file:///c:/Users/USUARIO/Desktop/api_zaSmaOlt/src/services/zabbix.js)
*   **Función:** Cliente HTTP JSON-RPC para interactuar con la API viva de Zabbix.
*   **Propiedades:** Evalúa de manera dinámica las variables de entorno de Zabbix al momento de la llamada, eliminando problemas de carga o importación (hoisting) en entornos de prueba.
*   **Métodos Clave:**
    *   `authenticate()`: Negocia un token de sesión si se configuran credenciales clásicas.
    *   `getActiveTriggers()`: Llama a `trigger.get` filtrando triggers activos en estado PROBLEM (`value: 1`) para barridos dinámicos de red.

### 5. Caché de Red (`src/services/cache.js`)
*   **Ruta:** [src/services/cache.js](file:///c:/Users/USUARIO/Desktop/api_zaSmaOlt/src/services/cache.js)
*   **Función:** Serializa y deserializa el archivo local `src/data/nap_cache.json`. Este caché optimiza los tiempos de respuesta del mapa en tiempo real y protege a Smart OLT contra rate-limits.
*   **Rutina de Ponderación:** Calcula automáticamente las coordenadas de una caja NAP promediando las latitudes y longitudes georreferenciadas de las ONUs que pertenecen a dicha caja.

### 6. Servicio Telegram (`src/services/telegram.js`)
*   **Ruta:** [src/services/telegram.js](file:///c:/Users/USUARIO/Desktop/api_zaSmaOlt/src/services/telegram.js)
*   **Función:** Mapea las llamadas a los endpoints del API del Bot de Telegram (como `/sendMessage`, `/setWebhook`, `/getUpdates`), formateando los mensajes enviados mediante sintaxis HTML nativa.

### 7. WebSocket Server (`src/services/websocket.js`)
*   **Ruta:** [src/services/websocket.js](file:///c:/Users/USUARIO/Desktop/api_zaSmaOlt/src/services/websocket.js)
*   **Función:** Gestiona conexiones de socket activas, emitiendo actualizaciones instantáneas de cajas NAP (`nap_status_update`) directamente a los paneles interactivos del mapa ante cualquier trigger.

### 8. Utilidad de Parseo (`src/utils/parser.js`)
*   **Ruta:** [src/utils/parser.js](file:///c:/Users/USUARIO/Desktop/api_zaSmaOlt/src/utils/parser.js)
*   **Función:** Funciones Regex reutilizables para extraer Números de Serie GPON (de 12 o 16 caracteres hexadecimales), nombres de NAPs, categorizar el tipo de alarma, y normalizar las marcas de tiempo a UTC-5.

---

## 🔄 Ciclo de Vida Completo de una Alerta

```
[Zabbix Trigger Webhook] 
          │ 
          ▼
    [POST /webhook/zabbix]
          │
          ▼
   [Regex Parser] ──► Extrae SN y normaliza (12/16-char Hex a ASCII)
          │ 
          ▼
    [¿Es Alerta de Energía?]
          ├──► SÍ: [Encolar en Map de De-bounce (5 Minutos)]
          │          │
          │          ├──► [¿Llega evento OK antes de 5 Minutos?]
          │          │      ├──► SÍ: [Borrar del Map y Abortar Alerta]
          │          │      └──► NO: [Ejecutar tras Timeout]
          │          ▼
          └──► NO: [Continuar Inmediatamente]
          │
          ▼
   [Query Smart OLT] ──► Busca detalles de ONU por SN
          │
          ▼
   [Live Status Query] ──► Pide live status en OLT (Rx Power, Down Reason)
          │
          ▼
   [Filtro de Corroboración] ──► Evalúa discrepancias Zabbix vs. Smart OLT
          │
          ├──► mismatch u OLT Offline: [Ignorar Alerta y Registrar en Logs]
          │
          ▼
   [Cálculo de Punto de Corte (Si es Loss)] ──► Compara clientes en el mismo puerto PON
          │
          ▼
   [Broadcast a WebSockets] y [Envío de Tarjeta HTML a Telegram]
```

---

## 📶 Algoritmo de Estimación de Punto de Corte en Cascada

Cuando una alerta es clasificada como **Pérdida de Señal (Loss of Signal / LOS)** y es corroborada por la OLT, el middleware intenta geolocalizar el corte físico del cable de fibra óptica (drop o troncal) mediante el siguiente algoritmo implementado en `src/routes/webhook.js`:

1.  **Recuperación de ONUs en el Puerto PON:**
    El sistema consulta a Smart OLT buscando todas las ONUs conectadas al mismo OLT ID, Slot (Board) y Puerto PON físico en el que está registrada la ONU afectada.
2.  **Agrupación y Ordenamiento Natural:**
    Agrupa los clientes por su identificador de Caja NAP (extraído de sus direcciones o comentarios). Luego, aplica un ordenamiento natural alfabético a las cajas (ej: `NAP-1` &rarr; `NAP-2` &rarr; `NAP-10`, evitando que `NAP-10` se ordene antes que `NAP-2`).
3.  **Identificación de Estado Ponderado:**
    Determina cuántos clientes de cada caja NAP están actualmente en línea (`Online`) u offline.
4.  **Establecimiento del Punto de Falla:**
    *   Recorre la lista ordenada de NAPs del puerto de atrás hacia adelante (de la última NAP del tendido a la primera).
    *   Localiza la **Última NAP que aún conserva al menos un cliente en línea** (Online).
    *   Estima que el corte físico ocurrió en el tramo de fibra entre la **Última NAP Activa** y la **Siguiente NAP Inactiva** (completamente sin señal).
    *   Si ninguna NAP tiene clientes activos en el puerto PON, determina que la falla es troncal o del propio puerto físico en la OLT.

---

## ⚙️ REST API Endpoints y Ejemplos de Pruebas Manuales (cURL)

### 1. Webhook de Zabbix
*   **Método:** `POST`
*   **Ruta:** `/webhook/zabbix`
*   **Headers:** `Content-Type: application/json`
*   **Payload JSON:**
    ```json
    {
      "event_name": "ONU FHTT8c3a91bf: Loss of Signal",
      "host_name": "OLT-CENTRAL",
      "event_severity": "High",
      "event_status": "PROBLEM",
      "clock": 1722123456
    }
    ```
*   **Prueba cURL:**
    ```bash
    curl -X POST http://localhost:3010/webhook/zabbix \
      -H "Content-Type: application/json" \
      -d '{"event_name": "ONU FHTT8c3a91bf: Loss of Signal", "host_name": "OLT-CENTRAL", "event_severity": "High", "event_status": "PROBLEM", "clock": 1722123456}'
    ```

### 2. Sincronización Masiva
*   **Método:** `GET`
*   **Ruta:** `/webhook/zabbix/sync`
*   **Prueba cURL:**
    ```bash
    curl -X GET http://localhost:3010/webhook/zabbix/sync
    ```

### 3. Actualización de Coordenadas de Caja NAP
*   **Método:** `POST`
*   **Ruta:** `/webhook/naps/coordinates`
*   **Payload JSON:**
    ```json
    {
      "name": "NAP-04-A",
      "latitude": -12.046374,
      "longitude": -77.042793
    }
    ```
*   **Prueba cURL:**
    ```bash
    curl -X POST http://localhost:3010/webhook/naps/coordinates \
      -H "Content-Type: application/json" \
      -d '{"name": "NAP-04-A", "latitude": -12.046374, "longitude": -77.042793}'
    ```

---

## 🛡️ Reglas Detalladas de Corroboración Cruzada

La API de Smart OLT valida el estado lógico reportado por Zabbix para evitar falsas alertas generadas por micro-cortes, latencias en el monitoreo o reinicios de energía:

| Evento Zabbix | Estado OLT | Acción Tomada | Razón Técnica |
| :--- | :--- | :--- | :--- |
| `PROBLEM` (LOS) | `Offline` | **ENVIAR ALERTA** | Coincidencia. La OLT corrobora que la fibra está desconectada. |
| `PROBLEM` (LOS) | `Online` / `Active` | **BLOQUEAR ENVÍO** | Mismatch. El cliente ya recuperó señal antes del procesamiento. |
| `PROBLEM` (Power Fail) | `Offline` (Dying gasp) | **ENVIAR ALERTA** | Coincidencia. La OLT corrobora corte eléctrico en la ONU. |
| `PROBLEM` (Power Fail) | `Online` | **BLOQUEAR ENVÍO** | Mismatch. Corte transitorio ya restablecido. |
| `OK` (Recuperación) | `Online` / `Active` | **ENVIAR ALERTA** | Coincidencia. Se confirma retorno de potencia óptica óptima. |
| `OK` (Recuperación) | `Offline` | **BLOQUEAR ENVÍO** | Mismatch. Zabbix infirió recuperación pero la OLT reporta que sigue caída. |

---

## 🔌 Especificaciones de WebSockets

El servidor WebSocket transmite eventos reactivos cuando hay cambios en el caché de NAPs (disparados por webhooks o geolocalización manual):

### Mensaje Transmitido (`nap_status_update`):
Cuando el estado de una caja NAP cambia, se emite un payload JSON a todos los clientes conectados:
```json
{
  "event": "nap_status_update",
  "data": {
    "name": "NAP-04-A",
    "olt_name": "OLT-CENTRAL",
    "board": "1",
    "port": "3",
    "latitude": -12.046374,
    "longitude": -77.042793,
    "totalClients": 3,
    "onlineClients": 2,
    "offlineClients": 1,
    "status": "partial",
    "clients": [
      { "name": "Juan Pérez", "sn": "FHTT8C3A91BF", "status": "Offline", "onu_id": "1/1/3:12" },
      { "name": "María López", "sn": "HWTC12345678", "status": "Online", "onu_id": "1/1/3:13" },
      { "name": "Carlos Rodríguez", "sn": "ZTEG00998877", "status": "Online", "onu_id": "1/1/3:14" }
    ]
  }
}
```

---

## 🛠️ Guía de Despliegue y Resolución de Problemas (Troubleshooting)

### 1. Error `listen EADDRINUSE: address already in use :::3010`
*   **Causa:** Otra instancia del servidor de integración ya está corriendo en el puerto 3010.
*   **Solución (Windows PowerShell):**
    ```powershell
    # Buscar el ID del proceso ocupando el puerto 3010
    Get-NetTCPConnection -LocalPort 3010 | Select-Object OwningProcess
    # Detener el proceso (Reemplazar PID con el número devuelto)
    Stop-Process -Id <PID> -Force
    ```

### 2. Mensajes `ZABBIX_API_URL is not configured` en Consola
*   **Causa:** Falta configurar el endpoint JSON-RPC de Zabbix en tu `.env`.
*   **Solución:** Agregue `ZABBIX_API_URL=http://tu-zabbix.com/api_jsonrpc.php` al archivo `.env` y reinicie el servicio.

### 3. Las alertas se encolan pero no llegan a Telegram tras 5 minutos
*   **Causa:** El de-bouncer de fallas de energía retiene la alerta.
*   **Solución:** Si está probando y desea recibir alertas de energía de forma instantánea, establezca `POWER_ALERT_DELAY_MINS=0` en su archivo `.env` y reinicie la API.

---

## 🖥️ Integración en Zabbix (Media Type Webhook Code)

Para configurar la llamada automática en su servidor Zabbix:
1. Vaya a **Administration** &rarr; **Media types** &rarr; **Create media type**.
2. Seleccione tipo **Webhook** e ingrese los siguientes parámetros:
   *   `event_name` = `{EVENT.NAME}`
   *   `host_name` = `{HOST.NAME}`
   *   `event_severity` = `{EVENT.SEVERITY}`
   *   `event_status` = `{EVENT.STATUS}`
   *   `event_clock` = `{EVENT.CLOCK}`
3. Pegue el siguiente script en el campo **Script**:

```javascript
try {
    var params = JSON.parse(value),
        req = new HttpRequest(),
        resp;

    req.addHeader('Content-Type: application/json');
    resp = req.post('http://tu-middleware-url:3010/webhook/zabbix', JSON.stringify({
        event_name: params.event_name,
        host_name: params.host_name,
        event_severity: params.event_severity,
        event_status: params.event_status,
        clock: params.event_clock
    }));

    if (req.getStatus() !== 200) {
        throw 'Error al enviar webhook: ' + resp;
    }

    return 'OK';
} catch (error) {
    Zabbix.log(3, 'Webhook error: ' + error);
    throw error;
}
```
