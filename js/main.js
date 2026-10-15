/* ============================================
   主逻辑 — 对齐当前 index.html 结构
   指向逻辑严格对齐 D:\SLP-demo\point_demo.py
   ============================================ */

console.log('[VERSION] main.js loaded at ' + new Date().toISOString());

// ========== Global State ==========
var state = {
    deviceId: generateDeviceId(),
    deviceType: null,       // 'P' or 'T1'/'T2'/'T3'
    serialReader: null,
    polarPlot: null,
    devices: [null, null, null],
    currentBestIdx: -1,     // 当前被指向的设备索引 (-1=无)
    isMaster: false,
    socket: null,          // 局域网 WebSocket 连接
    pnListener: null,       // keep listener reference to prevent GC
    // Debounce: only broadcast after N consecutive frames agree
    _debounceCount: 0,
    _debounceTarget: -1,
    // Mode: 'localization' (default) | 'pointing' (locked positions)
    mode: 'localization',
};

// ========== DOM References (aligned with current index.html) ==========
var screens = {
    register: document.getElementById('screen-register'),
    pDevice:  document.getElementById('screen-p-device'),
    tDevice:  document.getElementById('screen-t-device'),
};

var pUI = {
    statusDot:      document.getElementById('status-dot'),
    statusText:     document.getElementById('status-text'),
    btnConnect:     document.getElementById('btn-connect'),
    btnDisconnect:  document.getElementById('btn-disconnect'),
    btnFixPos:      document.getElementById('btn-fix-positions'),
    btnSettings:    document.getElementById('btn-settings'),
    modeBadge:      document.getElementById('mode-badge'),
    modeDesc:       document.getElementById('mode-desc'),
    polarCanvas:    document.getElementById('polar-canvas'),
    logContent:     document.getElementById('log-content'),
    pointingTarget: document.getElementById('pointing-target'),
    pointingStatus: document.getElementById('pointing-status'),
};

var tUI = {
    statusDisplay: document.getElementById('t-status-display'),
    deviceIcon:    document.getElementById('t-device-icon'),
    deviceName:    document.getElementById('t-device-name'),
    statusText:    document.getElementById('t-status-text'),
    statusBadge:   document.getElementById('t-status-badge'),
};

// Registration form elements
var regUI = {
    deviceNameInput: document.getElementById('device-name'),
    deviceButtons:   document.querySelectorAll('.device-btn'),
    btnEnter:        document.getElementById('btn-enter'),
    registeredInfo:  document.getElementById('registered-info'),
    displayName:     document.getElementById('display-device-name'),
    displayType:     document.getElementById('display-device-type'),
};

// ========== Mode Switching ==========
function updateModeUI() {
    if (state.mode === 'localization') {
        pUI.modeBadge.textContent = '📡 定位模式';
        pUI.modeBadge.className   = 'mode-badge localization';
        pUI.modeDesc.textContent  = '设备随SLP指向实时移动';
        pUI.btnFixPos.textContent = '📍 位置确定';
        pUI.btnFixPos.title       = '切换到指向模式，锁存设备坐标';
    } else {
        pUI.modeBadge.textContent = '🎯 指向模式';
        pUI.modeBadge.className   = 'mode-badge pointing';
        pUI.modeDesc.textContent  = '设备坐标已锁定，仅数据实时更新';
        pUI.btnFixPos.textContent = '🔄 返回定位';
        pUI.btnFixPos.title       = '回到定位模式，设备恢复实时移动';
    }
}

function switchMode(newMode) {
    state.mode = newMode;
    updateModeUI();

    if (newMode === 'pointing') {
        // Lock each device's position at current smoothed values
        for (var i = 0; i < state.devices.length; i++) {
            var dev = state.devices[i];
            if (dev && dev.history.length > 0) {
                dev.lockedDis = dev.smoothedDis;
                dev.lockedAzi = dev.smoothedAzi;
            }
        }
        logMsg('🔒 已进入指向模式 — 设备坐标已锁定');
    } else {
        // Clear locks, devices go back to live positions
        for (var j = 0; j < state.devices.length; j++) {
            var dj = state.devices[j];
            if (dj) {
                dj.lockedDis = null;
                dj.lockedAzi = null;
            }
        }
        logMsg('📡 已返回定位模式 — 设备恢复实时移动');
    }
}

// ========== Init ==========
// Scripts load at end of <body>, DOMContentLoaded may have already fired.
// Run init immediately if DOM is ready, otherwise wait for the event.
if (document.readyState === 'complete' || document.readyState === 'interactive') {
    // Small delay to ensure all scripts are parsed
    setTimeout(initRegistration, 0);
} else {
    document.addEventListener('DOMContentLoaded', function () {
        initRegistration();
    });
}

