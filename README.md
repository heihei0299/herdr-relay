# herdr-relay

自托管的 **Herdr 手机远程访问**：配对码 + 端到端加密中继。中继服务器只转发密文，无法读取你的终端内容，也无法向终端注入命令。

协议与 Alma 桌面版（0.4.400）自带的 remote 子系统（`alma-relay-e2e/v1`）兼容，因此同一个 relay 既能服务本项目自带的桌面 connector，也能作为 `relay.alma.now` 的自托管替代，接住已安装的 Alma 桌面 app。

## 组成

```
手机浏览器 ──WSS──▶ relay ──WSS──▶ desktop connector ──HTTP/WS──▶ herdr 的 Unix socket API
        └──────────── 端到端加密（中继只见密文）────────────┘
```

| 文件 | 作用 |
| --- | --- |
| `src/relay/server.mjs` | 中继：`/agent` 桌面注册、`/c/<routingId>/…` 手机接入、帧转发、静态页面 |
| `src/desktop/connector.mjs` | 桌面端：注册、E2E responder、HTTP/WS 隧道代理 |
| `src/desktop/herdr-bridge.mjs` | 把 herdr 的 NDJSON Unix socket API 暴露成回环 HTTP/WS，并限制手机可调用的方法 |
| `web/lib/e2e.js` | 配对派生 + ECDH/HKDF/AES-GCM 握手与会话（Node 与浏览器共用同一份代码） |
| `web/` | 手机端页面：输入配对码 → 连接 → 看 pane 输出、发文本 |
| `web/lib/backend.js` | 后端适配：herdr-relay bridge 与 Alma（`/ws/herdr` hub + `/api/herdr/rpc`） |
| `src/protocol/ws.mjs` | 无依赖 RFC6455 WebSocket（服务端 + 客户端） |

无第三方依赖，纯 Node 内置模块（Node ≥ 20）。

## 快速开始

```bash
# 一台机器跑全套：bridge + desktop connector + relay
node src/cli.mjs all --relay-port 8899 --bridge-port 23021
# 终端会打印 pairing code 和 http://127.0.0.1:8899/#code=<code>
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

## 接住已安装的 Alma 桌面 app

Alma 的本地控制 API 在 `127.0.0.1:23001`（不是文档里的 23002）。它内置 `POST /api/mobile-relay/enable`：

```bash
node src/cli.mjs relay --port 8899 &          # 先起中继
node src/cli.mjs alma --enable --relay http://127.0.0.1:8899
node src/cli.mjs alma                          # 打印当前状态 / pairingLink
node src/cli.mjs alma --disable                 # 关闭（也可 --enable --relay <原地址> --e2e off 精确回滚）
```

`--enable` 会把 Alma 的 `serverUrl` 指到本项目的中继并打开 E2E（`e2eEncryption: true`）。Alma 会以 `{t:"register", tokenHash, name, proto:2}` 注册；中继用 `sha256hex(routingId)` 反查桌面连接，所以配对码不会离开两端。Alma 关闭 E2E 时走明文 `hreq` 通道，本项目也支持（不推荐）。

### 手机页面的两种后端

页面连上 E2E 后先 `GET /api/snapshot` 探测：200 就是本项目的 bridge，404/403 就切到 Alma 模式。

| 能力 | herdr-relay bridge | 已安装的 Alma |
| --- | --- | --- |
| 连接状态 / pane 列表 | `GET /api/snapshot` | `WS /ws/herdr` hub 推送（`{type:"herdr"}`、`{type:"snapshot"}`、`{type:"status"}`） |
| JSON-RPC | `POST /api/rpc` | `POST /api/herdr/rpc`（Alma 手机白名单：`*.list|get` + `pane.read`/`pane.send_text`/`pane.send_keys` 等） |
| 读屏 / 输入 | `pane.read`、`pane.send_text`、`pane.send_keys` | 同左 |

hub 不可用时会退回 `pane.list` 轮询，界面不变。

## 协议

配对码 43 字符 base64url（32 随机字节）。所有派生量都可由配对码算出，中继只拿到不可逆的哈希：

```
routingId  = b64url(HKDF-SHA256(ikm=code, salt="alma-relay-e2e/v1/routing", 128 bit))
tokenHash  = sha256hex(routingId)                 # 桌面注册名；E2E 关闭时是 sha256hex(code)
transcript = SHA-256("alma-relay-e2e/v1" ‖ iPk ‖ rPk ‖ iNonce ‖ rNonce)
shared     = ECDH P-256
c2s / s2c  = HKDF(shared, salt=code, info="c2s|"/"s2c|" ‖ transcript, 256 bit)
confirm-r  = HKDF(..., "confirm-r|" ‖ transcript)     # 响应方证明
confirm-i  = HKDF(..., "confirm-i|" ‖ transcript)     # 发起方证明
密封帧      = AES-GCM，IV = 0x00000000 ‖ u64 counter，逐帧递增
```

握手：`{t:"hi",epk,n,bin,sb}` → `{t:"hi",epk,n,cr,bin,sb}` → `{t:"ok",ci}`。
中继帧：控制面 JSON，数据面二进制记录 `[kind u8][idLen u8][id][payload]`（1=HTTP body，3=socket binary，4=socket text）。

- 桌面 → 中继：`/agent?th=<tokenHash>`，`{t:"register",…}`、`wopened`、`werr`、`wmsg`、`wclose`、`hres`、`hchunk`、`hend`、`herr`。
- 手机 → 中继：连 `/c/<routingId>`（Alma 手机端）或 `/c/<routingId>/__alma_e2e__`（自带页面），然后
  `{t:"wopen", id, path:"/__alma_e2e__"}` → 中继回 `{t:"wopened", id}`（失败为 `{t:"werr", id, message}`），
  之后每条消息都是 E2E 记录，中继原样包进 `wmsg` 转发。
- 只接受 E2E：桌面收到未加密的 `hreq` 会回 403 `This desktop only accepts end-to-end encrypted connections`。

## 测试

```bash
node --test test/
```

- `test/pairing.test.mjs`：配对码、routingId、握手、错误配对码失败、密封帧不含明文。
- `test/tunnel.test.mjs`：完整链路（手机 → 中继 → 桌面 → bridge → 假 herdr），验证 HTTP/JSON-RPC/WebSocket 三条通道，断言中继转发方向上不含 pane 明文与方法名，验证接管（replaced）语义。
- `test/backend.test.mjs`：后端探测、hub 消息折叠、`pane.read` 结果形状、Alma 错误文案。
- `test/alma-mode.test.mjs`：用 `test/fixtures/fake-alma-desktop.mjs`（按 Alma 报文形状实现）验证「探测到 Alma → `/api/herdr/rpc` 列表/读屏/输入 → `/ws/herdr` hub 推送 → 白名单拒绝」。
- `test/live-herdr.test.mjs`：对本机真实 herdr socket 跑 `ping`、`session.snapshot`，并在存在 socket 时把快照完整走一遍 relay + E2E。

## 已知限制

- 手机页面渲染的是 `pane.read` 的纯文本快照（1.5s 轮询），不是 Alma 手机端那种 `surface` 格子增量渲染；Alma 模式下同样如此。
- 没有推送通知（APNs）、NAT 穿透、LAN 直连与流量计费/限流。
- 中继不校验配对码的持有者身份，拿到配对码即可配对；配对码泄露等同于授权，需自行轮换。
- 未做反代/TLS 配置；公网部署请放在 HTTPS 反向代理之后（`wss://` 才能被浏览器视为安全上下文）。

## 许可证

<!-- 待定 -->
