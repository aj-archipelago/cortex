# Concierge Companion

The companion connects local MCP servers to Concierge through an outbound WebSocket.
Customers install the app, pair their account once, and leave it running in the
menu bar or system tray. Node.js and command-line setup are not required.

Start in Concierge: download/install once, select **Connect this computer**, then
approve the account in Companion. The site and account arrive automatically.
macOS uses a universal DMG; Windows uses a one-click per-user installer. OS
installation and open-app prompts still apply.

**Choose a folder** enables the bundled, pinned MCP filesystem server for the
selected folders, including read and edit operations. No Node installation,
terminal commands, or JSON are needed.

The companion supports Streamable HTTP, legacy SSE, and stdio. It does not bundle
Premiere, CEP, or a particular vendor's MCP extension. Those tools must already
be installed on the customer's computer.

## Build and run

```sh
npm ci
npm start
```

Create an unsigned test installer on the target platform:

```sh
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist
```

Build Mac installers on macOS and Windows installers on Windows. The app bundles
Electron and all runtime dependencies. Mac distributions include a DMG and ZIP;
Windows uses a per-user, one-click NSIS installer. The first launch opens Settings.
After successful pairing, login startup is enabled. Closing Settings leaves the
companion running. Pause and Quit are available from the tray.

An unsigned build is for local testing. Customer distribution requires an
organization-owned Developer ID Application certificate, Apple notarization, and
Windows code signing. Do not use a personal Apple Development certificate. The
build script and deployment guide describe these gates.

## Local server configuration

Private endpoints entered in Concierge route here automatically. The native approval
shows the connector address before enabling it. Advanced settings also accept
local, private-network, or HTTPS cloud HTTP/SSE endpoints and a bearer token. No incoming listener is created by the companion. Credentials and
connection settings are encrypted with Electron `safeStorage` backed by the OS
keychain. Plaintext keychain fallbacks are refused.

Administrators can import a reviewed configuration for stdio or custom headers:

```json
{
  "servers": [
    {
      "id": "premiere",
      "name": "Premiere",
      "type": "streamable-http",
      "url": "http://127.0.0.1:3001/mcp"
    },
    {
      "id": "local-program",
      "name": "Local program",
      "type": "stdio",
      "command": "/absolute/path/to/executable",
      "args": ["/absolute/path/to/server.js"],
      "env": {}
    }
  ]
}
```

Import replaces the configured server list after showing the executable paths to
the local user. stdio does not use a shell. The browser cannot install servers or select executable paths; network proposals
require native approval. Commands run with the customer's account permissions, so local MCP server
installation and configuration remain a trust decision.

HTTP connections stay on the configured origin and refuse redirects.
OAuth servers requiring an interactive local authorization flow need their own
authenticated local proxy; the companion currently supports supplied headers.

## Connection behavior

Only server IDs and display names are advertised. MCP schemas, tool arguments and
results cross the relay when used. Saved credentials, executable paths and process
environment variables stay on the computer. A bearer token entered during web
setup passes through an encrypted ten-minute setup record and is then saved locally. Requests and results are limited to
4 MiB; long operations have a two-minute deadline. Save larger output to files.

The socket reconnects with exponential backoff and jitter. Calls are never replayed
after reconnect. A timeout, cancellation, disconnect, or revocation cannot undo an
edit that the local application already accepted. Concierge reports uncertain results
so the user can inspect the application before retrying.

See [the deployment guide](../../docs/local-companion.md) for the relay, Concierge
configuration, validation and customer release requirements.

## Updates and branding

Signed builds embed a fixed HTTPS update feed and verify signed updates. Updates
download on launch/every six hours and install on normal exit. Manual restart waits
for active tools to finish. Unsigned builds disable updates. See the deployment
guide for signing and feed configuration.

The icon and tray images derive from the public Concierge logo at
[`config/default/public/assets/logo.png`](https://github.com/aj-archipelago/concierge/blob/main/config/default/public/assets/logo.png), distributed under Concierge's MIT license. The interface uses system fonts, including Arabic font fallbacks.
The folder icon comes from Lucide (ISC); its license is included in
`src/LUCIDE-LICENSE`. The bundled filesystem server is
`@modelcontextprotocol/server-filesystem`, pinned in the lockfile.
