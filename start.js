import 'dotenv/config'

import startServerFactory from './index.js';

(async () => {
  const { startServer } = await startServerFactory();
  startServer && startServer();
})();