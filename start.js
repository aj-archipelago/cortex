import { loadLocalEnvFiles } from './lib/loadLocalEnv.js';

(async () => {
  loadLocalEnvFiles();
  const { default: startServerFactory } = await import('./index.js');
  const { startServer } = await startServerFactory();
  if (startServer) {
    await startServer();
  }
})();
