import { spawnSync } from 'node:child_process';

const week = 7 * 86400000;
const sha = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const sortUnique = values => [...new Set(values)].sort();

// 禁止可选锁与按需联网取对象；所有 git 操作均只读。
let gitCalls = 0;
export const gitCallCountForTest = () => gitCalls;

function git(root, args) {
  gitCalls++;
  const result = spawnSync('git', args, {
    cwd: root, shell: false, windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1' },
  });
  if (result.error || result.status !== 0) throw new Error('git 读取失败');
  return result.stdout;
}

function paths(root, parent, commit) {
  return git(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--no-renames', parent, commit, '--'])
    .split('\0').filter(Boolean);
}

function collectOne(root, task, now, head, shallow) {
  const result = { id: task.id, merge: task.merge, reverted: { state: 'unknown', commits: [] }, fixes: { state: 'unknown', commits: [] } };
  try {
    if (!sha.test(task.merge) || !Number.isFinite(task.acceptedAt) || !Number.isFinite(now)) return result;
    const merge = git(root, ['rev-parse', '--verify', `${task.merge}^{commit}`]).trim();
    if (merge !== task.merge) return result;
    git(root, ['merge-base', '--is-ancestor', merge, head]);
    // 祖先路径排除非后代旁支。
    const after = git(root, ['rev-list', '--ancestry-path', `${merge}..${head}`, '--']).trim().split('\n').filter(Boolean);
    const afterSet = new Set(after);
    const reverts = new Set((Array.isArray(task.reverted) ? task.reverted : [])
      .map(event => event?.commit).filter(commit => sha.test(commit) && afterSet.has(commit)));
    const metadata = new Map();
    if (after.length) {
      // 提交正文不含 NUL；字段以 NUL 分隔，-z 结束每条记录。
      const raw = git(root, ['log', '--ancestry-path', '-z', '--format=%H%x00%P%x00%ct%x00%s%x00%B', `${merge}..${head}`, '--']);
      const fields = raw.split('\0');
      if (fields.pop() !== '' || fields.length !== after.length * 5) throw new Error('提交数据无效');
      for (let i = 0; i < fields.length; i += 5) {
        const [commit, parents, timestamp, title, body] = fields.slice(i, i + 5);
        if (!afterSet.has(commit) || metadata.has(commit) || !/^\d+$/.test(timestamp)) throw new Error('提交数据无效');
        metadata.set(commit, { parents: parents ? parents.split(' ') : [], at: Number(timestamp) * 1000, title });
        const pattern = /^This reverts commit ([0-9a-f]{40}|[0-9a-f]{64})\.$/gm;
        for (const match of body.matchAll(pattern)) if (match[1] === merge) reverts.add(commit);
      }
    }
    result.reverted = { state: reverts.size ? 'yes' : shallow ? 'unknown' : 'no', commits: sortUnique(reverts) };
    if (shallow) return result;
    const parents = git(root, ['show', '-s', '--format=%P', merge, '--']).trim().split(' ').filter(Boolean);
    if (!parents.length) return result;
    const changed = new Set(paths(root, parents[0], merge));
    const fixes = [];
    for (const commit of after) {
      const item = metadata.get(commit);
      if (item.parents.length !== 1 || reverts.has(commit) || item.at <= task.acceptedAt || item.at > task.acceptedAt + week || item.at > now || !(/\bfix\b/i.test(item.title) || item.title.includes('修复'))) continue;
      const files = sortUnique(paths(root, item.parents[0], commit).filter(file => changed.has(file)));
      if (files.length) fixes.push({ commit, at: item.at, files });
    }
    fixes.sort((a, b) => a.commit < b.commit ? -1 : a.commit > b.commit ? 1 : 0);
    result.fixes = { state: now < task.acceptedAt + week ? 'pending' : 'complete', commits: fixes };
  } catch {
    // 扫描未完成时不得把部分结果当成完整结果。
    result.reverted = { state: 'unknown', commits: [] };
    result.fixes = { state: 'unknown', commits: [] };
  }
  return result;
}

export function collectSignals({ root, tasks, now = Date.now() }) {
  try {
    const head = git(root, ['rev-parse', '--verify', 'HEAD^{commit}']).trim();
    const shallow = git(root, ['rev-parse', '--is-shallow-repository']).trim();
    if (!sha.test(head) || !['true', 'false'].includes(shallow)) throw new Error('仓库状态无效');
    return { tasks: tasks.map(task => collectOne(root, task, now, head, shallow === 'true')) };
  } catch {
    return { tasks: tasks.map(task => ({ id: task.id, merge: task.merge, reverted: { state: 'unknown', commits: [] }, fixes: { state: 'unknown', commits: [] } })) };
  }
}
