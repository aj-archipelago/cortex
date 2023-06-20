import { config } from './config.js';
import { build } from './server/graphql.js';

export default async (configParams) => {
    configParams && config.load(configParams);
    return await build(config);
};