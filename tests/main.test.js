// main.test.js
// This is where all the Cortex graphQL live server tests go
// It's good to execute this serially and wrap server startup and shutdown around them.

import test from 'ava';
import serverFactory from '../index.js';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let testServer;

test.before(async () => {
  const { server, startServer } = await serverFactory();
  startServer && await startServer();
  testServer = server;
});

test.after.always('cleanup', async () => {
  if (testServer) {
    await testServer.stop();
  }
});

test('validates bias endpoint', async (t) => {
    const response = await testServer.executeOperation({
        query: 'query bias($text: String!) { bias(text: $text) { result } }',
        variables: { text: 'hello there my dear world!' },
    });

    t.is(response.body?.singleResult?.errors, undefined);
    t.regex(response.body?.singleResult?.data?.bias?.result, /(yes|no|bias)/i);
});

test('validates completion endpoint', async (t) => {
    const response = await testServer.executeOperation({
        query: 'query complete($text: String!) { complete(text: $text) { result } }',
        variables: { text: 'hello there my dear world!' },
    });

    t.is(response.body?.singleResult?.errors, undefined);
    t.true(response.body?.singleResult?.data?.complete?.result.length > 0);
});

test('validates entities endpoint with given num of count return', async (t) => {
    const response = await testServer.executeOperation({
        query: 'query entities($text: String!, $count: Int) { entities(text: $text, count: $count){ result { name, definition } } }',
        variables: { text: 'hello there my dear world!', count: 3 },
    });

    t.is(response.body?.singleResult?.errors, undefined);
    t.is(response.body?.singleResult?.data?.entities.result.length, 3);
    response.body?.singleResult?.data?.result?.entities.forEach((entity) => {
        t.truthy(entity.name);
        t.truthy(entity.definition);
    });
});

test('validates paraphrase endpoint', async (t) => {
    const response = await testServer.executeOperation({
        query: 'query paraphrase($text: String!) { paraphrase(text: $text) { result } }',
        variables: { text: 'hello there my dear world!' },
    });

    t.is(response.body?.singleResult?.errors, undefined);
    t.truthy(response.body?.singleResult?.data?.paraphrase?.result);
});

test('validates sentiment endpoint', async (t) => {
    const response = await testServer.executeOperation({
        query: 'query sentiment($text: String!) { sentiment(text: $text) { result } }',
        variables: { text: 'hello there my dear world!' },
    });

    t.is(response.body?.singleResult?.errors, undefined);
    t.truthy(response.body?.singleResult?.data?.sentiment.result);
});

test('validates edit endpoint', async (t) => {
    const response = await testServer.executeOperation({
        query: 'query edit($text: String!) { edit(text: $text) { result } }',
        variables: { text: 'helo there my dear worldd!' },
    });

    t.is(response.body?.singleResult?.errors, undefined);
    t.regex(response.body?.singleResult?.data?.edit.result, /hello.*world/i);
});

test('validates summary endpoint', async (t) => {
    const response = await testServer.executeOperation({
        query: 'query summary($text: String!, $targetLength: Int) { summary(text: $text, targetLength: $targetLength) { result } }',
        variables: { text: 'Now is the time for all good men to come to the aid of their country.  We ride at dawn!', targetLength: 50 },
    });

    t.is(response.body?.singleResult?.errors, undefined);
    t.truthy(response.body?.singleResult?.data?.summary.result);
});

test('chunking test of translate endpoint with huge text', async t => {
    t.timeout(400000);
    const response = await testServer.executeOperation({
        query: 'query translate($text: String!, $to: String) { translate(text: $text, to: $to) { result } }',
        variables: {
            to: 'en',
            text: `Lorem ipsum dolor sit amet, consectetur adipiscing elit. In id erat sem. Phasellus ac dapibus purus, in fermentum nunc. Mauris quis rutrum magna. Quisque rutrum, augue vel blandit posuere, augue magna convallis turpis, nec elementum augue mauris sit amet nunc. Aenean sit amet leo est. Nunc ante ex, blandit et felis ut, iaculis lacinia est. Phasellus dictum orci id libero ullamcorper tempor.

Vivamus id pharetra odio.Sed consectetur leo sed tortor dictum venenatis.Donec gravida libero non accumsan suscipit.Donec lectus turpis, ullamcorper eu pulvinar iaculis, ornare ut risus.Phasellus aliquam, turpis quis viverra condimentum, risus est pretium metus, in porta ipsum tortor vitae elit.Pellentesque id finibus erat.In suscipit, sapien non posuere dignissim, augue nisl ultrices tortor, sit amet eleifend nibh elit at risus.

Donec diam ligula, sagittis ut nisl tincidunt, porta sodales magna.Vestibulum ut dui arcu.Fusce at dolor ex.Aliquam eu justo non libero volutpat pulvinar at id urna.Donec nec purus sed elit bibendum faucibus.Pellentesque habitant morbi tristique senectus et netus et malesuada fames ac turpis egestas.Vivamus iaculis mattis velit, ut lacinia massa lacinia quis.Phasellus porttitor gravida ex, id aliquet eros rhoncus quis.Ut fringilla, lectus a vehicula luctus, diam odio convallis dolor, sodales pharetra nulla ex dictum justo.Ut faucibus, augue quis dictum iaculis, diam leo maximus sapien, sit amet vulputate eros quam sed sem.Cras malesuada, sapien sit amet iaculis euismod, nunc odio lacinia est, dictum iaculis ante nisi in est.Fusce vehicula lorem tellus.Nullam a tempus nisi.

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

Mauris diam dolor, maximus et ultrices sed, semper sed felis.Morbi ac eros tellus.Maecenas eget ex vitae quam lacinia eleifend non nec leo.Donec condimentum consectetur nunc, quis luctus elit commodo eu.Nunc tincidunt condimentum neque, sed porta ligula porttitor et.Suspendisse scelerisque id massa sit amet placerat.Sed eleifend aliquet facilisis.Donec ac purus nec metus vestibulum euismod.Maecenas sollicitudin consequat ornare.Suspendisse pharetra vehicula eros nec malesuada.` },
    });

    t.is(response.body?.singleResult?.errors, undefined);
    t.true(response.body?.singleResult?.data?.translate.result.length > 1000);
});

