/**
 * cutout_character.js — T 设备"被指向"时的手绘纸板人偶动画（纯展示层）
 *
 * 设计原则：
 *   - 不修改、不调用 main.js 里的任何指向判定逻辑。
 *   - 只"观察" #t-status-display 的 class：
 *       main.js 在被指向时设为 't-status-display green'，
 *       停止指向时设为 't-status-display red'。
 *     本模块用 MutationObserver 监听这个变化 → 出场 / 退场。
 *   - 只"读取" window.state.deviceType（T1/T2/T3）来决定显示哪个角色，从不写入。
 *   - 删掉本文件，原有功能完全不受影响。
 *
 * 角色（每台设备一个，主色与 P 端图例颜色对应）：
 *   T1 / 设备1 → 小狐狸（红色围巾）
 *   T2 / 设备2 → 小企鹅（蓝色毛线帽）
 *   T3 / 设备3 → 小青蛙（绿色）
 *
 * ── 性能设计（v3）────────────────────────────────────────────
 *   纸板颗粒 / 撕边 / 铅笔抖动都依赖 SVG 滤镜（feTurbulence 等），
 *   在手机分辨率下渲染一次要几百毫秒到一秒以上。旧版直接把带滤镜的 SVG
 *   放进页面，导致：
 *     ① 第一次出现时要先光栅化滤镜 → 出场延迟约 1 秒；
 *     ② SVG 内部的挥手 / 波纹 / 闪光动画每一帧都让整张 SVG 重绘滤镜 → 掉帧。
 *   新做法：
 *     1. 预渲染：T 设备进入等待界面后，在浏览器空闲时把人偶的"身体"和"挥动的手臂"
 *        各画成一张位图（canvas），投影也一并烘焙进去。被指向时直接用现成位图。
 *     2. 动画只改 transform / opacity：升起、浮动、挥手、眨眼、信号波纹、闪光
 *        全部是独立图层上的 transform/opacity 动画，由 GPU 合成线程完成，
 *        每帧不再触发任何重绘或滤镜计算。
 *     3. 撕边轮廓的"膨胀"改用矢量描边实现（原 feMorphology 占渲染耗时约 90%），
 *        身体与纸板厚度共用同一次撕边计算。
 *     4. 舞台常驻 DOM（visibility 切换而非 display 切换），出场时无需重新布局。
 *
 * 动画流程：
 *   出场：从屏幕底边升起 → 弹性过冲 → 停在屏幕中央 → 持续轻微上下浮动（bob）
 *   退场：沉回屏幕底部 → 隐藏
 *   出场途中被打断（或退场途中又被指向）时，从当前位置平滑接续，不会跳帧。
 */
