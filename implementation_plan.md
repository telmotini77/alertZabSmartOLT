# Plan de Implementación - API de Integración Zabbix y Smart OLT

Desarrollar una API de integración en Node.js que conecte las alertas de Zabbix con los detalles de clientes de la plataforma Smart OLT y envíe mensajes de alarma enriquecidos (que contengan la ubicación física del cliente, tarjeta, puerto y caja NAP) a un canal o grupo de Telegram.

Para ofrecer la máxima flexibilidad, la API admitirá **ambos** métodos de integración simultáneamente:
1. **Webhook Directo (Push)**: Zabbix envía alertas directamente al endpoint del webhook de nuestra API. La API consulta a Smart OLT, da formato a una tarjeta enriquecida y la publica en Telegram.
2. **Bot Oyente de Telegram (Pull/Enriquecimiento)**: Zabbix publica alertas de texto directamente en Telegram. Nuestro bot escucha en el grupo de Telegram, intercepta las alertas de Zabbix, extrae la información de la ONU/SN/OLT, consulta a Smart OLT y responde directamente al mensaje de alerta con los detalles físicos y la caja NAP del cliente.

---

## Arquitectura Técnica

La API está construida en Node.js (ES Modules) con la siguiente estructura de flujo:

```mermaid
graph TD
    subgraph Origen de Alertas
        Z1[Alerta Webhook Zabbix] -->|POST JSON| API[/Endpoint Webhook/]
        Z2[Alerta Telegram Directa Zabbix] -->|Mensaje de Texto| TG[Grupo de Telegram]
    end

    subgraph API de Integración (Node.js)
        API --> Proc[Procesador de Alertas]
        TGBot[Oyente Bot de Telegram] -->|Actualización de Mensaje| Parser[Analizador Regex]
        TG -->|Webhook / Polling| TGBot
        Parser -->|Extrae Número de Serie/Detalles| Proc
        Proc -->|Buscar ONU| SOLT[Cliente Smart OLT]
        SOLT -->|Retorna Nombre, Dirección, Puerto, NAP| Formatter[Formateador de Mensajes]
    end

    subgraph Plataformas Externas
        Formatter -->|Enviar Mensaje / Responder| TGAPI[API Bot de Telegram]
        TGAPI -->|Tarjeta HTML Enriquecida| TG
    end
```

---

## Variables de Configuración (`.env`)

