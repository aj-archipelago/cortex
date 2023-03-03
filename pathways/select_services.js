// Description: Select services from a conversation fragment
module.exports = {
    temperature: 0,
    prompt:
        [
            `Conversation:\n{{text}}\n\nInstructions:\nIn the above conversation fragment, the user may or may not have requested one of the following services:\n{"services": ["Coding", "Translate", "Summary", "Headlines", "Entities", "Spelling", "Grammar", "Style", "Entities", "Newswires"]}\nSelect the services the user requested (or none if none were requested) and return them as a JSON object called "services" below:\n\n`,
        ],
}

