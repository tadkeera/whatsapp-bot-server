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

// إعداد عميل الواتساب المتوافق تماماً مع بيئة لينكس وكروميوم داخل Docker
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

// نجاح الاتصال بالواتساب
client.on('ready', async () => {
    isReady = true;
    qrCodeData = '';
    console.log(`WhatsApp Client is Ready for Server ID: ${SPACE_SERVER_ID}`);
    
    try {
        await supabase.from('whatsapp_settings').upsert({ 
            server_id: SPACE_SERVER_ID, 
            status: 'connected', 
            updated_at: new Date() 
        });
    } catch (err) {
        console.error('Supabase update failed:', err);
    }
});

// معالجة الرسائل الواردة (البوت الذكي)
client.on('message', async (msg) => {
    const from = msg.from;
    const body = msg.body;

    // تشغيل منطق الرد التلقائي فقط للمحادثات الفردية وليس المجموعات
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
            if (nextState === 'WELCOME') {
                replyMessage = 'مرحباً بك في مستشفى بورج. لتأكيد موعدك اضغط (1)، لإلغاء الموعد اضغط (2).';
                nextState = 'AWAITING_CONFIRMATION';
            } else if (nextState === 'AWAITING_CONFIRMATION') {
                if (body === '1') {
                    replyMessage = 'تم تأكيد موعدك بنجاح. شكرًا لك!';
                    nextState = 'COMPLETED';
                } else if (body === '2') {
                    replyMessage = 'تم إلغاء الموعد بنجاح.';
                    nextState = 'CANCELLED';
                } else {
                    replyMessage = 'خيار غير صحيح. يرجى إرسال (1) للتأكيد أو (2) للإلغاء.';
                }
            } else {
                replyMessage = 'مرحباً بك مجدداً. تم تسجيل طلبك السابق بنجاح.';
            }

            await supabase.from('bot_sessions').upsert({ 
                patient_phone: from, 
                current_state: nextState, 
                updated_at: new Date() 
            });
            
            await client.sendMessage(from, replyMessage);
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

// مسار استقبال طلبات الإرسال من سيرفر Vercel
app.post('/api/send-message', async (req, res) => {
    const { to, message } = req.body;
    if (!isReady) {
        return res.status(503).json({ success: false, error: 'WhatsApp client is not ready' });
    }
    try {
        const formattedTo = to.includes('@c.us') ? to : `${to.replace('+', '')}@c.us`;
        await client.sendMessage(formattedTo, message);
        res.json({ success: true, message: 'Notification sent successfully' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// فحص الحالة العامة للسيرفر
app.get('/', (req, res) => {
    res.json({ status: "online", server_id: SPACE_SERVER_ID, whatsapp_connected: isReady });
});

client.initialize().catch(err => console.error('Initialization error:', err));

app.listen(PORT, () => {
    console.log(`Server running successfully on port ${PORT}`);
});
}

// =========================================================================
// WHATSAPP CLIENT INITIALIZATION
// =========================================================================

async function startWhatsAppBot() {
  // First recover existing token sessions
  await restoreAuthSession();

  console.log('[WhatsApp Launcher] Initializing browser engine...');
  const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--single-process'
      ],
      headless: true
    }
  });

  client.on('qr', (qr) => {
    globalQrText = qr;
    connectionStatus = 'AWAITING_SCAN';
    console.log('[WhatsApp QR] New QR text generated! Please view it via /api/qr');
  });

  client.on('authenticated', () => {
    console.log('[WhatsApp Event] Authentication complete! Client initialized.');
    connectionStatus = 'CONNECTED';
    globalQrText = null;
  });

  client.on('ready', () => {
    console.log('[WhatsApp Event] Client is fully ready and online!');
    connectionStatus = 'CONNECTED';
    // Sync authenticated session storage back to the cloud
    setTimeout(backupAuthSession, 12000);
  });

  client.on('disconnected', async (reason) => {
    console.warn('[WhatsApp Event] Connection lost!', reason);
    connectionStatus = 'DISCONNECTED';
    globalQrText = null;
  });

  // Handle inbound text state machine
  client.on('message', async (messageMsg) => {
    try {
      const fromPhone = messageMsg.from.split('@')[0];
      const messageText = (messageMsg.body || '').trim();

      // Skip groups and statuses
      if (messageMsg.from.endsWith('@g.us') || messageMsg.from === 'status@broadcast') {
        return;
      }

      console.log(`[Chatbot Inbound] [+${fromPhone}]: "${messageText}"`);

      // Mimics the real exact SQL flow in server.ts
      const botResponse = await handleWhatsappFlow(fromPhone, messageText);

      if (botResponse) {
        await client.sendMessage(messageMsg.from, botResponse);
        console.log(`[Chatbot Outbound] Replied directly to [+${fromPhone}] via client.`);
      }
    } catch (err) {
      console.error('[Chatbot Webhook Exception]', err.message);
    }
  });

  client.initialize();

  // =========================================================================
  // HTTP REST GATEWAYS
  // =========================================================================

  // Outbound push notification sender API
  app.post('/api/send-message', async (req, res) => {
    const { to, message } = req.body;
    if (!to || !message) {
      return res.status(400).json({ error: 'Missing standard parameters (to, message)' });
    }

    if (connectionStatus !== 'CONNECTED') {
      return res.status(503).json({ error: 'WhatsApp Gateway Client is currently disconnected' });
    }

    const cleanFormattedPhone = to.replace(/^\+/, '').replace(/\s+/g, '') + '@c.us';

    try {
      console.log(`[Outbound Gateway] Delivering text to ${cleanFormattedPhone}`);
      const chat = await client.sendMessage(cleanFormattedPhone, message);
      res.json({ success: true, messageId: chat.id._serialized });
    } catch (err) {
      console.error('[Outbound Message Exception]', err.message);
      res.status(500).json({ error: 'Failed to deliver message', details: err.message });
    }
  });

  // Status check & QR Render Webpage
  app.get('/api/qr', (req, res) => {
    let content = '';

    if (connectionStatus === 'CONNECTED') {
      content = `
        <div style="text-align: center; font-family: sans-serif; padding-top: 50px;">
          <div style="font-size: 80px;">✅</div>
          <h2 style="color: #2e7d32; font-weight: 800; margin-top: 20px;">تم الاتصال بنجاح!</h2>
          <p style="color: #555;">الموقع متصل بالطرف المساعد للبوت وجاهز لإرسال واستقبال الرسائل.</p>
          <div style="background: #f1f8e9; display: inline-block; padding: 12px 25px; border-radius: 20px; font-weight: bold; color: #33691e; margin-top: 15px;">
             Active Client: ${SPACE_SERVER_ID}
          </div>
          <p style="margin-top: 30px; color: #999; font-size: 11px;">آخر مزامنة لقاعدة البيانات: ${lastBackupAt || 'نشط حالياً'}</p>
        </div>
      `;
    } else if (connectionStatus === 'AWAITING_SCAN' && globalQrText) {
      const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(globalQrText)}&size=300x300`;
      content = `
        <div style="text-align: center; font-family: sans-serif; padding: 40px 15px;">
          <h2 style="color: #1a237e; font-weight: 800; margin-bottom: 5px;">ربط واتساب مستشفى برج الأطباء</h2>
          <p style="color: #666; font-size: 14px; margin-bottom: 25px;">يرجى مسح الرمز المربع (QR) الموضح أدناه من تطبيق واتساب بهاتفك للربط مباشرة:</p>
          <div style="background: #ffffff; padding: 25px; display: inline-block; border-radius: 16px; border: 1px solid #e0e0e0; box-shadow: 0 4px 10px rgba(0,0,0,0.05);">
             <img src="${qrImageUrl}" alt="WhatsApp Scan" style="display: block;" />
          </div>
          <div style="margin-top: 25px; font-weight: bold; color: #d32f2f;">
             ⚠️ حالة الاتصال: بانتظار مسح الباركود مفعلاً بالهاتف
          </div>
          <p style="margin-top:20px; color: #888; font-size: 12px;">تأكد من عدم اغلاق هذه الصفحة حتى تمام الاتصال لضمان حفظ الجلسة وقفل الأمان.</p>
        </div>
      `;
    } else {
      content = `
        <div style="text-align: center; font-family: sans-serif; padding-top: 60px;">
          <div style="font-size: 80px;">⏳</div>
          <h2 style="color: #e65100; font-weight: 800; margin-top: 20px;">جارٍ تهيئة خادم الواتساب...</h2>
          <p style="color: #666;">يرجى الانتظار 30 ثانية لتحديث الصفحة تلقائياً مع تحميل متصفح Puppeteer.</p>
          <p style="color: #999; font-size: 12px;">الحالة الحالية: ${connectionStatus}</p>
          <script>setTimeout(() => { window.location.reload(); }, 6000);</script>
        </div>
      `;
    }

    res.send(`
      <!DOCTYPE html>
      <html dir="rtl" lang="ar">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>بوابة واتساب مستشفى برج الأطباء</title>
      </head>
      <body style="background-color: #fafafa; margin: 0; padding: 0;">
         ${content}
      </body>
      </html>
    `);
  });
}

// =========================================================================
// INTEGRATED AUTOMATED CHATBOT LOGIC (Ar)
// =========================================================================

function normalizePhone(phone) {
  if (!phone) return '';
  return phone.replace(/^\+/, '').replace(/\s+/g, '').replace(/@c\.us$/, '').trim();
}

function getDayNameArabic(dayIndex) {
  const days = ['السبت', 'الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس'];
  return days[dayIndex] || '';
}

function getCircledNumber(num) {
  const circled = ['⓪', '①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳'];
  return num <= 20 ? circled[num] : `[ ${num} ]`;
}

function getYemenTime() {
  const utcNow = new Date().getTime();
  const yemenOffset = 3 * 60 * 60 * 1000; // UTC+3
  return new Date(utcNow + yemenOffset);
}

function getNextWeekDate(targetDayOfWeekIndex) {
  const now = getYemenTime();
  const currentDay = now.getUTCDay(); // Sun is 0, Sat is 6
  let normalizedCurrentDay = currentDay === 6 ? 0 : currentDay + 1; // Align: Sat=0, Sun=1...

  let diff = targetDayOfWeekIndex - normalizedCurrentDay;
  if (diff <= 0) {
    diff += 7;
  }
  const targetDate = new Date(now.getTime() + diff * 24 * 60 * 60 * 1000);
  return targetDate.toISOString().split('T')[0];
}

async function handleWhatsappFlow(phone, incomingMessage) {
  const cleanPhone = normalizePhone(phone);
  const currentYemenNow = getYemenTime();

  // 1. Log inbound message
  await supabase.from('whatsapp_logs').insert([{
    phone: cleanPhone,
    direction: 'in',
    message: incomingMessage,
    timestamp: currentYemenNow.toISOString()
  }]);

  // 2. Fetch or create interactive state
  const { data: dbSession } = await supabase
    .from('bot_sessions')
    .select('*')
    .eq('phone', cleanPhone)
    .maybeSingle();

  let session = dbSession;
  const isNewSession = !session;

  if (isNewSession) {
    session = {
      phone: cleanPhone,
      current_state: 'IDLE',
      patient_name: null,
      selected_doctor_id: null,
      selected_schedule_id: null,
      selected_day_offset: null,
      selected_shift: null,
      selected_date: null,
      last_interaction_at: currentYemenNow.toISOString()
    };
  }

  const outputReply = async (replyText, nextState) => {
    // Record out log
    await supabase.from('whatsapp_logs').insert([{
      phone: cleanPhone,
      direction: 'out',
      message: replyText,
      timestamp: getYemenTime().toISOString()
    }]);

    // Save state back to bot_sessions
    const nextSession = {
      phone: cleanPhone,
      current_state: nextState,
      patient_name: session.patient_name || null,
      selected_doctor_id: session.selected_doctor_id || null,
      selected_schedule_id: session.selected_schedule_id || null,
      selected_day_offset: session.selected_day_offset || null,
      selected_shift: session.selected_shift || null,
      selected_date: session.selected_date || null,
      last_interaction_at: getYemenTime().toISOString()
    };

    if (isNewSession) {
      await supabase.from('bot_sessions').insert([nextSession]);
    } else {
      await supabase.from('bot_sessions').update(nextSession).eq('phone', cleanPhone);
    }

    return replyText;
  };

  const isTriggerMsg = incomingMessage.toLowerCase() === 'تسجيل';
  const state = session.current_state;

  // State Machine Core
  if (state === 'IDLE') {
    if (!isTriggerMsg) {
       return outputReply("مرحباً بك في مستشفى برج الأطباء.\nللبدء في تسجيل موعد جديد آلياً، يرجى إرسال كلمة *تسجيل*", 'IDLE');
    }

    // Get active Doctors
    const { data: doctors } = await supabase
      .from('doctors')
      .select('*')
      .eq('is_active', true);

    if (!doctors || doctors.length === 0) {
      return outputReply('عذراً، لا تتوفر أي عيادات أو أطباء متاحين للتسجيل حالياً. يرجى مراجعة إدارة المشفى لاحقاً.', 'IDLE');
    }

    let prompt = `مرحباً بك في نظام حجز مستشفى برج الأطباء 🏥.\nالرجاء كتابة الرقم المقابل لاسم الطبيب المطلوب للحجز لديه:`;
    doctors.forEach((doc, idx) => {
      prompt += `\n\n*${idx + 1}* - د. ${doc.name} (${doc.specialty})`;
    });

    return outputReply(prompt, 'SELECTING_DOCTOR');
  }

  if (state === 'SELECTING_DOCTOR') {
    if (isTriggerMsg) {
      // Restart flow
      session.current_state = 'IDLE';
      return handleWhatsappFlow(cleanPhone, 'تسجيل');
    }

    const docSelectIndex = parseInt(incomingMessage) - 1;

    const { data: doctors } = await supabase
      .from('doctors')
      .select('*')
      .eq('is_active', true);

    if (isNaN(docSelectIndex) || docSelectIndex < 0 || !doctors || docSelectIndex >= doctors.length) {
      return outputReply('❌ عذراً، رقم الاختيار غير صحيح. يرجى إدخال الرقم المقابل لاسم الطبيب من القائمة السابقة.', 'SELECTING_DOCTOR');
    }

    const selectedDoc = doctors[docSelectIndex];
    session.selected_doctor_id = selectedDoc.id;

    // Fetch schedules
    const { data: schedules } = await supabase
      .from('schedules')
      .select('*')
      .eq('doctor_id', selectedDoc.id);

    if (!schedules || schedules.length === 0) {
      return outputReply(`التبويب عذراً، عيادة د. ${selectedDoc.name} غير متاح بها أيام حجز هذا الأسبوع. يرجى اختيار طبيب آخر.`, 'IDLE');
    }

    // Generate dynamic scheduling options
    const rawOptions = [];
    schedules.forEach(s => {
      const dateThisWeek = getNextWeekDate(s.day_of_week);
      rawOptions.push({
        day_of_week: s.day_of_week,
        date: dateThisWeek,
        weekLabel: 'الأسبوع الحالي',
        schedule: s
      });

      // Include week 2 offsets
      const tDate = new Date(dateThisWeek);
      const nextWeekDateStr = new Date(tDate.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      rawOptions.push({
        day_of_week: s.day_of_week,
        date: nextWeekDateStr,
        weekLabel: 'الأسبوع القادم',
        schedule: s
      });
    });

    // Group options by date
    const groupedMap = new Map();
    rawOptions.forEach(raw => {
      const existing = groupedMap.get(raw.date);
      if (existing) {
        if (!existing.schedules.some(s => s.id === raw.schedule.id)) {
          existing.schedules.push(raw.schedule);
        }
      } else {
        groupedMap.set(raw.date, {
          day_of_week: raw.day_of_week,
          date: raw.date,
          weekLabel: raw.weekLabel,
          schedules: [raw.schedule]
        });
      }
    });

    const optList = Array.from(groupedMap.values()).sort((a,b) => new Date(a.date) - new Date(b.date));

    let prompt = `عيادات الطبيب *د. ${selectedDoc.name}* متوفرة في الأيام التالية.\nيرجى كتابة رقم اليوم المقابل لإتمام الحجز:`;
    optList.forEach((opt, idx) => {
      const dayLabel = getDayNameArabic(opt.day_of_week);
      prompt += `\n\n*${idx + 1}* - ${dayLabel} - ${opt.weekLabel} (${opt.date})`;
    });

    // Temporarily save options inside temporary columns or state
    session.selected_doctor_id = selectedDoc.id;
    // We can save state parameters directly to handle options dynamically
    session.patient_name = JSON.stringify(optList); // Serialized Day Options list

    return outputReply(prompt, 'SELECTING_DAY');
  }

  if (state === 'SELECTING_DAY') {
    if (isTriggerMsg) {
      session.current_state = 'IDLE';
      return handleWhatsappFlow(cleanPhone, 'تسجيل');
    }

    let options = [];
    try {
      options = JSON.parse(session.patient_name || '[]');
    } catch(e) {}

    const daySelectIdx = parseInt(incomingMessage) - 1;
    if (isNaN(daySelectIdx) || daySelectIdx < 0 || daySelectIdx >= options.length) {
      return outputReply('❌ رقم الاختيار غير صحيح. يرجى اختيار رقم يوم صالح من القائمة.', 'SELECTING_DAY');
    }

    const chosenDayOpt = options[daySelectIdx];
    const schedule = chosenDayOpt.schedules[0]; // first schedule

    const startHour = parseInt(schedule.start_time.split(':')[0]);
    const shiftLabel = startHour < 13 ? 'Morning' : 'Evening';

    // Verify capacity
    const { data: bookingsCount } = await supabase
      .from('bookings')
      .select('id')
      .eq('doctor_id', session.selected_doctor_id)
      .eq('booking_date', chosenDayOpt.date)
      .eq('shift', shiftLabel)
      .neq('status', 'cancelled');

    const totalCount = bookingsCount ? bookingsCount.length : 0;
    if (totalCount >= schedule.max_capacity) {
      return outputReply(' عذراً، بلغت هذه الفترة السعة الاستيعابية القصوى المتاحة (ممتلئة). يرجى مراجعة طبيب آخر أو يوم عيادة مختلف.', 'IDLE');
    }

    session.selected_schedule_id = schedule.id;
    session.selected_date = chosenDayOpt.date;
    session.selected_shift = shiftLabel;
    session.patient_name = null; // reset placeholder storage

    return outputReply("يرجى كتابة اسم المريض الثلاثي أو الرباعي بوضوح لتأكيد وحفظ رقم الحجز الخاص بك:", 'AWAITING_NAME');
  }

  if (state === 'AWAITING_NAME') {
    if (isTriggerMsg) {
      session.current_state = 'IDLE';
      return handleWhatsappFlow(cleanPhone, 'تسجيل');
    }

    const nameInput = incomingMessage.trim();
    const wordsCount = nameInput.split(/\s+/).length;

    if (wordsCount < 2) {
      return outputReply("يرجى كتابة اسم المريض ثلاثياً على الأقل للتسجيل وتجنب الاسماء المتشابهة:", 'AWAITING_NAME');
    }

    // Verify duplicate booking name
    const { data: duplicate } = await supabase
      .from('bookings')
      .select('id')
      .eq('doctor_id', session.selected_doctor_id)
      .eq('booking_date', session.selected_date)
      .ilike('patient_name', nameInput)
      .neq('status', 'cancelled')
      .maybeSingle();

    if (duplicate) {
      return outputReply("⚠️ هذا الاسم مسجل مسبقاً لدى هذا الطبيب في نفس اليوم. يرجى إدخال اسم المريض ثلاثياً مع اللقب بوضوح:", 'AWAITING_NAME');
    }

    // Get next queue number for doctor/date/shift
    const { data: qData } = await supabase
      .from('bookings')
      .select('queue_number')
      .eq('doctor_id', session.selected_doctor_id)
      .eq('booking_date', session.selected_date)
      .eq('shift', session.selected_shift);

    const maxQ = qData && qData.length > 0 ? Math.max(...qData.map(b => b.queue_number || 0)) : 0;
    const nextQueueNumber = Math.max(maxQ, qData?.length || 0) + 1;

    // Create entry in bookings
    const { data: insertedBooking, error: insertErr } = await supabase
      .from('bookings')
      .insert([{
        doctor_id: session.selected_doctor_id,
        schedule_id: session.selected_schedule_id,
        patient_name: nameInput,
        patient_phone: '+' + cleanPhone,
        booking_date: session.selected_date,
        queue_number: nextQueueNumber,
        shift: session.selected_shift,
        status: 'pending',
        payment_status: 'pending',
        verified_by_whatsapp: true
      }])
      .select()
      .single();

    if (insertErr) {
      console.error('Error saving booking:', insertErr);
      return outputReply("عذراً، واجه النظام خطأً فنياً أثناء محاولة حفظ حجزك. يرجى المحاولة مرة أخرى لاحقاً.", 'IDLE');
    }

    const deadlineDate = new Date();
    deadlineDate.setDate(deadlineDate.getDate() + 2);
    const deadlineStr = deadlineDate.toISOString().split('T')[0];

    const isMorning = session.selected_shift === 'Morning';
    const shiftTextLabel = isMorning ? 'صباحية' : 'مسائية';
    const circledQueue = getCircledNumber(nextQueueNumber);

    const confirmationMessage = `✅ *تم تأكيد طلب الحجز بنجاح!*\n\n` +
      `👤 *الاسم:* ${nameInput}\n` +
      `🔢 *رقم دورك:* ${circledQueue}\n` +
      `⏰ *الفترة:* ${shiftTextLabel}\n` +
      `📅 *التاريخ:* ${session.selected_date}\n\n` +
      `🚑 *ملاحظة هامة:* يرجى التوجه لقسم الحسابات وصرف الدفتر لتأكيد حجزك رسمياً خلال يومين من هذا التاريخ بحد أقصى (قبل ${deadlineStr} )، وإلا سيتم إلغاء طلب تسجيلك تلقائياً شكراً لتعاونكم.`;

    // Clear session state
    await supabase.from('bot_sessions').delete().eq('phone', cleanPhone);

    return outputReply(confirmationMessage, 'IDLE');
  }

  return outputReply("مرحباً بك في مستشفى برج الأطباء.\nللبدء في تسجيل موعد جديد آلياً، يرجى إرسال كلمة *تسجيل*", 'IDLE');
}

// Start bot and launch Express
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[HTTP Server] Running and listening on port http://0.0.0.0:${PORT}`);
  startWhatsAppBot();
});  console.log('[Baileys Config] Booting engine state...');
  
  // نستخدم معايير حماية الذاكرة العشوائية لتخفيف الحجم المستهلك
  const { state, saveCreds } = await useMultiFileAuthState('./session_local');

  // استعادة الاعتماديات الإضافية إن وجدت بقاعدة البيانات لتسريع الإحياء
  const storedSession = await loadSessionFromDatabase();
  if (storedSession && storedSession.creds) {
    console.log('[Session Manager] Restoring credentials buffer safely...');
    state.creds = JSON.parse(JSON.stringify(storedSession.creds), BufferJSON.reviver);
  }

  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    printQRInTerminal: true,
    auth: state,
    logger: pino({ level: 'silent' }), // إخفاء السجلات الضخمة للمكتبة لتوفير الذاكرة
    browser: ['Borg Registration Bot', 'Chrome', '1.0.0']
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr) {
      currentQr = qr;
      connectionStatus = 'Awaiting Scan';
      console.log('[Baileys] New WhatsApp QR code generated. Visit /api/qr to scan.');
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      connectionStatus = 'Disconnected';
      currentQr = null;
      console.log('[Baileys Client Status] Connection closed due to: ', lastDisconnect?.error || 'Unknown Error');
      
      if (shouldReconnect) {
        console.log('[Baileys Reconnection] Attempting server rebuild sequence in 5 seconds...');
        setTimeout(startWhatsAppBot, 5000);
      } else {
        console.log('[Baileys Deauthorized] Session revoked! Please delete DB session block and rescan QR.');
        await supabase.from('whatsapp_sessions').delete().eq('render_server_id', RENDER_SERVER_ID);
      }
    } else if (connection === 'open') {
      connectionStatus = 'Connected';
      currentQr = null;
      console.log('[Baileys Success] Patient Bot gateway linked successfully on WhatsApp Web! 🚀');
      
      // حفظ الاعتماديات المسترجعة والنشطة لقاعدة البيانات فور الفتح
      const rawSession = JSON.stringify({ creds: state.creds }, BufferJSON.replacer);
      await saveSessionToDatabase(JSON.parse(rawSession));
    }
  });

  sock.ev.on('creds.update', async () => {
    await saveCreds();
    const rawSession = JSON.stringify({ creds: state.creds }, BufferJSON.replacer);
    await saveSessionToDatabase(JSON.parse(rawSession));
  });

  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const fromPhone = msg.key.remoteJid.split('@')[0];
    const cleanPhone = normalizePhone(fromPhone);

    // استخراج الكلمات النصية بأمان
    const messageText = (
      msg.message.conversation || 
      msg.message.extendedTextMessage?.text || 
      ''
    ).trim();

    if (!messageText) return;

    try {
      console.log(`[Inbound Text] Received message from [+${cleanPhone}]: "${messageText}"`);
      await handleChatbotStateMachine(cleanPhone, messageText);
    } catch (err) {
      console.error('[Chatbot Error] Execution failed:', err.message);
    }
  });
}

