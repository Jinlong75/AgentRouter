import fs from 'node:fs/promises';
import path from 'node:path';

export async function preserveFailures(shotsDir, { now = new Date(), keep = 10 } = {}) {
  const source = path.join(shotsDir, 'failures');
  let entries;
  try { entries = await fs.readdir(source); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!entries.length) { await fs.rmdir(source); return null; }

  // 时间戳使用 UTC，名称按字典序排列。
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace('T', '-').replace('.', '-').replace('Z', '');
  const base = `failures-${stamp}`;
  let name = base, suffix = 2;
  for (;;) {
    try { await fs.lstat(path.join(shotsDir, name)); }
    catch (error) { if (error.code === 'ENOENT') break; throw error; }
    name = `${base}-${suffix++}`;
  }
  const target = path.join(shotsDir, name);
  await fs.rename(source, target);
  const archives = (await fs.readdir(shotsDir, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && entry.name.startsWith('failures-'))
    .map(entry => entry.name).sort();
  for (const old of archives.slice(0, Math.max(0, archives.length - keep))) {
    await fs.rm(path.join(shotsDir, old), { recursive: true, force: true });
  }
  return target;
}
