const { getTestServer } = require('./main.test');

jest.setTimeout(1800000);

const testServer = getTestServer();

it('styleguidemulti test', async () => {
    const response = await testServer.executeOperation({
        query: 'query styleguidemulti($text: String!) { styleguidemulti(text: $text) { result } }',
        variables: {
            text: `
            "Doctors should better familiarise themselves with the symptoms of long COVID, according to the lead author of a newly published series of papers," said the Canadian Medical Association Journal. The papers "aim to help clinicians diagnose, assess and treat the condition affecting an estimated 1.4 million people in Canada."

Kieran Quinn, a clinician-scientist studying long COVID (known medically as post-COVID-19 condition), said many patients with lingering symptoms after an infection report that doctors seem uncomfortable broaching the issue because they don't know what to do. Other patients are put through numerous diagnostic tests and consultations with specialists, only to have their results appear "normal," he said.

"It just became very apparent in discussions with our patients and with our colleagues that there was an opportunity and a need to help educate society and our providers," said Dr. Quinn, who is an assistant professor in the University of Toronto's department of medicine.

In three papers published in the CMAJ (Canadian Medical Association Journal) on Tuesday, he and his colleagues outline some of the main issues clinicians should know about the condition, including its characteristics, hypothesised mechanisms and prevalence. (The World Health Organisation defines long COVID as symptoms that continue or develop three months after a COVID-19 infection and that can't be explained by an alternative diagnosis.)

The papers also feature guidance on some of the most common symptoms associated with the condition, such as fatigue, depression and anxiety, shortness of breath, sleep disturbance and heart palpitations.

In Canada, 47 per cent of adults with long COVID experienced symptoms for a year or more, according to government survey results released in October. Twenty-one per cent said their symptoms often or always limited their daily activities.

Dr. Quinn and his colleagues recommend a tailored approach for managing fatigue and post-exertional malaise - that is, when symptoms worsen after exertion. This involves advising patients to pace themselves and prioritise their activities, modifying as necessary.

They note that psychosocial interventions and medications may be used to treat the mental health complications of long COVID, which include anxiety, depression and post-traumatic stress disorder. Counselling about sleep hygiene, relaxation techniques, cognitive behavioural therapy and medication may help manage sleep disturbances.

Last week, Ontario introduced a new diagnostic code for long COVID, which physicians are expected to use when treating patients with suspected or confirmed cases. It will be instrumental for collecting data to evaluate and improve care for patients, Dr. Quinn said.

Until better treatments are available, he recommends physicians listen to patients, validate their experience and support them. "That's really the most important thing that we can do right now."

Federal Health Minister Jean-Yves Duclos noted at a December press conference that even mild cases of COVID-19 infection or reinfection can cause long-term consequences, and that evidence shows 15 per cent of adults infected experience lingering symptoms.

At that same event, Canada's Chief Science Advisor, Mona Nemer, emphasised the need to recognise that COVID-19 can manifest as not just an acute illness, but a chronic one. She also explained that it is still not well understood why certain people develop long COVID, why women are twice as likely as men to be affected, and why it can accelerate the onset of other chronic illnesses such as diabetes and heart disease.

Even if people do not develop long COVID after their first infection, it doesn't mean they won't develop it after subsequent reinfections, Dr. Quinn said, adding that the best way to prevent the condition is to prevent infection in the first place.

Helo world herre somee exttra stuff!
        ` },
    });

    expect(response.errors).toBeUndefined();
    expect(response.data?.styleguidemulti.result.length).toBeGreaterThan(1000); //check return length huge
});

