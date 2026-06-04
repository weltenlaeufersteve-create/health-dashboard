const { ipcRenderer, shell } = require('electron');
const https  = require('https');
const http   = require('http');
const urlMod = require('url');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const Anthropic = require('@anthropic-ai/sdk');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
// Credentials are read from .env (gitignored) at runtime.
// .env format: line 1 = CLIENT_ID, line 2 = CLIENT_SECRET, line 3 = ANTHROPIC_API_KEY
function loadEnv() {
  try {
    const lines = fs.readFileSync(path.join(__dirname, '.env'), 'utf8')
      .split('\n').map(l => l.trim()).filter(Boolean);
    return {
      CLIENT_ID: lines[0] || '',
      CLIENT_SECRET: lines[1] || '',
      ANTHROPIC_API_KEY: lines[2] || ''
    };
  } catch { return { CLIENT_ID: '', CLIENT_SECRET: '', ANTHROPIC_API_KEY: '' }; }
}
const env = loadEnv();

const CONFIG = {
  CLIENT_ID:     env.CLIENT_ID,
  CLIENT_SECRET: env.CLIENT_SECRET,
  ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
  REDIRECT_PORT: 9876,
  REDIRECT_URI:  'http://localhost:9876/oauth',
  SCOPES: [
    'https://www.googleapis.com/auth/fitness.activity.read',
    'https://www.googleapis.com/auth/fitness.sleep.read',
    'https://www.googleapis.com/auth/fitness.heart_rate.read',
    'https://www.googleapis.com/auth/fitness.body.read',
  ].join(' '),
};

// ─── TOKEN STORAGE ───────────────────────────────────────────────────────────
const TOKEN_DIR  = path.join(process.env.APPDATA || os.homedir(), 'health-dashboard');
const TOKEN_FILE = path.join(TOKEN_DIR, 'tokens.json');
let tokens = null;

function loadTokens() {
  try {
    if (fs.existsSync(TOKEN_FILE))
      tokens = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch {}
}

function saveTokens(t) {
  if (t.expires_in) t = { ...t, expiry_date: Date.now() + t.expires_in * 1000 };
  tokens = t;
  try {
    fs.mkdirSync(TOKEN_DIR, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(t), 'utf8');
  } catch {}
}

function clearTokens() {
  tokens = null;
  try { fs.unlinkSync(TOKEN_FILE); } catch {}
}

// ─── HTTPS HELPERS ────────────────────────────────────────────────────────────
function postForm(apiUrl, body) {
  return new Promise((resolve, reject) => {
    const data   = new URLSearchParams(body).toString();
    const parsed = new URL(apiUrl);
    const req = https.request(
      { hostname: parsed.hostname, path: parsed.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded',
                   'Content-Length': Buffer.byteLength(data) } },
      res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error(d)); } });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function fitRequest(endpoint, body = null) {
  const token = await getValidToken();
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: 'www.googleapis.com', path: endpoint,
        method: body ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } },
      res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error('JSON Parse Error: ' + data)); }
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── AUTH ────────────────────────────────────────────────────────────────────
async function getValidToken() {
  if (!tokens) throw new Error('Nicht eingeloggt');
  if (Date.now() > (tokens.expiry_date || 0) - 60_000) {
    if (!tokens.refresh_token) throw new Error('Kein Refresh Token');
    const fresh = await postForm('https://oauth2.googleapis.com/token', {
      refresh_token: tokens.refresh_token,
      client_id:     CONFIG.CLIENT_ID,
      client_secret: CONFIG.CLIENT_SECRET,
      grant_type:    'refresh_token',
    });
    saveTokens({ ...tokens, ...fresh });
  }
  return tokens.access_token;
}

function startOAuthFlow() {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const parsed = urlMod.parse(req.url, true);
      if (parsed.pathname !== '/oauth') { res.end('Not found'); return; }
      const code = parsed.query.code;
      if (!code) { res.end('Fehler: kein Code'); reject(new Error('No code')); return; }

      res.end('<html><body style="font-family:sans-serif;background:#0d0d1a;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><h2>✓ Verbunden! Du kannst dieses Fenster schließen.</h2></body></html>');
      server.close();

      try {
        const t = await postForm('https://oauth2.googleapis.com/token', {
          code,
          client_id:     CONFIG.CLIENT_ID,
          client_secret: CONFIG.CLIENT_SECRET,
          redirect_uri:  CONFIG.REDIRECT_URI,
          grant_type:    'authorization_code',
        });
        saveTokens(t);
        resolve(t);
      } catch (e) { reject(e); }
    });

    server.listen(CONFIG.REDIRECT_PORT);

    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id',     CONFIG.CLIENT_ID);
    authUrl.searchParams.set('redirect_uri',  CONFIG.REDIRECT_URI);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope',         CONFIG.SCOPES);
    authUrl.searchParams.set('access_type',   'offline');
    authUrl.searchParams.set('prompt',        'consent');
    shell.openExternal(authUrl.toString());
  });
}

