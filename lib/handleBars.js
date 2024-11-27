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

const MAX_RECURSION_DEPTH = 5; 
HandleBars.registerHelper('renderTemplate', function(value, depth = 0) {
    if (depth >= MAX_RECURSION_DEPTH) {
        console.warn('Maximum recursion depth reached while processing template');
        return value;
    }

    if (typeof value !== 'string') return value;
    
    try {
        if (value.includes('{{')) {
            const template = HandleBars.compile(value);
            const result = template({
                ...this,
                _depth: depth + 1
            });
            return new HandleBars.SafeString(result);
        }
        return value;
    } catch (error) {
        console.warn('Recursive template processing failed:', error);
        return value;
    }
});

export default HandleBars;