test('chunking test of translate endpoint with single long text sentence', async t => {
    t.timeout(400000);
    const response = await testServer.executeOperation({
        query: 'query translate($text: String!) { translate(text: $text) { result } }',
        variables: {
            text: `Lorem ipsum dolor sit amet, consectetur adipiscing elit in id erat sem phasellus ac dapibus purus, in fermentum nunc mauris quis rutrum magna Quisque rutrum, augue vel blandit posuere, augue magna convallis turpis, nec elementum augue mauris sit amet nunc Aenean sit amet leo est Nunc ante ex, blandit et felis ut, iaculis lacinia est Phasellus dictum orci id libero ullamcorper tempor Vivamus id pharetra odioSed consectetur leo sed tortor dictum venenatisDonec gravida libero non accumsan suscipitDonec lectus turpis, ullamcorper eu pulvinar iaculis, ornare ut risusPhasellus aliquam, turpis quis viverra condimentum, risus est pretium metus, in porta ipsum tortor vitae elitPellentesque id finibus eratIn suscipit, sapien non posuere dignissim, augue nisl ultrices tortor, sit amet eleifend nibh elit at risus Donec diam ligula, sagittis ut nisl tincidunt, porta sodales magnaVestibulum ut dui arcuFusce at dolor exAliquam eu justo non libero volutpat pulvinar at id urnaDonec nec purus sed elit bibendum faucibusPellentesque habitant morbi tristique senectus et netus et malesuada fames ac turpis egestasVivamus iaculis mattis velit, ut lacinia massa lacinia quisPhasellus porttitor gravida ex, id aliquet eros rhoncus quisUt fringilla, lectus a vehicula luctus, diam odio convallis dolor, sodales pharetra nulla ex dictum justoUt faucibus, augue quis dictum iaculis, diam leo maximus sapien, sit amet vulputate eros quam sed semCras malesuada, sapien sit amet iaculis euismod, nunc odio lacinia est, dictum iaculis ante nisi in estFusce vehicula lorem tellusNullam a tempus nisiSed ut lectus nec ligula blandit tempusDonec faucibus turpis id urna vehicula imperdietDuis tempor vitae orci interdum dignissimPhasellus sed efficitur semNullam accumsan, turpis vitae consectetur ullamcorper, lectus purus tincidunt nisi, in pulvinar leo tortor at semDonec at feugiat dui, nec rhoncus nibhNam faucibus ultrices nisl at lobortisMorbi congue, nisl vel fermentum tristique, dui ipsum rhoncus massa, non varius nibh massa in turpisVestibulum vulputate, felis quis lacinia porta, nulla ex volutpat lorem, non rhoncus neque erat quis arcuMorbi massa nisl, hendrerit eget tortor condimentum, lobortis dapibus semAliquam ut dapibus elitSed porta dignissim anteNullam interdum ligula et massa vehicula, vel gravida diam laoreetVivamus et enim eget turpis pellentesque laoreetVivamus pellentesque neque et mauris imperdiet pulvinar Aliquam eget ligula congue, tincidunt magna eu, rutrum urnaSed consequat orci est, vel laoreet magna tincidunt sit ametCurabitur eget condimentum odio, vitae condimentum elitDuis viverra lobortis magnaPellentesque habitant morbi tristique senectus et netus et malesuada fames ac turpis egestasSed facilisis mi eu scelerisque pharetraCras et massa odioPraesent quis nulla vitae mi blandit egestas ac vitae liberoCras ultricies ex non consequat scelerisqueNulla et est ac sem placerat convallis ac vitae massaPhasellus lobortis mauris vel est vehicula lobortisCurabitur ipsum ipsum, ullamcorper eget placerat sit amet, dapibus iaculis dui Phasellus facilisis rutrum metus nec euismod.`
        }
    });

    t.is(response.body?.singleResult?.errors, undefined);
    t.true(response.body?.singleResult?.data?.translate.result.length > 200);
});

