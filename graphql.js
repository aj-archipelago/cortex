const { config } = require("./config");
const { fns } = require("./fn");

//build API
const neurons = config.get('neurons');
const neuronNames = Object.keys(neurons);

//typeDefs
const typeDefs = `
    Query {
        ${neuronNames.map(neuronName => `${neuronName}(text: String!): String,`).join('\n\t')}
    }
`;
console.log(typeDefs);

//resolver fns
//resolvers
const resolvers = {
    Query: fns,
}

console.log(resolvers.Query.headline(null, { text: 'hello myheadline world' }));
console.log(resolvers.Query.summary(null, { text: 'mysummary world' }));

//// Schema definition.
// const typeDefs = gql`
// `;

//// Resolver map.
// const resolvers = {
// };

