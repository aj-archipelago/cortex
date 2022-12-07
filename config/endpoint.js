module.exports = {
    //TODO default all definitions of a single endpoint
    name: 'default',
    temperature: 0.7,
    prompt: `{{text}}`,
    // count: 5,
    // format: ``, 
    parser: (text) => text,
    typeDef: {
        type: ``,
        label: `{{name}}(text: String!): String,`
    },
    resolver: (parent, args, contextValue, info) => {
        //TODO default resolver
        // (parent, args, contextValue, info) => fn(endpointName, args, info);
    },
    ctx: {
        //
    }
}