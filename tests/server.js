import 'dotenv/config'
import { ApolloServer } from '@apollo/server';
import { config } from '../config.js';
import typeDefsresolversFactory from '../index.js';

let typeDefs;
let resolvers;

const initTypeDefsResolvers = async () => {
    const result = await typeDefsresolversFactory();
    typeDefs = result.typeDefs;
    resolvers = result.resolvers;
};

export const startTestServer = async () => {
    await initTypeDefsResolvers();

    return new ApolloServer({
        typeDefs,
        resolvers,
        context: () => ({ config, requestState: {} }),
    });
};