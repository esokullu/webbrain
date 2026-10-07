const EN = {
  title: 'Share this trace on GitHub?',
  publicWarning: 'Uploading makes this file publicly accessible immediately, even if you never submit the GitHub issue.',
  full: 'Includes recorded conversation text, tool details, and any saved screenshots. Screenshots may contain private information. Obvious credentials are masked; review the trace before sharing.',
  diagnostic: 'Includes diagnostic metadata: tool names, outcomes, error codes, and timings. Conversation text and screenshots that were not recorded are unavailable.',
  upload: 'Upload trace and open GitHub', without: 'Continue without trace', cancel: 'Cancel', view: 'View trace',
  fullLabel: 'Full recorded trace', diagnosticLabel: 'Diagnostic trace',
  details: 'Conversation {session} · {type} · {runs} runs · {shots} screenshots · {size}',
  preparing: 'Preparing trace locally…',
  omitted: 'Some content is unavailable or excluded. See the trace for details.',
  oversized: 'The full export is too large to attach. Only the diagnostic fallback will be uploaded. View trace to download the full export locally.',
  failed: 'The trace attachment could not be confirmed. Check the draft before retrying, or download the trace.',
  uploading: 'Attaching your trace. Please wait before submitting the issue.',
  ready: 'Trace attached. Review and submit your feedback on GitHub.',
  draftReady: 'Review and submit your feedback on GitHub.',
  retry: 'Retry attachment', download: 'Download trace', close: 'Close',
  local: 'Local preview. Nothing is uploaded by viewing or downloading this trace.',
  original: 'Download full export', previewLimited: 'Preview shortened. Download the export to inspect the complete file.',
  unavailable: 'No recorded trace is available for this conversation.',
  exportFailed: 'The trace could not be read; no trace is attached.',
  settingLabel: 'Local feedback diagnostics',
  settingDescription: 'Keep recent diagnostic metadata locally, even when Record traces is off. Limited to 10 completed runs, 7 days, and 2 MiB. Upload requires confirmation when sending feedback; conversation text and screenshots are not recorded by this option.',
};