// ========== Registration ==========
function initRegistration() {
    console.log('[Init] Found', regUI.deviceButtons.length, 'device buttons');
    console.log('[Init] btnEnter element:', regUI.btnEnter);
    // Device type selection
    for (var i = 0; i < regUI.deviceButtons.length; i++) {
        (function (btn) {
            btn.addEventListener('click', function () {
                console.log('[Click] Selected device:', btn.dataset.device);
                selectDevice(btn);
            });
        })(regUI.deviceButtons[i]);
    }

    // Enter button
    regUI.btnEnter.addEventListener('click', function () {
        if (state.deviceType) {
            showRoomInfo(state.deviceType);
        }
    });
}

function selectDevice(btn) {
    // Deselect all
    for (var i = 0; i < regUI.deviceButtons.length; i++) {
        regUI.deviceButtons[i].classList.remove('selected');
    }
    // Select this one
    btn.classList.add('selected');
    state.deviceType = btn.dataset.device;

    // Enable enter button
    regUI.btnEnter.disabled = false;
}

function showRoomInfo(role) {
    // Hide registration screen
    screens.register.classList.remove('active');
    screens.register.style.display = 'none';

    // Show room info overlay
    var roomOverlay = document.createElement('div');
    roomOverlay.id = 'room-overlay';
    roomOverlay.className = 'overlay';
    roomOverlay.innerHTML =
        '<div class="room-info-box">' +
            '<h2>' + CONFIG.DEVICES[role].icon + ' ' + CONFIG.DEVICES[role].label + '</h2>' +
            '<p class="room-code-label">房间号</p>' +
            '<p class="room-code-value">' + CONFIG.ROOM_CODE + '</p>' +
            '<p class="room-hint">所有设备自动加入同一房间，无需手动输入</p>' +
            '<button id="btn-enter-room" class="btn-primary">进入系统</button>' +
        '</div>';
    document.body.appendChild(roomOverlay);

    document.getElementById('btn-enter-room').addEventListener('click', function () {
        document.body.removeChild(roomOverlay);
        enterSystem(state.deviceType);
    });
}

function enterSystem(deviceType) {
    if (deviceType === 'P') {
        screens.pDevice.style.display = 'block';
        screens.pDevice.classList.add('active');
        initPScreen();
    } else {
        screens.tDevice.style.display = 'block';
        screens.tDevice.classList.add('active');
        initTScreen(deviceType);
    }
}

// ========== 局域网 WebSocket 通信（替代 PubNub） ==========
// 连接到本机 server.py 提供的 /ws，同一 Wi-Fi 下所有设备共享一个房间
function setLanStatus(text, color) {
    var el = document.getElementById('t-pn-status');
    if (el) {
        el.textContent = text;
        el.style.color = color;
    }
}

function initLanSocket() {
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    var url = proto + location.host + '/ws';
    var retryDelay = 1000;
    var heartbeat = null;
    var everConnected = false;

    console.log('[LAN] Connecting to', url, 'as', state.deviceType, state.deviceId);

    function connect() {
        var ws;
        try {
            ws = new WebSocket(url);
        } catch (e) {
            console.error('[LAN] WebSocket create failed:', e);
            setTimeout(connect, retryDelay);
            return;
        }
        state.socket = ws;
        setLanStatus('连接中...', '#888');

        ws.onopen = function () {
            retryDelay = 1000;
            setLanStatus(everConnected ? '✅ 重连成功' : '✅ 已连接', '#27ae60');
            if (state.deviceType === 'P') {
                logMsg('[局域网] ' + (everConnected ? '已重新连接' : '已连接到房间 ' + CONFIG.ROOM_CODE));
            }
            everConnected = true;
            broadcastPresence();
            if (state.deviceType === 'P') CastSender.onReconnect();
            // 心跳：防止手机/路由器在空闲时断开连接
            clearInterval(heartbeat);
            heartbeat = setInterval(function () {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'ping' }));
                }
            }, 10000);
        };

        ws.binaryType = 'blob';

        ws.onmessage = function (ev) {
            if (typeof ev.data !== 'string') {
                CastReceiver.onFrame(ev.data);   // 投屏画面
                return;
            }
            var msg;
            try {
                msg = JSON.parse(ev.data);
            } catch (e) {
                return;
            }
            if (msg.type === 'pong') return;
            try {
                console.log('[LAN recv] from=' + msg.sender + ' data=', msg);
                var msgCount = document.getElementById('t-msg-count');
                if (msgCount) {
                    var c = parseInt(msgCount.textContent, 10) || 0;
                    msgCount.textContent = c + 1;
                }
                var lastMsg = document.getElementById('t-last-msg');
                if (lastMsg) {
                    var detail = msg.type || '?';
                    if (msg.target) detail += '(' + msg.target + ')';
                    lastMsg.textContent = detail;
                    lastMsg.style.color = msg.type === 'point_at' ? '#e74c3c' : '#888';
                }
                var lastTime = document.getElementById('t-last-time');
                if (lastTime) {
                    lastTime.textContent = new Date().toLocaleTimeString();
                }
                onNetworkMessage(msg, msg.sender);
            } catch (e) {
                console.error('[LAN recv ERROR]', e);
            }
        };

        ws.onclose = function () {
            clearInterval(heartbeat);
            if (state.socket === ws) state.socket = null;
            setLanStatus('❌ 断开，' + Math.round(retryDelay / 1000) + '秒后重连', '#e74c3c');
            if (state.deviceType === 'P' && everConnected) {
                logMsg('[局域网] 连接断开，正在重连...');
            }
            setTimeout(connect, retryDelay);
            retryDelay = Math.min(retryDelay * 2, 5000);
        };

        ws.onerror = function () {
            // onclose 会紧跟着触发并负责重连
        };
    }

    // 手机从后台切回来时立刻检查连接
    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible' &&
            (!state.socket || state.socket.readyState > 1)) {
            retryDelay = 1000;
            connect();
        }
    });

    connect();
}

