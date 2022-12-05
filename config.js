var convict = require('convict');
const fs = require('fs');
const path = require('path');

// TODO: Define a schema possibly with formatters
const CONFIG_FILES = './config/default.json'
const config = convict({});
config.loadFile(CONFIG_FILES);

//build neurons
const NEURONS_PATH = './neurons';
const files = fs.readdirSync(NEURONS_PATH);
for (const file of files) {
    const neuron = { "neurons": { [path.parse(file).name]: require(`${NEURONS_PATH}/${file}`) } }
    config.load(neuron);
}
console.log(config.get('neurons')); //print neurons

// TODO: Perform validation
// config.validate({ allowed: 'strict' });


module.exports = { config };