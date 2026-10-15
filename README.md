# SLP Cast Demo — 指向投屏 / Point-to-cast

Everything from the LAN point demo (serial pointing, polar plot, settings, T characters), plus: **P shares its screen, and whichever T it points at shows that content full-screen.** Runs entirely on your Wi-Fi — no GitHub, no internet.

保留原有全部功能（串口指向、极坐标图、设置、T 端纸片人），新增：P 共享屏幕后，指向哪台 T，画面就投到哪台 T 上。全程局域网，不需要外网。

## Run / 运行

1. P laptop: install Python 3.8+ (Windows: tick "Add Python to PATH"). No `pip install` needed.
2. In this folder: `python server.py` (macOS/Linux: `python3 server.py`).
3. **P laptop**: open Chrome/Edge at `http://localhost:8000` → choose **P** → connect serial as before.
   Must be `localhost`: browsers only allow serial and screen sharing on secure addresses.
4. **Phones**: open the `http://192.168.x.x:8000` address printed in the terminal → choose T1/T2/T3.
5. On P, click **🖥️ 选择投屏内容** and pick a whole screen or a window (e.g. PowerPoint).
6. Point at a T — the content appears on that phone. Tap the phone screen to go full-screen.

## Cast options / 投屏选项（P 页面）

- **模式 · 锁定 (default)**: casting stays on the last T until you point at another one, or press **结束本次投屏**.
- **模式 · 跟随**: casting ends as soon as you point away.
- **画质**: 流畅 960px/20fps · 清晰 1280px/15fps · 高清 1920px/8fps. Edit `CONFIG.CAST` in `js/config.js` to tune.

## Notes / 说明

- Picture only, no audio. Latency is typically 100–300 ms on home Wi-Fi.
- Share a window or the entire screen, not the P tab itself — otherwise phones just see the radar page.
- You can switch to other apps while casting; capture keeps running in the background.
- Phone can't connect → allow Python through the firewall (**Private networks**), and avoid guest Wi-Fi with client isolation.
- Port busy → `python server.py 9000`.
