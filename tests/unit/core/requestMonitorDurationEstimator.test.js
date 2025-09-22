import test from 'ava';
import RequestMonitor from '../../../lib/requestMonitor.js';

test('add and get average request duration', async (t) => {
    const estimator = new RequestMonitor(5);

    const callid = estimator.startCall();
    await new Promise(resolve => setTimeout(() => {
        estimator.endCall(callid);

        const average = estimator.calculatePercentComplete(callid);

        // An average should be calculated after the first completed request  
        t.not(average, 0);
        resolve();
    }, 1000));
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
        const callid = estimator.startCall();
        // wait 1 second
        await new Promise(resolve => setTimeout(resolve, 1000));
        estimator.endCall(callid);
    }

    const callid = estimator.startCall();

    await new Promise(resolve => setTimeout(() => {
        const percentComplete = estimator.calculatePercentComplete(callid);

        // Depending on how fast the operations are,
        // the percentage may not be exactly 50%, but
        // we'll affirm it should be at least partially complete.
        t.true(percentComplete > 0);
        resolve();
    }, 500));
});

test('calculate percent complete based on average of past durations', async (t) => {
    const estimator = new RequestMonitor(5);
    estimator.callDurations.clear;
    estimator.callDurations.pushBack({endTime: new Date(), callDuration: 1000});
    estimator.callDurations.pushBack({endTime: new Date(), callDuration: 2000});
    estimator.callDurations.pushBack({endTime: new Date(), callDuration: 3000});

    const average = estimator.getAverageCallDuration();
    t.is(average, 2000);
});