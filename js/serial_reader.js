/* ============================================
   Web Serial API 串口读取器
   数据格式: addr:XX dis:NNN azi:NNN
   ============================================ */

var SerialReader = (function() {
    function create() {
        return {
            port: null,
            reader: null,
            running: false,
            buffer: '',
            onData: null,  // callback(addr, dis, azi)
            onError: null, // callback(msg)
        };
    }

    function requestPort(self) {
        return new Promise(function(resolve, reject) {
            if (!navigator.serial) {
                var err = new Error('浏览器不支持 Web Serial API，请使用 Chrome/Edge');
                if (self.onError) self.onError(err.message);
                reject(err);
                return;
            }
            navigator.serial.requestPort({}).then(function(port) {
                self.port = port;
                var baud = CONFIG.SERIAL.baudRate || 115200;
                return port.open({ baudRate: baud });
            }).then(function() {
                resolve(true);
            }).catch(function(e) {
                if (self.onError) self.onError(e.message);
                reject(e);
            });
        });
    }

    function startReading(self) {
        if (!self.port || self.running) return;
        self.running = true;

        var transport = self.port.readable.getReader();
        self.reader = transport;
        var decoder = new TextDecoder();

        function readLoop() {
            if (!self.running) return;

            transport.read().then(function(result) {
                if (result.done) {
                    if (self.reader) {
                        self.reader.releaseLock();
                        self.reader = null;
                    }
                    return;
                }

                if (result.value) {
                    self.buffer += decoder.decode(result.value, { stream: true });
                    var lines = self.buffer.split(/\r?\n/);
                    self.buffer = lines.pop();

                    for (var i = 0; i < lines.length; i++) {
                        parseLine(self, lines[i].trim());
                    }
                }

                if (self.running) {
                    readLoop();
                }
            }).catch(function(e) {
                if (self.reader) {
                    try { self.reader.releaseLock(); } catch(err) {}
                    self.reader = null;
                }
                self.running = false;
                if (self.onError) self.onError('串口读取错误: ' + e.message);
            });
        }

        readLoop();
    }

    function parseLine(self, line) {
        if (!line || !self.onData) return;
        // Format: addr:XX dis:NNN azi:NNN
        // Match Python pattern: r'addr:([0-9a-zA-Z]+).*dis:([-\d]+).*azi:([-\d]+)'
        var m = line.match(/addr:([0-9a-zA-Z]+).*dis:(-?\d+).*azi:(-?\d+)/);
        if (m) {
            // Pad address to 2 chars (e.g. "1" -> "01"), same as Python's zfill(ADDR_WIDTH)
            var addr = m[1].zfill ? m[1].padStart(2, '0') : (m[1].length < 2 ? '0' + m[1] : m[1]);
            var dis = parseInt(m[2], 10);
            var azi = parseInt(m[3], 10);
            self.onData(addr, dis, azi);
        } else {
            // Log unparseable lines for debugging (only non-empty)
            if (line.trim()) {
                console.warn('[SerialReader] 无法解析的行: "' + line + '"');
            }
        }
    }

    function close(self) {
        return new Promise(function(resolve) {
            self.running = false;

            var cleanup = function() {
                if (self.port) {
                    self.port.close().then(function() {
                        self.port = null;
                        resolve(true);
                    }).catch(function() {
                        self.port = null;
                        resolve(false);
                    });
                } else {
                    resolve(true);
                }
            };

            if (self.reader) {
                self.reader.cancel().then(function() {
                    if (self.reader) {
                        try { self.reader.releaseLock(); } catch(e) {}
                        self.reader = null;
                    }
                    cleanup();
                }).catch(function() {
                    if (self.reader) {
                        try { self.reader.releaseLock(); } catch(e) {}
                        self.reader = null;
                    }
                    cleanup();
                });
            } else {
                cleanup();
            }
        });
    }

    return {
        create: create,
        requestPort: requestPort,
        startReading: startReading,
        close: close,
    };
})();
