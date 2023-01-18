const { PathwayResolver } = require('../graphql/pathwayResolver');
const MAX_LENGTH = 12;

module.exports = {
    prompt: `Write a short summary of the following: \n\n{{text}}`,
    resolver: async (parent, args, contextValue, info) => {
        const { config, pathway } = contextValue;
        const pathwayResolver = new PathwayResolver({ config, pathway });

        let summary = await pathwayResolver.resolve(args);
        let i = 0;
        // reprompt if summary is too long
        while (summary.length > MAX_LENGTH && i < 3) {
            summary = await pathwayResolver.resolve({ ...args, text: summary });
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
