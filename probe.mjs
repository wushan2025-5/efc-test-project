// 探针路由，挂在 /__probe 下。返回 JSON，响应头一律 no-store。
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import express from 'express';
import { INSTANCE_ID, boot } from '../lib/state.mjs';

const MB = 1024 * 1024;
// 应用根目录按本文件位置算，不依赖启动时的 cwd
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILLER_DIR = path.join(APP_ROOT, 'views', '__filler');
// 只回显这些环境变量的值，其余只给名称，避免把 AK 之类的密钥带出来
const ENV_VALUES = ['NODE_OPTIONS', 'PORT', 'TZ', 'LANG', 'NODE_ENV'];
const HOOK_STATE_SOURCE = "globalThis[Symbol.for('esa.runtime-log')]";

const router = express.Router();
router.use((req, res, next) => {
  res.set('cache-control', 'no-store');
  next();
});

function hooked() {
  const state = globalThis[Symbol.for('esa.runtime-log')];
  return Boolean(state && state.installed);
}

function diff(later, earlier) {
  if (later == null || earlier == null) {
    return null;
  }
  return Math.round(later - earlier);
}

// 递归统计目录下的文件数和总字节数，不跟随软链接
function walk(dir) {
  let files = 0;
  let bytes = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = walk(full);
      files += sub.files;
      bytes += sub.bytes;
    } else if (entry.isFile()) {
      files++;
      bytes += fs.statSync(full).size;
    }
  }
  return { files, bytes };
}

function readManifest() {
  try {
    return JSON.parse(fs.readFileSync(path.join(FILLER_DIR, 'manifest.json'), 'utf8'));
  } catch {
    return null;
  }
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (data) => hash.update(data))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

// 启动耗时、运行环境、应用目录（code.zip 解压后）的体积
router.get('/boot', (req, res) => {
  const tree = walk(APP_ROOT);
  const manifest = readManifest();
  const env = {};
  for (const name of ENV_VALUES) {
    env[name] = process.env[name] ?? null;
  }
  res.json({
    instance: INSTANCE_ID,
    pid: process.pid,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    cwd: process.cwd(),
    appRoot: APP_ROOT,
    hooked: hooked(),
    boot: {
      ...boot,
      moduleLoadMs: diff(boot.moduleLoadAt, boot.processStartAt),
      listenMs: diff(boot.listeningAt, boot.processStartAt),
      firstRequestMs: diff(boot.firstRequestAt, boot.processStartAt)
    },
    uptimeSec: Math.round(process.uptime()),
    memory: process.memoryUsage(),
    cpus: os.cpus().length,
    totalMemMb: Math.round(os.totalmem() / MB),
    appFiles: tree.files,
    appBytes: tree.bytes,
    filler: manifest ? { sizeMb: manifest.sizeMb, totalBytes: manifest.totalBytes, chunks: manifest.chunks.length, builtAt: manifest.builtAt } : null,
    env,
    envNames: Object.keys(process.env).sort()
  });
});

// 填充文件是否完整：?verify=1 时按 manifest 逐块算 sha256
router.get('/filler', async (req, res) => {
  const manifest = readManifest();
  if (!manifest) {
    res.status(404).json({ ok: false, error: 'views/__filler/manifest.json 不存在' });
    return;
  }
  if (req.query.verify !== '1') {
    res.json(manifest);
    return;
  }
  const started = Date.now();
  const bad = [];
  let bytes = 0;
  for (const chunk of manifest.chunks) {
    const file = path.join(FILLER_DIR, chunk.file);
    try {
      const size = fs.statSync(file).size;
      bytes += size;
      if (size !== chunk.bytes || (await sha256File(file)) !== chunk.sha256) {
        bad.push(chunk.file);
      }
    } catch (error) {
      bad.push(`${chunk.file}: ${error.code ?? error.message}`);
    }
  }
  const ms = Date.now() - started;
  res.json({
    ok: bad.length === 0 && bytes === manifest.totalBytes,
    totalBytes: manifest.totalBytes,
    readBytes: bytes,
    bad,
    ms,
    mbPerSec: ms > 0 ? Math.round((bytes / MB / ms) * 1000 * 10) / 10 : null
  });
});

// 原生模块：@node-rs/xxhash 按平台加载 .node，空串的哈希值是固定的
router.get('/native', async (req, res) => {
  const require = createRequire(import.meta.url);
  let bindings = [];
  try {
    const scope = path.dirname(path.dirname(require.resolve('@node-rs/xxhash/package.json')));
    bindings = fs.readdirSync(scope).filter((name) => name.startsWith('xxhash'));
  } catch {
    // 包都找不到时下面的 import 会给出错误
  }
  try {
    const { xxh32, xxh64 } = await import('@node-rs/xxhash');
    const h32 = xxh32(Buffer.alloc(0)).toString(16);
    const h64 = xxh64(Buffer.alloc(0)).toString(16);
    res.json({
      ok: h32 === '2cc5d05' && h64 === 'ef46db3751d8e999',
      xxh32: h32,
      xxh64: h64,
      platform: `${process.platform}-${process.arch}`,
      bindings
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error && error.stack ? error.stack : error), bindings });
  }
});

