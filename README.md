# Backend-real fixture

Express 5 后端黑盒探针：一个项目覆盖 code.zip 体积档位（pod 拉代码与部署速率）、原生模块、子进程/worker、WebSocket、流式与大请求体、运行时日志采集，用来观察 TestStep → 生产容器整条链路上普通后端项目的实际表现。

- 入口 `server.mjs`（ESM），framework-checker 按 `server` + `import express` 识别为 Express。
- 探针都在 `/__probe/*`，`/` 列出全部探针；每个响应带 `x-probe-instance`。
- 自动化观测：`./probe.sh`。

## 控制台配置

| 项 | 值 |
|---|---|
| 根目录 | `Backend-real` |
| 构建命令 | `npm run build`（10M）或 `npm run build:200m`（200M） |
| 静态资源目录 | （留空） |
| 入口 | （留空） |
| Node 版本 | 22.x |

`esa.jsonc` 只填了 installCommand，不写 buildCommand——档位由控制台「构建命令」决定。

## 体积档位

`fc/code.zip` = 应用本身（约 0.8MB）+ 填充文件。填充文件由构建命令生成：

```bash
node scripts/gen-filler.mjs <MB>   # 写到 views/__filler/，也可用 FILLER_MB；MB=0 只写 manifest
```

- 内容是 aes-256-ctr 加密的全零数据：确定性、不可压缩，zip 后体积基本不变。
- framework-checker 会把 Express 的 `views/` 整个打进 code.zip，所以填充文件不需要被代码引用。
- `views/__filler/` 不入库，每次构建现生成（200MB 本地约 0.2s）。

| 档位 | 构建命令 | 本地 code.zip（darwin-arm64） | 云构建预估（linux-x64） |
|------|----------|-------------------------------|-------------------------|
| 10M | `node scripts/gen-filler.mjs 9.2` | 9.92MB | ≈ 10.0MB（linux 的 .node 多约 60KB） |
| 200M | `node scripts/gen-filler.mjs 199.2` | 199.95MB | ≈ 200.0MB |

TestStep 上传 index.zip 后会轮询版本状态；200M 档应记录版本就绪等待时间，确认最终变成 `Available`。

## 观测表

「本地实测」是 local-build 产物解压后、带运行时钩子启动的结果；「线上待确认」需要部署后用 probe.sh 观察。

| 探针 | 本地实测 | 线上待确认 |
|------|----------|------------|
| 首个请求 `/__probe/whoami` | — | 冷启动耗时（10M 与 200M 两档对比），`uptimeSec` 很小说明本次请求触发了冷启动 |
| `/__probe/boot` | 进程启动→监听约 80–100ms；返回应用目录文件数和总字节数 | pod 里的 node 版本、CPU/内存、cwd；环境变量只返回名称（只有 `NODE_OPTIONS`、`PORT`、`TZ`、`LANG`、`NODE_ENV` 带值） |
| `/__probe/filler?verify=1` | 逐块 sha256 一致；200MB 校验约 0.16s | 解压后是否完整；读盘速率 |
| `/__probe/native` | `@node-rs/xxhash` 加载成功，空串哈希正确 | 云构建装的是 linux 绑定，`bindings` 里应有 `xxhash-linux-x64-gnu`，pod 里能否加载 |
| `/__probe/child` | main、spawn 子进程 hooked=true（子进程通过 `NODE_OPTIONS --require` 继承）；**worker hooked=false** | 日志后台：main、spawn 两条都有（spawn 那条没有 host/path），worker 那条没有 |
| `/__probe/log?size=40000` | 采集到 10 条：console 的 log/info/warn/error/debug/dir、多行、对象、stack；**stdout.write / stderr.write 不采集**；40000 字节长日志截断到 32768 字节，末尾 `END` 丢失 | 日志后台按 tag 核对条数、级别、截断 |
| 启动日志 | `[backend-real] listening`、`[backend-runtime] listening` 两条都采集到（requestId/host/path 为空） | 同左 |
| `/__probe/ws` | 握手成功，hello 后原样回显 | 边缘和 FC 是否放行 WebSocket upgrade |
| `/__probe/whoami` ×40 并发 | 1 个实例 | 并发打出的实例数 |
| `/__probe/sse?n=5` | 首条 0s 到达，4s 结束 | 是否被缓冲（首条 ≈4s） |
| `/__probe/big?mb=50`（`BIG=1` 加 200） | 字节数正确 | 响应体上限、耗时 |
| `/__probe/upload` 3/20MB（`BIG=1` 加 100MB） | sha256 一致 | 请求体上限 |
| 未知路径 | Express 404 | 同左 |

## probe.sh

```bash
./probe.sh https://<域名>
FILLER_MB=199.2 ./probe.sh https://<域名>   # 额外核对填充体积与构建命令一致
BIG=1 ./probe.sh https://<域名>             # 额外跑 200MB 下载、100MB 上传
```

- `✓` 与上表「本地实测」一致，`✗` 不一致需要人工看，`·` 只打印观测值。
- 要测冷启动，部署完成后第一次运行 probe.sh，看「首个请求」那一节。
- ws 与嵌套字段解析需要本机 node（ws 需要 Node ≥ 22 的全局 WebSocket），没有 node 时相应项跳过或为空。
- 兼容 macOS 自带的 bash 3.2。

## 本地验证

本地没有 execd，用 `scripts/mock-log.mjs` 接收运行时钩子上报的日志（每条追加到 jsonl）。

```bash
# 1. 生成填充文件，再用 TestStep 的 local-build 走一遍云构建流程（local-build 不执行构建命令）
node scripts/gen-filler.mjs 9.2
npm_config_registry=https://registry.npmjs.org \
  node /path/to/TestStep/scripts/local-build.mjs
# version/deploy 步骤报 Invalid URL 属正常；日志里 Backend zip created 给出 code.zip 体积

# 2. 解压并启动
mkdir -p /tmp/br-fc && unzip -q fc/code.zip -d /tmp/br-fc
node scripts/mock-log.mjs &     # 监听 8790，写 /tmp/br-logs.jsonl
(cd /tmp/br-fc && PORT=3201 \
  ESA_RUNTIME_LOG_ENABLED=1 ESA_RUNTIME_LOG_IP=127.0.0.1 \
  ESA_RUNTIME_LOG_PORT=8790 ESA_RUNTIME_LOG_TOKEN=local-token \
  node __efc_runtime-bootstrap.mjs) &

# 3. 跑探针，再看采集到的日志
./probe.sh http://127.0.0.1:3201
cat /tmp/br-logs.jsonl
```

## 用例

| 用例 | 配置 | 预期 |
|------|------|------|
| 10M | 控制台构建命令 `npm run build` | 构建、部署成功，probe.sh 无 ✗ |
| 200M | 控制台构建命令 `npm run build:200m` | 同上；记录版本就绪等待时间和冷启动耗时 |
