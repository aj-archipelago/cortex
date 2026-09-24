import {
    app,
    BrowserWindow,
    ipcMain,
    Menu,
    Tray,
    nativeImage,
    safeStorage,
    shell,
    dialog,
} from 'electron';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { hostname } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { startCompanion, serviceOrigin, validateServers } from './runtime.js';
import {
    inspectHandoff,
    parseHandoff,
    pairedConfiguration,
} from './pairing.js';
import { startUpdates } from './updates.js';
import electronUpdater from 'electron-updater';

const directory = path.dirname(fileURLToPath(import.meta.url));
const settingsUrl = pathToFileURL(path.join(directory, 'settings.html')).href;
let window;
let tray;
let runtime;
let config = { conciergeUrl: '', servers: [] };
let status = 'unpaired';
let pairing;
let pairingTimer;
let quitting = false;
let saving = false;
let handoff;
let setupError;
let queuedLink = process.argv.find((arg) =>
    arg.startsWith('concierge-companion:'),
);
let initialized = false;
let updates;
let updateStatus = 'unavailable';
const storePath = () => path.join(app.getPath('userData'), 'connection.enc');

async function save() {
    if (
        !safeStorage.isEncryptionAvailable() ||
        safeStorage.getSelectedStorageBackend?.() === 'basic_text'
    ) {
        throw new Error(
            'Enable your operating system keychain to save the connection',
        );
    }
    const temp = `${storePath()}.tmp`;
    await writeFile(temp, safeStorage.encryptString(JSON.stringify(config)), {
        mode: 0o600,
    });
    await rename(temp, storePath());
}
function publicState() {
    return {
        conciergeUrl: config.conciergeUrl,
        account: config.account,
        servers: config.servers.map(({ id, name, type, url, folders }) => ({
            id,
            name,
            type,
            url,
            folders,
        })),
        status,
        code: pairing?.code,
        locale: app.getLocale(),
        setupError,
        updateStatus,
        handoff: handoff && {
            site: handoff.conciergeUrl,
            account: handoff.account,
            kind: handoff.kind,
            server: handoff.server && {
                name: handoff.server.name,
                url: handoff.server.url,
            },
        },
    };
}
function notify() {
    window?.webContents.send('companion:state', publicState());
    updateMenu();
}
function showSettings() {
    if (window) {
        window.show();
        window.focus();
        return;
    }
    window = new BrowserWindow({
        width: 460,
        height: 650,
        minWidth: 360,
        minHeight: 500,
        title: 'Concierge Companion',
        backgroundColor: '#101827',
        webPreferences: {
            preload: path.join(directory, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.on('close', (event) => {
        if (!quitting) {
            event.preventDefault();
            window.hide();
        }
    });
    window.on('closed', () => {
        window = null;
    });
    window.loadURL(settingsUrl);
}
async function start() {
    await runtime?.stop();
    runtime = null;
    if (!config.token) {
        status = 'unpaired';
        notify();
        return;
    }
    runtime = startCompanion({
        relayUrl: config.relayUrl,
        token: config.token,
        servers: config.servers,
        onStatus(value) {
            status = value;
            notify();
        },
    });
}
const phrase = (en, ar) => (app.getLocale().startsWith('ar') ? ar : en);
function updateMenu() {
    if (!tray) return;
    const labels = {
        connected: ['Connected', 'متصل'],
        connecting: ['Connecting…', 'جارٍ الاتصال…'],
        unpaired: ['Ready to connect', 'جاهز للاتصال'],
        pairing: ['Waiting for approval', 'بانتظار الموافقة'],
        offline: ['Reconnecting…', 'جارٍ إعادة الاتصال…'],
        paused: ['Paused', 'متوقف مؤقتاً'],
        locked: ['Unlock your keychain', 'افتح سلسلة المفاتيح'],
    };
    const statusLabel = phrase(...(labels[status] || labels.unpaired));
    tray.setToolTip(`Concierge Companion — ${statusLabel}`);
    tray.setContextMenu(
        Menu.buildFromTemplate([
            { label: 'Concierge Companion', enabled: false },
            {
                label: statusLabel,
                enabled: false,
            },
            { label: phrase('Settings…', 'الإعدادات…'), click: showSettings },
            {
                label:
                    status === 'paused'
                        ? phrase('Resume', 'استئناف')
                        : phrase('Pause', 'إيقاف مؤقت'),
                click: async () => {
                    if (status === 'paused') await start();
                    else await runtime?.stop();
                },
            },
            { type: 'separator' },
            { label: phrase('Quit', 'إنهاء'), click: () => app.quit() },
        ]),
    );
}
async function request(origin, endpoint, options = {}) {
    const response = await fetch(new URL(endpoint, origin), {
        ...options,
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
        throw new Error(
            response.status === 410
                ? 'Setup link expired. Return to Concierge and select Connect this computer again.'
                : 'Could not connect. Return to Concierge and try again.',
        );
    return { status: response.status, data: await response.json() };
}
function handle(name, fn) {
    ipcMain.handle(`companion:${name}`, async (event, ...args) => {
        if (
            event.senderFrame !== window?.webContents.mainFrame ||
            event.senderFrame.url !== settingsUrl
        )
            throw new Error('Settings window required');
        try {
            return { value: await fn(...args) };
        } catch (error) {
            return { error: error.message };
        }
    });
}
handle('state', () => publicState());
async function receiveLink(value) {
    let acquired = false;
    try {
        parseHandoff(value, !app.isPackaged);
        if (!initialized) {
            queuedLink = value;
            return;
        }
        showSettings();
        if (saving)
            throw new Error(
                'Please wait for the current change, then open the connection again',
            );
        saving = true;
        acquired = true;
        setupError = null;
        // Never replace an approval while the user is reviewing it.
        if (handoff)
            throw new Error('Approve or cancel the current connection first');
        handoff = await inspectHandoff(value, {
            request,
            development: !app.isPackaged,
        });
    } catch (error) {
        setupError = error.message;
    } finally {
        if (acquired) saving = false;
        if (initialized) notify();
    }
}
async function chooseFolders() {
    const result = await dialog.showOpenDialog(window, {
        title: app.getLocale().startsWith('ar')
            ? 'اختر مجلدات تسمح لConcierge بقراءة ملفاتها وتعديلها'
            : 'Choose folders Concierge can read and edit',
        properties: ['openDirectory', 'multiSelections'],
        buttonLabel: app.getLocale().startsWith('ar')
            ? 'السماح بالوصول'
            : 'Allow access',
    });
    if (result.canceled || !result.filePaths.length) return null;
    return {
        id: crypto.randomUUID(),
        name: result.filePaths
            .map((p) => path.basename(p) || p)
            .join(', ')
            .slice(0, 100),
        type: 'files',
        folders: result.filePaths,
    };
}
handle('approve', async () => {
    if (saving || !handoff)
        throw new Error('Open the connection from Concierge again');
    saving = true;
    try {
        if (
            !safeStorage.isEncryptionAvailable() ||
            safeStorage.getSelectedStorageBackend?.() === 'basic_text'
        )
            throw new Error(
                'Enable your operating system keychain before connecting',
            );
        const current = handoff;
        const files = current.kind === 'files' ? await chooseFolders() : null;
        if (current.kind === 'files' && !files) return publicState();
        if (files) validateServers([files]);
        if ((current.server || files) && config.servers.length >= 30)
            throw new Error('Remove a connector before adding another');
        const sameSite =
            config.conciergeUrl === current.conciergeUrl &&
            config.relayUrl === current.relayUrl;
        const { data } = await request(current.relayUrl, '/v1/handoff/claim', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(sameSite && config.token
                    ? { Authorization: `Bearer ${config.token}` }
                    : {}),
            },
            body: JSON.stringify({
                ticket: current.ticket,
                site: current.conciergeUrl,
                name: hostname(),
            }),
        });
        const addition = current.server || files;
        clearTimeout(pairingTimer);
        pairing = null;
        config = pairedConfiguration(config, current, data, addition);
        await save();
        handoff = null;
        setupError = null;
        app.setLoginItemSettings({ openAtLogin: true, args: ['--background'] });
        await start();
        // A failed acknowledgement does not undo a saved connection. Reopening
        // from the browser safely reuses this device and issues a fresh ticket.
        await request(current.relayUrl, '/v1/handoff/complete', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${config.token}`,
            },
            body: JSON.stringify({ ticket: current.ticket }),
        }).catch(() => {});
        return publicState();
    } finally {
        saving = false;
    }
});
handle('cancel', () => {
    if (!saving) {
        handoff = null;
        setupError = null;
    }
    return publicState();
});
handle('files', async () => {
    if (saving || !config.token)
        throw new Error('Connect this computer from Concierge first');
    saving = true;
    try {
        const server = await chooseFolders();
        if (server) {
            config.servers = validateServers([...config.servers, server]);
            await save();
            await start();
        }
        return publicState();
    } finally {
        saving = false;
    }
});
handle('open', async () => {
    if (config.conciergeUrl)
        await shell.openExternal(
            new URL(
                '/local-computers',
                serviceOrigin(config.conciergeUrl, !app.isPackaged),
            ).href,
        );
});
handle('pause', async () => {
    if (saving) throw new Error('Please wait for the current change');
    if (status === 'paused') await start();
    else await runtime?.stop();
    return publicState();
});
handle('update', async () => {
    if (!(await updates?.install()))
        throw new Error('Wait for the current tool to finish, then try again');
});
handle('pair', async (value) => {
    if (saving) throw new Error('Please wait for the current change');
    saving = true;
    try {
        if (
            !safeStorage.isEncryptionAvailable() ||
            safeStorage.getSelectedStorageBackend?.() === 'basic_text'
        )
            throw new Error(
                'Enable your operating system keychain before pairing',
            );
        const conciergeUrl = serviceOrigin(value, !app.isPackaged);
        const { data } = await request(conciergeUrl, '/api/companion/config');
        if (!data.enabled)
            throw new Error(
                'Your Concierge administrator has not enabled companion connections',
            );
        const relayUrl = serviceOrigin(data.relayUrl, !app.isPackaged);
        clearTimeout(pairingTimer);
        await runtime?.stop();
        runtime = null;
        const result = await request(relayUrl, '/v1/pair/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: hostname() }),
        });
        pairing = {
            ...result.data,
            relayUrl,
            conciergeUrl,
            expiresAt: Date.now() + 600000,
        };
        status = 'pairing';
        notify();
        await shell.openExternal(new URL('/local-computers', conciergeUrl).href);
        const current = pairing;
        async function poll() {
            if (pairing !== current) return;
            if (Date.now() >= current.expiresAt) {
                pairing = null;
                status = 'unpaired';
                notify();
                return;
            }
            try {
                const response = await request(
                    current.relayUrl,
                    '/v1/pair/status',
                    { headers: { Authorization: `Bearer ${current.token}` } },
                );
                if (response.data.paired && pairing === current) {
                    config = {
                        ...config,
                        conciergeUrl: current.conciergeUrl,
                        relayUrl: current.relayUrl,
                        token: current.token,
                        deviceId: current.deviceId,
                    };
                    await save();
                    pairing = null;
                    app.setLoginItemSettings({
                        openAtLogin: true,
                        args: ['--background'],
                    });
                    await start();
                    return;
                }
            } catch {
                /* Pairing remains bounded by its ten-minute expiry. */
            }
            if (pairing === current) pairingTimer = setTimeout(poll, 2000);
        }
        pairingTimer = setTimeout(poll, 2000);
        return publicState();
    } finally {
        saving = false;
    }
});
handle('add', async (server) => {
    if (!['streamable-http', 'sse'].includes(server?.type))
        throw new Error(
            'Use the folder picker or configuration import for local programs',
        );
    if (saving) throw new Error('Please wait for the current change');
    saving = true;
    try {
        const next = validateServers([...config.servers, server]);
        config.servers = next;
        await save();
        await start();
        return publicState();
    } finally {
        saving = false;
    }
});
handle('remove', async (id) => {
    if (saving) throw new Error('Please wait for the current change');
    saving = true;
    try {
        config.servers = config.servers.filter((s) => s.id !== id);
        await save();
        await start();
        return publicState();
    } finally {
        saving = false;
    }
});
handle('import', async () => {
    const result = await dialog.showOpenDialog(window, {
        title: 'Import local MCP servers',
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled) return publicState();
    const raw = await readFile(result.filePaths[0], 'utf8');
    if (raw.length > 1024 * 1024) throw new Error('Configuration is too large');
    const servers = validateServers(JSON.parse(raw).servers);
    const { response } = await dialog.showMessageBox(window, {
        type: 'question',
        title: 'Enable these local tools?',
        message: `Replace your local servers with ${servers.length} server(s)?`,
        detail:
            servers
                .map(
                    (s) =>
                        `${s.name}: ${s.type === 'stdio' ? [s.command, ...s.args].join(' ') : s.type === 'files' ? s.folders.join(', ') : s.url}`,
                )
                .join('\n') +
            '\n\nLocal programs run with your account permissions. Folder connectors can read and edit files in the listed folders. Only import servers you trust.',
        buttons: ['Cancel', 'Enable servers'],
        defaultId: 0,
        cancelId: 0,
    });
    if (response !== 1) return publicState();
    if (saving) throw new Error('Please wait for the current change');
    saving = true;
    try {
        config.servers = servers;
        await save();
        await start();
        return publicState();
    } finally {
        saving = false;
    }
});

if (!app.requestSingleInstanceLock()) app.quit();
else {
    app.on('second-instance', (_event, argv) => {
        const link = argv.find((arg) => arg.startsWith('concierge-companion:'));
        if (link) receiveLink(link);
        else if (initialized) showSettings();
    });
    app.on('open-url', (event, url) => {
        event.preventDefault();
        receiveLink(url);
    });
    app.on('activate', showSettings);
    app.on('window-all-closed', () => {});
    app.on('before-quit', (event) => {
        if (quitting) return;
        event.preventDefault();
        quitting = true;
        clearTimeout(pairingTimer);
        updates?.stop();
        Promise.resolve(runtime?.stop()).finally(() => app.quit());
    });
    // Electron waits for the ESM entrypoint to finish before firing ready.
    // Awaiting whenReady at module scope would deadlock first launch.
    app.whenReady()
        .then(async () => {
            app.dock?.hide();
            if (app.isPackaged)
                app.setAsDefaultProtocolClient('concierge-companion');
            try {
                config = JSON.parse(
                    safeStorage.decryptString(await readFile(storePath())),
                );
                validateServers(config.servers);
            } catch (error) {
                config = { conciergeUrl: '', servers: [] };
                if (error.code !== 'ENOENT') status = 'locked';
            }
            const isMac = process.platform === 'darwin';
            const icon = nativeImage
                .createFromPath(
                    path.join(directory, isMac ? 'tray.png' : 'icon.png'),
                )
                .resize({ width: 20, height: 20 });
            icon.setTemplateImage(isMac);
            tray = new Tray(icon);
            tray.on('click', showSettings);
            updateMenu();
            const metadata = JSON.parse(
                await readFile(path.join(directory, '../package.json'), 'utf8'),
            );
            updates = startUpdates({
                updater: electronUpdater.autoUpdater,
                enabled: app.isPackaged && metadata.companionUpdates === true,
                isBusy: () => saving || Boolean(runtime?.isBusy()),
                beforeInstall: async () => {
                    saving = true;
                    await runtime?.stop();
                },
                onStatus: (value) => {
                    updateStatus = value;
                    if (value === 'error') saving = false;
                    notify();
                },
            });
            if (status !== 'locked') await start();
            initialized = true;
            if (queuedLink) {
                const link = queuedLink;
                queuedLink = null;
                await receiveLink(link);
            } else if (!config.token || !process.argv.includes('--background'))
                showSettings();
        })
        .catch(() => {
            dialog.showErrorBox(
                'Concierge Companion',
                'Could not start the companion. Please reopen the app.',
            );
            app.quit();
        });
}
