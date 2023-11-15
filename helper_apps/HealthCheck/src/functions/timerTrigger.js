const { app } = require('@azure/functions');
const { transcribeHealthCheck } = require('../transcribeHealthCheck');

app.timer('timerTrigger', {
    schedule: '0 0 * * * *',
    // schedule: '0 * * * * *',
    runOnStartup: true,
    handler: async (myTimer, context) => {
        context.log('Timer function starting request.');
        await transcribeHealthCheck(context, 0);
        context.log('Timer function processed request.');
    }
});
