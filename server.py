#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SLP Cast Demo —— 局域网服务器（只用 Python 标准库，无需 pip 安装任何东西）

作用：
  1. 把本文件夹里的网页发给同一 Wi-Fi 下的手机和电脑
  2. /ws WebSocket 消息中转：
       - 文字消息（指向状态等）→ 转发给其他所有设备
       - 二进制消息（P 的屏幕画面 JPEG）→ 只转发给当前被投屏的那台 T

用法：
  python server.py            # 默认端口 8000
  python server.py 9000       # 指定端口
"""

import base64
import hashlib
import json
import os
import socket
import struct
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
ROOT = os.path.dirname(os.path.abspath(__file__))
WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAX_MESSAGE = 8 * 1024 * 1024   # 单条消息上限 8MB，防止异常数据


class Client(object):
    """一台已连接的设备"""

    def __init__(self, sock, ip):
        self.sock = sock
        self.ip = ip
        self.device_type = None          # 'P' / 'T1' / 'T2' / 'T3'
        self.lock = threading.Lock()     # 同一连接的发送必须串行，否则帧会交错

    def send(self, data, binary=False):
        n = len(data)
        b1 = 0x82 if binary else 0x81
        if n < 126:
            header = struct.pack("!BB", b1, n)
        elif n < 65536:
            header = struct.pack("!BBH", b1, 126, n)
        else:
            header = struct.pack("!BBQ", b1, 127, n)
        with self.lock:
            self.sock.sendall(header + data)

    def send_text(self, text):
        self.send(text.encode("utf-8"))


clients = set()
clients_lock = threading.Lock()

# 房间共享状态（新设备加入时补发）
room = {
    "last_pointing": None,   # 最近一次 point_at / point_stop（文字）
    "cast_target": None,     # 当前投屏目标 'T1'/'T2'/'T3' 或 None
    "cast_msg": None,        # 最近一次 cast_target 消息（文字）
    "last_frame": None,      # 最近一帧画面，切换目标时立即补发，避免静止画面不更新
}
room_lock = threading.Lock()


def snapshot_clients():
    with clients_lock:
        return list(clients)


def drop(client):
    with clients_lock:
        clients.discard(client)
    try:
        client.sock.close()
    except OSError:
        pass


def broadcast_text(text, sender):
    for c in snapshot_clients():
        if c is sender:
            continue
        try:
            c.send_text(text)
        except OSError:
            drop(c)


def send_frame_to(target, frame):
    for c in snapshot_clients():
        if c.device_type == target:
            try:
                c.send(frame, binary=True)
            except OSError:
                drop(c)


# ---------------------------------------------------------------- WebSocket 读取
def recv_exact(sock, n):
    buf = bytearray()
    while len(buf) < n:
        chunk = sock.recv(min(n - len(buf), 262144))
        if not chunk:
            raise ConnectionError("closed")
        buf += chunk
    return bytes(buf)


def unmask(payload, mask):
    # 用大整数异或一次性解掩码，比逐字节循环快几十倍（画面帧很大）
    n = len(payload)
    if n == 0:
        return payload
    key = (mask * (n // 4 + 1))[:n]
    return (int.from_bytes(payload, "big") ^ int.from_bytes(key, "big")).to_bytes(n, "big")


def ws_recv(client):
    """读取一条完整消息，返回 (is_binary, bytes)；连接关闭返回 (None, None)"""
    sock = client.sock
    parts = []
    msg_opcode = None
    total = 0
    while True:
        b1, b2 = recv_exact(sock, 2)
        fin, opcode = b1 & 0x80, b1 & 0x0F
        length = b2 & 0x7F
        if length == 126:
            length = struct.unpack("!H", recv_exact(sock, 2))[0]
        elif length == 127:
            length = struct.unpack("!Q", recv_exact(sock, 8))[0]
        total += length
        if total > MAX_MESSAGE:
            raise ValueError("message too large")
        mask = recv_exact(sock, 4) if b2 & 0x80 else None
        payload = recv_exact(sock, length)
        if mask:
            payload = unmask(payload, mask)

        if opcode == 0x8:                         # close
            return None, None
        if opcode == 0x9:                         # ping → pong
            with client.lock:
                sock.sendall(struct.pack("!BB", 0x8A, len(payload)) + payload)
            continue
        if opcode == 0xA:                         # pong
            continue
        if opcode in (0x1, 0x2):
            msg_opcode = opcode
        parts.append(payload)
        if fin:
            return msg_opcode == 0x2, b"".join(parts)


# ---------------------------------------------------------------- 消息处理
def set_cast_target(target, sender):
    """更新投屏目标，通知所有设备，并把最近一帧补发给新目标"""
    with room_lock:
        room["cast_target"] = target
        msg = json.dumps({"type": "cast_target", "target": target, "sender": "server"})
        room["cast_msg"] = msg
        frame = room["last_frame"]
    broadcast_text(msg, None if sender is None else sender)
    if target and frame:
        send_frame_to(target, frame)
    print("    投屏目标 → %s" % (target or "无"))


def handle_text(client, text):
    try:
        msg = json.loads(text)
    except ValueError:
        return
    mtype = msg.get("type")

    if mtype == "ping":
        client.send_text('{"type":"pong"}')
        return

    if mtype == "presence":
        client.device_type = msg.get("deviceType")
        print("    %s 是 %s" % (client.ip, client.device_type))
        # 新加入的 T 刚好是投屏目标 → 立即补发一帧
        with room_lock:
            target, frame = room["cast_target"], room["last_frame"]
        if target and frame and client.device_type == target:
            client.send(frame, binary=True)

    if mtype in ("point_at", "point_stop"):
        with room_lock:
            room["last_pointing"] = text

    if mtype == "cast_target":
        if client.device_type == "P":
            set_cast_target(msg.get("target"), client)
        return

    broadcast_text(text, client)


def handle_frame(client, data):
    if client.device_type != "P":
        return
    with room_lock:
        room["last_frame"] = data
        target = room["cast_target"]
    if target:
        send_frame_to(target, data)


# ---------------------------------------------------------------- HTTP
class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass

    def do_GET(self):
        if self.path.split("?")[0] == "/ws" and \
                self.headers.get("Upgrade", "").lower() == "websocket":
            self.handle_websocket()
        else:
            super().do_GET()

    def handle_websocket(self):
        key = self.headers.get("Sec-WebSocket-Key", "")
        accept = base64.b64encode(
            hashlib.sha1((key + WS_MAGIC).encode()).digest()).decode()
        self.send_response_only(101, "Switching Protocols")
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        SimpleHTTPRequestHandler.end_headers(self)
        self.wfile.flush()

        sock = self.connection
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        sock.settimeout(60)
        client = Client(sock, self.client_address[0])
        with clients_lock:
            clients.add(client)
        print("[+] 设备连接: %s   在线 %d 台" % (client.ip, len(clients)))

        try:
            with room_lock:
                pending = [room["last_pointing"], room["cast_msg"]]
            for text in pending:
                if text:
                    client.send_text(text)
            while True:
                is_binary, data = ws_recv(client)
                if data is None:
                    break
                if is_binary:
                    handle_frame(client, data)
                else:
                    handle_text(client, data.decode("utf-8", errors="replace"))
        except (OSError, ConnectionError, ValueError):
            pass
        finally:
            drop(client)
            print("[-] 设备断开: %s (%s)   在线 %d 台" %
                  (client.ip, client.device_type or "?", len(clients)))
            # P 掉线 → 结束投屏，T 回到正常界面
            if client.device_type == "P":
                with room_lock:
                    casting = room["cast_target"] is not None
                    room["last_frame"] = None
                if casting:
                    set_cast_target(None, None)
            self.close_connection = True


# ---------------------------------------------------------------- 启动
def lan_ips():
    ips = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    return sorted(ip for ip in ips if not ip.startswith("127."))


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    print("=" * 56)
    print(" SLP Cast Demo 局域网投屏服务器已启动")
    print("=" * 56)
    print(" 本机（P 主控，必须用这个地址才能用串口和屏幕共享）:")
    print("     http://localhost:%d" % PORT)
    print(" 手机 / 其他设备（T1 T2 T3，连同一个 Wi-Fi）:")
    for ip in lan_ips() or ["<本机IP>"]:
        print("     http://%s:%d" % (ip, PORT))
    print(" 按 Ctrl+C 停止")
    print("=" * 56)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
