import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import dns from 'dns';
import { fileURLToPath } from 'url';
import { fetchAllOnus } from './services/smartOlt.js';
import { extractNapBox } from './utils/parser.js';

// Force DNS resolution using public DNS
dns.setServers(['8.8.8.8', '1.1.1.1']);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.resolve(__dirname, '../data/telecom.db');

async function checkSmartOltAdditions() {
  try {
    console.log('📡 Querying all ONUs from Smart OLT in real-time...');
    const onus = await fetchAllOnus();
    console.log(`✅ Smart OLT returned ${onus.length} ONUs in total.`);

    // 1. Group ONUs from Smart OLT into NAPs
    const syncNapsMap = {};
    const syncOnusMap = new Map();

    onus.forEach((onu) => {
      if (!onu.sn) return;
      const sn = onu.sn.toUpperCase();
      syncOnusMap.set(sn, onu);

      const napName = (onu.odb_name ? onu.odb_name.trim() : '') || (onu.odb ? onu.odb.trim() : '') || extractNapBox(onu.address) || extractNapBox(onu.description);
      if (!napName) return;

      if (!syncNapsMap[napName]) {
        syncNapsMap[napName] = {
          name: napName,
          clients: []
        };
      }
      syncNapsMap[napName].clients.push({
        name: onu.name,
        sn: sn
      });
    });

    // 2. Fetch NAPs currently in SQLite
    const db = new sqlite3.Database(dbPath);
    db.all('SELECT * FROM naps', [], (err, dbRows) => {
      if (err) {
        console.error('Error querying DB:', err);
        process.exit(1);
      }

      const dbNaps = {};
      const dbOnus = new Map();

      dbRows.forEach(row => {
        const clients = JSON.parse(row.clients || '[]');
        dbNaps[row.name.toUpperCase()] = {
          name: row.name,
          clients: clients
        };
        clients.forEach(c => {
          if (c.sn) dbOnus.set(c.sn.toUpperCase(), { client: c, napName: row.name });
        });
      });

      console.log('\n=== COMPARING SMART OLT VS SQLITE DATABASE ===');
      console.log(`NAPs in Smart OLT: ${Object.keys(syncNapsMap).length}`);
      console.log(`NAPs in SQLite:   ${Object.keys(dbNaps).length}`);

      // Check for new NAPs
      const newNaps = [];
      Object.keys(syncNapsMap).forEach(name => {
        if (!dbNaps[name]) {
          newNaps.push(syncNapsMap[name]);
        }
      });

      // Check for new clients
      const newClients = [];
      syncOnusMap.forEach((onu, sn) => {
        if (!dbOnus.has(sn)) {
          const napName = (onu.odb_name ? onu.odb_name.trim() : '') || (onu.odb ? onu.odb.trim() : '') || extractNapBox(onu.address) || extractNapBox(onu.description) || 'Sin NAP';
          newClients.push({
            name: onu.name,
            sn: sn,
            nap: napName
          });
        }
      });

      // Check for clients that were removed
      const removedClients = [];
      dbOnus.forEach((val, sn) => {
        if (!syncOnusMap.has(sn)) {
          removedClients.push({
            name: val.client.name,
            sn: sn,
            nap: val.napName
          });
        }
      });

      console.log('\n📦 Nuevas Cajas NAP detectadas en Smart OLT (no registradas en SQLite):', newNaps.length);
      if (newNaps.length > 0) {
        newNaps.slice(0, 15).forEach(n => {
          console.log(`  - ${n.name} (${n.clients.length} cliente(s) asociados)`);
        });
        if (newNaps.length > 15) console.log(`  ... y ${newNaps.length - 15} cajas más.`);
      }

      console.log('\n👤 Nuevos Clientes detectados en Smart OLT (no registrados en SQLite):', newClients.length);
      if (newClients.length > 0) {
        newClients.slice(0, 15).forEach(c => {
          console.log(`  - ${c.name} (${c.sn}) en caja NAP: ${c.nap}`);
        });
        if (newClients.length > 15) console.log(`  ... y ${newClients.length - 15} clientes más.`);
      }

      console.log('\n❌ Clientes dados de baja o removidos de Smart OLT:', removedClients.length);
      if (removedClients.length > 0) {
        removedClients.slice(0, 15).forEach(c => {
          console.log(`  - ${c.name} (${c.sn}) de la caja NAP: ${c.nap}`);
        });
      }

      db.close();
    });

  } catch (error) {
    console.error('Error performing check:', error);
  }
}

checkSmartOltAdditions();
