import { nativeTheme } from 'electron';
import type { Harness } from './shots-input';
import { c } from '../shared/copy';

export async function captureControlContrast(h: Harness) {
    const { press, wait, check, evaluate, pause } = h;
    // 逐层合成祖先背景，再计算 WCAG 相对亮度。
    const contrast = async (selector: string, theme: string) => {
        const result = await evaluate(String.raw`(() => {
            const elements = [...document.querySelectorAll(".toggle:not(.on), .cb:not(.on), .rd:not(.on)")].filter(el => {
                const r = el.getBoundingClientRect(), s = getComputedStyle(el);
                return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth && s.visibility === 'visible' && s.display !== 'none';
            });
            const rgba = color => {
                color = color.trim();
                const hex = color.match(/^#([\da-f]{3}|[\da-f]{6})$/i);
                if (hex) { const h = hex[1].length === 3 ? [...hex[1]].map(c => c + c).join('') : hex[1]; return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)).concat(1); }
                const m = color.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i);
                return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])] : null;
            };
            const lum = rgb => rgb.slice(0, 3).map(v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
            const failures = elements.map(el => {
                const style = getComputedStyle(el), border = rgba(style.borderTopColor);
                const layers = []; let parent = el.parentElement;
                while (parent) { const color = rgba(getComputedStyle(parent).backgroundColor); if (color && color[3] > 0) layers.push(color); if (color && color[3] === 1) break; parent = parent.parentElement; }
                let bg = rgba(getComputedStyle(document.documentElement).getPropertyValue('--bg'));
                if (bg && bg[3] !== 1) bg = null;
                for (const color of layers.reverse()) {
                    if (color[3] === 1) bg = color;
                    else if (bg) bg = color.slice(0, 3).map((v, i) => v * color[3] + bg[i] * (1 - color[3])).concat(1);
                }
                const a = border && border[3] === 1 ? lum(border) : null, b = bg ? lum(bg) : null;
                const ratio = a !== null && b !== null ? (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) : null;
                if (parseFloat(style.borderTopWidth) > 0 && ratio !== null && ratio >= 3) return null;
                return { selector: el.matches('.toggle:not(.on)') ? '.toggle:not(.on)' : el.matches('.cb:not(.on)') ? '.cb:not(.on)' : '.rd:not(.on)', classes: el.className, borderTopWidth: style.borderTopWidth, borderTopColor: style.borderTopColor, background: bg, ratio };
            }).filter(Boolean);
            return { found: elements.some(el => el.matches(${JSON.stringify(selector)})), failures };
        })()`);
        await check(`控件边界对比度不足：${theme} ${selector} ${JSON.stringify(result)}`, JSON.stringify(result.found && result.failures.length === 0));
    };
    try {
        for (const theme of ['light', 'dark'] as const) {
            nativeTheme.themeSource = theme;
            await wait(`document.documentElement.dataset.theme === '${theme}'`, `切换到${theme}主题`);
            await press('[data-page=tasks]'); await wait('!!document.querySelector("[data-task=t1]")');
            await press('[data-task=t1]'); await wait('!!document.querySelector("[data-think]")');
            await check('思考开关初始关闭', '!document.querySelector("[data-think]").classList.contains("on") && !document.querySelector(".k-think")');
            await contrast('.toggle:not(.on)', theme);
            await press('[data-think]');
            await check('思考开关打开并显示思考内容', 'document.querySelector("[data-think]").classList.contains("on") && document.querySelector("[data-think]").getAttribute("aria-checked") === "true" && !!document.querySelector(".k-think")');
            await press('[data-think]');
            await check('思考开关关闭并隐藏思考内容', '!document.querySelector("[data-think]").classList.contains("on") && !document.querySelector(".k-think")');
            await press('[data-task=t13]'); await press('[data-more]');
            const index = await evaluate(`(() => { const items = [...document.querySelectorAll('.ctx button')]; items.forEach((b, i) => b.setAttribute('data-menu-index', String(i))); return items.findIndex(b => b.textContent.trim() === ${JSON.stringify(c.deleteOne)}); })()`);
            await check('删除菜单项存在', `${index} >= 0`);
            await press(`.ctx button[data-menu-index="${index}"]`); await wait('!!document.querySelector("[data-delete-files] .cb")');
            await contrast('.choice .cb:not(.on)', theme);
            await h.key('Escape');
            await press('[data-page=connect]'); await wait('!!document.querySelector(".page-h [data-import-agent]")');
            await press('.page-h [data-import-agent]'); await wait('!!document.querySelector(".sheet .preset .rd:not(.on)")');
            await pause(); await contrast('.rd:not(.on)', theme);
            await h.key('Escape');
        }
    } finally { nativeTheme.themeSource = 'dark'; }
}
