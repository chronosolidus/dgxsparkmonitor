// ============================================================
// DGX SPARK - CONNECTION MANAGER
// ============================================================
// Authentication is handled server-side via express-session.
// If you can see this page, you are already authenticated.
// ============================================================

let connectionsData = { clusters: [] };
let idCounter = Date.now();

function uid() { return 'id-' + (idCounter++).toString(36); }

// ---- API ----
async function loadConnections() {
    try {
        const res = await fetch('/api/connections/raw', { credentials: 'same-origin' });
        if (res.status === 401) {
            // Session expired — redirect to login
            window.location.href = '/connections-login';
            return;
        }
        const data = await res.json();
        if (data && data.clusters) {
            connectionsData = data;
        }
    } catch (e) {
        console.error('Failed to load connections:', e);
    }
    renderAll();
}

async function saveAllConnections() {
    // Collect data from DOM
    collectDataFromDOM();

    try {
        const res = await fetch('/api/connections', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify(connectionsData)
        });
        if (res.status === 401) {
            window.location.href = '/connections-login';
            return;
        }
        const result = await res.json();
        if (result.success) {
            showSaveIndicator('saved', 'Saved!');
            setTimeout(() => { window.location.href = '/'; }, 500);
        } else {
            showSaveIndicator('error', 'Error: ' + result.error);
        }
    } catch (e) {
        showSaveIndicator('error', 'Save failed');
        console.error('Save failed:', e);
    }
}

async function testConnection(nodeEl) {
    const host = nodeEl.querySelector('.node-host-input').value;
    const port = nodeEl.querySelector('.node-port-input').value || '22';
    const username = nodeEl.querySelector('.node-user-input').value;
    const password = nodeEl.querySelector('.node-pass-input').value;

    // Find or create result element
    let resultEl = nodeEl.querySelector('.test-result');
    if (!resultEl) {
        resultEl = document.createElement('div');
        resultEl.className = 'test-result';
        nodeEl.appendChild(resultEl);
    }

    resultEl.className = 'test-result testing';
    resultEl.textContent = 'Testing connection...';

    try {
        const res = await fetch('/api/test-connection', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ host, port: parseInt(port), username, password })
        });
        if (res.status === 401) {
            window.location.href = '/connections-login';
            return;
        }
        const result = await res.json();
        if (result.success) {
            resultEl.className = 'test-result success';
            resultEl.textContent = '\u2713 Connected! Hostname: ' + result.hostname;
        } else {
            resultEl.className = 'test-result error';
            resultEl.textContent = '\u2717 Failed: ' + result.error;
        }
    } catch (e) {
        resultEl.className = 'test-result error';
        resultEl.textContent = '\u2717 Error: ' + e.message;
    }
}

// ---- Change Password ----
function initChangePassword() {
    var btn = document.getElementById('btn-change-password');
    if (!btn) return;

    btn.addEventListener('click', async function() {
        var currentPassword = document.getElementById('current-password').value;
        var newPassword = document.getElementById('new-password').value;
        var confirmPassword = document.getElementById('confirm-password').value;
        var resultEl = document.getElementById('password-change-result');

        // Validate
        if (!currentPassword) {
            resultEl.className = 'password-change-result error';
            resultEl.textContent = 'Enter your current password';
            return;
        }
        if (!newPassword || newPassword.length < 5) {
            resultEl.className = 'password-change-result error';
            resultEl.textContent = 'New password must be at least 5 characters';
            return;
        }
        if (newPassword !== confirmPassword) {
            resultEl.className = 'password-change-result error';
            resultEl.textContent = 'New password and confirmation do not match';
            return;
        }

        try {
            var res = await fetch('/api/change-passcode', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({
                    currentPasscode: currentPassword,
                    newPasscode: newPassword
                })
            });
            if (res.status === 401) {
                window.location.href = '/connections-login';
                return;
            }
            var data = await res.json();

            if (data.success) {
                resultEl.className = 'password-change-result success';
                resultEl.textContent = '\u2713 Password updated successfully';
                // Clear inputs
                document.getElementById('current-password').value = '';
                document.getElementById('new-password').value = '';
                document.getElementById('confirm-password').value = '';
                // Clear message after 5s
                setTimeout(function() { resultEl.textContent = ''; }, 5000);
            } else {
                resultEl.className = 'password-change-result error';
                resultEl.textContent = '\u2717 ' + (data.error || 'Failed to update password');
            }
        } catch (e) {
            resultEl.className = 'password-change-result error';
            resultEl.textContent = '\u2717 Connection error';
            console.error('Password change failed:', e);
        }
    });
}


