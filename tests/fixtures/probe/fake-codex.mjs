// 假的 codex（ar agents models --probe 的测试用）：只认 debug models，打印和真实输出同样结构的 JSON（模型是编造的）。
// 参数不是 debug models 时以 2 退出；hidden 那一项 visibility 是 hide，探针要把它去掉。
const args = process.argv.slice(2);
if (args.join(' ') !== 'debug models') { console.error(`unexpected args: ${args.join(' ')}`); process.exit(2); }
const level = effort => ({ effort, description: effort });
console.log(JSON.stringify({
  models: [
    { slug: 'test-pro', display_name: 'Test Pro', visibility: 'list', default_reasoning_level: 'medium', supported_reasoning_levels: ['low', 'medium', 'high', 'max'].map(level) },
    { slug: 'test-mini', display_name: 'Test Mini', visibility: 'list', default_reasoning_level: 'low', supported_reasoning_levels: [level('low'), level('medium')] },
    { slug: 'test-hidden', display_name: 'Test Hidden', visibility: 'hide', default_reasoning_level: 'low', supported_reasoning_levels: [level('low')] },
  ],
}));