function broadcastMessage(msg) {
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
        console.warn('[Broadcast] not connected, dropped type=' + msg.type);
        return;
    }
    msg.timestamp = Date.now();
    msg.sender = state.deviceId;
    console.log('[Broadcast] type=' + msg.type + ' target=' + (msg.target || '--'));
    state.socket.send(JSON.stringify(msg));
}

function broadcastPresence() {
    broadcastMessage({
        type: 'presence',
        deviceType: state.deviceType,
        deviceId: state.deviceId,
    });
}

// ========== P Screen ==========
function initPScreen() {
    logMsg('主控设备已启动，等待串口连接...');
    pUI.statusText.textContent = '未连接';
    pUI.pointingTarget.textContent = '--';
    pUI.pointingStatus.textContent = '等待串口数据...';

    // 连接局域网服务器
    initLanSocket();

    // Initialize polar plot
    state.polarPlot = PolarPlot.create('polar-canvas');

    // 投屏面板
    CastSender.init();

    // Initialize mode indicator (default: localization)
    updateModeUI();

    // Connect/disconnect buttons
    pUI.btnConnect.addEventListener('click', startSerialConnection);
    pUI.btnDisconnect.addEventListener('click', disconnectSerial);

    // Settings panel
    initSettingsPanel();

    // Mode switch button
    pUI.btnFixPos.addEventListener('click', function () {
        if (state.mode === 'localization') {
            switchMode('pointing');
        } else {
            switchMode('localization');
        }
    });

    // No periodic broadcast needed — only send on pointing state change
}

// ========== T Screen ==========
function initTScreen(deviceType) {
    tUI.deviceName.textContent = CONFIG.DEVICES[deviceType].label;
    tUI.statusText.textContent = '等待指向...';
    tUI.statusBadge.textContent = '未被指向';
    tUI.statusDisplay.className = 't-status-display red';

    // Update debug info
    var debugType = document.getElementById('t-my-type');
    if (debugType) debugType.textContent = deviceType;

    // 投屏接收
    CastReceiver.init();

    // 连接局域网服务器
    initLanSocket();
}

// ========== Serial Connection ==========
function startSerialConnection() {
    if (!navigator.serial) {
        logMsg('❌ 当前浏览器不支持 Web Serial API');
        pUI.statusText.textContent = '❌ 不支持 Web Serial';
        return;
    }

    state.serialReader = SerialReader.create();
    state.serialReader.onData = onData;

    SerialReader.requestPort(state.serialReader).then(function () {
        state.isMaster = true;
        pUI.statusText.textContent = '已连接';
        pUI.statusDot.className = 'status-dot on';
        pUI.btnConnect.classList.add('hidden');
        pUI.btnDisconnect.classList.remove('hidden');
        logMsg('✅ 串口已连接，开始读取数据...');
        SerialReader.startReading(state.serialReader);
    }).catch(function (err) {
        logMsg('❌ 串口连接失败: ' + err.message);
        pUI.statusText.textContent = '❌ 连接失败';
    });
}

