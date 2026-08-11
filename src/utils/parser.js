/**
 * Utility functions for parsing text alerts and extracting network info.
 */

// Matches GPON/EPON Serial Numbers (usually 4 alphanumeric chars + 8 hex digits, e.g. HWTC12345678, FHTT8c3a91bf)
const SN_REGEX = /\b([A-Z0-9]{4}[0-9A-Fa-f]{8})\b/i;

// Fallback for general 12-character alphanumeric strings that look like serial numbers (e.g. ZTEG12345678)
const ALT_SN_REGEX = /\b(?:SN\s*[:=]\s*)?([A-Z0-9]{12})\b/i;

// Matches 16-character hex Serial Numbers (e.g. 4857544338423232)
const HEX_SN_REGEX = /\b([0-9A-Fa-f]{16})\b/i;

// Matches 16-character hex Serial Numbers with spaces (e.g. 48 57 54 43 38 42 32 32)
const HEX_SPACE_SN_REGEX = /\b((?:[0-9A-Fa-f]{2}[-\s:]+){7}[0-9A-Fa-f]{2})\b/i;

// Regexes to capture NAP box identifiers
const EXPLICIT_NAP_REGEX = /(?:caja\s+)?nap\s*[:=\s-_]\s*([A-Za-z0-9]+(?:[-_./][A-Za-z0-9]+)*)/i;
const NETWORK_CODE_NAP_REGEX = /\b([A-Z]{2}[-_]?\d{3,5}(?:[-_]\d+)?)\b/i;
const GENERIC_NAP_REGEX = /\b(NAP[-_.\s]*\d+(?:[-_.\s]*[A-Z0-9]{1,3})?)\b/i;

// Regex to capture GPON/EPON board and port (e.g., GPON 0/12/15, EPON 0/3/1)
const BOARD_PORT_REGEX = /(?:GPON|EPON|PON)\s*\d+\/(\d+)\/(\d+)/i;

/**
 * Extract Board and Port from a text message.
 * @param {string} text - Message text to parse
 * @returns {Object|null} - { board, port } or null if not found
 */
export function extractBoardAndPort(text) {
  if (!text) return null;
  const match = text.match(BOARD_PORT_REGEX);
  if (match) {
    return {
      board: parseInt(match[1], 10),
      port: parseInt(match[2], 10)
    };
  }
  return null;
}

/**
 * Helper to convert a 16-character hex serial number to standard 12-character ASCII format.
 * E.g., "4857544338423232" -> "HWTC38423232"
 */
function convertHexSnToAscii(hex) {
  const cleanHex = hex.replace(/[-:\s]/g, '');
  if (cleanHex.length !== 16) return cleanHex;
  
  const vendorHex = cleanHex.substring(0, 8);
  const serialPart = cleanHex.substring(8);
  
  let vendorAscii = '';
  for (let i = 0; i < vendorHex.length; i += 2) {
    const charCode = parseInt(vendorHex.substring(i, i + 2), 16);
    if (charCode >= 32 && charCode <= 126) {
      vendorAscii += String.fromCharCode(charCode);
    } else {
      // If not printable, return original hex
      return cleanHex;
    }
  }
  return vendorAscii.toUpperCase() + serialPart.toUpperCase();
}

/**
 * Extract ONU Serial Number from a text message.
 * @param {string} text - Message text to parse
 * @returns {string|null} - Cleaned serial number in uppercase, or null if not found
 */
export function extractSerialNumber(text) {
  if (!text) return null;
  
  // Try 16-character hex SN first (with spaces/separators)
  let match = text.match(HEX_SPACE_SN_REGEX);
  if (match) {
    return convertHexSnToAscii(match[1]);
  }
  
  // Try 16-character hex SN (no spaces)
  match = text.match(HEX_SN_REGEX);
  if (match) {
    return convertHexSnToAscii(match[1]);
  }
  
  // Try primary GPON/EPON SN regex first
  match = text.match(SN_REGEX);
  if (match) {
    return match[1].toUpperCase();
  }
  
  // Try alternative 12-character regex
  match = text.match(ALT_SN_REGEX);
  if (match) {
    return match[1].toUpperCase();
  }
  
  return null;
}

/**
 * Extract NAP Box information from a text string (like ONU address, description, or comment).
 * Handles formats such as:
 * - "caja nap: sm-7030-1" -> "SM-7030-1"
 * - "Caja NAP SM0201-5"   -> "SM0201-5"
 * - "NAP: SM-7030-1"       -> "SM-7030-1"
 * - "SM7038-1"             -> "SM7038-1"
 * - "SH7004-2"             -> "SH7004-2"
 * - "NAP-04-A"             -> "NAP-04-A"
 * - "NAP 12"               -> "NAP-12"
 * @param {string} text - The address, description, or comment string to search
 * @returns {string|null} - Extracted NAP box name in uppercase, or null if not found
 */
