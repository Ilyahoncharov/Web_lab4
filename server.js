const https    = require('https');
const http     = require('http');
const fs       = require('fs');
const path     = require('path');
const url      = require('url');
const { WebSocketServer, WebSocket } = require('ws');
const protobuf = require('protobufjs');

const loadEnvFile = (filePath = path.join(__dirname, '.env')) => {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const sep = trimmed.indexOf('=');
    if (sep === -1) continue;
    const key = trimmed.slice(0, sep).trim();
    let val = trimmed.slice(sep + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
};

const requiredEnv = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
};

const resolveProjectPath = (p) =>
  path.isAbsolute(p) ? p : path.join(__dirname, p);

loadEnvFile();

const tlsOptions = {
  key:  fs.readFileSync(resolveProjectPath(process.env.TLS_KEY_PATH  || 'certs/server.key')),
  cert: fs.readFileSync(resolveProjectPath(process.env.TLS_CERT_PATH || 'certs/server.crt')),
  minVersion: 'TLSv1.2',
  maxVersion: 'TLSv1.2',
  ciphers: ['AES128-GCM-SHA256', 'AES256-GCM-SHA384', 'AES128-SHA256', 'AES256-SHA256'].join(':'),
};

const OIDC_CONFIG = {
  issuer:       process.env.OIDC_ISSUER       || 'http://localhost:8000',
  clientId:     requiredEnv('OIDC_CLIENT_ID'),
  clientSecret: requiredEnv('OIDC_CLIENT_SECRET'),
  redirectUri:  process.env.OIDC_REDIRECT_URI  || 'https://localhost/callback',
  scope:        process.env.OIDC_SCOPE         || 'openid profile email',
};

const sendJson = (res, status, obj) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj, null, 2));
};

const parseCookies = (req) => {
  const raw = req.headers.cookie || '';
  return Object.fromEntries(
    raw.split(';').map(c => c.trim().split('=').map(decodeURIComponent))
  );
};

const fetchJson = (targetUrl, options = {}) => new Promise((resolve, reject) => {
  const parsed = new URL(targetUrl);
  const mod = parsed.protocol === 'https:' ? require('https') : require('http');
  const reqOptions = {
    hostname: parsed.hostname,
    port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path:     parsed.pathname + parsed.search,
    method:   options.method || 'GET',
    headers:  options.headers || {},
    rejectUnauthorized: false,
  };
  const req = mod.request(reqOptions, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
      catch { resolve({ status: res.statusCode, body: data }); }
    });
  });
  req.on('error', reject);
  if (options.body) req.write(options.body);
  req.end();
});

let protoRoot       = null;
let ServerMessage   = null;
let ClientMessage   = null;
let PriceUpdateType = null;

protobuf.load(path.join(__dirname, 'proto/messages.proto'))
  .then(root => {
    protoRoot       = root;
    ServerMessage   = root.lookupType('crypto.ServerMessage');
    ClientMessage   = root.lookupType('crypto.ClientMessage');
    PriceUpdateType = root.lookupType('crypto.PriceUpdate');
    console.log('[PROTO] Schema loaded');
    connectBinance();
  })
  .catch(err => console.error('[PROTO] Failed to load schema:', err));

const encodeServerMsg = (payload) => {
  if (!ServerMessage) return null;
  return ServerMessage.encode(ServerMessage.create(payload)).finish();
};

const sendInfo = (ws, text) => {
  const buf = encodeServerMsg({ info: text });
  if (buf && ws.readyState === WebSocket.OPEN) ws.send(buf);
};

const sendError = (ws, text) => {
  const buf = encodeServerMsg({ error: text });
  if (buf && ws.readyState === WebSocket.OPEN) ws.send(buf);
};

const TRACKED_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'ADAUSDT', 'XRPUSDT'];

const sessions = new Map();

