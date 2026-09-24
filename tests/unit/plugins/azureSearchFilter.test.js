import test from 'ava';
import { config } from '../../../config.js';
import AzureCognitivePlugin from '../../../server/plugins/azureCognitivePlugin.js';

const normalize = (filter, index) => AzureCognitivePlugin.prototype.normalizeFilter(filter, index);

test.serial('search date aliases preserve quoted literals and unrelated identifiers', (t) => {
    t.is(
        normalize("date_published ge 2026-01-01T00:00:00Z and title eq 'date_modified''s date' and candidate eq 'date'", 'idx-wires'),
        "date ge 2026-01-01T00:00:00Z and title eq 'date_modified''s date' and candidate eq 'date'",
    );
    t.is(normalize('date_modified gt 2026-01-01T00:00:00Z', 'indexcortex'), 'updatedAt gt 2026-01-01T00:00:00Z');
    t.is(normalize('date_published ne null', 'sample-documents'), 'date_published ne null');
});

test.serial('operators can configure date aliases for their own search indexes', (t) => {
    const previous = config.get('cognitiveSearchFieldAliases');
    t.teardown(() => config.set('cognitiveSearchFieldAliases', previous));
    config.set('cognitiveSearchFieldAliases', { 'sample-news': { date: 'publishedAt' } });
    t.is(normalize("date ne null and title eq 'date'", 'sample-news'), "publishedAt ne null and title eq 'date'");
    t.is(normalize(null, 'sample-news'), null);
});
