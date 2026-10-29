// 模型与推理强度探针（Stage07c 142）：用用户自己的密钥或程序，查"这个账号能用哪些模型、各支持哪些推理强度"。
// 本文件只管"发请求 + 解析 + 掩码"；选哪一家、取哪个密钥、运行哪个程序由 agents.mjs 的 probeAgentModels 决定。
// 结果统一为 { ok, source, models, details, reason? }：source 是 'api' | 'program' | 'preset'；
// details 是 [{ id, name?, efforts?, defaultEffort? }]，只在查到时有；退回预设时 ok 为 false，reason 是中文原因。
// 密钥只出现在请求头里（经标准输入交给子进程，不进命令行），返回前所有密钥值一律替换成 ***。
import { spawn } from 'node:child_process';
import { allowedEnv } from './env.mjs';

export const PROBE_TIMEOUT_MS = 10000;
const BODY_LIMIT = 200;
const NON_CHAT = /asr|tts|voice|embed|whisper|image|rerank/i;

// 在子进程里发请求的脚本：Node 24 的 fetch 只有环境变量 NODE_USE_ENV_PROXY=1 时才读 HTTP(S)_PROXY，
// 所以请求放进子进程里发，子进程的环境带上代理变量。请求（地址、请求头、超时）从标准输入读，密钥不出现在命令行。
const CHILD = `
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', async () => {
  const { url, headers, timeoutMs } = JSON.parse(input);
  let out;
  try {
    const r = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    out = { status: r.status, text: (await r.text()).slice(0, 2000000) };
  } catch (e) {
    out = { error: e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout' : 'network', message: String(e && e.cause && (e.cause.code || e.cause.message) || e && e.message || e).slice(0, 200) };
  }
  process.stdout.write(JSON.stringify(out));
});
`;

// 子进程环境：执行者同款白名单（系统变量、代理、证书）加 NODE_USE_ENV_PROXY=1；调用方传入的 env 已含设置里的代理变量（cli.mjs 的 withProxy）。
// 不含任何密钥来源变量（sources）。ELECTRON_RUN_AS_NODE 让软件里的 Electron 也当 Node 用。
export function probeEnv(env, { sources = [] } = {}) {
  return { ...allowedEnv({ base: env, sources }), NODE_USE_ENV_PROXY: '1', ELECTRON_RUN_AS_NODE: '1' };
}

