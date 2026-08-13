import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseCsvLine(line) {
  const cols = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      cols.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  cols.push(current.trim());
  return cols;
}

const csvPath = path.resolve(__dirname, './public/coordenadas_mymaps.csv');
const dbPath = path.resolve(__dirname, '../data/telecom.db');

const text = fs.readFileSync(csvPath, 'utf8');
const lines = text.split(/\r?\n/);
const csvNaps = {};

for (let i = 1; i < lines.length; i++) {
  const line = lines[i].trim();
  if (!line) continue;
  const cols = parseCsvLine(line);
  if (cols.length < 4) continue;
  const name = cols[1].trim().toUpperCase();
  const lat = parseFloat(cols[2]);
  const lng = parseFloat(cols[3]);
  if (name && !isNaN(lat) && !isNaN(lng)) {
    csvNaps[name] = { lat, lng };
  }
}

const db = new sqlite3.Database(dbPath);
db.all('SELECT name, latitude, longitude FROM naps', [], (err, rows) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log('--- ANALYSIS RESULTS ---');
  console.log('Total unique NAPs in CSV:', Object.keys(csvNaps).length);
  console.log('Total NAPs in SQLite:', rows.length);
  
  let matchCount = 0;
  let missingCoordsInSql = 0;
  let canBeRestored = 0;
  const missingInCsv = [];
  
  rows.forEach(row => {
    const dbName = row.name.toUpperCase();
    const csvMatch = csvNaps[dbName];
    if (csvMatch) {
      matchCount++;
      if (row.latitude === null || row.latitude === 0) {
        canBeRestored++;
      }
    } else {
      missingInCsv.push(row.name);
    }
    if (row.latitude === null || row.latitude === 0) {
      missingCoordsInSql++;
    }
  });
  
  console.log('NAPs in SQLite that match CSV:', matchCount);
  console.log('NAPs in SQLite missing coordinates:', missingCoordsInSql);
  console.log('NAPs missing coordinates that can be restored from CSV:', canBeRestored);
  console.log('NAPs in SQLite not found in CSV:', missingInCsv.length);
  db.close();
});
