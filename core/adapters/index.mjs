// 适配器注册表：执行者差异只写在适配器里，公共层通过 adapterFor(profile) 拿到适配器。
// Stage02 加 claude-code，Stage07 加 generic。
import { codex } from './codex.mjs';
import { claudeCode } from './claude-code.mjs';
import { fake } from './fake.mjs';
import { makeGeneric, brokenGeneric } from './generic.mjs';
import { validateGeneric } from '../lib/generic-schema.mjs';

// generic 不在这里：它的适配器由声明现做（genericFor）。
export const adapters = { codex, 'claude-code': claudeCode, fake };

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// 执行者配置对应的通用适配器声明：{ name, decl }；找不到或校验不通过时抛出中文原因（前 3 条错误，带路径）。
// 来源按顺序：派发时已解析好的 genericDecl（托管请求、升级快照里带着）→ 内嵌在 generic 字段里的声明 → config.generics[<generic>]。
export function genericDeclaration(profile, config = null) {
  if (typeof profile?.genericError === 'string') throw new Error(profile.genericError);
  const ref = profile?.generic;
  const name = typeof ref === 'string' ? ref : null;
  const decl = object(profile?.genericDecl) ? profile.genericDecl : object(ref) ? ref : name !== null ? config?.generics?.[name] : undefined;
  if (decl === undefined) {
    if (name === null) throw new Error('通用适配器执行者缺少 generic 字段（要引用的声明名，声明写在 config.json 的 generics 里）');
    throw new Error(`找不到通用适配器声明：config.json 的 generics.${name}`);
  }
  const checked = validateGeneric(decl, { path: `generics.${name ?? 'generic'}` });
  if (!checked.ok) {
    const shown = checked.errors.slice(0, 3).map(e => `${e.path}：${e.message}`).join('\n');
    const more = checked.errors.length > 3 ? `\n（另有 ${checked.errors.length - 3} 条错误）` : '';
    throw new Error(`通用适配器声明不合法：\n${shown}${more}`);
  }
  return { name, decl };
}

// 派发时把声明解析进执行者配置：genericDecl 随配置一起进托管请求 / 升级快照；
// 声明的 env 作默认值并入 env，声明的 secrets 在执行者配置自己没写 secrets 时并入（之后走 buildEnv / authOf）。
// 声明有问题时记下 genericError（adapterFor 据此失败）；已解析过的、非 generic 的原样返回。
export function resolveProfile(profile, config = null) {
  if (profile?.adapter !== 'generic' || profile.genericDecl !== undefined || profile.genericError !== undefined) return profile;
  try {
    const { decl } = genericDeclaration(profile, config);
    const ownSecrets = Object.keys(profile.secrets ?? {}).length > 0;
    return { ...profile, genericDecl: decl, env: { ...decl.env, ...profile.env }, secrets: ownSecrets ? profile.secrets : (decl.secrets ?? profile.secrets ?? {}) };
  } catch (error) {
    return { ...profile, genericError: error.message };
  }
}

// tolerant：generic 的声明有问题时不抛错，换成一个 command 必然失败的适配器（执行者没能启动，不重试）。
export function adapterFor(profile, { config = null, tolerant = false } = {}) {
  if (profile?.adapter === 'generic') {
    try {
      const { name, decl } = genericDeclaration(profile, config);
      return makeGeneric(decl, { name });
    } catch (error) {
      if (tolerant) return brokenGeneric(profile, error.message);
      throw error;
    }
  }
  const adapter = adapters[profile?.adapter];
  if (!adapter) throw new Error(`不支持的执行者类型：${profile?.adapter}（可用：${Object.keys(adapters).join('、')}）`);
  return adapter;
}
