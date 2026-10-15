/* ============================================
   配置
   ============================================ */

var CONFIG = {
    // 房间配置：固定单房间模式，连接同一台局域网服务器的设备都在这个房间
    ROOM_CODE: 'SLP01',  // 固定房间号，所有设备自动加入此房间

    // 投屏配置
    CAST: {
        // 画质预设：maxWidth 画面最大宽度（像素），quality JPEG 质量 0~1，fps 每秒帧数
        presets: {
            smooth: { maxWidth: 960,  quality: 0.6,  fps: 20 },
            clear:  { maxWidth: 1280, quality: 0.7,  fps: 15 },
            hd:     { maxWidth: 1920, quality: 0.8,  fps: 8 },
        },
        // P 端发送缓冲超过此值就丢帧（Wi-Fi 慢时防止延迟累积）
        maxBufferedBytes: 1500000,
    },

    // 串口配置（与 point_demo_test1.py 对齐）
    SERIAL: {
        baudRate: 115200,
    },

    // 设备标签（与 point_demo.py DEVICE_LABELS 一致）
    DEVICE_LABELS: ['设备1', '设备2', '设备3'],

    // 数据处理参数（与 point_demo_test1.py 完全一致）
    DATA: {
        smoothingWindow: 5,             // SMOOTHING_WINDOW
        aziToDeg: 100.0,               // AZI_TO_DEG
        maxDisplayAzi: 90,             // MAX_DISPLAY_AZI
        aziOutlierThreshold: 8000,     // AZI_OUTLIER_THRESHOLD
        disOutlierThreshold: 2000,     // DIS_OUTLIER_THRESHOLD
        pointingAziLimit: 1600,        // POINTING_AZI_LIMIT
        pointingStableRange: 1000,     // POINTING_STABLE_RANGE
        smoothAlpha: 0.3,              // SMOOTH_ALPHA
        // 测距固定偏移（mm）：串口读到的 dis 会先减去该值再参与计算。
        // 默认 300mm = 30cm；填负数表示实际距离比读数更远（加上偏移）。可在「设置」中修改。
        distanceOffset: -300,         // DISTANCE_OFFSET_MM
        updateIntervalMs: 1000,        // UPDATE_INTERVAL_MS (每秒处理)
    },

    // 设备定义
    DEVICES: {
        P:  { label: 'P (主控)', icon: '🎯' },
        T1: { label: 'T1',     icon: '🔴' },
        T2: { label: 'T2',     icon: '🔴' },
        T3: { label: 'T3',     icon: '🔴' },
    },

    // 目标设备地址映射 (addr 01→T1索引0, 02→T2索引1, 03→T3索引2)
    DEVICE_ADDRS: ['01', '02', '03'],
    DEVICE_COLORS: ['#e74c3c', '#3498db', '#2ecc71'], // 红色、蓝色、绿色
};

// 生成唯一设备ID
function generateDeviceId() {
    return 'SLP_' + Math.random().toString(36).substr(2, 8) + Date.now().toString(36);
}
