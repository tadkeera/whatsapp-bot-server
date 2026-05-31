const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 7860;
const SPACE_SERVER_ID = process.env.SPACE_SERVER_ID || 'borg-hospital-primary';

// تهيئة اتصال سوبابيز
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

let qrCodeData = '';
let isReady = false;
let outboundQueue = Promise.resolve(); // طابور لضمان جدولة رسائل التذكير بفارق زمني

// إعداد عميل الواتساب المتوافق مع بيئة Docker
const client = new Client({
    authStrategy: new LocalAuth({ clientId: SPACE_SERVER_ID }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu'
        ],
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium'
    }
});

// استقبال كود الـ QR
client.on('qr', (qr) => {
    qrCodeData = qr;
    isReady = false;
    console.log('QR Code updated. Ready to scan.');
});

// نجاح الاتصال بالواتساب وتحديث الحالة في سوبابيز
client.on('ready', async () => {
    isReady = true;
    qrCodeData = '';
    console.log(`WhatsApp Client is Ready for Server ID: ${SPACE_SERVER_ID}`);
    
    try {
        await supabase.from('whatsapp_settings').upsert({ 
            server_id: SPACE_SERVER_ID, 
            status: 'connected', 
            provider: 'huggingface',
            updated_at: new Date() 
        });
    } catch (err) {
        console.error('Supabase update failed:', err);
    }
});

// معالجة الرسائل الواردة (البوت الذكي للمستشفى)
client.on('message', async (msg) => {
    const from = msg.from;
    const body = msg.body;

    if (!from.endsWith('@g.us')) {
        try {
            let { data: session } = await supabase
                .from('bot_sessions')
                .select('*')
                .eq('patient_phone', from)
                .maybeSingle();

            let nextState = 'WELCOME';
            if (session) {
                nextState = session.current_state;
            }

            let replyMessage = '';
            let sendSaveContactNotice = false; // مؤشر لإرسال رسالة حفظ الرقم

            if (nextState === 'WELCOME') {
                replyMessage = 'مرحباً بك في مستشفى بورج. لتأكيد موعدك اضغط (1)، لإلغاء الموعد اضغط (2).';
                nextState = 'AWAITING_CONFIRMATION';
            } else if (nextState === 'AWAITING_CONFIRMATION') {
                if (body === '1') {
                    replyMessage = 'تم تأكيد موعدكم بنجاح. تسعدنا خدمتكم دائماً، متمنين لكم دوام الصحة والعافية.';
                    nextState = 'COMPLETED';
                    sendSaveContactNotice = true; // تفعيل إرسال الرسالة الاحترافية المنفصلة
                } else if (body === '2') {
                    replyMessage = 'تم إلغاء الموعد بنجاح بناءً على طلبكم. يسعدنا خدمتكم وتلقي حجوزاتكم في أي وقت آخر.';
                    nextState = 'CANCELLED';
                } else {
                    replyMessage = 'عذراً، الخيار المدخل غير صحيح. يرجى إرسال الرقم (1) لتأكيد الموعد، أو الرقم (2) لإلغائه.';
                }
            } else {
                replyMessage = 'مرحباً بك مجدداً في مستشفى بورج. تم تسجيل وتأكيد طلبك السابق مسبقاً.';
            }

            // تحديث قاعدة البيانات
            await supabase.from('bot_sessions').upsert({ 
                patient_phone: from, 
                current_state: nextState, 
                updated_at: new Date() 
            });
            
            // إرسال رسالة الرد الأساسية
            await client.sendMessage(from, replyMessage);

            // إذا تم تأكيد الحجز، يتم إرسال رسالة التوجيه الاحترافية بشكل منفصل بعد ثانية واحدة
            if (sendSaveContactNotice) {
                setTimeout(async () => {
                    const professionalNotice = 
                        "💡 *عزيزنا المريض:*\n\n" +
                        "لضمان استمرار تلقي إشعارات المواعيد والتحديثات الطبية الهامة الخاصة بكم وبأعلى جودة، " +
                        "يرجى التكرم بـ *حفظ رقم هاتف المستشفى هذا ضمن جهات الاتصال الخاصة بكم*.\n\n" +
                        "شاكرين لكم حسن تعاونكم وتفهمكم.\n" +
                        "*إدارة مستشفى بورج*";
                    
                    await client.sendMessage(from, professionalNotice).catch(e => console.error('Error sending notice:', e));
                }, 1500); // فاصل زمني بسيط ثانية ونصف لتبدو طبيعية جداً
            }

        } catch (error) {
            console.error('Error in chatbot automation:', error);
        }
    }
});

// مسار عرض الـ QR من المتصفح
app.get('/api/qr', (req, res) => {
    if (isReady) {
        return res.send('<h3>WhatsApp Client is already connected!</h3>');
    }
    if (!qrCodeData) {
        return res.send('<h3>Generating QR code... Please refresh the page in 10 seconds.</h3>');
    }
    const qrImageSrc = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qrCodeData)}`;
    res.send(`
        <div style="text-align: center; margin-top: 50px; font-family: Arial, sans-serif;">
            <h2>Scan to Link Hospital Bot</h2>
            <div style="margin: 20px 0;">
                <img src="${qrImageSrc}" alt="QR Code" style="border: 2px solid #333; padding: 10px; border-radius: 8px;" />
            </div>
            <p>Server ID: <strong style="color: #007bff;">${SPACE_SERVER_ID}</strong></p>
            <p style="color: #666; font-size: 14px;">Refresh page if code expires.</p>
        </div>
    `);
});

// مسار استقبال طلبات الإرسال من سيرفر Vercel (مع تطبيق فاصل زمني دقيقة كاملة بين الرسائل المجدولة)
app.post('/api/send-message', async (req, res) => {
    const { to, message } = req.body;
    if (!isReady) {
        return res.status(503).json({ success: false, error: 'WhatsApp client is not ready' });
    }

    const formattedTo = to.includes('@c.us') ? to : `${to.replace('+', '')}@c.us`;

    // إضافة الرسالة إلى طابور الانتظار لضمان تنفيذ فاصل دقيقة كاملة (60,000ms) بين كل تنبيه تذكيري وآخر
    outboundQueue = outboundQueue.then(() => {
        return new Promise((resolve) => {
            setTimeout(async () => {
                try {
                    await client.sendMessage(formattedTo, message);
                    console.log(`Notification sent successfully to ${formattedTo}`);
                } catch (error) {
                    console.error(`Failed to send notification to ${formattedTo}:`, error.message);
                }
                resolve(); // الانتقال للرسالة التالية في الطابور بعد انتهاء الدقيقة
            }, 60000); // 60 ألف مللي ثانية = دقيقة كاملة
        });
    });

    // الرد الفوري على سيرفر Vercel بأنه تم استلام الرسالة وجدولتها في طابور الأمان بنجاح
    res.json({ success: true, message: 'Message has been securely queued with a 1-minute delay' });
});

// فحص الحالة العامة للسيرفر
app.get('/', (req, res) => {
    res.json({ status: "online", server_id: SPACE_SERVER_ID, whatsapp_connected: isReady });
});

// تشغيل العميل
client.initialize().catch(err => console.error('Initialization error:', err));

// تشغيل السيرفر
app.listen(PORT, () => {
    console.log(`Server running successfully on port ${PORT}`);
});
