import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { git } from './git.mjs';

export function parseMutations(spec, report) {
  const all = [];
  for (const [source, text] of [['spec', spec], ['report', report]]) {
    const section = /^##\s+反向实验\s*\r?\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m.exec(text ?? '')?.[1] ?? '';
    let sourceIndex = 0;
    for (const block of section.matchAll(/```json\s*\r?\n([\s\S]*?)```/g)) {
      let items;
      try { items = JSON.parse(block[1]); } catch (e) { throw new Error(`${source} JSON 解析失败：${e.message}`); }
      if (!Array.isArray(items)) throw new Error(`${source} 必须是数组`);
      items.forEach(item => {
        const i = sourceIndex++;
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${source} 第 ${i + 1} 项必须是对象`);
        for (const field of ['file', 'find', 'replace', 'command']) if (typeof item[field] !== 'string' || (field !== 'replace' && !item[field])) throw new Error(`${source} 第 ${i + 1} 项 ${field} 无效`);
        if (item.expect !== undefined && typeof item.expect !== 'string') throw new Error(`${source} 第 ${i + 1} 项 expect 无效`);
        if (item.find === item.replace) throw new Error(`${source} 第 ${i + 1} 项 replace 无效`);
        if (!all.some(x => ['file', 'find', 'replace', 'command'].every(k => x[k] === item[k]))) all.push({ ...item, source, sourceIndex: i + 1 });
      });
    }
  }
  return all;
}
export function validateMutation(root, item, verify) {
  const file = item.file;
  if (isAbsolute(file) || /^[A-Za-z]:/.test(file) || file.split(/[\\/]/).includes('..')) throw new Error('file 必须是仓库内相对路径');
  const path = resolve(root, file), rel = relative(realpathSync(root), realpathSync(path));
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('file 超出仓库');
  if (git(root, ['ls-files', '--error-unmatch', '--', file]).status !== 0) throw new Error('file 不是已跟踪文件');
  if (!verify.includes(item.command)) throw new Error('command 不在验收命令中');
  const bytes = readFileSync(path), text = bytes.toString('utf8');
  // 重叠出现也算多次（aaa 里找 aa 是两次）：从第一次出现的下一个字符起再找。
  const first = text.indexOf(item.find);
  if (first === -1 || text.indexOf(item.find, first + 1) !== -1) throw new Error('find 必须恰好出现一次');
  return { path, bytes, text };
}
export async function executeMutation(root, item, verify, run, index) {
  let state, before, result, reason = '';
  const status = () => { const r = git(root, ['status', '--porcelain']); if (r.status !== 0) throw new Error('无法读取工作区状态'); return r.stdout; };
  try {
    state = validateMutation(root, item, verify); before = status();
    writeFileSync(state.path, state.text.replace(item.find, () => item.replace));
    result = await run(item.command, item.expect);
    if (result.timedOut) reason = `反向实验 ${index} 超时`;
    else if (result.error != null) reason = `反向实验 ${index} 启动失败：${result.error}`;
    else if (result.exit === 0) reason = `反向实验 ${index} 没有让检查失败：${item.command} 退出码 0（目标逻辑失效时检查仍通过）`;
    else if (item.expect !== undefined && !(result.expectMatched ?? result.output?.includes(item.expect))) reason = `反向实验 ${index} 的失败输出里没有“${item.expect}”`;
  } catch (e) { reason = `反向实验 ${index}（${item.source} 第 ${item.sourceIndex ?? index} 项）失败：${e.message}`; }
  finally {
    if (state && before !== undefined) {
      try { writeFileSync(state.path, state.bytes); const after = status(); if (after !== before) reason = `反向实验 ${index} 结束后工作区没有恢复：${after}`; }
      catch (e) { reason = `反向实验 ${index} 结束后工作区没有恢复：${e.message}`; }
    }
  }
  if (reason && !reason.includes(`(${item.source} `) && !reason.includes(`（${item.source} `)) reason += `（${item.source} 第 ${item.sourceIndex ?? index} 项）`;
  return { index, source: item.source, file: item.file, command: item.command, exit: result?.exit ?? null, timedOut: result?.timedOut ?? false, ms: result?.ms ?? 0, ok: !reason, reason };
}
