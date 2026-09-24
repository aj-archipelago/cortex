import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const signed = args.includes('--signed');
const env = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
if (signed) {
    const required = ['CSC_LINK', 'CSC_KEY_PASSWORD', 'COMPANION_UPDATE_URL'];
    if (process.platform === 'darwin') required.push('APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER');
    if (process.platform === 'win32') required.push('COMPANION_WIN_PUBLISHER_NAME');
    for (const name of required) if (!env[name]) throw new Error(`Signed release requires ${name}`);
    const feed = new URL(env.COMPANION_UPDATE_URL);
    if (feed.protocol !== 'https:' || feed.username || feed.password || feed.search || feed.hash) throw new Error('Update feed must use a public HTTPS URL without credentials');
}
const cli = fileURLToPath(new URL('../node_modules/electron-builder/cli.js', import.meta.url));
const commandArgs = [cli, '--publish', 'never', ...args.filter(a => a !== '--signed')];
if (signed) {
    commandArgs.push('--config.forceCodeSigning=true', '--config.extraMetadata.companionUpdates=true', '--config.publish.provider=generic', `--config.publish.url=${env.COMPANION_UPDATE_URL}`);
    if (process.platform === 'darwin') commandArgs.push('--config.mac.notarize=true');
    if (process.platform === 'win32') commandArgs.push(`--config.win.publisherName=${env.COMPANION_WIN_PUBLISHER_NAME}`);
}
const child = spawn(process.execPath, commandArgs, { env, stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
