# Responses function tool schemas

Cortex sends function tools to the Responses API with `strict: false` unless
the tool explicitly chooses a strict-mode value. This preserves the required
and optional fields declared by pathway and MCP schemas. It applies to nested
Chat Completions tool definitions, already-flat Responses tools, and the
`tools.functions` configuration form. Native tools keep their existing settings.

For example, a Jira comment tool may require the issue and comment body while
leaving visibility and a parent comment ID optional. Those optional arguments
should be omitted for an unrestricted, top-level comment. Cortex does not fill
them with empty strings, empty objects, or nulls.

The [OpenAI function-calling documentation](https://developers.openai.com/api/docs/guides/function-calling#strict-mode)
states that Responses may normalize schemas into strict mode when `strict` is
omitted. Strict schemas require every property to be listed in `required`;
explicit `strict: false` retains best-effort calling with the original schema.
Tools that explicitly opt into `strict: true` remain responsible for supplying
a compatible schema.

Regression coverage captures the outbound request at the plugin boundary. It
does not post Jira comments or call a live connector. Validate a read-only
connector tool on dev before the next production train.
