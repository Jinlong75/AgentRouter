// 有界并发：同时最多 limit 个任务在途，结果按输入顺序返回（与完成顺序无关）。
// 约定：某个任务 reject 时不再启动新任务，等在途任务结束后把最先出现的那个错误抛给调用方；
// 已在途任务的错误不会再被抛第二次（避免留下未处理的 rejection）。

export async function mapLimit(items, limit, fn) {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`并发上限必须是正整数：${limit}`);
  const results = new Array(items.length);
  let next = 0, failure = null;
  const worker = async () => {
    while (failure === null) {
      const index = next++;
      if (index >= items.length) return;
      try { results[index] = await fn(items[index], index); }
      catch (error) { if (failure === null) failure = { error }; }
    }
  };
  // 项目比上限少时只开项目数个 worker，不会空转。
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure !== null) throw failure.error;
  return results;
}