function disconnectSerial() {
    if (state.serialReader) {
        SerialReader.close(state.serialReader);
        state.isMaster = false;
        pUI.statusText.textContent = '未连接';
        pUI.statusDot.className = 'status-dot off';
        pUI.btnConnect.classList.remove('hidden');
        pUI.btnDisconnect.classList.add('hidden');
        logMsg('⚠️ 串口已断开');
    }
}

// ========== Data Processing ==========
// 严格对齐 point_demo.py 的数据处理逻辑：
// 1. 离群检测（AZI_OUTLIER_THRESHOLD / DIS_OUTLIER_THRESHOLD）— 与 is_valid_measurement() 一致
// 2. 每收到一条数据，存入对应设备的原始数据队列（最多 SMOOTHING_WINDOW=5 条）
// 3. 计算窗口均值 → EMA(alpha=0.3) 平滑
// 4. 更新极坐标图 + 图例
// 5. 调用 computeBestIdx() 判断指向（和 Python 完全一致）
function onData(addr, dis, azi) {
    if (addr === null || dis === null || azi === null) return;

    // Map addr string to index (01→0, 02→1, 03→2)
    var idx = parseInt(addr, 10) - 1;
    if (idx < 0 || idx > 2) return;

    // 测距固定偏移校正（mm）：在数据入口统一扣除，后续离群检测 / 平滑 / 绘图 / 广播都使用校正后的距离
    dis = applyDistanceOffset(dis);

    try {
        processData(idx, dis, azi);
    } catch(e) {
        console.error('[main.onData] crash:', e);
    }
}

/**
 * 离群值检测 — 严格对齐 point_demo.py 中的 is_valid_measurement()
 *
 * Python 逻辑：
 *   - 需要至少 SMOOTHING_WINDOW 条历史数据才做检测
 *   - current_azi 与历史均值偏差 > AZI_OUTLIER_THRESHOLD → 无效
 *   - current_dis 与历史均值偏差 > DIS_OUTLIER_THRESHOLD → 无效
 *   - current_dis < 0 → 无效
 *
 * @returns {boolean} true=有效，false=离群/无效
 */
function isValidMeasurement(idx, dis, azi) {
    var dev = state.devices[idx];
    if (!dev || !dev.history) return true; // 尚无历史，视为有效（冷启动）

    var history = dev.history;

    // 需要至少 smoothingWindow 条历史数据才开始做离群检测
    if (history.length < CONFIG.DATA.smoothingWindow) return true;

    // 距离为负直接无效
    if (dis < 0) return false;

    // 计算历史均值（不含当前帧）
    var aziSum = 0, disSum = 0;
    for (var i = 0; i < history.length; i++) {
        aziSum += history[i].azi;
        disSum += history[i].dis;
    }
    var aziMean = aziSum / history.length;
    var disMean = disSum / history.length;

    // 角度离群检测
    if (Math.abs(azi - aziMean) > CONFIG.DATA.aziOutlierThreshold) {
        console.log('[Outlier] Device ' + idx + ' azi OUTLIER: cur=' + azi + ' mean=' + aziMean.toFixed(1) +
                    ' diff=' + Math.abs(azi - aziMean).toFixed(1) +
                    ' threshold=' + CONFIG.DATA.aziOutlierThreshold);
        return false;
    }

    // 距离离群检测
    if (Math.abs(dis - disMean) > CONFIG.DATA.disOutlierThreshold) {
        console.log('[Outlier] Device ' + idx + ' dis OUTLIER: cur=' + dis + ' mean=' + disMean.toFixed(1) +
                    ' diff=' + Math.abs(dis - disMean).toFixed(1) +
                    ' threshold=' + CONFIG.DATA.disOutlierThreshold);
        return false;
    }

    return true;
}

