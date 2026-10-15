/* ============================================
   极坐标图渲染器 (Canvas) — 标准半圆 -90° ~ +90°
   对齐 point_demo.py 的 MAX_DISPLAY_AZI=90 设计

   视觉版本 v2：纸板剧场风 · 标准半圆（俯视、无透视）· 魔法棒 + 魔法光束
   - 公开 API 与旧版完全一致：
       create(canvasId) → { updateDevice, clearDevices, setHighlight, render,
                            canvas, ctx, w, h, cx, cy, maxR, devices, highlightIdx }
   - 数据逻辑（量程计算、±90° 过滤、距离截断）与旧版一致，仅改变绘制方式
   - 指向判定逻辑不在本文件，本文件对 main.js 的 window.state 只读不写：
       state.mode === 'pointing' 时，读取每台设备 lockedAzi（锁存角）与 smoothedAzi（实时角），
       估算魔法棒当前朝向 heading = 平均(lockedAzi - smoothedAzi)，光束随之旋转。
   ============================================ */

var PolarPlot = (function() {

    /* ---------- 纸板剧场配色（与 T 设备纸板人偶一致）---------- */
    var INK        = '#4a3b30';   // 棕色马克笔描边
    var INK_SOFT   = '#6e5a48';
    var PENCIL     = 'rgba(110, 90, 72, 0.55)';  // 铅笔辅助线
    var PAPER      = '#f6ecd6';   // 地面：奶油色卡纸
    var BOARD      = '#c9a676';   // 牛皮纸板
    var BOARD_DARK = '#8b6844';   // 纸板厚度
    var HILITE     = '#ffe066';   // 荧光笔黄
    var RIBBON     = '#fff4c9';   // 丝带
    var FONT_HAND  = '"Patrick Hand", "Kalam", "Comic Sans MS", "Microsoft YaHei", "PingFang SC", sans-serif';
    var FONT_LABEL = '"Patrick Hand", "Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif';

    /* ---------- 稳定的伪随机（保证手绘抖动每帧一致，不闪烁）---------- */
    function hash(n) {
        var x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
        return x - Math.floor(x);
    }
    function jit(seed, amp) { return (hash(seed) - 0.5) * 2 * amp; }

    /* ---------- 颜色工具 ---------- */
    function shade(hex, amt) {
        // amt < 0 变暗，> 0 变亮
        var c = hex.replace('#', '');
        if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
        var r = parseInt(c.substr(0, 2), 16), g = parseInt(c.substr(2, 2), 16), b = parseInt(c.substr(4, 2), 16);
        function f(v) {
            v = amt < 0 ? v * (1 + amt) : v + (255 - v) * amt;
            return Math.max(0, Math.min(255, Math.round(v)));
        }
        return 'rgb(' + f(r) + ',' + f(g) + ',' + f(b) + ')';
    }
    function alpha(hex, a) {
        var c = hex.replace('#', '');
        var r = parseInt(c.substr(0, 2), 16), g = parseInt(c.substr(2, 2), 16), b = parseInt(c.substr(4, 2), 16);
        return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
    }

    /* ---------- 缓动 ---------- */
    function easeOutBack(t) {
        var c1 = 1.70158, c3 = c1 + 1;
        return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
    }
    function easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }

    function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
    function lerp(a, b, t) { return a + (b - a) * t; }

    function create(canvasId) {
        var canvas = document.getElementById(canvasId);
        if (!canvas) return null;
        var ctx = canvas.getContext('2d');

        /* ---- 画布尺寸（横版，适配半圆）+ 高清屏适配 ---- */
        var W = 750, H = 460;
        var DPR = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
        canvas.width = W * DPR;
        canvas.height = H * DPR;

        /* ---- 标准半圆（俯视，无透视）----
           地面坐标：X 横向（右为正），Z 向前（0° 方向），单位 = 最大量程半径
           屏幕：原点在底边中央，0° 朝正上方，半径 RADIUS 像素 */
        var RADIUS   = 312;
        var ORIGIN_Y = 392;
        var SLAB_T   = 8;              // 纸板厚度（向右下错开的深色层）

        var cx = W / 2;
        var cy = ORIGIN_Y;
        var maxR = RADIUS;

        function project(X, Z) {
            return { x: cx + RADIUS * X, y: cy - RADIUS * Z, s: 1 };
        }
        function projPolar(rNorm, aziDeg) {
            var a = aziDeg * Math.PI / 180;
            return project(rNorm * Math.sin(a), rNorm * Math.cos(a));
        }

        var self = {
            canvas: canvas,
            ctx: ctx,
            w: W,
            h: H,
            cx: cx,
            cy: cy,
            maxR: maxR,
            // devices[0]=T1(addr01), devices[1]=T2(addr02), devices[2]=T3(addr03)
            devices: [null, null, null],
            highlightIdx: -1,
        };

        /* ---- 动画状态（纯视觉，不影响数据）---- */
        var anim = {
            open: [0, 0, 0],          // 礼物盒开启进度 0..1
            openedAt: [0, 0, 0],      // 打开时间戳（用于粒子爆发）
            beamT: 0,                 // 0 = 定位模式（连线），1 = 指向模式（魔法光束）
            hitT: 0,                  // 0 = 搜索光束，1 = 命中光束
            heading: 0,               // 魔法棒显示朝向（度，已平滑）
            hitAt: 0,                 // 最近一次命中的时间戳
            lastHit: -1,
            raf: null,
            last: 0,
        };

        self.updateDevice = function(idx, dis, azi) {
            if (idx >= 0 && idx <= 2) {
                self.devices[idx] = { dis: Number(dis), azi: Number(azi) };
            }
        };

        self.clearDevices = function() {
            self.devices = [null, null, null];
        };

        self.setHighlight = function(idx) {
            if (idx !== self.highlightIdx && idx >= 0 && idx <= 2) {
                anim.openedAt[idx] = performance.now();
            }
            self.highlightIdx = idx; // 0/1/2 or -1
            ensureLoop();
        };

        self.render = function() {
            // 动画循环运行中时由下一帧统一绘制，避免 20Hz 数据 + 60fps 动画重复绘制
            if (anim.raf) return;
            _draw(ctx);
            ensureLoop();
        };

        /* ---- 只读：当前模式 & 魔法棒朝向估算 ---- */
        function readMode() {
            var st = window.state;
            return (st && st.mode === 'pointing') ? 'pointing' : 'localization';
        }
        // 指向模式下：设备坐标锁定在 lockedAzi，实时角 smoothedAzi 随 P 转动而变化。
        // P 向右转 θ，设备的实时角减少 θ → θ ≈ lockedAzi - smoothedAzi。多台设备取平均。
        function readHeading() {
            var st = window.state;
            if (!st || !st.devices || st.mode !== 'pointing') return null;
            var k = (window.CONFIG && CONFIG.DATA && CONFIG.DATA.aziToDeg) || 100;
            var sum = 0, n = 0;
            for (var i = 0; i < st.devices.length; i++) {
                var d = st.devices[i];
                if (!d || d.lockedAzi == null || d.smoothedAzi == null) continue;
                sum += (d.lockedAzi - d.smoothedAzi) / k;
                n++;
            }
            if (!n) return null;
            return Math.max(-90, Math.min(90, sum / n));
        }
        function hitIndex() {
            var i = self.highlightIdx;
            return (readMode() === 'pointing' && i >= 0 && self.devices[i]) ? i : -1;
        }

        /* ---- 动画循环：仅在有动画时运行 ---- */
        function needsAnim() {
            if (readMode() === 'pointing') return true;            // 光束持续流动
            if (anim.beamT > 0.001) return true;                    // 模式切换过渡
            if (self.highlightIdx >= 0 && self.devices[self.highlightIdx]) return true;
            for (var i = 0; i < 3; i++) if (anim.open[i] > 0.001) return true;
            return false;
        }
        function ensureLoop() {
            if (anim.raf || !needsAnim()) return;
            anim.last = performance.now();
            anim.raf = requestAnimationFrame(tick);
        }
        function tick(now) {
            anim.raf = null;
            var dt = Math.min(0.1, (now - anim.last) / 1000);
            anim.last = now;
            for (var i = 0; i < 3; i++) {
                var target = (i === self.highlightIdx && self.devices[i]) ? 1 : 0;
                var speed = target ? 1.8 : 3.2;    // 打开 ~0.55s，合上 ~0.3s
                if (anim.open[i] < target) anim.open[i] = Math.min(target, anim.open[i] + dt * speed);
                else if (anim.open[i] > target) anim.open[i] = Math.max(target, anim.open[i] - dt * speed);
            }
            // 模式过渡：连线 ↔ 光束（约 0.6s）
            var beamTarget = readMode() === 'pointing' ? 1 : 0;
            anim.beamT = beamTarget ? Math.min(1, anim.beamT + dt / 0.6) : Math.max(0, anim.beamT - dt / 0.4);
            // 命中过渡（约 0.35s 锁定，0.5s 松开）
            var hi = hitIndex();
            if (hi >= 0 && hi !== anim.lastHit) anim.hitAt = now;
            anim.lastHit = hi;
            anim.hitT = hi >= 0 ? Math.min(1, anim.hitT + dt / 0.35) : Math.max(0, anim.hitT - dt / 0.5);
            // 朝向平滑：临界阻尼式跟随，20Hz 数据也能 60fps 平滑转动
            var h = readHeading();
            var targetHeading = h == null ? (beamTarget ? anim.heading : 0) : h;
            anim.heading += (targetHeading - anim.heading) * (1 - Math.exp(-dt * 9));

            _draw(ctx);
            if (needsAnim()) anim.raf = requestAnimationFrame(tick);
        }

        // 模式按钮切换时（main.js 会改 #mode-badge 的 class）立即启动过渡动画
        var badge = document.getElementById('mode-badge');
        if (badge && window.MutationObserver) {
            new MutationObserver(function () { ensureLoop(); if (!anim.raf) _draw(ctx); })
                .observe(badge, { attributes: true, attributeFilter: ['class'] });
        }

        /* ---- 绘制常量（与旧版一致）---- */
        var DEFAULT_MAX_DIS = 1000;
        var SCALE_MARGIN_FACTOR = 1.2;
        var SCALE_STEP = 200;
        var MAX_DISPLAY_AZI = 90;       // 显示范围 ±90°

        // 角度标注映射（原始 azi → 屏幕标签）
        var CARDINAL_LABELS = {
            '-90': '-90°', '-60': '-60°', '-30': '-30°',
            '0': '0°', '30': '30°', '60': '60°', '90': '90°'
        };

        function computeScale() {
            var maxDis = 0;
            for (var i = 0; i < 3; i++) {
                var dev = self.devices[i];
                if (dev && dev.dis > 0 && dev.dis > maxDis) {
                    maxDis = dev.dis;
                }
            }
            if (maxDis <= 0) return DEFAULT_MAX_DIS;
            var scaled = maxDis * SCALE_MARGIN_FACTOR;
            return Math.ceil(scaled / SCALE_STEP) * SCALE_STEP;
        }

        /* =========================================================
           手绘笔触工具
           ========================================================= */

        // 沿折线绘制带轻微抖动的平滑线（两遍：主线 + 淡色复描）
        function sketchPoly(c, pts, seed, opt) {
            opt = opt || {};
            var passes = opt.passes || 2;
            var amp = opt.amp == null ? 0.9 : opt.amp;
            for (var p = 0; p < passes; p++) {
                var q = [];
                for (var i = 0; i < pts.length; i++) {
                    q.push({
                        x: pts[i].x + jit(seed + i * 7.3 + p * 101, amp * (p ? 1.4 : 1)),
                        y: pts[i].y + jit(seed + i * 3.7 + p * 211, amp * (p ? 1.4 : 1))
                    });
                }
                c.beginPath();
                c.moveTo(q[0].x, q[0].y);
                if (q.length === 2) {
                    var mx = (q[0].x + q[1].x) / 2 + jit(seed + p * 17, amp * 1.6);
                    var my = (q[0].y + q[1].y) / 2 + jit(seed + p * 29, amp * 1.6);
                    c.quadraticCurveTo(mx, my, q[1].x, q[1].y);
                } else {
                    for (var j = 1; j < q.length - 1; j++) {
                        var xc = (q[j].x + q[j + 1].x) / 2, yc = (q[j].y + q[j + 1].y) / 2;
                        c.quadraticCurveTo(q[j].x, q[j].y, xc, yc);
                    }
                    c.lineTo(q[q.length - 1].x, q[q.length - 1].y);
                }
                if (opt.close) c.closePath();
                c.globalAlpha = p ? (opt.secondAlpha || 0.35) : (opt.alpha || 1);
                c.stroke();
                c.globalAlpha = 1;
            }
        }

        function sketchLine(c, x1, y1, x2, y2, seed, opt) {
            sketchPoly(c, [{ x: x1, y: y1 }, { x: x2, y: y2 }], seed, opt);
        }

        // 手绘多边形（填充 + 描边）
        function sketchShape(c, pts, fill, seed, lw) {
            c.beginPath();
            c.moveTo(pts[0].x, pts[0].y);
            for (var i = 1; i < pts.length; i++) c.lineTo(pts[i].x, pts[i].y);
            c.closePath();
            if (fill) { c.fillStyle = fill; c.fill(); }
            c.strokeStyle = INK;
            c.lineWidth = lw || 1.8;
            c.lineJoin = 'round';
            for (var k = 0; k < pts.length; k++) {
                var a = pts[k], b = pts[(k + 1) % pts.length];
                sketchLine(c, a.x, a.y, b.x, b.y, seed + k * 13, { amp: 0.55, secondAlpha: 0.25 });
            }
        }

        // 手绘标签（纸条 + 墨水边）
        function drawTag(c, text, x, y, seed, opt) {
            opt = opt || {};
            c.font = opt.font || ('bold 16px ' + FONT_LABEL);
            var tw = c.measureText(text).width;
            var pw = tw + 16, ph = 24;
            var x0 = x - pw / 2, y0 = y - ph / 2;
            var rot = jit(seed, 0.035);
            c.save();
            c.translate(x, y);
            c.rotate(rot);
            c.translate(-x, -y);
            // 投影
            c.fillStyle = 'rgba(45,42,50,0.18)';
            c.fillRect(x0 + 2.5, y0 + 2.5, pw, ph);
            sketchShape(c, [
                { x: x0, y: y0 }, { x: x0 + pw, y: y0 },
                { x: x0 + pw, y: y0 + ph }, { x: x0, y: y0 + ph }
            ], opt.fill || PAPER, seed + 3, 1.6);
            c.fillStyle = opt.color || INK;
            c.textAlign = 'center';
            c.textBaseline = 'middle';
            c.fillText(text, x, y + 1);
            c.restore();
        }

        // 四角星闪光
        function drawSparkle(c, x, y, r, color, rot) {
            c.save();
            c.translate(x, y);
            c.rotate(rot || 0);
            c.beginPath();
            for (var i = 0; i < 8; i++) {
                var ang = i * Math.PI / 4;
                var rr = (i % 2 === 0) ? r : r * 0.32;
                c.lineTo(Math.cos(ang) * rr, Math.sin(ang) * rr);
            }
            c.closePath();
            c.fillStyle = color;
            c.fill();
            c.strokeStyle = INK;
            c.lineWidth = 1.2;
            c.stroke();
            c.restore();
        }

        /* =========================================================
           礼物盒
           ========================================================= */
        function drawGiftBox(c, i, gx, gy, s, color, openT, now) {
            var w   = 44 * s;           // 盒宽
            var hgt = 31 * s;           // 盒高
            var dep = 24 * s;           // 纵深
            var ox = dep * 0.62, oy = -dep * 0.48;   // 纵深偏移（右上）
            var seed = 1000 + i * 97;

            // 前面左下角，使盒子底面中心落在地面点上
            var x0 = gx - w / 2 - ox / 2;
            var y0 = gy - oy / 2;

            var front = color, side = shade(color, -0.28), top = shade(color, 0.22);

            // ---- 地面阴影 ----
            c.beginPath();
            c.ellipse(gx + 3 * s, gy + 2 * s, w * 0.78, dep * 0.55, 0, 0, Math.PI * 2);
            c.fillStyle = 'rgba(45,42,50,0.16)';
            c.fill();

            // ---- 打开时：盒内光柱（画在盒体前，被盒体正面遮挡下半部）----
            var lidT = openT > 0 ? easeOutBack(Math.min(1, openT)) : 0;
            var glowT = easeInOut(Math.min(1, openT));
            var topY = y0 - hgt;
            var mouthCx = x0 + w / 2 + ox / 2, mouthCy = topY + oy / 2;

            if (glowT > 0.01) {
                // 光晕
                var g = c.createRadialGradient(mouthCx, mouthCy - 18 * s, 2, mouthCx, mouthCy - 18 * s, 70 * s);
                g.addColorStop(0, 'rgba(255, 224, 102,' + (0.75 * glowT) + ')');
                g.addColorStop(1, 'rgba(255, 224, 102, 0)');
                c.fillStyle = g;
                c.beginPath();
                c.arc(mouthCx, mouthCy - 18 * s, 70 * s, 0, Math.PI * 2);
                c.fill();

                // 手绘光束线条
                c.strokeStyle = 'rgba(232, 164, 0,' + (0.9 * glowT) + ')';
                c.lineWidth = 2;
                c.lineCap = 'round';
                var rays = 7;
                for (var r = 0; r < rays; r++) {
                    var ang = -Math.PI / 2 + (r - (rays - 1) / 2) * 0.32;
                    var wob = Math.sin(now / 260 + r * 1.7) * 3 * s;
                    var r1 = 22 * s, r2 = (40 + (r % 2) * 10) * s * glowT + wob;
                    sketchLine(c,
                        mouthCx + Math.cos(ang) * r1, mouthCy + Math.sin(ang) * r1 - 6 * s,
                        mouthCx + Math.cos(ang) * (r1 + r2), mouthCy + Math.sin(ang) * (r1 + r2) - 6 * s,
                        seed + 500 + r, { amp: 0.6, passes: 1 });
                }
            }

            // ---- 盒体：侧面 ----
            sketchShape(c, [
                { x: x0 + w, y: y0 }, { x: x0 + w + ox, y: y0 + oy },
                { x: x0 + w + ox, y: topY + oy }, { x: x0 + w, y: topY }
            ], side, seed + 1);

            // ---- 盒体：正面 ----
            sketchShape(c, [
                { x: x0, y: y0 }, { x: x0 + w, y: y0 },
                { x: x0 + w, y: topY }, { x: x0, y: topY }
            ], front, seed + 2);

            // 正面铅笔排线（手绘质感）
            c.save();
            c.beginPath();
            c.rect(x0, topY, w, hgt);
            c.clip();
            c.strokeStyle = 'rgba(255,255,255,0.22)';
            c.lineWidth = 1;
            for (var hx = -hgt; hx < w; hx += 6 * s) {
                c.beginPath();
                c.moveTo(x0 + hx, y0);
                c.lineTo(x0 + hx + hgt, topY);
                c.stroke();
            }
            c.restore();

            // ---- 丝带（正面竖带 + 侧面竖带）----
            var rb = w * 0.18;
            sketchShape(c, [
                { x: x0 + w / 2 - rb / 2, y: y0 }, { x: x0 + w / 2 + rb / 2, y: y0 },
                { x: x0 + w / 2 + rb / 2, y: topY }, { x: x0 + w / 2 - rb / 2, y: topY }
            ], RIBBON, seed + 3, 1.3);
            var sm = 0.5, sb = 0.18;
            sketchShape(c, [
                { x: x0 + w + ox * (sm - sb / 2), y: y0 + oy * (sm - sb / 2) },
                { x: x0 + w + ox * (sm + sb / 2), y: y0 + oy * (sm + sb / 2) },
                { x: x0 + w + ox * (sm + sb / 2), y: topY + oy * (sm + sb / 2) },
                { x: x0 + w + ox * (sm - sb / 2), y: topY + oy * (sm - sb / 2) }
            ], shade('#fff4c9', -0.12), seed + 4, 1.3);

            // ---- 盒口（打开时显示内部）----
            var mouth = [
                { x: x0, y: topY }, { x: x0 + w, y: topY },
                { x: x0 + w + ox, y: topY + oy }, { x: x0 + ox, y: topY + oy }
            ];
            if (openT > 0.02) {
                sketchShape(c, mouth, shade(color, -0.55), seed + 5, 1.5);
                // 内部暖光
                c.save();
                c.beginPath();
                c.moveTo(mouth[0].x, mouth[0].y);
                for (var mi = 1; mi < 4; mi++) c.lineTo(mouth[mi].x, mouth[mi].y);
                c.closePath();
                c.clip();
                var ig = c.createRadialGradient(mouthCx, mouthCy, 1, mouthCx, mouthCy, w * 0.7);
                ig.addColorStop(0, 'rgba(255, 236, 140,' + (0.95 * glowT) + ')');
                ig.addColorStop(1, 'rgba(255, 236, 140, 0)');
                c.fillStyle = ig;
                c.fillRect(x0 - 5, topY + oy - 5, w + ox + 10, -oy + 10);
                c.restore();
            } else {
                sketchShape(c, mouth, top, seed + 5);
            }

            // ---- 盖子（含蝴蝶结）----
            var oh = 3 * s;               // 盖子外沿
            var lidH = 8 * s;
            var lift = lidT * 18 * s;
            var tilt = -lidT * 0.55;      // 向左后方掀起
            var shiftX = -lidT * 6 * s;
            var lx0 = x0 - oh, lw = w + oh * 2;
            var ly0 = topY + oh * 0.6;    // 盖子前下沿

            c.save();
            // 以盖子左后角为铰链旋转
            var hingeX = lx0, hingeY = ly0 - lidH;
            c.translate(hingeX + shiftX, hingeY - lift);
            c.rotate(tilt);
            c.translate(-hingeX, -hingeY);

            // 盖子侧面
            sketchShape(c, [
                { x: lx0 + lw, y: ly0 }, { x: lx0 + lw + ox, y: ly0 + oy },
                { x: lx0 + lw + ox, y: ly0 - lidH + oy }, { x: lx0 + lw, y: ly0 - lidH }
            ], shade(color, -0.18), seed + 6, 1.6);
            // 盖子正面
            sketchShape(c, [
                { x: lx0, y: ly0 }, { x: lx0 + lw, y: ly0 },
                { x: lx0 + lw, y: ly0 - lidH }, { x: lx0, y: ly0 - lidH }
            ], shade(color, 0.08), seed + 7, 1.6);
            // 盖子顶面
            var lt = ly0 - lidH;
            sketchShape(c, [
                { x: lx0, y: lt }, { x: lx0 + lw, y: lt },
                { x: lx0 + lw + ox, y: lt + oy }, { x: lx0 + ox, y: lt + oy }
            ], top, seed + 8, 1.6);
            // 盖子上的十字丝带
            sketchShape(c, [
                { x: lx0 + lw / 2 - rb / 2, y: ly0 }, { x: lx0 + lw / 2 + rb / 2, y: ly0 },
                { x: lx0 + lw / 2 + rb / 2, y: lt }, { x: lx0 + lw / 2 - rb / 2, y: lt }
            ], RIBBON, seed + 9, 1.2);
            sketchShape(c, [
                { x: lx0 + lw / 2 - rb / 2, y: lt }, { x: lx0 + lw / 2 + rb / 2, y: lt },
                { x: lx0 + lw / 2 + rb / 2 + ox, y: lt + oy }, { x: lx0 + lw / 2 - rb / 2 + ox, y: lt + oy }
            ], RIBBON, seed + 10, 1.2);

            // 蝴蝶结
            var bx = lx0 + lw / 2 + ox / 2, by = lt + oy / 2;
            var bw = 10 * s, bh = 7 * s;
            c.lineWidth = 1.6;
            c.strokeStyle = INK;
            c.fillStyle = RIBBON;
            [-1, 1].forEach(function(dir) {
                c.beginPath();
                c.moveTo(bx, by);
                c.bezierCurveTo(bx + dir * bw * 1.3, by - bh * 1.8, bx + dir * bw * 1.6, by + bh * 0.2, bx, by);
                c.fill();
                c.stroke();
            });
            // 飘带
            c.beginPath();
            c.moveTo(bx, by);
            c.quadraticCurveTo(bx - 4 * s, by + 6 * s, bx - 7 * s, by + 9 * s);
            c.moveTo(bx, by);
            c.quadraticCurveTo(bx + 4 * s, by + 6 * s, bx + 8 * s, by + 8 * s);
            c.stroke();
            c.beginPath();
            c.arc(bx, by, 2.4 * s, 0, Math.PI * 2);
            c.fillStyle = shade('#fff4c9', -0.2);
            c.fill();
            c.stroke();
            c.restore();

            // ---- 闪光与粒子 ----
            if (glowT > 0.01) {
                // 环绕闪烁的星星
                var starColors = ['#ffd43b', '#ffffff', alpha(color.length === 7 ? color : '#ffd43b', 1)];
                for (var k = 0; k < 6; k++) {
                    var ph = now / 900 + k * (Math.PI * 2 / 6);
                    var rad = (34 + 6 * Math.sin(now / 400 + k)) * s;
                    var sx = mouthCx + Math.cos(ph) * rad * 1.15;
                    var sy = mouthCy - 22 * s + Math.sin(ph) * rad * 0.55;
                    var tw = 0.5 + 0.5 * Math.sin(now / 160 + k * 2.1);
                    drawSparkle(c, sx, sy, (3 + 4 * tw) * s * glowT, starColors[k % 3], now / 1200 + k);
                }
                // 爆发 + 循环上升的纸屑粒子
                var since = (now - anim.openedAt[i]) / 1000;
                var confetti = ['#ff6b6b', '#ffd43b', '#4dabf7', '#69db7c', '#f783ac', color];
                for (var p = 0; p < 14; p++) {
                    var life = 1.6;
                    var tt = ((since + p * (life / 14)) % life) / life;   // 0..1
                    var spread = (hash(p * 3.1 + i) - 0.5) * 2;
                    var px = mouthCx + spread * 38 * s * tt + Math.sin(tt * 6 + p) * 3 * s;
                    var py = mouthCy - 8 * s - (70 * tt - 30 * tt * tt) * s;
                    var a = (1 - tt) * glowT;
                    c.save();
                    c.globalAlpha = a;
                    c.translate(px, py);
                    c.rotate(tt * 8 + p);
                    c.fillStyle = confetti[p % confetti.length];
                    c.strokeStyle = INK;
                    c.lineWidth = 0.8;
                    if (p % 3 === 0) {
                        c.beginPath(); c.arc(0, 0, 2.6 * s, 0, Math.PI * 2); c.fill(); c.stroke();
                    } else if (p % 3 === 1) {
                        c.fillRect(-3 * s, -1.5 * s, 6 * s, 3 * s); c.strokeRect(-3 * s, -1.5 * s, 6 * s, 3 * s);
                    } else {
                        c.beginPath(); c.moveTo(-3 * s, 0); c.quadraticCurveTo(0, -3 * s, 3 * s, 0);
                        c.strokeStyle = confetti[p % confetti.length]; c.lineWidth = 2; c.stroke();
                    }
                    c.restore();
                }
            }

            // 返回标签锚点（盒子+盖子的上方）
            return { tagX: gx, tagY: topY + oy - lidH - 22 * s - lidT * 52 * s };
        }

        /* =========================================================
           静态层（背景纸板 + 半圆地面 + 刻度 + 标注）
           只在量程变化 / 字体加载完成时重画，平时直接贴图 → 每帧开销很小
           ========================================================= */
        var staticLayer = document.createElement('canvas');
        staticLayer.width = W * DPR;
        staticLayer.height = H * DPR;
        var staticKey = '';

        function semicirclePath(c, rPx, dx, dy) {
            c.beginPath();
            c.moveTo(cx - rPx + (dx || 0), cy + (dy || 0));
            c.arc(cx + (dx || 0), cy + (dy || 0), rPx, Math.PI, 0, false);
            c.closePath();
        }
        // 半圆外缘的手绘点列（带抖动）
        function arcPoints(rn, step) {
            var pts = [];
            for (var a = -MAX_DISPLAY_AZI; a <= MAX_DISPLAY_AZI + 0.001; a += step) pts.push(projPolar(rn, a));
            return pts;
        }

        function drawStatic(c, MAX_DIS, RING_STEPS) {
            c.setTransform(DPR, 0, 0, DPR, 0, 0);
            c.clearRect(0, 0, W, H);
            c.lineCap = 'round';
            c.lineJoin = 'round';

            // 背景透明：不再绘制纸板底框，半圆直接放在页面上

            // ===== 半圆地面：奶油卡纸剪片（纸板厚度 + 投影 + 马克笔描边）=====
            semicirclePath(c, RADIUS + 6, 7, 9);
            c.fillStyle = 'rgba(60, 38, 20, 0.28)';
            c.fill();
            semicirclePath(c, RADIUS + 6, 4, SLAB_T);
            c.fillStyle = BOARD_DARK;
            c.fill();
            semicirclePath(c, RADIUS + 6);
            c.fillStyle = PAPER;
            c.fill();

            // 地面淡淡的铅笔方格（裁剪在半圆内）
            c.save();
            semicirclePath(c, RADIUS + 6);
            c.clip();
            c.strokeStyle = 'rgba(110, 90, 72, 0.10)';
            c.lineWidth = 1;
            for (var gx = cx % 24; gx <= W; gx += 24) { c.beginPath(); c.moveTo(gx + 0.5, 0); c.lineTo(gx + 0.5, H); c.stroke(); }
            for (var gy = cy % 24; gy <= H; gy += 24) { c.beginPath(); c.moveTo(0, gy + 0.5); c.lineTo(W, gy + 0.5); c.stroke(); }
            c.restore();

            // 外缘 + 直径（手绘马克笔）
            c.strokeStyle = INK;
            c.lineWidth = 3;
            var rim = arcPoints((RADIUS + 6) / RADIUS, 3);
            sketchPoly(c, rim, 51, { amp: 0.8 });
            var L = project(-(RADIUS + 6) / RADIUS, 0), R = project((RADIUS + 6) / RADIUS, 0);
            sketchLine(c, L.x, L.y, R.x, R.y, 52, { amp: 0.6 });

            // ===== 同心半圆（距离刻度环）=====
            for (var ri = 0; ri < RING_STEPS.length; ri++) {
                var rn = RING_STEPS[ri] / MAX_DIS;
                if (rn > 1.001) continue;
                c.strokeStyle = rn >= 0.999 ? INK_SOFT : PENCIL;
                c.lineWidth = rn >= 0.999 ? 1.8 : 1.3;
                c.setLineDash(rn >= 0.999 ? [] : [6, 6]);
                sketchPoly(c, arcPoints(rn, 4), 60 + ri * 11, { amp: 0.5, passes: 1 });
                c.setLineDash([]);
            }

            // ===== 径向线（每 30° 一条）=====
            var o = project(0, 0);
            for (var ra = -MAX_DISPLAY_AZI + 30; ra <= MAX_DISPLAY_AZI - 30; ra += 30) {
                var e = projPolar(1, ra);
                c.strokeStyle = ra === 0 ? INK_SOFT : PENCIL;
                c.lineWidth = ra === 0 ? 1.6 : 1.1;
                c.setLineDash(ra === 0 ? [8, 6] : [4, 6]);
                sketchLine(c, o.x, o.y, e.x, e.y, 80 + ra, { amp: 0.6, passes: 1 });
                c.setLineDash([]);
            }

            // ===== 距离刻度：写在直径下方（mm→cm 取整）=====
            c.font = 'bold 15px ' + FONT_HAND;
            c.textBaseline = 'middle';
            // 刻度太密时隔几个环才写一个数字（相邻数字至少间隔 ~38px）
            var ringPx = RADIUS * SCALE_STEP / MAX_DIS;
            var labelEvery = Math.max(1, Math.ceil(38 / ringPx));
            for (var ti = 0; ti < RING_STEPS.length; ti++) {
                var tn = RING_STEPS[ti] / MAX_DIS;
                if (tn > 1.001) continue;
                var isOuter = ti === RING_STEPS.length - 1;
                var showNum = isOuter || (((ti + 1) % labelEvery === 0) && (RING_STEPS.length - 1 - ti) >= labelEvery);
                [-1, 1].forEach(function (side) {
                    var tp = project(side * tn, 0);
                    c.strokeStyle = INK;
                    c.lineWidth = 1.5;
                    sketchLine(c, tp.x, tp.y, tp.x, tp.y + (showNum ? 7 : 4), 90 + ti + side, { passes: 1, amp: 0.3 });
                    if (side > 0 && showNum) {
                        c.fillStyle = INK;
                        c.textAlign = 'center';
                        c.fillText(Math.round(RING_STEPS[ti] / 10), tp.x, tp.y + SLAB_T + 14);
                    }
                });
            }
            c.fillStyle = INK_SOFT;
            c.textAlign = 'left';
            c.fillText('cm', R.x + 8, R.y + SLAB_T + 14);

            // ===== 角度标注（纸片小标签）=====
            for (var ka = -MAX_DISPLAY_AZI; ka <= MAX_DISPLAY_AZI; ka += 30) {
                var label = CARDINAL_LABELS[String(ka)] || (ka + '°');
                var lp2 = projPolar(1.11, ka);
                if (Math.abs(ka) === 90) lp2 = { x: lp2.x, y: cy - 14 };
                c.fillStyle = ka === 0 ? INK : INK_SOFT;
                c.font = 'bold 18px ' + FONT_HAND;
                c.textAlign = 'center';
                c.textBaseline = 'middle';
                c.fillText(label, lp2.x, lp2.y);
            }
        }

        function ensureStatic(MAX_DIS, RING_STEPS) {
            var key = MAX_DIS + '|' + (self._fontsReady ? 1 : 0);
            if (key === staticKey) return;
            drawStatic(staticLayer.getContext('2d'), MAX_DIS, RING_STEPS);
            staticKey = key;
        }

        /* =========================================================
           主绘制
           ========================================================= */
        function _draw(c) {
            var now = performance.now();
            var MAX_DIS = computeScale();
            var RING_STEPS = [];
            for (var r = SCALE_STEP; r <= MAX_DIS; r += SCALE_STEP) RING_STEPS.push(r);

            ensureStatic(MAX_DIS, RING_STEPS);
            c.setTransform(1, 0, 0, 1, 0, 0);
            c.clearRect(0, 0, canvas.width, canvas.height);   // 背景已透明，每帧需先清空
            c.drawImage(staticLayer, 0, 0);
            c.setTransform(DPR, 0, 0, DPR, 0, 0);
            c.lineCap = 'round';
            c.lineJoin = 'round';

            var o = project(0, 0);
            var beamT = easeInOut(anim.beamT);
            var hitT = easeInOut(anim.hitT);
            var limDeg = (window.CONFIG && CONFIG.DATA) ? CONFIG.DATA.pointingAziLimit / CONFIG.DATA.aziToDeg : 10;
            limDeg = Math.max(0.5, Math.min(MAX_DISPLAY_AZI, limDeg));

            // ===== 定位模式：荧光笔指向判定区（±limit，固定朝 0°）=====
            if (beamT < 0.999) drawZone(c, o, 0, limDeg, 1 - beamT);

            // ===== 设备节点位置 =====
            var labels = CONFIG.DEVICE_LABELS;
            var items = [];
            for (var i = 0; i < 3; i++) {
                var dev = self.devices[i];
                if (!dev) continue;
                if (Math.abs(dev.azi) > MAX_DISPLAY_AZI) continue;   // 超出 ±90° 不显示
                var rr = Math.min(dev.dis, MAX_DIS) / MAX_DIS;
                var arad = dev.azi * Math.PI / 180;
                var X = rr * Math.sin(arad), Z = rr * Math.cos(arad);
                items.push({ i: i, X: X, Z: Z, p: project(X, Z) });
            }
            items.sort(function(a, b) { return b.Z - a.Z; });

            // ===== 连接虚线（定位模式）→ 指向模式下淡出、收缩回魔法棒 =====
            var lineK = 1 - beamT;
            if (lineK > 0.001) {
                for (var li = 0; li < items.length; li++) {
                    var it = items[li];
                    var hl = it.i === self.highlightIdx;
                    var ex = lerp(o.x, it.p.x, lineK), ey = lerp(o.y, it.p.y, lineK);
                    c.globalAlpha = lineK;
                    if (hl) {
                        c.strokeStyle = 'rgba(255, 212, 59, 0.55)';
                        c.lineWidth = 12;
                        sketchLine(c, o.x, o.y, ex, ey, 300 + it.i, { passes: 1, amp: 0.8 });
                    }
                    c.strokeStyle = alpha(CONFIG.DEVICE_COLORS[it.i], hl ? 0.95 : 0.7);
                    c.lineWidth = hl ? 2.4 : 1.8;
                    c.setLineDash([7, 5]);
                    sketchLine(c, o.x, o.y, ex, ey, 200 + it.i, { passes: 1, amp: 0.6 });
                    c.setLineDash([]);
                    c.globalAlpha = 1;
                }
            }
            // 地面落点小十字
            for (var xi = 0; xi < items.length; xi++) {
                c.strokeStyle = INK;
                c.lineWidth = 1.4;
                sketchLine(c, items[xi].p.x - 5, items[xi].p.y, items[xi].p.x + 5, items[xi].p.y, 220 + items[xi].i, { passes: 1, amp: 0.3 });
            }

            // ===== 指向模式：魔法光束 =====
            var heading = lerp(0, anim.heading, beamT);
            var wandAng = heading;
            var hitItem = null;
            if (anim.lastHit >= 0) {
                for (var hi2 = 0; hi2 < items.length; hi2++) if (items[hi2].i === anim.lastHit) hitItem = items[hi2];
            }
            if (hitItem && hitT > 0) {
                // 命中时光束"锁定"到目标位置
                var tgtAng = Math.atan2(hitItem.p.x - o.x, o.y - hitItem.p.y) * 180 / Math.PI;
                wandAng = lerp(heading, tgtAng, hitT);
            }
            var tip = wandTip(o, wandAng);
            if (beamT > 0.001) {
                drawSearchBeam(c, tip, wandAng, limDeg, beamT * (1 - hitT), now);
                if (hitItem && hitT > 0.001) drawHitBeam(c, tip, hitItem, CONFIG.DEVICE_COLORS[hitItem.i], beamT * hitT, now);
            }

            // ===== 原点：魔法棒 =====
            drawWand(c, o, wandAng, beamT, hitT, now);

            // ===== 礼物盒（远处先画）+ 标签 =====
            var tags = [];
            for (var bi = 0; bi < items.length; bi++) {
                var b = items[bi];
                var anchor = drawGiftBox(c, b.i, b.p.x, b.p.y, 0.92, CONFIG.DEVICE_COLORS[b.i], anim.open[b.i], now);
                tags.push({ i: b.i, x: anchor.tagX, y: anchor.tagY });
            }
            for (var tg = 0; tg < tags.length; tg++) {
                var t = tags[tg];
                drawTag(c, labels[t.i], t.x, Math.max(16, t.y), 700 + t.i, {
                    fill: t.i === self.highlightIdx ? HILITE : RIBBON,
                    font: 'bold 16px ' + FONT_LABEL,
                });
            }
        }

        /* =========================================================
           指向判定区（荧光笔斜线排线的扇形）
           ========================================================= */
        function drawZone(c, o, centerDeg, halfDeg, a) {
            if (a <= 0.001) return;
            c.save();
            c.globalAlpha = a;
            c.beginPath();
            c.moveTo(o.x, o.y);
            for (var la = centerDeg - halfDeg; la <= centerDeg + halfDeg + 0.001; la += Math.max(0.5, halfDeg / 10)) {
                var lp = projPolar(1, la);
                c.lineTo(lp.x, lp.y);
            }
            c.closePath();
            c.fillStyle = 'rgba(255, 224, 102, 0.30)';
            c.fill();
            c.clip();
            c.strokeStyle = 'rgba(232, 180, 20, 0.45)';
            c.lineWidth = 3;
            for (var k = -RADIUS; k < RADIUS * 2; k += 9) {
                c.beginPath(); c.moveTo(o.x - RADIUS + k, o.y); c.lineTo(o.x + k, o.y - RADIUS); c.stroke();
            }
            c.restore();
        }

        /* =========================================================
           魔法棒
           ========================================================= */
        var WAND_LEN = 54;
        function dirOf(deg) { var a = deg * Math.PI / 180; return { x: Math.sin(a), y: -Math.cos(a) }; }
        function wandTip(o, deg) { var d = dirOf(deg); return { x: o.x + d.x * WAND_LEN, y: o.y - 4 + d.y * WAND_LEN }; }

        function drawWand(c, o, deg, beamT, hitT, now) {
            var d = dirOf(deg);
            var bx = o.x, by = o.y - 4;
            var tip = wandTip(o, deg);

            // 纸板底座（圆形小台子）
            c.beginPath();
            c.ellipse(o.x + 4, o.y + 5, 22, 9, 0, 0, Math.PI * 2);
            c.fillStyle = 'rgba(60, 38, 20, 0.25)';
            c.fill();
            c.beginPath();
            c.ellipse(o.x, o.y + 1, 19, 8, 0, 0, Math.PI * 2);
            c.fillStyle = BOARD;
            c.fill();
            c.strokeStyle = INK;
            c.lineWidth = 2;
            c.stroke();

            // 棒身：马克笔描边 + 紫色棒身 + 白色握柄环
            c.lineCap = 'round';
            c.strokeStyle = INK;
            c.lineWidth = 11;
            c.beginPath(); c.moveTo(bx, by); c.lineTo(tip.x - d.x * 6, tip.y - d.y * 6); c.stroke();
            c.strokeStyle = '#6b4fa0';
            c.lineWidth = 6;
            c.beginPath(); c.moveTo(bx, by); c.lineTo(tip.x - d.x * 6, tip.y - d.y * 6); c.stroke();
            // 排线高光
            c.strokeStyle = 'rgba(255,255,255,0.35)';
            c.lineWidth = 2;
            c.beginPath(); c.moveTo(bx - d.y * 1.5, by + d.x * 1.5); c.lineTo(tip.x - d.x * 10 - d.y * 1.5, tip.y - d.y * 10 + d.x * 1.5); c.stroke();
            // 握柄环
            c.strokeStyle = '#fff4c9';
            c.lineWidth = 6;
            c.beginPath(); c.moveTo(bx + d.x * 10, by + d.y * 10); c.lineTo(bx + d.x * 16, by + d.y * 16); c.stroke();
            // 关节双脚钉
            c.beginPath();
            c.arc(bx, by, 5, 0, Math.PI * 2);
            c.fillStyle = '#d4a845';
            c.fill();
            c.lineWidth = 2;
            c.strokeStyle = INK;
            c.stroke();

            // 顶端星星（指向模式更亮，命中时放大闪烁）
            var glow = 0.25 + 0.75 * beamT;
            var pulse = 1 + 0.08 * Math.sin(now / 180) * beamT + 0.25 * hitT;
            var g = c.createRadialGradient(tip.x, tip.y, 0, tip.x, tip.y, 30 * pulse);
            g.addColorStop(0, 'rgba(255, 240, 160,' + (0.85 * glow) + ')');
            g.addColorStop(1, 'rgba(255, 240, 160, 0)');
            c.fillStyle = g;
            c.beginPath(); c.arc(tip.x, tip.y, 30 * pulse, 0, Math.PI * 2); c.fill();
            drawStar5(c, tip.x, tip.y, 11 * pulse, '#ffd43b', deg * Math.PI / 180 + now / 1500 * beamT);
        }

        function drawStar5(c, x, y, r, color, rot) {
            c.save();
            c.translate(x, y);
            c.rotate(rot || 0);
            c.beginPath();
            for (var i = 0; i < 10; i++) {
                var ang = -Math.PI / 2 + i * Math.PI / 5;
                var rr = i % 2 === 0 ? r : r * 0.45;
                c.lineTo(Math.cos(ang) * rr, Math.sin(ang) * rr);
            }
            c.closePath();
            c.fillStyle = color;
            c.fill();
            c.strokeStyle = INK;
            c.lineWidth = 2;
            c.lineJoin = 'round';
            c.stroke();
            c.restore();
        }

        /* =========================================================
           搜索光束：淡紫色魔法光锥（宽度 = 指向判定范围 ±limit），星尘向外飘
           ========================================================= */
        function drawSearchBeam(c, tip, deg, halfDeg, a, now) {
            if (a <= 0.001) return;
            var len = RADIUS - WAND_LEN + 4;
            var a0 = (deg - halfDeg) * Math.PI / 180, a1 = (deg + halfDeg) * Math.PI / 180;
            c.save();
            c.globalAlpha = a;

            // 光锥
            c.beginPath();
            c.moveTo(tip.x, tip.y);
            for (var k = 0; k <= 12; k++) {
                var ang = a0 + (a1 - a0) * k / 12;
                c.lineTo(tip.x + Math.sin(ang) * len, tip.y - Math.cos(ang) * len);
            }
            c.closePath();
            var g = c.createRadialGradient(tip.x, tip.y, 4, tip.x, tip.y, len);
            g.addColorStop(0, 'rgba(214, 196, 255, 0.75)');
            g.addColorStop(0.55, 'rgba(190, 165, 245, 0.32)');
            g.addColorStop(1, 'rgba(190, 165, 245, 0)');
            c.fillStyle = g;
            c.fill();

            // 光锥内的马克笔排线（与人偶的排线上色呼应）
            c.clip();
            c.strokeStyle = 'rgba(140, 110, 220, 0.18)';
            c.lineWidth = 2.5;
            var shift = (now / 60) % 10;
            for (var hx = -len; hx < len; hx += 10) {
                c.beginPath();
                c.moveTo(tip.x + hx + shift - len, tip.y + len);
                c.lineTo(tip.x + hx + shift + len, tip.y - len);
                c.stroke();
            }
            c.restore();

            // 光束中轴（流动的虚线）
            var d = dirOf(deg);
            c.save();
            c.globalAlpha = a * 0.9;
            c.strokeStyle = 'rgba(255, 255, 255, 0.85)';
            c.lineWidth = 3;
            c.setLineDash([10, 12]);
            c.lineDashOffset = -now / 25;
            c.beginPath();
            c.moveTo(tip.x, tip.y);
            c.lineTo(tip.x + d.x * len * 0.92, tip.y + d.y * len * 0.92);
            c.stroke();
            c.setLineDash([]);

            // 星尘：沿光束向外飘散，越远越淡
            for (var p = 0; p < 12; p++) {
                var life = 2.2;
                var tt = ((now / 1000 + p * life / 12) % life) / life;
                var lat = (hash(p * 4.7) - 0.5) * 2 * Math.sin(halfDeg * Math.PI / 180) * tt;
                var dist = 14 + tt * (len - 14);
                var px = tip.x + d.x * dist + (-d.y) * lat * dist;
                var py = tip.y + d.y * dist + (d.x) * lat * dist;
                c.globalAlpha = a * (1 - tt) * 0.95;
                drawSparkle(c, px, py, 3 + 3 * (1 - tt), p % 3 ? '#ffffff' : '#e5dbff', tt * 4 + p);
            }
            c.restore();
        }

        /* =========================================================
           命中光束：金色聚焦光柱直达目标，螺旋星光 + 目标处光环
           ========================================================= */
        function drawHitBeam(c, tip, item, color, a, now) {
            var tx = item.p.x, ty = item.p.y - 14;      // 指向礼物盒中部
            var dx = tx - tip.x, dy = ty - tip.y;
            var len = Math.max(1, Math.sqrt(dx * dx + dy * dy));
            var ux = dx / len, uy = dy / len, nx = -uy, ny = ux;
            var grow = clamp01((now - anim.hitAt) / 260);  // 命中瞬间光束从魔法棒"射出"
            var reach = len * easeInOut(grow);
            var ex = tip.x + ux * reach, ey = tip.y + uy * reach;

            c.save();
            c.globalAlpha = a;

            // 外层光晕（锥形：棒端窄、目标端宽）
            var w0 = 5, w1 = 16 + 2 * Math.sin(now / 120);
            c.beginPath();
            c.moveTo(tip.x + nx * w0, tip.y + ny * w0);
            c.lineTo(ex + nx * w1, ey + ny * w1);
            c.lineTo(ex - nx * w1, ey - ny * w1);
            c.lineTo(tip.x - nx * w0, tip.y - ny * w0);
            c.closePath();
            var lg = c.createLinearGradient(tip.x, tip.y, ex, ey);
            lg.addColorStop(0, 'rgba(255, 230, 120, 0.85)');
            lg.addColorStop(1, alpha(color, 0.55));
            c.fillStyle = lg;
            c.fill();
            c.strokeStyle = 'rgba(232, 164, 0, 0.8)';
            c.lineWidth = 1.5;
            c.stroke();

            // 内芯：白色亮线（两遍手绘）
            c.strokeStyle = '#fffdf2';
            c.lineWidth = 4;
            sketchLine(c, tip.x, tip.y, ex, ey, 900 + item.i, { passes: 1, amp: 0.8 });
            c.strokeStyle = 'rgba(255, 212, 59, 0.9)';
            c.lineWidth = 1.6;
            sketchLine(c, tip.x, tip.y, ex, ey, 950 + item.i, { passes: 1, amp: 1.2 });

            // 螺旋星光：两条正弦丝带沿光束流动
            for (var s = 0; s < 2; s++) {
                for (var q = 0; q < 14; q++) {
                    var f = ((q / 14) + now / 1400) % 1;
                    if (f * len > reach) continue;
                    var wv = Math.sin(f * 14 - now / 140 + s * Math.PI) * (6 + 6 * f);
                    var px = tip.x + ux * f * len + nx * wv, py = tip.y + uy * f * len + ny * wv;
                    c.globalAlpha = a * (0.4 + 0.6 * Math.sin(f * Math.PI));
                    drawSparkle(c, px, py, 2.4 + 1.6 * Math.sin(f * Math.PI), s ? '#ffffff' : '#ffe066', f * 6);
                }
            }

            // 目标处：扩散光环 + 星芒
            if (grow >= 1) {
                c.globalAlpha = a;
                for (var ring = 0; ring < 2; ring++) {
                    var rt = ((now - anim.hitAt) / 900 + ring * 0.5) % 1;
                    c.beginPath();
                    c.ellipse(tx, ty + 10, 12 + rt * 34, (12 + rt * 34) * 0.55, 0, 0, Math.PI * 2);
                    c.strokeStyle = alpha(color, 0.75 * (1 - rt));
                    c.lineWidth = 3 * (1 - rt) + 1;
                    c.stroke();
                }
                for (var st = 0; st < 5; st++) {
                    var ang = now / 700 + st * Math.PI * 2 / 5;
                    var rad = 30 + 5 * Math.sin(now / 200 + st);
                    c.globalAlpha = a * (0.6 + 0.4 * Math.sin(now / 150 + st * 1.3));
                    drawSparkle(c, tx + Math.cos(ang) * rad, ty + Math.sin(ang) * rad * 0.6, 5, st % 2 ? '#ffffff' : '#ffd43b', ang);
                }
            }
            c.restore();
        }

        // 手绘字体加载完成后重绘一次（静态层也要用新字体重画）
        if (document.fonts && document.fonts.ready) {
            document.fonts.ready.then(function() { self._fontsReady = true; _draw(ctx); });
        }

        self.render();
        return self;
    }

    return { create: create };
})();
