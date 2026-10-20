// 软件内部使用的环境变量。
// 演示把隔离用的覆盖值放在 AR_ISOLATED_ENV（JSON：变量名 → 字符串，null 表示删除）里交给软件，
// 只合并进软件自己用的环境：公共目录、偏好与托管线程（Worker 的 env）、核心子进程（coreRun）。
// Electron 主进程自身的 process.env 保持用户原样、运行中不改，所以 shell.openPath 打开的外部程序
// （编辑器等）和 Chromium 子进程拿到的是用户真实环境，不会带走演示的假 USERPROFILE / APPDATA。
// 没有 AR_ISOLATED_ENV 时（安装版、截图验收、测试）原样返回，行为不变。
export const isolatedEnvKey = 'AR_ISOLATED_ENV';

const sameKey = (a, b, platform) => platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

export function appEnvironment(base = process.env, platform = process.platform) {
  const raw = base[isolatedEnvKey];
  const env = { ...base };
  for (const key of Object.keys(env)) if (sameKey(key, isolatedEnvKey, platform)) delete env[key];
  if (raw === undefined) return env;
  let overrides;
  try { overrides = JSON.parse(raw); } catch (e) { throw Error(`${isolatedEnvKey} 不是有效的 JSON：${e.message}`); }
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw Error(`${isolatedEnvKey} 必须是对象`);
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== null && typeof value !== 'string') throw Error(`${isolatedEnvKey} 中 ${key} 的值必须是字符串或 null`);
    // Windows 环境变量名不区分大小写：先删掉所有同名（忽略大小写）的项再写入。
    for (const existing of Object.keys(env)) if (sameKey(existing, key, platform)) delete env[existing];
    if (value !== null) env[key] = value;
  }
  return env;
}

// 演示用：算出从 base（用户真实环境）到 isolated（隔离环境）需要的覆盖值。
export function isolationOverrides(base, isolated, platform = process.platform) {
  const find = (env, key) => Object.keys(env).find(k => sameKey(k, key, platform));
  const overrides = {};
  for (const [key, value] of Object.entries(isolated)) {
    if (value === undefined) continue;
    const old = find(base, key);
    if (old === undefined || base[old] !== value) overrides[key] = value;
  }
  for (const key of Object.keys(base)) if (find(isolated, key) === undefined) overrides[key] = null;
  return overrides;
}
