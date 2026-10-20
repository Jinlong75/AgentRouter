import { contextBridge, ipcRenderer } from 'electron';
import type { API, Snapshot } from '../shared/types';
const api: API = { preferences: async (action, payload) => {
    const result = await ipcRenderer.invoke('preferences', action, payload);
    if (!result.ok) throw Error(result.error);
    return result.value;
}, console: async (action, payload) => {
    const result = await ipcRenderer.invoke('console', action, payload);
    if (!result.ok) {
        // contextBridge 跨进程只保留 Error 的标准属性（message / stack），挂在 Error 上的自定义 code 会丢。
        // 因此抛一个带 message 和 code 的普通对象：渲染层统一用 message 显示，用 code 区分"没有提交身份"等情况。
        throw { name: 'Error', message: String(result.error), ...(typeof result.code === 'string' && result.code ? { code: result.code } : {}) };
    }
    return result.value;
}, snapshot: () => ipcRenderer.invoke('snapshot'), detail: id => ipcRenderer.invoke('detail', id), events: (id, cursor, before) => ipcRenderer.invoke('events', id, cursor, before), action: (id, action, value) => ipcRenderer.invoke('action', id, action, value), deleteTasks: (ids, files) => ipcRenderer.invoke('delete-tasks', ids, files), import: () => ipcRenderer.invoke('import'), subscribe(callback) { const listener = (_event: unknown, s: Snapshot) => callback(s); ipcRenderer.on('snapshot', listener); return () => ipcRenderer.removeListener('snapshot', listener); }, closeReady: () => ipcRenderer.invoke('close-ready'), closeChoice: (action, remember) => ipcRenderer.invoke('close-choice', action, remember), closeShown: () => ipcRenderer.invoke('close-shown'), onCloseRequest(callback) { const listener = () => callback(); ipcRenderer.on('close-request', listener); return () => ipcRenderer.removeListener('close-request', listener); } };
contextBridge.exposeInMainWorld('dock', api);
