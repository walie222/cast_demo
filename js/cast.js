/* ============================================
   局域网投屏
   P 端：共享屏幕/窗口 → 压缩成 JPEG → 通过 WebSocket 发给服务器
   服务器：只把画面转发给当前被指向（投屏目标）的那台 T
   T 端：收到画面后全屏显示
   ============================================ */

// ---------------------------------------------------------------- P 端
var CastSender = (function () {
    var s = {
        stream: null,          // getDisplayMedia 返回的流
        track: null,
        desiredTarget: null,   // 指向逻辑决定的目标
        sentTarget: undefined, // 最近一次告诉服务器的目标
        busy: false,           // 正在编码一帧
        lastSend: 0,
        frames: 0,
        bytes: 0,
        statTimer: null,
        reader: null,          // MediaStreamTrackProcessor 读取器（Chrome/Edge）
        video: null,           // 兼容模式：<video> + 定时器
        ticker: null,
        canvas: null,
        ctx: null,
    };

    var ui = {};

    function preset() {
        var key = ui.quality ? ui.quality.value : 'clear';
        return CONFIG.CAST.presets[key] || CONFIG.CAST.presets.clear;
    }

    function init() {
        ui.btnShare = document.getElementById('btn-cast-share');
        ui.btnStopShare = document.getElementById('btn-cast-stop-share');
        ui.btnEnd = document.getElementById('btn-cast-end');
        ui.quality = document.getElementById('cast-quality');
        ui.mode = document.getElementById('cast-mode');
        ui.preview = document.getElementById('cast-preview');
        ui.placeholder = document.getElementById('cast-preview-empty');
        ui.shareState = document.getElementById('cast-share-state');
        ui.target = document.getElementById('cast-target');
        ui.stats = document.getElementById('cast-stats');

        if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
            ui.btnShare.disabled = true;
            ui.shareState.textContent = '❌ 当前地址不支持屏幕共享（请用 http://localhost 打开）';
            return;
        }

        ui.btnShare.addEventListener('click', startShare);
        ui.btnStopShare.addEventListener('click', stopShare);
        ui.btnEnd.addEventListener('click', function () {
            s.desiredTarget = null;
            logMsg('📺 已手动结束投屏');
            syncTarget();
        });
        ui.mode.addEventListener('change', function () {
            // 切到「跟随」时，若当前没指向任何设备就立即结束
            if (ui.mode.value === 'follow' && state.currentBestIdx < 0) {
                s.desiredTarget = null;
                syncTarget();
            }
        });
        render();
    }

    function startShare() {
        var p = preset();
        navigator.mediaDevices.getDisplayMedia({
            video: { frameRate: { ideal: p.fps, max: 30 }, cursor: 'always' },
            audio: false,
        }).then(function (stream) {
            s.stream = stream;
            s.track = stream.getVideoTracks()[0];
            s.track.addEventListener('ended', stopShare);   // 浏览器自带「停止共享」按钮
            ui.preview.srcObject = stream;
            ui.preview.play().catch(function () {});
            logMsg('📺 已开始共享屏幕，指向哪台 T 就投屏到哪台');
            startCapture();
            syncTarget();
            render();
        }).catch(function (e) {
            if (e && e.name !== 'NotAllowedError') logMsg('❌ 屏幕共享失败: ' + e.message);
        });
    }

    function stopShare() {
        if (!s.stream) return;
        stopCapture();
        s.stream.getTracks().forEach(function (t) { t.stop(); });
        s.stream = null;
        s.track = null;
        ui.preview.srcObject = null;
        logMsg('📺 已停止共享屏幕');
        syncTarget();
        render();
    }

    // ---- 采集：优先用 MediaStreamTrackProcessor，P 页面切到后台也不会降速
    function startCapture() {
        s.canvas = document.createElement('canvas');
        s.ctx = s.canvas.getContext('2d');
        s.frames = 0; s.bytes = 0;
        clearInterval(s.statTimer);
        s.statTimer = setInterval(updateStats, 1000);

        if (typeof MediaStreamTrackProcessor === 'function') {
            var processor = new MediaStreamTrackProcessor({ track: s.track });
            s.reader = processor.readable.getReader();
            readLoop(s.reader);
        } else {
            // 兼容模式：用 Worker 计时（后台标签页里普通定时器会被限速到 1 秒一次）
            s.video = document.createElement('video');
            s.video.muted = true;
            s.video.playsInline = true;
            s.video.srcObject = s.stream;
            s.video.play().catch(function () {});
            var src = 'var t;onmessage=function(e){clearInterval(t);if(e.data>0)t=setInterval(function(){postMessage(0)},e.data)}';
            s.ticker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
            s.ticker.onmessage = function () {
                if (s.video && s.video.videoWidth) maybeSend(s.video, s.video.videoWidth, s.video.videoHeight);
            };
            s.ticker.postMessage(Math.round(1000 / preset().fps));
        }
    }

    function readLoop(reader) {
        reader.read().then(function (r) {
            if (r.done || reader !== s.reader) return;
            var frame = r.value;
            try {
                maybeSend(frame, frame.displayWidth, frame.displayHeight);
            } finally {
                frame.close();   // 必须释放，否则显存很快耗尽
            }
            readLoop(reader);
        }).catch(function () {});
    }

    function stopCapture() {
        if (s.reader) { s.reader.cancel().catch(function () {}); s.reader = null; }
        if (s.ticker) { s.ticker.terminate(); s.ticker = null; }
        if (s.video) { s.video.srcObject = null; s.video = null; }
        clearInterval(s.statTimer);
        s.busy = false;
    }

    function maybeSend(source, w, h) {
        var target = effectiveTarget();
        if (!target || s.busy || !w || !h) return;
        var ws = state.socket;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        var p = preset();
        var now = performance.now();
        if (now - s.lastSend < 1000 / p.fps) return;
        // 网络跟不上时丢帧，保证延迟不会越积越大
        if (ws.bufferedAmount > CONFIG.CAST.maxBufferedBytes) return;

        var scale = Math.min(1, p.maxWidth / w);
        var cw = Math.round(w * scale), ch = Math.round(h * scale);
        if (s.canvas.width !== cw || s.canvas.height !== ch) {
            s.canvas.width = cw; s.canvas.height = ch;
        }
        s.ctx.drawImage(source, 0, 0, cw, ch);
        s.lastSend = now;
        s.busy = true;
        s.canvas.toBlob(function (blob) {
            s.busy = false;
            if (!blob || effectiveTarget() !== target) return;
            if (state.socket && state.socket.readyState === WebSocket.OPEN) {
                state.socket.send(blob);
                s.frames++;
                s.bytes += blob.size;
            }
        }, 'image/jpeg', p.quality);
    }

    // ---- 目标管理
    function effectiveTarget() {
        return s.stream ? s.desiredTarget : null;
    }

    function syncTarget() {
        var t = effectiveTarget();
        if (t !== s.sentTarget && state.socket && state.socket.readyState === WebSocket.OPEN) {
            state.socket.send(JSON.stringify({ type: 'cast_target', target: t, sender: state.deviceId }));
            s.sentTarget = t;
            if (t) logMsg('📺 投屏到 ' + t);
        }
        render();
    }

    /** 指向逻辑每次确认新目标时调用：target 为 'T1'/'T2'/'T3' 或 null */
    function onPointing(target) {
        if (target) {
            s.desiredTarget = target;
        } else if (ui.mode && ui.mode.value === 'follow') {
            s.desiredTarget = null;       // 跟随模式：移开就结束
        }                                 // 锁定模式：保持上一台，直到指向另一台
        syncTarget();
    }

    /** 重新连上服务器后，重新告知当前目标 */
    function onReconnect() {
        s.sentTarget = undefined;
        syncTarget();
    }

    function updateStats() {
        if (ui.stats) {
            ui.stats.textContent = effectiveTarget()
                ? s.frames + ' 帧/秒 · ' + Math.round(s.bytes / 1024) + ' KB/秒'
                : '';
        }
        s.frames = 0; s.bytes = 0;
    }

    function render() {
        if (!ui.btnShare) return;
        var sharing = !!s.stream;
        var t = effectiveTarget();
        ui.btnShare.classList.toggle('hidden', sharing);
        ui.btnStopShare.classList.toggle('hidden', !sharing);
        ui.btnEnd.disabled = !t;
        ui.placeholder.classList.toggle('hidden', sharing);
        ui.preview.classList.toggle('hidden', !sharing);
        if (ui.shareState.textContent.indexOf('❌') !== 0) {
            ui.shareState.textContent = sharing ? '✅ 正在共享' : '未共享';
        }
        ui.target.textContent = t ? t : (sharing ? '等待指向…' : '--');
        ui.target.classList.toggle('live', !!t);
        if (!t && ui.stats) ui.stats.textContent = '';
    }

    return { init: init, onPointing: onPointing, onReconnect: onReconnect };
})();


