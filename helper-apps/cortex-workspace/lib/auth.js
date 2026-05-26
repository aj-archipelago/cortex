import crypto from 'node:crypto';

let _secret = process.env.WORKSPACE_SECRET;

/**
 * Get the current workspace secret.
 */
export function getSecret() {
    return _secret;
}

/**
 * Replace the workspace secret at runtime.
 * Used by /reconfigure to rotate the secret after a warm-pool container is claimed.
 */
export function setSecret(s) {
    _secret = s;
}

/**
 * Express middleware for shared secret authentication.
 * Validates x-workspace-secret header using timing-safe comparison.
 */
export function requireAuth(req, res, next) {
    if (!_secret) {
        return res.status(500).json({ error: 'Server misconfigured: no secret set' });
    }

    const provided = req.headers['x-workspace-secret'];
    if (!provided || typeof provided !== 'string') {
        return res.status(401).json({ error: 'Missing x-workspace-secret header' });
    }

    const expected = Buffer.from(_secret, 'utf8');
    const actual = Buffer.from(provided, 'utf8');

    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
        return res.status(401).json({ error: 'Invalid secret' });
    }

    next();
}
