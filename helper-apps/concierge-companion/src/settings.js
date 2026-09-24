const arabic = {
    title: 'رفيق Concierge',
    intro: 'أدواتك، أينما كانت.',
    oneStep: 'خطوة أخيرة',
    approveTitle: 'توصيل هذا الكمبيوتر؟',
    approveHelp: 'اسمح لحساب Concierge هذا باستخدام الأدوات التي تفعّلها هنا.',
    approve: 'الموافقة على الاتصال',
    cancel: 'إلغاء',
    welcome: 'ابدأ من Concierge.',
    welcomeHelp:
        'افتح الموصلات في Concierge واختر «توصيل هذا الكمبيوتر». سيتم إدخال حسابك تلقائياً.',
    installed: 'تم التثبيت',
    connectStep: 'اتصال',
    approveStep: 'موافقة',
    ready: 'جاهز لمساعدتك.',
    readyHelp: 'يمكنك إغلاق هذه النافذة. سيبقى رفيق Concierge جاهزاً في الخلفية.',
    open: 'فتح Concierge ↗',
    tools: 'موصلاتك',
    files: 'اختر مجلداً',
    filesHelp: 'قراءة وتعديل الملفات التي تختارها، دون إعدادات.',
    advanced: 'إعدادات متقدمة',
    custom: 'موصل مخصص',
    customHelp: 'اتصل بخادم MCP محلي أو على شبكة خاصة أو في السحابة.',
    name: 'الاسم',
    address: 'عنوان الخادم',
    transport: 'نوع الاتصال',
    token: 'رمز الوصول (إذا لزم)',
    add: 'إضافة موصل',
    import: 'استيراد الإعدادات…',
    manual: 'الاتصال باستخدام رمز',
    site: 'عنوان Concierge',
    pair: 'الحصول على رمز الاقتران',
    codeHelp: 'أدخل هذا الرمز في Concierge:',
    expiry: 'تنتهي الصلاحية خلال 10 دقائق.',
    restart: 'إعادة التشغيل للتحديث',
    footer: 'أدر الوصول من Concierge. أوقف الاتصال مؤقتاً من شريط القوائم أو علبة النظام في أي وقت.',
};
const statuses = {
    connected: ['Connected · running quietly', 'متصل · يعمل في الخلفية'],
    connecting: ['Connecting…', 'جارٍ الاتصال…'],
    offline: ['Reconnecting automatically…', 'جارٍ إعادة الاتصال تلقائياً…'],
    paused: ['Paused', 'متوقف مؤقتاً'],
    unpaired: ['Ready to connect', 'جاهز للاتصال'],
    pairing: ['Waiting for approval in Concierge', 'بانتظار الموافقة في Concierge'],
    locked: ['Unlock your keychain to connect', 'افتح سلسلة المفاتيح للاتصال'],
};
const updateLabels = {
    unavailable: [
        'Local build · updates unavailable',
        'نسخة تجريبية داخلية · التحديثات غير متاحة',
    ],
    current: [
        'Up to date · updates download automatically',
        'محدّث · تنزيل التحديثات تلقائياً',
    ],
    downloading: ['Downloading an update…', 'جارٍ تنزيل تحديث…'],
    ready: ['Update ready', 'التحديث جاهز'],
    error: [
        'Update check failed · will retry',
        'تعذر البحث عن تحديث · ستتم إعادة المحاولة',
    ],
};
const $ = (id) => document.getElementById(id);
let isArabic = false;
function render(state) {
    isArabic = String(state.locale).startsWith('ar');
    document.documentElement.lang = isArabic ? 'ar' : 'en';
    document.documentElement.dir = isArabic ? 'rtl' : 'ltr';
    if (isArabic)
        document.querySelectorAll('[data-t]').forEach((el) => {
            if (arabic[el.dataset.t]) el.textContent = arabic[el.dataset.t];
        });
    $('status').textContent =
        statuses[state.status]?.[isArabic ? 1 : 0] || state.status;
    $('dot').classList.toggle('online', state.status === 'connected');
    const paired =
        Boolean(state.conciergeUrl) &&
        !['unpaired', 'locked', 'pairing'].includes(state.status);
    $('welcome').hidden = paired || Boolean(state.handoff);
    $('connected').hidden = !paired || Boolean(state.handoff);
    $('tools-panel').hidden = !paired || Boolean(state.handoff);
    $('approval').hidden = !state.handoff;
    if (state.handoff) {
        $('approval-account').textContent = state.handoff.account;
        $('approval-site').textContent = state.handoff.site;
        $('approval-tool').textContent =
            state.handoff.kind === 'files'
                ? isArabic
                    ? 'ستختار المجلدات التي يمكن لتطبيق Concierge قراءتها وتعديلها.'
                    : 'You will choose the folders Concierge can read and edit.'
                : state.handoff.server
                  ? `${state.handoff.server.name} · ${state.handoff.server.url}`
                  : '';
    }
    $('account').textContent = state.account || '';
    $('connected-site').textContent = state.conciergeUrl || '';
    $('pause').textContent =
        state.status === 'paused'
            ? isArabic
                ? 'استئناف'
                : 'Resume'
            : isArabic
              ? 'إيقاف مؤقت'
              : 'Pause';
    if (!$('site').value) $('site').value = state.conciergeUrl || '';
    $('pairing').hidden = !state.code;
    $('code').textContent = state.code?.match(/.{1,4}/g)?.join('-') || '';
    $('count').textContent = state.servers?.length || 0;
    $('servers').replaceChildren();
    for (const server of state.servers || []) {
        const li = document.createElement('li');
        const text = document.createElement('span');
        text.textContent = server.name;
        const detail = document.createElement('small');
        detail.textContent =
            server.type === 'files'
                ? isArabic
                    ? 'ملفات ومجلدات'
                    : 'Files and folders'
                : server.url ||
                  (isArabic
                      ? 'أداة على هذا الكمبيوتر'
                      : 'Tool on this computer');
        text.append(detail);
        const remove = document.createElement('button');
        remove.className = 'text-button';
        remove.textContent = isArabic ? 'إزالة' : 'Remove';
        remove.addEventListener('click', () =>
            action(() => window.companion.remove(server.id)),
        );
        li.append(text, remove);
        $('servers').append(li);
    }
    $('update-status').textContent =
        updateLabels[state.updateStatus]?.[isArabic ? 1 : 0] || '';
    $('update').hidden = state.updateStatus !== 'ready';
    if (state.setupError) {
        $('error').textContent = errorText(state.setupError);
        $('error').hidden = false;
    }
}
const arabicErrors = {
    'Invalid setup link': 'رابط الإعداد غير صالح',
    'Invalid setup response': 'استجابة الإعداد غير صالحة',
    'Setup link expired. Return to Concierge and select Connect this computer again.':
        'انتهت صلاحية الرابط. عُد إلى Concierge واختر توصيل هذا الكمبيوتر مجدداً.',
    'Could not connect. Return to Concierge and try again.':
        'تعذر الاتصال. عُد إلى Concierge وحاول مجدداً.',
    'Your Concierge administrator has not enabled companion connections':
        'لم يفعّل المسؤول اتصالات رفيق Concierge بعد.',
    'Enable your operating system keychain before connecting':
        'فعّل سلسلة مفاتيح نظام التشغيل قبل الاتصال.',
    'Open the connection from Concierge again': 'افتح الاتصال من Concierge مجدداً.',
    'Please wait for the current change': 'يرجى انتظار اكتمال التغيير الحالي.',
    'Please wait for the current change, then open the connection again':
        'انتظر اكتمال التغيير الحالي، ثم افتح الاتصال مجدداً.',
    'Approve or cancel the current connection first':
        'وافق على الاتصال الحالي أو ألغِه أولاً.',
    'Connect this computer from Concierge first':
        'وصّل هذا الكمبيوتر من Concierge أولاً.',
    'Remove a connector before adding another':
        'أزل موصلاً قبل إضافة موصل آخر.',
    'Wait for the current tool to finish, then try again':
        'انتظر انتهاء الأداة الحالية ثم حاول مجدداً.',
};
const errorText = (text) => (isArabic ? arabicErrors[text] || text : text);
async function action(fn) {
    $('error').hidden = true;
    document.querySelectorAll('button').forEach((b) => {
        b.disabled = true;
    });
    try {
        const result = await fn();
        if (result.error) throw new Error(result.error);
        if (result.value) render(result.value);
        return true;
    } catch (e) {
        $('error').textContent = errorText(e.message);
        $('error').hidden = false;
        return false;
    } finally {
        document.querySelectorAll('button').forEach((b) => {
            b.disabled = false;
        });
    }
}
for (const name of [
    'approve',
    'cancel',
    'files',
    'open',
    'pause',
    'update',
    'import',
])
    $(name).addEventListener('click', () =>
        action(() => window.companion[name]()),
    );
$('pair-form').addEventListener('submit', (event) => {
    event.preventDefault();
    action(() => window.companion.pair($('site').value));
});
$('server-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const ok = await action(() =>
        window.companion.add({
            id: crypto.randomUUID(),
            name: $('name').value,
            url: $('url').value,
            type: $('transport').value,
            headers: $('token').value
                ? { Authorization: `Bearer ${$('token').value}` }
                : {},
        }),
    );
    if (ok) event.target.reset();
});
window.companion.onState(render);
action(() => window.companion.state());
