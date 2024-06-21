// Description: Select services from a conversation fragment
export default {
    temperature: 0,
    prompt:
        [
            `Conversation:\n{{text}}\n\nInstructions:\nIn the above conversation fragment, the user may or may not have requested one of the following services:\n{"services": ["Coding", "Translate", "Transcribe", "Summary", "Headlines", "Entities", "Spelling", "Grammar", "Style", "Entities", "Newswires", "FileOrDocumentUpload"]}\nSelect the services the user requested (or none if none were requested) and return them as a JSON object called "services" below:\n\n`,
        ],
    model: 'oai-gpt4o',
}

