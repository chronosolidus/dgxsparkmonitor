// ============================================================
//  DGX SPARK CLUSTER MONITOR - Visual Dashboard Engine
//  Cyberpunk Edition - Real-time SVG Gauges & Canvas Sparklines
// ============================================================

(function () {
    'use strict';

    // ── Constants ──────────────────────────────────────────────
    const GAUGE_RADIUS = 45;
    const GAUGE_CIRCUMFERENCE = 2 * Math.PI * GAUGE_RADIUS; // ~282.74
    const SPARKLINE_MAX_POINTS = 60;
    const WEATHER_INTERVAL = 300000; // 5 min
    let WEATHER_LAT = null;
    let WEATHER_LON = null;
    let WEATHER_CITY = '';
    let WEATHER_STATE = '';
    let WEATHER_ZIP = '';
    let weatherConfigured = false;

    // ── State ──────────────────────────────────────────────────
    let socket = null;
    let monitoring = false;
    let clusters = [];
    let streamCount = 0;

    // Per-node metric state:  nodeKey -> { memory, gpu, network, bandwidth, sparklines }
    const nodeState = {};

    // ── Auth Status Check (show/hide logout button) ─────────
    async function checkAuthStatus() {
        try {
            const res = await fetch('/api/auth/status');
            const data = await res.json();
            const logoutBtn = document.getElementById('dashboard-logout-btn');
            if (logoutBtn) {
                logoutBtn.style.display = data.authenticated ? '' : 'none';
            }
        } catch (e) {
            // If check fails, keep logout hidden
            const logoutBtn = document.getElementById('dashboard-logout-btn');
            if (logoutBtn) logoutBtn.style.display = 'none';
        }
    }

    // ── DOM References ────────────────────────────────────────
    const $wsStatus      = document.getElementById('ws-status');
    const $wsStatusText  = document.getElementById('ws-status-text');
    const $btnStart      = document.getElementById('btn-start');
    const $btnStop       = document.getElementById('btn-stop');
    const $clusterCount  = document.getElementById('cluster-count');
    const $nodeCount     = document.getElementById('node-count');
    const $streamCount   = document.getElementById('stream-count');
    const $noConnections = document.getElementById('no-connections');
    const $container     = document.getElementById('clusters-container');

    // ── Utility ───────────────────────────────────────────────
    function nodeKey(clusterId, nodeId) {
        return `${clusterId}::${nodeId}`;
    }

    function formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
    }

    function formatRate(bytesPerSec) {
        if (bytesPerSec === 0) return '0 B/s';
        const units = ['B/s', 'KiB/s', 'MiB/s', 'GiB/s'];
        const i = Math.floor(Math.log(bytesPerSec) / Math.log(1024));
        return (bytesPerSec / Math.pow(1024, i)).toFixed(2) + ' ' + units[Math.min(i, units.length - 1)];
    }

    function formatMB(mb) {
        if (mb >= 1024) return (mb / 1024).toFixed(1) + ' GB';
        return mb + ' MB';
    }

    function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

    function tempColorClass(temp) {
        if (temp < 40) return 'temp-cool';
        if (temp < 60) return 'temp-warm';
        if (temp < 80) return 'temp-hot';
        return 'temp-critical';
    }

    // ── SVG Gauge Builder ─────────────────────────────────────
    function createGaugeSVG(id, colorClass) {
        return `
            <div class="radial-gauge" id="${id}">
                <svg viewBox="0 0 100 100">
                    <circle class="gauge-track" cx="50" cy="50" r="${GAUGE_RADIUS}" />
                    <circle class="gauge-fill ${colorClass}" cx="50" cy="50" r="${GAUGE_RADIUS}"
                            stroke-dasharray="${GAUGE_CIRCUMFERENCE}"
                            stroke-dashoffset="${GAUGE_CIRCUMFERENCE}" />
                </svg>
                <div class="gauge-center">
                    <div class="gauge-value">--</div>
                    <div class="gauge-unit"></div>
                </div>
            </div>`;
    }

    function updateGauge(el, percent, valueText, unitText, colorClass) {
        if (!el) return;
        const fill = el.querySelector('.gauge-fill');
        const valEl = el.querySelector('.gauge-value');
        const unitEl = el.querySelector('.gauge-unit');
        const p = clamp(percent, 0, 100);
        const offset = GAUGE_CIRCUMFERENCE * (1 - p / 100);
        if (fill) {
            fill.style.strokeDashoffset = offset;
            if (colorClass) {
                // Remove old dynamic classes
                fill.className.baseVal = 'gauge-fill ' + colorClass;
            }
        }
        if (valEl) valEl.textContent = valueText;
        if (unitEl) unitEl.textContent = unitText || '';
    }

    // ── Sparkline Canvas ──────────────────────────────────────
    function initSparkline(nk, key) {
        if (!nodeState[nk]) nodeState[nk] = {};
        if (!nodeState[nk].sparklines) nodeState[nk].sparklines = {};
        if (!nodeState[nk].sparklines[key]) {
            nodeState[nk].sparklines[key] = [];
        }
    }

    function pushSparklinePoint(nk, key, value) {
        initSparkline(nk, key);
        const arr = nodeState[nk].sparklines[key];
        arr.push(value);
        if (arr.length > SPARKLINE_MAX_POINTS) arr.shift();
    }

    function drawSparkline(canvasId, nk, keys, colors) {
        const canvas = document.getElementById(canvasId);
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width * (window.devicePixelRatio || 1);
        canvas.height = rect.height * (window.devicePixelRatio || 1);
        ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);
        const w = rect.width;
        const h = rect.height;

        ctx.clearRect(0, 0, w, h);

        // Draw grid lines
        ctx.strokeStyle = 'rgba(100, 100, 180, 0.08)';
        ctx.lineWidth = 0.5;
        for (let i = 1; i < 4; i++) {
            const y = (h / 4) * i;
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(w, y);
            ctx.stroke();
        }

        if (!nodeState[nk] || !nodeState[nk].sparklines) return;

        keys.forEach((key, ki) => {
            const data = nodeState[nk].sparklines[key];
            if (!data || data.length < 2) return;

            const maxVal = Math.max(...data, 1);
            const color = colors[ki] || '#00f0ff';
            const step = w / (SPARKLINE_MAX_POINTS - 1);

            // Draw area fill
            ctx.beginPath();
            ctx.moveTo(0, h);
            data.forEach((v, i) => {
                const x = i * step;
                const y = h - (v / maxVal) * (h - 4);
                if (i === 0) ctx.lineTo(x, y);
                else ctx.lineTo(x, y);
            });
            ctx.lineTo((data.length - 1) * step, h);
            ctx.closePath();
            ctx.fillStyle = color.replace(')', ', 0.08)').replace('rgb', 'rgba');
            ctx.fill();

            // Draw line
            ctx.beginPath();
            data.forEach((v, i) => {
                const x = i * step;
                const y = h - (v / maxVal) * (h - 4);
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            });
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.5;
            ctx.shadowColor = color;
            ctx.shadowBlur = 4;
            ctx.stroke();
            ctx.shadowBlur = 0;
        });
    }

    // ── Build Node Card HTML ──────────────────────────────────
    function buildNodeCard(cluster, node) {
        const nk = nodeKey(cluster.id, node.id);
        const badge = node.type === 'head' ? 'head' : 'worker';
        const badgeLabel = node.type === 'head' ? 'HEAD' : 'WORKER';

        return `
        <div class="node-card" id="node-card-${nk}">
            <div class="node-header">
                <span class="node-badge ${badge}">${badgeLabel}</span>
                <span class="node-name">${node.name || 'Unnamed'}</span>
                <span class="node-status-dot" id="node-dot-${nk}"></span>
                <span class="node-conn-label" id="node-conn-${nk}">IDLE</span>
            </div>
            <div class="metrics-grid">
                <!-- GPU DATA PANEL (Combined Memory + GPU) -->
                <div class="metric-panel gpu-data-panel" id="panel-gpudata-${nk}">
                    <div class="metric-panel-title">
                        <img src="/gpu-icon.png" alt="GPU" class="metric-panel-icon-img" style="width:60px;height:60px;vertical-align:middle;margin-right:6px;">
                        <span class="metric-panel-label">GPU Data</span>
                        <span class="metric-panel-status" id="status-gpudata-${nk}"></span>
                    </div>
                    <div class="metric-waiting" id="waiting-gpudata-${nk}">
                        <span class="metric-waiting-icon">&#8987;</span>
                        <span class="metric-waiting-text">Awaiting data...</span>
                    </div>
                    <div id="content-gpudata-${nk}" style="display:none;">
                        <div class="gpu-gauges-row">
                            <div class="gpu-gauge-item">
                                ${createGaugeSVG('gauge-mem-' + nk, 'glow-cyan')}
                                <div class="gauge-label-below">MEMORY</div>
                            </div>
                            <div class="gpu-gauge-item">
                                ${createGaugeSVG('gauge-cache-' + nk, 'glow-purple')}
                                <div class="gauge-label-below">CACHE</div>
                            </div>
                            <div class="gpu-gauge-item">
                                ${createGaugeSVG('gauge-swap-' + nk, 'glow-orange')}
                                <div class="gauge-label-below">SWAP</div>
                            </div>
                            <div class="gpu-gauge-item">
                                ${createGaugeSVG('gauge-gpu-temp-' + nk, 'temp-cool')}
                                <div class="gauge-label-below">Temp</div>
                            </div>
                            <div class="gpu-gauge-item">
                                ${createGaugeSVG('gauge-gpu-power-' + nk, 'glow-orange')}
                                <div class="gauge-label-below">Power</div>
                            </div>
                            <div class="gpu-gauge-item">
                                ${createGaugeSVG('gauge-gpu-util-' + nk, 'glow-green')}
                                <div class="gauge-label-below">Utilization</div>
                            </div>
                        </div>
                        <!-- Mobile GPU progress bars (same style as RAM/Cache/Swap, visible on mobile only) -->
                        <div class="progress-group mobile-gpu-bars" id="mobile-gpu-bars-${nk}">
                            <div class="progress-item">
                                <div class="progress-header">
                                    <span class="progress-label">Memory</span>
                                    <span class="progress-value" id="mgpu-mem-val-${nk}">0%</span>
                                </div>
                                <div class="progress-track">
                                    <div class="progress-fill cyan" id="mgpu-mem-bar-${nk}" style="width:0%"></div>
                                </div>
                            </div>
                            <div class="progress-item">
                                <div class="progress-header">
                                    <span class="progress-label">Utilization</span>
                                    <span class="progress-value" id="mgpu-util-val-${nk}">0%</span>
                                </div>
                                <div class="progress-track">
                                    <div class="progress-fill green" id="mgpu-util-bar-${nk}" style="width:0%"></div>
                                </div>
                            </div>
                            <div class="progress-item">
                                <div class="progress-header">
                                    <span class="progress-label">Temp</span>
                                    <span class="progress-value" id="mgpu-temp-val-${nk}">0°C</span>
                                </div>
                                <div class="progress-track">
                                    <div class="progress-fill green" id="mgpu-temp-bar-${nk}" style="width:0%"></div>
                                </div>
                            </div>
                            <div class="progress-item">
                                <div class="progress-header">
                                    <span class="progress-label">Power</span>
                                    <span class="progress-value" id="mgpu-power-val-${nk}">0W</span>
                                </div>
                                <div class="progress-track">
                                    <div class="progress-fill yellow" id="mgpu-power-bar-${nk}" style="width:0%"></div>
                                </div>
                            </div>
                        </div>
                        <div class="gpudata-details">
                            <div class="gpudata-bars">
                                <div class="progress-group">
                                    <div class="progress-item">
                                        <div class="progress-header">
                                            <span class="progress-label">CACHE</span>
                                            <span class="progress-value" id="mem-cache-${nk}">--</span>
                                        </div>
                                        <div class="progress-track">
                                            <div class="progress-fill purple" id="mem-cache-bar-${nk}" style="width:0%"></div>
                                        </div>
                                    </div>
                                    <div class="progress-item">
                                        <div class="progress-header">
                                            <span class="progress-label">Swap</span>
                                            <span class="progress-value" id="mem-swap-${nk}">-- / --</span>
                                        </div>
                                        <div class="progress-track">
                                            <div class="progress-fill orange" id="mem-swap-bar-${nk}" style="width:0%"></div>
                                        </div>
                                    </div>
                                </div>
                            </div>

                        </div>
                    </div>
                </div>

                <!-- NETWORK (RDMA) PANEL -->
                <div class="metric-panel" id="panel-network-${nk}">
                    <div class="metric-panel-title">
                        <img src="/rdma-icon.png" alt="RDMA" class="metric-panel-icon-img" style="width:40px;height:40px;vertical-align:middle;margin-right:6px;">
                        <span class="metric-panel-label">RDMA Interconnect</span>
                        <span class="metric-panel-status" id="status-network-${nk}"></span>
                    </div>
                    <div class="metric-waiting" id="waiting-network-${nk}">
                        <span class="metric-waiting-icon">&#8987;</span>
                        <span class="metric-waiting-text">Awaiting data...</span>
                    </div>
                    <div id="content-network-${nk}" style="display:none;">
                        <!-- Desktop: side-by-side boxes -->
                        <div class="net-stats-grid desktop-net">
                            <div class="net-stat-box">
                                <div class="net-stat-direction rx">&#8595; RX</div>
                                <div class="net-stat-value" id="net-rx-total-${nk}">-- /s</div>
                                <div class="net-stat-sub" id="net-rx-rate-${nk}">--</div>
                            </div>
                            <div class="net-stat-box">
                                <div class="net-stat-direction tx">&#8593; TX</div>
                                <div class="net-stat-value" id="net-tx-total-${nk}">-- /s</div>
                                <div class="net-stat-sub" id="net-tx-rate-${nk}">--</div>
                            </div>
                        </div>
                        <!-- Mobile: compact line rows -->
                        <div class="mobile-net-rows" id="mobile-net-${nk}">
                            <div class="mobile-net-row">
                                <div class="mobile-net-header">
                                    <span class="mobile-net-dir rx">&#8595; RX</span>
                                    <span class="mobile-net-rate" id="m-net-rx-rate-${nk}">-- /s</span>
                                </div>
                                <div class="mobile-net-sub" id="m-net-rx-total-${nk}">--</div>
                            </div>
                            <div class="mobile-net-row">
                                <div class="mobile-net-header">
                                    <span class="mobile-net-dir tx">&#8593; TX</span>
                                    <span class="mobile-net-rate" id="m-net-tx-rate-${nk}">-- /s</span>
                                </div>
                                <div class="mobile-net-sub" id="m-net-tx-total-${nk}">--</div>
                            </div>
                        </div>
                        <div class="sparkline-container">
                            <canvas id="sparkline-net-${nk}"></canvas>
                            <span class="sparkline-label">60s history</span>
                        </div>
                    </div>
                </div>

                <!-- BANDWIDTH (bmon) PANEL -->
                <div class="metric-panel" id="panel-bw-${nk}">
                    <div class="metric-panel-title">
                        <img src="/eth-icon.png" alt="ETH" class="metric-panel-icon-img" style="width:40px;height:40px;vertical-align:middle;margin-right:6px;">
                        <span class="metric-panel-label">Ethernet Bandwidth</span>
                        <span class="metric-panel-status" id="status-bw-${nk}"></span>
                    </div>
                    <div class="metric-waiting" id="waiting-bw-${nk}">
                        <span class="metric-waiting-icon">&#8987;</span>
                        <span class="metric-waiting-text">Awaiting data...</span>
                    </div>
                    <div id="content-bw-${nk}" style="display:none;">
                        <!-- Desktop: side-by-side boxes -->
                        <div class="net-stats-grid desktop-net">
                            <div class="net-stat-box">
                                <div class="net-stat-direction rx">&#8595; RX</div>
                                <div class="net-stat-value" id="bw-rx-rate-${nk}">--</div>
                                <div class="net-stat-sub" id="bw-rx-bytes-${nk}">-- B/s</div>
                            </div>
                            <div class="net-stat-box">
                                <div class="net-stat-direction tx">&#8593; TX</div>
                                <div class="net-stat-value" id="bw-tx-rate-${nk}">--</div>
                                <div class="net-stat-sub" id="bw-tx-bytes-${nk}">-- B/s</div>
                            </div>
                        </div>
                        <!-- Mobile: compact line rows -->
                        <div class="mobile-net-rows" id="mobile-bw-${nk}">
                            <div class="mobile-net-row">
                                <div class="mobile-net-header">
                                    <span class="mobile-net-dir rx">&#8595; RX</span>
                                    <span class="mobile-net-rate" id="m-bw-rx-rate-${nk}">--</span>
                                </div>
                                <div class="mobile-net-sub" id="m-bw-rx-bytes-${nk}">-- B/s</div>
                            </div>
                            <div class="mobile-net-row">
                                <div class="mobile-net-header">
                                    <span class="mobile-net-dir tx">&#8593; TX</span>
                                    <span class="mobile-net-rate" id="m-bw-tx-rate-${nk}">--</span>
                                </div>
                                <div class="mobile-net-sub" id="m-bw-tx-bytes-${nk}">-- B/s</div>
                            </div>
                        </div>
                        <div class="sparkline-container">
                            <canvas id="sparkline-bw-${nk}"></canvas>
                            <span class="sparkline-label">60s history</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>`;
    }

    // ── Build Cluster Sections ─────────────────────────────────
    function buildDashboard(data) {
        clusters = data.clusters || [];
        $container.innerHTML = '';

        if (clusters.length === 0) {
            $noConnections.style.display = 'block';
            $btnStart.style.display = 'none';
            $btnStop.style.display = 'none';
            $clusterCount.textContent = '0';
            $nodeCount.textContent = '0';
            return;
        }

        $noConnections.style.display = 'none';
        $btnStart.style.display = '';
        let totalNodes = 0;

        clusters.forEach(cluster => {
            const nodeCards = (cluster.nodes || []).map(n => buildNodeCard(cluster, n)).join('');
            totalNodes += (cluster.nodes || []).length;

            const section = document.createElement('div');
            section.className = 'cluster-section';
            section.id = `cluster-${cluster.id}`;
            section.innerHTML = `
                <div class="cluster-header">
                    <div class="cluster-name">&#9670; ${cluster.name || 'Unnamed Cluster'}</div>
                    <div class="cluster-meta">${(cluster.nodes || []).length} nodes</div>
                </div>
                <div class="cluster-body">
                    ${nodeCards}
                </div>`;

            $container.appendChild(section);
        });

        $clusterCount.textContent = clusters.length;
        $nodeCount.textContent = totalNodes;
    }

    // ── Metric Update Handlers ─────────────────────────────────
    function showPanel(nk, type) {
        const waiting = document.getElementById(`waiting-${type}-${nk}`);
        const content = document.getElementById(`content-${type}-${nk}`);
        const status  = document.getElementById(`status-${type}-${nk}`);
        if (waiting) waiting.style.display = 'none';
        if (content) content.style.display = 'block';
        if (status)  status.classList.add('live');
    }

    function showGpuDataPanel(nk, source) {
        const waiting = document.getElementById(`waiting-gpudata-${nk}`);
        const content = document.getElementById(`content-gpudata-${nk}`);
        const status  = document.getElementById(`status-gpudata-${nk}`);
        if (waiting) waiting.style.display = 'none';
        if (content) content.style.display = 'block';
        if (status)  status.classList.add('live');
    }

    function handleMemory(nk, m) {
        showGpuDataPanel(nk, 'mem');

        // System RAM gauge
        const gaugeEl = document.getElementById('gauge-mem-' + nk);
        updateGauge(gaugeEl, m.percent, m.percent + '%', 'RAM', 'glow-cyan');

        // CACHE gauge (Buff/Cache as % of total)
        const cacheGaugeEl = document.getElementById('gauge-cache-' + nk);
        const cachePctGauge = m.total > 0 ? Math.round((m.buffCache / m.total) * 100) : 0;
        updateGauge(cacheGaugeEl, cachePctGauge, cachePctGauge + '%', 'Buff', 'glow-purple');

        // SWAP gauge
        const swapGaugeEl = document.getElementById('gauge-swap-' + nk);
        updateGauge(swapGaugeEl, m.swapPercent, m.swapPercent + '%', 'Used', 'glow-orange');

        // Progress bars
        const cacheBar = document.getElementById('mem-cache-bar-' + nk);
        const swapBar  = document.getElementById('mem-swap-bar-' + nk);
        const cacheText = document.getElementById('mem-cache-' + nk);
        const swapText  = document.getElementById('mem-swap-' + nk);


        const cachePct = m.total > 0 ? Math.round((m.buffCache / m.total) * 100) : 0;
        if (cacheBar)  cacheBar.style.width = cachePct + '%';
        if (cacheText) cacheText.textContent = formatMB(m.buffCache);

        if (swapBar)  swapBar.style.width = m.swapPercent + '%';
        if (swapText) swapText.textContent = `${formatMB(m.swapUsed)} / ${formatMB(m.swapTotal)}`;

        // === Mobile bar: MEMORY ===
        const mobMemFill = document.getElementById('mgpu-mem-bar-' + nk);
        const mobMemVal  = document.getElementById('mgpu-mem-val-' + nk);
        if (mobMemFill) mobMemFill.style.width = m.percent + '%';
        if (mobMemVal)  mobMemVal.textContent = m.percent + '%';
    }

    function handleGpu(nk, m) {
        showGpuDataPanel(nk, 'gpu');

        // Initialize per-node state for zero-protection and EMA smoothing
        if (!nodeState[nk]) nodeState[nk] = {};
        if (!nodeState[nk].lastGpu) nodeState[nk].lastGpu = { utilization: 0, temperature: 0, power: 0 };
        if (!nodeState[nk].ema) nodeState[nk].ema = { power: 0, temperature: 0, utilization: 0, initialized: false };
        const last = nodeState[nk].lastGpu;
        const ema = nodeState[nk].ema;

        // Use incoming value if non-zero, otherwise hold last known good value
        const util = m.utilization > 0 ? m.utilization : last.utilization;
        const temp = m.temperature > 0 ? m.temperature : last.temperature;
        const power = m.power > 0 ? m.power : last.power;

        // Store as last known good values
        if (m.utilization > 0) last.utilization = m.utilization;
        if (m.temperature > 0) last.temperature = m.temperature;
        if (m.power > 0) last.power = m.power;

        // EMA smoothing: alpha controls responsiveness (lower = smoother, higher = more responsive)
        // Power uses heavier smoothing (alpha=0.25) since wattage fluctuates rapidly
        // Temperature uses moderate smoothing (alpha=0.3)
        // Utilization uses lighter smoothing (alpha=0.4) to stay responsive
        const ALPHA_POWER = 0.25;
        const ALPHA_TEMP  = 0.3;
        const ALPHA_UTIL  = 0.4;

        if (!ema.initialized) {
            // First reading: seed EMA with actual values
            ema.power = power;
            ema.temperature = temp;
            ema.utilization = util;
            ema.initialized = true;
        } else {
            ema.power = ALPHA_POWER * power + (1 - ALPHA_POWER) * ema.power;
            ema.temperature = ALPHA_TEMP * temp + (1 - ALPHA_TEMP) * ema.temperature;
            ema.utilization = ALPHA_UTIL * util + (1 - ALPHA_UTIL) * ema.utilization;
        }

        // Use smoothed values for display
        const smoothUtil  = Math.round(ema.utilization);
        const smoothTemp  = Math.round(ema.temperature);
        const smoothPower = Math.round(ema.power);

        // Utilization gauge
        const utilEl = document.getElementById('gauge-gpu-util-' + nk);
        updateGauge(utilEl, smoothUtil, smoothUtil + '%', 'SM', 'glow-green');

        // Temperature gauge (max ~100C)
        const tempPct = clamp((smoothTemp / 100) * 100, 0, 100);
        const tempEl = document.getElementById('gauge-gpu-temp-' + nk);
        updateGauge(tempEl, tempPct, smoothTemp + '°', 'C', tempColorClass(smoothTemp));

        // Power gauge (DGX Spark GB10 SOC TDP = 140W, nvidia-smi reports GPU power)
        const MAX_GPU_POWER = 140;
        const powerPct = clamp((smoothPower / MAX_GPU_POWER) * 100, 0, 100);
        const powerEl = document.getElementById('gauge-gpu-power-' + nk);
        const powerColorClass = powerPct > 85 ? 'glow-red' : powerPct > 60 ? 'glow-orange' : 'glow-yellow';
        updateGauge(powerEl, powerPct, smoothPower + '', 'W', powerColorClass);

        // === Mobile bars: UTILIZATION, TEMP, POWER ===
        const mobUtilFill  = document.getElementById('mgpu-util-bar-' + nk);
        const mobUtilVal   = document.getElementById('mgpu-util-val-' + nk);
        const mobTempFill  = document.getElementById('mgpu-temp-bar-' + nk);
        const mobTempVal   = document.getElementById('mgpu-temp-val-' + nk);
        const mobPowerFill = document.getElementById('mgpu-power-bar-' + nk);
        const mobPowerVal  = document.getElementById('mgpu-power-val-' + nk);

        // Utilization bar (always green)
        if (mobUtilFill) mobUtilFill.style.width = smoothUtil + '%';
        if (mobUtilVal)  mobUtilVal.textContent = smoothUtil + '%';

        // Temperature bar (dynamic color based on temp)
        if (mobTempFill) {
            mobTempFill.style.width = tempPct + '%';
            // Remove all bar color classes then add the appropriate one
            mobTempFill.className = 'progress-fill';
            if (smoothTemp >= 80) mobTempFill.classList.add('pink');
            else if (smoothTemp >= 65) mobTempFill.classList.add('orange');
            else if (smoothTemp >= 50) mobTempFill.classList.add('yellow');
            else mobTempFill.classList.add('green');
        }
        if (mobTempVal) mobTempVal.textContent = smoothTemp + '°C';

        // Power bar (dynamic color based on power %)
        if (mobPowerFill) {
            mobPowerFill.style.width = powerPct + '%';
            mobPowerFill.className = 'progress-fill';
            if (powerPct > 85) mobPowerFill.classList.add('orange');
            else if (powerPct > 60) mobPowerFill.classList.add('orange');
            else mobPowerFill.classList.add('yellow');
        }
        if (mobPowerVal) mobPowerVal.textContent = smoothPower + 'W';
    }

    function handleNetwork(nk, m) {
        showPanel(nk, 'network');

        const rxTotalEl = document.getElementById('net-rx-total-' + nk);
        const txTotalEl = document.getElementById('net-tx-total-' + nk);
        const rxRateEl  = document.getElementById('net-rx-rate-' + nk);
        const txRateEl  = document.getElementById('net-tx-rate-' + nk);

        if (rxTotalEl) rxTotalEl.textContent = formatRate(m.rxRate);
        if (txTotalEl) txTotalEl.textContent = formatRate(m.txRate);
        if (rxRateEl)  rxRateEl.textContent = formatBytes(m.rx);
        if (txRateEl)  txRateEl.textContent = formatBytes(m.tx);

        // Mobile elements
        const mRxRate = document.getElementById('m-net-rx-rate-' + nk);
        const mTxRate = document.getElementById('m-net-tx-rate-' + nk);
        const mRxTotal = document.getElementById('m-net-rx-total-' + nk);
        const mTxTotal = document.getElementById('m-net-tx-total-' + nk);
        if (mRxRate) mRxRate.textContent = formatRate(m.rxRate);
        if (mTxRate) mTxRate.textContent = formatRate(m.txRate);
        if (mRxTotal) mRxTotal.textContent = formatBytes(m.rx);
        if (mTxTotal) mTxTotal.textContent = formatBytes(m.tx);

        // Push to sparkline
        pushSparklinePoint(nk, 'net-rx', m.rxRate);
        pushSparklinePoint(nk, 'net-tx', m.txRate);
        drawSparkline('sparkline-net-' + nk, nk,
            ['net-rx', 'net-tx'],
            ['rgb(0, 240, 255)', 'rgb(255, 42, 109)']
        );
    }

    function parseBwValue(str) {
        // Parse bmon rate strings like "1.23MiB", "456KiB", "0B"
        if (!str) return 0;
        const match = str.match(/([\d.]+)\s*([KMGT]?)(i?)(B)/i);
        if (!match) return 0;
        const num = parseFloat(match[1]);
        const prefix = (match[2] || '').toUpperCase();
        const multipliers = { '': 1, 'K': 1024, 'M': 1048576, 'G': 1073741824, 'T': 1099511627776 };
        return num * (multipliers[prefix] || 1);
    }

    function handleBandwidth(nk, m) {
        showPanel(nk, 'bw');

        const rxRateEl  = document.getElementById('bw-rx-rate-' + nk);
        const txRateEl  = document.getElementById('bw-tx-rate-' + nk);
        const rxBytesEl = document.getElementById('bw-rx-bytes-' + nk);
        const txBytesEl = document.getElementById('bw-tx-bytes-' + nk);

        if (rxRateEl) rxRateEl.textContent = m.rxRate || '--';
        if (txRateEl) txRateEl.textContent = m.txRate || '--';
        if (rxBytesEl) rxBytesEl.textContent = (m.rxBytes != null ? m.rxBytes.toLocaleString() + ' B/s' : '-- B/s');
        if (txBytesEl) txBytesEl.textContent = (m.txBytes != null ? m.txBytes.toLocaleString() + ' B/s' : '-- B/s');

        // Mobile elements
        const mRxRate = document.getElementById('m-bw-rx-rate-' + nk);
        const mTxRate = document.getElementById('m-bw-tx-rate-' + nk);
        const mRxBytes = document.getElementById('m-bw-rx-bytes-' + nk);
        const mTxBytes = document.getElementById('m-bw-tx-bytes-' + nk);
        if (mRxRate) mRxRate.textContent = m.rxRate || '--';
        if (mTxRate) mTxRate.textContent = m.txRate || '--';
        if (mRxBytes) mRxBytes.textContent = (m.rxBytes != null ? m.rxBytes.toLocaleString() + ' B/s' : '-- B/s');
        if (mTxBytes) mTxBytes.textContent = (m.txBytes != null ? m.txBytes.toLocaleString() + ' B/s' : '-- B/s');

        // Parse for sparkline
        const rxVal = m.rxBytes != null ? m.rxBytes : parseBwValue(m.rxRate);
        const txVal = m.txBytes != null ? m.txBytes : parseBwValue(m.txRate);

        // Sparkline
        pushSparklinePoint(nk, 'bw-rx', rxVal);
        pushSparklinePoint(nk, 'bw-tx', txVal);
        drawSparkline('sparkline-bw-' + nk, nk,
            ['bw-rx', 'bw-tx'],
            ['rgb(0, 240, 255)', 'rgb(255, 42, 109)']
        );
    }

    // ── Socket.IO ──────────────────────────────────────────────
    function connectSocket() {
        socket = io({ transports: ['websocket', 'polling'] });

        socket.on('connect', () => {
            $wsStatus.className = 'status-dot connected';
            $wsStatusText.textContent = 'Connected';
            // Auto-start monitoring on connect/reconnect
            setTimeout(() => { if (!monitoring) startMonitoring(); }, 500);
        });

        socket.on('disconnect', () => {
            $wsStatus.className = 'status-dot error';
            $wsStatusText.textContent = 'Disconnected';
        });

        socket.on('connect_error', () => {
            $wsStatus.className = 'status-dot error';
            $wsStatusText.textContent = 'Connection Error';
        });

        // Node connection status
        socket.on('node-status', (data) => {
            const nk = nodeKey(data.clusterId, data.nodeId);
            const dot = document.getElementById('node-dot-' + nk);
            const label = document.getElementById('node-conn-' + nk);

            if (data.status === 'connected') {
                if (dot) dot.className = 'node-status-dot connected';
                if (label) {
                    label.textContent = 'ONLINE';
                    label.className = 'node-conn-label connected';
                }
                streamCount++;
            } else if (data.status === 'error') {
                if (dot) dot.className = 'node-status-dot error';
                if (label) {
                    label.textContent = 'ERROR';
                    label.className = 'node-conn-label error';
                }
            } else {
                if (dot) dot.className = 'node-status-dot';
                if (label) {
                    label.textContent = 'OFFLINE';
                    label.className = 'node-conn-label';
                }
            }
            $streamCount.textContent = streamCount;
        });

        // Parsed metrics handler
        socket.on('parsed-metrics', (data) => {
            const nk = nodeKey(data.clusterId, data.nodeId);
            const m = data.metrics;
            if (!m) return;

            switch (m.type) {
                case 'memory':    handleMemory(nk, m);    break;
                case 'gpu':       handleGpu(nk, m);       break;
                case 'network':   handleNetwork(nk, m);   break;
                case 'bandwidth': handleBandwidth(nk, m); break;
            }
        });
    }

    // ── Monitoring Controls ────────────────────────────────────
    function startMonitoring() {
        if (!socket) return;
        if (clusters.length === 0) return;
        monitoring = true;
        streamCount = 0;
        $streamCount.textContent = '0';
        $btnStart.style.display = 'none';
        $btnStop.style.display = 'inline-flex';
        socket.emit('start-monitoring');
    }

    function stopMonitoring() {
        if (!socket) return;
        monitoring = false;
        streamCount = 0;
        $streamCount.textContent = '0';
        if (clusters.length > 0) {
            $btnStart.style.display = 'inline-flex';
        }
        $btnStop.style.display = 'none';
        socket.emit('stop-monitoring');

        // Reset all panels to waiting state
        document.querySelectorAll('.metric-waiting').forEach(el => el.style.display = 'flex');
        document.querySelectorAll('[id^="content-"]').forEach(el => el.style.display = 'none');
        document.querySelectorAll('.metric-panel-status').forEach(el => el.classList.remove('live'));
        document.querySelectorAll('.node-status-dot').forEach(el => el.className = 'node-status-dot');
        document.querySelectorAll('.node-conn-label').forEach(el => {
            el.textContent = 'IDLE';
            el.className = 'node-conn-label';
        });
    }

    $btnStart.addEventListener('click', startMonitoring);
    $btnStop.addEventListener('click', stopMonitoring);

    // ── Weather Widget ────────────────────────────────────────
    const WMO_CODES = {
        0: ['Clear Sky', '\u2600\ufe0f'],
        1: ['Mainly Clear', '\ud83c\udf24\ufe0f'],
        2: ['Partly Cloudy', '\u26c5'],
        3: ['Overcast', '\u2601\ufe0f'],
        45: ['Fog', '\ud83c\udf2b\ufe0f'],
        48: ['Rime Fog', '\ud83c\udf2b\ufe0f'],
        51: ['Light Drizzle', '\ud83c\udf26\ufe0f'],
        53: ['Moderate Drizzle', '\ud83c\udf26\ufe0f'],
        55: ['Dense Drizzle', '\ud83c\udf27\ufe0f'],
        61: ['Slight Rain', '\ud83c\udf26\ufe0f'],
        63: ['Moderate Rain', '\ud83c\udf27\ufe0f'],
        65: ['Heavy Rain', '\ud83c\udf27\ufe0f'],
        71: ['Slight Snow', '\ud83c\udf28\ufe0f'],
        73: ['Moderate Snow', '\ud83c\udf28\ufe0f'],
        75: ['Heavy Snow', '\u2744\ufe0f'],
        80: ['Rain Showers', '\ud83c\udf26\ufe0f'],
        81: ['Moderate Showers', '\ud83c\udf27\ufe0f'],
        82: ['Violent Showers', '\u26c8\ufe0f'],
        95: ['Thunderstorm', '\u26a1'],
        96: ['Hail Storm', '\u26a1'],
        99: ['Severe Hail', '\u26a1']
    };


    // ── Load Weather Location from Server Config ─────────────
    async function loadWeatherLocation() {
        try {
            const res = await fetch('/api/weather/config');
            const config = await res.json();
            if (config.latitude && config.longitude) {
                WEATHER_LAT = config.latitude;
                WEATHER_LON = config.longitude;
                WEATHER_CITY = config.city || 'Unknown';
                WEATHER_STATE = config.state || '';
                WEATHER_ZIP = config.zipCode || '';
                weatherConfigured = true;
                console.log(`[Weather] Location loaded: ${WEATHER_CITY}, ${WEATHER_STATE} ${WEATHER_ZIP} (${WEATHER_LAT}, ${WEATHER_LON})`);

                // Update location display in the weather widget
                const locEl = document.getElementById('weather-loc');
                if (locEl) locEl.textContent = `${WEATHER_CITY}, ${WEATHER_STATE} ${WEATHER_ZIP}`;
            } else {
                weatherConfigured = false;
                console.log('[Weather] No location configured');
                const locEl = document.getElementById('weather-loc');
                if (locEl) locEl.textContent = 'No location set';
                const $temp = document.getElementById('temperature');
                const $cond = document.getElementById('condition');
                const $hum  = document.getElementById('humidity');
                const $wind = document.getElementById('wind-speed');
                const $icon = document.getElementById('weather-icon');
                if ($temp) $temp.textContent = '--°F';
                if ($cond) $cond.textContent = '--';
                if ($hum)  $hum.textContent = '--%';
                if ($wind) $wind.textContent = '--';
                if ($icon) $icon.textContent = '🌐';
            }
        } catch (e) {
            console.warn('[Weather] Failed to load config:', e);
            weatherConfigured = false;
        }
    }

    async function fetchWeather() {
        if (!weatherConfigured) {
            console.log('[Weather] Skipping fetch - no location configured');
            return;
        }
        try {
            const url = `https://api.open-meteo.com/v1/forecast?latitude=${WEATHER_LAT}&longitude=${WEATHER_LON}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America%2FLos_Angeles`;
            const res = await fetch(url);
            const data = await res.json();
            const c = data.current;

            const temp = Math.round(c.temperature_2m);
            const humidity = c.relative_humidity_2m;
            const wind = Math.round(c.wind_speed_10m);
            const code = c.weather_code;
            const wmo = WMO_CODES[code] || ['Unknown', '\ud83c\udf24\ufe0f'];

            const $temp = document.getElementById('temperature');
            const $cond = document.getElementById('condition');
            const $hum  = document.getElementById('humidity');
            const $wind = document.getElementById('wind-speed');
            const $icon = document.getElementById('weather-icon');

            if ($temp) $temp.textContent = temp + '\u00b0F';
            if ($cond) $cond.textContent = wmo[0];
            if ($hum)  $hum.textContent = humidity + '%';
            if ($wind) $wind.textContent = wind;
            if ($icon) $icon.textContent = wmo[1];
        } catch (e) {
            console.warn('Weather fetch failed:', e);
        }
    }

    // ── Initialize ─────────────────────────────────────────────
    async function init() {
        checkAuthStatus();
        try {
            const res = await fetch('/api/connections');
            const data = await res.json();
            buildDashboard(data);
        } catch (e) {
            console.error('Failed to load connections:', e);
            $noConnections.style.display = 'block';
            $btnStart.style.display = 'none';
            $btnStop.style.display = 'none';
        }

        connectSocket();
        // Load configured location first, then fetch weather
        loadWeatherLocation().then(() => {
            fetchWeather();
            setInterval(fetchWeather, WEATHER_INTERVAL);
        });
    }

    // Wait for DOM
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