// -------------------------------------------------------------------------
// ماكينة معالجة الحالات للرد الآلي والحجز بالعربية في المستشفى (State Machine)
// -------------------------------------------------------------------------
async function handleChatbotStateMachine(phone, messageText) {
  const currentYemenNow = getYemenTime();

  // إدراج السجل الوارد
  await supabase.from('whatsapp_logs').insert([{
    phone: phone,
    direction: 'in',
    message: messageText,
    timestamp: currentYemenNow.toISOString()
  }]);

  // جلب الجلسة الحالية
  let { data: session } = await supabase
    .from('bot_sessions')
    .select('*')
    .eq('phone', phone)
    .maybeSingle();

  const isNewSession = !session;
  if (isNewSession) {
    session = {
      phone: phone,
      current_state: 'IDLE',
      patient_name: null,
      selected_doctor_id: null,
      selected_schedule_id: null,
      selected_day_offset: null,
      selected_shift: null,
      selected_date: null,
      last_interaction_at: currentYemenNow.toISOString()
    };
  }

  // دالة الرد المسجل وتفعيل الحالة التالية
  const outputReply = async (replyMessage, nextState) => {
    // إرسال الرسالة للمريض فوراً عبر Baileys
    await sock.sendMessage(`${phone}@s.whatsapp.net`, { text: replyMessage });

    // تسجيل السجل الصادر
    await supabase.from('whatsapp_logs').insert([{
      phone: phone,
      direction: 'out',
      message: replyMessage,
      timestamp: getYemenTime().toISOString()
    }]);

    // حفظ الجلسة لقاعدة البيانات
    const updatedSession = {
      phone,
      current_state: nextState,
      patient_name: session.patient_name || null,
      selected_doctor_id: session.selected_doctor_id || null,
      selected_schedule_id: session.selected_schedule_id || null,
      selected_day_offset: session.selected_day_offset || null,
      selected_shift: session.selected_shift || null,
      selected_date: session.selected_date || null,
      last_interaction_at: getYemenTime().toISOString()
    };

    if (isNewSession) {
      await supabase.from('bot_sessions').insert([updatedSession]);
    } else {
      await supabase.from('bot_sessions').update(updatedSession).eq('phone', phone);
    }
    return replyMessage;
  };

  // 1. معالجة انتهاء مدة الجلسة (10 دقائق)
  if (!isNewSession && session.current_state !== 'IDLE') {
    const lastTime = new Date(session.last_interaction_at).getTime();
    const diffMin = (currentYemenNow.getTime() - lastTime) / (1000 * 60);

    if (diffMin > 10) {
      session.current_state = 'IDLE';
      session.patient_name = null;
      session.selected_doctor_id = null;
      session.selected_schedule_id = null;
      session.selected_date = null;
      await supabase.from('bot_sessions').delete().eq('phone', phone);
      return outputReply(
        "عذراً، انتهت مدة الجلسة (أكبر من 10 دقائق). الرجاء إرسال كلمة 'تسجيل' للبدء من جديد.",
        'IDLE'
      );
    }
  }

  // جلب قائمة الأطباء النشطين والجدول الأسبوعي من Supabase
  const { data: activeDocs } = await supabase.from('doctors').select('*').eq('is_active', true);
  const { data: activeSchedules } = await supabase.from('schedules').select('*');

  // إعادة التعيين والبدء المباشر إذا كتب المريض كلمة "تسجيل"
  if (messageText === 'تسجيل' || messageText === 'حجز') {
    if (!activeDocs || activeDocs.length === 0) {
      return outputReply(
        "عذراً، لا يوجد أطباء متاحين للجدولة حالياً في المشفى. يرجى مراجعة إدارة المستشفى.",
        'IDLE'
      );
    }

    let docsPrompt = "أهلاً بك في مستشفى برج الأطباء. الرجاء إرسال رقم الطبيب الذي تريد التسجيل لديه:\n";
    activeDocs.forEach((doc, idx) => {
      docsPrompt += `\n*${idx + 1}* - ${doc.name} (${doc.specialty})`;
    });

    session.patient_name = null;
    session.selected_doctor_id = null;
    session.selected_shift = null;
    session.selected_schedule_id = null;
    session.selected_date = null;

    return outputReply(docsPrompt, 'SELECTING_DOCTOR');
  }

  const state = session.current_state;

  // الحالات الأساسية للبوت
  if (state === 'IDLE' || state === 'COMPLETED') {
    if (messageText === '1' || messageText.includes('مرحبا') || messageText.includes('سلام')) {
      if (!activeDocs || activeDocs.length === 0) {
        return outputReply(
          "عذراً، لا يوجد أطباء متاحين للجدولة حالياً في المشفى. يرجى مراجعة إدارة المستشفى.",
          'IDLE'
        );
      }

      let docsPrompt = "أهلاً بك في مستشفى برج الأطباء. الرجاء إرسال رقم الطبيب الذي تريد التسجيل لديه:\n";
      activeDocs.forEach((doc, idx) => {
        docsPrompt += `\n*${idx + 1}* - ${doc.name} (${doc.specialty})`;
      });

      session.patient_name = null;
      session.selected_doctor_id = null;
      session.selected_shift = null;
      session.selected_schedule_id = null;
      session.selected_date = null;

      return outputReply(docsPrompt, 'SELECTING_DOCTOR');
    } else {
      return outputReply(
        "مرحباً بك في مستشفى برج الأطباء. لإجراء حجز عيادات جديد، يرجى إرسال كلمة 'تسجيل' أو الرقم '1' للمباشرة في حجز دورك.",
        'IDLE'
      );
    }
  }

  if (state === 'SELECTING_DOCTOR') {
    const selectedIdx = parseInt(messageText) - 1;
    if (isNaN(selectedIdx) || !activeDocs || selectedIdx < 0 || selectedIdx >= activeDocs.length) {
      return outputReply(
        "عذراً، لم أتمكن من فهم طلبك. الرجاء الالتزام بالخيارات المتاحة وإرسال رقم الطبيب الصحيح.",
        'SELECTING_DOCTOR'
      );
    }

    const doctor = activeDocs[selectedIdx];
    session.selected_doctor_id = doctor.id;

    const docSchedules = (activeSchedules || []).filter(s => s.doctor_id === doctor.id);
    if (docSchedules.length === 0) {
      let failPrompt = `عذراً، الطبيب *${doctor.name}* لا يوجد لديه عيادات مجدولة هذا الأسبوع حالياً.\n`;
      failPrompt += "يرجى اختيار طبيب آخر من القائمة التالية:\n";
      activeDocs.forEach((doc, idx) => {
        failPrompt += `\n*${idx + 1}* - ${doc.name} (${doc.specialty})`;
      });
      return outputReply(failPrompt, 'SELECTING_DOCTOR');
    }

    session.selected_shift = null;
    const { prompt } = getGroupedDatesForDoctorHelper(doctor, activeSchedules || []);
    return outputReply(prompt, 'SELECTING_DAY');
  }

  if (state === 'SELECTING_DAY') {
    const selectedIdx = parseInt(messageText) - 1;
    const doctor = activeDocs?.find(d => d.id === session.selected_doctor_id);
    
    if (!doctor) {
      return outputReply("عذراً، حدث خطأ ما في الجلسة. يرجى إرسال كلمة 'تسجيل' للبدء من جديد.", 'IDLE');
    }
    const { options } = getGroupedDatesForDoctorHelper(doctor, activeSchedules || []);

    if (isNaN(selectedIdx) || selectedIdx < 0 || selectedIdx >= options.length) {
      return outputReply(
        "عذراً، الرجاء اختيار يوم من الأيام المحددة لعيادة الطبيب بصيغة رقم صحيح.",
        'SELECTING_DAY'
      );
    }

    const option = options[selectedIdx];

    if (option.schedules.length > 1) {
      session.selected_date = option.date;
      return outputReply(
        "الطبيب متاح في فترتين في هذا اليوم، يرجى اختيار الفترة:\n1. صباحية\n2. مسائية",
        'SELECTING_SHIFT'
      );
    } else {
      const matchedSchedule = option.schedules[0];

      // فحص مدى استيعاب الحجوزات
      const { count: currentBookingsCount } = await supabase
        .from('bookings')
        .select('*', { count: 'exact', head: true })
        .eq('doctor_id', doctor.id)
        .eq('booking_date', option.date)
        .eq('schedule_id', matchedSchedule.id)
        .neq('status', 'cancelled');

      const liveBookings = currentBookingsCount || 0;
      if (liveBookings >= matchedSchedule.max_capacity) {
        return outputReply("اكتمل التسجيل في هذا اليوم، الرجاء اختيار يوم آخر لعيادة الطبيب.", 'SELECTING_DAY');
      }

      // الحد الأقصى للمريض لحجز موعدين لنفس الطبيب لمنع الإسبام
      if (doctor.limit_two_patients_per_number) {
        const { count: patientBookingsCount } = await supabase
          .from('bookings')
          .select('*', { count: 'exact', head: true })
          .eq('doctor_id', doctor.id)
          .eq('patient_phone', phone)
          .neq('status', 'cancelled');

        if ((patientBookingsCount || 0) >= 2) {
          session.current_state = 'IDLE';
          await supabase.from('bot_sessions').delete().eq('phone', phone);
          return outputReply(
            "عذراً، لقد تم الوصول إلى الحد الأقصى للتسجيل (مريضين كحد أقصى) لهذا الطبيب من رقم هذا الهاتف.",
            'IDLE'
          );
        }
      }

      session.selected_schedule_id = matchedSchedule.id;
      session.selected_date = option.date;
      session.selected_shift = parseInt(matchedSchedule.start_time.split(':')[0]) < 13 ? 'morning' : 'evening';

      return outputReply("يوجد متسع للحجز! الرجاء كتابة اسم المريض الرباعي لتأكيد ودور حجزك:", 'AWAITING_NAME');
    }
  }

  if (state === 'SELECTING_SHIFT') {
    const txt = messageText.trim();
    let selectedShift = null;
    if (txt === '1' || txt.includes('صباح')) {
      selectedShift = 'morning';
    } else if (txt === '2' || txt.includes('مساء')) {
      selectedShift = 'evening';
    } else {
      return outputReply(
        "الرجاء اختيار الفترة بكتابة الرقم المقابل:\n1. صباحية\n2. مسائية",
        'SELECTING_SHIFT'
      );
    }

    const doctor = activeDocs?.find(d => d.id === session.selected_doctor_id);
    if (!doctor) {
      return outputReply("عذراً، حدث خطأ في الجلسة. يرجى البدء مجدداً بكتابة 'تسجيل'.", 'IDLE');
    }
    const selectedDateStr = session.selected_date;
    const { options } = getGroupedDatesForDoctorHelper(doctor, activeSchedules || []);
    const matchedOption = options.find(o => o.date === selectedDateStr);
    
    if (!matchedOption) {
      await supabase.from('bot_sessions').delete().eq('phone', phone);
      return outputReply("عذراً، حدث خطأ ما في الجلسة. يرجى إرسال كلمة 'تسجيل' للبدء من جديد.", 'IDLE');
    }

    const matchedSchedule = matchedOption.schedules.find(s => {
      const startHour = parseInt(s.start_time.split(':')[0]);
      const sShift = startHour < 13 ? 'morning' : 'evening';
      return sShift === selectedShift;
    });

    if (!matchedSchedule) {
      return outputReply(
        `عذراً، هذه الفترة غير متاحة للطبيب في هذا اليوم. يرجى إعادة اختيار الفترة:`,
        'SELECTING_SHIFT'
      );
    }

    // فحص المقاعد
    const { count: currentBookingsCount } = await supabase
      .from('bookings')
      .select('*', { count: 'exact', head: true })
      .eq('doctor_id', doctor.id)
      .eq('booking_date', selectedDateStr)
      .eq('schedule_id', matchedSchedule.id)
      .neq('status', 'cancelled');

    if ((currentBookingsCount || 0) >= matchedSchedule.max_capacity) {
      return outputReply("عذراً، هذه الفترة متكاملة العدد للحجوزات لهذا اليوم. الرجاء إرسال 'تسجيل' للاختيار من جديد.", 'IDLE');
    }

    session.selected_schedule_id = matchedSchedule.id;
    session.selected_shift = selectedShift;

    return outputReply("يوجد متسع! الرجاء كتابة اسم المريض الرباعي لتأكيد وحفظ دورك الحجز:", 'AWAITING_NAME');
  }

  if (state === 'AWAITING_NAME') {
    const doctorId = session.selected_doctor_id;
    const dateStr = session.selected_date;
    const nameInput = messageText.trim();

    const wordsCount = nameInput.split(/\s+/).length;
    if (wordsCount < 2) {
      return outputReply("يرجى كتابة اسم المريض الثنائي أو الثلاثي على الأقل بشكل صحيح لتلقي وحفظ الحجز.", 'AWAITING_NAME');
    }

    // تجنب الأسماء المتكررة لنفس الدكتور وتاريخ الحجز
    const { data: nameExists } = await supabase
      .from('bookings')
      .select('id')
      .eq('doctor_id', doctorId)
      .eq('booking_date', dateStr)
      .ilike('patient_name', nameInput)
      .neq('status', 'cancelled')
      .maybeSingle();

    if (nameExists) {
      return outputReply(
        "هذا الاسم مسجل مسبقاً، يرجى كتابة الاسم الثلاثي أو إضافة اللقب للتمييز.",
        'AWAITING_NAME'
      );
    }

    const schedule = activeSchedules?.find(s => s.id === session.selected_schedule_id);
    const startHour = parseInt(schedule.start_time.split(':')[0]);
    const shiftValue = startHour < 13 ? 'Morning' : 'Evening';

    // حساب ترتيب الحجز الجديد
    const { data: qData } = await supabase
      .from('bookings')
      .select('queue_number')
      .eq('doctor_id', doctorId)
      .eq('booking_date', dateStr)
      .eq('shift', shiftValue);

    const maxQ = qData && qData.length > 0
      ? Math.max(...qData.map(b => b.queue_number || 0))
      : 0;
    const nextQueueNumber = Math.max(maxQ, qData?.length || 0) + 1;

    // إدراج الحجز في قاعدة بيانات supabase
    const { data: insertedBooking, error: insertErr } = await supabase
      .from('bookings')
      .insert([{
        doctor_id: doctorId,
        schedule_id: schedule.id,
        patient_name: nameInput,
        patient_phone: phone,
        booking_date: dateStr,
        queue_number: nextQueueNumber,
        shift: shiftValue,
        status: 'pending',
        payment_status: 'pending',
        verified_by_whatsapp: true
      }])
      .select()
      .single();

    if (insertErr) {
      console.error(insertErr);
      return outputReply("عذراً، واجه النظام خطأ غير متوقع أثناء الحفظ. يرجى المحاولة لاحقاً.", 'IDLE');
    }

    const deadlineDate = new Date();
    deadlineDate.setDate(deadlineDate.getDate() + 2);
    const deadlineStr = deadlineDate.toISOString().split('T')[0];

    const isMorning = startHour < 13;
    const shiftLabel = isMorning ? 'صباحية' : 'مسائية';
    const dayLabel = getDayNameArabic(schedule.day_of_week);
    const circleQueue = getCircledNumber(insertedBooking.queue_number || nextQueueNumber);

    const successMsg = `تم تأكيد الحجز بنجاح 🎉\n\nالاسم: ${nameInput}\nرقمك هو: ${circleQueue}\nالفترة: ${shiftLabel}\nموعدك هو: ( ${dayLabel} ) ( ${dateStr} )\n\nنتمنى لكم دوام الصحة والعافية.\n(يرجى تأكيد الحجز بواسطة دفع رسوم التسجيل للمشفى خلال يومين من تاريخ اليوم للحد النهائي ${deadlineStr}، وإلا سيعتبر الحجز لاغياً تلقائياً، وشكرا لثقتكم).`;

    // تصفير وتنظيف جلسة البوت
    await supabase.from('bot_sessions').delete().eq('phone', phone);

    return outputReply(successMsg, 'IDLE');
  }

  return outputReply("مرحباً بك في مستشفى برج الأطباء. يرجى إرسال كلمة 'تسجيل' أو رقم '1' للتسجيل والحجز.", 'IDLE');
}

