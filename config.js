var convict = require('convict');
// const fs = require('fs');
// const path = require('path');

// TODO: Define a schema possibly with formatters
const CONFIG_FILES = './config/default.json'
const config = convict({});
config.loadFile(CONFIG_FILES);

//build endpoints
const ENDPOINTS_PATH = './endpoints';
const endpoints = require(ENDPOINTS_PATH);
config.load({ endpoints })
// const files = fs.readdirSync(ENDPOINTS_PATH);
// for (const file of files) {//////////////
//     const endpoint = { "endpoints": { [path.parse(file).name]: require(`${ENDPOINTS_PATH}/${file}`) } }
//     config.load(endpoint);
// }
console.log(config.get('endpoints')); //print endpoints

// TODO: Perform validation
// config.validate({ allowed: 'strict' });


module.exports = { config };