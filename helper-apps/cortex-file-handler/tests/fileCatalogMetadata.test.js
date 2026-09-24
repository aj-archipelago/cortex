import test from 'ava';
import { buildFileMetadataIndex, enrichFileCatalog, findFileMetadata } from '../src/utils/fileCatalogMetadata.js';
import { encodeDisplayMetadata, decodeDisplayMetadata } from '../src/utils/blobDisplayMetadata.js';

test('catalog compatibility uses exact, case-sensitive cloud identity and ignores signed tokens', async t => {
  const index = await buildFileMetadataIndex({
    old: { url: 'https://store.test/user/global/Report.md?old=secret', displayFilename: 'Original.docx' },
  });
  const files = await enrichFileCatalog([
    { name: 'global/Report.md', url: 'https://store.test/user/global/Report.md?new=secret' },
    { name: 'global/report.md', url: 'https://store.test/user/global/report.md' },
    { name: 'chats/a/Report.md', url: 'https://store.test/user/chats/a/Report.md' },
  ], index);
  t.is(files[0].displayFilename, 'Original.docx');
  t.falsy(files[1].displayFilename);
  t.falsy(files[2].displayFilename);
});

test('original and converted locations retain their own metadata; native display name wins', async t => {
  const index = await buildFileMetadataIndex({ old: {
    url: 'https://store.test/user/a.docx', displayFilename: 'Original.docx',
    converted: { url: 'https://store.test/user/a.md', mimeType: 'text/markdown' },
  } });
  const [file] = await enrichFileCatalog([{ url: 'https://store.test/user/a.md', displayFilename: 'Renamed.md' }], index);
  t.is(file.displayFilename, 'Renamed.md');
  t.is(file.mimeType, 'text/markdown');
});

test('compact listing does not guess when the same path exists in different containers', async t => {
  const index = await buildFileMetadataIndex({
    one: { url: 'https://store.test/one/global/report.txt', displayFilename: 'One' },
    two: { url: 'https://store.test/two/global/report.txt', displayFilename: 'Two' },
  });
  t.is(findFileMetadata({ name: 'global/report.txt' }, index), null);
  t.is(findFileMetadata({ url: 'https://store.test/one/global/report.txt' }, index).displayFilename, 'One');
});

test('large unmatched catalogs yield the event loop and do not cross-match names', async t => {
  const records = Object.fromEntries(Array.from({ length: 15000 }, (_, i) => [String(i), {
    url: `https://store.test/user/old/${i}.txt`, displayFilename: `friendly-${i}`,
  }]));
  const files = Array.from({ length: 30000 }, (_, i) => ({ name: `new/${i}.txt` }));
  let yielded = false;
  setImmediate(() => { yielded = true; });
  const started = performance.now();
  const index = await buildFileMetadataIndex(records);
  const result = await enrichFileCatalog(files, index);
  t.true(yielded);
  t.is(result.length, files.length);
  t.true(result.every(file => !file.displayFilename && !file.hash));
  // The previous 600x600 implementation took 12 seconds locally. This much
  // larger case must remain comfortably below that even on slow CI hosts.
  t.true(performance.now() - started < 5000);
});

test('blob display metadata round-trips international filenames', t => {
  const name = 'تقرير قطر 📄.docx';
  const metadata = encodeDisplayMetadata(name);
  t.regex(metadata.cfh_display_name, /^[A-Za-z0-9+/=]+$/);
  t.deepEqual(decodeDisplayMetadata(metadata), { displayFilename: name });
});
