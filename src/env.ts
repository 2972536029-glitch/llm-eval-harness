/** 手动解析 .env,零依赖。只补缺、不覆盖已有环境变量(learning-log-qa src/env.ts 同款) */
import { existsSync, readFileSync } from 'node:fs';

let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  if (existsSync('.env')) {
    for (const line of readFileSync('.env', 'utf-8').split(/\r?\n/)) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
      }
    }
  }
  loaded = true;
}

// 惰性读取:取值发生在调用时而非模块加载时(pokemon 项目 dotenv 时序坑的教训)
export function requireEnv(name: string): string {
  ensureLoaded();
  const v = process.env[name];
  if (!v) throw new Error(`缺少环境变量 ${name}:复制 .env.example 为 .env 并填入`);
  return v;
}

export function envOr(name: string, fallback: string): string {
  ensureLoaded();
  return process.env[name] ?? fallback;
}