function processData(idx, dis, azi) {

    var dev = state.devices[idx];
    if (!dev) {
        dev = { smoothedDis: dis, smoothedAzi: azi, history: [] };
        state.devices[idx] = dev;
    }

    // Step 0: Outlier detection — skip invalid measurements entirely
    if (!isValidMeasurement(idx, dis, azi)) {
        logMsg('⚠️ ' + CONFIG.DEVICE_LABELS[idx] + ' 数据离群，已过滤 (azi=' + azi + ', dis=' + dis + ')');
        // Still render with existing data (no update to history/plot)
        state.polarPlot.setHighlight(computeBestIdx());
        state.polarPlot.render();
        return;
    }

    // Step 1: Push raw data into window buffer (max SMOOTHING_WINDOW entries)
    dev.history.push({ dis: dis, azi: azi });
    if (dev.history.length > CONFIG.DATA.smoothingWindow) {
        dev.history.shift();
    }

    // Step 2: Wait until we have enough samples before showing (aligns with Python's behavior)
    if (dev.history.length < CONFIG.DATA.smoothingWindow) {
        state.polarPlot.setHighlight(computeBestIdx());
        state.polarPlot.render();
        return;
    }

    // Step 3: Compute window average then apply EMA smoothing
    var avgDis = 0, avgAzi = 0;
    for (var i = 0; i < dev.history.length; i++) {
        avgDis += dev.history[i].dis;
        avgAzi += dev.history[i].azi;
    }
    avgDis /= dev.history.length;
    avgAzi /= dev.history.length;

    var alpha = CONFIG.DATA.smoothAlpha;
    dev.smoothedDis = alpha * avgDis + (1 - alpha) * dev.smoothedDis;
    dev.smoothedAzi = alpha * avgAzi + (1 - alpha) * dev.smoothedAzi;

    var aziDeg = parseFloat((dev.smoothedAzi / CONFIG.DATA.aziToDeg).toFixed(1));
    var disMm  = Math.round(dev.smoothedDis);
    var disCm  = parseFloat((disMm / 10).toFixed(1)); // mm → cm, 1 decimal

    // Step 4: Update polar plot
    // In localization mode: devices follow live smoothed data
    // In pointing mode: devices stay at locked position (only update if not yet locked)
    if (state.mode === 'localization') {
        state.polarPlot.updateDevice(idx, disMm, aziDeg);
    } else {
        // Pointing mode: use locked position for the plot
        if (dev.lockedDis !== null && dev.lockedAzi !== null) {
            var lockAziDeg = parseFloat((dev.lockedAzi / CONFIG.DATA.aziToDeg).toFixed(1));
            state.polarPlot.updateDevice(idx, Math.round(dev.lockedDis), lockAziDeg);
        }
        // If not yet locked (device appeared after mode switch), keep last known position
    }

    // Legend always shows live data (both modes)
    updateLegend(idx, disCm, aziDeg);

    // Step 5: Compute best_idx across ALL devices (same as Python's compute_best_idx)
    var newBestIdx = computeBestIdx();

    // Debounce: only broadcast after 3 consecutive frames agree on the same target
    if (newBestIdx === state._debounceTarget) {
        state._debounceCount++;
    } else {
        state._debounceTarget = newBestIdx;
        state._debounceCount = 1;
    }

    var DEBOUNCE_FRAMES = 3; // ~150ms at 20Hz serial rate

    if (state._debounceCount >= DEBOUNCE_FRAMES && newBestIdx !== state.currentBestIdx) {
        console.log('[onData] bestIdx STABLE & CHANGED: ' + state.currentBestIdx + ' → ' + newBestIdx + ' (after ' + state._debounceCount + ' frames)');
        state.currentBestIdx = newBestIdx;
        updateHighlight(newBestIdx);
        broadcastPointingState(newBestIdx);
    }

    // Render polar plot with current highlight (always use latest, not debounced)
    state.polarPlot.setHighlight(newBestIdx);
    state.polarPlot.render();
}

/**
 * 更新图例文字
 */
function updateLegend(idx, dis, azi) {
    var legendItem = document.getElementById('legend-' + idx);
    if (legendItem) {
        var dataSpan = legendItem.querySelector('.legend-data');
        if (dataSpan) {
            dataSpan.textContent = '距离: ' + dis + 'cm  角度: ' + azi + '°';
        }
    }
}

/**
 * 严格对齐 point_demo_test1.py 中的 get_highlight_index()
 *
 * Python 逻辑：
 * 1. 对每个设备计算窗口内原始 azi 均值 → device_avgs
 * 2. 至少 MIN_VALID_DEVICES(1) 个有效设备才继续
 * 3. best_idx = 角度均值最接近 0 的设备
 * 4. 稳定性判定：窗口内角度极差 <= POINTING_STABLE_RANGE(1000)
 *    且 |平均角度| <= POINTING_AZI_LIMIT(1000)
 *    （注意：这两个阈值都是原始 azi 单位，不是度数）
 */
