# herdr-relay

自托管的 **Herdr 手机远程访问**：配对码 + 端到端加密中继。中继只转发密文，无法读取终端内容，也无法向终端注入命令。

协议同时对齐两套真实实现：

- Alma 桌面版（0.4.400）的 `alma-relay-e2e/v1` 端到端会话与 `hb`/`wb` 隧道；
- 官方 [`yetone/alma-relay`](https://github.com/yetone/alma-relay) 1.2.0 的 Node edition 中继线协议（HTTP/WS 反向代理、protocol 1/2、流式请求体、推送、TURN、LAN 直连）。

因此同一个 relay 既能服务本项目自带的 desktop connector + 手机页面，也能作为 `relay.alma.now` 的自托管替代，接住已安装的 Alma 桌面 app；反过来，本项目的 connector 也能注册到官方 relay 上（已用本机运行的 `ghcr.io/yetone/alma-relay` 容器实测）。

## 组成

```
手机浏览器 ──HTTPS/WSS──▶ relay ──WSS──▶ desktop connector ──HTTP/WS──▶ herdr 的 Unix socket API
              │                    │
              └── /c/<token>/… ────┘    E2E 会话跑在 /__alma_e2e__ 这条 WS 里
                  中继只做反向代理；E2E 打开时它只见密文
```

| 文件 | 作用 |
| --- | --- |
| `src/relay/server.mjs` | 中继：官方 protocol 1/2 的 HTTP 代理 + WS 桥接、`/agent` 注册、鉴权、推送、TURN、静态页面 |
| `src/relay/shared.mjs` | 协议常量、`parseClientPath`、`encodeBinary`/`decodeBinary`、relay token 校验、TURN 凭据 |
| `src/relay/apns.mjs` / `fcm.mjs` | APNs / FCM 推送（没有配置密钥时返回 `unsupported`） |
| `src/desktop/connector.mjs` | 桌面端：注册、心跳/看门狗、protocol 1/2、明文 HTTP/WS 代理、E2E tunnel、LAN 直连 |
| `src/desktop/tunnel.mjs` | 一条 relay/E2E 隧道的 HTTP + WS 代理、流式请求体、`hack` 背压、`/__alma_lan__` |
| `src/desktop/lan.mjs` | LAN 直连：`0.0.0.0:23019`（占用则随机端口）、`__alma_e2e__`、候选地址 |
| `src/desktop/herdr-bridge.mjs` | 把 herdr 的 NDJSON Unix socket API 暴露成回环 HTTP/WS，并限制手机可调用的方法 |
| `web/lib/e2e.js` | 配对派生 + ECDH/HKDF/AES-GCM 握手与会话（Node 与浏览器共用同一份代码） |
| `web/` | 手机端页面：配对码 / LAN 直连 / 明文兼容模式，pane 列表、读屏、发文本 |
| `src/protocol/ws.mjs` | 无依赖 RFC6455 WebSocket（服务端 + 客户端，带 maxPayload/背压） |

无第三方依赖，纯 Node 内置模块（Node ≥ 20）。

## 快速开始

```bash
# 一台机器跑全套：bridge + desktop connector + relay
node src/cli.mjs all --relay-port 8899 --bridge-port 23021
# 终端会打印 pairing code、alma:// 配对链接和 http://127.0.0.1:8899/#code=<code>
```

分开跑：

```bash
node src/cli.mjs bridge  --port 23021                 # herdr socket → HTTP/WS
node src/cli.mjs relay   --port 8899 --host 0.0.0.0   # 中继 + 手机页面
node src/cli.mjs desktop --relay http://127.0.0.1:8899 --local http://127.0.0.1:23021
```

- 手机打开 `http://<relay>:8899/`，粘贴配对码；或直接用带 `#code=` 的链接。
- `--socket` / `HERDR_SOCKET_PATH` / `HERDR_SESSION` 选择 herdr 的 socket。
- `--allow-all` 解除 bridge 对手机的方法白名单（默认只允许 `*.list|get|read|wait|snapshot` 与少数输入类方法）。
- `--e2e off` 关闭端到端加密，走官方 protocol 1/2 的明文 `hreq`/`wopen` 通道（不推荐）。
- `--no-lan` 关闭 LAN 直连；`--relay-token` 给需要 registration key / relay token 的中继。

## 接住已安装的 Alma 桌面 app

Alma 的本地控制 API 在 `127.0.0.1:23001`（不是文档里的 23002）。它内置 `POST /api/mobile-relay/enable`：

```bash
node src/cli.mjs relay --port 8899 &          # 先起中继
node src/cli.mjs alma --enable --relay http://127.0.0.1:8899
node src/cli.mjs alma                          # 打印当前状态 / pairingLink
node src/cli.mjs alma --regenerate             # 换配对码（旧码短期仍可用）
node src/cli.mjs alma --reconnect              # 强制桌面重连
node src/cli.mjs alma --token <relay-token>    # 设置/清空 relay token
node src/cli.mjs alma --disable                 # 关闭（也可 --enable --relay <原地址> --e2e off 精确回滚）
```

`--enable` 会把 Alma 的 `serverUrl` 指到本项目的中继并打开 E2E（`e2eEncryption: true`）。Alma 会以 `{t:"register", tokenHash, name, key, proto:2}` 注册；中继用 `sha256hex(routingId)` 反查桌面连接，所以配对码不会离开两端。Alma 关闭 E2E 时走明文 `hreq` 通道，本项目也支持（不推荐）。

### 手机页面的两种后端

页面连上 E2E 后先 `GET /api/snapshot` 探测：200 就是本项目的 bridge，404/403 就切到 Alma 模式。

| 能力 | herdr-relay bridge | 已安装的 Alma |
| --- | --- | --- |
| 连接状态 / pane 列表 | `GET /api/snapshot` | `WS /ws/herdr` hub 推送（`{type:"herdr"}`、`{type:"snapshot"}`、`{type:"status"}`） |
| JSON-RPC | `POST /api/rpc` | `POST /api/herdr/rpc`（Alma 手机白名单：`*.list|get` + `pane.read`/`pane.send_text`/`pane.send_keys` 等） |
| 读屏 / 输入 | `pane.read`、`pane.send_text`、`pane.send_keys` | 同左 |

hub 不可用时会退回 `pane.list` 轮询，界面不变。

## 协议

### 地址与注册

配对码 43 字符 base64url（32 随机字节）。所有派生量都可由配对码算出，中继只拿到不可逆的哈希：

```
routingId  = b64url(HKDF-SHA256(ikm=code, salt="alma-relay-e2e/v1/routing", 128 bit))
tokenHash  = sha256hex(routingId)                 # E2E 开启时的桌面注册名
tokenHash  = sha256hex(code)                      # E2E 关闭时
```

桌面连 `wss://relay/agent?th=<tokenHash>`，首帧：

```json
{ "t": "register", "tokenHash": "…", "name": "…", "key": "…", "proto": 2 }
```

中继回 `{ "t": "registered", "proto": 2 }`（协商取双方较小值；任何一侧缺省按 1 处理）。注册失败关闭码：`4002` tokenHash 非法、`4003` registration key 错误、`4401` relay token 错误；同一 tokenHash 被新连接接管时旧连接收 `4000`。

### 手机侧（官方中继协议）

手机访问 `https://relay/c/<token>/<path>`：

- HTTP 请求被中继转成 agent 上的 `{t:"hreq", id, method, path, headers, b?}`；桌面回 `hres`/`hchunk`/`hend`，中继流式写回手机（SSE 可用）。桌面在 120 s 内不出 `hres` 会被 504。
- WebSocket 请求被转成 `{t:"wopen", id, path}`；桌面回 `wopened`/`werr`，之后 `wmsg`（`s` 文本 / `b` base64 二进制）和 `wclose` 双向桥接。`wopened` 之前手机发来的消息会被中继排队（上限 4 MiB）。
- protocol 2 用二进制帧 `[kind u8][idLen u8][id][payload]`：`1`=响应体、`2`=请求体（中继→桌面）、`3`=二进制 WS、`4`=文本 WS；请求体还带 `stream:true` + `HBODY` + `hack` 信用窗口（4 MiB，窗口 256 KiB 切片）。
- E2E 只是 WS 里的内容：手机连 `/c/<routingId>/__alma_e2e__`，中继自动 `wopen` 该路径，之后手机与桌面在桥接的 WS 上跑 E2E 握手/密封帧。中继不解析这些字节。

### 端到端加密（`alma-relay-e2e/v1`）

```
transcript = SHA-256("alma-relay-e2e/v1" ‖ iPk ‖ rPk ‖ iNonce ‖ rNonce)
shared     = ECDH P-256
c2s / s2c  = HKDF(shared, salt=code, info="c2s|"/"s2c|" ‖ transcript, 256 bit)
confirm-r  = HKDF(..., "confirm-r|" ‖ transcript)     # 响应方证明
confirm-i  = HKDF(..., "confirm-i|" ‖ transcript)     # 发起方证明
密封帧      = AES-GCM，IV = 0x00000000 ‖ u64 counter，逐帧递增
```

握手：`{t:"hi",epk,n,bin,sb}` → `{t:"hi",epk,n,cr,bin,sb}` → `{t:"ok",ci}`。`bin` 协商二进制密封帧：头部 `[0][u32 jsonLen][json]` + 原始 payload，`$:"b"` 为二进制 body、`$:"s"` 为文本 WS 消息的 UTF-8 尾巴；否则回退为 JSON + base64url `b`。`sb` 表示支持流式请求体。

### 隧道内帧（E2E 内或明文模式）

- HTTP：`hreq`（`b` 或 `stream:true`）→ `hres`/`hchunk`/`hend`/`herr`，`hbody`/`hreqend`/`hcancel`/`hack`。
- WebSocket：`wopen`/`wopened`/`werr`/`wmsg`/`wclose`。
- 桌面虚拟端点：`GET /__alma_lan__` 返回 `{port, hosts}`（LAN 直连候选）。

### LAN 直连

桌面在 `0.0.0.0:23019`（被占用则随机端口）监听 `__alma_e2e__`。手机先通过中继 E2E 请求 `/__alma_lan__` 拿到候选地址，再对 `ws://<host>:<port>/__alma_e2e__` 重跑一次 E2E 握手；成功就切到直连，失败保持中继。最多 16 个客户端，20 s ping。

### 推送与 TURN（可选）

- 桌面发 `{t:"push", id, notifications:[…]}`；中继有 APNs/FCM 密钥就投递并回 `{t:"pushed", id, results:[{token,status,reason?}]}`，没有密钥回 `{t:"pushed", id, unsupported:true}`。
- 手机可 `POST /turn`（`Authorization: Bearer <relay token>`）拿 TURN REST 凭据；未配置 `TURN_URLS`/`TURN_SECRET` 时 404。

中继环境变量与官方 Node edition 一致：`PORT`、`HOST`、`RELAY_PROTOCOL`、`MAX_BODY_MB`、`MAX_BUFFERED_MB`、`MAX_AGENTS`、`MAX_REQUESTS_PER_AGENT`、`MAX_SOCKETS_PER_AGENT`、`STALL_TIMEOUT_S`、`RELAY_REGISTRATION_KEY`、`RELAY_TOKEN_SECRET`/`RELAY_TOKEN_MESSAGE`、`APNS_KEY`/`APNS_KEY_FILE`/`APNS_KEY_ID`/`APNS_TEAM_ID`/`APNS_TOPIC`/`APNS_ENV`、`FCM_SERVICE_ACCOUNT`/`FCM_SERVICE_ACCOUNT_FILE`/`FCM_PROJECT_ID`、`TURN_URLS`/`TURN_SECRET`/`TURN_TTL`。

## 测试

```bash
node --test test/
```

- `test/pairing.test.mjs`：配对码、routingId、握手、错误配对码失败、密封帧不含明文、protocol 2 的 `$:"s"` 文本帧。
- `test/relay-protocol.test.mjs`：官方中继线协议——healthz、protocol 2 HTTP/二进制响应、流式请求体 + `hack`、protocol 1 base64 回退、注册鉴权 4003、push `unsupported`、WS 桥接。
- `test/tunnel.test.mjs`：完整链路（手机 → 中继 → 桌面 → bridge → 假 herdr），HTTP/JSON-RPC/WS 三条通道，断言中继转发方向上不含 pane 明文与方法名，验证接管（replaced）语义与“只接受 E2E”的拒绝。
- `test/plain-and-lan.test.mjs`：E2E 关闭时的明文 HTTP/流式 POST，以及 LAN 直连 + `/__alma_lan__` 候选。
- `test/desktop-dispatch.test.mjs`：按 Alma `MobileRelay` 的帧分派逐条对齐——`wopen` 的 E2E 路径/拒绝/明文三态、未知隧道的 `wclose 4404`、E2E 模式下 `hreq` 回 403。
- `test/backend.test.mjs`：后端探测、hub 消息折叠、`pane.read` 结果形状、Alma 错误文案。
- `test/alma-mode.test.mjs`：用 `test/fixtures/fake-alma-desktop.mjs`（按 Alma 报文形状实现）验证「探测到 Alma → `/api/herdr/rpc` 列表/读屏/输入 → `/ws/herdr` hub 推送 → 白名单拒绝」。
- `test/live-herdr.test.mjs`：对本机真实 herdr socket 跑 `ping`、`session.snapshot`，并在存在 socket 时把快照完整走一遍 relay + E2E。

已额外用本机运行的官方 `ghcr.io/yetone/alma-relay` 容器验证：本 connector 的 E2E / 明文 HTTP / 流式 POST / WS 均可互通；反向用本 relay 接住真实 Alma 0.4.400 桌面（E2E 握手、`/api/herdr/rpc`、`/ws/herdr`）。

## 已知限制

- 手机页面渲染的是 `pane.read` 的纯文本快照（1.5s 轮询），不是终端格子渲染；Alma 模式（`/ws/herdr`）下同样如此。注意：Alma 的手机端是独立的 Capacitor 工程，不在 `app.asar` 里，所以它到底怎么渲染无法从本 artifact 证实；而 herdr 的 schema 只提供 `pane.read` 的 `text`/`ansi`，没有 cells/grid 协议，`pane.updated` 也只带元数据——任何格子渲染都得在客户端模拟。
- 没有 APNs/FCM 密钥时不会真正投递推送（中继按官方协议回 `unsupported`）；没有推送设置界面。
- Alma 的 `/api/handoff/tool-approvals` 与 `/api/handoff/user-questions` 走通用隧道可直达桌面，但 herdr 侧还没有产生审批/提问的生产者，页面也没有审批 UI。
- 没有 NAT 穿透 / WebRTC 屏幕流；`/turn` 只是按官方协议签发 TURN 凭据。
- 中继不校验配对码的持有者身份，拿到配对码即可配对；配对码泄露等同于授权，需自行轮换。
- 明文模式（`--e2e off`）没有加密，仅用于兼容关闭 E2E 的桌面；公网部署请放在 HTTPS 反向代理之后（`wss://` 才能被浏览器视为安全上下文）。

## 许可证

<!-- 待定 -->
