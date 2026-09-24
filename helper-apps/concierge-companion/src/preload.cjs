const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('companion', {
    state: () => ipcRenderer.invoke('companion:state'),
    approve: () => ipcRenderer.invoke('companion:approve'),
    cancel: () => ipcRenderer.invoke('companion:cancel'),
    files: () => ipcRenderer.invoke('companion:files'),
    open: () => ipcRenderer.invoke('companion:open'),
    pause: () => ipcRenderer.invoke('companion:pause'),
    update: () => ipcRenderer.invoke('companion:update'),
    pair: (value) => ipcRenderer.invoke('companion:pair', value),
    add: (value) => ipcRenderer.invoke('companion:add', value),
    remove: (id) => ipcRenderer.invoke('companion:remove', id),
    import: () => ipcRenderer.invoke('companion:import'),
    onState: (listener) => {
        ipcRenderer.on('companion:state', (_event, value) => listener(value));
    },
});
