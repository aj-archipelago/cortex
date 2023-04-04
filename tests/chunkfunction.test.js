import test from 'ava';
import { getSemanticChunks } from '../graphql/chunker.js';
import { encode } from 'gpt-3-encoder';

const testText = `Lorem ipsum dolor sit amet, consectetur adipiscing elit. In id erat sem. Phasellus ac dapibus purus, in fermentum nunc. Mauris quis rutrum magna. Quisque rutrum, augue vel blandit posuere, augue magna convallis turpis, nec elementum augue mauris sit amet nunc. Aenean sit amet leo est. Nunc ante ex, blandit et felis ut, iaculis lacinia est. Phasellus dictum orci id libero ullamcorper tempor.

Vivamus id pharetra odio.   Sed consectetur leo sed tortor dictum venenatis.Donec gravida libero non accumsan suscipit.Donec lectus turpis, ullamcorper eu pulvinar iaculis, ornare ut risus.Phasellus aliquam, turpis quis viverra condimentum, risus est pretium    metus, in porta ipsum tortor vitae elit.Pellentesque id finibus erat.  In suscipit, sapien non posuere dignissim, augue nisl ultrices tortor, sit amet eleifend nibh elit at risus.

Donec diam ligula, sagittis ut nisl tincidunt, porta sodales magna.Vestibulum ut dui arcu.Fusce at dolor ex.Aliquam eu justo non libero volutpat pulvinar at id urna.Donec nec purus sed elit bibendum faucibus.Pellentesque habitant morbi                                     tristique senectus et netus et malesuada fames ac turpis egestas.Vivamus iaculis mattis velit, ut lacinia massa lacinia quis.Phasellus porttitor gravida ex, id aliquet eros rhoncus quis. Ut fringilla, lectus a vehicula luctus, diam odio convallis dolor, sodales pharetra nulla ex dictum justo.Ut faucibus, augue quis dictum iaculis, diam leo    maximus sapien, sit amet vulputate eros quam sed sem.Cras malesuada, sapien sit amet iaculis euismod, nunc odio lacinia est, dictum iaculis ante nisi in est.Fusce vehicula lorem tellus.Nullam a tempus nisi    .

Sed ut lectus nec ligula blandit tempus.Donec faucibus turpis id urna vehicula imperdiet.Duis tempor vitae orci interdum dignissim.Phasellus sed efficitur sem.Nullam accumsan, turpis vitae consectetur ullamcorper, lectus purus tincidunt nisi, in pulvinar leo tortor at sem.Donec at feugiat dui, nec rhoncus nibh.Nam faucibus ultrices nisl at lobortis.Morbi congue, nisl vel fermentum tristique, dui ipsum rhoncus massa, non varius nibh massa in turpis.Vestibulum vulputate, felis quis lacinia porta, nulla ex volutpat lorem, non rhoncus neque erat quis arcu.Morbi massa nisl, hendrerit eget tortor condimentum, lobortis dapibus sem.Aliquam ut dapibus elit.Sed porta dignissim ante.Nullam interdum ligula et massa vehicula, vel gravida diam laoreet.Vivamus et enim eget turpis pellentesque laoreet.Vivamus pellentesque neque et mauris imperdiet pulvinar.

Aliquam eget ligula congue, tincidunt magna eu, rutrum urna.Sed consequat orci est, vel laoreet magna tincidunt sit amet.Curabitur eget condimentum odio, vitae condimentum elit.Duis viverra lobortis magna.Pellentesque habitant morbi tristique senectus et netus et malesuada fames ac turpis egestas.Sed facilisis mi eu scelerisque pharetra.Cras et massa odio.Praesent quis nulla vitae mi blandit egestas ac vitae libero.Cras ultricies ex non consequat scelerisque.Nulla et est ac sem placerat convallis ac vitae massa.Phasellus lobortis mauris vel est vehicula lobortis.Curabitur ipsum ipsum, ullamcorper eget placerat sit amet, dapibus iaculis dui.Phasellus facilisis rutrum metus nec euismod.

Nam viverra est ac orci rhoncus, mollis mattis mi lobortis.Maecenas lectus ex, pulvinar vel mauris vel, egestas ornare massa.Nam placerat, tellus vel ullamcorper ullamcorper, enim felis egestas tellus, eu dictum augue tortor vel libero.Integer vel nunc felis.Nulla vehicula et enim non luctus.Vestibulum non odio magna.Donec vitae ipsum et nisl vestibulum maximus eu at augue.Morbi ac tristique quam.Suspendisse vestibulum nec dui et consectetur.Aliquam a dapibus dolor, sit amet fringilla eros.Nam id lorem nulla.

Proin vulputate risus purus, id tincidunt magna eleifend vel.Pellentesque et commodo leo, sit amet molestie nunc.Nunc purus lectus, interdum ut mauris ac, varius pretium magna.Etiam sollicitudin eros at pretium molestie.Cras fermentum sagittis elit at egestas.Fusce auctor lacinia nisl ac ullamcorper.Interdum et malesuada fames ac ante ipsum primis in faucibus.Fusce commodo pretium urna vel consequat.In finibus tellus vitae magna pharetra, porttitor egestas libero cursus.Donec eget tincidunt dolor, ac tristique diam.Etiam interdum dictum ex suscipit tempus.In hac habitasse platea dictumst.Nulla ornare libero a leo mollis, sed gravida leo finibus.Nunc ornare, dolor ac convallis varius, quam ipsum ultricies dui, non vehicula est eros eget ipsum.Mauris vel rhoncus ligula, non porta metus.

Ut non felis pretium leo viverra tincidunt.Vivamus et ligula commodo dolor faucibus gravida.Quisque eu dolor ac metus pretium pharetra.Integer mattis efficitur libero, sed condimentum nulla ultricies eu.Donec turpis orci, fermentum vitae imperdiet nec, luctus quis lectus.Nunc viverra ornare libero.Vestibulum elementum tempus tortor id semper.

Aliquam in dapibus risus.Praesent vitae condimentum elit, sodales pellentesque diam.Curabitur luctus pellentesque nunc, ut eleifend urna dictum ac.Aenean rhoncus lacinia quam a suscipit.Proin purus metus, egestas a pretium eu, tempus ut ante.Sed tellus turpis, hendrerit consequat porta id, porttitor non dolor.Proin volutpat massa a dui dictum facilisis a vel eros.Fusce eu efficitur odio.Aliquam interdum metus id ex dapibus dapibus.Nullam porttitor non sapien nec rhoncus.Cras iaculis fringilla cursus.Praesent at leo orci.Sed eget vulputate eros, eget auctor sapien.Nulla auctor, lectus ut tincidunt rhoncus, ante lorem volutpat eros, ac tincidunt enim ipsum at ex.Fusce dolor arcu, pretium eget elementum vel, semper at ipsum.

Integer rhoncus fringilla felis ac tincidunt.Phasellus eu ultricies tellus.Sed pharetra, eros sed dignissim mattis, mi lectus blandit elit, vitae euismod ipsum sapien a eros.Aliquam lobortis tellus venenatis, sagittis lorem non, eleifend odio.Duis ultrices urna vel commodo varius.Sed ultricies mauris ut velit dignissim, eu lobortis ex tempor.Praesent vitae iaculis nisl.Vestibulum id convallis tellus.Vivamus eu consectetur erat.Curabitur interdum est non nibh malesuada ullamcorper.Phasellus mollis arcu a pharetra lacinia.Praesent sit amet sem non dui iaculis tincidunt.Aliquam vitae libero viverra metus feugiat volutpat ut eget sem.Nam facilisis pulvinar urna, ut venenatis ligula accumsan finibus.Maecenas nec aliquam nulla.Maecenas mattis magna erat.

Nunc a nulla sed ante sollicitudin ultrices a a ante.Sed feugiat scelerisque leo, eget venenatis orci cursus eget.Ut pretium leo et nunc sodales, in luctus erat faucibus.Interdum et malesuada fames ac ante ipsum primis in faucibus.Mauris facilisis lorem quis turpis commodo, id vulputate metus molestie.Fusce id neque vestibulum, pretium elit in, ultrices justo.Praesent turpis dui, ullamcorper in vulputate ut, posuere at sapien.Etiam laoreet ultrices felis, id venenatis purus.Sed nec mauris pharetra, rhoncus sem non, interdum justo.Nulla sed tincidunt nisi.Suspendisse luctus viverra volutpat.Duis arcu nulla, euismod eu scelerisque in, vulputate eget quam.

Vestibulum ante ipsum primis in faucibus orci luctus et ultrices posuere cubilia curae; Fusce at dignissim quam.Suspendisse eget metus nec sem accumsan sagittis.Suspendisse non mollis lacus.Donec ac consectetur ante.Nullam luctus, nibh ac imperdiet porta, sem felis bibendum nibh, ut sollicitudin libero nulla a sapien.Sed tristique odio enim, eget tempor enim cursus vel.Morbi tristique lobortis tortor, nec placerat lorem suscipit ac.Nullam sed sodales diam, sed tincidunt est.Quisque semper velit sed risus dictum pretium.Proin condimentum, nisi a vulputate tristique, tellus erat scelerisque nisi, tincidunt viverra est neque non magna.Quisque nibh augue, interdum non justo et, varius rutrum erat.Pellentesque habitant morbi tristique senectus et netus et malesuada fames ac turpis egestas.

Vestibulum et lorem auctor, vestibulum nisl id, elementum metus.Pellentesque quis mi a augue consectetur cursus.Morbi sodales risus et faucibus dictum.Ut in lobortis nisl, et euismod nisl.Donec ornare tellus placerat, blandit justo quis, pharetra nisl.Nulla scelerisque magna at nisi suscipit commodo.Fusce pellentesque in elit et consequat.Phasellus vehicula accumsan enim, vitae pellentesque nulla.Nullam id arcu vitae nunc consectetur mattis.Fusce ac sapien vel mi congue fringilla.Nulla mattis consectetur fringilla.Morbi orci elit, tempor in rhoncus eget, fringilla eget erat.

Phasellus nec lorem lectus.Donec in cursus elit.In dictum elementum odio a scelerisque.Phasellus ac sapien eget velit accumsan elementum.Mauris odio eros, vulputate eu aliquet a, bibendum in quam.Integer euismod libero ac massa imperdiet, ullamcorper cursus risus auctor.Nam rutrum erat eget tortor suscipit semper sit amet nec mauris.Pellentesque nec semper neque.Nunc fringilla nisl erat, a sollicitudin tortor accumsan finibus.

Integer vulputate ex dui, vitae scelerisque purus viverra vel.Cras ultricies purus in nibh dapibus, non hendrerit nulla aliquam.Fusce vitae gravida urna.Mauris eleifend rutrum ex, at fermentum enim fringilla quis.Suspendisse dignissim est eget tempus condimentum.Fusce scelerisque, felis et malesuada dictum, mauris dolor cursus ex, eget pulvinar sem nulla id diam.Ut volutpat tincidunt efficitur.Nunc vel risus fringilla, lacinia urna vitae, aliquet nulla.Nunc sed pulvinar dolor, eu fermentum velit.Curabitur a pretium quam, ut consectetur neque.Nunc ultricies, ex sed mattis efficitur, nulla nunc convallis odio, sit amet pellentesque orci tortor ut sapien.Vivamus felis orci, ultricies eget lacinia at, blandit vitae quam.In lacinia dui nec tincidunt maximus.Donec feugiat consectetur bibendum.Aenean eget vestibulum lacus.

Suspendisse vel molestie magna, et viverra justo.Aenean nec mi felis.Nam lacinia purus et congue facilisis.Pellentesque eget odio sed sem tincidunt imperdiet.Proin finibus ex nec placerat aliquet.Phasellus quis sapien nunc.Mauris eu augue aliquam sem suscipit vehicula a luctus augue.Phasellus ac scelerisque nibh.Nullam eleifend eleifend sapien eget convallis.

Nunc vitae metus risus.Ut iaculis dolor accumsan bibendum posuere.Morbi vitae odio sed velit dictum consequat.Aliquam vel erat vitae lacus luctus cursus vel ut risus.Aliquam a nunc eu lorem consequat finibus.Sed non enim vestibulum, ornare dui id, dignissim turpis.Etiam fermentum rutrum porttitor.Maecenas id nisl sodales, ornare turpis placerat, tincidunt dui.

Nulla aliquam purus at leo fringilla euismod.Praesent condimentum augue nibh, sed scelerisque mauris bibendum vitae.Vivamus maximus enim non massa commodo gravida.Cras iaculis elit ac est dapibus convallis.Quisque in tortor tincidunt, placerat turpis pulvinar, rhoncus orci.In vel risus et lacus lacinia volutpat.Maecenas facilisis fermentum dictum.Lorem ipsum dolor sit amet, consectetur adipiscing elit.Praesent aliquam pretium pellentesque.In eleifend leo eros, in lobortis eros elementum maximus.Fusce in orci ut massa vehicula mollis vitae non nibh.Sed ac porttitor urna.Nulla ac venenatis sapien, eget vulputate metus.

Mauris hendrerit lacus quam, vel mollis ligula porttitor ac.Nulla ornare libero at faucibus dictum.Donec tincidunt viverra sapien nec tincidunt.Donec leo sapien, rutrum quis dui a, auctor sodales nisi.Fusce condimentum eros sit amet ligula viverra, eget ullamcorper erat dapibus.Suspendisse dignissim ligula sed luctus aliquet.Aenean consectetur enim non nibh semper volutpat.

Mauris diam dolor, maximus et ultrices sed, semper sed felis.Morbi ac eros tellus.Maecenas eget ex vitae quam lacinia eleifend non nec leo.Donec condimentum consectetur nunc, quis luctus elit commodo eu.Nunc tincidunt condimentum neque, sed porta ligula porttitor et.Suspendisse scelerisque id massa sit amet placerat.Sed eleifend aliquet facilisis.Donec ac purus nec metus vestibulum euismod.Maecenas sollicitudin consequat ornare.Suspendisse pharetra vehicula eros nec malesuada.`;

