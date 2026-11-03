import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ackFiles, ackToken, checkAck, confirmAck } from '../../core/lib/lead-ack.mjs';

test('确认码覆盖三份文件并规范化换行', t => {
  const root = mkdtempSync(join(tmpdir(), 'ack-unit-')), core = join(root, 'core');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, text) => { const f = join(root, path); mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, text); };
  const token = () => ackToken(ackFiles(root, core));
  const missing = token(); put('handoff.md', '?\r\n?'); const first = token(); assert.notEqual(first, missing);
  put('handoff.md', '?\n?'); assert.equal(token(), first);
  put('skills/lead-practices/SKILL.md', '经验'); const second = token(); assert.notEqual(second, first);
  put('docs/roles/lead.md', '角色'); assert.notEqual(token(), second);
});
test('检查记录、文件、会话与时间', t => {
  const root = mkdtempSync(join(tmpdir(), 'ack-check-')), core = resolve('core');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const opts = { env: { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'one' }, now: 100000000 };
  assert.equal(checkAck(root, core, opts), '没有确认记录');
  const files = ackFiles(root, core); assert.equal(confirmAck(root, core, ackToken(files), opts.env).code, undefined);
  const recordFile = join(root, '.agent-runs/lead-ack.json');
  const record = JSON.parse(requireRead(recordFile)); record.at = opts.now - 13 * 3600000; writeFileSync(recordFile, JSON.stringify(record));
  assert.equal(checkAck(root, core, opts), null);
  assert.equal(checkAck(root, core, { ...opts, env: { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'two' } }), '会话已换');
  assert.equal(checkAck(root, core, { ...opts, env: {} }), '确认已超过 12 小时');
  record.at = opts.now; writeFileSync(recordFile, JSON.stringify(record)); assert.equal(checkAck(root, core, { ...opts, env: {} }), null);
  writeFileSync(join(root, 'handoff.md'), '变化'); assert.equal(checkAck(root, core, opts), '文件已改：handoff.md');
});
import { readFileSync as requireRead } from 'node:fs';