test('chunking test of translate endpoint with two long text sentence', async t => {
    t.timeout(400000);
    const response = await testServer.executeOperation({
        query: 'query translate($text: String!) { translate(text: $text) { result } }',
        variables: {
            text: `I love coding. I like coding. Lorem ipsum dolor sit amet, consectetur adipiscing elit in id erat sem phasellus ac dapibus purus, in fermentum nunc mauris quis rutrum magna Quisque rutrum, augue vel blandit posuere, augue magna convallis turpis, nec elementum augue mauris sit amet nunc Aenean sit amet leo est Nunc ante ex, blandit et felis ut, iaculis lacinia est Phasellus dictum orci id libero ullamcorper tempor Vivamus id pharetra odioSed consectetur leo sed tortor dictum venenatisDonec gravida libero non accumsan suscipitDonec lectus turpis, ullamcorper eu pulvinar iaculis, ornare ut risusPhasellus aliquam, turpis quis viverra condimentum, risus est pretium metus, in porta ipsum tortor vitae elitPellentesque id finibus eratIn suscipit, sapien non posuere dignissim, augue nisl ultrices tortor, sit amet eleifend nibh elit at risus Donec diam ligula, sagittis ut nisl tincidunt, porta sodales magnaVestibulum ut dui arcuFusce at dolor exAliquam eu justo non libero volutpat pulvinar at id urnaDonec nec purus sed elit bibendum faucibusPellentesque habitant morbi tristique senectus et netus et malesuada fames ac turpis egestasVivamus iaculis mattis velit, ut lacinia massa lacinia quisPhasellus porttitor gravida ex, id aliquet eros rhoncus quisUt fringilla, lectus a vehicula luctus, diam odio convallis dolor, sodales pharetra nulla ex dictum justoUt faucibus, augue quis dictum iaculis, diam leo maximus sapien, sit amet vulputate eros quam sed semCras malesuada, sapien sit amet iaculis euismod, nunc odio lacinia est, dictum iaculis ante nisi in estFusce vehicula lorem tellusNullam a tempus nisiSed ut lectus nec ligula blandit tempusDonec faucibus turpis id urna vehicula imperdietDuis tempor vitae orci interdum dignissimPhasellus sed efficitur semNullam accumsan, turpis vitae consectetur ullamcorper, lectus purus tincidunt nisi, in pulvinar leo tortor at semDonec at feugiat dui, nec rhoncus nibhNam faucibus ultrices nisl at lobortisMorbi congue, nisl vel fermentum tristique, dui ipsum rhoncus massa, non varius nibh massa in turpisVestibulum vulputate, felis quis lacinia porta, nulla ex volutpat lorem, non rhoncus neque erat quis arcuMorbi massa nisl, hendrerit eget tortor condimentum, lobortis dapibus semAliquam ut dapibus elitSed porta dignissim anteNullam interdum ligula et massa vehicula, vel gravida diam laoreetVivamus et enim eget turpis pellentesque laoreetVivamus pellentesque neque et mauris imperdiet pulvinar Aliquam eget ligula congue, tincidunt magna eu, rutrum urnaSed consequat orci est, vel laoreet magna tincidunt sit ametCurabitur eget condimentum odio, vitae condimentum elitDuis viverra lobortis magnaPellentesque habitant morbi tristique senectus et netus et malesuada fames ac turpis egestasSed facilisis mi eu scelerisque pharetraCras et massa odioPraesent quis nulla vitae mi blandit egestas ac vitae liberoCras ultricies ex non consequat scelerisqueNulla et est ac sem placerat convallis ac vitae massaPhasellus lobortis mauris vel est vehicula lobortisCurabitur ipsum ipsum, ullamcorper eget placerat sit amet, dapibus iaculis dui Phasellus facilisis rutrum metus nec euismod.Lorem ipsum dolor sit amet, consectetur adipiscing elit in id erat sem phasellus ac dapibus purus, in fermentum nunc mauris quis rutrum magna Quisque rutrum, augue vel blandit posuere, augue magna convallis turpis, nec elementum augue mauris sit amet nunc Aenean sit amet leo est Nunc ante ex, blandit et felis ut, iaculis lacinia est Phasellus dictum orci id libero ullamcorper tempor Vivamus id pharetra odioSed consectetur leo sed tortor dictum venenatisDonec gravida libero non accumsan suscipitDonec lectus turpis, ullamcorper eu pulvinar iaculis, ornare ut risusPhasellus aliquam, turpis quis viverra condimentum, risus est pretium metus, in porta ipsum tortor vitae elitPellentesque id finibus eratIn suscipit, sapien non posuere dignissim, augue nisl ultrices tortor, sit amet eleifend nibh elit at risus Donec diam ligula, sagittis ut nisl tincidunt, porta sodales magnaVestibulum ut dui arcuFusce at dolor exAliquam eu justo non libero volutpat pulvinar at id urnaDonec nec purus sed elit bibendum faucibusPellentesque habitant morbi tristique senectus et netus et malesuada fames ac turpis egestasVivamus iaculis mattis velit, ut lacinia massa lacinia quisPhasellus porttitor gravida ex, id aliquet eros rhoncus quisUt fringilla, lectus a vehicula luctus, diam odio convallis dolor, sodales pharetra nulla ex dictum justoUt faucibus, augue quis dictum iaculis, diam leo maximus sapien, sit amet vulputate eros quam sed semCras malesuada, sapien sit amet iaculis euismod, nunc odio lacinia est, dictum iaculis ante nisi in estFusce vehicula lorem tellusNullam a tempus nisiSed ut lectus nec ligula blandit tempusDonec faucibus turpis id urna vehicula imperdietDuis tempor vitae orci interdum dignissimPhasellus sed efficitur semNullam accumsan, turpis vitae consectetur ullamcorper, lectus purus tincidunt nisi, in pulvinar leo tortor at semDonec at feugiat dui, nec rhoncus nibhNam faucibus ultrices nisl at lobortisMorbi congue, nisl vel fermentum tristique, dui ipsum rhoncus massa, non varius nibh massa in turpisVestibulum vulputate, felis quis lacinia porta, nulla ex volutpat lorem, non rhoncus neque erat quis arcuMorbi massa nisl, hendrerit eget tortor condimentum, lobortis dapibus semAliquam ut dapibus elitSed porta dignissim anteNullam interdum ligula et massa vehicula, vel gravida diam laoreetVivamus et enim eget turpis pellentesque laoreetVivamus pellentesque neque et mauris imperdiet pulvinar Aliquam eget ligula congue, tincidunt magna eu, rutrum urnaSed consequat orci est, vel laoreet magna tincidunt sit ametCurabitur eget condimentum odio, vitae condimentum elitDuis viverra lobortis magnaPellentesque habitant morbi tristique senectus et netus et malesuada fames ac turpis egestasSed facilisis mi eu scelerisque pharetraCras et massa odioPraesent quis nulla vitae mi blandit egestas ac vitae liberoCras ultricies ex non consequat scelerisqueNulla et est ac sem placerat convallis ac vitae massaPhasellus lobortis mauris vel est vehicula lobortisCurabitur ipsum ipsum, ullamcorper eget placerat sit amet, dapibus iaculis dui Phasellus facilisis rutrum metus nec euismod.`
        }
    });

    t.is(response.body?.singleResult?.errors, undefined);
    t.true(response.body?.singleResult?.data?.translate.result.length > 500);
});

