import {SocketServer} from './src/SocketServer';
import {ApiServer} from "./src/ApiServer";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const CORS_HOSTS = process.env.CORS_HOSTS ? JSON.parse(process.env.CORS_HOSTS) : 'http://localhost:5173';
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 8081;

if (!OPENAI_API_KEY) {
  console.error(
    `Environment variable "OPENAI_API_KEY" is required.\n` +
    `Please set it in your .env file.`
  );
  process.exit(1);
}

const apiServer = new ApiServer(OPENAI_API_KEY, CORS_HOSTS);
apiServer.initServer();
const server = new SocketServer(OPENAI_API_KEY, CORS_HOSTS);
server.listen(apiServer.getServer(), PORT);
