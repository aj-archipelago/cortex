// The feed is embedded at build time in a signed release. Pairing links and
// remote MCP servers cannot choose where executable updates come from.
export function startUpdates({
    updater,
    enabled,
    isBusy,
    onStatus,
    beforeInstall = async () => {},
}) {
    if (!enabled) {
        onStatus('unavailable');
        return { stop() {} };
    }
    updater.autoDownload = true;
    // The app waits for its runtime to stop in before-quit. The updater's normal
    // quit handler runs only after that shutdown completes.
    updater.autoInstallOnAppQuit = true;
    updater.allowDowngrade = false;
    let ready = false;
    let stopped = false;
    let checking = false;
    updater.on('update-available', () => onStatus('downloading'));
    updater.on('update-downloaded', () => {
        ready = true;
        onStatus('ready');
    });
    updater.on('update-not-available', () => onStatus('current'));
    updater.on('error', () => onStatus('error'));
    async function check() {
        if (stopped || checking || ready) return;
        checking = true;
        try {
            await updater.checkForUpdates();
        } catch {
            onStatus('error');
        } finally {
            checking = false;
        }
    }
    const timer = setInterval(check, 6 * 60 * 60 * 1000);
    check();
    return {
        async install() {
            if (!ready || isBusy()) return false;
            await beforeInstall();
            updater.quitAndInstall(false, true);
            return true;
        },
        stop() {
            stopped = true;
            clearInterval(timer);
        },
    };
}
