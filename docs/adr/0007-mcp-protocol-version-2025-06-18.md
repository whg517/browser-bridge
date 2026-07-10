# ADR-0007:锁定 MCP 协议版本 2025-06-18

- **状态**:Accepted
- **日期**:2026-07-07

## 背景

MCP(Model Context Protocol)在快速演进。协议版本用日期字符串标识(如 `2024-11-05`、`2025-06-18`),不同版本的握手字段、能力声明、消息格式有差异。

browser-bridge 作为 MCP server,需要在 `initialize` 响应里声明自己说的协议版本,并按该版本实现。选错版本会导致 MCP 客户端握手失败或行为异常。

## 决策

**锁定协议版本 `2025-06-18`**(调研时的当前稳定版)。

具体实现:
- `initialize` 响应里 `protocolVersion: "2025-06-18"`
- 实现该版本的最小消息集:`initialize` / `notifications/initialized` / `ping` / `tools/list` / `tools/call`
- 不实现 `resources/` / `prompts/`(可选,capabilities 只声明 `{"tools": {}}`)
- 工具错误用 result 内 `isError: true`,不用 JSON-RPC error
- 未知方法返回 `-32601`

## 考虑过的替代方案

### 方案 A:用最新 draft 版本
- **调研发现**:有个 draft 提议移除 `initialize` / `notifications/initialized` 握手,改成无状态模型
- **问题**:调研时**没有发布版客户端**用这个 draft
- **排除**:用 draft 会导致与所有实际客户端不兼容

### 方案 B:用更老的 `2024-11-05`
- **问题**:旧版本的字段约定和能力模型与当前客户端实现有偏差
- **排除**:MCP 客户端普遍实现的是 2025-06-18,用旧版本可能错过新约定

### 方案 C:协商(客户端发什么版本,我回什么版本)
- **问题**:server 应该声明自己支持的版本,客户端再协商。盲目 echo 客户端版本会导致 server 实际没实现却声称支持
- **处理**:server 声明 `2025-06-18`;若客户端发不同版本,由客户端决定是否继续(我们的实现不做主动协商)

## 后果

### 正面
- **与 MCP 客户端兼容**:MCP 客户端普遍实现的就是这个版本,握手能通过
- **稳定**:协议版本锁定,不随 draft 漂移
- **最小实现**:只实现必需消息,代码量小,易审计

### 负面
- **未来要跟进**:MCP 若发布新稳定版且客户端升级,browser-bridge 可能需要更新协议版本号 + 适配新约定
- **不主动协商**:如果客户端坚持要别的版本,我们不会降级/升级(直接声明 2025-06-18,客户端不接受就连接失败)

## 关键实现细节

来自字节级协议调研(详见架构调研报告):

### 传输
- NDJSON,LF 分隔,**禁止内嵌换行**(serde 序列化自动转义)
- stdin 收,stdout 发,stderr 仅日志
- 每条消息一个 `\n`

### 握手
```
client → server: {"jsonrpc":"2.0","id":1,"method":"initialize",
                  "params":{"protocolVersion":"2025-06-18","capabilities":{},...}}
server → client: {"jsonrpc":"2.0","id":1,"result":{
                  "protocolVersion":"2025-06-18",
                  "capabilities":{"tools":{}},
                  "serverInfo":{"name":"browser-bridge","version":"0.1.0"}}}
client → server: {"jsonrpc":"2.0","method":"notifications/initialized"}  ← 无 id,不回复
```

### 工具错误(关键)
工具执行失败用 **result 内 `isError: true`**,**不**用 JSON-RPC error:
```json
{"jsonrpc":"2.0","id":3,"result":{
  "content":[{"type":"text","text":"Error: extension not connected"}],
  "isError":true
}}
```
理由:让模型看到错误文本并自我修正;JSON-RPC error 是协议层失败,会让中间件困惑。

### 必须处理 ping
客户端发 `ping` 做 keepalive,server 必须回空 result:
```json
// in:  {"jsonrpc":"2.0","id":7,"method":"ping"}
// out: {"jsonrpc":"2.0","id":7,"result":{}}
```
很多客户端 ping 无响应就判 server 死了。

## 实施

`src/mcp_server.rs` 的 `handle()` 函数,5 个 method 分支 + 默认 `-32601`。

## 已验证

端到端测试 PASS:
- initialize 响应正确返回 protocolVersion/capabilities/serverInfo
- notifications/initialized 被正确吞掉(无响应)
- tools/list 返回 11 个工具
- ping 返回空 result
- 退出码 0,锁文件清理正常

## 参考

- [MCP Lifecycle 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle)
- [MCP Tools 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
- [MCP Transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
- draft spec changelog(无状态握手提议,未采用)