// -------------------------------------------------------------------------
// دوال المزامنة الحركية لتواريخ جدولة الأطباء (Date Grouping Core)
// -------------------------------------------------------------------------
function getGroupedDatesForDoctorHelper(doctor, schedules) {
  const docSchedules = schedules.filter(s => s.doctor_id === doctor.id);
  const yemenNow = getYemenTime();
  const currentJsDay = yemenNow.getDay(); 
  const jsToOur = [1, 2, 3, 4, 5, -1, 0]; // الأحد=1، الإثنين=2، الثلاثاء=3... الجمعة=-1، السبت=0
  const ourCurrentDay = jsToOur[currentJsDay];

  const rawOptions = [];

  docSchedules.forEach(s => {
    const startHour = parseInt(s.start_time.split(':')[0]);
    const isMorning = startHour < 13;
    const currentHour = yemenNow.getHours();

    if (ourCurrentDay === -1) {
      const daysToAddCurrent = 1 + s.day_of_week;
      const dateCurrent = new Date(yemenNow.getTime() + daysToAddCurrent * 24 * 60 * 60 * 1000);
      rawOptions.push({
        day_of_week: s.day_of_week,
        date: dateCurrent.toISOString().split('T')[0],
        weekLabel: 'الأسبوع الحالي',
        schedule: s
      });

      if (doctor.allow_second_week_booking) {
        const daysToAddNext = 1 + s.day_of_week + 7;
        const dateNext = new Date(yemenNow.getTime() + daysToAddNext * 24 * 60 * 60 * 1000);
        rawOptions.push({
          day_of_week: s.day_of_week,
          date: dateNext.toISOString().split('T')[0],
          weekLabel: 'الأسبوع الثاني',
          schedule: s
        });
      }
    } else {
      const diff = s.day_of_week - ourCurrentDay;

      if (diff === 0) {
        let isExpired = false;
        if (isMorning && currentHour >= 12) {
          isExpired = true;
        } else if (!isMorning && currentHour >= 19) {
          isExpired = true;
        }

        if (!isExpired) {
          const dateCurrent = new Date(yemenNow.getTime() + diff * 24 * 60 * 60 * 1000);
          rawOptions.push({
            day_of_week: s.day_of_week,
            date: dateCurrent.toISOString().split('T')[0],
            weekLabel: 'الأسبوع الحالي',
            schedule: s
          });
        }
      } else if (diff > 0) {
        const dateCurrent = new Date(yemenNow.getTime() + diff * 24 * 60 * 60 * 1000);
        rawOptions.push({
          day_of_week: s.day_of_week,
          date: dateCurrent.toISOString().split('T')[0],
          weekLabel: 'الأسبوع الحالي',
          schedule: s
        });
      }

      if (doctor.allow_second_week_booking) {
        const diffNext = diff + 7;
        const dateNext = new Date(yemenNow.getTime() + diffNext * 24 * 60 * 60 * 1000);
        rawOptions.push({
          day_of_week: s.day_of_week,
          date: dateNext.toISOString().split('T')[0],
          weekLabel: 'الأسبوع الثاني',
          schedule: s
        });
      }
    }
  });

  const groupedMap = new Map();
  rawOptions.forEach(raw => {
    const existing = groupedMap.get(raw.date);
    if (existing) {
      if (!existing.schedules.some(s => s.id === raw.schedule.id)) {
        existing.schedules.push(raw.schedule);
      }
    } else {
      groupedMap.set(raw.date, {
        day_of_week: raw.day_of_week,
        date: raw.date,
        weekLabel: raw.weekLabel,
        schedules: [raw.schedule]
      });
    }
  });

  const options = Array.from(groupedMap.values()).sort((a, b) => {
    return new Date(a.date).getTime() - new Date(b.date).getTime();
  });

  let prompt = `عيادات الطبيب *${doctor.name}* متوفرة في الأيام التالية. يرجى حجز اليوم بكتابة رقمه المقابل:`;
  options.forEach((opt, idx) => {
    const dayName = getDayNameArabic(opt.day_of_week);
    const shiftsSet = new Set();
    opt.schedules.forEach(s => {
      const startHour = parseInt(s.start_time.split(':')[0]);
      shiftsSet.add(startHour < 13 ? 'صباحية' : 'مسائية');
    });

    let shiftsLabel = '';
    if (shiftsSet.has('صباحية') && shiftsSet.has('مسائية')) {
      shiftsLabel = 'صباحي ومسائي';
    } else if (shiftsSet.has('صباحية')) {
      shiftsLabel = 'صباحي فقط';
    } else {
      shiftsLabel = 'مسائي فقط';
    }

    prompt += `\n\n*${idx + 1}* - ( ${dayName} ) ( ${opt.date} ) -> [ ${shiftsLabel} ] (${opt.weekLabel})`;
  });

  return { prompt, options };
}

