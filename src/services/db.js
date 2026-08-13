import sqlite3 from 'sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbDir = path.resolve(__dirname, '../../data');
const dbPath = path.join(dbDir, 'telecom.db');

let db;

/**
 * Helper to run a SQL command returning a Promise.
 */
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

/**
 * Helper to fetch a single row.
 */
function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

/**
 * Helper to fetch all rows.
 */
function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

/**
 * Initialize SQLite database, create tables and run auto-migration.
 */
export function initDb() {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    db = new sqlite3.Database(dbPath, async (err) => {
      if (err) {
        console.error('❌ Failed to open SQLite database:', err.message);
        return reject(err);
      }
      console.log(`📡 SQLite Database connected at: ${dbPath}`);

      try {
        // Create NAPs table
        await run(`
          CREATE TABLE IF NOT EXISTS naps (
            name TEXT PRIMARY KEY,
            olt_name TEXT,
            board TEXT,
            port TEXT,
            latitude REAL,
            longitude REAL,
            totalClients INTEGER,
            onlineClients INTEGER,
            offlineClients INTEGER,
            status TEXT,
            clients TEXT
          )
        `);

        // Create Status History table
        await run(`
          CREATE TABLE IF NOT EXISTS status_history (
            id TEXT PRIMARY KEY,
            timestamp TEXT,
            formattedTime TEXT,
            eventTime TEXT,
            sn TEXT,
            onuName TEXT,
            napName TEXT,
            previousStatus TEXT,
            newStatus TEXT,
            napStatus TEXT,
            failureType TEXT,
            failureLabel TEXT,
            reason TEXT,
            resolved INTEGER,
            resolvedAt TEXT,
            oltName TEXT,
            board TEXT,
            port TEXT,
            latitude REAL,
            longitude REAL
          )
        `);

        // Create Optical History table
        await run(`
          CREATE TABLE IF NOT EXISTS optical_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sn TEXT,
            rx_power REAL,
            tx_power REAL,
            temperature REAL,
            voltage REAL,
            bias_current REAL,
            timestamp TEXT
          )
        `);

        console.log('✅ SQLite Tables verified/created.');

        // Run data migration if JSON files exist and DB is empty
        await runMigration();

        resolve();
      } catch (tableErr) {
        console.error('❌ SQLite table creation error:', tableErr.message);
        reject(tableErr);
      }
    });
  });
}

/**
 * Migrate legacy JSON file cache to SQLite if SQLite database is empty.
 */
