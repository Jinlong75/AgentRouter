import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const lineAt = (source, offset) => source.slice(0, offset).split('\n').length;

// 用空格替换注释，保留偏移量和换行，避免改变诊断位置。
function withoutComments(source) {
    const result = source.split('');
    let quote = '';
    for (let i = 0; i < source.length; i++) {
        if (quote) {
            if (source[i] === '\\') i++;
            else if (source[i] === quote) quote = '';
        } else if (source[i] === "'" || source[i] === '"' || source[i] === '`') {
            quote = source[i];
        } else if (source[i] === '/' && (source[i + 1] === '/' || source[i + 1] === '*')) {
            const block = source[i + 1] === '*';
            result[i] = result[i + 1] = ' ';
            i += 2;
            for (; i < source.length; i++) {
                if (block && source[i] === '*' && source[i + 1] === '/') {
                    result[i] = result[i + 1] = ' ';
                    i++;
                    break;
                }
                if (!block && (source[i] === '\n' || source[i] === '\r')) break;
                if (source[i] !== '\n' && source[i] !== '\r') result[i] = ' ';
            }
        }
    }
    return result.join('');
}

function baseline(source, file) {
    source = withoutComments(source);
    const match = /export\s+const\s+UI_BASELINE\s*=\s*\[([\s\S]*?)\]\s+as\s+const/.exec(source);
    assert.ok(match, `${file}: 未找到 UI_BASELINE`);
    const entries = [];
    const pattern = /(['"`])(UI\d{2})\1/g;
    for (const item of match[1].matchAll(pattern)) {
        entries.push({ id: item[2], file, line: lineAt(source, match.index + match[0].indexOf(match[1]) + item.index) });
    }
    assert.ok(entries.length, `${file}: 清单为空`);
    return entries;
}

function checks(source, file) {
    source = withoutComments(source);
    const entries = [];
    const pattern = /\b(?:check|verify)\s*\(\s*(['"`])(UI\d{2})/g;
    for (const item of source.matchAll(pattern)) {
        entries.push({ id: item[2], file, line: lineAt(source, item.index) });
    }
    return entries;
}

function validate(list, found) {
    const errors = [];
    const ids = new Set(list.map(entry => entry.id));
    const checked = new Set(found.map(entry => entry.id));
    for (const entry of found) if (!ids.has(entry.id)) errors.push(`检查多出 ${entry.id} ${entry.file}:${entry.line}`);
    for (const entry of list) if (!checked.has(entry.id)) errors.push(`检查缺少 ${entry.id} ${entry.file}:${entry.line}`);
    for (let i = 1; i < list.length; i++) {
        if (list[i - 1].id >= list[i].id) errors.push(`清单重复或未升序 ${list[i].id} ${list[i].file}:${list[i].line}`);
    }
    assert.deepEqual(errors, [], errors.join('\n'));
}

test('仓库界面检查编号与基线一致', () => {
    const dir = path.join(root, 'app/src/main');
    const list = baseline(readFileSync(path.join(dir, 'shots-baseline.ts'), 'utf8'), 'app/src/main/shots-baseline.ts');
    const found = readdirSync(dir).filter(name => /^shots.*\.ts$/.test(name)).flatMap(name =>
        checks(readFileSync(path.join(dir, name), 'utf8'), `app/src/main/${name}`));
    validate(list, found);
});

test('识别多余检查和三种引号，包括模板插值', () => {
    const list = baseline("export const UI_BASELINE = ['UI01', 'UI05'] as const;", 'list.ts');
    const found = checks('check("UI01 a", x);\nverify(`UI05 ${value}`, x);\ncheck(\'UI99 extra\', x);', 'fake.ts');
    assert.deepEqual(found.map(x => x.id), ['UI01', 'UI05', 'UI99']);
    assert.throws(() => validate(list, found), /检查多出 UI99 fake\.ts:3/);
});

test('清单缺 UI05 时指出检查位置', () => {
    const list = baseline("export const UI_BASELINE = ['UI01'] as const;", 'list.ts');
    assert.throws(() => validate(list, checks("check('UI01', x);\nverify('UI05', x);", 'fake.ts')), /检查多出 UI05 fake\.ts:2/);
});

test('清单中的检查被删光时指出清单位置', () => {
    const list = baseline("export const UI_BASELINE = ['UI01',\n'UI05'] as const;", 'list.ts');
    assert.throws(() => validate(list, checks("check('UI01', x);", 'fake.ts')), /检查缺少 UI05 list\.ts:2/);
});

test('注释里的检查不计入覆盖，字符串里的斜杠保留', () => {
    const list = baseline("export const UI_BASELINE = ['UI01', 'UI05'] as const;", 'list.ts');
    for (const comment of ["// check('UI05', x);", "/* check('UI05', x); */", "const x = 1; // check('UI05', x);"]) {
        const found = checks(`check('UI01 http://example.test', x);\n${comment}`, 'fake.ts');
        assert.deepEqual(found.map(entry => entry.id), ['UI01']);
        assert.throws(() => validate(list, found), /检查缺少 UI05 list\.ts:1/);
    }
    assert.deepEqual(checks('check("UI01 http://example.test", x); verify(`UI05 http://example.test`, x);', 'fake.ts').map(entry => entry.id), ['UI01', 'UI05']);
});

test('清单重复或未升序时报错', () => {
    const found = checks("check('UI01', x); check('UI05', x);", 'fake.ts');
    for (const text of ["['UI01', 'UI05', 'UI05']", "['UI05', 'UI01']"]) {
        assert.throws(() => validate(baseline(`export const UI_BASELINE = ${text} as const;`, 'list.ts'), found), /清单重复或未升序/);
    }
});