test('should return identical text that chunker was passed, given large chunk size (1812)', async t => {
    const maxChunkToken = 1812;
    const chunks = getSemanticChunks(testText, maxChunkToken);
    t.true(chunks.length > 0); //check chunking
    t.true(chunks.every(chunk => encode(chunk).length <= maxChunkToken)); //check chunk size
    const recomposedText = chunks.reduce((acc, chunk) => acc + chunk, '');
    t.is(recomposedText, testText); //check recomposition
});

test('should return identical text that chunker was passed, given medium chunk size (500)', async t => {
    const maxChunkToken = 500;
    const chunks = getSemanticChunks(testText, maxChunkToken);
    t.true(chunks.length > 1); //check chunking
    t.true(chunks.every(chunk => encode(chunk).length <= maxChunkToken)); //check chunk size
    const recomposedText = chunks.reduce((acc, chunk) => acc + chunk, '');
    t.is(recomposedText, testText); //check recomposition
});

test('should return identical text that chunker was passed, given tiny chunk size (1)', async t => {
    const maxChunkToken = 1;
    const chunks = getSemanticChunks(testText, maxChunkToken);
    t.true(chunks.length > 1); //check chunking
    t.true(chunks.every(chunk => encode(chunk).length <= maxChunkToken)); //check chunk size
    const recomposedText = chunks.reduce((acc, chunk) => acc + chunk, '');
    t.is(recomposedText, testText); //check recomposition
});

