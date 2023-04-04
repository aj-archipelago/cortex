import { config } from './config.js';
import { build } from './graphql/graphql.js';

export default async (configParams) => {
    configParams && config.load(configParams);
    return await build(config);
};