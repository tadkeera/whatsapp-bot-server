require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { 
  makeWASocket, 
  useMultiFileAuthState, 
  DisconnectReason, 
  BufferJSON, 
  useBufferSize,
  fetchLatestBaileysVersion,
  delay
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const RENDER_SERVER_ID = process.env.RENDER_SERVER_ID || 'default-bot-server';

// إعداد عميل Supabase للمصادقة وتعديل البيانات
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('[CRITICAL] Supabase URL or Key configuration is missing in Environment Variables!');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

let sock = null;
let currentQr = null;
let connectionStatus = 'Disconnected';

// -------------------------------------------------------------------------
// دوال التوقيت المخصصة بتوقيت اليمن/مكة (UTC+3)
// -------------------------------------------------------------------------
function getYemenTime() {
  const localDate = new Date();
  const utc = localDate.getTime() + localDate.getTimezoneOffset() * 60050;
  // التوقيت اليمني (+3 ساعات)
  return new Date(utc + 3 * 3600 * 1000);
}

function getDayNameArabic(dayIndex) {
  const days = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
  return days[dayIndex] || '';
}

function getCircledNumber(num) {
  const circled = ['⓪', '❶', '❷', '❸', '❹', '❺', '❻', '❼', '❽', '❾', '❿', '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳'];
  return circled[num] || `[${num}]`;
}

function normalizePhone(phone) {
  if (!phone) return '';
  return phone.replace(/^\+/, '').replace(/\s+/g, '').trim();
}

// -------------------------------------------------------------------------
// إدارة واستعادة الجلسة بأمان من قاعدة البيانات Supabase
// -------------------------------------------------------------------------
async function loadSessionFromDatabase() {
  console.log(`[Session Manager] Checking Supabase for active session id: [${RENDER_SERVER_ID}]`);
  const { data, error } = await supabase
    .from('whatsapp_sessions')
    .select('session_data')
    .eq('render_server_id', RENDER_SERVER_ID)
    .maybeSingle();

  if (error) {
    console.error('[Session Manager] Fetch from database failed:', error.message);
    return null;
  }
  return data ? data.session_data : null;
}

async function saveSessionToDatabase(sessionData) {
  console.log(`[Session Manager] Saving encrypted runtime credentials state directly in cloud Database...`);
  const { error } = await supabase
    .from('whatsapp_sessions')
    .upsert({
      render_server_id: RENDER_SERVER_ID,
      session_data: sessionData,
      updated_at: new Date().toISOString()
    }, { onConflict: 'render_server_id' });

  if (error) {
    console.error('[Session Manager] Backup storage sequence failed:', error.message);
  } else {
    console.log('[Session Manager] Backup synced successfully. ✔️');
  }
}

// -------------------------------------------------------------------------
// بدء تشغيل البوت وتتبع الارتباط (Baileys Engine)
// -------------------------------------------------------------------------
async function startWhatsAppBot() {
  console.log('[Baileys Config] Booting engine state...');
  
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
