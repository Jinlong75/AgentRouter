// 读 JSON 的小工具（零依赖）：容忍文本开头的 UTF-8 BOM（协议第 4 节"编码（Stage05 起）"）。
// 原因：Windows PowerShell 5.1 的 Set-Content -Encoding utf8 / Out-File 会写出 BOM（EF BB BF），
// JSON.parse 遇到开头的 U+FEFF 会抛错，用户或工具改过的配置因此被判为"不是 JSON"（058 事故）。
// 写文件的行为不变：核心与软件一律写无 BOM 的 UTF-8。
import { readFileSync } from 'node:fs';

// 开头的 BOM（U+FEFF）去掉一个再交给 JSON.parse；其余内容、解析失败的错误都原样处理。
export function parseJson(text) {
  const source = typeof text === 'string' ? text : String(text ?? '');
  return JSON.parse(source.charCodeAt(0) === 0xfeff ? source.slice(1) : source);
}

// 读文件再按 parseJson 解析；读取失败（ENOENT 等）的错误原样抛出，由调用方处理。
export function readJson(file) {
  return parseJson(readFileSync(file, 'utf8'));
}