// ─── GOOGLE FIT API ──────────────────────────────────────────────────────────
function dayRange(daysAgo = 0) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(0, 0, 0, 0);
  const start = d.getTime();
  d.setHours(23, 59, 59, 999);
  return { start, end: d.getTime() };
}

function nDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

async function fetchSteps7Days() {
  const results = [];
  for (let i = 6; i >= 0; i--) {
    const { start, end } = dayRange(i);
    const resp = await fitRequest('/fitness/v1/users/me/dataset:aggregate', {
      aggregateBy:    [{ dataTypeName: 'com.google.step_count.delta' }],
      bucketByTime:   { durationMillis: 86400000 },
      startTimeMillis: start,
      endTimeMillis:   end,
    });
    const steps = resp.bucket?.[0]?.dataset?.[0]?.point?.[0]?.value?.[0]?.intVal || 0;
    results.push({ label: new Date(start).toLocaleDateString('de-DE', { weekday: 'short' }), steps });
  }
  return results;
}

async function fetchCaloriesToday() {
  const { start, end } = dayRange(0);
  const resp = await fitRequest('/fitness/v1/users/me/dataset:aggregate', {
    aggregateBy:    [{ dataTypeName: 'com.google.calories.expended' }],
    bucketByTime:   { durationMillis: 86400000 },
    startTimeMillis: start,
    endTimeMillis:   end,
  });
  return Math.round(resp.bucket?.[0]?.dataset?.[0]?.point?.[0]?.value?.[0]?.fpVal || 0);
}

async function fetchSleep7Days() {
  const resp = await fitRequest(
    `/fitness/v1/users/me/sessions?startTime=${new Date(nDaysAgo(7)).toISOString()}&endTime=${new Date().toISOString()}&activityType=72`
  );
  const byDay = {};
  (resp.session || []).forEach(s => {
    const label = new Date(parseInt(s.startTimeMillis)).toLocaleDateString('de-DE', { weekday: 'short' });
    byDay[label] = (byDay[label] || 0) + (parseInt(s.endTimeMillis) - parseInt(s.startTimeMillis)) / 3_600_000;
  });
  return Object.entries(byDay).map(([label, hours]) => ({ label, hours: +hours.toFixed(1) }));
}

async function fetchHeartRate7Days() {
  const resp = await fitRequest('/fitness/v1/users/me/dataset:aggregate', {
    aggregateBy:    [{ dataTypeName: 'com.google.heart_rate.bpm' }],
    bucketByTime:   { durationMillis: 86_400_000 },
    startTimeMillis: nDaysAgo(6),
    endTimeMillis:   Date.now(),
  });
  return (resp.bucket || []).map(b => {
    const v = b.dataset?.[0]?.point?.[0]?.value;
    return {
      label: new Date(parseInt(b.startTimeMillis)).toLocaleDateString('de-DE', { weekday: 'short' }),
      avg:   v?.[0]?.fpVal ? Math.round(v[0].fpVal) : null,
      max:   v?.[1]?.fpVal ? Math.round(v[1].fpVal) : null,
      min:   v?.[2]?.fpVal ? Math.round(v[2].fpVal) : null,
    };
  });
}

async function fetchRuns() {
  const resp = await fitRequest(
    `/fitness/v1/users/me/sessions?startTime=${new Date(nDaysAgo(30)).toISOString()}&endTime=${new Date().toISOString()}&activityType=8`
  );
  return (resp.session || []).map(s => ({
    name:        s.name || 'Lauf',
    date:        new Date(parseInt(s.startTimeMillis)).toLocaleDateString('de-DE'),
    durationMin: Math.round((parseInt(s.endTimeMillis) - parseInt(s.startTimeMillis)) / 60_000),
  })).reverse();
}

// ─── AI INSIGHTS (CLAUDE) ─────────────────────────────────────────────────────
function summarizeHealthData(steps, calories, sleep, hr) {
  const stepsArray = steps.map(d => d.steps);
  const sleepArray = sleep.map(d => d.hours);
  const hrArray = hr.map(d => d.avg).filter(v => v !== null);

  return {
    period: 'last 7 days',
    steps: {
      daily: stepsArray,
      total: stepsArray.reduce((a, b) => a + b, 0),
      avg: Math.round(stepsArray.reduce((a, b) => a + b, 0) / stepsArray.length),
      max: Math.max(...stepsArray),
      min: Math.min(...stepsArray),
    },
    sleep: {
      daily: sleepArray,
      total: parseFloat(sleepArray.reduce((a, b) => a + b, 0).toFixed(1)),
      avg: parseFloat((sleepArray.reduce((a, b) => a + b, 0) / sleepArray.length).toFixed(1)),
    },
    heartRate: {
      daily: hrArray,
      avg: hrArray.length > 0 ? Math.round(hrArray.reduce((a, b) => a + b, 0) / hrArray.length) : null,
      max: hrArray.length > 0 ? Math.max(...hrArray) : null,
      min: hrArray.length > 0 ? Math.min(...hrArray) : null,
    },
    calories: calories,
  };
}

