import test from 'ava';
import RequestMonitor from '../lib/requestMonitor.js'; // replace with actual path

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
  await new Promise(resolve => setTimeout(resolve, 1000));
  rm.endCall(callId1);

  const callId2 = rm.startCall();
  await new Promise(resolve => setTimeout(resolve, 2000));
  rm.endCall(callId2);

  const average = rm.getAverageCallDuration();
  t.truthy(average > 1400 && average < 1600);
});

test('RequestMonitor: incrementError429Count', t => {
  const rm = new RequestMonitor();

  rm.incrementError429Count();

  t.is(rm.error429Count.size(), 1);
});

test('RequestMonitor: getCallRate', async t => {
  const rm = new RequestMonitor();

  rm.startCall();
  rm.endCall();

  await new Promise(resolve => setTimeout(resolve, 1000));

  const callRate = rm.getCallRate();
  t.truthy(callRate > 0.9 && callRate < 1.1);
});

test('RequestMonitor: getPeakCallRate', async t => {
  const rm = new RequestMonitor();

  rm.startCall();
  rm.endCall();

  await new Promise(resolve => setTimeout(resolve, 1000));

  rm.startCall();
  rm.endCall();

  const peakCallRate = rm.getPeakCallRate();
  t.truthy(peakCallRate > 1.9 && peakCallRate < 2.1);
});

test('RequestMonitor: getError429Rate', t => {
  const rm = new RequestMonitor();

  rm.startCall();
  rm.endCall();
  rm.incrementError429Count();

  t.is(rm.getError429Rate(), 1);
});

test('RequestMonitor: reset', t => {
  const rm = new RequestMonitor();

  rm.startCall();
  rm.endCall();
  rm.incrementError429Count();

  rm.reset();

  t.is(rm.callCount.size(), 0);
  t.is(rm.error429Count.size(), 0);
  t.is(rm.peakCallRate, 0);
});