// 退出诊断：记录退出各阶段（窗口 close/closed、before-quit、will-quit、quit）与每个清理步骤的开始、完成、耗时和错误。
// AR_QUIT_TRACE=1 时实时打印到 stderr；不论是否开启，清理超过 5 秒仍未完成时打印尚未完成的步骤，
// 清理全部完成后进程仍未退出时打印仍活跃的资源。只做诊断，不强制退出、不吞掉错误。
const live = process.env.AR_QUIT_TRACE === '1';
const lines: string[] = [];
const pending = new Map<string, number>();
let started = 0;

const stamp = () => new Date().toISOString().slice(11, 23);
const elapsed = () => started ? ` +${Date.now() - started}ms` : '';
function print(text: string) { console.error(`[退出诊断 ${stamp()} pid=${process.pid}${elapsed()}] ${text}`); }

export function quitEvent(text: string) {
    lines.push(`${stamp()} ${text}`);
    if (live) print(text);
}

// 包装一个清理步骤：开始、完成（耗时）、出错（原因）都记下；返回的 Promise 不吞错误。
export function quitStep<T>(name: string, work: Promise<T> | T | undefined): Promise<T | undefined> {
    const at = Date.now();
    pending.set(name, at);
    quitEvent(`开始：${name}`);
    return Promise.resolve(work).then(value => {
        pending.delete(name); quitEvent(`完成：${name}（${Date.now() - at}ms）`); return value;
    }, error => {
        pending.delete(name); quitEvent(`出错：${name}（${Date.now() - at}ms）：${error instanceof Error ? error.message : String(error)}`);
        throw error;
    });
}

// 退出开始时调用：5 秒、15 秒、30 秒检查一次；计时器 unref，不会自己拖住进程。
export function quitWatchdog() {
    started = Date.now();
    for (const ms of [5000, 15000, 30000]) setTimeout(() => {
        if (pending.size) {
            print(`退出已进行 ${ms / 1000} 秒，仍未完成的清理步骤：${[...pending].map(([name, at]) => `${name}（已等 ${Date.now() - at}ms）`).join('、')}`);
            print(`退出过程记录：\n  ${lines.join('\n  ')}`);
        } else {
            print(`退出已进行 ${ms / 1000} 秒，清理步骤都已完成，但进程仍在；仍活跃的资源：${process.getActiveResourcesInfo().join(', ') || '无'}`);
            print(`退出过程记录：\n  ${lines.join('\n  ')}`);
        }
    }, ms).unref();
}