test('chunking test...', async t => {
    t.timeout(400000);
    const response = await testServer.executeOperation({
        query: 'query translate($text: String!, $to: String) { translate(text: $text, to: $to) { result } }',
        variables: {
            to: 'en',
            text: `
            صعدت روسيا هجماتها في أنحاء أوكرانيا، بعد يوم من إعلان الغرب مدّ كييف بدبابات قتالية، واستهدفت عشرات الصواريخ والمسيّرات الروسية العاصمة الأوكرانية ومدنا في الجنوب والشرق، واعتبر الكرملين أن الدبابات لن تغيّر من طبيعة المعركة، في حين أعلنت وزارة الدفاع الأوكرانية أن هناك تحضيرات قتالية روسية انطلاقا من القرم.

فقد شنّت القوات الروسية ضربات صاروخية في أنحاء مختلفة من أوكرانيا؛ من بينها 37 غارة جوية و10 ضربات صاروخية ليلية استهدفت البنية التحتية في دنيبرو ومناطق أخرى، مما دفع الجيش الأوكراني إلى إعلان عن حالة التأهب القصوى في عموم أراضي البلاد.

كما شمل القصف والغارات العاصمة كييف التي استيقظ سكانها على وقع أصوات الانفجارات بعد استهداف القوات الروسية لها بأكثر من 15 صاروخ "كروز"، قالت السلطات الأوكرانية إن دفاعاتها الجوية نجحت في إسقاطها جميعها.

وأكدت السلطات العسكرية في كييف تصدّي الدفاعات الجوية الأوكرانية للصواريخ الروسية التي وجهت نحو المدينة، لكنها دفعت بعدد كبير من سكانها إلى النزول إلى الملاجئ والبقاء فيها، بعد تأكيد المجلس الإقليمي في كييف أن خطر الضربات الجوية لم ينته.

وفي وقت سابق، أعلن عمدة كييف فيتالي كليتشكو مقتل شخص وإصابة اثنين بهجوم صاروخي روسي استهدف مبنى غير سكني بمنطقة هولوسيفسكي بالمدينة، وأكد -في منشور على تليغرام- وقوع انفجارات متفرقة في المدينة وحث السكان على الاحتماء.

وتشتد المواجهات بين الطرفين في الجبهة الجنوبية حيث قصفت القوات الروسية مناطق عدة لا سيما في مقاطعة خيرسون جنوبا، كما أعلنت الدفاعات الأوكرانية إسقاط صواريخ روسية في سماء مقاطعة ميكولايف، واستهدفت الصواريخ الروسية كذلك منشآت للطاقة في مقاطعة أوديسا على ساحل البحر الأسود جنوبا وتسببت في انقطاع التيار الكهربائي.

وفي الجبهة الشرقية، على ضفاف نهر دنيبرو، تعرضت مدينة زاباروجيا لهجمة صاروخية روسية جديدة. كما أعلن الدفاع الجوي الأوكراني رصد صاروخين موجهين نحو مقاطعة دنيبرو، في مدينة كريفيري غربي المقاطعة.

في الأثناء، أعلنت سلطات دونيتسك الموالية لروسيا دخول القوات الروسية مدينة أوغليدار، وتعزيز مواقعها في ضواحيها.

وتزامن التصعيد العسكري الروسي أيضا مع تحذير أوكراني من تحضيرات قتالية روسية انطلاقا من القرم؛ حيث قال المتحدث باسم هيئة الأركان الأوكرانية أولكسندر شتوبون إن موسكو تعدّ لعملية تعبئة جديدة في المنطقة.

وبالتوازي مع تحركات روسية في القرم أكدت الاستخبارات الأوكرانية حاجة القوات الأوكرانية إلى مزيد من المدفعية البعيدة المدى، لضرب التعزيزات الروسية التي تصل من شبه جزيرة القرم، وقالت إن الروس ينقلون ذخيرة وعتادا إلى مستودعات تبعد عن خطوط الجبهة الجنوبية أكثر من 80 كيلومترا.

وتأتي التطورات العسكرية في أوكرانيا في ظل تأكيد عدد من الدول الأوروبية، بينهما ألمانيا، إرسال دبابات "ليوبارد2" إلى الجيش الأوكراني.

وتخشى دول حلف شمال الأطلسي (ناتو) أن تتسبب بعض الإمدادات العسكرية إلى أوكرانيا بتصعيد وتيرة الصراع وتحويله إلى حرب مباشرة مع روسيا.

دبابات.. وعيد وتصعيد

ورافق الرد العسكري الروسي على إعلان تزويد أوكرانيا بالدبابات تصعيد على مستوى التصريحات أيضا.

فبعد توعد موسكو هذه الدبابات بالحرق، اعتبر المتحدث باسم الكرملين ديمتري بيسكوف تزويد أوكرانيا بالدبابات الغربية انخراطا مباشرا في الصراع، ودليلا على التورط الأميركي والأوروبي المباشر والمتزايد في هذه الحرب، وفق تعبيره.

وأكد بيسكوف أنه لا نية لدى موسكو لتغيير وضع العملية العسكرية الخاصة في أوكرانيا، بعد إرسال الدبابات إلى كييف.

بدوره، قال رئيس لجنة مجلس الدوما الروسي للشؤون الدولية ليونيد سلوتسكي إن كتيبة الدبابات الأميركية لن تساعد الرئيس الأوكراني فولوديمير زيلينسكي على تغيير مسار العملية الروسية في أوكرانيا ولا الوضع في شبه جزيرة القرم، حسب تعبيره.

وأضاف أيضا أن أي محاولة للاستيلاء على شبه الجزيرة القرم ستلقى ردا قاسيا، مؤكدا أن الهجوم الروسي لن يوقفه إمداد آخر من الأسلحة الغربية.

تنديد أميركي

من جانبها، نددت الولايات المتحدة الأميركية، اليوم الخميس، بالهجمات الصاروخية الروسية التي استهدفت العاصمة الأوكرانية كييف.

ووصفت السفيرة الأميركية لدى كييف بريدغيت برينك، في تغريدة، الهجمات الورسية بأنها "عنيفة" وتتبع "الفشل الإستراتيجي نفسه".

وأضافت "لا يمكن لموجة الهجمات الروسية بالصواريخ والمسيرات أن توقف المدافعين الأبطال عن أوكرانيا، ولا شعبها الشجاع، ولا دعمنا الحاسم والموحد لأوكرانيا".

دبابات "تشالنجر2"

وفي تطور آخر، قال وزير الدولة البريطاني لشؤون الدفاع أليكس تشوك إن من المقرر أن تدخل دبابات "تشالنجر2" البريطانية مسرح العمليات العسكرية في أوكرانيا بنهاية مارس/آذار المقبل.

وأضاف وزير الدولة البريطاني لشؤون الدفاع، في مؤتمر صحفي، أن بلاده قدمت 200 عربة مدرعة لأوكرانيا حتى الآن، وأن تدريب القوات الأوكرانية على استخدام دبابات "تشالنجر2" سيبدأ الأسبوع المقبل.

ورحب الوزير البريطاني بقرار ألمانيا إرسال دبابات "ليوبارد2″، وقرار الولايات المتحدة إرسال دبابات "أبرامز" لأوكرانيا.

وأعلن أمس الأربعاء الرئيس الأميركي جو بايدن أن الولايات المتحدة سترسل 31 دبابة من طراز "إم1 أبرامز" القتالية إلى أوكرانيا، وذلك عقب ساعات من تأكيد ألمانيا أنها ستنقل إلى حكومة كييف 14 من دباباتها من طراز "ليوبارد2″، وإعلان مشابه من النرويج ودول أوروبية أخرى، الأمر الذي رحب به الناتو، ووصفته أوكرانيا بـ"حلف الدبابات الكبير".`
        }
    });

    t.is(response.body?.singleResult?.errors, undefined);
    t.true(response.body?.singleResult?.data?.translate.result.length > 500);
});

