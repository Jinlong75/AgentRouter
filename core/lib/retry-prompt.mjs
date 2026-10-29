// 重试段落生成：把上一次的失败信息（门禁未通过或执行者异常退出）与主导补充说明
// 拼到原始指令后面，形成这次发给执行者的完整指令（文件协议 14.2 第 8 条）。
// 纯函数：不读写文件、不读环境变量、不打印。零依赖。

// 每段输出的截断上限：末尾 80 行、8 KB（UTF-8 字节）。
const MAX_LINES = 80;
const MAX_BYTES = 8192;

// 有失败时附上的要求（第 3 条是"与改动无关的失败"）。
const REQUIREMENTS = `要求：
1. 在当前工作区已有改动的基础上修复，不要推倒重来。
2. 修复后重新运行上面的验收命令，确认通过再提交。
3. 如果某条失败与你这次的改动无关（例如原本就不稳定的检查），不要为了它去修改无关的文件，在汇报里写明。
4. 汇报里说明这次改了什么、上一次为什么没有通过。`;

// 生成这一次发给执行者的完整指令。
// base：原始指令；n：第几次尝试（从 1 开始）；total：一共允许几次（手动重试为 null）；
// failure：上一次的失败（null 表示没有）；note：主导补充说明（可为空）。
// escalation：默认升级链这一次做了什么的一句话（提高了推理强度 / 换了执行者），写在标题下面；没有就不写。
// 没有失败也没有补充说明时原样返回 base（第 1 次尝试的指令不变）。
export function buildPrompt(base, { n, total, failure, note, escalation } = {}) {
  if (!failure && !note) return base;
  const paragraphs = [base];
  if (failure?.kind === 'conflict') paragraphs.push(...conflictParagraphs(failure));
  else if (failure?.kind === 'review') paragraphs.push(...reviewParagraphs(failure));
  else if (failure) {
    paragraphs.push(
      `## 上一次尝试没有通过验收（第 ${n - 1} 次${total == null ? '' : `，共允许 ${total} 次`}）`,
      ...(escalation ? [escalation] : []),
      ...failureParagraphs(failure),
      REQUIREMENTS,
    );
  }
  if (note) paragraphs.push(`## 主导补充说明\n\n${note}`);
  return paragraphs.join('\n\n');
}

// 合并冲突（协议 15.8）：主分支有新的提交，合并进当前工作区时有冲突，合并停在冲突状态。
// failure：{ kind: 'conflict', files: [冲突文件], baseBranch }。
function conflictParagraphs({ files = [], baseBranch = '主分支' }) {
  return [
    `## 需要解决合并冲突`,
    `${baseBranch} 上有新的提交，把它合并进当前工作区时有冲突，合并停在冲突状态，还没有提交。`,
    listSection('以下文件有冲突：', files),
    `要求：
1. 解决合并冲突，保留双方的意图，不要简单地丢掉任何一方的改动。
2. 解决后重新运行验收命令，确认通过。
3. 提交合并结果（不要放弃这次合并，也不要重新建分支）。
4. 汇报里说明每个冲突文件是怎么取舍的。`,
  ];
}

// 审查触发的返工（Stage08 T3）：门禁已经通过，审查者提出了问题。
// failure：{ kind: 'review', issues: [{ id, severity, file, line, title, detail, confirmation }] }。
// 列出没有被标为"不成立"的 high 问题与 medium 问题，high 在前，最多 10 条；low 不列。
const REVIEW_ISSUE_LIMIT = 10;
const SEVERITY_ORDER = { high: 0, medium: 1 };
function reviewParagraphs({ issues = [] }) {
  const listed = (Array.isArray(issues) ? issues : [])
    .filter(issue => issue && Object.hasOwn(SEVERITY_ORDER, issue.severity) && issue.confirmation?.result !== 'invalid')
    .map((issue, index) => ({ issue, index }))
    .sort((a, b) => SEVERITY_ORDER[a.issue.severity] - SEVERITY_ORDER[b.issue.severity] || a.index - b.index)
    .slice(0, REVIEW_ISSUE_LIMIT)
    .map(({ issue }) => {
      const where = issue.file ? `${issue.file}${Number.isInteger(issue.line) ? `:${issue.line}` : ''}` : '（没有指明文件）';
      const detail = String(issue.detail ?? '').trim().replace(/\r?\n/g, '\n  ');
      return `- ${issue.id}（${issue.severity}）${where}　${issue.title}${detail ? `\n  ${detail}` : ''}`;
    });
  return [
    '## 上一次审查发现了这些问题',
    listed.join('\n'),
    '如果你认为某条问题不成立，在汇报里说明理由，不要为了通过审查做无意义的修改。',
  ];
}