export function extractNapBox(text) {
  if (!text || typeof text !== 'string') return null;
  
  // 1. Try explicit "caja nap: <name>", "caja nap <name>", "nap: <name>"
  const explicitMatch = text.match(/(?:caja\s+nap\s*[:=\s-_]*|nap\s*[:=]\s*)([A-Za-z0-9]+(?:[-_./][A-Za-z0-9]+)*)/i);
  if (explicitMatch && explicitMatch[1]) {
    const raw = explicitMatch[1].trim();
    if (raw.length >= 2 && !/^(caja|box|puerto|port|onu|olt)$/i.test(raw)) {
      if (/^\d+([A-Za-z0-9-_]*)$/.test(raw)) {
        return `NAP-${raw.toUpperCase()}`;
      }
      return raw.toUpperCase().replace(/\s+/g, ' ');
    }
  }

  // 2. Try standard network codes like SM0201-5, SM-7030-1, SH7038-1, SJ0101-1, etc.
  const codeMatch = text.match(/\b([A-Z]{2}[-_]?\d{3,5}(?:[-_]\d+)?)\b/i);
  if (codeMatch && codeMatch[1]) {
    return codeMatch[1].toUpperCase().trim();
  }

  // 3. Try generic NAP-01, NAP_12, NAP 12 formats (capturing the NAP prefix)
  const genericMatch = text.match(/\b(NAP[-_.\s]*\d+(?:[-_.\s]*[A-Z0-9]{1,3})?)\b/i);
  if (genericMatch && genericMatch[1]) {
    return genericMatch[1].toUpperCase().replace(/\s+/g, ' ').trim();
  }
  
  return null;
}

/**
 * Parse status details from Zabbix alert text and return user-friendly status & icon.
 * @param {string} text - The alert event name, description, or subject
 * @returns {Object} - Object with { status, icon, category }
 */
export function parseStatusInfo(text) {
  if (!text) {
    return {
      status: 'Desconocido',
      icon: '❓',
      category: 'unknown'
    };
  }
  
  const lowerText = text.toLowerCase();
  
  // Power failure checks
  if (
    lowerText.includes('power fail') || 
    lowerText.includes('dying gasp') || 
    lowerText.includes('sin energia') || 
    lowerText.includes('corte de luz') || 
    lowerText.includes('power down') ||
    lowerText.includes('alimentacion') ||
    lowerText.includes('d-gasp') ||
    lowerText.includes('dgasp')
  ) {
    return {
      status: 'Corte de Energía (Power Failure)',
      icon: '🔌',
      category: 'power_fail'
    };
  }
  
  // Optical loss checks
  if (
    lowerText.includes('loss of signal') || 
    lowerText.includes('los') || 
    lowerText.includes('loss') || 
    lowerText.includes('offline') || 
    lowerText.includes('corte de fibra') ||
    lowerText.includes('sin señal') ||
    lowerText.includes('disconnect')
  ) {
    return {
      status: 'Pérdida de Señal (Loss of Signal)',
      icon: '🔴',
      category: 'loss'
    };
  }
  
  // High CPU/Temp (Macro alerts)
  if (lowerText.includes('cpu') || lowerText.includes('overload') || lowerText.includes('sobrecargado')) {
    return {
      status: 'Sobrecarga de CPU',
      icon: '🔥',
      category: 'cpu_overload'
    };
  }
  
  if (lowerText.includes('temperature') || lowerText.includes('temperatura')) {
    return {
      status: 'Temperatura Elevada',
      icon: '🌡️',
      category: 'temperature'
    };
  }
  
  // Generic alarm
  return {
    status: 'Alarma Activa',
    icon: '⚠️',
    category: 'generic'
  };
}

/**
 * Format a Date object to YYYY-MM-DD HH:mm:ss in America/Bogota timezone (UTC-5)
 * @param {Date} date - The date to format
 * @returns {string} - Formatted string
 */
export function formatDateTime(date) {
  // Offset in milliseconds for UTC-5 (5 hours)
  const offsetMs = -5 * 60 * 60 * 1000;
  // Adjust to UTC-5
  const adjusted = new Date(date.getTime() + offsetMs);
  
  const yyyy = adjusted.getUTCFullYear();
  const mm = String(adjusted.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(adjusted.getUTCDate()).padStart(2, '0');
  const hh = String(adjusted.getUTCHours()).padStart(2, '0');
  const min = String(adjusted.getUTCMinutes()).padStart(2, '0');
  const ss = String(adjusted.getUTCSeconds()).padStart(2, '0');
  
  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
}

/**
 * Extract the event date and time from the webhook payload or string message.
 * @param {Object|string} payload - Webhook body object or raw message string
 * @returns {string} - Formatted date/time
 */
export function extractEventTime(payload) {
  const p = typeof payload === 'string' ? { text: payload } : (payload || {});
  
  // 1. Check direct event timestamp/clock fields
  const timeVal = p.event_time || p.time || p.clock || p.timestamp;
  const dateVal = p.event_date || p.date;
  
  if (timeVal) {
    // If it's a Unix timestamp (seconds or milliseconds)
    if (!isNaN(timeVal) && String(timeVal).length >= 10) {
      const ms = String(timeVal).length === 10 ? Number(timeVal) * 1000 : Number(timeVal);
      return formatDateTime(new Date(ms));
    }
    
    if (dateVal) {
      return `${dateVal.replace(/\./g, '-')} ${timeVal}`;
    }
    return timeVal;
  }
  
  // 2. Parse from text fields (event_name, trigger_description, or raw message text)
  const text = ((p.event_name || '') + ' ' + (p.trigger_description || '') + ' ' + (p.text || '')).trim();
  
  // Look for timestamp pattern HH:MM:SS or HH:MM
  const timeMatch = text.match(/\b(\d{1,2}:\d{2}:\d{2})\b/) || text.match(/\b(\d{1,2}:\d{2})\b/);
  // Look for date pattern YYYY.MM.DD or YYYY-MM-DD or YYYY/MM/DD
  const dateMatch = text.match(/\b(\d{4}[./-]\d{2}[./-]\d{2})\b/);
  
  if (timeMatch) {
    if (dateMatch) {
      const cleanDate = dateMatch[1].replace(/\./g, '-').replace(/\//g, '-');
      return `${cleanDate} ${timeMatch[1]}`;
    }
    return timeMatch[1];
  }
  
  // 3. Fallback to current local time formatted
  return formatDateTime(new Date());
}

