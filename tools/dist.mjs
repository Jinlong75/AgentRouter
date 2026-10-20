import { checkFont, checkBrandFont } from './fonts.mjs';

// 安装包必须带上两种随包字体；缺失或哈希不符时在构建前失败。
try { await checkFont(); }
catch { console.error('MiSans 字体缺失或 SHA-256 不符，请运行 npm run fonts。'); process.exit(1); }
try { await checkBrandFont(); }
catch { console.error('Space Grotesk 字体缺失或 SHA-256 不符，请运行 npm run fonts。'); process.exit(1); }
// 禁止自动发现本机证书，发行包明确不签名。
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
await import('./build.mjs');
const { build, Platform, Arch } = await import('electron-builder');
await build({ targets: Platform.WINDOWS.createTarget('nsis', Arch.x64), config: 'electron-builder.config.cjs' });
