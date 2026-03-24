const express = require('express');
const cors = require('cors');
const http = require('http');
const session = require('express-session');
const { Server } = require('socket.io');
const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' },
    pingTimeout: 60000,
    pingInterval: 25000
});

const PORT = 9100;
const CONNECTIONS_FILE = path.join(__dirname, 'connections.json');
const PASSCODE_FILE = path.join(__dirname, 'passcode.json');
const WEATHER_FILE = path.join(__dirname, 'weather.json');


// ============================================================
// MIDDLEWARE
// ============================================================

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
}));

// Trust proxy - required when behind nginx/Cloudflare
app.set('trust proxy', 1);

// Session middleware
app.use(session({
    secret: 'dgx-spark-session-' + (Date.now().toString(36)),
    resave: false,
    saveUninitialized: false,
    name: 'dgx_spark_sid',
    cookie: {
        maxAge: 24 * 60 * 60 * 1000,  // 24 hours
        httpOnly: true,
        secure: false,      // Set false so it works on both HTTP and HTTPS
        sameSite: 'lax'
    }
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));  // For HTML form POST

// ============================================================
// CONNECTION STORAGE
// ============================================================

function loadConnections() {
    try {
        if (fs.existsSync(CONNECTIONS_FILE)) {
            return JSON.parse(fs.readFileSync(CONNECTIONS_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('Error loading connections:', e);
    }
    return { clusters: [] };
}

function saveConnections(data) {
    fs.writeFileSync(CONNECTIONS_FILE, JSON.stringify(data, null, 2));
}

if (!fs.existsSync(CONNECTIONS_FILE)) {
    saveConnections({ clusters: [] });
}

// ============================================================
// PASSCODE STORAGE
// ============================================================

function loadPasscode() {
    try {
        if (fs.existsSync(PASSCODE_FILE)) {
            const data = JSON.parse(fs.readFileSync(PASSCODE_FILE, 'utf8'));
            return data.passcode || 'spark';
        }
    } catch (e) {
        console.error('Error loading passcode:', e);
    }
    return 'spark';
}

function savePasscode(newCode) {
    fs.writeFileSync(PASSCODE_FILE, JSON.stringify({ passcode: newCode }, null, 2));
}

if (!fs.existsSync(PASSCODE_FILE)) {
    savePasscode('spark');
}

// WEATHER CONFIGURATION
const DEFAULT_WEATHER = {};

function loadWeatherConfig() {
    try {
        if (fs.existsSync(WEATHER_FILE)) {
            return JSON.parse(fs.readFileSync(WEATHER_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('Error loading weather config:', e);
    }
    return { ...DEFAULT_WEATHER };
}

function saveWeatherConfig(config) {
    fs.writeFileSync(WEATHER_FILE, JSON.stringify(config, null, 2));
}

if (!fs.existsSync(WEATHER_FILE)) {
    saveWeatherConfig({});
    console.log('[Weather] Initialized empty weather config');
}


// ============================================================
// SESSION AUTH MIDDLEWARE
// ============================================================

function requireAuth(req, res, next) {
    if (req.session && req.session.authenticated) {
        return next();
    }
    // For API routes, return 401 JSON
    if (req.path.startsWith('/api/')) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
    }
    // For page routes, redirect to login
    return res.redirect('/');
}


// ============================================================
// LOGIN PAGE HTML (server-rendered, zero JavaScript dependency)
// ============================================================

function getLoginPageHTML(errorMsg) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="icon" type="image/svg+xml" href="/favicon.svg?v=1774200162">
    <link rel="icon" type="image/x-icon" href="/favicon.ico?v=1774200162">
    <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png?v=1774200162">
    <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png?v=1774200162">
    <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png?v=1774200162">
    <title>DGX Spark — Access</title>
    <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=JetBrains+Mono:wght@300;400;500;700&family=Rajdhani:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <style>
        *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
        :root {
            --bg-deep: #05050f;
            --bg-card: rgba(10, 10, 30, 0.95);
            --neon-purple: #bf00ff;
            --neon-cyan: #00e5ff;
            --neon-green: #39ff14;
            --neon-red: #ff0040;
            --text-primary: rgba(255,255,255,0.92);
            --text-dim: rgba(255,255,255,0.4);
        }
        body {
            background: var(--bg-deep);
            color: var(--text-primary);
            font-family: "JetBrains Mono", monospace;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            overflow: hidden;
        }
        /* Animated background grid */
        body::before {
            content: "";
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            background:
                linear-gradient(rgba(191,0,255,0.03) 1px, transparent 1px),
                linear-gradient(90deg, rgba(191,0,255,0.03) 1px, transparent 1px);
            background-size: 40px 40px;
            z-index: -1;
            animation: gridPulse 4s ease-in-out infinite;
        }
        @keyframes gridPulse {
            0%, 100% { opacity: 0.5; }
            50% { opacity: 1; }
        }
        /* Glow orbs */
        body::after {
            content: "";
            position: fixed;
            top: 50%; left: 50%;
            width: 1200px; height: 1200px;
            transform: translate(-50%, -50%);
            background: radial-gradient(circle, rgba(191,0,255,0.08) 0%, transparent 70%);
            z-index: -1;
        }
        .login-container {
            background: var(--bg-card);
            border: 1px solid var(--neon-purple);
            border-radius: 12px;
            padding: 3rem 2.5rem;
            text-align: center;
            min-width: 380px;
            max-width: 420px;
            box-shadow:
                0 0 40px rgba(191,0,255,0.15),
                inset 0 0 30px rgba(0,0,0,0.3);
            position: relative;
        }
        .login-container::before {
            content: "";
            position: absolute;
            top: -1px; left: -1px; right: -1px; bottom: -1px;
            border-radius: 12px;
            background: linear-gradient(135deg, var(--neon-purple), var(--neon-cyan), var(--neon-purple));
            z-index: -1;
            opacity: 0.3;
        }
        .lock-icon {
            font-size: 3rem;
            margin-bottom: 1rem;
            display: block;
            filter: drop-shadow(0 0 10px var(--neon-purple));
        }
        .login-title {
            font-family: "Orbitron", monospace;
            font-size: 1.2rem;
            color: var(--neon-purple);
            letter-spacing: 3px;
            margin-bottom: 0.5rem;
            text-transform: uppercase;
        }
        .login-subtitle {
            font-size: 0.75rem;
            color: var(--text-dim);
            margin-bottom: 2rem;
        }
        .pin-form {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 1.5rem;
        }
        .password-input {
            width: 100%;
            max-width: 300px;
            height: 50px;
            background: rgba(0,0,0,0.4);
            border: 1px solid rgba(191,0,255,0.4);
            border-radius: 8px;
            color: var(--neon-cyan);
            font-family: "JetBrains Mono", monospace;
            font-size: 1rem;
            text-align: center;
            outline: none;
            padding: 0 1rem;
            transition: all 0.3s ease;
            letter-spacing: 2px;
        }
        .password-input:focus {
            border-color: var(--neon-cyan);
            box-shadow: 0 0 15px rgba(0,229,255,0.3);
            background: rgba(0,229,255,0.05);
        }
        .password-input::placeholder {
            color: var(--text-dim);
            letter-spacing: 1px;
            font-size: 0.85rem;
        }
        .submit-btn {
            width: 100%;
            max-width: 260px;
            padding: 0.9rem 2rem;
            background: linear-gradient(135deg, rgba(191,0,255,0.2), rgba(0,229,255,0.2));
            border: 1px solid var(--neon-purple);
            border-radius: 8px;
            color: var(--neon-purple);
            font-family: "Orbitron", monospace;
            font-size: 0.85rem;
            letter-spacing: 3px;
            text-transform: uppercase;
            cursor: pointer;
            transition: all 0.3s ease;
        }
        .submit-btn:hover {
            background: linear-gradient(135deg, rgba(191,0,255,0.35), rgba(0,229,255,0.35));
            box-shadow: 0 0 20px rgba(191,0,255,0.3);
            transform: translateY(-1px);
        }
        .submit-btn:active {
            transform: translateY(0);
        }
        .error-msg {
            color: var(--neon-red);
            font-family: "JetBrains Mono", monospace;
            font-size: 0.8rem;
            min-height: 1.2em;
            text-shadow: 0 0 10px rgba(255,0,64,0.5);
            letter-spacing: 1px;
        }
        .back-link {
            display: inline-block;
            margin-top: 1.5rem;
            color: var(--text-dim);
            font-size: 0.7rem;
            text-decoration: none;
            letter-spacing: 1px;
            transition: color 0.3s ease;
        }
        .back-link:hover {
            color: var(--neon-cyan);
        }
        /* Scanline effect */
        .scanline {
            position: fixed;
            top: 0; left: 0; right: 0;
            height: 2px;
            background: rgba(191,0,255,0.1);
            animation: scan 8s linear infinite;
            pointer-events: none;
            z-index: 9999;
        }
        @keyframes scan {
            0% { top: 0; }
            100% { top: 100vh; }
        }
        /* Mobile: fix login container for small screens */
        @media (max-width: 480px) {
            .login-container {
                min-width: unset;
                width: calc(100% - 32px);
                max-width: 420px;
                padding: 2rem 1.5rem;
                margin: 0 16px;
            }
            .login-title {
                font-size: 1rem;
                letter-spacing: 2px;
            }
            .password-input {
                max-width: 260px;
                height: 46px;
                font-size: 0.9rem;
            }
            .submit-btn {
                max-width: 220px;
                padding: 0.8rem 1.5rem;
                font-size: 0.75rem;
                letter-spacing: 2px;
            }
            .lock-icon {
                font-size: 2.5rem;
            }
        }
    </style>
</head>
<body>
    <canvas id="neural-bg" style="position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:-3;pointer-events:none;"></canvas>
    <div class="scanline"></div>
    <div class="login-container">
        <span class="lock-icon">\u{1F512}</span>
        <h1 class="login-title">Access Required</h1>
        <p class="login-subtitle">DGX Spark &bull; Connections Management</p>

        ${errorMsg ? '<p class="error-msg">' + errorMsg + '</p>' : ''}

        <form class="pin-form" method="POST" action="/auth/connections">
            <input class="password-input" type="password" name="password" placeholder="Enter password" required autofocus autocomplete="current-password">
            <button type="submit" class="submit-btn">Authenticate</button>
        </form>

        <a href="/" class="back-link">&larr; Return to Dashboard</a>
    </div>

    <!-- No JavaScript required for password form -->

    <script src="/neural-bg.js"></script>
</body>
</html>`;
}

// ============================================================
// AUTH ROUTES (pure HTML form-based, no JS needed)
// ============================================================

// GET /connections-login — serve the login page
app.get('/connections-login', (req, res) => {
    // If already authenticated, redirect to connections
    if (req.session && req.session.authenticated) {
        return res.redirect('/connections');
    }
    const error = req.query.error ? 'ACCESS DENIED — Invalid Password' : '';
    res.send(getLoginPageHTML(error));
});

// POST /auth/connections — validate passcode via form POST
app.post('/auth/connections', (req, res) => {
    // Read password from form
    const password = req.body.password || '';

    const stored = loadPasscode();
    if (password === stored) {
        // Set session as authenticated
        req.session.authenticated = true;
        req.session.save(() => {
            res.redirect('/connections');
        });
    } else {
        res.redirect('/connections-login?error=1');
    }
});


// WEATHER CONFIG API
// GET /api/weather/config — public, returns lat/lon/city/state/zip for dashboard widget
app.get('/api/weather/config', (req, res) => {
    const config = loadWeatherConfig();
    res.json(config);
});

// POST /api/weather/config — protected, update weather zip code
app.post('/api/weather/config', requireAuth, async (req, res) => {
    const { zipCode } = req.body;
    if (!zipCode || !/^\d{5}$/.test(zipCode)) {
        return res.status(400).json({ success: false, error: 'Please enter a valid 5-digit US zip code' });
    }

    try {
        // Use Open-Meteo geocoding API to resolve zip code to coordinates
        const https = require('https');
        const geocodeUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${zipCode}&count=1&language=en&format=json&country=US`;

        const geoData = await new Promise((resolve, reject) => {
            https.get(geocodeUrl, (response) => {
                let data = '';
                response.on('data', chunk => data += chunk);
                response.on('end', () => {
                    try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
                });
            }).on('error', reject);
        });

        // Open-Meteo geocoding might not find zip codes directly, fallback to nominatim
        let latitude, longitude, city, state;

        if (geoData.results && geoData.results.length > 0) {
            const result = geoData.results[0];
            latitude = result.latitude;
            longitude = result.longitude;
            city = result.name || '';
            state = result.admin1 || '';
        } else {
            // Fallback: Use Nominatim (OpenStreetMap) geocoding for US zip codes
            const nomUrl = `https://nominatim.openstreetmap.org/search?postalcode=${zipCode}&country=US&format=json&limit=1`;
            const nomData = await new Promise((resolve, reject) => {
                https.get(nomUrl, { headers: { 'User-Agent': 'DGX-Spark-Dashboard/1.0' } }, (response) => {
                    let data = '';
                    response.on('data', chunk => data += chunk);
                    response.on('end', () => {
                        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
                    });
                }).on('error', reject);
            });

            if (nomData && nomData.length > 0) {
                latitude = parseFloat(nomData[0].lat);
                longitude = parseFloat(nomData[0].lon);
                // Parse display_name for city/state
                const parts = (nomData[0].display_name || '').split(',').map(s => s.trim());
                city = parts[0] || '';
                state = parts.length >= 3 ? parts[parts.length - 2] : '';
            } else {
                return res.status(404).json({ success: false, error: `Could not find location for zip code ${zipCode}` });
            }
        }

        const config = { zipCode, city, state, latitude, longitude };
        saveWeatherConfig(config);
        console.log(`[Weather] Updated: ${city}, ${state} ${zipCode} (${latitude}, ${longitude})`);
        res.json({ success: true, config });
    } catch (e) {
        console.error('[Weather] Geocoding error:', e);
        res.status(500).json({ success: false, error: 'Failed to geocode zip code: ' + e.message });
    }
});


// DELETE /api/weather/config — protected, clear weather location
app.delete('/api/weather/config', requireAuth, (req, res) => {
    try {
        saveWeatherConfig({});
        console.log('[Weather] Location cleared by user');
        res.json({ success: true, message: 'Weather location cleared' });
    } catch (e) {
        console.error('[Weather] Failed to clear config:', e);
        res.status(500).json({ success: false, error: 'Failed to clear weather config' });
    }
});

// GET /api/auth/status — check if user is authenticated (for conditional UI)
app.get('/api/auth/status', (req, res) => {
    const authenticated = !!(req.session && req.session.authenticated);
    res.json({ authenticated });
});

// GET /auth/logout
app.get('/auth/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/');
    });
});

