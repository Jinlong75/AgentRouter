// 启动器解析（所有适配器共用）：参数数组 + shell:false 启动；npm 的 .cmd 包装解析成 Node 入口直接运行，不经过 cmd.exe。
import { existsSync, readFileSync, statSync } from 'node:fs';
import { delimiter, dirname, resolve } from 'node:path';
import { systemNode } from './command.mjs';

const isFile = file => existsSync(file) && statSync(file).isFile();

// Node 入口用系统 Node（430 D176）；找不到系统 Node（软件里才可能）时退回软件自带的运行时。
// runtime 让调用方看出跑在哪种运行时上：system = 系统 Node，bundled = 软件自带；不在 Electron 里时不带。
function nodeLaunch(wrapper, args, options) {
  const inElectron = options.inElectron ?? Boolean(process.versions.electron);
  const node = systemNode({ ...options, wrapperDir: dirname(wrapper), inElectron });
  if (node) return { executable: node, args, ...(inElectron ? { runtime: 'system' } : {}) };
  return { executable: options.execPath ?? process.execPath, args, runtime: 'bundled' };
}

// file 是可执行文件、Node 脚本或 npm 的 .cmd/.bat 包装；missing / unwrapError 由适配器提供中文说明。
// 其余选项（env、inElectron、execPath、exists、readdir、homedir、platform）原样交给 systemNode，测试可注入。
export function launcherFor(file, { missing, unwrapError, ...options } = {}) {
  if (!isFile(file)) throw new Error(missing);
  if (/\.(js|mjs|cjs)$/i.test(file)) return nodeLaunch(file, [file], options);
  if (!/\.(cmd|bat)$/i.test(file)) return { executable: file, args: [] };
  const wrapper = readFileSync(file, 'utf8');
  // 仅识别 npm 的包装入口，不执行或求值批处理文本：指向 Node 脚本时用 Node 运行；
  // 指向原生程序（如 Claude Code 2.x 的 bin\claude.exe）时直接运行它。两种都不经过 cmd.exe。
  const match = wrapper.match(/"%dp0%[\\/]([^"\r\n]+\.(?:js|mjs|cjs|exe))"\s+%\*/i);
  const entry = match && resolve(dirname(file), match[1]);
  if (entry && isFile(entry)) return /\.exe$/i.test(entry) ? { executable: entry, args: [] } : nodeLaunch(file, [entry], options);
  throw new Error(unwrapError(file));
}

// 在 PATH 里按顺序找第一个存在的文件名；找不到返回 null。
export function findOnPath(names, env = process.env) {
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const file = resolve(dir.replace(/^"|"$/g, ''), name);
      if (isFile(file)) return file;
    }
  }
  return null;
}