(function () {
    'use strict';

    // ============================================================
    // 一、画风公共部分（纸板材质 / 撕边 / 马克笔排线）
    // ============================================================
    var INK = '#4a3b30';                         // 棕色马克笔描边
    var VB = { x: -40, y: -20, w: 380, h: 390 }; // 人偶整体坐标系

    var COLORS = {
        red:    '#d9480f',
        orange: '#e8833a',
        pink:   '#e8788a',
        blue:   '#3b6fc4',
        navy:   '#3f4a5c',
        green:  '#5c9e3f',
        yellow: '#e0a526'
    };

    // 斜线排线图案：模拟马克笔一笔一笔涂色
    function hatchPatterns() {
        var s = '', angle = { red: 35, orange: 35, pink: 50, blue: -35, navy: 30, green: 40, yellow: -30 };
        Object.keys(COLORS).forEach(function (k) {
            s += '<pattern id="h-' + k + '" width="7" height="7" patternUnits="userSpaceOnUse" ' +
                     'patternTransform="rotate(' + angle[k] + ')">' +
                     '<rect width="3.6" height="7" fill="' + COLORS[k] + '" opacity=".85"/>' +
                 '</pattern>';
        });
        return s;
    }

    // 上色区域 = 淡淡的底色 + 排线（纸板颗粒仍然透出来）
    function color(d, key, extra) {
        extra = extra || '';
        return '<path d="' + d + '" fill="' + COLORS[key] + '" opacity=".28" ' + extra + '/>' +
               '<path d="' + d + '" fill="url(#h-' + key + ')" ' + extra + '/>';
    }
    function line(d, w, extra) {
        return '<path d="' + d + '" fill="none" stroke="' + INK + '" stroke-width="' + (w || 4.5) + '" ' + (extra || '') + '/>';
    }
    function sil(d) { return '<path d="' + d + '"/>'; }
    function ellipseD(cx, cy, rx, ry) {
        return 'M' + (cx - rx) + ' ' + cy + ' a' + rx + ' ' + ry + ' 0 1 0 ' + (2 * rx) + ' 0 a' + rx + ' ' + ry + ' 0 1 0 ' + (-2 * rx) + ' 0 Z';
    }
    function blush(lx, rx, y) {
        return color(ellipseD(lx, y, 14, 8), 'pink') + color(ellipseD(rx, y, 14, 8), 'pink');
    }
    // 手臂关节处的"双脚钉"（纸板人偶常用的活动关节）
    function splitPin(x, y) {
        return '<circle cx="' + x + '" cy="' + y + '" r="6" fill="#d4a845" stroke="' + INK + '" stroke-width="2.5"/>' +
               '<path d="M' + (x - 2) + ' ' + (y - 2) + ' l3 3" stroke="#fff6d6" stroke-width="1.6"/>';
    }

    /**
     * 生成一个"纸板剪纸图层"的完整 SVG 文档（只用于离屏渲染成位图）
     * box: 该图层在人偶坐标系中的区域 {x,y,w,h}
     */
    function layerSvg(box, silhouette, art, pxW, pxH) {
        var R = 'x="' + box.x + '" y="' + box.y + '" width="' + box.w + '" height="' + box.h + '"';
        return '<svg xmlns="http://www.w3.org/2000/svg" width="' + pxW + '" height="' + pxH + '" ' +
                    'viewBox="' + box.x + ' ' + box.y + ' ' + box.w + ' ' + box.h + '">' +
            '<defs>' +
                // 撕/剪纸边：矢量描边膨胀后的剪影 → 低频噪声扭曲（撕口）→ 高频噪声扭曲（毛刺）
                '<filter id="torn" ' + R + ' filterUnits="userSpaceOnUse">' +
                    '<feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="2" seed="7" result="n1"/>' +
                    '<feDisplacementMap in="SourceAlpha" in2="n1" scale="12" xChannelSelector="R" yChannelSelector="G" result="t1"/>' +
                    '<feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="1" seed="27" result="n2"/>' +
                    '<feDisplacementMap in="t1" in2="n2" scale="3" xChannelSelector="R" yChannelSelector="G" result="t2"/>' +
                    '<feFlood flood-color="#fff"/>' +
                    '<feComposite in2="t2" operator="in"/>' +
                '</filter>' +
                // 牛皮纸板材质：底色 + 低频深浅斑 + 深色颗粒 + 浅色颗粒
                '<filter id="kraft" ' + R + ' filterUnits="userSpaceOnUse">' +
                    '<feFlood flood-color="#c9a676" result="base"/>' +
                    '<feTurbulence type="fractalNoise" baseFrequency="0.012" numOctaves="2" seed="5" result="blot"/>' +
                    '<feColorMatrix in="blot" type="matrix" values="0 0 0 0 .62  0 0 0 0 .45  0 0 0 0 .27  1.3 0 0 0 -.55" result="blotC"/>' +
                    '<feComposite in="blotC" in2="base" operator="over" result="b1"/>' +
                    '<feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="1" seed="9" result="sp1"/>' +
                    '<feColorMatrix in="sp1" type="matrix" values="0 0 0 0 .40  0 0 0 0 .28  0 0 0 0 .16  7 0 0 0 -4.3" result="sp1C"/>' +
                    '<feComposite in="sp1C" in2="b1" operator="over" result="b2"/>' +
                    '<feTurbulence type="fractalNoise" baseFrequency="0.7" numOctaves="1" seed="23" result="sp2"/>' +
                    '<feColorMatrix in="sp2" type="matrix" values="0 0 0 0 .93  0 0 0 0 .84  0 0 0 0 .66  7 0 0 0 -4.4" result="sp2C"/>' +
                    '<feComposite in="sp2C" in2="b2" operator="over"/>' +
                '</filter>' +
                // 铅笔抖动
                '<filter id="pencil" ' + R + ' filterUnits="userSpaceOnUse">' +
                    '<feTurbulence type="fractalNoise" baseFrequency="0.03" numOctaves="1" seed="11" result="n"/>' +
                    '<feDisplacementMap in="SourceGraphic" in2="n" scale="3" xChannelSelector="R" yChannelSelector="G"/>' +
                '</filter>' +
                hatchPatterns() +
                // 剪影 + 26 宽的圆角描边 = 向外膨胀 13 个单位（代替昂贵的 feMorphology）
                '<mask id="cut" maskUnits="userSpaceOnUse" ' + R + '>' +
                    '<g filter="url(#torn)" fill="#000" stroke="#000" stroke-width="26" stroke-linejoin="round">' + silhouette + '</g>' +
                '</mask>' +
            '</defs>' +
            // 纸板厚度：同一张撕边形状，深棕色，向右下错开（共用 mask，不再重复计算撕边）
            '<g transform="translate(4 6)"><rect ' + R + ' fill="#8b6844" mask="url(#cut)"/></g>' +
            // 纸板正面：牛皮纸颗粒
            '<g mask="url(#cut)"><rect ' + R + ' filter="url(#kraft)"/></g>' +
            // 角色线稿 + 排线上色（铅笔抖动）
            '<g filter="url(#pencil)" stroke-linecap="round" stroke-linejoin="round">' + art + '</g>' +
        '</svg>';
    }

    // ============================================================
    // 二、三个角色（原创设计，纸板人偶风格）
    //   body : 身体图层（不含挥动的手臂、不含眼睛）
    //   arm  : 挥动的手臂（独立纸板片，绕关节旋转）
    //   eyes : [左眼x, 右眼x, y, 半径]（独立小图层，用于眨眼）
    //   signal / sparks : 信号波纹与闪光的位置
    // ============================================================
    var CHARACTERS = {};

    // ---------- T1：小狐狸（红色系，对应 设备1 红色）----------
    (function () {
        var head  = 'M150 92 C 200 92, 236 120, 240 160 L 264 184 C 242 194, 222 214, 190 222 C 172 230, 128 230, 110 222 C 78 214, 58 194, 36 184 L 60 160 C 64 120, 100 92, 150 92 Z';
        var mask  = 'M150 92 C 200 92, 236 120, 240 160 C 212 150, 180 160, 150 190 C 120 160, 88 150, 60 160 C 64 120, 100 92, 150 92 Z';
        var earL  = 'M80 120 L 70 32 L 130 96 Z', earR = 'M220 120 L 230 32 L 170 96 Z';
        var earLi = 'M86 108 L 80 54 L 116 94 Z', earRi = 'M214 108 L 220 54 L 184 94 Z';
        var body  = 'M116 220 C 104 260, 104 300, 118 316 L 182 316 C 196 300, 196 260, 184 220 Z';
        var tail  = 'M184 300 C 236 312, 274 282, 270 236 C 268 208, 248 196, 236 212 C 248 246, 228 276, 188 280 Z';
        var tailTip = 'M270 236 C 268 208, 248 196, 236 212 C 241 224, 245 234, 270 236 Z';
        var scarf = 'M104 222 C 130 238, 170 238, 196 222 L 198 242 C 170 256, 130 256, 102 242 Z';
        var scarfEnd = 'M168 244 L 192 290 L 172 296 L 154 250 Z';
        var armL  = 'M120 250 C 98 240, 82 222, 74 202 C 70 190, 86 184, 92 196 C 100 214, 112 228, 126 236 Z';
        var armR  = 'M182 250 C 200 262, 210 278, 212 292 C 213 304, 198 306, 197 294 C 195 282, 188 270, 178 262 Z';
        var feet  = ellipseD(132, 318, 18, 10) + ellipseD(168, 318, 18, 10);

        CHARACTERS.T1 = {
            body: {
                sil: sil(tail) + sil(earL) + sil(earR) + sil(head) + sil(body) + sil(armR) + sil(feet),
                art:
                    color(tail, 'orange') + '<path d="' + tailTip + '" fill="#efe2c8" opacity=".8"/>' + line(tail) + line('M236 212 C 241 224, 245 234, 270 236', 3) +
                    color(feet, 'red') + line(feet) +
                    line(body) +
                    color(earL, 'orange') + color(earR, 'orange') + color(earLi, 'pink') + color(earRi, 'pink') +
                    line(earL) + line(earR) + line(earLi, 3) + line(earRi, 3) +
                    color(mask, 'orange') + line(head) + line(head, 1.6, 'opacity=".4" transform="translate(2 -2)"') +
                    line('M60 160 C 88 150, 120 160, 150 190 C 180 160, 212 150, 240 160', 3) +
                    '<path d="M141 192 Q 150 186, 159 192 Q 156 202, 150 203 Q 144 202, 141 192 Z" fill="' + INK + '"/>' +
                    line('M138 208 Q 144 216, 150 208 Q 156 216, 162 208', 3.5) +
                    blush(104, 196, 196) +
                    color(scarf, 'red') + color(scarfEnd, 'red') + line(scarfEnd) + line(scarf) +
                    line('M118 240 L 124 248 M140 244 L 144 252 M160 244 L 156 252', 2.5) +
                    line(armR)
            },
            arm: {
                box: { x: 40, y: 150, w: 120, h: 135 },
                origin: [122, 244],
                sil: sil(armL),
                art: line(armL) + splitPin(118, 240)
            },
            eyes: [122, 178, 170, 8],
            signal: [244, 52],
            sparks: [150, 40]
        };
    })();

    // ---------- T2：小企鹅（蓝色系，对应 设备2 蓝色）----------
    (function () {
        var body  = 'M150 66 C 214 66, 246 144, 244 222 C 242 292, 206 326, 150 326 C 94 326, 58 292, 56 222 C 54 144, 86 66, 150 66 Z';
        var belly = 'M150 122 C 194 122, 212 172, 210 230 C 208 288, 184 312, 150 312 C 116 312, 92 288, 90 230 C 88 172, 106 122, 150 122 Z';
        var hat   = 'M86 112 C 92 50, 208 50, 214 112 C 184 98, 116 98, 86 112 Z';
        var pom   = ellipseD(150, 40, 17, 16);
        var brim  = 'M84 112 C 116 96, 184 96, 216 112 L 214 128 C 184 114, 116 114, 86 128 Z';
        var beak  = 'M136 170 Q 150 164, 164 170 Q 158 186, 150 188 Q 142 186, 136 170 Z';
        var finL  = 'M68 192 C 42 178, 24 152, 22 128 C 22 116, 36 114, 40 126 C 48 150, 62 168, 78 176 Z';
        var finR  = 'M234 204 C 252 224, 262 248, 262 266 C 262 278, 248 278, 246 268 C 242 250, 234 232, 224 218 Z';
        var feet  = ellipseD(124, 326, 22, 10) + ellipseD(176, 326, 22, 10);

        CHARACTERS.T2 = {
            body: {
                sil: sil(pom) + sil(hat) + sil(body) + sil(finR) + sil(feet),
                art:
                    color(feet, 'yellow') + line(feet) +
                    color(body + ' ' + belly, 'navy', 'fill-rule="evenodd"') +
                    line(body) + line(body, 1.6, 'opacity=".4" transform="translate(2 -2)"') + line(belly, 3.5) +
                    color(hat, 'blue') + color(brim, 'blue') + line(hat) + line(brim) +
                    line('M106 108 L 104 122 M126 104 L 125 119 M150 102 L 150 117 M174 104 L 175 119 M194 108 L 196 122', 2.5) +
                    color(pom, 'blue') + line(pom) +
                    color(beak, 'yellow') + line(beak, 3.5) +
                    blush(110, 190, 176) +
                    color(finR, 'navy') + line(finR)
            },
            arm: {
                box: { x: -10, y: 88, w: 120, h: 135 },
                origin: [70, 184],
                sil: sil(finL),
                art: color(finL, 'navy') + line(finL) + splitPin(66, 182)
            },
            eyes: [126, 174, 148, 8],
            signal: [222, 44],
            sparks: [150, 26]
        };
    })();

    // ---------- T3：小青蛙（绿色系，对应 设备3 绿色）----------
    (function () {
        var head  = 'M150 112 C 210 112, 256 142, 256 184 C 256 224, 210 242, 150 242 C 90 242, 44 224, 44 184 C 44 142, 90 112, 150 112 Z';
        var bumpL = ellipseD(100, 112, 34, 32), bumpR = ellipseD(200, 112, 34, 32);
        var eyeWL = ellipseD(100, 112, 21, 20), eyeWR = ellipseD(200, 112, 21, 20);
        var body  = 'M104 232 C 92 272, 98 312, 118 324 L 182 324 C 202 312, 208 272, 196 232 Z';
        var belly = ellipseD(150, 284, 32, 28);
        var armL  = 'M110 252 C 88 240, 72 222, 64 200 C 60 188, 74 182, 80 192 C 88 210, 102 226, 118 236 Z';
        var armR  = 'M192 252 C 212 264, 222 282, 222 298 C 222 310, 206 310, 206 298 C 205 284, 198 272, 186 264 Z';
        var feet  = ellipseD(118, 324, 26, 10) + ellipseD(182, 324, 26, 10);
        var leaf  = 'M150 80 C 150 62, 162 48, 184 46 C 182 66, 168 78, 150 80 Z';

        CHARACTERS.T3 = {
            body: {
                sil: sil(body) + sil(head) + sil(bumpL) + sil(bumpR) + sil(armR) + sil(feet) + sil(leaf) +
                     sil('M146 82 L 154 82 L 154 116 L 146 116 Z'),
                art:
                    color(feet, 'green') + line(feet) +
                    color(body + ' ' + belly, 'green', 'fill-rule="evenodd"') + line(body) + line(belly, 3) +
                    color(head, 'green') + line(head) + line(head, 1.6, 'opacity=".4" transform="translate(2 -2)"') +
                    line('M150 112 C 150 98, 150 88, 152 80', 4) +
                    color(leaf, 'green') + line(leaf, 3.5) +
                    color(bumpL + ' ' + eyeWL, 'green', 'fill-rule="evenodd"') +
                    color(bumpR + ' ' + eyeWR, 'green', 'fill-rule="evenodd"') +
                    line(bumpL) + line(bumpR) + line(eyeWL, 2.5) + line(eyeWR, 2.5) +
                    line('M96 186 Q 150 232, 204 186', 5) +
                    '<path d="M140 206 Q 150 222, 162 206 Q 151 212, 140 206 Z" fill="#e8788a" stroke="' + INK + '" stroke-width="2.5"/>' +
                    blush(74, 226, 196) +
                    line('M132 152 L 134 156 M168 152 L 166 156', 3) +
                    color(armR, 'green') + line(armR)
            },
            arm: {
                box: { x: 30, y: 150, w: 120, h: 135 },
                origin: [114, 244],
                sil: sil(armL),
                art: color(armL, 'green') + line(armL) + splitPin(110, 242)
            },
            eyes: [102, 198, 114, 10],
            signal: [234, 70],
            sparks: [150, 60]
        };
    })();

    // ============================================================
    // 三、轻量叠加层（无滤镜的小 SVG，只做 transform / opacity 动画）
    // ============================================================
    // 把人偶坐标系里的矩形换算成相对人偶盒子的百分比定位
    function pct(box) {
        return 'left:' + ((box.x - VB.x) / VB.w * 100) + '%;top:' + ((box.y - VB.y) / VB.h * 100) + '%;' +
               'width:' + (box.w / VB.w * 100) + '%;height:' + (box.h / VB.h * 100) + '%;';
    }
    function overlay(cls, box, content, extraStyle) {
        return '<svg class="rb-ov ' + cls + '" style="' + pct(box) + (extraStyle || '') + '" ' +
                    'viewBox="' + box.x + ' ' + box.y + ' ' + box.w + ' ' + box.h + '" xmlns="http://www.w3.org/2000/svg">' +
                    content + '</svg>';
    }
    function eyesOverlay(e) {
        var lx = e[0], rx = e[1], y = e[2], r = e[3];
        var box = { x: lx - r - 2, y: y - r * 1.25 - 2, w: rx - lx + 2 * r + 4, h: r * 2.5 + 4 };
        var one = function (x) {
            return '<ellipse cx="' + x + '" cy="' + y + '" rx="' + r + '" ry="' + (r * 1.25) + '" fill="' + INK + '"/>' +
                   '<circle cx="' + (x - r * 0.35) + '" cy="' + (y - r * 0.45) + '" r="' + (r * 0.38) + '" fill="#fff8e8"/>';
        };
        return overlay('rb-eyes', box, one(lx) + one(rx));
    }
    function signalOverlay(x, y) {
        var a = '<path d="M' + (x + 12) + ' ' + (y - 14) + ' Q ' + (x + 22) + ' ' + y + ', ' + (x + 12) + ' ' + (y + 14) + '"/>';
        var b = '<path d="M' + (x + 26) + ' ' + (y - 26) + ' Q ' + (x + 42) + ' ' + y + ', ' + (x + 26) + ' ' + (y + 26) + '"/>';
        var g = function (p) { return '<g fill="none" stroke="' + INK + '" stroke-width="4" stroke-linecap="round">' + p + '</g>'; };
        var box = { x: x + 6, y: y - 30, w: 42, h: 60 };
        return overlay('rb-signal rb-signal-1', box, g(a)) + overlay('rb-signal rb-signal-2', box, g(b));
    }
    function sparksOverlay(cx, top) {
        var box = { x: cx - 100, y: top - 26, w: 220, h: 90 };
        return overlay('rb-sparks', box,
            '<g fill="none" stroke="' + INK + '" stroke-width="5" stroke-linecap="round">' +
                '<path d="M' + (cx - 70) + ' ' + (top + 30) + ' L ' + (cx - 90) + ' ' + (top + 8) + '"/>' +
                '<path d="M' + (cx - 38) + ' ' + (top + 6) + ' L ' + (cx - 46) + ' ' + (top - 20) + '"/>' +
                '<path d="M' + (cx + 74) + ' ' + (top + 26) + ' L ' + (cx + 98) + ' ' + (top + 8) + '"/>' +
                '<path d="M' + (cx + 86) + ' ' + (top + 58) + ' L ' + (cx + 114) + ' ' + (top + 54) + '"/>' +
            '</g>', 'transform-origin:50% 100%;');
    }

    // ============================================================
    // 四、离屏预渲染：SVG（带滤镜）→ canvas 位图（含投影）
    // ============================================================
    var cache = {};   // type → Promise<{ body: canvas, arm: canvas }>

    function puppetCssHeight() {
        // 与 CSS 中 .rb-puppet 的高度公式保持一致：min(50vh, 78vw)
        return Math.min(window.innerHeight * 0.5, window.innerWidth * 0.78);
    }

    function rasterize(svg, pxW, pxH, shadowScale) {
        return new Promise(function (resolve, reject) {
            var url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
            var img = new Image();
            img.onload = function () {
                var c = document.createElement('canvas');
                c.width = pxW; c.height = pxH;
                var ctx = c.getContext('2d');
                // 投影直接烘焙进位图，避免 CSS filter 每帧在 GPU 上重算
                ctx.shadowColor = 'rgba(60, 38, 20, 0.45)';
                ctx.shadowBlur = 6 * shadowScale;
                ctx.shadowOffsetX = 8 * shadowScale;
                ctx.shadowOffsetY = 10 * shadowScale;
                ctx.drawImage(img, 0, 0, pxW, pxH);
                URL.revokeObjectURL(url);
                resolve(c);
            };
            img.onerror = function (e) { URL.revokeObjectURL(url); reject(e); };
            img.src = url;
        });
    }

    function prepare(type) {
        if (cache[type]) return cache[type];
        var ch = CHARACTERS[type];
        var cssH = puppetCssHeight();
        var dpr = Math.min(window.devicePixelRatio || 1, 2);   // 上限 2x：再高肉眼无差别，只会更慢
        var unit = cssH * dpr / VB.h;                            // 1 个人偶坐标单位 = 多少位图像素
        var shadow = dpr;                                        // 投影参数（CSS 像素）× dpr

        var bodyW = Math.round(VB.w * unit), bodyH = Math.round(VB.h * unit);
        var a = ch.arm.box, armW = Math.round(a.w * unit), armH = Math.round(a.h * unit);

        var t0 = performance.now();
        cache[type] = rasterize(layerSvg(VB, ch.body.sil, ch.body.art, bodyW, bodyH), bodyW, bodyH, shadow)
            .then(function (body) {
                // 两张位图分两个任务渲染，避免一次长时间占用主线程
                return new Promise(function (r) { setTimeout(r, 0); }).then(function () {
                    return rasterize(layerSvg(a, ch.arm.sil, ch.arm.art, armW, armH), armW, armH, shadow);
                }).then(function (arm) {
                    if (window.console) console.log('[CutoutCharacter] ' + type + ' 预渲染完成 ' + Math.round(performance.now() - t0) + 'ms (' + bodyW + 'x' + bodyH + ')');
                    return { body: body, arm: arm };
                });
            })
            .catch(function (e) { delete cache[type]; throw e; });
        return cache[type];
    }

    function whenIdle(fn) {
        if (window.requestIdleCallback) window.requestIdleCallback(fn, { timeout: 800 });
        else setTimeout(fn, 60);
    }

    // ============================================================
    // 五、舞台 DOM（常驻，visibility 切换）
    // ============================================================
    var stage = null, mover = null, bobber = null;
    var mountedType = null;

    function mount(type, layers) {
        var screen = document.getElementById('screen-t-device');
        if (!screen) return false;
        if (stage && mountedType === type) return true;
        if (stage) stage.remove();

        var ch = CHARACTERS[type];
        var a = ch.arm.box;
        var originX = (ch.arm.origin[0] - a.x) / a.w * 100;
        var originY = (ch.arm.origin[1] - a.y) / a.h * 100;

        stage = document.createElement('div');
        stage.className = 'rb-stage rb-char-' + type;
        stage.setAttribute('aria-hidden', 'true');
        stage.innerHTML =
            '<div class="rb-mover">' +
                '<div class="rb-bobber">' +
                    '<div class="rb-stick"></div>' +
                    '<div class="rb-puppet">' +
                        '<div class="rb-layer rb-body"></div>' +
                        eyesOverlay(ch.eyes) +
                        '<div class="rb-layer rb-arm" style="' + pct(a) + 'transform-origin:' + originX + '% ' + originY + '%;"></div>' +
                        signalOverlay(ch.signal[0], ch.signal[1]) +
                        sparksOverlay(ch.sparks[0], ch.sparks[1]) +
                    '</div>' +
                '</div>' +
            '</div>';
        stage.querySelector('.rb-body').appendChild(layers.body);
        stage.querySelector('.rb-arm').appendChild(layers.arm);
        screen.appendChild(stage);

        mover = stage.querySelector('.rb-mover');
        bobber = stage.querySelector('.rb-bobber');
        mover.style.transform = 'translateY(' + offscreenY() + 'px)';
        mountedType = type;
        return true;
    }

    // ============================================================
    // 六、动画引擎（只动 transform / opacity）
    // ============================================================
    var anim = null;       // 当前正在进行的出场/退场动画
    var mode = 'hidden';   // hidden | waiting | rising | idle | leaving
    var wantShown = false; // 最新的指向状态（异步准备期间以它为准）

    var reduceMotion = window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // 只读：当前设备类型（T1/T2/T3）。读不到时返回 null
    function currentDeviceType() {
        var t = (window.state && window.state.deviceType) ||
                (document.getElementById('t-my-type') || {}).textContent;
        return CHARACTERS[t] ? t : null;
    }

    // 屏幕外起始位置：人偶顶部刚好在屏幕底边以下 → 第一帧起就开始"冒头"
    function offscreenY() {
        var h = puppetCssHeight();
        return Math.round(window.innerHeight / 2 + h / 2 + 8);
    }

    function currentY() {
        var t = getComputedStyle(mover).transform;
        if (!t || t === 'none') return 0;
        try { return new DOMMatrixReadOnly(t).m42; } catch (e) { return 0; }
    }

    function stopAnim() {
        if (anim) { anim.onfinish = null; anim.cancel(); anim = null; }
    }

    function show() {
        wantShown = true;
        if (mode === 'rising' || mode === 'idle' || mode === 'waiting') return; // 幂等

        var type = currentDeviceType() || 'T1';
        if (mode === 'leaving' && mountedType === type) { rise(currentY()); return; }

        // 正常情况下位图早已在空闲时准备好，这里的 then 会在同一轮微任务中执行
        mode = 'waiting';
        prepare(type).then(function (layers) {
            if (!wantShown) { mode = 'hidden'; return; }
            var fromLeaving = stage && mountedType === type && anim;
            var y = fromLeaving ? currentY() : null;
            stopAnim();
            mount(type, layers);
            rise(y === null ? offscreenY() : y);
        }).catch(function (e) {
            mode = 'hidden';
            if (window.console) console.warn('[CutoutCharacter] 预渲染失败', e);
        });
    }

    function rise(fromY) {
        stopAnim();
        mode = 'rising';
        stage.classList.add('is-visible');
        stage.classList.remove('is-arrived');

        if (reduceMotion || !mover.animate) { arrived(); return; }

        bobber.classList.add('is-bobbing'); // 浮动从一开始就叠加，到位时不会"咔"一下切换
        anim = mover.animate([
            { transform: 'translateY(' + fromY + 'px) rotate(-6deg)', easing: 'cubic-bezier(.12,.8,.3,1)' },
            { transform: 'translateY(-30px) rotate(3deg)', offset: 0.6, easing: 'ease-in-out' },
            { transform: 'translateY(8px) rotate(-1.5deg) scale(1.03, .97)', offset: 0.82, easing: 'ease-out' },
            { transform: 'translateY(0) rotate(0deg) scale(1, 1)' }
        ], { duration: 900, fill: 'forwards' });
        anim.onfinish = arrived;
    }

    function arrived() {
        anim = null;
        mode = 'idle';
        mover.style.transform = 'translateY(0)';
        bobber.classList.add('is-bobbing');
        stage.classList.add('is-arrived'); // 触发挥手、信号波纹、闪光
    }

    function hide() {
        wantShown = false;
        if (mode === 'waiting') { mode = 'hidden'; return; }
        if (!stage || mode === 'hidden' || mode === 'leaving') return;

        var fromY = currentY();
        stopAnim();
        mode = 'leaving';
        stage.classList.remove('is-arrived');

        if (reduceMotion || !mover.animate) { gone(); return; }

        anim = mover.animate([
            { transform: 'translateY(' + fromY + 'px) rotate(0deg)', easing: 'ease-out' },
            { transform: 'translateY(' + (fromY - 22) + 'px) rotate(-2deg)', offset: 0.22, easing: 'cubic-bezier(.5,0,.9,.45)' },
            { transform: 'translateY(' + offscreenY() + 'px) rotate(6deg)' }
        ], { duration: 650, fill: 'forwards' });
        anim.onfinish = gone;
    }

    function gone() {
        anim = null;
        mode = 'hidden';
        stage.classList.remove('is-visible', 'is-arrived');
        bobber.classList.remove('is-bobbing');
        mover.style.transform = 'translateY(' + offscreenY() + 'px)';
    }

    // ============================================================
    // 七、只观察，不干预：监听 #t-status-display 的 class
    // ============================================================
    function warmUp() {
        var type = currentDeviceType();
        if (!type || cache[type]) return;
        whenIdle(function () {
            prepare(type).then(function (layers) {
                if (mode === 'hidden') mount(type, layers); // 提前挂到 DOM（隐藏），出场零等待
            }).catch(function () {});
        });
    }

    function watch() {
        var display = document.getElementById('t-status-display');
        if (!display || !window.MutationObserver) return;

        var sync = function () {
            if (display.classList.contains('green')) show();
            else { hide(); warmUp(); } // T 界面初始化 / 每次复位时顺便预热位图
        };
        new MutationObserver(sync).observe(display, { attributes: true, attributeFilter: ['class'] });
        sync();
    }

    // 页面加载后，趁用户还在登记界面操作时，在空闲时间依次预渲染三个角色。
    // 这样即使进入 T 界面的瞬间就被指向，位图也已就绪。
    function preloadAll() {
        var order = ['T1', 'T2', 'T3'];
        var t = currentDeviceType();
        if (t) order = [t].concat(order.filter(function (x) { return x !== t; }));
        (function next(i) {
            if (i >= order.length) return;
            whenIdle(function () {
                prepare(order[i]).then(function () { next(i + 1); }, function () { next(i + 1); });
            });
        })(0);
    }

    function start() { watch(); preloadAll(); }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }

    // 调试用：控制台可手动 CutoutCharacter.show() / hide() / prepare('T2')
    window.CutoutCharacter = { show: show, hide: hide, prepare: prepare };
})();
