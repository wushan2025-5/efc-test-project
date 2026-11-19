// 生成填充文件，用来把 fc/code.zip 撑到指定体积。
// 用法：node scripts/gen-filler.mjs [MB]，也可读 FILLER_MB，默认 8；MB=0 时只写 manifest。
// 内容是 aes-256-ctr 加密的全零数据：确定性、不可压缩，zip 后体积基本不变。
// 文件放在 views/__filler/ 下，framework-checker 会把 Express 的 views/ 整个打进 code.zip。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'views', '__filler');
const MB = 1024 * 1024;
const CHUNK_BYTES = 48 * MB;
const WRITE_BYTES = 4 * MB;
const KEY = crypto.createHash('sha256').update('backend-real-filler').digest();

const raw = process.argv[2] ?? process.env.FILLER_MB ?? '8';
const sizeMb = Number(raw);
if (!Number.isFinite(sizeMb) || sizeMb < 0) {
  console.error(`[gen-filler] 非法的 MB：${raw}`);
  process.exit(1);
}
const totalBytes = Math.round(sizeMb * MB);

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const zero = Buffer.alloc(WRITE_BYTES);
const chunks = [];
const started = Date.now();
for (let i = 0, left = totalBytes; left > 0; i++) {
  const bytes = Math.min(CHUNK_BYTES, left);
  // 块序号放在 iv 高位，各块的计数器区间不重叠
  const iv = Buffer.alloc(16);
  iv.writeUInt32BE(i, 0);
  const cipher = crypto.createCipheriv('aes-256-ctr', KEY, iv);
  const hash = crypto.createHash('sha256');
  const file = `chunk-${String(i).padStart(3, '0')}.bin`;
  const fd = fs.openSync(path.join(OUT, file), 'w');
  for (let done = 0; done < bytes; done += WRITE_BYTES) {
    const data = cipher.update(zero.subarray(0, Math.min(WRITE_BYTES, bytes - done)));
    hash.update(data);
    fs.writeSync(fd, data);
  }
  fs.closeSync(fd);
  chunks.push({ file, bytes, sha256: hash.digest('hex') });
  left -= bytes;
}

const manifest = {
  sizeMb,
  totalBytes,
  chunkBytes: CHUNK_BYTES,
  builtAt: new Date().toISOString(),
  node: process.version,
  chunks
};
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`[gen-filler] ${sizeMb}MB，${chunks.length} 个文件，耗时 ${Date.now() - started}ms → ${path.relative(ROOT, OUT)}`);