// 失败信息的各段（不含标题与要求）。执行者失败给出错信息；否则按门禁结果分段。
function failureParagraphs(failure) {
  if (failure.kind !== 'agent') return gateParagraphs(failure.gate);
  const paragraphs = [`失败原因：执行者异常退出（exit ${failure.exit}）。`];
  // 最后 3 条出错事件文字与 stderrTail 连接后取末尾；都为空时不写"出错信息末尾"一行和代码块。
  const tail = [...(Array.isArray(failure.errors) ? failure.errors : []).slice(-3), failure.stderrTail]
    .filter(Boolean).join('\n');
  if (tail) paragraphs.push(`出错信息末尾：\n${fence(tailOf(tail))}`);
  return paragraphs;
}

// 门禁失败的各段：原因、越界（受保护的另列一段）、未提交、没提交、删除的文件、逐条失败命令。
// scope.protected / scope.deleted 是 Stage05 新增，旧 gate.json 可能没有，按"没有记录"处理（协议 12.3）。
function gateParagraphs(gate) {
  const scope = gate.scope ?? {};
  const commit = gate.commit ?? {};
  const protectedFiles = Array.isArray(scope.protected) ? scope.protected : [];
  const outside = (Array.isArray(scope.outside) ? scope.outside : [])
    .filter(file => !protectedFiles.includes(file));
  const uncommitted = Array.isArray(gate.uncommitted) ? gate.uncommitted : [];
  const deleted = Array.isArray(scope.deleted) ? scope.deleted : [];
  const commands = Array.isArray(gate.commands) ? gate.commands : [];
  const paragraphs = [`失败原因：${gate.summary}`];
  if (outside.length) {
    paragraphs.push(listSection('以下文件不在允许修改的范围内，请用 git 把它们恢复到任务开始时的版本，不要删除或绕过检查：', outside));
  }
  if (protectedFiles.length) {
    paragraphs.push(listSection('以下文件是受保护的路径（任务说明、项目配置），不允许修改，请用 git 把它们恢复到任务开始时的版本：', protectedFiles));
  }
  if (uncommitted.length) paragraphs.push(listSection('以下文件改了但没有提交：需要就提交，不需要就恢复：', uncommitted));
  if (commit.required === true && commit.ok === false) paragraphs.push('上一次没有提交任何改动：完成后必须提交。');
  if (deleted.length) {
    paragraphs.push(listSection('上一次删除了以下文件：如果不是任务要求删除的（例如为了让检查通过而删掉测试），请恢复它们：', deleted));
  }
  for (const command of commands) {
    if (command.timedOut || command.error != null || command.exit !== 0) paragraphs.push(commandParagraph(command));
  }
  return paragraphs;
}

// 一段"标题 + 文件清单"。
const listSection = (title, files) => `${title}\n${files.map(file => `- ${file}`).join('\n')}`;

// 一条失败命令的段落：原因 + 输出末尾的代码块；输出为空时写"，没有输出。"。
function commandParagraph(command) {
  const head = `验收命令 \`${command.line}\` ${commandReason(command)}`;
  if (command.output == null || command.output === '') return `${head}，没有输出。`;
  return `${head}，输出末尾：\n${fence(tailOf(command.output))}`;
}

// 失败原因写法：超时 → 超时；启动失败 → 没能运行（原因）；否则 → 失败（exit N）。
function commandReason(command) {
  if (command.timedOut) return '超时';
  if (command.error != null) return `没能运行（${command.error}）`;
  return `失败（exit ${command.exit}）`;
}

// 每段输出只留末尾 80 行、且不超过 8 KB：先取末尾 80 行，再从开头整行去掉直到满足字节数；
// 换行统一成 \n（输入里的 \r\n 也按行处理）；单独一行就超限时保留这一行的末尾（从字符边界开始）。
function tailOf(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  let tail = lines.slice(-MAX_LINES).join('\n');
  while (Buffer.byteLength(tail) > MAX_BYTES) {
    const newline = tail.indexOf('\n');
    if (newline === -1) return tailBytes(tail, MAX_BYTES);
    tail = tail.slice(newline + 1);
  }
  return tail;
}

// 超长单行按字节保留末尾，起点对齐到 UTF-8 字符边界（不切出半个字符）。
function tailBytes(text, maxBytes) {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return text;
  let start = buffer.length - maxBytes;
  // 落点在多字节字符中间时向后跳过续字节（10xxxxxx），从下一个完整字符开始。
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start).toString('utf8');
}

// 代码块围栏：反引号组成，长度为内容里最长连续反引号 + 1、至少 3 个（CommonMark），
// 这样输出里的 ``` 不会打断代码块；不插入零宽字符等不可见字符。
function fence(text) {
  let longest = 0;
  for (const run of String(text).matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  const bar = '`'.repeat(Math.max(3, longest + 1));
  return `${bar}\n${text}\n${bar}`;
}
