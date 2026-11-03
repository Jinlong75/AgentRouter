const nonEmptyLine = value => typeof value === 'string' && value.trim() !== '' && !/[\r\n]/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateTarget(value) {
  const errors = [];
  const invalid = path => errors.push(`目标字段无效：${path}`);
  const field = (item, key, path = key) => {
    if (!nonEmptyLine(item?.[key])) invalid(path);
  };
  const root = object(value) ? value : {};
  if (typeof root.goal !== 'string' || !root.goal.split('\n').every(nonEmptyLine)) invalid('goal');
  if (!Array.isArray(root.milestones) || root.milestones.length === 0) {
    invalid('milestones');
  } else {
    Array.from(root.milestones).forEach((milestone, i) => {
      const path = `milestones[${i}]`;
      if (!object(milestone)) {
        invalid(path);
        return;
      }
      field(milestone, 'title', `${path}.title`);
      for (const key of ['commands', 'manualChecks']) {
        if (!Array.isArray(milestone[key]) || milestone[key].length === 0 ||
            !Array.from(milestone[key]).every(nonEmptyLine)) invalid(`${path}.${key}`);
      }
    });
  }
  if (!Array.isArray(root.exclusions) || !root.exclusions.length) invalid('exclusions');
  else Array.from(root.exclusions).forEach((item, i) => {
    if (!nonEmptyLine(item)) invalid(`exclusions[${i}]`);
  });
  for (const key of ['budget', 'deadline']) field(root, key);
  return { valid: errors.length === 0, errors };
}

export function parseTarget(text) {
  if (typeof text !== 'string') throw new Error('目标内容必须是字符串');
  const lines = text.split(/\r?\n/);
  let index = 0;
  const skip = () => { while (index < lines.length && lines[index].trim() === '') index++; };
  const fail = () => { throw new Error(`目标格式无效：第 ${index + 1} 行`); };
  const peek = () => { skip(); return lines[index]?.trim(); };
  const expect = expected => {
    if (peek() !== expected) fail();
    index++;
  };
  const value = () => {
    const line = peek();
    if (!line || /^(?:#|[-*+](?:\s|$)|\d+[.)]\s)/.test(line) || !nonEmptyLine(line)) fail();
    index++;
    return line;
  };
  expect('# 项目目标');
  expect('## 最终目标');
  const goalLines = [];
  while (peek() && !/^(?:#|[-*+](?:\s|$)|\d+[.)]\s)/.test(peek())) goalLines.push(value());
  if (!goalLines.length) fail();
  const goal = goalLines.join('\n');
  expect('## 里程碑');
  const milestones = [];
  while (peek()?.startsWith('### ')) {
    const title = peek().slice(4).trim();
    if (!nonEmptyLine(title)) fail();
    index++;
    const commands = [];
    const manualChecks = [];
    while (true) {
      const line = peek();
      const match = line?.match(/^- (完成条件命令|人工验证项)：(.*)$/);
      if (!match) break;
      const entry = match[2].trim();
      if (!nonEmptyLine(entry)) fail();
      (match[1] === '完成条件命令' ? commands : manualChecks).push(entry);
      index++;
    }
    if (!commands.length || !manualChecks.length) fail();
    milestones.push({ title, commands, manualChecks });
  }
  if (!milestones.length) fail();
  expect('## 不做什么');
  const exclusions = [];
  while (peek() && !peek().startsWith('#')) {
    const line = peek();
    if (line.startsWith('- ')) {
      const entry = line.slice(2).trim();
      if (!nonEmptyLine(entry)) fail();
      exclusions.push(entry);
      index++;
    } else exclusions.push(value());
  }
  if (!exclusions.length) fail();
  expect('## 预算');
  const budget = value();
  expect('## 截止时间');
  const deadline = value();
  if (peek() !== undefined) fail();
  const result = { goal, milestones, exclusions, budget, deadline };
  if (!validateTarget(result).valid) fail();
  return result;
}