// ---- Weather Zip Code Configuration ----
async function loadWeatherConfig() {
    try {
        var res = await fetch('/api/weather/config', { credentials: 'same-origin' });
        var config = await res.json();
        var locationEl = document.getElementById('weather-current-location');
        var coordsEl = document.getElementById('weather-current-coords');
        var inputEl = document.getElementById('weather-zip-input');

        if (locationEl && config.city) {
            locationEl.textContent = config.city + ', ' + config.state + ' ' + config.zipCode;
        } else if (locationEl) {
            locationEl.textContent = 'No location set';
        }
        if (coordsEl && config.latitude) {
            coordsEl.textContent = 'Coordinates: ' + config.latitude.toFixed(4) + ', ' + config.longitude.toFixed(4);
        } else if (coordsEl) {
            coordsEl.textContent = '';
        }
        if (inputEl) {
            inputEl.placeholder = config.zipCode || 'Enter zip code';
        }
    } catch (e) {
        console.error('Failed to load weather config:', e);
        var locationEl = document.getElementById('weather-current-location');
        if (locationEl) locationEl.textContent = 'Unable to load';
    }
}

function initWeatherZip() {
    var btn = document.getElementById('btn-update-zip');
    if (!btn) return;

    btn.addEventListener('click', async function() {
        var zipInput = document.getElementById('weather-zip-input');
        var resultEl = document.getElementById('zip-change-result');
        var zipCode = zipInput.value.trim();

        // Validate 5-digit US zip code
        if (!zipCode || !/^\d{5}$/.test(zipCode)) {
            resultEl.className = 'zip-change-result error';
            resultEl.textContent = 'Please enter a valid 5-digit US zip code';
            return;
        }

        // Show loading state
        resultEl.className = 'zip-change-result loading';
        resultEl.textContent = 'Geocoding zip code ' + zipCode + '...';
        btn.disabled = true;

        try {
            var res = await fetch('/api/weather/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ zipCode: zipCode })
            });

            if (res.status === 401) {
                window.location.href = '/connections-login';
                return;
            }

            var data = await res.json();

            if (data.success) {
                resultEl.className = 'zip-change-result success';
                resultEl.textContent = '\u2713 Weather location updated to ' + data.config.city + ', ' + data.config.state + ' ' + data.config.zipCode;
                // Refresh the display
                loadWeatherConfig();
                // Clear input
                zipInput.value = '';
                // Clear message after 8 seconds
                setTimeout(function() { resultEl.textContent = ''; }, 8000);
            } else {
                resultEl.className = 'zip-change-result error';
                resultEl.textContent = '\u2717 ' + (data.error || 'Failed to update location');
            }
        } catch (e) {
            resultEl.className = 'zip-change-result error';
            resultEl.textContent = '\u2717 Connection error: ' + e.message;
            console.error('Weather zip update failed:', e);
        } finally {
            btn.disabled = false;
        }
    });

    // Also allow Enter key to submit
    var zipInput = document.getElementById('weather-zip-input');
    if (zipInput) {
        zipInput.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') {
                btn.click();
            }
        });
    }
}

// ---- Data Collection ----
function collectDataFromDOM() {
    var clusters = [];
    document.querySelectorAll('.cluster-editor').forEach(function(clusterEl) {
        var cluster = {
            id: clusterEl.dataset.id,
            name: clusterEl.querySelector('.cluster-name-input').value || 'Unnamed Cluster',
            nodes: []
        };
        clusterEl.querySelectorAll('.node-editor').forEach(function(nodeEl) {
            cluster.nodes.push({
                id: nodeEl.dataset.id,
                name: nodeEl.querySelector('.node-name-input').value || '',
                type: nodeEl.querySelector('.node-type-select').value || 'worker',
                host: nodeEl.querySelector('.node-host-input').value || '',
                port: nodeEl.querySelector('.node-port-input').value || '22',
                username: nodeEl.querySelector('.node-user-input').value || '',
                password: nodeEl.querySelector('.node-pass-input').value || ''
            });
        });
        clusters.push(cluster);
    });
    connectionsData.clusters = clusters;
}