// Keep the consequential disclosure and actions translated for every UI locale.
// Secondary status text uses the same English fallback as the main UI.
const CORE = {
  ru: ['Поделиться этой трассировкой на GitHub?', 'Файл станет общедоступным сразу после загрузки, даже если вы не отправите обращение на GitHub.', 'Загрузить трассировку и открыть GitHub', 'Продолжить без трассировки', 'Отмена', 'Посмотреть трассировку'],
  ar: ['مشاركة هذا التتبع على GitHub؟', 'يصبح هذا الملف متاحًا للجميع فور رفعه، حتى لو لم ترسل المشكلة على GitHub.', 'رفع التتبع وفتح GitHub', 'المتابعة دون تتبع', 'إلغاء', 'عرض التتبع'],
  bn: ['এই ট্রেস GitHub-এ শেয়ার করবেন?', 'আপলোড করলেই ফাইলটি সবার জন্য উন্মুক্ত হবে, আপনি GitHub ইস্যু জমা না দিলেও।', 'ট্রেস আপলোড করে GitHub খুলুন', 'ট্রেস ছাড়া চালিয়ে যান', 'বাতিল', 'ট্রেস দেখুন'],
  de: ['Diesen Trace auf GitHub teilen?', 'Die Datei ist sofort nach dem Hochladen öffentlich zugänglich, auch wenn du das GitHub-Issue nie absendest.', 'Trace hochladen und GitHub öffnen', 'Ohne Trace fortfahren', 'Abbrechen', 'Trace ansehen'],
  es: ['¿Compartir esta traza en GitHub?', 'El archivo será público inmediatamente al subirlo, aunque nunca envíes la incidencia de GitHub.', 'Subir traza y abrir GitHub', 'Continuar sin traza', 'Cancelar', 'Ver traza'],
  fa: ['این ردگیری در GitHub به اشتراک گذاشته شود؟', 'فایل بلافاصله پس از بارگذاری برای همه قابل دسترسی می‌شود، حتی اگر گزارش GitHub را ارسال نکنید.', 'بارگذاری ردگیری و باز کردن GitHub', 'ادامه بدون ردگیری', 'لغو', 'مشاهده ردگیری'],
  fr: ['Partager cette trace sur GitHub ?', 'Le fichier devient public dès son téléversement, même si vous ne soumettez jamais le ticket GitHub.', 'Téléverser la trace et ouvrir GitHub', 'Continuer sans trace', 'Annuler', 'Voir la trace'],
  he: ['לשתף את התיעוד הזה ב-GitHub?', 'הקובץ יהיה נגיש לציבור מיד לאחר ההעלאה, גם אם לא תשלחו את הדיווח ב-GitHub.', 'העלאת התיעוד ופתיחת GitHub', 'המשך ללא תיעוד', 'ביטול', 'הצגת התיעוד'],
  hi: ['यह ट्रेस GitHub पर साझा करें?', 'अपलोड होते ही फ़ाइल सार्वजनिक हो जाएगी, भले ही आप GitHub समस्या कभी जमा न करें।', 'ट्रेस अपलोड करें और GitHub खोलें', 'ट्रेस के बिना जारी रखें', 'रद्द करें', 'ट्रेस देखें'],
  id: ['Bagikan trace ini di GitHub?', 'Berkas langsung dapat diakses publik setelah diunggah, meskipun Anda tidak pernah mengirim issue GitHub.', 'Unggah trace dan buka GitHub', 'Lanjutkan tanpa trace', 'Batal', 'Lihat trace'],
  ja: ['このトレースをGitHubで共有しますか？', 'アップロードすると、GitHubのIssueを送信しなくても、ファイルは直ちに公開されます。', 'トレースをアップロードしてGitHubを開く', 'トレースなしで続行', 'キャンセル', 'トレースを表示'],
  ko: ['이 트레이스를 GitHub에 공유할까요?', '업로드하면 GitHub 이슈를 제출하지 않아도 파일이 즉시 공개됩니다.', '트레이스 업로드 후 GitHub 열기', '트레이스 없이 계속', '취소', '트레이스 보기'],
  ms: ['Kongsi jejak ini di GitHub?', 'Fail boleh diakses umum serta-merta selepas dimuat naik, walaupun anda tidak menghantar isu GitHub.', 'Muat naik jejak dan buka GitHub', 'Teruskan tanpa jejak', 'Batal', 'Lihat jejak'],
  nl: ['Deze trace op GitHub delen?', 'Het bestand is direct na het uploaden openbaar, ook als je het GitHub-issue nooit indient.', 'Trace uploaden en GitHub openen', 'Doorgaan zonder trace', 'Annuleren', 'Trace bekijken'],
  pl: ['Udostępnić ten ślad na GitHub?', 'Plik stanie się publicznie dostępny natychmiast po przesłaniu, nawet jeśli nie wyślesz zgłoszenia GitHub.', 'Prześlij ślad i otwórz GitHub', 'Kontynuuj bez śladu', 'Anuluj', 'Zobacz ślad'],
  pt: ['Compartilhar este rastreamento no GitHub?', 'O arquivo ficará público imediatamente após o envio, mesmo que você nunca publique a issue no GitHub.', 'Enviar rastreamento e abrir GitHub', 'Continuar sem rastreamento', 'Cancelar', 'Ver rastreamento'],
  th: ['แชร์บันทึกนี้บน GitHub หรือไม่?', 'ไฟล์จะเปิดให้สาธารณะเข้าถึงได้ทันทีที่อัปโหลด แม้คุณจะไม่ส่งปัญหาบน GitHub ก็ตาม', 'อัปโหลดบันทึกและเปิด GitHub', 'ดำเนินการต่อโดยไม่แนบบันทึก', 'ยกเลิก', 'ดูบันทึก'],
  tl: ['Ibahagi ang trace na ito sa GitHub?', 'Magiging pampubliko agad ang file kapag na-upload, kahit hindi mo isumite ang GitHub issue.', 'I-upload ang trace at buksan ang GitHub', 'Magpatuloy nang walang trace', 'Kanselahin', 'Tingnan ang trace'],
  tr: ['Bu izi GitHub’da paylaşmak ister misiniz?', 'Dosya yüklendiği anda herkese açık olur; GitHub sorununu göndermeseniz bile dosyaya erişilebilir.', 'İzi yükle ve GitHub’ı aç', 'İz olmadan devam et', 'İptal', 'İzi görüntüle'],
  uk: ['Поділитися цим трасуванням на GitHub?', 'Файл стане загальнодоступним одразу після завантаження, навіть якщо ви не надішлете звернення на GitHub.', 'Завантажити трасування й відкрити GitHub', 'Продовжити без трасування', 'Скасувати', 'Переглянути трасування'],
  vi: ['Chia sẻ dấu vết này trên GitHub?', 'Tệp sẽ công khai ngay khi tải lên, kể cả khi bạn không gửi vấn đề trên GitHub.', 'Tải dấu vết lên và mở GitHub', 'Tiếp tục không kèm dấu vết', 'Hủy', 'Xem dấu vết'],
  zh: ['在 GitHub 上分享此跟踪记录？', '上传后文件会立即公开，即使您最终没有提交 GitHub 问题。', '上传跟踪记录并打开 GitHub', '不附带跟踪记录继续', '取消', '查看跟踪记录'],
};
const CONTENT = {
  ar: ['يتضمن نص المحادثة وتفاصيل الأدوات ولقطات الشاشة المحفوظة، إن وُجدت. تُخفى بيانات الاعتماد الواضحة؛ راجع الملف قبل مشاركته.', 'يتضمن بيانات تشخيصية فقط: أسماء الأدوات والنتائج ورموز الأخطاء والتوقيتات. لا تتوفر النصوص أو الصور غير المسجلة.'],
  bn: ['সংরক্ষিত কথোপকথন, টুলের বিবরণ ও উপলব্ধ স্ক্রিনশট অন্তর্ভুক্ত থাকে। স্পষ্ট পরিচয়পত্র গোপন করা হয়; শেয়ার করার আগে ফাইলটি দেখুন।', 'শুধু ডায়াগনস্টিক তথ্য থাকে: টুলের নাম, ফলাফল, ত্রুটি কোড ও সময়। রেকর্ড না করা লেখা বা স্ক্রিনশট নেই।'],
  de: ['Enthält aufgezeichnete Gespräche, Werkzeugdetails und vorhandene Screenshots. Offensichtliche Zugangsdaten werden maskiert; prüfe die Datei vor dem Teilen.', 'Enthält nur Diagnosedaten: Werkzeugnamen, Ergebnisse, Fehlercodes und Zeitangaben. Nicht aufgezeichnete Texte und Screenshots sind nicht verfügbar.'],
  es: ['Incluye conversaciones grabadas, detalles de herramientas y capturas disponibles. Se ocultan las credenciales evidentes; revisa el archivo antes de compartirlo.', 'Solo incluye datos de diagnóstico: nombres de herramientas, resultados, códigos de error y tiempos. Los textos y capturas no grabados no están disponibles.'],
  fa: ['شامل گفت‌وگوی ثبت‌شده، جزئیات ابزارها و تصاویر ذخیره‌شده است. اطلاعات ورود آشکار پوشانده می‌شوند؛ پیش از اشتراک‌گذاری فایل را بررسی کنید.', 'فقط شامل اطلاعات تشخیصی است: نام ابزارها، نتایج، کدهای خطا و زمان‌ها. متن و تصاویر ثبت‌نشده موجود نیستند.'],
  he: ['כולל שיחות שהוקלטו, פרטי כלים וצילומי מסך זמינים. פרטי גישה ברורים מוסתרים; בדקו את הקובץ לפני השיתוף.', 'כולל רק נתוני אבחון: שמות כלים, תוצאות, קודי שגיאה וזמנים. טקסט ותמונות שלא תועדו אינם זמינים.'],
  hi: ['रिकॉर्ड की गई बातचीत, टूल विवरण और उपलब्ध स्क्रीनशॉट शामिल हैं। स्पष्ट लॉगिन जानकारी छिपाई जाती है; साझा करने से पहले फ़ाइल देखें।', 'केवल निदान जानकारी: टूल के नाम, परिणाम, त्रुटि कोड और समय। रिकॉर्ड न किया गया पाठ या स्क्रीनशॉट उपलब्ध नहीं है।'],
  id: ['Berisi percakapan yang direkam, detail alat, dan tangkapan layar yang tersedia. Kredensial yang jelas disamarkan; periksa berkas sebelum berbagi.', 'Hanya berisi diagnostik: nama alat, hasil, kode kesalahan, dan waktu. Teks dan tangkapan layar yang tidak direkam tidak tersedia.'],
  ja: ['記録された会話、ツールの詳細、保存済みのスクリーンショットを含みます。明らかな認証情報はマスクされます。共有前にファイルを確認してください。', 'ツール名、結果、エラーコード、時間などの診断情報のみを含みます。記録されていない会話やスクリーンショットは含まれません。'],
  ko: ['기록된 대화, 도구 세부 정보 및 저장된 스크린샷을 포함합니다. 명백한 인증 정보는 가려집니다. 공유하기 전에 파일을 확인하세요.', '도구 이름, 결과, 오류 코드 및 시간 등 진단 정보만 포함합니다. 기록하지 않은 대화나 스크린샷은 제공되지 않습니다.'],
  ms: ['Mengandungi perbualan yang direkodkan, butiran alat dan tangkapan skrin yang tersedia. Bukti kelayakan yang jelas disamarkan; semak fail sebelum berkongsi.', 'Hanya mengandungi diagnostik: nama alat, hasil, kod ralat dan masa. Teks dan tangkapan skrin yang tidak direkodkan tidak tersedia.'],
  nl: ['Bevat opgenomen gesprekken, tooldetails en beschikbare schermafbeeldingen. Duidelijke inloggegevens worden afgeschermd; controleer het bestand voordat je het deelt.', 'Bevat alleen diagnostiek: toolnamen, resultaten, foutcodes en tijden. Niet opgenomen tekst en schermafbeeldingen zijn niet beschikbaar.'],
  pl: ['Zawiera zapisane rozmowy, szczegóły narzędzi i dostępne zrzuty ekranu. Oczywiste dane logowania są maskowane; sprawdź plik przed udostępnieniem.', 'Zawiera tylko diagnostykę: nazwy narzędzi, wyniki, kody błędów i czasy. Niezapisane teksty i zrzuty ekranu nie są dostępne.'],
  pt: ['Inclui conversas gravadas, detalhes de ferramentas e capturas disponíveis. Credenciais evidentes são ocultadas; revise o arquivo antes de compartilhar.', 'Inclui apenas diagnóstico: nomes de ferramentas, resultados, códigos de erro e tempos. Textos e capturas não gravados não estão disponíveis.'],
  ru: ['Содержит записанные разговоры, детали инструментов и сохранённые снимки экрана. Очевидные учётные данные маскируются; проверьте файл перед отправкой.', 'Содержит только диагностику: имена инструментов, результаты, коды ошибок и время. Незаписанный текст и снимки экрана недоступны.'],
  th: ['รวมบทสนทนาที่บันทึกไว้ รายละเอียดเครื่องมือ และภาพหน้าจอที่มีอยู่ ข้อมูลรับรองที่ชัดเจนจะถูกปิดบัง โปรดตรวจสอบไฟล์ก่อนแชร์', 'มีเฉพาะข้อมูลวินิจฉัย: ชื่อเครื่องมือ ผลลัพธ์ รหัสข้อผิดพลาด และเวลา ไม่มีข้อความหรือภาพหน้าจอที่ไม่ได้บันทึกไว้'],
  tl: ['Kasama ang naitalang usapan, detalye ng mga tool, at available na screenshot. Itinatago ang malinaw na kredensyal; suriin ang file bago ibahagi.', 'Diagnostic data lamang: pangalan ng mga tool, resulta, error code, at oras. Walang tekstong o screenshot na hindi naitala.'],
  uk: ['Містить записані розмови, деталі інструментів і збережені знімки екрана. Очевидні облікові дані маскуються; перевірте файл перед надсиланням.', 'Містить лише діагностику: назви інструментів, результати, коди помилок і час. Незаписаний текст і знімки екрана недоступні.'],
  vi: ['Gồm cuộc trò chuyện đã ghi, chi tiết công cụ và ảnh chụp màn hình có sẵn. Thông tin đăng nhập rõ ràng được che; hãy xem tệp trước khi chia sẻ.', 'Chỉ gồm chẩn đoán: tên công cụ, kết quả, mã lỗi và thời gian. Văn bản và ảnh chụp chưa ghi không có sẵn.'],
  zh: ['包含已记录的对话、工具详情和已保存的截图。明显的凭据会被遮盖；分享前请检查文件。', '仅包含诊断信息：工具名称、结果、错误代码和时间。未记录的对话文本和截图不可用。'],
};
const EXTRA = {
  tr: {
    full: 'Kaydedilmiş konuşma metni, araç ayrıntıları ve varsa ekran görüntülerini içerir. Ekran görüntülerinde özel bilgiler olabilir. Belirgin kimlik bilgileri maskelenir; paylaşmadan önce izi inceleyin.',
    diagnostic: 'Araç adları, sonuçlar, hata kodları ve süreler gibi tanılama bilgilerini içerir. Kaydedilmemiş konuşma metni ve ekran görüntüleri mevcut değildir.',
    fullLabel: 'Tam kaydedilmiş iz', diagnosticLabel: 'Tanılama izi',
    details: 'Konuşma {session} · {type} · {runs} çalışma · {shots} ekran görüntüsü · {size}',
    preparing: 'İz yerel olarak hazırlanıyor…', settingLabel: 'Yerel geri bildirim tanılaması',
    settingDescription: 'İz kaydı kapalı olsa da son tanılama bilgilerini cihazda saklar. En fazla 10 tamamlanan çalışma, 7 gün ve 2 MiB. Geri bildirim gönderirken yükleme için onay gerekir; bu seçenek konuşma metni veya ekran görüntüsü kaydetmez.',
  },
  fr: {
    full: 'Contient le texte de conversation enregistré, les détails des outils et les captures conservées. Les captures peuvent contenir des informations privées. Les identifiants évidents sont masqués ; vérifiez la trace avant de la partager.',
    diagnostic: 'Contient les noms des outils, les résultats, les codes d’erreur et les durées. Le texte et les captures non enregistrés ne sont pas disponibles.',
    fullLabel: 'Trace enregistrée complète', diagnosticLabel: 'Trace de diagnostic',
    details: 'Conversation {session} · {type} · {runs} exécutions · {shots} captures · {size}',
  },
};
export function getFeedbackCopy(locale = 'en') {
  const copy = { ...EN, ...EXTRA[locale] };
  if (CORE[locale]) ['title', 'publicWarning', 'upload', 'without', 'cancel', 'view'].forEach((key, index) => { copy[key] = CORE[locale][index]; });
  if (CONTENT[locale]) [copy.full, copy.diagnostic] = CONTENT[locale];
  return copy;
}
export function formatFeedbackDetails(trace, copy) {
  const values = { session: trace.sessionId, type: copy[`${trace.traceType}Label`],
    runs: trace.runCount, shots: trace.screenshotCount, size: `${(trace.blob.size / 1024).toFixed(1)} KiB` };
  return copy.details.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');
}

export const feedbackTranslations = Object.fromEntries(['en', ...Object.keys(CORE)].map(locale => {
  const copy = getFeedbackCopy(locale);
  return [locale, {
    'st.display.feedback_diagnostics.label': copy.settingLabel,
    'st.display.feedback_diagnostics.desc': copy.settingDescription,
  }];
}));