Configuraremos la API utilizando variables de entorno en el archivo [.env](file:///c:/Users/USUARIO/Desktop/api_zaSmaOlt/.env):
- `PORT`: Puerto del servidor Express (por defecto `3000`).
- `SMARTOLT_SUBDOMAIN`: Subdominio de la cuenta de Smart OLT (por ejemplo, `miempresa` en `miempresa.smartolt.com`).
- `SMARTOLT_API_KEY`: Clave API generada en el panel de Smart OLT (Settings -> API KEY).
- `TELEGRAM_BOT_TOKEN`: Token del bot de Telegram obtenido a través de `@BotFather`.
- `TELEGRAM_CHAT_ID`: ID del chat/grupo de Telegram al que se enviarán las alertas (para el flujo Webhook Directo).
- `BOT_USERNAME`: El nombre de usuario del bot de Telegram (incluido el `@`) para filtrar mensajes propios y evitar bucles.
- `TELEGRAM_MODE`: Modo de conexión del bot (`polling` para desarrollo sin IP pública, o `webhook` para producción).
- `PUBLIC_URL`: URL pública (HTTPS) de la API necesaria para registrar el webhook con Telegram si se usa `TELEGRAM_MODE=webhook`.

---

## Cambios Realizados

Hemos creado e implementado la siguiente estructura de archivos en el proyecto:

### [NEW] [package.json](file:///c:/Users/USUARIO/Desktop/api_zaSmaOlt/package.json)
Inicializa el proyecto Node.js como ES Module y gestiona las dependencias necesarias (`express`, `dotenv`).

### [NEW] [.env.example](file:///c:/Users/USUARIO/Desktop/api_zaSmaOlt/.env.example)
Plantilla que muestra el diseño y las variables de configuración requeridas.

### [NEW] [src/services/smartOlt.js](file:///c:/Users/USUARIO/Desktop/api_zaSmaOlt/src/services/smartOlt.js)
Servicio cliente para comunicarse con la API de Smart OLT.
- `findOnuBySn(sn)`: Busca una ONU por su número de serie utilizando el endpoint de búsqueda `GET /api/onu/get_all_onus_details?sn=SN`.
- `getOnuStatus(externalId)`: Obtiene los niveles de potencia óptica y estado operativo en tiempo real de la OLT.

### [NEW] [src/services/telegram.js](file:///c:/Users/USUARIO/Desktop/api_zaSmaOlt/src/services/telegram.js)
Controla la comunicación con la API de Telegram Bot:
- `sendMessage(chatId, text, options)`: Envía mensajes enriquecidos con formato HTML a chats o canales.
- `replyToMessage(chatId, messageId, text)`: Responde a un mensaje específico dentro de un grupo.

### [NEW] [src/utils/parser.js](file:///c:/Users/USUARIO/Desktop/api_zaSmaOlt/src/utils/parser.js)
Utilidad de análisis mediante expresiones regulares:
- `extractSerialNumber(text)`: Detecta y extrae números de serie GPON/EPON (secuencias alfanuméricas de 12 caracteres como `FHTT8c3a91bf`).
- `extractNapBox(text)`: Extrae el identificador de la caja NAP de las cadenas de dirección o descripción (patrones como `NAP-04-A`, `Caja NAP 12`, etc.).
- `parseStatusInfo(text)`: Identifica si la alarma es una pérdida de señal (Loss of Signal) o un corte de energía (Power Failure / Dying Gasp) y asigna un emoji representativo.

### [NEW] [src/routes/webhook.js](file:///c:/Users/USUARIO/Desktop/api_zaSmaOlt/src/routes/webhook.js)
Define los endpoints HTTP para la API:
- `POST /webhook/zabbix`: Recibe webhooks JSON de Zabbix, extrae el número de serie, consulta Smart OLT y publica el mensaje enriquecido en Telegram.
- `POST /webhook/telegram`: Recibe actualizaciones del bot de Telegram (cuando se utiliza el modo webhook).

### [NEW] [src/index.js](file:///c:/Users/USUARIO/Desktop/api_zaSmaOlt/src/index.js)
Punto de entrada de la aplicación Express:
- Arranca el servidor HTTP en el puerto configurado.
- Registra las rutas de los webhooks.
- Inicia el listener de Telegram mediante registro de Webhook o mediante el bucle de Long Polling.

---

## Formato de Mensajes Enriquecidos

### 1. Alerta Directa por Webhook (Flujo Push)
Cuando Zabbix dispara una alerta y llama a `/webhook/zabbix`:
```
🔴 <b>ALERTA DE ZABBIX ENRIQUECIDA</b> 🔴

<b>Estado:</b> Pérdida de Señal (Loss of Signal)
<b>Severidad:</b> High
<b>OLT:</b> OLT-CENTRAL
<b>Tarjeta/Slot:</b> 1  |  <b>Puerto PON:</b> 3  |  <b>ONU ID:</b> 1/1/3:12

👤 <b>Detalles del Cliente (Smart OLT):</b>
• <b>Nombre/Cliente:</b> Juan Pérez
• <b>Nro. Serie:</b> <code>FHTT8C3A91BF</code>
• <b>Dirección:</b> Calle Falsa 123, NAP-04-A, Sector Centro
• <b>Caja NAP:</b> <b>NAP-04-A</b>

ℹ️ <i>Evento Zabbix: ONU FHTT8c3a91bf: Loss of Signal</i>
```

### 2. Respuesta Automática del Bot (Flujo Pull/Reply)
Cuando Zabbix publica una alerta directamente en Telegram y el Bot responde en el chat:
```
[Mensaje de Zabbix: Alerta ONU FHTT8c3a91bf Loss of Signal en OLT-CENTRAL]
   └── 🤖 (Respuesta de nuestro Bot en el chat)
       🤖 <b>Detalles de Smart OLT para <code>FHTT8C3A91BF</code>:</b>

       👤 <b>Cliente:</b> Juan Pérez
       📍 <b>Dirección:</b> Calle Falsa 123, NAP-04-A, Sector Centro
       📦 <b>Caja NAP:</b> <b>NAP-04-A</b>
       🔌 <b>Conexión Física:</b>
       • <b>OLT:</b> OLT-CENTRAL
       • <b>Tarjeta/Puerto:</b> Slot 1 | Puerto 3
       • <b>ID ONU en puerto:</b> 1/1/3:12
       • <b>ID Externo:</b> <code>N/A</code>
```

---

## Plan de Verificación

### Pruebas Automatizadas
Hemos implementado dos scripts de prueba para verificar que el código funciona localmente sin necesidad de credenciales reales ni configuraciones de red complejas:
1.  [src/test_parser.js](file:///c:/Users/USUARIO/Desktop/api_zaSmaOlt/src/test_parser.js): Prueba unitaria del extractor Regex.
2.  [src/test_routes.js](file:///c:/Users/USUARIO/Desktop/api_zaSmaOlt/src/test_routes.js): Prueba de integración de los endpoints y flujo de enriquecimiento con Smart OLT simulado.

### Verificación Manual
1. Iniciar el servidor local (`npm run dev`).
2. Configurar una alerta en Zabbix que envíe un POST HTTP al puerto local.
3. Añadir el bot de Telegram al grupo de alertas y enviarle un número de serie ONU para confirmar que responde con los datos correctos de la OLT.
