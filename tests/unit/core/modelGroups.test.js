import test from 'ava';
import sinon from 'sinon';
import { config } from '../../../config.js';
import { pickGroupMember, modelEndpoints, resolveModelName } from '../../../lib/requestExecutor.js';

let configStub;

const fakeMonitor = ({
    healthy = true,
    ttfb = 0,
    callDuration = 0,
    liveTtfb = 0,
    liveCallDuration = 0,
} = {}) => ({
    healthy,
    getAverageTTFB: (source) => source === 'ping' ? ttfb : liveTtfb,
    getAverageCallDuration: (source) => source === 'ping' ? callDuration : liveCallDuration,
});

const seedMember = (name, monitorOpts) => {
    modelEndpoints[name] = { endpoints: [{ name: `${name}-ep`, monitor: fakeMonitor(monitorOpts) }] };
};

const seedMemberEndpoints = (name, endpointMonitors) => {
    modelEndpoints[name] = {
        endpoints: endpointMonitors.map((monitorOpts, index) => ({
            name: `${name}-ep-${index}`,
            monitor: fakeMonitor(monitorOpts),
        })),
    };
};

const clearMember = (name) => { delete modelEndpoints[name]; };

test.beforeEach(() => {
    configStub = sinon.stub(config, 'get');
    configStub.callThrough();
});

test.afterEach.always(() => {
    configStub.restore();
    ['m-a', 'm-b', 'm-c'].forEach(clearMember);
});

test.serial('pickGroupMember returns first member when no usable data on any', (t) => {
    seedMember('m-a', {});
    seedMember('m-b', {});
    t.is(pickGroupMember({ members: ['m-a', 'm-b'] }), 'm-a');
});

test.serial('pickGroupMember returns priority pick when its TTFB is in band with fastest', (t) => {
    seedMember('m-a', { ttfb: 700 });
    seedMember('m-b', { ttfb: 600 });
    // priority-1 (m-a) at 700ms vs fastest 600ms; 700/600=1.17 < 1.2 tolerance → priority wins
    t.is(pickGroupMember({ members: ['m-a', 'm-b'] }), 'm-a');
});

test.serial('pickGroupMember demotes priority pick when meaningfully slower', (t) => {
    seedMember('m-a', { ttfb: 2000 });
    seedMember('m-b', { ttfb: 600 });
    // m-a at 2000ms vs fastest 600ms; 2000/600=3.3x → out of band → m-b wins
    t.is(pickGroupMember({ members: ['m-a', 'm-b'] }), 'm-b');
});

test.serial('pickGroupMember picks faster member even when priority pick has no measurement', (t) => {
    seedMember('m-a', {});
    seedMember('m-b', { ttfb: 600 });
    // m-a never measured (no usable latency); m-b is the only candidate with data → m-b wins
    t.is(pickGroupMember({ members: ['m-a', 'm-b'] }), 'm-b');
});

test.serial('pickGroupMember ignores live TTFB and uses sampler TTFB only', (t) => {
    seedMember('m-a', { ttfb: 700, liveTtfb: 3000 });
    seedMember('m-b', { ttfb: 600, liveTtfb: 400 });
    // Live TTFB is workload-dependent and should not change cross-model
    // ranking. Ping TTFB keeps the comparison payload-controlled.
    t.is(pickGroupMember({ members: ['m-a', 'm-b'] }), 'm-a');
});

test.serial('pickGroupMember skips unhealthy priority pick', (t) => {
    seedMember('m-a', { healthy: false, ttfb: 600 });
    seedMember('m-b', { healthy: true, ttfb: 700 });
    t.is(pickGroupMember({ members: ['m-a', 'm-b'] }), 'm-b');
});

test.serial('pickGroupMember ignores latency samples from unhealthy endpoints', (t) => {
    seedMemberEndpoints('m-a', [
        { healthy: false, ttfb: 100 },
        { healthy: true, ttfb: 2000 },
    ]);
    seedMember('m-b', { healthy: true, ttfb: 700 });
    // m-a's fast sample is on an unhealthy endpoint, so group routing should
    // compare its healthy 2000ms endpoint against m-b's 700ms endpoint.
    t.is(pickGroupMember({ members: ['m-a', 'm-b'] }), 'm-b');
});

test.serial('pickGroupMember falls back to priority order when TTFB unavailable', (t) => {
    seedMember('m-a', { ttfb: 0, callDuration: 500 });
    seedMember('m-b', { ttfb: 0, callDuration: 2000 });
    t.is(pickGroupMember({ members: ['m-a', 'm-b'] }), 'm-a');
});

test.serial('pickGroupMember does not use call duration as a fallback metric', (t) => {
    seedMember('m-a', { ttfb: 0, callDuration: 100 });
    seedMember('m-b', { ttfb: 600, callDuration: 2000 });
    // A streaming ping without first-token data is not comparable model
    // latency, even if the HTTP connection duration was short.
    t.is(pickGroupMember({ members: ['m-a', 'm-b'] }), 'm-b');
});

test.serial('pickGroupMember uses priority order among members with the selected metric', (t) => {
    seedMember('m-a', { ttfb: 0, callDuration: 100 });
    seedMember('m-b', { ttfb: 700, callDuration: 2000 });
    seedMember('m-c', { ttfb: 600, callDuration: 2000 });
    // m-a has no TTFB, so it is excluded from the comparison. m-b is within
    // 1.2x of fastest m-c, so priority order picks m-b.
    t.is(pickGroupMember({ members: ['m-a', 'm-b', 'm-c'] }), 'm-b');
});

test.serial('pickGroupMember handles empty/missing inputs', (t) => {
    t.is(pickGroupMember({ members: [] }), null);
    t.is(pickGroupMember(null), null);
    t.is(pickGroupMember(undefined), null);
});

test.serial('resolveModelName resolves modelGroup alias to picked member', (t) => {
    seedMember('m-a', { ttfb: 500 });
    seedMember('m-b', { ttfb: 500 });
    configStub.withArgs('modelRedirects').returns({});
    configStub.withArgs('modelGroups').returns({ 'fast-tier': { members: ['m-a', 'm-b'] } });
    t.is(resolveModelName('fast-tier'), 'm-a');
});

test.serial('resolveModelName passes through unknown names unchanged', (t) => {
    configStub.withArgs('modelRedirects').returns({});
    configStub.withArgs('modelGroups').returns({ 'fast-tier': { members: ['m-a'] } });
    t.is(resolveModelName('not-a-group'), 'not-a-group');
});