// -------------------------------------------------------------------------
// طرق واجهات الخادم (Express API Endpoints)
// -------------------------------------------------------------------------

/**
 * 1. مسار إرسال الرسائل الصادرة (تستدعى مجاناً من خادم Vercel للتنبيهات وإرسال الإشعارات)
 */
app.post('/api/send-message', async (req, res) => {
  const { to, message } = req.body;
  if (!to || !message) {
    return res.status(400).json({ error: 'Missing required parameter fields: (to) or (message)' });
  }

  if (connectionStatus !== 'Connected' || !sock) {
    return res.status(503).json({ error: 'WhatsApp bot Gateway is currently offline or unlinked.' });
  }

  try {
    const cleanTo = normalizePhone(to);
    console.log(`[API Send Message] Forwarding message to [+${cleanTo}]`);
    await sock.sendMessage(`${cleanTo}@s.whatsapp.net`, { text: message });
    
    // حفظ السجل الصادر
    await supabase.from('whatsapp_logs').insert([{
      phone: cleanTo,
      direction: 'out',
      message: message,
      timestamp: getYemenTime().toISOString()
    }]);

    res.json({ success: true, description: 'Message dispatched successfully!' });
  } catch (err) {
    console.error('Failed to send outbound message via Baileys API:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 2. واجهة إظهار كود الـ QR الديناميكي للمسح من الهاتف
 */
app.get('/api/qr', async (req, res) => {
  if (connectionStatus === 'Connected') {
    return res.send(`
      <html>
        <head>
          <title>Borg Bot Status</title>
          <meta charset="utf-8">
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; text-align: center; padding: 50px; background: #f4f6f8; color: #333; }
            .card { background: white; padding: 40px; border-radius: 16px; box-shadow: 0 4px 15px rgba(0,0,0,0.05); display: inline-block; max-width: 450px; }
            .badge { background: #10b981; color: white; padding: 6px 16px; border-radius: 50px; font-weight: bold; font-size: 14px; }
          </style>
        </head>
        <body>
          <div class="card">
            <h2>بوابة واتساب نشطة ومرتبطة بنجاح! 🎉</h2>
            <br/><br/>
            <span class="badge">نظام البوت متصل بالإنترنت</span>
            <br/><br/>
            <p>يعمل خادم البوت الآن على استقبال الرسائل من المرضى، كما يرسل الإشعارات بنجاح من لوحة تحكم Borg المدمجة.</p>
          </div>
        </body>
      </html>
    `);
  }

  if (!currentQr) {
    return res.send(`
      <html>
        <head>
          <title>Borg Bot Status</title>
          <meta charset="utf-8">
          <meta http-equiv="refresh" content="3">
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", sans-serif; text-align: center; padding: 50px; background: #f4f6f8; }
            .card { background: white; padding: 40px; border-radius: 16px; box-shadow: 0 4px 15px rgba(0,0,0,0.05); display: inline-block; }
          </style>
        </head>
        <body>
          <div class="card">
            <h2>يجرى تشغيل خادم مصفوفة البوت...</h2>
            <p>الرجاء الانتظار ثوانٍ معدودة، جاري الاتصال وتوليد كود QR لتتمكن من مسحه. يتم تحديث الصفحة تلقائياً.</p>
          </div>
        </body>
      </html>
    `);
  }

  try {
    const qrImage = await QRCode.toDataURL(currentQr);
    res.send(`
      <html>
        <head>
          <title>Borg Bot QR Scan</title>
          <meta charset="utf-8">
          <meta http-equiv="refresh" content="20">
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; text-align: center; padding: 30px; background: #f4f6f8; }
            .card { background: white; padding: 35px; border-radius: 20px; box-shadow: 0 10px 25px rgba(0,0,0,0.08); display: inline-block; max-width: 420px; }
            img { border: 1px solid #e1e8ed; border-radius: 12px; padding: 10px; width: 250px; height: 250px; }
            p { font-size: 14px; color: #657786; line-height: 1.5; }
            .badge { background: #f59e0b; color: white; padding: 5px 12px; border-radius: 50px; font-weight: bold; font-size: 12px; }
          </style>
        </head>
        <body>
          <div class="card">
            <h2>اتصال بوابة واتساب مستشفى البرج</h2>
            <span class="badge">في انتظار المسح الضوئي</span>
            <br/><br/>
            <p>يرجى فتح تطبيق الواتساب المخصص للبوت من هاتف العيادة -> الأجهزة المرتبطة -> رمز QR لربط الخدمة مجاناً.</p>
            <br/>
            <img src="${qrImage}" />
            <br/><br/>
            <p>يتم تحديث هذه الصفحة والرمز تلقائياً كل 20 ثانية لتجنب انتهاء صلاحية كود الاتصال.</p>
          </div>
        </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send('Failed to generate rendering image for connection QR code');
  }
});

// بدائل الصحة والمتابعة لخادم Render
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    renderServerId: RENDER_SERVER_ID,
    connection: connectionStatus,
    active: sock !== null
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Standalone Bot Server] Gateway listening bound on host: 0.0.0.0 and port ${PORT}`);
  startWhatsAppBot();
});
