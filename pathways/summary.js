const PROMPT = `Write a short summary of the following: \n\n{{text}}`;
const MAX_LENGTH = 120;

module.exports = {
    prompt: PROMPT,
    parser: async (response, reprompt) => {
        let summary = response;

        let i = 0

        // reprompt if summary is too long
        while (summary.length > MAX_LENGTH && i < 3) {
            summary = await reprompt(summary);
            i++
        }

        // truncate summary if still too long
        if (summary.length > MAX_LENGTH) {
            const chunks = summary.split('.').map(s => s.trim())

            const included = []
            let totalLength = 0
            for (let i = 0; i < chunks.length; i++) {
                const chunk = chunks[i]
                included.push(chunk)
                totalLength += chunk.length

                if (totalLength.length >= MAX_LENGTH) {
                    break;
                }
            }

            summary = included.join('. ')
        }
        
        return summary;
    }
}
