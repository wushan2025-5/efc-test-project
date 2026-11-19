// 本地验证用：模拟 execd 的 /function-logs，每条记录追加到 LOG_OUT（jsonl）
import fs from 'node:fs';
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 8790);
const OUT = process.env.LOG_OUT || '/tmp/br-logs.jsonl';
const TOKEN = process.env.MOCK_TOKEN || 'local-token';

http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (d) => {
      body += d;
    });
    req.on('end', () => {
      const ok = req.url === '/function-logs' && req.headers['x-execd-access-token'] === TOKEN;
      fs.appendFileSync(OUT, (ok ? '' : '#BAD ') + body + '\n');
      res.statusCode = ok ? 200 : 401;
      res.end();
    });
  })
  .listen(PORT, () => console.log(`mock log on ${PORT} → ${OUT}`));
