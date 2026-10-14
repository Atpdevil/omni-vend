'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path');
const { getDb, save } = require('./db');

// ── Constants ───────────────────────────────────────────────────────
const ITEM_PRICE = 20;
const STARTING_BALANCE = 100;
const PORT = 3000;

const SERIAL_PORT = process.env.SERIAL_PORT || 'COM5';
const BAUD_RATE = parseInt(process.env.BAUD_RATE, 10) || 9600;

// ── Seed cards ──────────────────────────────────────────────────────
const SEED_CARDS = ['3E300002', 'C1971307', 'D2A10202', '0E810202', 'EB940102'];

async function seedCards(db) {
  const stmt = db.prepare('INSERT OR IGNORE INTO cards (card_id, balance) VALUES (?, ?)');
  for (const id of SEED_CARDS) {
    stmt.run([id, STARTING_BALANCE]);
  }
  stmt.free();
  save();
}

// ── DB helpers ──────────────────────────────────────────────────────
function getCard(db, cardId) {
  const stmt = db.prepare('SELECT card_id, balance FROM cards WHERE card_id = ?');
  stmt.bind([cardId]);
  let row = null;
  if (stmt.step()) {
    row = stmt.getAsObject();
  }
  stmt.free();
  return row;
}

function ensureCard(db, cardId) {
  let row = getCard(db, cardId);
  if (!row) {
    db.run('INSERT INTO cards (card_id, balance) VALUES (?, 0)', [cardId]);
    save();
    row = getCard(db, cardId);
  }
  return row;
}

function logTransaction(db, cardId, result, balance) {
  db.run(
    'INSERT INTO transactions (card_id, result, balance, ts) VALUES (?, ?, ?, datetime(\'now\'))',
    [cardId, result, balance]
  );
  save();
}

function getTransactions(db, limit) {
  const stmt = db.prepare(
    'SELECT id, card_id, result, balance, ts FROM transactions ORDER BY id DESC LIMIT ?'
  );
  stmt.bind([limit]);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

// ── Process a tap (used by both serial and API) ─────────────────────
function processTap(db, uid) {
  const cardId = uid.toUpperCase();
  ensureCard(db, cardId);
  const row = getCard(db, cardId);

  if (row.balance >= ITEM_PRICE) {
    db.run(
      'UPDATE cards SET balance = balance - ? WHERE card_id = ? AND balance >= ?',
      [ITEM_PRICE, cardId, ITEM_PRICE]
    );
    save();
    const updated = getCard(db, cardId);
    logTransaction(db, cardId, 'GRANTED', updated.balance);
    console.log('[TAP] %s  GRANTED  bal=%d', cardId, updated.balance);
    return { status: 'granted', balance: updated.balance };
  }

  logTransaction(db, cardId, 'DENIED', row.balance);
  console.log('[TAP] %s  DENIED   bal=%d', cardId, row.balance);
  return { status: 'low_balance', balance: row.balance };
}

// ── Serial port ─────────────────────────────────────────────────────
async function openSerial(db) {
  let SerialPort, ReadlineParser;
  try {
    const sp = require('serialport');
    SerialPort = sp.SerialPort;
    ReadlineParser = require('@serialport/parser-readline').ReadlineParser;
  } catch (err) {
    console.warn('[SERIAL] serialport package not available: %s', err.message);
    return;
  }

  let port;
  try {
    port = new SerialPort({ path: SERIAL_PORT, baudRate: BAUD_RATE });
  } catch (err) {
    console.warn('[SERIAL] Could not open %s: %s', SERIAL_PORT, err.message);
    console.warn('[SERIAL] Server continues without serial. Plug in the Arduino and restart.');
    return;
  }

  const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));

  port.on('open', () => {
    console.log('[SERIAL] Connected to %s at %d baud', SERIAL_PORT, BAUD_RATE);
  });

  port.on('error', (err) => {
    console.error('[SERIAL] Port error: %s', err.message);
  });

  parser.on('data', (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('TAP:')) return;

    const uid = trimmed.substring(4).trim();
    if (!uid) return;

    const result = processTap(db, uid);

    if (result.status === 'granted') {
      port.write('GRANTED:' + result.balance + '\n');
    } else {
      port.write('DENIED:' + result.balance + '\n');
    }
  });
}

// ── Express ─────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// GET /api/card/:id
app.get('/api/card/:id', async (req, res) => {
  const db = await getDb();
  const row = ensureCard(db, req.params.id.toUpperCase());
  res.json({ card_id: row.card_id, balance: row.balance });
});

// POST /api/card/:id/recharge
app.post('/api/card/:id/recharge', async (req, res) => {
  const db = await getDb();
  const cardId = req.params.id.toUpperCase();
  const amount = parseInt(req.body.amount, 10);

  if (!amount || amount <= 0) {
    return res.status(400).json({ error: 'Amount must be a positive integer' });
  }

  ensureCard(db, cardId);
  db.run('UPDATE cards SET balance = balance + ? WHERE card_id = ?', [amount, cardId]);
  save();

  const row = getCard(db, cardId);
  res.json({ card_id: row.card_id, balance: row.balance });
});

// POST /api/card/:id/tap
app.post('/api/card/:id/tap', async (req, res) => {
  const db = await getDb();
  const result = processTap(db, req.params.id);
  res.json(result);
});

// GET /api/transactions
app.get('/api/transactions', async (_req, res) => {
  const db = await getDb();
  const rows = getTransactions(db, 20);
  res.json(rows);
});

// SPA fallback
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ── Start ───────────────────────────────────────────────────────────
async function start() {
  const db = await getDb();
  await seedCards(db);

  openSerial(db);

  app.listen(PORT, () => {
    console.log('OmniVend server running on http://localhost:%d', PORT);
  });
}

start();
