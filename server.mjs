// Backend-real：Express 5 + ws + 原生模块，探针挂在 /__probe 下。
// 端口取 PORT，云构建的 start.mjs 会拦截 listen 改用自己的端口，所以监听完成用 'listening' 事件记录。
import express from 'express';
import { WebSocketServer } from 'ws';
import { INSTANCE_ID, boot } from './lib/state.mjs';
import probe from './routes/probe.mjs';

const app = express();

app.use((req, res, next) => {
  if (boot.firstRequestAt === null) {
    boot.firstRequestAt = Date.now();
  }
  res.set('x-probe-instance', INSTANCE_ID);
  next();
});

app.get('/', (req, res) => {
  res.json({
    name: 'Backend-real',
    instance: INSTANCE_ID,
    probes: [
      'GET /__probe/boot',
      'GET /__probe/filler?verify=1',
      'GET /__probe/native',
      'GET /__probe/child',
      'GET /__probe/log?size=40000',
      'GET /__probe/sse?n=5',
      'GET /__probe/big?mb=5',
      'POST /__probe/upload',
      'GET /__probe/whoami/test',
      'WS /__probe/ws'
    ]
  });
});

app.use('/__probe', probe);

const server = app.listen(Number(process.env.PORT) || 3000);
server.on('listening', () => {
  boot.listeningAt = Date.now();
  const address = server.address();
  console.log(`[backend-real] listening on ${typeof address === 'object' && address ? address.port : address}`);
});

// WebSocket：连接后先发 hello，之后原样回显
const wss = new WebSocketServer({ server, path: '/__probe/ws' });
wss.on('connection', (socket) => {
  socket.send(JSON.stringify({ type: 'hello', instance: INSTANCE_ID }));
  socket.on('message', (data, isBinary) => {
    socket.send(data, { binary: isBinary });
  });
});