function computeBestIdx() {
    var device_avgs = {};

    for (var i = 0; i < 3; i++) {
        var dev = state.devices[i];
        if (!dev || !dev.history || dev.history.length < CONFIG.DATA.smoothingWindow) continue;

        // 检查数据有效性（距离不能为离群值）
        var lastDis = dev.smoothedDis;
        if (lastDis == null) continue;

        // 计算窗口内原始 azi 均值（未除以 aziToDeg）
        var aziSum = 0;
        for (var j = 0; j < dev.history.length; j++) {
            aziSum += dev.history[j].azi;
        }
        device_avgs[i] = aziSum / dev.history.length;
    }

    // 至少需要 MIN_VALID_DEVICES 个有效设备
    var validKeys = Object.keys(device_avgs);
    console.log('[computeBestIdx] validDevices=' + validKeys.length + ' avgs=', device_avgs);
    if (validKeys.length < 1) return -1;

    // 找到角度最接近 0 的设备
    var best_idx = -1;
    var best_abs = Infinity;
    for (var k = 0; k < validKeys.length; k++) {
        var idx = parseInt(validKeys[k], 10);
        var absAzi = Math.abs(device_avgs[idx]);
        if (absAzi < best_abs) {
            best_abs = absAzi;
            best_idx = idx;
        }
    }

    // 稳定性判定：窗口内角度极差 + 均值范围
    var dev = state.devices[best_idx];
    var azisList = [];
    for (var m = 0; m < dev.history.length; m++) {
        azisList.push(dev.history[m].azi);
    }
    var aziRange = Math.max.apply(null, azisList) - Math.min.apply(null, azisList);
    var bestAzi = device_avgs[best_idx];

    console.log('[computeBestIdx] best=' + best_idx + ' aziAvg=' + bestAzi.toFixed(1) + ' historyAzis=' + azisList.join(',') + ' range=' + aziRange + ' limitRange=' + CONFIG.DATA.pointingStableRange + ' limitAzi=' + CONFIG.DATA.pointingAziLimit);

    if (aziRange <= CONFIG.DATA.pointingStableRange && Math.abs(bestAzi) <= CONFIG.DATA.pointingAziLimit) {
        console.log('[computeBestIdx] → PASS idx=' + best_idx);
        return best_idx;
    }
    console.log('[computeBestIdx] → FAIL (range ' + aziRange + '>' + CONFIG.DATA.pointingStableRange + '? ' + (aziRange > CONFIG.DATA.pointingStableRange) + ', absAzi ' + Math.abs(bestAzi).toFixed(1) + '>' + CONFIG.DATA.pointingAziLimit + '? ' + (Math.abs(bestAzi) > CONFIG.DATA.pointingAziLimit) + ')');
    return -1;
}

/**
 * 更新极坐标图高亮 + UI 指示器
 */
function updateHighlight(bestIdx) {
    if (bestIdx >= 0) {
        var targetType = 'T' + (bestIdx + 1);
        var dev = state.devices[bestIdx];
        var disMm = Math.round(dev.smoothedDis);
        var disCm = parseFloat((disMm / 10).toFixed(1));
        var azi = parseFloat((dev.smoothedAzi / CONFIG.DATA.aziToDeg).toFixed(1));

        pUI.pointingTarget.textContent = CONFIG.DEVICE_ADDRS[bestIdx] + ' (' + targetType + ')';
        pUI.pointingStatus.textContent = '指向中 | 距离:' + disCm + 'cm 角度:' + azi + '°';
        logMsg('🎯 指向 ' + targetType + ' (距离:' + disCm + 'cm, 角度:' + azi + '°)');
    } else {
        pUI.pointingTarget.textContent = '--';
        pUI.pointingStatus.textContent = '等待串口数据...';
    }
}

/**
 * 通过局域网广播当前指向状态给所有 T 设备
 */
function broadcastPointingState(bestIdx) {
    // 指向变化 → 投屏目标跟着变化
    CastSender.onPointing(bestIdx >= 0 ? 'T' + (bestIdx + 1) : null);

    if (!state.socket) return;

    if (bestIdx >= 0) {
        var targetType = 'T' + (bestIdx + 1);
        var dev = state.devices[bestIdx];
        var dis = Math.round(dev.smoothedDis);
        var azi = parseFloat((dev.smoothedAzi / CONFIG.DATA.aziToDeg).toFixed(1));

        broadcastMessage({
            type: 'point_at',
            target: targetType,
            dis: dis,
            azi: azi,
        });
    } else {
        broadcastMessage({
            type: 'point_stop',
        });
    }
}

// ========== Network Message Handler ==========
function onNetworkMessage(msg, senderId) {
    // Ignore messages from self
    if (senderId === state.deviceId) return;

    console.log('[T recv] msg.type=' + msg.type + ' target=' + (msg.target || '--') + ' myType=' + state.deviceType);

    switch (msg.type) {
        case 'presence':
            if (state.deviceType === 'P') {
                logMsg('[房间] 设备加入: ' + msg.deviceType + ' (' + msg.deviceId.substr(-6) + ')');
            }
            break;

        case 'raw_data':
            // Raw SLP data — P already displays locally
            break;

        case 'point_at':
            handlePointAt(msg);
            break;

        case 'point_stop':
            handlePointStop();
            break;

        case 'cast_target':
            if (state.deviceType !== 'P') CastReceiver.onTarget(msg.target);
            break;
    }
}