async function fetchAIInsights(summary) {
  if (!CONFIG.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured');

  const client = new Anthropic({ apiKey: CONFIG.ANTHROPIC_API_KEY });

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    system: `You are a supportive health coach. Analyze the user's 7-day health metrics and provide:
1. A brief weekly overview (1-2 sentences) of their activity, sleep, and vitals trends
2. Any notable patterns or anomalies you observe
3. 2-3 concrete, actionable suggestions to improve their health

Keep your tone encouraging and practical. Focus on patterns rather than single data points.`,
    messages: [
      {
        role: 'user',
        content: `Here's my health data from the last 7 days: ${JSON.stringify(summary)}`,
      },
    ],
  });

  return message.content[0].type === 'text' ? message.content[0].text : '';
}

function renderInsights(text) {
  const card = $('insights-card');
  const content = $('insights-text');
  if (!card || !content) return;

  content.textContent = text;
  card.classList.remove('hidden');
}

async function loadInsights(steps, calories, sleep, hr) {
  try {
    $('insights-loading').classList.remove('hidden');
    const summary = summarizeHealthData(steps, calories, sleep, hr);
    const insights = await fetchAIInsights(summary);
    renderInsights(insights);
  } catch (e) {
    showError('Error loading insights: ' + e.message);
  } finally {
    $('insights-loading').classList.add('hidden');
  }
}

// ─── UI HELPERS ───────────────────────────────────────────────────────────────
const $      = id => document.getElementById(id);
const charts = {};

function fmt(n) { return Number(n).toLocaleString('de-DE'); }

function destroyChart(id) {
  if (charts[id]) { charts[id].destroy(); delete charts[id]; }
}

