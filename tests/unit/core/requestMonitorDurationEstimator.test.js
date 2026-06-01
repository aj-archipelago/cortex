import test from 'ava';
import RequestMonitor from '../../../lib/requestMonitor.js';

test('add and get average request duration', async (t) => {
    const estimator = new RequestMonitor(5);

    const callid = estimator.startCall();
    estimator.callStartTimes.set(callid, new Date(Date.now() - 1000));
    estimator.endCall(callid);

    t.true(estimator.getAverageCallDuration() >= 1000);
});

test('add more requests than size of durations array', (t) => {
    const estimator = new RequestMonitor(5);

    for (let i = 0; i < 10; i++) {
        const callid = estimator.startCall();
        estimator.endCall(callid);
    }

    // Array size should not exceed maximum length (5 in this case)
    t.is(estimator.callDurations.size(), 5);
});

test('calculate percent complete of current request based on average of past durations', async (t) => {
    const estimator = new RequestMonitor(5);

    for (let i = 0; i < 4; i++) {
        estimator.callDurations.pushBack({ endTime: new Date(), callDuration: 1000 });
    }

    const callid = estimator.startCall();
    estimator.callStartTimes.set(callid, new Date(Date.now() - 500));

    const percentComplete = estimator.calculatePercentComplete(callid);

    t.true(percentComplete >= 0.5);
    t.true(percentComplete <= 0.8);
});

test('calculate percent complete based on average of past durations', async (t) => {
    const estimator = new RequestMonitor(5);
    estimator.callDurations.clear();
    estimator.callDurations.pushBack({endTime: new Date(), callDuration: 1000});
    estimator.callDurations.pushBack({endTime: new Date(), callDuration: 2000});
    estimator.callDurations.pushBack({endTime: new Date(), callDuration: 3000});

    const average = estimator.getAverageCallDuration();
    t.is(average, 2000);
});
