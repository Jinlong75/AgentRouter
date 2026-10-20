// 适配器注册表：执行者差异只写在适配器里，公共层通过 adapterFor(profile) 拿到适配器。
// Stage02 加 claude-code，Stage07 加 generic。
import { codex } from './codex.mjs';
import { claudeCode } from './claude-code.mjs';
import { fake } from './fake.mjs';

export const adapters = { codex, 'claude-code': claudeCode, fake };

export function adapterFor(profile) {
  const adapter = adapters[profile?.adapter];
  if (!adapter) throw new Error(`不支持的执行者类型：${profile?.adapter}（可用：${Object.keys(adapters).join('、')}）`);
  return adapter;
}
