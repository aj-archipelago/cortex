const axios = require('axios');

const API_URL = process.env.API_URL;
const API_SUBSCRIPTION_KEY = process.env.API_SUBSCRIPTION_KEY;

async function transcribeHealthCheck(context, runCount) {
    try {
        const query = `
            query Transcribe($file: String!, $text: String, $wordTimestamped: Boolean, $responseFormat: String, $async: Boolean) {
                transcribe(
                    file: $file
                    text: $text
                    wordTimestamped: $wordTimestamped
                    responseFormat: $responseFormat
                    async: $async
                ) {
                    result
                    __typename
                }
            }
        `;

        const variables = {
            "file": "https://www.youtube.com/watch?v=SCvWXEFb8jE",
            "wordTimestamped": true,
            "responseFormat": "srt",
            "async": false
        };

        const response = await axios({
            url: API_URL,
            method: 'post',
            data: {
                query: query,
                variables: variables
            },
            headers: {
                'Ocp-Apim-Subscription-Key': API_SUBSCRIPTION_KEY
            },
        });

        context.log(response.data);

        const transcribeText =  response.data.data.transcribe.result;

        if (!validateTranscribeText(transcribeText)) {
            throw new Error("Invalid transcribe text");
        } else {
            context.log("Transcribe text is valid");
        }        

    } catch (error) {
        context.error(error);
        if(runCount < 1){
            transcribeHealthCheck(context, runCount + 1);
        }else{
            throw new Error("Error in transcribeHealthCheck");
        }
    }
}


//validate transcribeText similar to below str:
/*
'1
00:00:00,140 --> 00:00:00,640
You

2
00:00:00,640 --> 00:00:00,820
may
...cor
*/
// Validate transcribeText
const validateTranscribeText = (text) => {
    let numberLineRegex = /^\d+$/m;
    let timeFormatRegex = /^\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}$/m;
    let wordLineRegex = /^\w+$/m;
    
    let hasNumberLine = numberLineRegex.test(text);
    let hasTimeFormatLine = timeFormatRegex.test(text);
    let hasWordLine = wordLineRegex.test(text);
    
    if(hasNumberLine && hasTimeFormatLine && hasWordLine){
        return true;
    }
    return false;
}




module.exports = { transcribeHealthCheck };