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

// Which keypad item numbers actually have a motor fitted right now.
// Only "1" is real; add more here as slots are built.
const AVAILABLE_ITEMS = { '1': ITEM_PRICE };

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

// ── STEP 1: check a tapped card - NO deduction here ──────────────────
// This matches the Arduino's "TAP:<uid>" message. It only looks up
// whether the card exists and what its current balance is. It does
// NOT touch the balance - that only happens in dispenseItem() below,
// once the customer has actually picked an item.
function checkCard(db, uid) {
  const cardId = uid.toUpperCase();
  const row = getCard(db, cardId);

  if (!row) {
    logTransaction(db, cardId, 'INVALID', 0);
    console.log('[TAP] %s  INVALID  (not registered)', cardId);
    return { status: 'invalid' };
  }

  console.log('[TAP] %s  OK       bal=%d', cardId, row.balance);
  return { status: 'ok', balance: row.balance };
}

// ── STEP 2: item selected - THIS is where balance actually changes ───
// Matches the Arduino's "SELECT:<uid>:<item>" message, sent only
// after the customer presses a key on the keypad.
function dispenseItem(db, uid, item) {
  const cardId = uid.toUpperCase();
  const row = getCard(db, cardId);

  if (!row) {
    console.log('[SELECT] %s  INVALID  (not registered)', cardId);
    return { status: 'invalid' };
  }

  const price = AVAILABLE_ITEMS[item];
  if (price === undefined) {
    console.log('[SELECT] %s  UNAVAILABLE  item=%s', cardId, item);
    return { status: 'unavailable' };
  }

  if (row.balance < price) {
    logTransaction(db, cardId, 'LOW_BALANCE', row.balance);
    console.log('[SELECT] %s  LOW_BALANCE  bal=%d', cardId, row.balance);
    return { status: 'low_balance', balance: row.balance };
  }

  db.run(
    'UPDATE cards SET balance = balance - ? WHERE card_id = ? AND balance >= ?',
    [price, cardId, price]
  );
  save();
  const updated = getCard(db, cardId);
  logTransaction(db, cardId, 'DISPENSED', updated.balance);
  console.log('[SELECT] %s  DISPENSED  bal=%d', cardId, updated.balance);
  return { status: 'dispensed', balance: updated.balance };
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

    // Step 1: card tapped - just report status + balance, no deduction
    if (trimmed.startsWith('TAP:')) {
      const uid = trimmed.substring(4).trim();
      if (!uid) return;

      const result = checkCard(db, uid);
      if (result.status === 'invalid') {
        port.write('INVALID\n');
      } else {
        port.write('OK:' + result.balance + '\n');
      }
      return;
    }

    // Step 2: item selected - this is where the real deduction happens
    if (trimmed.startsWith('SELECT:')) {
      const parts = trimmed.split(':'); // ['SELECT', uid, item]
      const uid = parts[1] ? parts[1].trim() : '';
      const item = parts[2] ? parts[2].trim() : '';
      if (!uid) return;

      const result = dispenseItem(db, uid, item);

      if (result.status === 'invalid') {
        port.write('INVALID\n');
      } else if (result.status === 'unavailable') {
        port.write('UNAVAILABLE\n');
      } else if (result.status === 'low_balance') {
        port.write('LOWBAL:' + result.balance + '\n');
      } else {
        port.write('DISPENSED:' + result.balance + '\n');
      }
    }
  });
}

// ── Express ─────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// GET /api/card/:id - website lookup, still auto-creates for convenience
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

// POST /api/card/:id/order - website "buy an item" button.
// Mirrors the Arduino's SELECT step: real deduction happens here.
app.post('/api/card/:id/order', async (req, res) => {
  const db = await getDb();
  const cardId = req.params.id.toUpperCase();
  const item = req.body.item || '1';

  ensureCard(db, cardId); // website orders are allowed to auto-register
  const result = dispenseItem(db, cardId, item);

  if (result.status === 'unavailable') {
    return res.status(400).json({ error: 'Item slot not available' });
  }
  if (result.status === 'low_balance') {
    return res.status(400).json({ error: 'Low balance', balance: result.balance });
  }
  res.json({ status: 'dispensed', balance: result.balance });
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