const BASE_OPTS = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: { legend: { display: false } },
  scales: {
    x: { ticks: { color: '#7878a0', font: { size: 11 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
    y: { ticks: { color: '#7878a0', font: { size: 11 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
  },
};

function renderSteps(data) {
  destroyChart('steps');
  const today = data[data.length - 1]?.steps || 0;
  $('val-steps').textContent = fmt(today);
  $('sub-steps').textContent = today >= 10000
    ? '✓ Goal reached!'
    : `${fmt(10000 - today)} to go`;

  charts.steps = new Chart($('chart-steps'), {
    type: 'bar',
    data: {
      labels: data.map(d => d.label),
      datasets: [{
        data: data.map(d => d.steps),
        backgroundColor: data.map((_, i) => i === data.length - 1 ? '#5b8cff' : 'rgba(91,140,255,0.35)'),
        borderRadius: 6, borderSkipped: false,
      }],
    },
    options: { ...BASE_OPTS, scales: { ...BASE_OPTS.scales,
      y: { ...BASE_OPTS.scales.y, ticks: { ...BASE_OPTS.scales.y.ticks,
        callback: v => v >= 1000 ? (v / 1000).toFixed(0) + 'k' : v } } } },
  });
}

function renderSleep(data) {
  destroyChart('sleep');
  $('val-sleep').textContent = (data[data.length - 1]?.hours || 0).toFixed(1);

  charts.sleep = new Chart($('chart-sleep'), {
    type: 'bar',
    data: {
      labels: data.map(d => d.label),
      datasets: [{
        data: data.map(d => d.hours),
        backgroundColor: data.map((_, i) => i === data.length - 1 ? '#3dd68c' : 'rgba(61,214,140,0.35)'),
        borderRadius: 6, borderSkipped: false,
      }],
    },
    options: { ...BASE_OPTS, scales: { ...BASE_OPTS.scales,
      y: { ...BASE_OPTS.scales.y, suggestedMax: 10,
        ticks: { ...BASE_OPTS.scales.y.ticks, callback: v => v + 'h' } } } },
  });
}

async function loadHR() {
  try {
    const data = await fetchHeartRate7Days();
    renderHeartRate(data);
  } catch (e) {
    showError('Error loading heart rate: ' + e.message);
  }
}

function renderHeartRate(data) {
  destroyChart('hr');
  const withData = data.filter(d => d.avg !== null);
  if (!withData.length) { $('val-hr').textContent = '–'; return; }

  const today = data[data.length - 1];
  $('val-hr').textContent = today?.avg ?? withData[withData.length - 1].avg;

  charts.hr = new Chart($('chart-hr'), {
    type: 'bar',
    data: {
      labels: data.map(d => d.label),
      datasets: [
        {
          // range bar: min → max
          data: data.map(d => d.avg !== null ? [d.min, d.max] : null),
          backgroundColor: 'rgba(255,92,122,0.2)',
          borderColor: 'rgba(255,92,122,0.5)',
          borderWidth: 1,
          borderRadius: 4,
          borderSkipped: false,
        },
        {
          // average marker: thin white line inside the bar
          data: data.map(d => d.avg !== null ? [d.avg - 1, d.avg + 1] : null),
          backgroundColor: 'rgba(255,255,255,0.55)',
          borderWidth: 0,
          borderRadius: 2,
          borderSkipped: false,
        },
      ],
    },
    options: {
      ...BASE_OPTS,
      grouped: false,
      scales: { ...BASE_OPTS.scales,
        y: { ...BASE_OPTS.scales.y,
          ticks: { ...BASE_OPTS.scales.y.ticks, callback: v => v + ' bpm' } } },
      plugins: {
        ...BASE_OPTS.plugins,
        tooltip: {
          callbacks: {
            label: ctx => {
              const d = data[ctx.dataIndex];
              if (!d.avg) return '';
              return ctx.datasetIndex === 0
                ? `Min ${d.min} – Max ${d.max} bpm`
                : `Avg ${d.avg} bpm`;
            },
          },
        },
      },
    },
  });
}

function renderRuns(runs) {
  const list = $('runs-list');
  list.innerHTML = '';
  if (!runs.length) {
    list.innerHTML = '<p style="color:var(--muted);font-size:12px;padding:8px">No runs in the last 30 days.</p>';
    return;
  }
  runs.slice(0, 12).forEach(r => {
    const h = Math.floor(r.durationMin / 60), m = r.durationMin % 60;
    const row = document.createElement('div');
    row.className = 'run-row';
    row.innerHTML = `
      <span class="run-icon">🏃</span>
      <span class="run-name">${r.name}</span>
      <span class="run-date">${r.date}</span>
      <span class="run-dur">${h > 0 ? h + 'h ' + m + 'min' : m + ' min'}</span>`;
    list.appendChild(row);
  });
}

// ─── VIEW CONTROL ─────────────────────────────────────────────────────────────
function showLogin() {
  $('view-login').classList.remove('hidden');
  $('view-dashboard').classList.add('hidden');
  $('btn-refresh').classList.add('hidden');
  $('btn-logout').classList.add('hidden');
}

function showDashboard() {
  $('view-login').classList.add('hidden');
  $('view-dashboard').classList.remove('hidden');
  $('btn-refresh').classList.remove('hidden');
  $('btn-logout').classList.remove('hidden');
}

function setLoading(on) { $('loading').classList.toggle('hidden', !on); }

function showError(msg) {
  const el = $('error-msg');
  el.textContent = msg;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 5000);
}

let lastData = { steps: null, calories: null, sleep: null, hr: null };

async function loadData() {
  setLoading(true);
  try {
    const [steps, calories, sleep, runs, hr] = await Promise.all([
      fetchSteps7Days(),
      fetchCaloriesToday(),
      fetchSleep7Days(),
      fetchRuns(),
      fetchHeartRate7Days(),
    ]);
    lastData = { steps, calories, sleep, hr };
    renderSteps(steps);
    renderSleep(sleep);
    renderHeartRate(hr);
    renderRuns(runs);
    $('val-cals').textContent = fmt(calories);
    $('last-updated').textContent = 'Updated: ' + new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    await loadInsights(steps, calories, sleep, hr);
  } catch (e) {
    showError('Error loading data: ' + e.message);
  } finally {
    setLoading(false);
  }
}

// ─── INIT ─────────────────────────────────────────────────────────────────────
$('btn-win-minimize').addEventListener('click', () => ipcRenderer.send('win:minimize'));
$('btn-win-maximize').addEventListener('click', () => ipcRenderer.send('win:maximize'));
$('btn-win-close').addEventListener('click',    () => ipcRenderer.send('win:close'));

$('btn-login-big').addEventListener('click', async () => {
  setLoading(true);
  try {
    await startOAuthFlow();
    showDashboard();
    loadData();
  } catch (e) {
    showError('Login failed: ' + e.message);
  } finally {
    setLoading(false);
  }
});

$('btn-refresh').addEventListener('click', loadData);
$('btn-logout').addEventListener('click', () => { clearTokens(); showLogin(); });
$('btn-insights').addEventListener('click', () => {
  if (lastData.steps && lastData.calories !== null && lastData.sleep && lastData.hr) {
    loadInsights(lastData.steps, lastData.calories, lastData.sleep, lastData.hr);
  }
});

loadTokens();
tokens?.access_token ? (showDashboard(), loadData()) : showLogin();