// 掩码：把 secrets 里的值（至少 4 个字符）全部换成 ***；对字符串、数组、对象递归。
export function maskSecrets(value, secrets) {
  const list = (secrets ?? []).filter(v => typeof v === 'string' && v.length >= 4).sort((a, b) => b.length - a.length);
  const walk = v => {
    if (typeof v === 'string') return list.reduce((s, secret) => s.split(secret).join('***'), v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value);
}

// 发一次 GET。返回 { status, text } 或 { error: 'timeout' | 'network' | 'spawn', message }。
export function fetchInChild(url, headers, { env, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return new Promise(resolve => {
    let stdout = '', settled = false, child;
    const done = value => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
    // 子进程自己会在 timeoutMs 后中止请求；这里多留 3 秒兜底（启动慢、卡死时强制结束）。
    const timer = setTimeout(() => { try { child?.kill(); } catch { /* 已退出 */ } done({ error: 'timeout' }); }, timeoutMs + 3000);
    try {
      child = spawn(process.execPath, ['-e', CHILD], { env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (error) { done({ error: 'spawn', message: error.message }); return; }
    child.on('error', error => done({ error: 'spawn', message: error.message }));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ url, headers, timeoutMs }), 'utf8');
    child.on('close', () => {
      try { done(JSON.parse(stdout)); } catch { done({ error: 'network', message: '请求没有返回结果' }); }
    });
  });
}

const seconds = ms => `${Math.round(ms / 100) / 10}`.replace(/\.0$/, '');
const excerpt = text => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, BODY_LIMIT);

// 把 { data: [...] } 形式的列表（OpenAI 格式，Anthropic 格式也一样）解析成 details；不是列表返回 null。
export function parseModelsBody(text) {
  let json;
  try { json = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(json?.data)) return null;
  const details = [];
  for (const item of json.data) {
    if (typeof item?.id !== 'string' || !item.id || NON_CHAT.test(item.id)) continue;
    const detail = { id: item.id };
    const name = item.display_name ?? item.name;
    if (typeof name === 'string' && name && name !== item.id) detail.name = name;
    // 有的接口带 effort.supported_levels / default_level（实测只有一家）；没有就不给 efforts。
    const levels = Array.isArray(item.effort?.supported_levels) ? item.effort.supported_levels.filter(l => typeof l === 'string' && l) : [];
    if (levels.length) {
      detail.efforts = levels;
      if (typeof item.effort.default_level === 'string' && item.effort.default_level) detail.defaultEffort = item.effort.default_level;
    }
    details.push(detail);
  }
  return details;
}

// 按顺序试地址，第一个 200 且格式对的为准。401 / 403 不再试后面的地址（换地址也一样没有权限）。
// 返回 { ok: true, details } 或 { ok: false, reason }。
export async function probeApi(urls, headers, { env, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  let reason = '这个执行者没有可查询的接口';
  for (const url of urls) {
    const r = await fetchInChild(url, headers, { env, timeoutMs });
    if (r.error === 'timeout') return { ok: false, reason: `${seconds(timeoutMs)} 秒没有响应，已停止` };
    if (r.error) { reason = `请求失败：${r.message ?? r.error}`; continue; }
    if (r.status === 200) {
      const details = parseModelsBody(r.text);
      if (!details) { reason = '接口返回的不是模型列表'; continue; }
      if (!details.length) { reason = '接口返回的列表里没有对话模型'; continue; }
      return { ok: true, details };
    }
    const body = excerpt(r.text);
    const auth = r.status === 401 || r.status === 403;
    reason = `接口返回 ${r.status}${auth ? '：密钥无效或没有权限' : ''}${body ? `${auth ? '（' : '：'}${body}${auth ? '）' : ''}` : ''}`;
    if (auth) break;
  }
  return { ok: false, reason };
}

// codex debug models 的输出：{ models: [{ slug, display_name, visibility, supported_reasoning_levels: [{ effort }], default_reasoning_level }] }；
// 只留 visibility 为 list 的。解析不出返回 null。
export function parseCodexModels(text) {
  let json;
  try { json = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(json?.models)) return null;
  const details = [];
  for (const item of json.models) {
    if (typeof item?.slug !== 'string' || !item.slug || item.visibility !== 'list') continue;
    const detail = { id: item.slug };
    if (typeof item.display_name === 'string' && item.display_name && item.display_name !== item.slug) detail.name = item.display_name;
    const levels = (Array.isArray(item.supported_reasoning_levels) ? item.supported_reasoning_levels : []).map(l => typeof l === 'string' ? l : l?.effort).filter(l => typeof l === 'string' && l);
    if (levels.length) {
      detail.efforts = levels;
      if (typeof item.default_reasoning_level === 'string' && item.default_reasoning_level) detail.defaultEffort = item.default_reasoning_level;
    }
    details.push(detail);
  }
  return details;
}

// 接口地址换成要试的列表地址：去掉末尾的 / 和 /anthropic（Anthropic 兼容地址），依次试 <地址>/models、<地址>/v1/models。
export function listUrls(baseUrl) {
  const base = String(baseUrl ?? '').trim().replace(/\/+$/, '').replace(/\/anthropic$/i, '');
  return /^https?:\/\/[^/\s]+/i.test(base) ? [`${base}/models`, `${base}/v1/models`] : null;
}

// 文字输出：查到时 / 退回预设时。presetEfforts 是预设的推理强度可选值（r.models 退回预设时就是预设的模型）。
export function formatProbe(r, { presetEfforts = [], programLabel = '程序的列表' } = {}) {
  if (r.source === 'preset') {
    return [`没有查到（${r.reason}），用预设的可选值：`, ...r.models.map(m => `  ${m}`), ...(presetEfforts.length ? [`推理强度：${presetEfforts.join(' / ')}`] : [])].join('\n');
  }
  const label = r.source === 'program' ? programLabel : '接口';
  const head = `模型（来自${/^\w/.test(label) ? ' ' : ''}${label}）：`;
  const lines = r.details.map(d => `  ${d.id}${d.efforts ? `  推理强度：${d.efforts.join(' / ')}${d.defaultEffort ? `（默认 ${d.defaultEffort}）` : ''}` : ''}`);
  return [head, ...lines].join('\n');
}
