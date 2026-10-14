'use strict';

// ── DOM refs ────────────────────────────────────────────────────────
const screenEntry     = document.getElementById('screen-entry');
const screenDashboard = document.getElementById('screen-dashboard');
const screenLog       = document.getElementById('screen-log');

const cardInput      = document.getElementById('card-input');
const btnLoad        = document.getElementById('btn-load');
const entryError     = document.getElementById('entry-error');

const dashCardId     = document.getElementById('dash-card-id');
const dashBalance    = document.getElementById('dash-balance');
const rechargeAmount = document.getElementById('recharge-amount');
const btnRecharge    = document.getElementById('btn-recharge');
const rechargeError  = document.getElementById('recharge-error');
const btnLogView     = document.getElementById('btn-log');
const btnBackEntry   = document.getElementById('btn-back-entry');

const logBody        = document.getElementById('log-body');
const btnBackDash    = document.getElementById('btn-back-dash');

// ── State ───────────────────────────────────────────────────────────
let currentCardId = null;
let pollTimer = null;

// ── Helpers ─────────────────────────────────────────────────────────
function showScreen(screen) {
  screenEntry.classList.remove('active');
  screenDashboard.classList.remove('active');
  screenLog.classList.remove('active');
  screen.classList.add('active');

  // Start/stop polling when entering/leaving log screen
  if (screen === screenLog) {
    fetchLog();
    pollTimer = setInterval(fetchLog, 2000);
  } else if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function apiGet(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Request failed');
  return res.json();
}

async function apiPost(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(function () { return {}; });
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

function formatBalance(n) {
  return 'Rs. ' + n;
}

// ── Screen 1: Entry ─────────────────────────────────────────────────
btnLoad.addEventListener('click', loadCard);
cardInput.addEventListener('keydown', function (e) {
  if (e.key === 'Enter') loadCard();
});

async function loadCard() {
  entryError.textContent = '';
  var id = cardInput.value.trim().toUpperCase();
  if (!id) {
    entryError.textContent = 'Enter a card UID.';
    return;
  }

  btnLoad.disabled = true;
  try {
    var data = await apiGet('/api/card/' + encodeURIComponent(id));
    currentCardId = data.card_id;
    dashCardId.textContent = data.card_id;
    dashBalance.textContent = formatBalance(data.balance);
    showScreen(screenDashboard);
  } catch (_err) {
    entryError.textContent = 'Failed to load card. Check the UID.';
  } finally {
    btnLoad.disabled = false;
  }
}

// ── Screen 2: Dashboard ─────────────────────────────────────────────
btnBackEntry.addEventListener('click', function () {
  currentCardId = null;
  cardInput.value = '';
  entryError.textContent = '';
  rechargeError.textContent = '';
  rechargeAmount.value = '';
  showScreen(screenEntry);
});

btnRecharge.addEventListener('click', rechargeCard);
rechargeAmount.addEventListener('keydown', function (e) {
  if (e.key === 'Enter') rechargeCard();
});

async function rechargeCard() {
  rechargeError.textContent = '';
  var amount = parseInt(rechargeAmount.value, 10);
  if (!amount || amount <= 0) {
    rechargeError.textContent = 'Enter a positive amount.';
    return;
  }

  btnRecharge.disabled = true;
  try {
    var data = await apiPost(
      '/api/card/' + encodeURIComponent(currentCardId) + '/recharge',
      { amount: amount }
    );
    dashBalance.textContent = formatBalance(data.balance);
    rechargeAmount.value = '';
  } catch (err) {
    rechargeError.textContent = err.message || 'Recharge failed.';
  } finally {
    btnRecharge.disabled = false;
  }
}

btnLogView.addEventListener('click', function () {
  showScreen(screenLog);
});

// ── Screen 3: Live log ──────────────────────────────────────────────
btnBackDash.addEventListener('click', async function () {
  if (currentCardId) {
    try {
      var data = await apiGet('/api/card/' + encodeURIComponent(currentCardId));
      dashBalance.textContent = formatBalance(data.balance);
    } catch (_err) {
      // stale balance is fine
    }
  }
  showScreen(screenDashboard);
});

async function fetchLog() {
  try {
    var rows = await apiGet('/api/transactions');
    renderLog(rows);
  } catch (_err) {
    // silently retry next cycle
  }
}

function renderLog(rows) {
  if (!rows.length) {
    logBody.innerHTML = '<tr><td colspan="4" class="empty-row">No taps recorded yet</td></tr>';
    return;
  }

  var html = '';
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var cls = r.result === 'GRANTED' ? 'result-granted' : 'result-denied';
    html += '<tr>'
      + '<td>' + escHtml(r.ts) + '</td>'
      + '<td>' + escHtml(r.card_id) + '</td>'
      + '<td class="' + cls + '">' + escHtml(r.result) + '</td>'
      + '<td>Rs. ' + r.balance + '</td>'
      + '</tr>';
  }
  logBody.innerHTML = html;
}

function escHtml(s) {
  var d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