async function runMigration() {
  const cacheFile = path.join(dbDir, 'nap_cache.json');
  const historyFile = path.join(dbDir, 'status_history.json');

  try {
    // 1. Migrate NAPs cache
    const napsCountRow = await get('SELECT COUNT(*) as count FROM naps');
    if (napsCountRow.count === 0 && fs.existsSync(cacheFile)) {
      console.log('📦 Migrating NAPs cache from JSON to SQLite...');
      const cacheData = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (Array.isArray(cacheData)) {
        db.serialize(() => {
          const stmt = db.prepare(`
            INSERT INTO naps (name, olt_name, board, port, latitude, longitude, totalClients, onlineClients, offlineClients, status, clients)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);
          cacheData.forEach((nap) => {
            stmt.run(
              nap.name,
              nap.olt_name,
              nap.board,
              nap.port,
              nap.latitude,
              nap.longitude,
              nap.totalClients,
              nap.onlineClients,
              nap.offlineClients,
              nap.status,
              JSON.stringify(nap.clients || [])
            );
          });
          stmt.finalize();
        });
        console.log(`✅ Migrated ${cacheData.length} NAPs to SQLite.`);
      }
    }

    // 2. Migrate Status History
    const historyCountRow = await get('SELECT COUNT(*) as count FROM status_history');
    if (historyCountRow.count === 0 && fs.existsSync(historyFile)) {
      console.log('📋 Migrating Status History from JSON to SQLite...');
      const historyData = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
      if (Array.isArray(historyData)) {
        db.serialize(() => {
          const stmt = db.prepare(`
            INSERT INTO status_history (
              id, timestamp, formattedTime, eventTime, sn, onuName, napName,
              previousStatus, newStatus, napStatus, failureType, failureLabel,
              reason, resolved, resolvedAt, oltName, board, port, latitude, longitude
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);
          historyData.forEach((item) => {
            stmt.run(
              item.id,
              item.timestamp,
              item.formattedTime,
              item.eventTime,
              item.sn,
              item.onuName,
              item.napName,
              item.previousStatus,
              item.newStatus,
              item.napStatus,
              item.failureType,
              item.failureLabel,
              item.reason,
              item.resolved ? 1 : 0,
              item.resolvedAt || null,
              item.oltName,
              item.board,
              item.port,
              item.latitude,
              item.longitude
            );
          });
          stmt.finalize();
        });
        console.log(`✅ Migrated ${historyData.length} history items to SQLite.`);
      }
    }
  } catch (err) {
    console.error('⚠️ Error during migration to SQLite:', err.message);
  }
}

/**
 * Retrieve all NAPs from database.
 */
export async function dbGetAllNaps() {
  try {
    const rows = await all('SELECT * FROM naps');
    return rows.map((r) => ({
      ...r,
      clients: JSON.parse(r.clients || '[]')
    }));
  } catch (err) {
    console.error('dbGetAllNaps error:', err.message);
    return [];
  }
}

/**
 * Save or update a single NAP in database.
 */
export async function dbSaveNap(nap) {
  try {
    await run(
      `INSERT OR REPLACE INTO naps (
        name, olt_name, board, port, latitude, longitude,
        totalClients, onlineClients, offlineClients, status, clients
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        nap.name,
        nap.olt_name,
        nap.board,
        nap.port,
        nap.latitude,
        nap.longitude,
        nap.totalClients,
        nap.onlineClients,
        nap.offlineClients,
        nap.status,
        JSON.stringify(nap.clients || [])
      ]
    );
  } catch (err) {
    console.error(`dbSaveNap error for ${nap.name}:`, err.message);
  }
}

/**
 * Retrieve status history from database.
 */
export async function dbGetStatusHistory(limit = 100, filter = 'all') {
  try {
    let sql = 'SELECT * FROM status_history';
    const params = [];
    
    if (filter === 'pending') {
      sql += ' WHERE resolved = 0';
    } else if (filter === 'resolved') {
      sql += ' WHERE resolved = 1';
    }
    
    sql += ' ORDER BY timestamp DESC LIMIT ?';
    params.push(limit);
    
    const rows = await all(sql, params);
    return rows.map((r) => ({
      ...r,
      resolved: r.resolved === 1
    }));
  } catch (err) {
    console.error('dbGetStatusHistory error:', err.message);
    return [];
  }
}

/**
 * Save single status history item in database.
 */
export async function dbSaveHistoryItem(item) {
  try {
    await run(
      `INSERT OR REPLACE INTO status_history (
        id, timestamp, formattedTime, eventTime, sn, onuName, napName,
        previousStatus, newStatus, napStatus, failureType, failureLabel,
        reason, resolved, resolvedAt, oltName, board, port, latitude, longitude
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        item.id,
        item.timestamp,
        item.formattedTime,
        item.eventTime,
        item.sn,
        item.onuName,
        item.napName,
        item.previousStatus,
        item.newStatus,
        item.napStatus,
        item.failureType,
        item.failureLabel,
        item.reason,
        item.resolved ? 1 : 0,
        item.resolvedAt || null,
        item.oltName,
        item.board,
        item.port,
        item.latitude,
        item.longitude
      ]
    );
  } catch (err) {
    console.error(`dbSaveHistoryItem error for ${item.id}:`, err.message);
  }
}

/**
 * Delete a specific history item by ID.
 */
export async function dbDeleteHistoryItem(id) {
  try {
    const item = await get('SELECT * FROM status_history WHERE id = ?', [id]);
    if (item) {
      await run('DELETE FROM status_history WHERE id = ?', [id]);
      return {
        ...item,
        resolved: item.resolved === 1
      };
    }
    return null;
  } catch (err) {
    console.error(`dbDeleteHistoryItem error for ${id}:`, err.message);
    return null;
  }
}

/**
 * Clear history (all or resolved).
 */
export async function dbClearHistory(mode = 'all') {
  try {
    if (mode === 'resolved') {
      await run('DELETE FROM status_history WHERE resolved = 1');
    } else {
      await run('DELETE FROM status_history');
    }
    const rows = await all('SELECT * FROM status_history ORDER BY timestamp DESC');
    return rows.map((r) => ({
      ...r,
      resolved: r.resolved === 1
    }));
  } catch (err) {
    console.error(`dbClearHistory error (${mode}):`, err.message);
    return [];
  }
}

/**
 * Resolve a history item.
 */
export async function dbResolveHistoryItem(id, resolvedAt) {
  try {
    await run('UPDATE status_history SET resolved = 1, resolvedAt = ? WHERE id = ?', [resolvedAt, id]);
    const r = await get('SELECT * FROM status_history WHERE id = ?', [id]);
    if (r) {
      return {
        ...r,
        resolved: r.resolved === 1
      };
    }
    return null;
  } catch (err) {
    console.error(`dbResolveHistoryItem error for ${id}:`, err.message);
    return null;
  }
}

/**
 * Record an optical metric point in SQLite.
 */
export async function dbSaveOpticalRecord(sn, rx, tx, temp, volt, bias) {
  try {
    await run(
      `INSERT INTO optical_history (sn, rx_power, tx_power, temperature, voltage, bias_current, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        sn.toUpperCase(),
        Number.isFinite(rx) ? rx : null,
        Number.isFinite(tx) ? tx : null,
        Number.isFinite(temp) ? temp : null,
        Number.isFinite(volt) ? volt : null,
        Number.isFinite(bias) ? bias : null,
        new Date().toISOString()
      ]
    );
  } catch (err) {
    console.error(`dbSaveOpticalRecord error for ${sn}:`, err.message);
  }
}

/**
 * Retrieve optical metrics history.
 */
export async function dbGetOpticalHistory(sn, limit = 20) {
  try {
    const rows = await all(
      'SELECT * FROM optical_history WHERE sn = ? ORDER BY timestamp DESC LIMIT ?',
      [sn.toUpperCase(), limit]
    );
    // Return sorted chronologically for graph plotting
    return rows.reverse();
  } catch (err) {
    console.error(`dbGetOpticalHistory error for ${sn}:`, err.message);
    return [];
  }
}