function runSpawn(tag) {
  const code = [
    `const s = ${HOOK_STATE_SOURCE};`,
    `console.log('[${tag}] spawn console.log');`,
    "require('fs').writeSync(3, JSON.stringify({ hooked: Boolean(s && s.installed), nodeOptions: process.env.NODE_OPTIONS || '' }));"
  ].join('\n');
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'inherit', 'inherit', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    child.stdio[3].on('data', (data) => {
      out += data;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ error: error.message });
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      try {
        resolve({ exitCode, ...JSON.parse(out) });
      } catch {
        resolve({ exitCode, error: 'fd3 无输出', raw: out });
      }
    });
  });
}

function runWorker(tag) {
  const code = [
    `const s = ${HOOK_STATE_SOURCE};`,
    `console.log('[${tag}] worker console.log');`,
    "require('node:worker_threads').parentPort.postMessage({ hooked: Boolean(s && s.installed) });"
  ].join('\n');
  return new Promise((resolve) => {
    const worker = new Worker(code, { eval: true });
    const timer = setTimeout(() => {
      worker.terminate();
      resolve({ error: 'timeout' });
    }, 10000);
    worker.once('message', (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    worker.once('error', (error) => {
      clearTimeout(timer);
      resolve({ error: error.message });
    });
  });
}

// 子进程和 worker 里运行时钩子是否生效；每处各打一条带 tag 的日志，去日志后台核对
router.get('/child', async (req, res) => {
  const tag = `probe-child-${Date.now().toString(36)}`;
  console.log(`[${tag}] main console.log`);
  const [spawned, worker] = await Promise.all([runSpawn(tag), runWorker(tag)]);
  res.json({
    tag,
    main: { hooked: hooked(), nodeOptions: process.env.NODE_OPTIONS ?? '' },
    spawn: spawned,
    worker
  });
});

// 日志采集：每条带同一个 tag；?size=N 额外输出一条 N 字节的长日志，末尾带 END
router.get('/log', (req, res) => {
  const tag = `probe-log-${Date.now().toString(36)}`;
  const size = Math.min(Number(req.query.size ?? 0) || 0, MB);
  console.log(`[${tag}] console.log`);
  console.info(`[${tag}] console.info`);
  console.warn(`[${tag}] console.warn`);
  console.error(`[${tag}] console.error`);
  console.debug(`[${tag}] console.debug`);
  console.dir({ tag, via: 'console.dir', nested: { a: 1 } });
  process.stdout.write(`[${tag}] stdout.write\n`);
  process.stderr.write(`[${tag}] stderr.write\n`);
  console.log(`[${tag}] multi-line first\nsecond line\nthird line`);
  console.log(`[${tag}] json`, { nested: { a: 1, list: [1, 2, 3] }, zh: '中文日志' });
  console.error(new Error(`[${tag}] error with stack`));
  if (size > 0) {
    const head = `[${tag}] long size=${size} `;
    console.log(head + 'x'.repeat(Math.max(size - head.length - 3, 0)) + 'END');
  }
  res.json({ tag, size, instance: INSTANCE_ID, hooked: hooked(), lines: size > 0 ? 12 : 11 });
});

// SSE：每秒推一条，共 ?n 条（默认 10），用来看链路是否缓冲
router.get('/sse', (req, res) => {
  const total = Math.min(Number(req.query.n ?? 10) || 10, 120);
  res.set({ 'content-type': 'text/event-stream', 'x-accel-buffering': 'no' });
  res.flushHeaders();
  const started = Date.now();
  let i = 0;
  const tick = () => {
    i++;
    res.write(`id: ${i}\ndata: ${JSON.stringify({ i, sinceStartMs: Date.now() - started })}\n\n`);
    if (i >= total) {
      res.end('event: done\ndata: end\n\n');
      return;
    }
    timer = setTimeout(tick, 1000);
  };
  let timer = setTimeout(tick, 0);
  req.on('close', () => clearTimeout(timer));
});

// 大响应：?mb=N（默认 5，上限 200），每 1MB 一块，x-probe-bytes 为预期字节数
router.get('/big', (req, res) => {
  const mb = Math.min(Math.max(Number(req.query.mb ?? 5) || 5, 1), 200);
  const chunk = Buffer.alloc(MB, 'abcdefghijklmnopqrstuvwxyz0123456789\n');
  res.set({ 'content-type': 'application/octet-stream', 'x-probe-bytes': String(mb * MB) });
  let sent = 0;
  const pump = () => {
    while (sent < mb) {
      sent++;
      if (!res.write(chunk)) {
        res.once('drain', pump);
        return;
      }
    }
    res.end();
  };
  pump();
});

// 上传：流式算字节数和 sha256，用来测请求体上限与完整性
router.post('/upload', (req, res) => {
  const started = Date.now();
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  req.on('data', (data) => {
    bytes += data.length;
    hash.update(data);
  });
  req.on('end', () => {
    res.json({
      bytes,
      sha256: hash.digest('hex'),
      contentLength: req.get('content-length') ?? null,
      readMs: Date.now() - started,
      instance: INSTANCE_ID
    });
  });
});

router.get('/whoami', (req, res) => {
  res.json({ instance: INSTANCE_ID, pid: process.pid, uptimeSec: Math.round(process.uptime()) });
});

export default router;
