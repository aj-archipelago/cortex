# Weekly cost accounting

REST generation supports a configurable per-key, seven-day estimated-cost
allowance. Set `CORTEX_DEFAULT_WEEKLY_COST_USD` to a nonnegative amount or
`unlimited` in Cortex and Concierge. The default is unlimited; per-key overrides
take precedence. Policy edits and deployments preserve each
key's anchor and accumulated spend.

Only provider-reported token counts enter the allowance counter. Input, output,
cache creation, and cache reads use their configured prices. Dated OpenAI model
names use the configured base model's prices unless an exact snapshot price exists.
The existing conservative pricing fallback still applies to reported tokens whose
model or rate is unknown.

Responses API terminal events include `response.incomplete` as well as completed,
done, failed, and cancelled responses. Usage in those events is recorded once;
the original event and status are forwarded unchanged.

When execution ends without a usage report, Cortex emits
`weekly_cost_usage_missing` with the request ID, model, route,
stream flag, and HTTP status. It does not turn request bodies, base64 media, SSE
framing, response bytes, or maximum context capacity into token charges. The event
contains no request content or credential. A later provider usage report can still
be recorded. Requests without provider usage can therefore be unmetered; this is
an approximate spending guard, not invoice accounting or an absolute spend ceiling.

The allowance's Redis admission fallback, snapshot lag, and possible
loss of outage debits remain unchanged. Missing-usage warnings and budget-storage
degradation are separate events. The dashboard's fallback count now reflects
pricing fallbacks for reported usage; historical synthetic debits remain in the
current counters until their normal weekly reset. Upgrades do not reset counters or reconcile historical charges.
