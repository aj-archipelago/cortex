function convertToSingleContentChatHistory(chatHistory){
    for(let i=0; i<chatHistory.length; i++){
        //if isarray make it single string
        if (Array.isArray(chatHistory[i]?.content)) {
            chatHistory[i].content = chatHistory[i].content.join("\n");
        }
    }
}

//check if args has a type in chatHistory
function chatArgsHasType(args, type){
    const { chatHistory } = args;
    for(const ch of chatHistory){
        for(const content of ch.content){
            try{
                if(JSON.parse(content).type == type){
                    return true;
                }
            }catch(e){
                continue;
            }
        }
    }
    return false;
}

//check if args has an image_url in chatHistory
function chatArgsHasImageUrl(args){
    return chatArgsHasType(args, 'image_url');
}

export { 
    convertToSingleContentChatHistory,
    chatArgsHasImageUrl, 
    chatArgsHasType 
};