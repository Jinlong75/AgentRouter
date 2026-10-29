import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// 派发默认带角色（Stage07c 138，D63 / D75）：假执行者，隔离目录，临时仓库里派发。
const script = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));
const ROLE_LINE = { worker: '你在本项目中的角色是「执行者」。', reviewer: '你在本项目中的角色是「审查者」。' };

function fixture(t, { roles = ['worker', 'reviewer'] } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-dispatch-role-'));
  const home = path.join(base, 'home'), repo = path.join(base, 'repo');
  for (const dir of [home, path.join(repo, 'docs', 'roles'), path.join(repo, 'docs', 'specs')]) fs.mkdirSync(dir, { recursive: true });
  assert.ok(path.relative(os.tmpdir(), home).startsWith('ar-dispatch-role-'));
  const titles = { worker: '# 角色：执行者\n', reviewer: '# 角色：审查者\n' };
  for (const role of roles) fs.writeFileSync(path.join(repo, 'docs', 'roles', `${role}.md`), titles[role]);
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), '共同规则\n');
  fs.writeFileSync(path.join(repo, 'docs', 'specs', '001-代码.md'), '---\nid: 1\ntitle: 代码任务\ntype: code\nallowed_paths:\n  - docs/**\nmax_retries: 0\n---\n\n# 代码任务\n');
  fs.writeFileSync(path.join(repo, 'docs', 'specs', '002-审查.md'), '---\nid: 2\ntitle: 审查任务\ntype: review\nallowed_paths:\n  - docs/**\nmax_retries: 0\n---\n\n# 审查任务\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.agent-runs/\n');
  const git = (...args) => { const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  git('init', '-q'); git('add', '--', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init');
  const env = { ...process.env, AGENT_ROUTER_HOME: home, AR_NO_WATCH: '1' };
  for (const key of ['AR_DRY_RUN', 'CODEX_DRY_RUN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'AR_TEST_AGENT', 'CODEX_DISPATCH_TEST_AGENT']) delete env[key];
  const profile = { adapter: 'fake', label: '假执行者', enabled: true, events: [{ kind: 'say', text: '好' }], report: '假汇报\n', exit: 0, delayMs: 0 };
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ v: 2, managed: false, watchWindow: 'never', defaultProfile: 'fake', profiles: { fake: profile } }));
  t.after(() => {
    assert.ok(path.relative(os.tmpdir(), base).startsWith('ar-dispatch-role-'));
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const ar = args => spawnSync(process.execPath, [script, ...args], { cwd: repo, env, encoding: 'utf8', timeout: 30000, windowsHide: true, shell: false });
  const dispatch = (args, name) => {
    const r = ar(['dispatch', ...args, '--name', name, '--json']);
    // 假执行者不提交改动，门禁会报“没有提交任何改动”（退出码 3）；本测试只看指令，所以 0 和 3 都算派发成功。
    assert.ok([0, 3].includes(r.status), r.stderr + r.stdout);
    return r;
  };
  const dir = name => path.join(repo, '.agent-runs', name);
  const saved = name => JSON.parse(fs.readFileSync(path.join(dir(name), 'dispatch.json'), 'utf8'));
  const prompt = (name, n = 1) => fs.readFileSync(path.join(dir(name), 'attempts', String(n), 'prompt.md'), 'utf8');
  return { base, home, repo, ar, dispatch, saved, prompt };
}

const SPEC_TAIL = '然后完成任务说明 docs/specs/001-代码.md 中的全部内容，按要求验证、提交，最后给出汇报。';

test('任务说明（type: code）没写 --role：默认执行者，dispatch.json 记 role 与 roleDefault', t => {
  const f = fixture(t);
  f.dispatch(['docs/specs/001-代码.md'], 'a');
  const prompt = f.prompt('a');
  assert.equal(prompt.split('\n')[0], ROLE_LINE.worker);
  assert.equal(prompt, [ROLE_LINE.worker, '请先阅读仓库根目录的 AGENTS.md（共同规则）。', '再阅读你的角色文档 docs/roles/worker.md，严格遵守其中的职责、硬规则、完成标准和汇报格式。', SPEC_TAIL].join('\n'));
  const saved = f.saved('a');
  assert.equal(saved.role, 'worker');
  assert.equal(saved.roleDefault, true);
});

test('任务说明（type: review）没写 --role：默认审查者', t => {
  const f = fixture(t);
  f.dispatch(['docs/specs/002-审查.md'], 'r');
  assert.equal(f.prompt('r').split('\n')[0], ROLE_LINE.reviewer);
  assert.match(f.prompt('r'), /docs\/roles\/reviewer\.md/);
  assert.deepEqual([f.saved('r').role, f.saved('r').roleDefault], ['reviewer', true]);
});

test('项目没有角色文档：不带角色、不报错，指令不变；明确写了 --role 而文档不存在仍报错', t => {
  const f = fixture(t, { roles: [] });
  f.dispatch(['docs/specs/001-代码.md'], 'n');
  assert.equal(f.prompt('n'), ['请先阅读仓库根目录的 AGENTS.md（共同规则）。', SPEC_TAIL].join('\n'));
  const saved = f.saved('n');
  assert.equal(saved.role, null);
  assert.ok(!('roleDefault' in saved));
  assert.notEqual(f.ar(['dispatch', 'docs/specs/001-代码.md', '--role', 'worker', '--name', 'bad', '--json']).status, 0);
});

// D75（用户改）：任何派发都默认带角色，直接写任务文字没有 type，按执行者算。
test('直接写任务文字：项目有角色文档时默认带执行者角色；没有角色文档时不带、不报错', t => {
  const f = fixture(t);
  f.dispatch(['只回复 OK'], 't');
  assert.equal(f.prompt('t'), [ROLE_LINE.worker, '请先阅读仓库根目录的 AGENTS.md（共同规则）。', '再阅读你的角色文档 docs/roles/worker.md，严格遵守其中的职责、硬规则、完成标准和汇报格式。', '任务：\n只回复 OK'].join('\n'));
  assert.equal(f.saved('t').role, 'worker');
  assert.equal(f.saved('t').roleDefault, true);
  f.dispatch(['只回复 OK', '--role', 'none'], 't-none');
  assert.equal(f.prompt('t-none'), '请先阅读仓库根目录的 AGENTS.md（共同规则）。\n任务：\n只回复 OK');

  const bare = fixture(t, { roles: [] });
  bare.dispatch(['只回复 OK'], 'n');
  assert.equal(bare.prompt('n'), '请先阅读仓库根目录的 AGENTS.md（共同规则）。\n任务：\n只回复 OK');
  assert.equal(bare.saved('n').role, null);
  assert.ok(!('roleDefault' in bare.saved('n')));
});

test('--role none 不带角色；明确写 --role worker 指令与默认相同但没有 roleDefault', t => {
  const f = fixture(t);
  f.dispatch(['docs/specs/001-代码.md', '--role', 'none'], 'none');
  assert.equal(f.prompt('none'), ['请先阅读仓库根目录的 AGENTS.md（共同规则）。', SPEC_TAIL].join('\n'));
  assert.equal(f.saved('none').role, 'none');
  assert.ok(!('roleDefault' in f.saved('none')));
  f.dispatch(['docs/specs/001-代码.md'], 'dflt');
  f.dispatch(['docs/specs/001-代码.md', '--role', 'worker'], 'explicit');
  assert.equal(f.prompt('explicit'), f.prompt('dflt'));
  assert.equal(f.saved('explicit').role, 'worker');
  assert.ok(!('roleDefault' in f.saved('explicit')));
});

test('ar retry 与 ar redispatch：角色和第一次相同；redispatch 不拼出显式的 --role worker', t => {
  const f = fixture(t);
  f.dispatch(['docs/specs/001-代码.md'], 'rt');
  const first = f.prompt('rt');
  const retry = f.ar(['retry', 'rt', '--json']);
  assert.ok([0, 3].includes(retry.status),retry.stderr + retry.stdout);
  const second = f.prompt('rt', 2);
  assert.equal(second.split('\n')[0], ROLE_LINE.worker);
  assert.ok(second.startsWith(first));

  const again = f.ar(['redispatch', 'rt', '--json']);
  assert.ok([0, 3].includes(again.status),again.stderr + again.stdout);
  const name = JSON.parse(again.stdout).name;
  assert.notEqual(name, 'rt');
  assert.equal(f.prompt(name), first);
  const copied = f.saved(name);
  assert.equal(copied.role, 'worker');
  assert.equal(copied.roleDefault, true);
});

test('ar init 生成的 AGENTS.md 含"交互会话里的你默认是主导"', t => {
  const f = fixture(t);
  const fresh = path.join(f.base, 'fresh');
  fs.mkdirSync(fresh);
  assert.equal(spawnSync('git', ['-C', fresh, 'init', '-q'], { encoding: 'utf8' }).status, 0);
  const r = spawnSync(process.execPath, [script, 'init', fresh, '--json'], { cwd: fresh, env: { ...process.env, AGENT_ROUTER_HOME: f.home }, encoding: 'utf8', timeout: 30000, windowsHide: true, shell: false });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const text = fs.readFileSync(path.join(fresh, 'AGENTS.md'), 'utf8');
  assert.match(text, /交互会话里的你默认是主导；由 AgentRouter 派发启动、指令开头写明角色的才是执行者或审查者。/);
  assert.match(text, /指令开头写明了角色时，读对应的角色文档/);
});
