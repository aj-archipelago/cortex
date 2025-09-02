import CortexFileHandler from "./index.js";
import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import cors from "cors";
import { readFileSync } from "fs";

import { publicIpv4 } from "public-ip";

// When running under tests we want all generated URLs to resolve to the
// locally-running server, otherwise checks like HEAD requests inside the
// handler will fail (because the external IP is not reachable from inside
// the test runner).  Use the machine's public IP in normal operation, but
// fall back to "localhost" when the environment variable NODE_ENV indicates
// a test run.

let ipAddress = "localhost";

// Initialize IP address asynchronously (only for non-test environments)
async function initializeIpAddress() {
  if (process.env.NODE_ENV !== "test") {
    try {
      ipAddress = await publicIpv4();
    } catch (err) {
      // In rare cases querying the public IP can fail (e.g. no network when
      // running offline).  Keep the default of "localhost" in that case so we
      // still generate valid URLs.
      console.warn(
        "Unable to determine public IPv4 address – defaulting to 'localhost'.",
        err,
      );
    }
  }
}

const app = express();
const port = process.env.PORT || 7071;
const publicFolder = join(dirname(fileURLToPath(import.meta.url)), "files");

// Get version from package.json
const packageJson = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../package.json"),
    "utf8",
  ),
);
const version = packageJson.version;

app.use(cors());
// Serve static files from the public folder
app.use("/files", express.static(publicFolder));

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "healthy",
    version: version,
  });
});

// New primary endpoint
app.all("/api/CortexFileHandler", async (req, res) => {
  const context = { req, res, log: console.log };
  try {
    await CortexFileHandler(context, req);
    context.log(context.res);
    res.status(context.res.status || 200).send(context.res.body);
  } catch (error) {
    const status = error.status || 500;
    const message = error.message || "Internal server error";
    res.status(status).send(message);
  }
});

// Legacy endpoint for compatibility
app.all("/api/MediaFileChunker", async (req, res) => {
  const context = { req, res, log: console.log };
  try {
    await CortexFileHandler(context, req);
    context.log(context.res);
    res.status(context.res.status || 200).send(context.res.body);
  } catch (error) {
    const status = error.status || 500;
    const message = error.message || "Internal server error";
    res.status(status).send(message);
  }
});

// Only start the server if this module is being run directly (not imported for tests)
if (import.meta.url === `file://${process.argv[1]}`) {
  initializeIpAddress().then(() => {
    app.listen(port, () => {
      console.log(
        `Cortex File Handler v${version} running on port ${port} (includes legacy MediaFileChunker endpoint)`,
      );
    });
  });
}
// For tests, we'll keep ipAddress as "localhost" by default - no need to initialize

export { port, publicFolder, ipAddress, app };
