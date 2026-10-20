import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function registryWriter(home, { separate = false } = {}) {
  return record => {
    try {
      mkdirSync(home, { recursive: true });
      appendFileSync(join(home, 'runs.jsonl'), `${separate ? '\n' : ''}${JSON.stringify({ v: 1, ...record })}\n`);
    } catch { /* 协议规定：清单写入失败不影响任务。 */ }
  };
}

// 协议 v2：每个任务一个目录 <项目>/.agent-runs/<名>/。
export function taskPaths(root, name) {
  const dir = join(root, '.agent-runs', name);
  return { name, dir, progress: join(dir, 'progress.log'), report: join(dir, 'report.md'), raw: join(dir, 'raw.log'), events: join(dir, 'events.jsonl') };
}

export function dispatchPath(root, name) {
  return join(taskPaths(root, name).dir, 'dispatch.json');
}

// 派发参数快照：再派一次按同样的参数重新派发。字段只有用户输入与执行者名，不含任何密钥值。
// 先写临时文件再改名，读到的要么是完整文件，要么什么都没有。
export function writeDispatch(paths, fields) {
  const file = join(paths.dir, 'dispatch.json');
  const temp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify({ v: 1, ...fields }), { flag: 'wx', mode: 0o600 });
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return file;
}

// 读回派发参数。文件不存在或格式不对都当作旧任务（返回 null），由调用方报同一句话。
export function readDispatch(root, name) {
  let value;
  try { value = JSON.parse(readFileSync(dispatchPath(root, name), 'utf8')); } catch { return null; }
  const valid = value && value.v === 1 && typeof value.task === 'string' && value.task !== ''
    && typeof value.extra === 'string' && (value.role === null || typeof value.role === 'string')
    && (value.spec === null || typeof value.spec === 'string') && typeof value.profile === 'string' && value.profile !== ''
    && typeof value.name === 'string' && value.name !== '';
  return valid ? value : null;
}

export function recordPaths(root, requested, header, dryRun = false) {
  for (let n = 1; ; n++) {
    const paths = taskPaths(root, n === 1 ? requested : `${requested}-${n}`);
    if (dryRun) { if (existsSync(paths.progress)) continue; }
    else {
      mkdirSync(paths.dir, { recursive: true });
      // 独占创建 progress.log 占名，并发派发也不会占用同一个记录名。
      try { writeFileSync(paths.progress, header, { flag: 'wx' }); }
      catch (error) { if (error.code === 'EEXIST') continue; throw error; }
    }
    return paths;
  }
}