test('test translate endpoint with huge arabic text english translation and check return non-arabic/english', async t => {
    const response = await testServer.executeOperation({
        query: 'query translate($text: String!, $to:String) { translate(text: $text, to:$to) { result } }',
        variables: {
            to: 'English',
            text: `
طهران- ما عدا فترات قصيرة ساد خلالها الهدوء في علاقات إيران الخارجية، فإن ملفات طهران حافظت على سخونتها منذ الثورة الإيرانية عام 1979 حتی اليوم، فما إن تهدأ قضية حتى تعود أخرى إلى الواجهة على هيئة احتجاج في الداخل أو توتر في علاقات طهران مع دول إقليمية أو غربية.

ومع الاحتجاجات التي انطلقت شرارتها إثر وفاة الشابة مهسا أميني في منتصف أيلول/سبتمبر الماضي، عاد التوتر إلى العلاقات الإيرانية الأوروبية من جديد، مما أبرز علامات استفهام كبيرة عن سبب تكرار الاحتجاجات، ومستقبل المفاوضات النووية، وعلاقات طهران مع دول الجوار، وعما إذا كانت ستغيّر موقفها من القضية الفلسطينية.

وفي حوار خاص للجزيرة نت مع السياسي الإيراني المحافظ محمد رضا باهنر، عضو مجمع تشخيص مصلحة النظام والأمين العام للجمعية الإسلامية للمهندسين، الذي سبق أن حافظ علی معقده في البرلمان الإيراني طوال 28 عاما؛ استبعد أن تكون قضية وفاة الشابة مهسا أميني هي السبب الرئيسي للاحتجاجات، بل علق الأمر على التدخلات الخارجية التي سعت إلى التجييش ضد النظام الإيراني.

وفيما يأتي نص الحوار:

باهنر أقرّ بوجود أخطاء وتقصير في عمل المؤسسات الإيرانية لكن السلطة القضائية والأجهزة الرقابية تحاول علاجها (الجزيرة)

شهدت الساحة الإيرانية خلال الأشهر الأخيرة احتجاجات شعبية واسعة، لكنها ليست الوحيدة خلال العقود الماضية. برأيك ما أسباب تكرار الاحتجاجات في إيران؟

خلافا للمناورات الإعلامية التي تحاول تقديم موضوع الحجاب ووفاة الشابة مهسا أميني علی أنه السبب الأساس لانطلاقة هذه الاحتجاجات، فإنني أرى أن التطورات في الداخل الإيراني مرتبطة ارتباطا وثيقا بالمستجدات الدولية والتهديدات الموجهة للجمهورية الإسلامية منذ عام 1979. لكن هذه المرة كانت الحرب الناعمة ضدنا شاملة وهجينة على مختلف الجبهات الداخلية والخارجية.

هناك تحليلات متفاوتة عن سبب خوض العدو غمار المعركة الشاملة ضد إيران في المرحلة الراهنة، بين من يرى أن الأخيرة تعيش مرحلة الضعف وفقدت قاعدتها الاجتماعية جراء تردي الوضع المعيشي وفاعلية العقوبات الخارجية، في حين يرى آخرون أن فتح جبهة محدّدة ضد إيران أثبت فشله، حيث استطاعت طهران خلال العقود الماضية لملمة جراحها وتجاوز العديد من الأزمات، وبالتالي لا بد من فتح عدة جبهات ضدها في آن واحد.

أما الفئة أخرى، فإنها تؤمن بضرورة النيل من إيران في أي وقت وبشتى الأدوات وأينما سنحت الفرصة لوضع حد لتطورها المتنامي، وهذا تحليل ضعيف جدا. في الوقت ذاته، هناك من يعتبر السياسات الإيرانية هجومية ويخشى تداعياتها على الصعيدين الإقليمي والدولي، وهذا ما أدى إلى تقاطع مصالح العديد من الجهات بشأن الملف الإيراني والتخويف من سياسات طهران؛ مما أدى بأطراف خارجية أن تشن حربا هجينة ضد إيران في المرحلة الراهنة، انطلاقا من تقارير مفبركة كانت قد تلقتها عن تدهور الحالة الصحية للمرشد الأعلى آية الله علي خامنئي، في حين أن العدو كان قد خطط لإطلاق عملياته في الفترة المقبلة، وأن وفاة الشابة مهسا أميني ليست سوى ذريعة لإطلاق شرارة العمليات المعدة مسبقا ضدنا.

هذا عن دور الجانب الخارجي في الاحتجاجات، لكن ماذا عن العوامل الداخلية؟

لم ندّعِ يوما أن سلوك المؤسسات الإيرانية وكوادرها لا يعتريه التقصير والقصور، بل هنالك أخطاء ومشكلات دون أدنى شك. في المقابل تعمل السلطة القضائية والأجهزة الرقابية بعزيمة عالية على معاقبة المقصّرين وجبر خواطر الضحايا وذويهم قدر المستطاع، لكن هذا لا يبرر فبركة شتى أنواع الاتهامات بحق الدولة والتآمر ضدها.

نعتقد أنه كان بالإمكان تفادي جزء من الغضب الشعبي الناجم عن عمليات الحرب الناعمة، من خلال الإسراع في تشكيل لجنة تقصي حقائق والإعلان عن سبب وفاة الشابة مهسا أميني ومعاقبة المقصّرين المحتملين.

قبل شهرين من قضية مهسا، كان المجلس الأعلى للثورة الثقافية قد عمّم قرارا يؤكد ضرورة وقف العنف والاستعانة بالشرطة الأخلاقية (دوريات الإرشاد) في تطبيق قانون الحجاب، والتركيز على جانب الأمر بالمعروف والنهي عن المنكر. ومما لا شك فيه، فإن عدم أخذ القرار على محمل الجد نجم عن غفلة بعض الجهات الإيرانية، مما كلف البلاد غاليا خلال فترة الاحتجاجات، كما أننا لا ننكر تردي الوضع الاقتصادي والمعيشي ودوره في اعتراض شريحة من أبناء الشعب الإيراني، لكن هنا لا بد من التفريق بين الحراك المطلبي وأعمال الشغب.

نعتقد أن أقل من 3% من الشعب الإيراني قاموا بصب الزيت على النار خلال التطورات الأخيرة. وفي المقابل، هناك غالبية أعلنت ولاءها للنظام الإسلامي من خلال المشاركة في المسيرات الداعمة للجمهورية الإسلامية.

لا نريد التقليل من نسبة المعاندين والمعارضين للنظام الإيراني، بل نعتقد أن هذه النسبة كبيرة، ويتعيّن علينا فتح قنوات اتصال وحوار معهم، لتحويل المعاند إلى معارض وتبديل المعارض إلى محايد، واستقطاب المحايد وتحويله إلى موالٍ. للأسف نسمع بعض الأصوات المتطرفة في الداخل الإيراني تعمل على طرد كل الذين لا ينتمون إلى معسكر الموالين للنظام.

هل هناك آلية بالفعل للمصالحة بين النظام الإيراني والمحتجين؟

بعد الاحتجاجات الأخيرة التي شهدتها البلاد، قدمت خطة إلى السلطات المعنية، سبق أن تم إعدادها بناء على دراسات علمية، من أجل تقريب وجهات النظر وتكريس ثقافة الحوار بين شرائح الشعب الإيراني. نعتقد أننا ابتعدنا قليلا عن الثقافة التي كانت تشجع على حرية التعبير عقب الثورة الإيرانية عام 1979. ويمكن تلخيص محاور الخطة الرئيسية كالتالي:

إطلاق كرسي الحوار في الجامعات الإيرانية، وتوفير أماكن للاعتراض والاحتجاج، والاعتراف بحق مختلف الأطياف السياسية والاجتماعية في المشاركة بالحكم، وتوفير الأرضية للمنافسة السليمة بينها، وتعديل الأخطاء الموجودة في منظومة الحكم.

وقد تجاوب كل من الرئيس إبراهيم رئيسي ورئيس السلطة القضائية مع هذه الخطة، وهناك جلسات عقدت وتعقد من أجل تعديلها ورسم خارطة طريق لتطبيقها في الفترة المقبلة، وسوف نتابع تنفيذها من خلال مجمع تشخيص مصلحة النظام.

نسمع منذ فترة أصواتا تنادي بتعديل الدستور الإيراني وإجراء استفتاء عام لإخراج البلاد من الأزمات، هل تتابعون هذه المطالب في إطار الخطة التي تقدمتم بها؟

موضوع الاستفتاء بشأن نوعية النظام السياسي في البلاد أصبح في خبر كان، لأنه تم إجراء هذا الاستفتاء عقب الثورة الإيرانية وصوتت غالبية الشعب الإيراني لصالح الجمهورية الإسلامية، ولا توجد مثل هذه البدعة التي يطالب بها البعض في أي من الدول الأخرى.

أما بخصوص تعديل بعض المواد القانونية في الدستور الإيراني، فإنه لا يمانع أحد مثل هذا التوجه المنصوص عليه في المادة 177 من الدستور نفسه، ما عدا المواد القانونية التي تتضمن جمهورية النظام وإسلاميته. لكن هل نعتزم تعديل بعض مواد الدستور خلال الفترة القصيرة المقبلة؟ إن الجواب بالنفي، وذلك بالرغم من أننا نشاطر الأصوات التي تطالب بتعديل الدستور، لأن هذه المطالب كبيرة ومتضاربة في بعض الأحيان وتشمل طيفا موسعا من المواد الدستورية. نؤمن بضرورة تعديل الدستور، لكن لا بد من إجماع الأوساط الفكرية على المواد المراد تعديلها، وحينها سيكون إجراء الاستفتاء على المواد المعدلة لازما.

ووفق المادة 177 من الدستور الإيراني، تتم المراجعة بأمر من المرشد الأعلى إلى الرئيس، وذلك بعد التشاور مع مجمع تشخيص مصلحة النظام، لإعادة النظر في المواد التي يلزم تعديلها أو إضافتها من قبل مجلس يتألف من:

أعضاء مجلس صيانة الدستور.

رؤساء السلطات الثلاث.

الأعضاء الدائمين في مجمع تشخيص مصلحة النظام.

5 من أعضاء مجلس خبراء القيادة.

10 أشخاص يعيّنهم المرشد.

3 من المجلس الوزاري.

3 من السلطة القضائية.

10 من نواب البرلمان.

3 أكاديميين.

وتطرح قرارات هذا المجلس على الاستفتاء العام بعد توقيعها من قبل المرشد، وتصبح سارية المفعول في حال حازت على موافقة الأكثرية المطلقة من المشاركين في الاستفتاء.

أحد أسباب تردي الوضع الاقتصادي الناتج عن العقوبات المالية يعود إلى عدم موافقة طهران على اتفاقيات "فاتف" (FATF) المتعلقة بمكافحة غسيل الأموال وتمويل الإرهاب، لماذا لم تحسم هذه القضية حتى الآن؟

لدينا خلاف بين البرلمان ومجلس صيانة الدستور بشأن قوانين مجموعة العمل المالي، مما أدى إلى إحالة القضية إلى مجمع تشخيص مصلحة النظام الذي لم يحسم بدوره الأمر لأسباب مختلفة منها تضارب آراء أعضائه، وهناك قانون ينص على أنه في حال عدم بت المجمع في قضية ما خلال عام من إحالتها إليه، فإن القرار سيكون لصالح مجلس صيانة الدستور الذي يعارض المصادقة على قوانين فاتف في هذه القضية.

أود أن أقول هنا إن رأي الحكومة مؤثر في إقناع الأعضاء في مجمع مصلحة النظام، وإذا كانت حكومة إبراهيم رئيسي ترى مصلحة في المصادقة على هذه القوانين فيمكنها الإدلاء برأيها ومطالبة المجمع بالبت من جديد في القضية، وحينها سنكون في المجمع على استعداد لتسهيل الأمر في هذا الملف.

أشرت أكثر من مرة إلى دور سلبي تلعبه جهات أجنبية ضد طهران بما في ذلك في الاحتجاجات الأخيرة، ما سبب هذا العداء الخارجي للنظام الإيراني؟

منذ حقبة الرئيس الأسبق محمود أحمدي نجاد، وطرحه موضوع محرقة الهولوكوست وصدور قرارات أممية ضد إيران، بدأ المجتمع الدولي باتهام طهران بتبني سياسة هجومية، مما مهّد الطريق لعمل بعض الجهات على التخويف من إيران، في ظل غفلة الأخيرة من مخاطر هذا التوجه الدولي وعدم التحرك الجاد لإبطال مفعول الدعاية المضللة التي يقوم بها العدو.

لقد وجد العدو في بعض الملفات الإيرانية -مثل برنامجها النووي وقدراتها العسكرية- ذريعة للضغط على طهران، ولمطالبتها بالتخلي عن مرتكزات قوتها، بينما هذه البرامج ردعية وتهدف إلى ضمان المصالح الوطنية، ولولا القدرات التي توصل إليها الإيرانيون خلال العقود الماضية لتمت مهاجمة الجمهورية الإسلامية حتى الآن.

ألا تظنون أن البرنامج النووي كلف البلاد أكثر من طاقاتها؟

العالم الغربي ينتهج سياسة مزدوجة حيال البرنامج النووي الإيراني، إذ يغض البصر عن البرنامج النووي الإسرائيلي ويبذل ما في وسعه للضغط على إيران، بالرغم من إصدار المرجعية الدينية في إيران فتوى تحرّم تصنيع وحيازة السلاح النووي، ناهيك عن أن الدول الدائمة العضوية في مجلس الأمن الدولي تمتلك أسلحة نووية، لكنها تعارض تطوير الدول الأخرى طاقاتها النووية بذريعة الحد من انتشار أسلحة الدمار الشامل.

هناك استخدامات عديدة للطاقة النووية وتقنياتها، أبرزها في المجالات الطبية والدواء والكهرباء والزراعة؛ والجانب العسكري ليس سوى أحد هذه المجالات. أعداء إيران يريدون حرمانها من كل هذه الاستخدامات السلمية، لأن هناك آليات بالفعل لمنع الدول من بلوغ العتبة النووية والتحرك نحو تصنيع أسلحة نووية، وقد تم الاتفاق بين إيران والمجموعة السداسية عام 2015 علی إطالة أمد بلوغ طهران العتبة النووية في إطار الاتفاق النووي، لكن الولايات المتحدة هي التي انتهكت الاتفاق وانسحبت منه عام 2018 وأعادت العقوبات الأحادية على إيران.

ورغم تعنت الجانب الغربي في المفاوضات النووية طوال العامين الماضيين، فإن طهران على استعداد لاستئناف المفاوضات الرامية لإحياء الاتفاق النووي، لكننا بحاجة إلى ضمانات بشأن وفاء الطرف المقابل بتعهداته.

هناك اتهامات متكررة بشأن تدخل إيران في الشؤون الداخلية للدول العربية، كيف تعلقون على ذلك؟

الوثيقة العشرينية الموسومة بـ"إيران في أفق 2025″ التي صدرت عام 2003، تؤكد بوضوح على ضرورة تعاون طهران مع جميع دول العالم ما عدا الكيان الصهيوني الذي لم تعترف به الجمهورية الإسلامية، ومنذ ذلك الحين لم نغيّر في سياساتنا، ولا سيما تجاه الدول الجوار، لكن روّج العدو لمقولة تصدير الثورة الإسلامية للخارج، ودق الإسفين بيننا وبين الدول الإسلامية، في حين أن المقصود من تصدير الثورة هو تبيين مبادئها وثقافتها الإسلامية، بعيدا عن كل الشائعات الرامية إلى التخويف من الجمهورية الإسلامية بسبب موقفها المبدئي تجاه الكيان الصهيوني. لعل أبرز نقطة خلافية بين طهران والولايات المتحدة هي موقف الجمهورية الإسلامية من الكيان الصهيوني.

ولا ننكر أن ما وصلت إليه العلاقات الإيرانية العربية خلال السنوات الماضية كان نابعا عن غفلتنا إزاء مخططات أعداء الأمة الإسلامية، في حين أن المصالح والقواسم المشتركة بين الشعب الإيراني والشعوب العربية والإسلامية أكبر بكثير من النقاط الخلافية بينهما، ونستغل هذه المقابلة لندعو هنا إلى حوار عادل لوضع حدّ لهذه الاتهامات وإحلال الوفاق والوئام في المنطقة.

الشعب الإيراني دفع ضريبة رفع الجمهورية الإسلامية شعار القضاء على إسرائيل، ألا تزال إيران متحمسة لهذا الشعار؟

لقد أكد مؤسس الجمهورية الإسلامية آية الله الخميني مرارا أن الثورة الإسلامية ترتبط ارتباطا وثيقا بالقضية الفلسطينية، ولا يمكن تفكيكهما، ولا تغيير بعد في موقف طهران الثابت حيال تحرير القدس مهما عظمت الضريبة التي ندفعها.

نحن أعلنّا أنه يجب إزالة الكيان الصهيوني، لكننا لم نعلن يوما أننا نريد الهجوم عسكريا للقضاء عليه، لكن مما لا شك فيه أننا سندعم حلفاءنا في أي مواجهة مع الكيان الصهيوني، في حين أن الولايات المتحدة تعلن باستمرار أنها تريد تغيير النظام في إيران بسبب سياساتها المناوئة للكيان الصهيوني، لكنها تعرف جيدا أن طهران لن تقف مكتوفة الأيدي تجاه أي اعتداء على مصالحها، وفي نهاية المطاف تقديرنا أن الاحتلال الإسرائيلي لن يستمر في الأراضي الفلسطينية، وأن أولى القبلتين سوف تتحرر ولو بعد حين.
` },
    });

    t.falsy(response.body?.singleResult?.errors);
    t.true(response.body?.singleResult?.data?.translate.result.length > 1000); // check return length huge
    // check return only contains non-Arabic characters
    t.notRegex(response.body?.singleResult?.data?.translate.result, /[ء-ي]/);
});





