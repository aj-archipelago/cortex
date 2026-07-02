import test from 'ava';
import RequestMonitor from '../../../lib/requestMonitor.js'; // replace with actual path

test('RequestMonitor: startCall', t => {
  const rm = new RequestMonitor();

  const callId = rm.startCall();

  t.is(rm.callStartTimes.has(callId), true);
});

test('RequestMonitor: endCall', t => {
  const rm = new RequestMonitor();

  const callId = rm.startCall();
  rm.endCall(callId);

  t.is(rm.callStartTimes.has(callId), false);
  t.is(rm.callCount.size(), 1);
});

test('RequestMonitor: getAverageCallDuration', async t => {
  const rm = new RequestMonitor();

  const callId1 = rm.startCall();
  rm.callStartTimes.set(callId1, new Date(Date.now() - 1000));
  rm.endCall(callId1);

  const callId2 = rm.startCall();
  rm.callStartTimes.set(callId2, new Date(Date.now() - 2000));
  rm.endCall(callId2);

  const average = rm.getAverageCallDuration();
  t.truthy(average > 1400 && average < 1600);
});

test('RequestMonitor: keeps ping latency separate from live latency', t => {
  const rm = new RequestMonitor();

  rm.recordTTFB(100, 'ping');
  rm.recordTTFB(1000, 'live');
  rm.callStartTimes.set('ping-call', new Date(Date.now() - 10));
  rm.endCall('ping-call', 'ping');

  t.is(rm.getAverageTTFB('ping'), 100);
  t.is(rm.getAverageTTFB(), 1000);
  t.true(rm.getAverageCallDuration('ping') > 0);
  t.is(rm.getAverageCallDuration(), 0);
  t.true(Number.isFinite(rm.getSampleAge('ping')));
});

test('RequestMonitor: incrementError429Count', t => {
  const rm = new RequestMonitor();

  rm.incrementErrorCount(null, 429);

  t.is(rm.error429Count.size(), 1);
});

test('RequestMonitor: getCallRate', t => {
  const rm = new RequestMonitor();

  rm.startCall();
  rm.endCall();

  const callRate = rm.getCallRate();
  t.is(callRate, 1);
});

test('RequestMonitor: getPeakCallRate', t => {
  const rm = new RequestMonitor();

  rm.startCall();
  rm.endCall();

  rm.startCall();
  rm.endCall();

  const peakCallRate = rm.getPeakCallRate();
  t.is(peakCallRate, 2);
});

test('RequestMonitor: getError429Rate', t => {
  const rm = new RequestMonitor();

  rm.startCall();
  rm.endCall();
  rm.incrementErrorCount(null, 429);

  t.is(rm.getError429Rate(), 1);
});

test('RequestMonitor: reset', t => {
  const rm = new RequestMonitor();

  rm.startCall();
  rm.endCall();
  rm.incrementErrorCount(null, 429);

  rm.reset();

  t.is(rm.callCount.size(), 0);
  t.is(rm.error429Count.size(), 0);
  t.is(rm.peakCallRate, 0);
});
