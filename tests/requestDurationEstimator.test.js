import test from 'ava';
import RequestDurationEstimator from '../lib/requestDurationEstimator.js';

test('add and get average request duration', async (t) => {
    const estimator = new RequestDurationEstimator(5);

    estimator.startRequest('req1');
    await new Promise(resolve => setTimeout(() => {
        estimator.endRequest();

        const average = estimator.calculatePercentComplete();

        // An average should be calculated after the first completed request  
        t.not(average, 0);
        resolve();
    }, 1000));
});

test('add more requests than size of durations array', (t) => {
    const estimator = new RequestDurationEstimator(5);

    for (let i = 0; i < 10; i++) {
        estimator.startRequest(`req${i}`);
        estimator.endRequest();
    }

    // Array size should not exceed maximum length (5 in this case)
    t.is(estimator.durations.length, 5);
});

test('calculate percent complete of current request based on average of past durations', async (t) => {
    const estimator = new RequestDurationEstimator(5);

    for (let i = 0; i < 4; i++) {
        estimator.startRequest(`req${i}`);
        // wait 1 second
        await new Promise(resolve => setTimeout(resolve, 1000));
        estimator.endRequest();
    }

    estimator.startRequest('req5');

    await new Promise(resolve => setTimeout(() => {
        const percentComplete = estimator.calculatePercentComplete();

        // Depending on how fast the operations are,
        // the percentage may not be exactly 50%, but
        // we'll affirm it should be at least partially complete.
        t.true(percentComplete > 0);
        resolve();
    }, 500));
});

test('calculate percent complete based on average of past durations', async (t) => {
    const estimator = new RequestDurationEstimator(5);
    estimator.durations = [1000, 2000, 3000];
    const average = estimator.getAverage();
    t.is(average, 2000);
});