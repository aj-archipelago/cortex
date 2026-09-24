# Browser client tool heartbeats

Client tools must acknowledge receipt within 15 seconds. After acknowledgement,
Cortex allows up to 90 seconds between heartbeats because background browsers
can batch timers once a minute. This grace applies to ordinary tools as well as
long-running tools; browser timer policy does not depend on the tool timeout.

The tool's hard execution deadline is unchanged: five minutes by default, with
bounded per-tool overrides. Repeated heartbeats never extend that deadline.
A missing initial acknowledgement still fails promptly.

Timeout logs include `client_tool_heartbeat_timeout`, the callback and request
IDs, `reason` (`not_acknowledged` or `stale`), elapsed time, heartbeat count and,
for stale clients, the age of the last heartbeat. They contain no tool arguments
or results. Use these fields to distinguish missing delivery from a client that
was connected and stopped responding.

The companion Concierge change dispatches tool markers directly from the stream
reader, without waiting behind text-rendering frames. The browser still checks
whether a tool requires the active chat; navigating or controlling a mounted
applet continues to require focus. Duplicate markers do not rerun a tool.

Validation uses simulated time for one-minute browser heartbeat cadence,
missing acknowledgements, stale clients and hard deadlines. A dev browser
canary should exercise a read-only client tool with its tab backgrounded;
do not retry an unconfirmed mutating tool automatically.