/*
it('should return identical text that chunker was passed, given tiny chunk size (1)', () => {
    const maxChunkToken = 1;
    const chunks = getSemanticChunks(testText, maxChunkToken);
    expect(chunks.length).toBeGreaterThan(1); //check chunking
    expect(chunks.every(chunk => encode(chunk).length <= maxChunkToken)).toBe(true); //check chunk size
    const recomposedText = chunks.reduce((acc, chunk) => acc + chunk, '');
    expect(recomposedText).toBe(testText); //check recomposition
});

it('should return identical text that chunker was passed, given huge chunk size (32000)', () => {
    const maxChunkToken = 32000;
    const chunks = getSemanticChunks(testText, maxChunkToken);
    expect(chunks.length).toBe(1); //check chunking
    expect(chunks.every(chunk => encode(chunk).length <= maxChunkToken)).toBe(true); //check chunk size
    const recomposedText = chunks.reduce((acc, chunk) => acc + chunk, '');
    expect(recomposedText).toBe(testText); //check recomposition
});

const testTextNoSpaces = `Loremipsumdolorsitamet,consecteturadipiscingelit.Inideratsem.Phasellusacdapibuspurus,infermentumnunc.Maurisquisrutrummagna.Quisquerutrum,auguevelblanditposuere,auguemagnacon vallisturpis,necelementumauguemaurissitametnunc.Aeneansitametleoest.Nuncanteex,blanditetfelisut,iaculislaciniaest.Phasellusdictumorciidliberoullamcorpertempor.Vivamusidpharetraodioq.Sedconsecteturleosedtortordictumvenenatis.Donecgravidaliberononaccumsansuscipit.Doneclectusturpis,ullamcorpereupulvinariaculis,ornareutrisus.Phasellusaliquam,turpisquisviverracondimentum,risusestpretiummetus,inportaips umtortorvita elit.Pellentesqueidfinibuserat.Insuscipit,sapiennonposueredignissim,auguenisl ultricestortor,sitameteleifendnibhelitatrisus.`;

it('should return identical text that chunker was passed, given no spaces and small chunks(5)', () => {
    const maxChunkToken = 5;
    const chunks = getSemanticChunks(testTextNoSpaces, maxChunkToken);
    expect(chunks.length).toBeGreaterThan(0); //check chunking
    expect(chunks.every(chunk => encode(chunk).length <= maxChunkToken)).toBe(true); //check chunk size
    const recomposedText = chunks.reduce((acc, chunk) => acc + chunk, '');
    expect(recomposedText).toBe(testTextNoSpaces); //check recomposition
});

const testTextShortWeirdSpaces=`Lorem ipsum dolor sit amet, consectetur adipiscing elit. In id erat sem. Phasellus ac dapibus purus, in fermentum nunc.............................. Mauris quis rutrum magna. Quisque rutrum, augue vel blandit posuere, augue magna convallis turpis, nec elementum augue mauris sit amet nunc. Aenean sit a;lksjdf 098098- -23 eln ;lkn l;kn09 oij[0u ,,,,,,,,,,,,,,,,,,,,, amet leo est. Nunc ante ex, blandit et felis ut, iaculis lacinia est. Phasellus dictum orci id libero ullamcorper tempor.




    Vivamus id pharetra odio.   Sed consectetur leo sed tortor dictum venenatis.Donec gravida libero non accumsan suscipit.Donec lectus turpis, ullamcorper eu pulvinar iaculis, ornare ut risus.Phasellus aliquam, turpis quis viverra condimentum, risus est pretium    metus, in porta ipsum tortor vitae elit.Pellentesque id finibus erat.  In suscipit, sapien non posuere dignissim, augue nisl ultrices tortor, sit amet eleifend nibh elit at risus.`;

it('should return identical text that chunker was passed, given weird spaces and tiny chunks(1)', () => {
    const maxChunkToken = 1;
    const chunks = getSemanticChunks(testTextShortWeirdSpaces, maxChunkToken);
    expect(chunks.length).toBeGreaterThan(0); //check chunking
    expect(chunks.every(chunk => encode(chunk).length <= maxChunkToken)).toBe(true); //check chunk size
    const recomposedText = chunks.reduce((acc, chunk) => acc + chunk, '');
    expect(recomposedText).toBe(testTextShortWeirdSpaces); //check recomposition
});

it('should return identical text that chunker was passed, given weird spaces and small chunks(10)', () => {
    const maxChunkToken = 1;
    const chunks = getSemanticChunks(testTextShortWeirdSpaces, maxChunkToken);
    expect(chunks.length).toBeGreaterThan(0); //check chunking
    expect(chunks.every(chunk => encode(chunk).length <= maxChunkToken)).toBe(true); //check chunk size
    const recomposedText = chunks.reduce((acc, chunk) => acc + chunk, '');
    expect(recomposedText).toBe(testTextShortWeirdSpaces); //check recomposition
});*/