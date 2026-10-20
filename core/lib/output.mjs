// 命令输出截断（所有适配器共用）：前 200 行、最多 16KB，截在完整字符上。
export function limitOutput(output) {
  const bytes = Buffer.from(output.split('\n').slice(0, 200).join('\n'));
  const limited = bytes.subarray(0, 16384).toString('utf8').replace(/�$/, '');
  return { output: limited, truncated: limited.length < output.length };
}
