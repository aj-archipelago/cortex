import test from 'ava';
import { PathwayResolver } from '../../../server/pathwayResolver.js';
import { withStorageGrant, getStorageGrant } from '../../../helper-apps/cortex-file-handler/src/security/storageGrant.js';
import { mockConfig, mockModelEndpoints, mockPathwayString } from '../../helpers/mocks.js';

test('deferred and concurrent executions restore the captured grant outside model args', async t => {
    const pending = ['alice', 'bob'].map(sub => withStorageGrant({ token: `token-${sub}`, claims: { sub } }, () => {
        const parent = new PathwayResolver({ config: mockConfig, endpoints: mockModelEndpoints, args: {},
            pathway: { ...mockPathwayString, executePathway: async ({ args }) => {
                await new Promise(resolve => setImmediate(resolve));
                t.is(getStorageGrant().claims.sub, sub);
                t.false(JSON.stringify(args).includes('token-'));
                const child = new PathwayResolver({ config: mockConfig, endpoints: mockModelEndpoints, args: {}, pathway: mockPathwayString });
                t.is(child.storageGrant.claims.sub, sub);
                t.false(Object.keys(child).includes('storageGrant'));
                return sub;
            } },
        });
        return () => parent.executePathway({ useMemory: false });
    }));
    t.is(getStorageGrant(), null);
    t.deepEqual(await Promise.all(pending.map(run => run())), ['alice', 'bob']);
    t.is(getStorageGrant(), null);
});
