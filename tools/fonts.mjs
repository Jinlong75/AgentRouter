import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const fontFile = 'build/fonts/MiSansVF.ttf';
export const fontHash = '5daf8d5447bfd423cfdec94a0e07c53b205892223ccc6ea21b7b8a37248b44d9';
export const downloadPage = 'https://hyperos.mi.com/font/download';
export async function checkFont(file = fontFile) {
  const bytes = await readFile(file);
  if (createHash('sha256').update(bytes).digest('hex') !== fontHash) throw Error('MiSans SHA-256 不符');
  return bytes;
}
// 只读取 ZIP 中指定的文件，不把压缩包里的路径写入文件系统。
function zipDirectory(bytes, offset = 0) {
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0 || bytes.readUInt32LE(end) !== 0x06054b50) throw Error('官方字体包不是有效的 ZIP');
  let at = bytes.readUInt32LE(end + 16) - offset;
  if (at < 0) throw Error('官方字体包目录超过读取范围');
  const entries = [];
  for (let i = 0; i < bytes.readUInt16LE(end + 10); i++) {
    if (bytes.readUInt32LE(at) !== 0x02014b50) throw Error('ZIP 目录无效');
    const length = bytes.readUInt16LE(at + 28), name = bytes.subarray(at + 46, at + 46 + length).toString('utf8');
    entries.push({ name, local: bytes.readUInt32LE(at + 42), size: bytes.readUInt32LE(at + 20), method: bytes.readUInt16LE(at + 10) });
    at += 46 + length + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
  }
  return entries;
}
function unpack(bytes, method) {
  if (method === 0) return bytes;
  if (method === 8) return inflateRawSync(bytes);
  throw Error('官方字体包使用了不支持的压缩方式');
}
function zipEntry(bytes, pattern) {
  const entry = zipDirectory(bytes).find(e => pattern.test(e.name));
  if (!entry) throw Error('官方包没有所需的字体文件');
  const start = entry.local + 30 + bytes.readUInt16LE(entry.local + 26) + bytes.readUInt16LE(entry.local + 28);
  return unpack(bytes.subarray(start, start + entry.size), entry.method);
}
async function request(url, headers) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw Error(`HTTP ${response.status}: ${url}`);
  return response;
}
async function remoteEntry(url, pattern) {
  // 官方包很大；支持 Range 时仅下载中央目录及所需条目。
  const tail = await request(url, { Range: 'bytes=-65557' });
  const bytes = Buffer.from(await tail.arrayBuffer());
  if (tail.status === 200) return zipEntry(bytes, pattern);
  const offset = Number(tail.headers.get('content-range')?.match(/^bytes (\d+)-/)?.[1]);
  if (!Number.isFinite(offset)) throw Error('官方下载返回了无效的范围');
  const entry = zipDirectory(bytes, offset).find(e => pattern.test(e.name));
  if (!entry) throw Error('官方包没有所需的字体文件');
  const headerResponse = await request(url, { Range: `bytes=${entry.local}-${entry.local + 29}` });
  if (headerResponse.status !== 206) { await headerResponse.body.cancel(); throw Error('官方下载不再支持范围读取'); }
  const header = Buffer.from(await headerResponse.arrayBuffer());
  if (header.readUInt32LE(0) !== 0x04034b50) throw Error('ZIP 文件头无效');
  const start = entry.local + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  const response = await request(url, { Range: `bytes=${start}-${start + entry.size - 1}` });
  if (response.status !== 206) { await response.body.cancel(); throw Error('官方下载不再支持范围读取'); }
  return unpack(Buffer.from(await response.arrayBuffer()), entry.method);
}
export async function prepareFont() {
  const html = await (await request(downloadPage)).text();
  let source = html;
  for (const match of html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)) {
    const url = new URL(match[1], downloadPage);
    if (url.hostname === 'hyperos.mi.com') source += await (await request(url)).text();
  }
  const match = [...source.matchAll(/["']([^"']*MiSans(?:%20| )[Vv][Ff][^"']*\.ttf|[^"']*MiSans\.zip)["']/g)][0];
  // 当前官方页面用 origin + 下载目录 + downloadLink 动态生成地址。
  const directory = source.match(/window\.location\.origin\+["']([^"']+)["']/)?.[1];
  const dynamic = directory && /downloadLink:["']MiSans["']/.test(source) && source.includes('.concat(e.downloadLink,".zip")') ? `${directory}/MiSans.zip` : null;
  if (!match && !dynamic) throw Error('官方下载页未提供可识别的 MiSans 包，请检查站点变更');
  let url = new URL(match?.[1] || dynamic, downloadPage);
  const fontPattern = /(?:^|\/)MiSans ?VF\.ttf$/;
  let bytes = url.pathname.endsWith('.ttf') ? Buffer.from(await (await request(url)).arrayBuffer()) : await remoteEntry(url, fontPattern);
  if (createHash('sha256').update(bytes).digest('hex') !== fontHash && directory && source.includes('/MiSans_Global_ALL.zip')) {
    console.log('单独下载包的字体版本已变化，检查同页官方全量包中的指定版本。');
    url = new URL(`${directory}/MiSans_Global_ALL.zip`, downloadPage);
    bytes = zipEntry(await remoteEntry(url, /(?:^|\/)MiSans\.zip$/), fontPattern);
  }
  if (createHash('sha256').update(bytes).digest('hex') !== fontHash) throw Error('字体版本的 SHA-256 与定稿不一致，拒绝使用');
  await mkdir(path.dirname(fontFile), { recursive: true });
  await writeFile(fontFile, bytes);
  console.log(JSON.stringify({ source: String(url), version: '4.003', sha256: fontHash, bytes: bytes.length }));
}
// 字标字体 Space Grotesk（SIL OFL 1.1）：从 Google Fonts 官方仓库的固定提交下载，核对 SHA-256；仓库里不放字体文件。
export const brandFontFile = 'build/fonts/SpaceGrotesk.ttf';
export const brandFontHash = 'acad6de1fc93436f5c0f1f4137751ef04f1aea3063e7036535970ffcfbd79f72';
export const brandFontSource = 'https://raw.githubusercontent.com/google/fonts/00a38a53f92aef923b9353f40128e8f4552ddae4/ofl/spacegrotesk/SpaceGrotesk%5Bwght%5D.ttf';
export async function checkBrandFont(file = brandFontFile) {
  const bytes = await readFile(file);
  if (createHash('sha256').update(bytes).digest('hex') !== brandFontHash) throw Error('Space Grotesk SHA-256 不符');
  return bytes;
}
export async function prepareBrandFont() {
  const bytes = Buffer.from(await (await request(brandFontSource)).arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== brandFontHash) throw Error('Space Grotesk 的 SHA-256 与定稿不一致，拒绝使用');
  await mkdir(path.dirname(brandFontFile), { recursive: true });
  await writeFile(brandFontFile, bytes);
  console.log(JSON.stringify({ source: brandFontSource, sha256: brandFontHash, bytes: bytes.length }));
}
export async function copyBrandFont(out, source = brandFontFile) {
  const target = path.join(out, 'fonts', 'SpaceGrotesk.ttf');
  try { const bytes = await checkBrandFont(source); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes); return true; }
  catch (error) { await rm(target, { force: true }); console.warn(`警告：Space Grotesk 字体缺失或 SHA-256 不符，字标使用系统字体；运行 npm run fonts。${error.code || error.message}`); return false; }
}
export async function copyFont(out, source = fontFile) {
  const target = path.join(out, 'fonts', 'MiSansVF.ttf');
  try { const bytes = await checkFont(source); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes); return true; }
  catch (error) { await rm(target, { force: true }); console.warn(`警告：MiSans 字体缺失或 SHA-256 不符，使用系统字体；运行 npm run fonts。${error.code || error.message}`); return false; }
}
// 默认的字体清单：file 是相对输出根目录的路径，download 是联网下载（成功时写入当前目录下的 file）。
export const defaultFonts = () => [
  { name: 'MiSans', file: fontFile, hash: fontHash, download: prepareFont },
  { name: 'Space Grotesk', file: brandFontFile, hash: brandFontHash, download: prepareBrandFont },
];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
// 读文件并核对 SHA-256；文件不存在、读不了或哈希不符都返回 null。
async function readVerified(file, hash) {
  try { const bytes = await readFile(file); return sha256(bytes) === hash ? bytes : null; }
  catch { return null; }
}
const samePlace = (a, b) => {
  const [x, y] = [path.resolve(a), path.resolve(b)];
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
};
// 每个字体依次：out 下已有且 SHA-256 正确 → 跳过；base 下有且正确 → 复制到 out；否则联网下载。
// 只读 base，不往里面写任何东西；base 与 out 是同一个目录时不会自己复制给自己。
// 返回 [{ name, action: 'existing' | 'copied' | 'downloaded' }]；有字体下载失败时全部处理完后抛出带中文原因的错误。
export async function copyFontsFromBase({ base = process.env.AR_BASE_REPO, out = process.cwd(), fonts = defaultFonts(), log = console.log } = {}) {
  const results = [];
  const failures = [];
  const hasBase = typeof base === 'string' && base !== '' && !samePlace(base, out);
  for (const { name, file, hash, download } of fonts) {
    const target = path.join(out, file);
    if (await readVerified(target, hash)) {
      log(`${name}：已有（SHA-256 一致）`);
      results.push({ name, action: 'existing' });
      continue;
    }
    let reason = '';
    if (hasBase) {
      const bytes = await readVerified(path.join(base, file), hash);
      if (bytes) {
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, bytes);
        log(`${name}：从主工作区复制（SHA-256 一致）`);
        results.push({ name, action: 'copied' });
        continue;
      }
      reason = '（主工作区没有这个字体或 SHA-256 不符）';
    }
    try {
      log(`${name}：联网下载${reason}`);
      await download();
      results.push({ name, action: 'downloaded' });
    } catch (error) {
      failures.push(`${name}：联网下载失败（${error.message}）`);
    }
  }
  if (failures.length) throw Error(failures.join('；'));
  return results;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--from-base')) {
    try { await copyFontsFromBase(); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  } else { await prepareFont(); await prepareBrandFont(); }
}