// ---- Rendering ----
function renderAll() {
    var container = document.getElementById('clusters-editor');
    var emptyState = document.getElementById('empty-state');

    if (connectionsData.clusters.length === 0) {
        container.innerHTML = '';
        emptyState.style.display = 'block';
        return;
    }

    emptyState.style.display = 'none';
    container.innerHTML = connectionsData.clusters.map(function(cluster) { return renderCluster(cluster); }).join('');

    // Re-attach event listeners
    attachNodeListeners();
}

function renderCluster(cluster) {
    var nodesHTML = cluster.nodes.map(function(node) { return renderNode(node); }).join('');

    return '<div class="cluster-editor" data-id="' + cluster.id + '">' +
        '<div class="cluster-editor-header">' +
            '<span style="font-family:var(--font-display);font-size:0.8rem;color:var(--neon-purple);letter-spacing:2px;">CLUSTER</span>' +
            '<input type="text" class="cyber-input cluster-name-input" value="' + escapeAttr(cluster.name) + '" placeholder="Cluster Name (e.g., DGX-Spark-01)">' +
            '<button class="cyber-btn danger sm btn-remove-cluster" data-cluster-id="' + cluster.id + '">' +
                '&#10007; Remove Cluster' +
            '</button>' +
        '</div>' +
        '<div class="cluster-editor-body">' +
            '<div class="nodes-list">' +
                nodesHTML +
            '</div>' +
            '<div class="add-node-row">' +
                '<button class="cyber-btn sm btn-add-head" data-cluster-id="' + cluster.id + '">' +
                    '+ Add Head Node' +
                '</button>' +
                '<button class="cyber-btn sm accent btn-add-worker" data-cluster-id="' + cluster.id + '">' +
                    '+ Add Worker Node' +
                '</button>' +
            '</div>' +
        '</div>' +
    '</div>';
}

function renderNode(node) {
    return '<div class="node-editor" data-id="' + node.id + '">' +
        '<select class="cyber-select node-type-select">' +
            '<option value="head"' + (node.type === 'head' ? ' selected' : '') + '>Head</option>' +
            '<option value="worker"' + (node.type === 'worker' ? ' selected' : '') + '>Worker</option>' +
        '</select>' +
        '<input type="text" class="cyber-input node-name-input" value="' + escapeAttr(node.name) + '" placeholder="Node Name">' +
        '<input type="text" class="cyber-input node-host-input" value="' + escapeAttr(node.host) + '" placeholder="IP Address / Hostname">' +
        '<input type="text" class="cyber-input node-port-input" value="' + escapeAttr(node.port || '22') + '" placeholder="Port" style="max-width:80px;">' +
        '<input type="text" class="cyber-input node-user-input" value="' + escapeAttr(node.username) + '" placeholder="Username">' +
        '<input type="password" class="cyber-input node-pass-input" value="' + escapeAttr(node.password) + '" placeholder="Password">' +
        '<div class="node-editor-actions">' +
            '<button class="cyber-btn sm success btn-test-node" title="Test Connection">&#9889; Test</button>' +
            '<button class="cyber-btn sm danger btn-remove-node" data-node-id="' + node.id + '" title="Remove Node">&#10007;</button>' +
        '</div>' +
    '</div>';
}