function handlePointAt(msg) {
    var match = state.deviceType === msg.target;
    console.log('[handlePointAt] msg.target=' + msg.target + '(type:' + typeof msg.target + ') my deviceType=' + state.deviceType + '(type:' + typeof state.deviceType + ') match=' + match);
    if (match) {
        // This T device is being pointed at → turn GREEN!
        tUI.statusDisplay.className = 't-status-display green';
        tUI.deviceIcon.textContent = '🟢';
        tUI.statusText.textContent = '被指向中！';
        var disCm = parseFloat((msg.dis / 10).toFixed(1));
        tUI.statusBadge.textContent = '距离: ' + disCm + 'cm | 角度: ' + msg.azi + '°';
    }
}

function handlePointStop() {
    if (state.deviceType && state.deviceType !== 'P') {
        // Reset T device display
        tUI.statusDisplay.className = 't-status-display red';
        tUI.deviceIcon.textContent = '🔴';
        tUI.statusText.textContent = '等待指向...';
        tUI.statusBadge.textContent = '未被指向';
    }
}

// ========== Settings Panel ==========
var DEFAULT_SETTINGS = {
    labels: ['设备1', '设备2', '设备3'],
    smoothingWindow: 5,
    aziOutlierThreshold: 8000,
    disOutlierThreshold: 2000,
    pointingAziLimit: 1600,
    pointingStableRange: 1000,
    smoothAlpha: 0.3,
    distanceOffset: -300,   // mm（设置面板中以 cm 显示）
};

var settingsUI = {};

function initSettingsPanel() {
    settingsUI.overlay   = document.getElementById('settings-overlay');
    settingsUI.btnSave   = document.getElementById('btn-settings-save');
    settingsUI.btnReset  = document.getElementById('btn-settings-reset');

    // Open
    pUI.btnSettings.addEventListener('click', function () {
        populateSettingsForm();
        settingsUI.overlay.classList.remove('hidden');
    });

    // Close on overlay background click
    settingsUI.overlay.addEventListener('click', function (e) {
        if (e.target === settingsUI.overlay) closeSettings();
    });

    // Save
    settingsUI.btnSave.addEventListener('click', function () {
        applySettingsFromForm();
        closeSettings();
    });

    // Reset to defaults
    settingsUI.btnReset.addEventListener('click', function () {
        resetSettingsToDefaults();
        populateSettingsForm();
    });
}

function closeSettings() {
    settingsUI.overlay.classList.add('hidden');
}

function populateSettingsForm() {
    for (var i = 0; i < 3; i++) {
        document.getElementById('set-label-' + i).value = CONFIG.DEVICE_LABELS[i] || DEFAULT_SETTINGS.labels[i];
    }
    document.getElementById('set-smoothing-window').value      = CONFIG.DATA.smoothingWindow;
    document.getElementById('set-azi-outlier').value            = CONFIG.DATA.aziOutlierThreshold;
    document.getElementById('set-dis-outlier').value            = CONFIG.DATA.disOutlierThreshold;
    document.getElementById('set-pointing-azi-limit').value     = CONFIG.DATA.pointingAziLimit;
    document.getElementById('set-pointing-stable-range').value  = CONFIG.DATA.pointingStableRange;
    document.getElementById('set-smooth-alpha').value           = CONFIG.DATA.smoothAlpha;
    document.getElementById('set-dis-offset').value             = (Number(CONFIG.DATA.distanceOffset) || 0) / 10; // mm → cm
}

function readSettingsForm() {
    var labels = [];
    for (var i = 0; i < 3; i++) {
        labels.push(document.getElementById('set-label-' + i).value.trim() || DEFAULT_SETTINGS.labels[i]);
    }
    return {
        labels:              labels,
        smoothingWindow:     parseInt(document.getElementById('set-smoothing-window').value, 10),
        aziOutlierThreshold: parseInt(document.getElementById('set-azi-outlier').value, 10),
        disOutlierThreshold: parseInt(document.getElementById('set-dis-outlier').value, 10),
        pointingAziLimit:    parseInt(document.getElementById('set-pointing-azi-limit').value, 10),
        pointingStableRange: parseInt(document.getElementById('set-pointing-stable-range').value, 10),
        smoothAlpha:         parseFloat(document.getElementById('set-smooth-alpha').value),
        distanceOffset:      Math.round(parseFloat(document.getElementById('set-dis-offset').value) * 10), // cm → mm
    };
}