// ============================================================
// PROTECTED PAGE ROUTES (before static middleware)
// ============================================================

// Intercept GET /connections — require auth (clean URL)
app.get('/connections', (req, res, next) => {
    if (req.session && req.session.authenticated) {
        return res.sendFile(path.join(__dirname, 'public', 'connections.html'));
    }
    return res.redirect('/connections-login');
});

// Redirect /connections.html to clean URL /connections
app.get('/connections.html', (req, res) => {
    return res.redirect(301, '/connections');
});

// ============================================================
// STATIC FILES (everything except connections.html is public)
// ============================================================

// Disable caching for JS/CSS files to prevent stale browser cache
app.use((req, res, next) => {
    if (req.url.match(/\.(js|css|html)$/)) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    }
    next();
});
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// REST API - Connection Management (protected)
// ============================================================

app.get('/api/connections', (req, res) => {
    const data = loadConnections();
    const masked = JSON.parse(JSON.stringify(data));
    masked.clusters.forEach(cluster => {
        cluster.nodes.forEach(node => {
            if (node.password) node.password = '********';
        });
    });
    res.json(masked);
});

app.get('/api/connections/raw', requireAuth, (req, res) => {
    const data = loadConnections();
    res.json(data);
});

app.post('/api/connections', requireAuth, (req, res) => {
    try {
        const data = req.body;
        if (!data.clusters || !Array.isArray(data.clusters)) {
            return res.status(400).json({ error: 'Invalid data structure' });
        }
        saveConnections(data);
        res.json({ success: true, message: 'Connections saved' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ============================================================
// REST API - Passcode Management (protected)
// ============================================================

// Keep verify-passcode for backward compat (also sets session)
app.post('/api/verify-passcode', (req, res) => {
    const { passcode } = req.body;
    const stored = loadPasscode();
    if (passcode === stored) {
        req.session.authenticated = true;
        req.session.save(() => {
            res.json({ success: true });
        });
    } else {
        res.status(401).json({ success: false, error: 'Invalid passcode' });
    }
});

app.post('/api/change-passcode', requireAuth, (req, res) => {
    const { currentPasscode, newPasscode } = req.body;
    const stored = loadPasscode();
    console.log('[DEBUG change-passcode] body:', JSON.stringify(req.body));
    console.log('[DEBUG change-passcode] currentPasscode:', JSON.stringify(currentPasscode), 'stored:', JSON.stringify(stored), 'match:', currentPasscode === stored);
    console.log('[DEBUG change-passcode] newPasscode:', JSON.stringify(newPasscode), 'length:', newPasscode ? newPasscode.length : 0);
    if (currentPasscode !== stored) {
        return res.status(401).json({ success: false, error: 'Current password is incorrect' });
    }
    if (!newPasscode || newPasscode.length < 5) {
        return res.status(400).json({ success: false, error: 'New password must be at least 5 characters' });
    }
    savePasscode(newPasscode);
    res.json({ success: true, message: 'Password updated successfully' });
});

app.post('/api/test-connection', requireAuth, (req, res) => {
    const { host, port, username, password } = req.body;
    const conn = new Client();
    let responded = false;

    const timeout = setTimeout(() => {
        if (!responded) {
            responded = true;
            conn.end();
            res.json({ success: false, error: 'Connection timed out after 10s' });
        }
    }, 10000);

    conn.on('ready', () => {
        clearTimeout(timeout);
        if (!responded) {
            responded = true;
            conn.exec('hostname', (err, stream) => {
                if (err) {
                    conn.end();
                    return res.json({ success: true, hostname: 'connected' });
                }
                let output = '';
                stream.on('data', (data) => { output += data.toString(); });
                stream.on('close', () => {
                    conn.end();
                    res.json({ success: true, hostname: output.trim() });
                });
            });
        }
    });

    conn.on('error', (err) => {
        clearTimeout(timeout);
        if (!responded) {
            responded = true;
            res.json({ success: false, error: err.message });
        }
    });

    conn.connect({
        host: host,
        port: parseInt(port) || 22,
        username: username,
        password: password,
        readyTimeout: 10000,
        algorithms: {
            kex: [
                'ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521',
                'diffie-hellman-group-exchange-sha256', 'diffie-hellman-group14-sha256',
                'diffie-hellman-group14-sha1', 'diffie-hellman-group-exchange-sha1',
                'diffie-hellman-group1-sha1'
            ]
        }
    });
});

// ============================================================
// METRIC PARSING ENGINE
// ============================================================

// Per-node network byte tracking for throughput deltas
const networkHistory = {};

function parseMemory(text) {
    // Parse output of free -m
    // Expected lines like:
    //               total        used        free      shared  buff/cache   available
    // Mem:          xxxxx       xxxxx       xxxxx       xxxxx       xxxxx       xxxxx
    // Swap:         xxxxx       xxxxx       xxxxx
    try {
        const lines = text.trim().split('\n');
        let memLine = null;
        let swapLine = null;
        for (const line of lines) {
            if (line.startsWith('Mem:')) memLine = line;
            if (line.startsWith('Swap:')) swapLine = line;
        }
        if (!memLine) return null;

        const memParts = memLine.split(/\s+/);
        const total = parseInt(memParts[1]) || 0;
        const used = parseInt(memParts[2]) || 0;
        const free = parseInt(memParts[3]) || 0;
        const shared = parseInt(memParts[4]) || 0;
        const buffCache = parseInt(memParts[5]) || 0;
        const available = parseInt(memParts[6]) || 0;
        const percent = total > 0 ? Math.round((used / total) * 100) : 0;

        let swapTotal = 0, swapUsed = 0, swapPercent = 0;
        if (swapLine) {
            const swapParts = swapLine.split(/\s+/);
            swapTotal = parseInt(swapParts[1]) || 0;
            swapUsed = parseInt(swapParts[2]) || 0;
            swapPercent = swapTotal > 0 ? Math.round((swapUsed / swapTotal) * 100) : 0;
        }

        return {
            type: 'memory',
            total, used, free, shared, buffCache, available, percent,
            swapTotal, swapUsed, swapPercent
        };
    } catch (e) {
        return null;
    }
}

function parseNetwork(text, nodeKey) {
    // Parse ethtool output for RDMA bytes
    // Lines like: rx_vport_rdma_unicast_bytes: 123456789
    try {
        let rx = 0, tx = 0;
        const lines = text.trim().split('\n');
        for (const line of lines) {
            if (line.includes('rx_vport_rdma_unicast_bytes')) {
                const match = line.match(/(\d+)/);
                if (match) rx += parseInt(match[1]);
            }
            if (line.includes('tx_vport_rdma_unicast_bytes')) {
                const match = line.match(/(\d+)/);
                if (match) tx += parseInt(match[1]);
            }
        }

        // Calculate throughput delta
        let rxRate = 0, txRate = 0;
        const now = Date.now();
        if (!networkHistory[nodeKey]) {
            networkHistory[nodeKey] = { rx, tx, time: now };
        } else {
            const prev = networkHistory[nodeKey];
            const elapsed = (now - prev.time) / 1000; // seconds
            if (elapsed > 0 && elapsed < 10) {
                rxRate = Math.max(0, (rx - prev.rx) / elapsed);
                txRate = Math.max(0, (tx - prev.tx) / elapsed);
            }
            networkHistory[nodeKey] = { rx, tx, time: now };
        }
        return {
            type: 'network',
            rx, tx, rxRate, txRate
        };
    } catch (e) {
        return null;
    }
}

function parseBmon(text) {
    // Parse bandwidth data from /sys/class/net stats reader
    try {
        // Strip ANSI codes
        const clean = text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
                         .replace(/\x1b\([A-Z]/g, '')
                         .replace(/\[\?[0-9;]*[a-zA-Z]/g, '')
                         .replace(/[\x00-\x09\x0b-\x0c\x0e-\x1f]/g, '');

        // Match "RX: <number> B/s TX: <number> B/s"
        const rxMatch = clean.match(/RX:\s*(\d+)\s*B\/s/i);
        const txMatch = clean.match(/TX:\s*(\d+)\s*B\/s/i);

        if (rxMatch && txMatch) {
            const rxBytes = parseInt(rxMatch[1]);
            const txBytes = parseInt(txMatch[1]);
            return {
                type: 'bandwidth',
                rxRate: fmtBw(rxBytes) + '/s',
                txRate: fmtBw(txBytes) + '/s',
                rxBytes: rxBytes,
                txBytes: txBytes
            };
        }

        // Fallback: try generic RX/TX patterns
        const rxGeneric = clean.match(/RX[:\s]+([\d.]+\s*[KMGT]?i?B(?:\/s)?)/i);
        const txGeneric = clean.match(/TX[:\s]+([\d.]+\s*[KMGT]?i?B(?:\/s)?)/i);
        if (rxGeneric || txGeneric) {
            return {
                type: 'bandwidth',
                rxRate: rxGeneric ? rxGeneric[1] : '0 B/s',
                txRate: txGeneric ? txGeneric[1] : '0 B/s'
            };
        }

        return null;
    } catch (e) {
        return null;
    }
}

function fmtBw(bytes) {
    if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + ' GiB';
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(2) + ' MiB';
    if (bytes >= 1024) return (bytes / 1024).toFixed(2) + ' KiB';
    return bytes + ' B';
}

function parseGpu(text) {
    // Parse nvidia-smi --query-gpu CSV output
    // Input is already split by ---REFRESH--- markers by the text-type handler
    // Format: "utilization [%], temperature [C], power [W]"
    // Example: "78, 52, 85.43"
    try {
        if (!text || !text.trim()) return null;

        // Get non-empty lines, skip any header/error lines
        const dataLines = text.split('\n').filter(l => {
            const t = l.trim();
            return t.length > 0 && /\d/.test(t) && !t.includes('nvidia-smi') && !t.includes('not available');
        });
        if (dataLines.length === 0) return null;

        // Take the last valid data line
        const lastLine = dataLines[dataLines.length - 1].trim();

        // Parse comma-separated or space-separated numbers
        const parts = lastLine.split(/[,\s]+/).map(s => parseFloat(s)).filter(n => !isNaN(n));

        if (parts.length >= 3) {
            return {
                type: 'gpu',
                utilization: Math.round(parts[0]) || 0,
                temperature: Math.round(parts[1]) || 0,
                power: Math.round(parts[2]) || 0,
                memoryPercent: 0
            };
        }

        // Partial data fallback
        if (parts.length >= 1) {
            return {
                type: 'gpu',
                utilization: Math.round(parts[0]) || 0,
                temperature: parts.length >= 2 ? Math.round(parts[1]) : 0,
                power: 0,
                memoryPercent: 0
            };
        }

        return null;
    } catch (e) {
        return null;
    }
}

// ============================================================
// SSH STREAMING VIA SOCKET.IO
// ============================================================

const activeSessions = new Map();

// Buffer for accumulating text data between REFRESH markers
const dataBuffers = {};

const MONITOR_COMMANDS = {
    'memory': {
        cmd: 'while true; do free -m 2>&1; echo "---REFRESH---"; sleep 1; done',
        label: 'Memory Usage',
        type: 'text'
    },
    'network': {
        cmd: "while true; do for IFACE in enp1s0f0np0 enp1s0f1np1 enP2p1s0f0np0 enP2p1s0f1np1; do ethtool -S $IFACE 2>/dev/null | grep -E 'rx_vport_rdma_unicast_bytes|tx_vport_rdma_unicast_bytes'; done; echo '---REFRESH---'; sleep 1; done",
        label: 'RDMA Network',
        type: 'text'
    },
    'bmon': {
        cmd: 'IFACE=enP7s7; while true; do R1=$(cat /sys/class/net/$IFACE/statistics/rx_bytes 2>/dev/null || echo 0); T1=$(cat /sys/class/net/$IFACE/statistics/tx_bytes 2>/dev/null || echo 0); sleep 2; R2=$(cat /sys/class/net/$IFACE/statistics/rx_bytes 2>/dev/null || echo 0); T2=$(cat /sys/class/net/$IFACE/statistics/tx_bytes 2>/dev/null || echo 0); RX=$(( (R2 - R1) / 2 )); TX=$(( (T2 - T1) / 2 )); echo "RX: ${RX} B/s TX: ${TX} B/s"; done',
        label: 'Bandwidth Monitor',
        type: 'terminal'
    },
    'nvtop': {
        cmd: 'while true; do nvidia-smi --query-gpu=utilization.gpu,temperature.gpu,power.draw --format=csv,noheader,nounits 2>/dev/null || echo "0, 0, 0"; echo "---REFRESH---"; sleep 2; done',
        label: 'GPU Monitor',
        type: 'text'
    }
};

io.on('connection', (socket) => {
    console.log(`[Socket.IO] Client connected: ${socket.id}`);
    activeSessions.set(socket.id, new Map());

    socket.on('start-monitoring', () => {
        console.log(`[Socket.IO] Starting monitoring for ${socket.id}`);
        console.log(`[DEBUG] Loading connections...`);
        const data = loadConnections();
        console.log(`[DEBUG] Clusters found: ${data.clusters.length}, nodes: ${JSON.stringify(data.clusters.map(c => c.nodes.length))}`);
        data.clusters.forEach(cluster => {
            cluster.nodes.forEach(node => {
                Object.keys(MONITOR_COMMANDS).forEach(cmdKey => {
                    startSSHStream(socket, cluster, node, cmdKey);
                });
            });
        });
    });

    socket.on('start-stream', (data) => {
        const { clusterId, nodeId, command } = data;
        const connData = loadConnections();
        const cluster = connData.clusters.find(c => c.id === clusterId);
        if (!cluster) return;
        const node = cluster.nodes.find(n => n.id === nodeId);
        if (!node) return;
        startSSHStream(socket, cluster, node, command);
    });

    socket.on('stop-monitoring', () => {
        cleanupSessions(socket.id);
    });

    socket.on('disconnect', () => {
        console.log(`[Socket.IO] Client disconnected: ${socket.id}`);
        cleanupSessions(socket.id);
        activeSessions.delete(socket.id);
    });
});

function startSSHStream(socket, cluster, node, cmdKey) {
    const sessionKey = `${cluster.id}-${node.id}-${cmdKey}`;
    const sessions = activeSessions.get(socket.id);
    if (!sessions) return;

    if (sessions.has(sessionKey)) {
        try {
            const old = sessions.get(sessionKey);
            if (old.stream) old.stream.close();
            if (old.conn) old.conn.end();
        } catch (e) {}
        sessions.delete(sessionKey);
    }

    const cmdConfig = MONITOR_COMMANDS[cmdKey];
    if (!cmdConfig) return;

    const conn = new Client();
    const channelId = `${cluster.id}/${node.id}/${cmdKey}`;
    const bufferKey = `${socket.id}-${sessionKey}`;
    dataBuffers[bufferKey] = '';

    conn.on('ready', () => {
        console.log(`[SSH] Connected: ${node.name}@${node.host} for ${cmdKey}`);

        socket.emit('node-status', {
            clusterId: cluster.id,
            nodeId: node.id,
            command: cmdKey,
            status: 'connected'
        });

        if (cmdConfig.type === 'terminal') {
            conn.shell({ term: 'xterm-256color', cols: 120, rows: 40 }, (err, stream) => {
                if (err) {
                    socket.emit('stream-error', { channel: channelId, error: err.message });
                    return;
                }
                sessions.set(sessionKey, { conn, stream });

                stream.on('data', (data) => {
                    const rawStr = data.toString('utf8');

                    // Emit raw stream data (backward compatible)
                    socket.emit('stream-data', {
                        channel: channelId,
                        data: rawStr,
                        type: 'terminal'
                    });

                    // Parse and emit structured metrics
                    if (cmdKey === 'bmon') {
                        const parsed = parseBmon(rawStr);
                        if (parsed) {
                            socket.emit('parsed-metrics', {
                                clusterId: cluster.id,
                                nodeId: node.id,
                                nodeName: node.name,
                                nodeType: node.type,
                                nodeHost: node.host,
                                metrics: parsed
                            });
                        }
                    } else if (cmdKey === 'nvtop') {
                        const parsed = parseGpu(rawStr);
                        if (parsed) {
                            socket.emit('parsed-metrics', {
                                clusterId: cluster.id,
                                nodeId: node.id,
                                nodeName: node.name,
                                nodeType: node.type,
                                nodeHost: node.host,
                                metrics: parsed
                            });
                        }
                    }
                });

                stream.on('close', () => {
                    socket.emit('node-status', {
                        clusterId: cluster.id,
                        nodeId: node.id,
                        command: cmdKey,
                        status: 'disconnected'
                    });
                });

                stream.write(cmdConfig.cmd + '\n');
            });
        } else {
            conn.exec(cmdConfig.cmd, { pty: false }, (err, stream) => {
                if (err) {
                    socket.emit('stream-error', { channel: channelId, error: err.message });
                    return;
                }
                sessions.set(sessionKey, { conn, stream });

                stream.on('data', (data) => {
                    const rawStr = data.toString('utf8');

                    // Emit raw stream data (backward compatible)
                    socket.emit('stream-data', {
                        channel: channelId,
                        data: rawStr,
                        type: 'text'
                    });

                    // Accumulate data and parse on REFRESH markers
                    dataBuffers[bufferKey] = (dataBuffers[bufferKey] || '') + rawStr;

                    if (dataBuffers[bufferKey].includes('---REFRESH---')) {
                        const parts = dataBuffers[bufferKey].split('---REFRESH---');
                        // The last complete block before the marker
                        const completeBlock = parts[parts.length - 2] || parts[0];
                        // Keep any trailing incomplete data
                        dataBuffers[bufferKey] = parts[parts.length - 1] || '';

                        if (completeBlock && completeBlock.trim()) {
                            let parsed = null;
                            const nodeKey = `${cluster.id}-${node.id}`;

                            if (cmdKey === 'memory') {
                                parsed = parseMemory(completeBlock);
                            } else if (cmdKey === 'network') {
                                parsed = parseNetwork(completeBlock, nodeKey);
                            } else if (cmdKey === 'nvtop') {
                                parsed = parseGpu(completeBlock);
                            }

                            if (parsed) {
                                socket.emit('parsed-metrics', {
                                    clusterId: cluster.id,
                                    nodeId: node.id,
                                    nodeName: node.name,
                                    nodeType: node.type,
                                    nodeHost: node.host,
                                    metrics: parsed
                                });
                            }
                        }
                    }
                });

                stream.stderr.on('data', (data) => {
                    socket.emit('stream-data', {
                        channel: channelId,
                        data: data.toString('utf8'),
                        type: 'text'
                    });
                });

                stream.on('close', () => {
                    delete dataBuffers[bufferKey];
                    socket.emit('node-status', {
                        clusterId: cluster.id,
                        nodeId: node.id,
                        command: cmdKey,
                        status: 'disconnected'
                    });
                });
            });
        }
    });

    conn.on('error', (err) => {
        console.error(`[SSH] Error for ${node.name}@${node.host}: ${err.message}`);
        socket.emit('node-status', {
            clusterId: cluster.id,
            nodeId: node.id,
            command: cmdKey,
            status: 'error',
            error: err.message
        });
    });

    conn.on('close', () => {
        socket.emit('node-status', {
            clusterId: cluster.id,
            nodeId: node.id,
            command: cmdKey,
            status: 'disconnected'
        });
    });

    conn.connect({
        host: node.host,
        port: parseInt(node.port) || 22,
        username: node.username,
        password: node.password,
        readyTimeout: 15000,
        keepaliveInterval: 10000,
        algorithms: {
            kex: [
                'ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521',
                'diffie-hellman-group-exchange-sha256', 'diffie-hellman-group14-sha256',
                'diffie-hellman-group14-sha1'
            ]
        }
    });
}

function cleanupSessions(socketId) {
    const sessions = activeSessions.get(socketId);
    if (!sessions) return;

    sessions.forEach((session, key) => {
        try {
            if (session.stream) session.stream.close();
            if (session.conn) session.conn.end();
        } catch (e) {}
        // Clean up data buffers
        delete dataBuffers[`${socketId}-${key}`];
    });
    sessions.clear();
    console.log(`[Cleanup] All sessions cleared for ${socketId}`);
}

// ============================================================
// START SERVER
// ============================================================

server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n========================================`);
    console.log(`  DGX SPARK MONITORING DASHBOARD`);
    console.log(`  Running on http://localhost:${PORT} (cloned instance on port 9100)`);
    console.log(`========================================\n`);
});