function connectBinance() {
  const streams = TRACKED_SYMBOLS
    .map(s => `${s.toLowerCase()}@miniTicker`)
    .join('/');
  const bws = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${streams}`);

  bws.on('open', () => console.log('[BINANCE] Connected'));

  bws.on('message', (raw) => {
    if (!protoRoot) return;
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const ticker = msg.data;
    if (!ticker || !ticker.s) return;

    const symbol    = ticker.s.toUpperCase();
    const price     = ticker.c;
    const open      = ticker.o;
    const changePct = open !== '0'
      ? ((parseFloat(price) - parseFloat(open)) / parseFloat(open) * 100).toFixed(2)
      : '0.00';

    const buf = encodeServerMsg({
      priceUpdate: PriceUpdateType.create({
        symbol, price, changePercent: changePct, timestamp: String(ticker.E),
      }),
    });
    if (!buf) return;

    for (const [clientWs, session] of sessions) {
      if (session.symbols.has(symbol) && clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(buf);
      }
    }
  });

  bws.on('close', () => {
    console.log('[BINANCE] Disconnected — reconnecting in 5 s');
    setTimeout(connectBinance, 5000);
  });

  bws.on('error', (err) => console.error('[BINANCE] Error:', err.message));
}

const validateToken = async (token) => {
  if (!token) return null;
  try {
    const result = await fetchJson(`${OIDC_CONFIG.issuer}/api/userinfo`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return result.status === 200 ? result.body : null;
  } catch { return null; }
};

const handleHello = (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Hello from Goncharov Illia KP-31');
};

const handleLogin = (req, res) => {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     OIDC_CONFIG.clientId,
    redirect_uri:  OIDC_CONFIG.redirectUri,
    scope:         OIDC_CONFIG.scope,
    state:         Math.random().toString(36).slice(2),
  });
  res.writeHead(302, { Location: `${OIDC_CONFIG.issuer}/login/oauth/authorize?${params}` });
  res.end();
};

const handleCallback = async (req, res) => {
  const parsedUrl = new URL(req.url, `https://${req.headers.host}`);
  const code  = parsedUrl.searchParams.get('code');
  const error = parsedUrl.searchParams.get('error');

  if (error) return sendJson(res, 400, { error, description: parsedUrl.searchParams.get('error_description') });
  if (!code) return sendJson(res, 400, { error: 'missing_code' });

  const body = new URLSearchParams({
    grant_type:    'authorization_code',
    code,
    redirect_uri:  OIDC_CONFIG.redirectUri,
    client_id:     OIDC_CONFIG.clientId,
    client_secret: OIDC_CONFIG.clientSecret,
  }).toString();

  try {
    const result = await fetchJson(`${OIDC_CONFIG.issuer}/api/login/oauth/access_token`, {
      method: 'POST',
      headers: {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
      body,
    });

    if (result.status !== 200 || result.body.error) {
      return sendJson(res, 400, { error: 'token_exchange_failed', details: result.body });
    }

    const { access_token, id_token } = result.body;
    res.writeHead(302, {
      Location: '/frontend/index.html?logged_in=1',
      'Set-Cookie': [
        `id_token=${id_token}; HttpOnly; Secure; SameSite=Strict; Path=/`,
        `access_token=${access_token}; HttpOnly; Secure; SameSite=Strict; Path=/`,
      ],
    });
    res.end();
  } catch (err) {
    sendJson(res, 500, { error: 'internal_error', message: err.message });
  }
};

const handleUserInfo = async (req, res) => {
  const token = parseCookies(req)['access_token'];
  if (!token) return sendJson(res, 401, { error: 'Unauthorized', message: 'No access_token cookie' });

  try {
    const result = await fetchJson(`${OIDC_CONFIG.issuer}/api/userinfo`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (result.status === 401 || result.status === 403)
      return sendJson(res, 401, { error: 'Unauthorized', message: 'Token invalid or expired' });
    sendJson(res, result.status, result.body);
  } catch (err) {
    sendJson(res, 500, { error: 'internal_error', message: err.message });
  }
};

const handleLogout = (req, res) => {
  res.writeHead(302, {
    Location: '/frontend/index.html',
    'Set-Cookie': [
      'id_token=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0',
      'access_token=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0',
    ],
  });
  res.end();
};

const handleStatic = (req, res) => {
  const { pathname } = url.parse(req.url);
  const filePath = path.join(__dirname, pathname === '/frontend/' ? '/frontend/index.html' : pathname);
  const ext  = path.extname(filePath);
  const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.proto': 'text/plain' };
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
};

const requestHandler = async (req, res) => {
  const { pathname } = url.parse(req.url);
  if (pathname === '/' || pathname === '')
    { res.writeHead(302, { Location: '/frontend/index.html' }); return res.end(); }
  if (pathname === '/hello')     return handleHello(req, res);
  if (pathname === '/login')     return handleLogin(req, res);
  if (pathname === '/callback')  return handleCallback(req, res);
  if (pathname === '/user-info') return handleUserInfo(req, res);
  if (pathname === '/logout')    return handleLogout(req, res);
  if (pathname.startsWith('/frontend') || pathname.startsWith('/proto'))
    return handleStatic(req, res);
  sendJson(res, 404, { error: 'Not found' });
};

const server = https.createServer(tlsOptions, requestHandler);
const wss    = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', async (ws, req) => {
  const token = parseCookies(req)['access_token'];
  const user  = await validateToken(token);

  if (!user) {
    sendError(ws, 'Unauthorized: invalid or missing token');
    ws.close(4401, 'Unauthorized');
    return;
  }

  const userId  = user.sub || user.preferred_username || 'unknown';
  const session = { userId, symbols: new Set() };
  sessions.set(ws, session);

  console.log(`[WS] Session opened: ${userId}`);
  sendInfo(ws, `Welcome, ${user.name || user.preferred_username}! Send a subscribe message to start streaming.`);

  ws.on('message', (data) => {
    if (!ClientMessage) return;
    try {
      const msg = ClientMessage.decode(new Uint8Array(data));
      session.symbols = new Set(msg.symbols.map(s => s.toUpperCase()));
      sendInfo(ws, `Subscribed to: ${[...session.symbols].join(', ') || 'none'}`);
    } catch {
      sendError(ws, 'Invalid message format');
    }
  });

  ws.on('close', () => {
    sessions.delete(ws);
    console.log(`[WS] Session closed: ${userId}`);
  });

  ws.on('error', (err) => console.error(`[WS] Error (${userId}):`, err.message));
});

server.listen(443, () => {
  console.log('HTTPS/WSS server: https://localhost');
  console.log('  GET /hello | GET /login | GET /callback | GET /user-info | GET /logout');
  console.log('  WSS /ws');
});

http.createServer((req, res) => {
  res.writeHead(301, { Location: `https://${req.headers.host}${req.url}` });
  res.end();
}).listen(80, () => console.log('HTTP redirect on port 80'));
