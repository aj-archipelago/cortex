
// fulfill a task with an timeout
const fulfillWithTimeout = (promise, timeout) => {
    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            reject(new Error(`Request timed out after ${timeout} seconds!`));
        }, timeout * 1000);
        promise.then(
            (res) => {
                clearTimeout(timeoutId);
                resolve(res);
            },
            (err) => {
                clearTimeout(timeoutId);
                reject(err);
            }
        );
    });
};


export {
    fulfillWithTimeout
};