function escapeAttr(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---- Event Listeners ----
function attachNodeListeners() {
    // Remove cluster buttons
    document.querySelectorAll('.btn-remove-cluster').forEach(function(btn) {
        btn.addEventListener('click', function() {
            var clusterId = btn.dataset.clusterId;
            if (confirm('Remove this entire cluster and all its nodes?')) {
                connectionsData.clusters = connectionsData.clusters.filter(function(c) { return c.id !== clusterId; });
                renderAll();
                showSaveIndicator('unsaved', 'Unsaved changes');
            }
        });
    });

    // Add head node buttons
    document.querySelectorAll('.btn-add-head').forEach(function(btn) {
        btn.addEventListener('click', function() {
            collectDataFromDOM();
            var cluster = connectionsData.clusters.find(function(c) { return c.id === btn.dataset.clusterId; });
            if (cluster) {
                cluster.nodes.push({
                    id: uid(),
                    name: '',
                    type: 'head',
                    host: '',
                    port: '22',
                    username: '',
                    password: ''
                });
                renderAll();
                showSaveIndicator('unsaved', 'Unsaved changes');
            }
        });
    });

    // Add worker node buttons
    document.querySelectorAll('.btn-add-worker').forEach(function(btn) {
        btn.addEventListener('click', function() {
            collectDataFromDOM();
            var cluster = connectionsData.clusters.find(function(c) { return c.id === btn.dataset.clusterId; });
            if (cluster) {
                cluster.nodes.push({
                    id: uid(),
                    name: '',
                    type: 'worker',
                    host: '',
                    port: '22',
                    username: '',
                    password: ''
                });
                renderAll();
                showSaveIndicator('unsaved', 'Unsaved changes');
            }
        });
    });

    // Remove node buttons
    document.querySelectorAll('.btn-remove-node').forEach(function(btn) {
        btn.addEventListener('click', function() {
            collectDataFromDOM();
            var nodeId = btn.dataset.nodeId;
            connectionsData.clusters.forEach(function(cluster) {
                cluster.nodes = cluster.nodes.filter(function(n) { return n.id !== nodeId; });
            });
            renderAll();
            showSaveIndicator('unsaved', 'Unsaved changes');
        });
    });

    // Test node buttons
    document.querySelectorAll('.btn-test-node').forEach(function(btn) {
        btn.addEventListener('click', function() {
            var nodeEl = btn.closest('.node-editor');
            testConnection(nodeEl);
        });
    });
}

function showSaveIndicator(type, text) {
    var el = document.getElementById('save-indicator');
    if (el) {
        el.className = 'save-indicator ' + type;
        el.textContent = text;
        if (type === 'saved') {
            setTimeout(function() { el.textContent = ''; el.className = 'save-indicator'; }, 3000);
        }
    }
}

// ---- Initialization ----
// Authentication is handled server-side. If we got here, we are already authenticated.


function initClearWeather() {
    var btn = document.getElementById('btn-clear-weather');
    if (!btn) return;

    btn.addEventListener('click', async function() {
        var resultEl = document.getElementById('zip-change-result');
        var locationEl = document.getElementById('weather-current-location');
        var coordsEl = document.getElementById('weather-current-coords');
        var inputEl = document.getElementById('weather-zip-input');

        resultEl.className = 'zip-change-result loading';
        resultEl.textContent = 'Clearing location...';
        btn.disabled = true;

        try {
            var res = await fetch('/api/weather/config', {
                method: 'DELETE',
                credentials: 'same-origin'
            });

            if (res.status === 401) {
                window.location.href = '/connections-login';
                return;
            }

            var data = await res.json();

            if (data.success) {
                resultEl.className = 'zip-change-result success';
                resultEl.textContent = '\u2713 Weather location cleared';
                if (locationEl) locationEl.textContent = 'No location set';
                if (coordsEl) coordsEl.textContent = '';
                if (inputEl) {
                    inputEl.value = '';
                    inputEl.placeholder = 'Enter zip code';
                }
                setTimeout(function() { resultEl.textContent = ''; }, 8000);
            } else {
                resultEl.className = 'zip-change-result error';
                resultEl.textContent = '\u2717 ' + (data.error || 'Failed to clear location');
            }
        } catch (e) {
            resultEl.className = 'zip-change-result error';
            resultEl.textContent = '\u2717 Connection error: ' + e.message;
        } finally {
            btn.disabled = false;
        }
    });
}

document.addEventListener('DOMContentLoaded', function() {
    // Auto-load connections immediately (no password gate needed)
    loadConnections();

    // Initialize Change Password section
    initChangePassword();

    // Initialize Weather Widget Location section
    loadWeatherConfig();
    initWeatherZip();
    initClearWeather();

    // Add cluster button
    document.getElementById('btn-add-cluster').addEventListener('click', function() {
        collectDataFromDOM();
        connectionsData.clusters.push({
            id: uid(),
            name: '',
            nodes: [
                { id: uid(), name: '', type: 'head', host: '', port: '22', username: '', password: '' },
                { id: uid(), name: '', type: 'worker', host: '', port: '22', username: '', password: '' }
            ]
        });
        renderAll();
        showSaveIndicator('unsaved', 'Unsaved changes');
    });

    // Save all button
    document.getElementById('btn-save-all').addEventListener('click', function() {
        saveAllConnections();
    });

    // Clear all button
    document.getElementById('btn-clear-all').addEventListener('click', function() {
        if (confirm('Are you sure you want to remove ALL cluster connections?')) {
            connectionsData = { clusters: [] };
            renderAll();
            saveAllConnections();
        }
    });
});
