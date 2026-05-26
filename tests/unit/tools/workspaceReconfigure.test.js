/**
 * Unit tests for workspace secret rotation (auth.js getSecret/setSecret).
 *
 * These tests run in isolation — no Docker or server needed.
 * Uses test.serial because tests share module-level secret state.
 *
 * Run with: npm test -- cortex -- tests/unit/tools/workspaceReconfigure.test.js
 */

import test from 'ava';

// Set the initial secret before importing the auth module
const INITIAL_SECRET = 'test-secret-initial';
process.env.WORKSPACE_SECRET = INITIAL_SECRET;

// Dynamic import so the module picks up process.env.WORKSPACE_SECRET
const { getSecret, setSecret, requireAuth } = await import(
    '../../../helper-apps/cortex-workspace/lib/auth.js'
);

// Helper: create mock req/res/next for Express middleware testing
function mockReqRes(secretHeader) {
    const req = {
        headers: secretHeader !== undefined
            ? { 'x-workspace-secret': secretHeader }
            : {},
    };
    let statusCode = null;
    let jsonBody = null;
    let nextCalled = false;

    const res = {
        status(code) {
            statusCode = code;
            return res;
        },
        json(body) {
            jsonBody = body;
            return res;
        },
    };

    const next = () => { nextCalled = true; };

    return { req, res, next, getStatus: () => statusCode, getBody: () => jsonBody, wasNextCalled: () => nextCalled };
}

// ============================================================================
// getSecret / setSecret
// ============================================================================

test.serial('getSecret › returns initial value from process.env', (t) => {
    t.is(getSecret(), INITIAL_SECRET);
});

test.serial('setSecret › changes the secret', (t) => {
    setSecret('new-secret');
    t.is(getSecret(), 'new-secret');

    // Restore for subsequent tests
    setSecret(INITIAL_SECRET);
    t.is(getSecret(), INITIAL_SECRET);
});

// ============================================================================
// requireAuth middleware
// ============================================================================

test.serial('requireAuth › accepts correct secret', (t) => {
    const { req, res, next, wasNextCalled, getStatus } = mockReqRes(INITIAL_SECRET);
    requireAuth(req, res, next);

    t.true(wasNextCalled());
    t.is(getStatus(), null); // no error status set
});

test.serial('requireAuth › rejects wrong secret', (t) => {
    const { req, res, next, wasNextCalled, getStatus, getBody } = mockReqRes('wrong-secret');
    requireAuth(req, res, next);

    t.false(wasNextCalled());
    t.is(getStatus(), 401);
    t.is(getBody().error, 'Invalid secret');
});

test.serial('requireAuth › rejects missing header', (t) => {
    const { req, res, next, wasNextCalled, getStatus, getBody } = mockReqRes(undefined);
    requireAuth(req, res, next);

    t.false(wasNextCalled());
    t.is(getStatus(), 401);
    t.is(getBody().error, 'Missing x-workspace-secret header');
});

// ============================================================================
// Secret rotation flow (simulates /reconfigure)
// ============================================================================

test.serial('rotation › old secret rejected after setSecret', (t) => {
    const oldSecret = getSecret();
    const newSecret = 'rotated-secret-' + Date.now();

    setSecret(newSecret);

    // Old secret should be rejected
    const { req: req1, res: res1, next: next1, wasNextCalled: n1, getStatus: s1 } = mockReqRes(oldSecret);
    requireAuth(req1, res1, next1);
    t.false(n1());
    t.is(s1(), 401);

    // New secret should be accepted
    const { req: req2, res: res2, next: next2, wasNextCalled: n2, getStatus: s2 } = mockReqRes(newSecret);
    requireAuth(req2, res2, next2);
    t.true(n2());
    t.is(s2(), null);

    // Restore
    setSecret(INITIAL_SECRET);
});
