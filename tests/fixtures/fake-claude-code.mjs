// 假的 Claude Code（测试用，经 AR_TEST_AGENT 指定）：回放一份真实输出样例到标准输出，不访问任何服务。
// 环境变量：AR_TEST_FIXTURE 样例文件（默认同目录的 claude-code-sample.jsonl）、AR_TEST_EXIT 退出码、AR_TEST_STDERR 写到标准错误的文字、
// AR_TEST_ENV_REPORT 证据文件：只写变量名、布尔值与路径，从不写任何变量的值（以免测试本身把密钥写进文件）；
// AR_TEST_TOKEN_SHA256 期望的令牌摘要（执行者环境是白名单，读不到密钥来源变量，只能比对摘要）。
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

if (process.argv.includes('--version')) { console.log('2.1.302 (Claude Code)'); process.exit(0); }
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { prompt += d; });
process.stdin.on('end', () => {
  const env = process.env;
  if (env.AR_TEST_ENV_REPORT) writeFileSync(env.AR_TEST_ENV_REPORT, JSON.stringify({
    args: process.argv.slice(2), cwd: process.cwd(), promptChars: prompt.length,
    names: Object.keys(env).filter(k => /^(ANTHROPIC|CLAUDE)/i.test(k)).sort(),
    configDir: env.CLAUDE_CONFIG_DIR ?? null, baseUrl: env.ANTHROPIC_BASE_URL ?? null, model: env.ANTHROPIC_MODEL ?? null,
    tokenFromSource: !!env.ANTHROPIC_AUTH_TOKEN && createHash('sha256').update(env.ANTHROPIC_AUTH_TOKEN).digest('hex') === env.AR_TEST_TOKEN_SHA256,
    allNames: Object.keys(env).sort(),
    disableAutoupdater: env.DISABLE_AUTOUPDATER ?? null,
  }));
  const fixture = env.AR_TEST_FIXTURE ?? fileURLToPath(new URL('claude-code-sample.jsonl', import.meta.url));
  // 样例里的示例根目录换成实际工作目录（真实的 Claude Code 报告的就是它所在项目的绝对路径）。样例是 JSON 文本，反斜杠按转义后的形式替换。
  const cwd = process.cwd(), escaped = JSON.stringify(cwd).slice(1, -1), sampleRoot = JSON.stringify('D:\\demo\\repo').slice(1, -1);
  const text = readFileSync(fixture, 'utf8').split(sampleRoot).join(escaped).split('D:/demo/repo').join(cwd.replaceAll('\\', '/'));
  process.stdout.write(text);
  if (env.AR_TEST_STDERR) process.stderr.write(`${env.AR_TEST_STDERR}\n`);
  process.exitCode = Number(env.AR_TEST_EXIT ?? 0);
});
