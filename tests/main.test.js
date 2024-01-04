// main.test.js
// This is where all the Cortex graphQL live server tests go
// It's good to execute this serially and wrap server startup and shutdown around them.

import test from 'ava';
import serverFactory from '../index.js';

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
        query: 'query summary($text: String!) { summary(text: $text) { result } }',
        variables: { text: 'hello there my dear world!' },
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


test('vision test image', async t => {
    const response = await testServer.executeOperation({
        query: `query($text: String, $chatHistory: [MultiMessage]){
            vision(text: $text, chatHistory: $chatHistory) {
              result
            }
          }`,

          variables: {
            "chatHistory": [
              { 
                "role": "user",
                "content": [
                  "{\"type\": \"text\", \"text\": \"first tell me your name then describe the image shortly:\"}",
                  "{\"type\":\"image_url\",\"image_url\":{\"url\":\"https://static.toiimg.com/thumb/msid-102827471,width-1280,height-720,resizemode-4/102827471.jpg\"}}"
                ],
            }],
        },
    });

    t.is(response.body?.singleResult?.errors, undefined);
    t.true(response.body?.singleResult?.data?.vision.result.length > 100);
});


test('vision test base64 image', async t => {
    const response = await testServer.executeOperation({
        query: `query($text: String, $chatHistory: [MultiMessage]){
            vision(text: $text, chatHistory: $chatHistory) {
              result
            }
          }`,

          variables: {
            "chatHistory": [
              { 
                "role": "user",
                "content": [
                  "{\"type\": \"text\", \"text\": \"first tell me your name then describe the image shortly:\"}",
                  "{\"type\":\"image_url\",\"image_url\":{\"url\":\"data:image/jpeg;base64,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\"}}"
                ],
            }],
        },
    });

    t.is(response.body?.singleResult?.errors, undefined);
    t.true(response.body?.singleResult?.data?.vision.result.length > 100);
});


const base64Img = `data:image/jpeg;base64,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`;

test('vision test chunking', async t => {
    t.timeout(400000);
    //generate text adem1 adem2 ... ademN
    // const testText = Array.from(Array(1000000).keys()).map(i => `adem${i}`).join(' ');
    //const testRow = { "role": "user", "content": [`{"type": "text", "text": "${testText}"}`] };

    const base64ImgRow = `{"type":"image_url","image_url":{"url":"${base64Img}"}}`;

    const response = await testServer.executeOperation({
        query: `query($text: String, $chatHistory: [MultiMessage]){
            vision(text: $text, chatHistory: $chatHistory) {
              result
            }
          }`,

          variables: {
            "chatHistory": [
              { 
                "role": "user",
                "content": [
                  "{\"type\": \"text\", \"text\": \"first tell me your name then describe the image shortly:\"}",
                  ...Array.from(new Array(1),()=> base64ImgRow),
                ],
            }],
        },
    });

    t.is(response.body?.singleResult?.errors, undefined);
    t.true(response.body?.singleResult?.data?.vision.result.length > 100);
});


test('vision multi single long text', async t => {
    t.timeout(400000);
    //generate text adem1 adem2 ... ademN
    const testText = Array.from(Array(10).keys()).map(i => `adem${i}`).join(' ');
    const testRow = { "role": "user", "content": [`{"type": "text", "text": "${testText}"}`] };

    const base64ImgRow = `{"type":"image_url","image_url":{"url":"${base64Img}"}}`;

    const response = await testServer.executeOperation({
        query: `query($text: String, $chatHistory: [MultiMessage]){
            vision(text: $text, chatHistory: $chatHistory) {
              result
            }
          }`,

          variables: {
            "chatHistory": [
              ...Array.from(new Array(10),()=> testRow),
              { 
                "role": "user",
                "content": [
                  "{\"type\": \"text\", \"text\": \"first tell me your name then describe the image shortly:\"}",
                  ...Array.from(new Array(10),()=> base64ImgRow),
                ],
              },
            ],
        },
    });

    t.is(response.body?.singleResult?.errors?.[0]?.message, 'Unable to process your request as your single message content is too long. Please try again with a shorter message.');
});


test('vision multi long text', async t => {
    t.timeout(400000);
    //generate text adem1 adem2 ... ademN
    const testText = Array.from(Array(10).keys()).map(i => `adem${i}`).join(' ');
    const testRow = { "role": "user", "content": [`{"type": "text", "text": "${testText}"}`] };

    const base64ImgRow = `{"type":"image_url","image_url":{"url":"${base64Img}"}}`;

    const response = await testServer.executeOperation({
        query: `query($text: String, $chatHistory: [MultiMessage]){
            vision(text: $text, chatHistory: $chatHistory) {
              result
            }
          }`,

          variables: {
            "chatHistory": [
              ...Array.from(new Array(10),()=> testRow),
              { 
                "role": "user",
                "content": [
                  "{\"type\": \"text\", \"text\": \"first tell me your name then describe the image shortly:\"}",
                  ...Array.from(new Array(10),()=> base64ImgRow),
                ],
              },
              { 
                "role": "user",
                "content": [
                  "{\"type\": \"text\", \"text\": \"then tell me your name then describe the image shortly:\"}",
                  ...Array.from(new Array(1),()=> base64ImgRow),
                ],
              },
            ],
        },
    });

    t.is(response.body?.singleResult?.errors, undefined);
    t.true(response.body?.singleResult?.data?.vision.result.length > 100);
});