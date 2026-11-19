// 进程级状态：实例标识和启动各阶段的时间点（毫秒时间戳）。
import crypto from 'node:crypto';
import os from 'node:os';
import { performance } from 'node:perf_hooks';

export const INSTANCE_ID = `${os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;

export const boot = {
  // 进程创建时间，包含 Node 自身启动和运行时钩子加载
  processStartAt: performance.timeOrigin,
  moduleLoadAt: Date.now(),
  listeningAt: null,
  firstRequestAt: null
};
