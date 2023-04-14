// handleBars.js

import HandleBars from 'handlebars';

// register functions that can be called directly in the prompt markdown
HandleBars.registerHelper('stripHTML', function (value) {
    return value.replace(/<[^>]*>/g, '');
});

HandleBars.registerHelper('now', function () {
    return new Date().toISOString();
});

HandleBars.registerHelper('toJSON', function (object) {
    return JSON.stringify(object);
});

HandleBars.registerHelper('ctoW', function (value) {
    // if value is not a number, return it
    if (isNaN(value)) {
        return value;
    }
    return Math.round(value / 6.6);
});

export default HandleBars;