// ---------------------------------------------------------------- T 端
var CastReceiver = (function () {
    var ui = {};
    var active = false;
    var decoding = false;
    var pending = null;   // 解码期间到达的最新一帧（旧的直接丢弃）
    var currentUrl = null;
    var frames = 0;

    function init() {
        ui.overlay = document.getElementById('cast-view');
        ui.img = document.getElementById('cast-img');
        ui.wait = document.getElementById('cast-wait');
        ui.label = document.getElementById('cast-label');
        ui.fps = document.getElementById('t-cast-fps');
        // 移到 <body> 顶层，保证盖住纸片人等所有 T 界面元素
        document.body.appendChild(ui.overlay);
        var dbg = document.getElementById('t-debug-info');
        if (dbg) document.body.appendChild(dbg);
        ui.overlay.addEventListener('click', toggleFullscreen);
        setInterval(function () {
            if (ui.fps) ui.fps.textContent = active ? frames + ' 帧/秒' : '未投屏';
            frames = 0;
        }, 1000);
    }

    function toggleFullscreen() {
        var el = document.documentElement;
        if (!document.fullscreenElement && el.requestFullscreen) {
            el.requestFullscreen().catch(function () {});
        } else if (document.exitFullscreen) {
            document.exitFullscreen().catch(function () {});
        }
    }

    /** 服务器广播投屏目标 */
    function onTarget(target) {
        var mine = !!target && target === state.deviceType;
        if (mine === active) return;
        active = mine;
        ui.overlay.classList.toggle('active', mine);
        document.body.classList.toggle('is-casting', mine);
        if (mine) {
            ui.wait.classList.remove('hidden');
            ui.label.classList.remove('fade');
            void ui.label.offsetWidth;          // 重新触发提示动画
            ui.label.classList.add('fade');
        } else {
            ui.img.removeAttribute('src');
            if (currentUrl) { URL.revokeObjectURL(currentUrl); currentUrl = null; }
            pending = null;
        }
    }

    /** 收到一帧 JPEG（Blob） */
    function onFrame(blob) {
        if (!active) return;
        frames++;
        if (decoding) { pending = blob; return; }
        show(blob);
    }

    function show(blob) {
        decoding = true;
        var url = URL.createObjectURL(blob);
        var img = new Image();
        img.onload = img.onerror = function () {
            if (active) {
                ui.img.src = url;
                ui.wait.classList.add('hidden');
                if (currentUrl) URL.revokeObjectURL(currentUrl);
                currentUrl = url;
            } else {
                URL.revokeObjectURL(url);
            }
            decoding = false;
            if (pending) { var next = pending; pending = null; show(next); }
        };
        img.src = url;
    }

    return { init: init, onTarget: onTarget, onFrame: onFrame };
})();
