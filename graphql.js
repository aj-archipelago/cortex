const { config } = require("./config");
const { fns } = require("./fn");

//build API
const endpoints = config.get('endpoints');
const endpointNames = Object.keys(endpoints);

//typeDefs
//TODO: check code first approach - codegen
const typeDefs = `
    Query {
        ${endpointNames.map(name => `${name}(text: String!): String,`).join('\n\t')}
    }
`;
console.log(typeDefs);

//resolver fns
//resolvers
const resolvers = {
    Query: fns,
}
console.log(resolvers);


const text = `Featured articles are considered to be some of the best articles Wikipedia has to offer, as determined by Wikipedia's editors. They are used by editors as examples for writing other articles. Before being listed here, articles are reviewed as featured article candidates for accuracy, neutrality, completeness, and style according to our featured article criteria. Many featured articles were previously good articles (which are reviewed with a less restrictive set of criteria). There are 6,176 featured articles out of 6,583,906 articles on the English Wikipedia (about 0.09% or one out of every 1,060. `
// fn('summary', t).then(console.log);
// fn('headline', t).then(console.log);

// resolvers.Query.headline(null, { text }).then(console.log);
// resolvers.Query.summary(null, { text }).then(console.log);
// resolvers.Query.bias(null, { text }).then(console.log);
// resolvers.Query.complete(null, { text }).then(console.log);
resolvers.Query.topics(null, { text }).then(console.log);

//// Schema definition.
// const typeDefs = gql`
// `;

//// Resolver map.
// const resolvers = {
// };

module.exports = {
    typeDefs,
    resolvers,
};