function resetSettingsToDefaults() {
    CONFIG.DEVICE_LABELS = DEFAULT_SETTINGS.labels.slice();
    CONFIG.DATA.smoothingWindow      = DEFAULT_SETTINGS.smoothingWindow;
    CONFIG.DATA.aziOutlierThreshold  = DEFAULT_SETTINGS.aziOutlierThreshold;
    CONFIG.DATA.disOutlierThreshold  = DEFAULT_SETTINGS.disOutlierThreshold;
    CONFIG.DATA.pointingAziLimit     = DEFAULT_SETTINGS.pointingAziLimit;
    CONFIG.DATA.pointingStableRange  = DEFAULT_SETTINGS.pointingStableRange;
    CONFIG.DATA.smoothAlpha          = DEFAULT_SETTINGS.smoothAlpha;
    CONFIG.DATA.distanceOffset       = DEFAULT_SETTINGS.distanceOffset;
}

function applySettingsFromForm() {
    var s = readSettingsForm();

    // Validate ranges
    if (isNaN(s.smoothingWindow) || s.smoothingWindow < 1) s.smoothingWindow = DEFAULT_SETTINGS.smoothingWindow;
    if (isNaN(s.aziOutlierThreshold) || s.aziOutlierThreshold < 100) s.aziOutlierThreshold = DEFAULT_SETTINGS.aziOutlierThreshold;
    if (isNaN(s.disOutlierThreshold) || s.disOutlierThreshold < 100) s.disOutlierThreshold = DEFAULT_SETTINGS.disOutlierThreshold;
    if (isNaN(s.pointingAziLimit) || s.pointingAziLimit < 100) s.pointingAziLimit = DEFAULT_SETTINGS.pointingAziLimit;
    if (isNaN(s.pointingStableRange) || s.pointingStableRange < 100) s.pointingStableRange = DEFAULT_SETTINGS.pointingStableRange;
    if (isNaN(s.smoothAlpha) || s.smoothAlpha < 0.05) s.smoothAlpha = DEFAULT_SETTINGS.smoothAlpha;
    if (s.smoothAlpha > 1) s.smoothAlpha = 1;
    if (isNaN(s.distanceOffset)) s.distanceOffset = DEFAULT_SETTINGS.distanceOffset;
    s.distanceOffset = Math.max(-2000, Math.min(2000, s.distanceOffset));   // 限制在 ±200cm

    // Apply to CONFIG
    CONFIG.DEVICE_LABELS = s.labels;
    CONFIG.DATA.smoothingWindow      = s.smoothingWindow;
    CONFIG.DATA.aziOutlierThreshold  = s.aziOutlierThreshold;
    CONFIG.DATA.disOutlierThreshold  = s.disOutlierThreshold;
    CONFIG.DATA.pointingAziLimit     = s.pointingAziLimit;
    CONFIG.DATA.pointingStableRange  = s.pointingStableRange;
    CONFIG.DATA.smoothAlpha          = s.smoothAlpha;
    CONFIG.DATA.distanceOffset       = s.distanceOffset;

    // Refresh legend labels immediately
    for (var i = 0; i < 3; i++) {
        var nameSpan = document.querySelector('#legend-' + i + ' .legend-name');
        if (nameSpan) nameSpan.textContent = s.labels[i];
    }

    // Clear device histories so new window size takes effect immediately
    for (var j = 0; j < state.devices.length; j++) {
        if (state.devices[j]) state.devices[j].history = [];
    }

    logMsg('⚙️ 参数已更新: 窗口=' + s.smoothingWindow +
           ' | 离群(角度/距离)=' + s.aziOutlierThreshold + '/' + s.disOutlierThreshold +
           ' | 指向(偏差/稳定)=' + s.pointingAziLimit + '/' + s.pointingStableRange +
           ' | EMA=' + s.smoothAlpha +
           ' | 测距偏移=' + (s.distanceOffset / 10) + 'cm');
}

/**
 * 测距偏移校正：corrected = raw - CONFIG.DATA.distanceOffset（mm），结果不小于 0
 */
function applyDistanceOffset(rawDis) {
    var offset = Number(CONFIG.DATA.distanceOffset) || 0;
    return Math.max(0, rawDis - offset);
}

// ========== Logging ==========
function logMsg(text) {
    var time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    var entry = document.createElement('div');
    entry.className = 'log-entry';
    entry.textContent = '[' + time + '] ' + text;
    pUI.logContent.appendChild(entry);
    pUI.logContent.scrollTop = pUI.logContent.scrollHeight;
}
