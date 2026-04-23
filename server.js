const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

const loadEnvFile = (filePath = path.join(__dirname, '.env')) => {
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
};

const requiredEnv = (name) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

const resolveProjectPath = (filePath) => (
  path.isAbsolute(filePath) ? filePath : path.join(__dirname, filePath)
);

loadEnvFile();

const tlsOptions = {
  key:  fs.readFileSync(resolveProjectPath(process.env.TLS_KEY_PATH || 'certs/server.key')),
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
  scope:        process.env.OIDC_SCOPE || 'openid profile email',
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
  const authUrl = `${OIDC_CONFIG.issuer}/login/oauth/authorize?${params}`;
  console.log(`[LOGIN] Redirecting to: ${authUrl}`);
  res.writeHead(302, { Location: authUrl });
  res.end();
};

const handleCallback = async (req, res) => {
  const parsedUrl = new URL(req.url, `https://${req.headers.host}`);
  const code  = parsedUrl.searchParams.get('code');
  const error = parsedUrl.searchParams.get('error');

  if (error) {
    return sendJson(res, 400, { error, description: parsedUrl.searchParams.get('error_description') });
  }
  if (!code) {
    return sendJson(res, 400, { error: 'missing_code' });
  }

  const body = new URLSearchParams({
    grant_type:    'authorization_code',
    code,
    redirect_uri:  OIDC_CONFIG.redirectUri,
    client_id:     OIDC_CONFIG.clientId,
    client_secret: OIDC_CONFIG.clientSecret,
  }).toString();

  try {
    const tokenUrl = `${OIDC_CONFIG.issuer}/api/login/oauth/access_token`;
    console.log(`[CALLBACK] Exchanging code at: ${tokenUrl}`);
    const result = await fetchJson(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
      body,
    });

    if (result.status !== 200 || result.body.error) {
      console.error('[CALLBACK] Token error:', result.body);
      return sendJson(res, 400, { error: 'token_exchange_failed', details: result.body });
    }

    const { access_token, id_token } = result.body;
    console.log('[CALLBACK] Tokens received successfully');

    res.writeHead(302, {
      Location:   '/frontend/index.html?logged_in=1',
      'Set-Cookie': [
        `id_token=${id_token}; HttpOnly; Secure; SameSite=Strict; Path=/`,
        `access_token=${access_token}; HttpOnly; Secure; SameSite=Strict; Path=/`,
      ],
    });
    res.end();
  } catch (err) {
    console.error('[CALLBACK] Error:', err);
    sendJson(res, 500, { error: 'internal_error', message: err.message });
  }
};

const handleUserInfo = async (req, res) => {
  const cookies = parseCookies(req);
  const token   = cookies['access_token'];

  if (!token) {
    return sendJson(res, 401, { error: 'Unauthorized', message: 'No access_token cookie' });
  }

  try {
    const result = await fetchJson(`${OIDC_CONFIG.issuer}/api/userinfo`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (result.status === 401 || result.status === 403) {
      return sendJson(res, 401, { error: 'Unauthorized', message: 'Token invalid or expired' });
    }

    console.log(`[USER-INFO] Status ${result.status}`);
    sendJson(res, result.status, result.body);
  } catch (err) {
    console.error('[USER-INFO] Error:', err);
    sendJson(res, 500, { error: 'internal_error', message: err.message });
  }
};

const handleLogout = (req, res) => {
  res.writeHead(302, {
    Location:   '/frontend/index.html',
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
  const ext = path.extname(filePath);
  const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript' };
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
    res.end(content);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
};

const requestHandler = async (req, res) => {
  const { pathname } = url.parse(req.url);
  console.log(`[${new Date().toISOString()}] ${req.method} ${pathname}`);

  if (pathname === '/' || pathname === '')
    { res.writeHead(302, { Location: '/frontend/index.html' }); return res.end(); }
  if (pathname === '/hello')       return handleHello(req, res);
  if (pathname === '/login')       return handleLogin(req, res);
  if (pathname === '/callback')    return handleCallback(req, res);
  if (pathname === '/user-info')   return handleUserInfo(req, res);
  if (pathname === '/logout')      return handleLogout(req, res);
  if (pathname.startsWith('/frontend')) return handleStatic(req, res);
    sendJson(res, 404, { error: 'Not found' });
};

https.createServer(tlsOptions, requestHandler).listen(443, () => {
  console.log('HTTPS server: https://localhost');
  console.log('  GET /hello       – Lab 2 endpoint');
  console.log('  GET /login       – Start OIDC flow');
  console.log('  GET /callback    – OIDC callback');
  console.log('  GET /user-info   – Protected resource (requires token)');
  console.log('  GET /logout      – Clear cookies');
});

http.createServer((req, res) => {
  res.writeHead(301, { Location: `https://${req.headers.host}${req.url}` });
  res.end();
}).listen(80, () => console.log('HTTP redirect on port 80'));
