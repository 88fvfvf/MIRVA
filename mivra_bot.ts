/**
 * MIVRA — B2B Telegram Bot v6.0
 * Savdoni osonlashtiramiz.
 *
 * v6 additions vs v5:
 *  M1 — Competitive Offer Board: aggregate stats, sorted ranking (price/speed/deals/newest)
 *  M2 — Supplier Market Position: anonymous stats after submission, no competitor names
 *  M3 — Offer Improvement: supplier can update price+ETA on a pending offer
 *  M4 — Pre-accept Confirmation: full supplier profile before final acceptance
 *  M5 — Negotiation stage: 'accepted' relabeled as Negotiations in UX
 *
 * SETUP: npm install telegraf dotenv
 *        npm install -D typescript ts-node @types/node
 * .env:  BOT_TOKEN=...  ADMIN_ID=...
 * Run:   npx ts-node mivra_bot.ts
 */

import { Telegraf, Markup } from 'telegraf';
import { startPaycomServer, buildCheckoutUrl } from './mivra_paycom';
import { logger } from './mivra_logger';
import { message } from 'telegraf/filters';
import * as dotenv from 'dotenv';
dotenv.config();

import { getDb, closeDb } from './mivra_db';
import { runMigration } from './mivra_migrate';
import {
  createRepos, Repos, User, RegularUser, StoreUser, SupplierUser,
  Offer, Request, Product, DealRecord, AnalyticsEventType,
  Lang, SupplierTier, ReqStatus, SessionData
} from './mivra_repos';
import { smartSearch, getCatalogMeta as dbGetCatalogMeta } from './mivra_search';
import { SpamGuard } from './mivra_spam';
import { buildAdminAnalytics, formatAdminStats } from './mivra_analytics';

// ─── TRANSLATIONS ─────────────────────────────────────────────────────────────

const TR = {
  ru: {
    select_lang: '👋 Добро пожаловать в *MIVRA*\n_Savdoni osonlashtiramiz._\n\nВыберите язык / Tilni tanlang:',
    lang_ru: '🇷🇺 Русский', lang_uz: "🇺🇿 O'zbek",
    choose_role: 'Кем вы являетесь?',
    role_store: '🏪 Магазин', role_supplier: '🚛 Поставщик',
    catalog: '🔍 Каталог', create_req: '📝 Создать заявку',
    my_reqs: '📋 Мои заявки', favorites: '⭐ Избранное', help: 'ℹ️ Помощь',
    buyer_reqs: '📥 Заявки', my_prods: '📦 Мои товары',
    add_prod: '➕ Добавить товар', profile: '👤 Профиль',
    stats: '📊 Статистика', all_reqs: '📋 Все заявки',
    sups: '👥 Поставщики', prods: '🛍 Продукты',
    cat_empty: '📭 Каталог пуст. Поставщики скоро добавят товары.',
    prev: '◀️', next: '▶️',
    contact: '📞 Контакт', verified: '✅ Проверенный',
    search: '🔍 Поиск', filter: '🔽 Фильтр',
    search_hint: 'Введите название или категорию для поиска:',
    no_results: '🔍 Ничего не найдено.',
    filter_by_cat: '📁 По категории', filter_by_city: '📍 По городу',
    filter_reset: '🔄 Сбросить', filter_active: '🔽 Фильтр активен',
    ask_prod: '📦 Название товара:\nПример: Pepsi 1.5L',
    ask_cat: '📁 Категория:\nПример: Напитки',
    ask_spec: '📝 Описание / требования:\nЕсли нет — нет',
    ask_qty: '📊 Количество (только цифра):', ask_unit: '📏 Единица:',
    ask_city: '📍 Город доставки:', ask_addr: '🏠 Адрес доставки:',
    ask_phone: '📞 Контактный телефон:',
    ask_date: '📅 Дата доставки:\nПример: 15.06.2026 (или нет)',
    ask_notes: '📝 Примечания (или нет):',
    req_done: '✅ Заявка создана! Поставщики уведомлены.',
    ask_price: '💰 Цена за единицу:\nПример: 150,000 сум за коробку',
    ask_del: '🚚 Доставка доступна?', ask_neg: '💬 Цена договорная?',
    ask_eta: '📅 Срок доставки:\nПример: 1–2 дня, Завтра',
    ask_cmt: '📝 Комментарий (или нет):',
    offer_sent: '✅ Предложение отправлено!',
    offer_accept: '✅ Принять', offer_reject: '❌ Отклонить',
    offer_accepted_msg: '✅ Поставщик выбран!',
    offer_rejected_msg: '❌ Предложение отклонено.',
    offer_accepted_notif: '🎉 Ваше предложение принято!',
    offer_rejected_notif: '❌ Ваше предложение отклонено.',
    offer_closed_notif: '❌ Заявка закрыта — выбран другой поставщик.',
    send_offer_btn: '📨 Отправить предложение', skip_req_btn: '⏭ Не актуально',
    yes: '✅ Да', no: '❌ Нет',
    boxes: '📦 Коробки', packs: '📫 Пачки', units: '🔢 Штуки',
    r_sname: '🏪 Название магазина:', r_phone: '📞 Телефон (+998 ...):',
    r_city: '📍 Город:', r_company: '🏢 Название компании:',
    r_contact: '👤 Контактное лицо (ФИО):', r_desc: '📝 Описание бизнеса:\nЧем торгуете?',
    r_store_done: '✅ Регистрация завершена!', r_sup_pending: '⏳ Заявка отправлена!',
    p_name: '📦 Название:', p_cat: '📁 Категория:', p_desc: '📝 Описание:',
    p_wv: '⚖️ Вес/Объём:', p_upb: '📦 В упаковке:', p_moq: '📊 Мин. заказ:',
    p_price: '💰 Цена:', p_avail: '✅ Статус наличия:',
    p_photos: '📸 Фото (до 5 шт). Затем /done', p_added: '✅ Товар добавлен!',
    suspended: '⛔ Аккаунт приостановлен.', pending_sup: '⏳ Ожидает одобрения.',
    not_active: '⛔ Аккаунт не активен.', expired: '⚠️ Сессия устарела. /start',
    no_reqs: '📭 Активных заявок нет.', no_prods: 'Товаров нет.',
    only_approved: 'Только для одобренных поставщиков.',
    req_closed: 'Заявка закрыта или не найдена.', already_replied: 'Вы уже ответили.',
    views: '👁', limit_reqs: '⚠️ Лимит: максимум 5 активных заявок.',
    limit_prods: '⚠️ Лимит активных товаров достигнут.',
    dup_req_smart: '⚠️ Идентичная заявка создана менее 15 минут назад.',
    bad_phone: '⚠️ Введите корректный номер.', slow_down: '⚠️ Не так быстро.',
    no_qty_number: '⚠️ Введите положительное число.',
    offer_pending: '⏳ Ожидает', offer_accepted_lbl: '✅ Принято', offer_rejected_lbl: '❌ Отклонено',
    req_status_active: '🟢 Активна', req_status_offer: '💬 Идёт конкурс',
    req_status_accepted: '🤝 Переговоры',  // M5: relabeled
    req_status_delivered: '🚚 Доставлено',
    req_status_completed: '✅ Завершена', req_status_cancelled: '❌ Отменена',
    mark_delivered_btn: '🚚 Отметить как доставлено',
    confirm_delivery_btn: '✅ Подтвердить получение',
    delivered_notif_store: '🚚 Поставщик отметил доставку!\n\nПодтвердите получение:',
    delivered_notif_sup: '📦 Ожидаем подтверждения магазина.',
    completed_notif_store: '✅ Поставка подтверждена. Сделка завершена!',
    completed_notif_sup: '🎉 Магазин подтвердил получение! Сделка завершена.',
    active_deals: '🤝 Активные сделки', waiting_confirm: '⏳ Ожидает подтверждения',
    offers_summary_btn: '💬 Итоги',
    view_more_photos: '📸 Ещё фото',
    delivery_yes: 'Доставка', delivery_no: 'Самовывоз',
    delivery_scope_title: '🚚 Зона:',
    delivery_scope_uzbekistan: '🌍 Весь Узбекистан',
    delivery_scope_regional: '📍 Только регион',
    p_scope: '🚚 Выберите зону доставки:',
    ef_scope: '🚚 Зона доставки',
    broadcast_btn: '📢 Рассылка',
    broadcast_target: '📢 Кому отправить рассылку?',
    broadcast_target_all: '👥 Всем пользователям',
    broadcast_target_stores: '🏪 Только магазинам',
    broadcast_target_sups: '🚛 Только поставщикам',
    broadcast_ask_msg: '✏️ Введите текст рассылки:',
    broadcast_ask_photo: '📸 Прикрепите фото или напишите /skip:',
    broadcast_sent: '✅ Рассылка отправлена:',
    broadcast_limited: '⚠️ Лимит рассылок: 3 в час.',
    price_neg_label: 'Договорная', price_fixed_label: 'Фикс.',
    add_to_fav: '⭐ В избранное', remove_from_fav: '💛 Убрать',
    fav_added: '⭐ Добавлено!', fav_removed: '💔 Убрано.',
    fav_empty: '⭐ Список избранного пуст.',
    my_deals_label: '🛒 Завершённых покупок',
    completed_deals_lbl: '✅ Сделок завершено',
    products_listed_lbl: '📦 Товаров в каталоге',
    member_since_lbl: '📅 Участник с',
    new_req_title: '🔔 Новая заявка!',
    offers_none: '📭 Предложений нет.',
    cats_select: '📁 Выберите категории (можно несколько):',
    cats_confirm: '✅ Готово', cat_custom: '✏️ Другое',
    cat_custom_hint: '✏️ Введите категории через запятую:',
    cats_updated: '✅ Категории обновлены!', edit_cats_btn: '📁 Изменить категории',
    no_cats_selected: '⚠️ Выберите хотя бы одну категорию.',
    edit_prod_btn: '✏️ Редактировать', archive_btn: '🗄 В архив',
    restore_btn: '📤 Восстановить', archived_label: '🗄 Архивирован',
    my_archived_btn: '🗄 Архив', prod_archived: '🗄 Товар архивирован.',
    prod_restored: '✅ Товар восстановлен!', edit_choose_field: '✏️ Что изменить?',
    ef_name: '📦 Название', ef_cat: '📁 Категория', ef_desc: '📝 Описание',
    ef_price: '💰 Цена', ef_moq: '📊 Мин. заказ', ef_avail: '✅ Наличие',
    ef_city: '📍 Город', ef_photos: '📸 Фото',
    enter_new_value: '✏️ Введите новое значение:', prod_updated: '✅ Товар обновлён!',
    active_prods_label: 'Активных', archived_prods_label: 'Архивных',
    tier_free: '🆓 Бесплатный', tier_premium: '⭐ Премиум', tier_enterprise: '🏢 Корпоративный',
    tier_label: 'Тариф',
    dashboard: '📊 Аналитика',
    da_title: '📊 Аналитика товаров', da_contacts: 'Контактов', da_offers: 'Предложений',
    da_deals: 'Сделок', da_conversion: 'Конверсия', da_top_by: 'Топ товаров',
    da_sort_views: '👁 Просмотры', da_sort_contacts: '📞 Контакты',
    da_sort_offers: '📨 Предложения', da_sort_deals: '✅ Сделки', da_sort_conv: '📈 Конверсия',
    da_no_data: '📭 Нет данных.', da_total_label: 'Итого по каталогу',
    // M1 — Offer Board
    ob_title: '📊 Конкурс предложений',
    ob_total: 'Предложений', ob_lowest: '💰 Мин. цена',
    ob_fastest: '⚡ Быстрее всех', ob_best_sup: '🏆 Лучший рейтинг',
    ob_sort_price: '💰 Цена', ob_sort_eta: '⚡ Скорость',
    ob_sort_deals: '🏆 Репутация', ob_sort_new: '🕐 Новые',
    // M2 — Supplier Market
    mkt_title: '📊 Ваша позиция на рынке',
    mkt_your_offer: '💰 Ваше предложение', mkt_your_pos: '🏆 Ваша позиция',
    mkt_lowest: '📉 Мин. цена на рынке', mkt_total: '👥 Всего конкурентов',
    mkt_improve: '✏️ Улучшить предложение', mkt_btn: '📊 Моя позиция',
    mkt_no_offer: 'Вы ещё не подавали предложение.',
    mkt_leading: '🥇 Вы лидируете по цене!',
    mkt_behind: '📈 Вас опережают',
    // M3 — Offer Update
    upd_ask_price: '💰 Новая цена:\n(или /skip чтобы оставить текущую)',
    upd_ask_eta: '📅 Новый срок доставки:\n(или /skip чтобы оставить текущий)',
    upd_done: '✅ Предложение обновлено!',
    upd_notif_store: '🔄 Поставщик обновил своё предложение!',
    // M4 — Pre-accept Confirmation
    pre_accept_msg: '⚠️ Вы выбираете поставщика. Подтвердите:',
    pre_accept_confirm: '✅ Подтвердить',
    pre_accept_cancel: '⬅️ Назад',
    pg_products: '📦 Товары',
    pg_filter: '🔎 Фильтр',
    pg_prev: '⬅️ Назад',
    pg_next: 'Вперёд ➡️',
    pg_page: 'Страница',
    all_cats_lbl: 'Все категории',
  },
  uz: {
    select_lang: '👋 *MIVRA*га хуш келибсиз\n_Savdoni osonlashtiramiz._\n\nВыберите язык / Tilni tanlang:',
    lang_ru: '🇷🇺 Русский', lang_uz: "🇺🇿 O'zbek",
    choose_role: 'Siz kimsiz?',
    role_store: "🏪 Do'kon", role_supplier: '🚛 Yetkazib beruvchi',
    catalog: '🔍 Katalog', create_req: "📝 So'rov",
    my_reqs: "📋 So'rovlarim", favorites: '⭐ Sevimlilar', help: 'ℹ️ Yordam',
    buyer_reqs: "📥 So'rovlar", my_prods: '📦 Mahsulotlarim',
    add_prod: "➕ Qo'shish", profile: '👤 Profil',
    stats: '📊 Statistika', all_reqs: "📋 Barcha so'rovlar",
    sups: '👥 Yetkazib beruvchilar', prods: '🛍 Mahsulotlar',
    cat_empty: "📭 Katalog bo'sh.",
    prev: '◀️', next: '▶️',
    contact: "📞 Bog'lanish", verified: '✅ Tasdiqlangan',
    search: '🔍 Qidirish', filter: '🔽 Filtr',
    search_hint: 'Nom yoki kategoriya kiriting:',
    no_results: '🔍 Topilmadi.',
    filter_by_cat: "📁 Kategoriya bo'yicha", filter_by_city: "📍 Shahar bo'yicha",
    filter_reset: '🔄 Tozalash', filter_active: '🔽 Filtr faol',
    ask_prod: '📦 Mahsulot nomi:', ask_cat: '📁 Kategoriya:',
    ask_spec: "📝 Tavsif (yoki yo'q):", ask_qty: '📊 Miqdor (raqam):', ask_unit: "📏 O'lchov:",
    ask_city: '📍 Shahar:', ask_addr: '🏠 Manzil:', ask_phone: '📞 Telefon:',
    ask_date: "📅 Sana (yoki yo'q):", ask_notes: "📝 Izohlar (yoki yo'q):",
    req_done: "✅ So'rov yaratildi!",
    ask_price: '💰 Birlik narxi:', ask_del: '🚚 Yetkazib berish?',
    ask_neg: '💬 Narx kelishiladi?', ask_eta: '📅 Muddat:', ask_cmt: "📝 Izoh (yoki yo'q):",
    offer_sent: '✅ Taklif yuborildi!',
    offer_accept: '✅ Qabul', offer_reject: '❌ Rad',
    offer_accepted_msg: '✅ Yetkazib beruvchi tanlandi!',
    offer_rejected_msg: '❌ Taklif rad etildi.',
    offer_accepted_notif: '🎉 Taklifingiz qabul qilindi!',
    offer_rejected_notif: '❌ Taklifingiz rad etildi.',
    offer_closed_notif: "❌ So'rov yopildi — boshqa yetkazib beruvchi tanlandi.",
    send_offer_btn: '📨 Taklif yuborish', skip_req_btn: '⏭ Shu emas',
    yes: '✅ Ha', no: "❌ Yo'q",
    boxes: '📦 Qutili', packs: "📫 Bog'lam", units: '🔢 Dona',
    r_sname: "🏪 Do'kon nomi:", r_phone: '📞 Telefon:',
    r_city: '📍 Shahar:', r_company: '🏢 Kompaniya nomi:',
    r_contact: '👤 Aloqa shaxsi:', r_desc: '📝 Biznes tavsifi:',
    r_store_done: "✅ Ro'yxatdan o'tish yakunlandi!", r_sup_pending: '⏳ Ariza yuborildi!',
    p_name: '📦 Nom:', p_cat: '📁 Kategoriya:', p_desc: '📝 Tavsif:',
    p_wv: "⚖️ Og'irlik/Hajm:", p_upb: '📦 Qadoqdagi miqdor:', p_moq: '📊 Min buyurtma:',
    p_price: '💰 Narx:', p_avail: '✅ Mavjudlik:',
    p_photos: '📸 Rasm (5 tagacha). /done', p_added: "✅ Mahsulot qo'shildi!",
    suspended: "⛔ Hisob to'xtatilgan.", pending_sup: "⏳ Ko'rib chiqilmoqda.",
    not_active: "⛔ Hisob faol emas.", expired: '⚠️ Sessiya eskirgan. /start',
    no_reqs: "📭 Faol so'rovlar yo'q.", no_prods: "Mahsulotlar yo'q.",
    only_approved: 'Faqat tasdiqlangan yetkazib beruvchilar uchun.',
    req_closed: "So'rov yopilgan.", already_replied: 'Allaqachon javob berdingiz.',
    views: '👁', limit_reqs: "⚠️ Limit: 5 ta faol so'rov.",
    limit_prods: "⚠️ Faol mahsulotlar limiti to'ldi.",
    dup_req_smart: "⚠️ Bir xil so'rov 15 daqiqa oldin yaratilgan.",
    bad_phone: "⚠️ To'g'ri telefon kiriting.", slow_down: '⚠️ Sekinroq.',
    no_qty_number: '⚠️ Musbat raqam kiriting.',
    offer_pending: '⏳ Kutilmoqda', offer_accepted_lbl: '✅ Qabul', offer_rejected_lbl: '❌ Rad',
    req_status_active: '🟢 Faol', req_status_offer: '💬 Raqobat ketmoqda',
    req_status_accepted: '🤝 Muzokaralar',
    req_status_delivered: '🚚 Yetkazildi',
    req_status_completed: '✅ Yakunlandi', req_status_cancelled: '❌ Bekor',
    mark_delivered_btn: "🚚 Yetkazildi deb belgilash",
    confirm_delivery_btn: "✅ Qabul qilishni tasdiqlash",
    delivered_notif_store: "🚚 Yetkazildi! Tasdiqlang:",
    delivered_notif_sup: "📦 Do'kon tasdiqlashini kutilmoqda.",
    completed_notif_store: "✅ Tasdiqlandi. Bitim yakunlandi!",
    completed_notif_sup: "🎉 Do'kon tasdiqladi! Bitim yakunlandi.",
    active_deals: '🤝 Faol bitimlar', waiting_confirm: '⏳ Tasdiqlanishini kutilmoqda',
    offers_summary_btn: '💬 Natijalar',
    view_more_photos: "📸 Ko'proq rasm",
    delivery_yes: 'Yetkazib berish', delivery_no: 'Olib ketish',
    delivery_scope_title: '🚚 Zona:',
    delivery_scope_uzbekistan: "🌍 Butun O'zbekiston",
    delivery_scope_regional: '📍 Faqat mintaqa',
    p_scope: '🚚 Yetkazib berish zonasini tanlang:',
    ef_scope: '🚚 Yetkazib berish zonasi',
    pg_products: '📦 Mahsulotlar', pg_filter: '🔎 Filtr',
    pg_prev: '⬅️ Oldingi', pg_next: 'Keyingi ➡️',
    pg_page: 'Sahifa', pg_del: "❌ O'chirish",
    broadcast_btn: '📢 Xabar yuborish',
    broadcast_target: '📢 Kimga yuborish?',
    broadcast_target_all: '👥 Hammaga',
    broadcast_target_stores: "🏪 Faqat do'konlarga",
    broadcast_target_sups: '🚛 Faqat yetkazib beruvchilarga',
    broadcast_ask_msg: '✏️ Xabar matnini kiriting:',
    broadcast_ask_photo: '📸 Rasm biriktiring yoki /skip:',
    broadcast_sent: '✅ Xabar yuborildi:',
    broadcast_limited: '⚠️ Soatiga 3 ta xabar limiti.',
    price_neg_label: 'Kelishilgan', price_fixed_label: 'Belgilangan',
    add_to_fav: '⭐ Sevimlilarga', remove_from_fav: "💛 O'chirish",
    fav_added: "⭐ Qo'shildi!", fav_removed: "💔 O'chirildi.",
    fav_empty: "⭐ Sevimlilar bo'sh.",
    my_deals_label: "🛒 Yakunlangan xaridlar",
    completed_deals_lbl: '✅ Yakunlangan bitimlar',
    products_listed_lbl: '📦 Katalogdagi mahsulotlar',
    member_since_lbl: "📅 A'zo bo'lgan",
    new_req_title: "🔔 Yangi so'rov!",
    offers_none: "📭 Takliflar yo'q.",
    cats_select: '📁 Kategoriyalarni tanlang:',
    cats_confirm: '✅ Tayyor', cat_custom: '✏️ Boshqa',
    cat_custom_hint: "✏️ Kategoriyalarni vergul bilan yozing:",
    cats_updated: "✅ Kategoriyalar yangilandi!", edit_cats_btn: '📁 Kategoriyalarni tahrirlash',
    no_cats_selected: "⚠️ Kamida bitta kategoriya tanlang.",
    edit_prod_btn: '✏️ Tahrirlash', archive_btn: "🗄 Arxivlash",
    restore_btn: "📤 Tiklash", archived_label: '🗄 Arxivlangan',
    my_archived_btn: '🗄 Arxiv', prod_archived: "🗄 Mahsulot arxivlandi.",
    prod_restored: "✅ Mahsulot tiklandi!", edit_choose_field: "✏️ Nimani o'zgartirish?",
    ef_name: '📦 Nom', ef_cat: '📁 Kategoriya', ef_desc: '📝 Tavsif',
    ef_price: '💰 Narx', ef_moq: '📊 Min buyurtma', ef_avail: '✅ Mavjudlik',
    ef_city: '📍 Shahar', ef_photos: '📸 Rasm',
    enter_new_value: '✏️ Yangi qiymat kiriting:', prod_updated: "✅ Mahsulot yangilandi!",
    active_prods_label: 'Faol', archived_prods_label: 'Arxivlangan',
    tier_free: '🆓 Bepul', tier_premium: '⭐ Premium', tier_enterprise: '🏢 Korporativ',
    tier_label: "Tarif",
    dashboard: '📊 Tahlil',
    da_title: '📊 Mahsulotlar tahlili', da_contacts: "Bog'lanishlar", da_offers: 'Takliflar',
    da_deals: 'Bitimlar', da_conversion: 'Konversiya', da_top_by: 'Top mahsulotlar',
    da_sort_views: "👁 Ko'rishlar", da_sort_contacts: "📞 Bog'lanishlar",
    da_sort_offers: '📨 Takliflar', da_sort_deals: '✅ Bitimlar', da_sort_conv: '📈 Konversiya',
    da_no_data: "📭 Ma'lumot yo'q.", da_total_label: 'Katalog jami',
    // M1
    ob_title: '📊 Takliflar raqobati',
    ob_total: 'Takliflar', ob_lowest: '💰 Min. narx',
    ob_fastest: '⚡ Tezroq', ob_best_sup: '🏆 Eng yaxshi',
    ob_sort_price: '💰 Narx', ob_sort_eta: '⚡ Tezlik',
    ob_sort_deals: '🏆 Obro\'', ob_sort_new: '🕐 Yangi',
    // M2
    mkt_title: "📊 Bozordagi o'rningiz",
    mkt_your_offer: '💰 Taklifingiz', mkt_your_pos: "🏆 O'rningiz",
    mkt_lowest: '📉 Min. bozor narxi', mkt_total: '👥 Raqobatchilar',
    mkt_improve: '✏️ Taklifni yaxshilash', mkt_btn: "📊 Mening o'rnim",
    mkt_no_offer: 'Siz hali taklif bermagansiz.',
    mkt_leading: "🥇 Siz narx bo'yicha yetakchisiz!",
    mkt_behind: '📈 Sizi quvib ketishyapti',
    // M3
    upd_ask_price: '💰 Yangi narx:\n(/skip — hozirgi narxni saqlash)',
    upd_ask_eta: '📅 Yangi muddat:\n(/skip — hozirgi muddatni saqlash)',
    upd_done: '✅ Taklif yangilandi!',
    upd_notif_store: "🔄 Yetkazib beruvchi taklifini yangiladi!",
    // M4
    pre_accept_msg: "⚠️ Yetkazib beruvchini tasdiqlang:",
    pre_accept_confirm: '✅ Tasdiqlash',
    pre_accept_cancel: '⬅️ Orqaga',
  },
} as const;

type TKey = keyof typeof TR.ru;
const t = (k: TKey, l: Lang = 'ru'): string => ((TR[l] as Record<string, string>)[k]) ?? TR.ru[k] ?? k;
const isCmd = (txt: string, k: TKey): boolean => txt === TR.ru[k] || txt === TR.uz[k];
const getLang = (u?: User): Lang => (u as any)?.lang ?? 'ru';
const skip = (txt: string): boolean => ['нет', "yo'q", 'yoq', 'no', '/skip'].includes(txt.toLowerCase().trim());
const truncS = (s: string, max: number) => s.length > max ? s.slice(0, max) + '…' : s;
const truncC = (s: string, max = 1000) => s.length > max ? s.slice(0, max - 1) + '…' : s;
/** Sanitize user input to a reasonable max length before storing */
const sanitize = (s: string, max = 500): string => s.trim().slice(0, max);

// ─── PRESETS & TIERS ─────────────────────────────────────────────────────────

const PRESET_CATS = ['Напитки', 'Продукты питания', 'Детские товары', 'Бытовая химия', 'Косметика', 'Электроника', 'Канцелярия', 'Стройматериалы', 'Одежда', 'Прочее'];
const TIER_LIMITS: Record<SupplierTier, number> = { free: 20, premium: 100, enterprise: Infinity };

// ─── LIMITS & RATE ────────────────────────────────────────────────────────────

const MAX_ACTIVE_REQS = 5;

// SpamGuard instance — initialised in initRepos() after the DB is ready
let spam: SpamGuard;

/** Drop-in replacement for the old COOLDOWNS map — delegates to SpamGuard */
const rateLimit = (uid: number, ms = 1500): boolean => spam.rateLimit(uid, ms);

// ─── VALIDATION ───────────────────────────────────────────────────────────────

const isValidPhone = (p: string) => /^\+?\d[\d\s\-()]{8,18}$/.test(p.trim());
const fmtD = (v: string) => { const d = new Date(v); return isNaN(d.getTime()) ? v : d.toLocaleDateString('ru-RU'); };
const md = (v: unknown) => String(v ?? '').replace(/([_*`[\]()])/g, '\\$1');
const genId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// Database-backed duplicate check.
const isDuplicateReq = (storeId: number, product: string, quantity: string, city: string): boolean => {
  return repos.requests.isDuplicate(storeId, product, quantity, city);
};

// ─── M1+M3: OFFER SORT HELPERS ───────────────────────────────────────────────

const parsePrice = (s: string): number => {
  const n = parseFloat(s.replace(/[^\d.,]/g, '').replace(',', '.'));
  return isNaN(n) ? Infinity : n;
};
const parseEta = (s: string): number => {
  if (/завтра|bugun|tomorrow|today/i.test(s)) return 1;
  const m = s.match(/\d+/); return m ? parseInt(m[0]) : 999;
};

function sortOffers(offers: Offer[], by: string): Offer[] {
  const deals = (sid: number) => repos.deals.countBySupplierId(sid);
  return [...offers].sort((a, b) => {
    if (by === 'price') return parsePrice(a.price) - parsePrice(b.price);
    if (by === 'eta') return parseEta(a.estimatedDelivery) - parseEta(b.estimatedDelivery);
    if (by === 'deals') return deals(b.supplierId) - deals(a.supplierId);
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(); // newest
  });
}

// M1: Build the complete competitive offer board as one message
function buildOfferBoard(req: Request, lang: Lang, sortBy: string): { text: string; kb: ReturnType<typeof Markup.inlineKeyboard> } {
  const pending = req.offers.filter(o => o.status !== 'rejected');
  if (!pending.length) return { text: t('offers_none', lang), kb: Markup.inlineKeyboard([]) };

  const sorted = sortOffers(pending, sortBy);
  const byPrice = sortOffers(pending, 'price');
  const byEta = sortOffers(pending, 'eta');
  const byDeals = sortOffers(pending, 'deals');

  const lowestPrice = byPrice[0]?.price ?? '—';
  const fastestEta = byEta[0]?.estimatedDelivery ?? '—';
  const bestSup = byDeals[0];
  const bestDealsN = bestSup ? repos.deals.countBySupplierId(bestSup.supplierId) : 0;

  const sortLbls: Record<string, TKey> = { price: 'ob_sort_price', eta: 'ob_sort_eta', deals: 'ob_sort_deals', newest: 'ob_sort_new' };
  const activeLbl = t(sortLbls[sortBy] ?? 'ob_sort_price', lang);

  let text =
    `📊 *${t('ob_title', lang)}*\n` +
    `📦 *${md(req.product)}* | ${req.quantity} ${req.unitType}\n\n` +
    `${t('ob_total', lang)}: *${pending.length}* | ${t('ob_lowest', lang)}: *${md(lowestPrice)}*\n` +
    `${t('ob_fastest', lang)}: *${md(fastestEta)}* | ${t('ob_best_sup', lang)}: *${md(truncS(bestSup?.supplierName ?? '—', 20))}* (${bestDealsN})\n` +
    `\n━━━ ${activeLbl} ━━━`;

  for (let i = 0; i < Math.min(sorted.length, 5); i++) {
    const o = sorted[i];
    const isVer = (repos.users.findById(o.supplierId) as SupplierUser)?.approved;
    const supDeals = repos.deals.countBySupplierId(o.supplierId);
    const isAcc = req.acceptedOfferId === o.id;
    text += `\n\n*#${i + 1}* 🏢 ${md(truncS(o.supplierName, 22))}${isVer ? ' ✅' : ''} • 🏆 ${supDeals}\n`;
    text += `   💰 ${md(o.price)} | ⚡ ${md(o.estimatedDelivery)} | ${o.deliveryAvailable ? '🚚' : '🏭'} | ${o.priceNegotiable ? t('price_neg_label', lang) : t('price_fixed_label', lang)}`;
    if (o.comment) text += `\n   📝 ${md(truncS(o.comment, 45))}`;
    if (isAcc) text += `\n   ${t('offer_accepted_lbl', lang)}`;
  }

  const sBtn = (tk: TKey, sort: string) =>
    Markup.button.callback((sort === sortBy ? '● ' : '') + t(tk, lang), `ob_sort_${sort}_${req.id}`);

  const canAcc = canModReq(req.status);
  const accRow = canAcc ? sorted.slice(0, Math.min(sorted.length, 3)).map((o, i) =>
    Markup.button.callback(`✅ #${i + 1}`, `pre_accept_${o.id}_${req.id}`)
  ) : [];

  const kb = Markup.inlineKeyboard([
    [sBtn('ob_sort_price', 'price'), sBtn('ob_sort_eta', 'eta'), sBtn('ob_sort_deals', 'deals'), sBtn('ob_sort_new', 'newest')],
    ...(accRow.length ? [accRow] : []),
  ]);

  return { text: truncC(text, 3500), kb };
}

// M2: Build anonymous market position for supplier
function buildMarketStats(req: Request, supplierId: number, lang: Lang): string {
  const pending = req.offers.filter(o => o.status === 'pending');
  const myOffer = pending.find(o => o.supplierId === supplierId);
  if (!myOffer) return t('mkt_no_offer', lang);

  const byPrice = sortOffers(pending, 'price');
  const myRank = byPrice.findIndex(o => o.supplierId === supplierId) + 1;
  const lowest = byPrice[0];

  let text = `${t('mkt_title', lang)}\n📦 *${md(req.product)}*\n\n`;
  text += `${t('mkt_your_offer', lang)}: *${md(myOffer.price)}*\n`;
  text += `${t('mkt_your_pos', lang)}: *#${myRank} из ${pending.length}*\n`;
  text += `${t('mkt_lowest', lang)}: *${md(lowest?.price ?? '—')}*\n`;
  text += `${t('mkt_total', lang)}: *${pending.length}*\n\n`;
  if (myRank === 1) text += t('mkt_leading', lang);
  else text += `${t('mkt_behind', lang)}: ${myRank - 1}`;
  return text;
}

// ─── ADDITIONAL TYPES ─────────────────────────────────────────────────────────

interface CatFilter { q?: string; city?: string; category?: string; }
interface StatusHistoryEntry { status: ReqStatus; at: string; }
interface Session extends SessionData {}

// ─── REPOSITORY INITIALIZATION ────────────────────────────────────────────────

let repos: Repos;

function initRepos() {
  const db = getDb();
  runMigration(db);
  repos = createRepos(db);
  spam = new SpamGuard(db);
  spam.startCleanupTimer();
  repos.sessions.cleanup();
  // Monetization expiry + nonce cleanup: run on startup, then every hour
  expireMonetization();
  setInterval(() => {
    expireMonetization();
    repos.nonces.cleanup();
  }, 60 * 60 * 1000);
}

/**
 * Expiration Automation
 * Direct SQL UPDATE — avoids loading every user/product into memory.
 * Runs at startup and every hour. Fully idempotent.
 */
function expireMonetization(): void {
  const now = new Date().toISOString();
  try {
    const proResult = repos.db.prepare(
      `UPDATE users SET is_pro = 0, pro_until = NULL WHERE is_pro = 1 AND pro_until IS NOT NULL AND pro_until <= ?`
    ).run(now);
    if (proResult.changes > 0) {
      logger.info('EXPIRY', `Expired ${proResult.changes} PRO subscription(s)`);
    }
    const featuredResult = repos.db.prepare(
      `UPDATE products SET is_featured = 0, featured_until = NULL WHERE is_featured = 1 AND featured_until IS NOT NULL AND featured_until <= ?`
    ).run(now);
    if (featuredResult.changes > 0) {
      logger.info('EXPIRY', `Expired ${featuredResult.changes} Featured product(s)`);
    }
  } catch (e: any) {
    logger.error('EXPIRY', 'expireMonetization error', { error: e.message });
  }
}

// ─── BOT INIT ─────────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env.BOT_TOKEN!;
const ADMIN_ID = Number(process.env.ADMIN_ID!);
if (!BOT_TOKEN || !Number.isFinite(ADMIN_ID)) throw new Error('Missing BOT_TOKEN or ADMIN_ID');

const bot = new Telegraf(BOT_TOKEN);

// ─── SESSION MANAGEMENT (SQLite-backed, survives restarts) ──────────────────
const sessionCache: Record<number, Session> = {};
const getS = (id: number): Session => {
  if (!sessionCache[id]) {
    // Load from SQLite on first access
    const stored = repos.sessions.get(id);
    sessionCache[id] = { step: stored.step, tempData: stored.tempData, catalog: stored.catalog };
  }
  return sessionCache[id];
};
const persistS = (id: number): void => {
  const s = sessionCache[id];
  if (s) repos.sessions.set(id, { step: s.step, tempData: s.tempData, catalog: s.catalog });
};
const clearS = (id: number) => {
  sessionCache[id] = {};
  repos.sessions.clear(id);
};

// In-memory contact click dedup (1h per user per product)
const CONTACT_TRACKER = new Map<string, number>();

const isAdmin = (id?: number) => id === ADMIN_ID;
const isSt = (u?: User): u is StoreUser => u?.role === 'store';
const isSup = (u?: User): u is SupplierUser => u?.role === 'supplier';
const isAct = (u?: User): u is SupplierUser => isSup(u) && u.approved && !u.suspended;
const canModReq = (st: ReqStatus) => st === 'active' || st === 'offer_received';
const getActiveProds = (sid: number) => repos.products.countActiveForSupplier(sid);
const getProductLimit = (sup: SupplierUser) => TIER_LIMITS[sup.tier ?? 'free'];

// ─── KEYBOARDS ────────────────────────────────────────────────────────────────

const storeKb = (l: Lang) => Markup.keyboard([[t('catalog', l), t('create_req', l)], [t('my_reqs', l), t('favorites', l)], [t('help', l)]]).resize();
const supKb = (l: Lang) => Markup.keyboard([[t('buyer_reqs', l), t('my_prods', l)], [t('add_prod', l), t('dashboard', l)], [t('profile', l), t('help', l)]]).resize();
const adminKb = Markup.keyboard([[TR.ru.stats, TR.ru.all_reqs], [TR.ru.sups, TR.ru.prods], [TR.ru.broadcast_btn]]).resize();
const ynKb = (y: string, n: string, l: Lang) => Markup.inlineKeyboard([[Markup.button.callback(t('yes', l), y), Markup.button.callback(t('no', l), n)]]);
const unitKb = (l: Lang) => Markup.inlineKeyboard([[Markup.button.callback(t('boxes', l), 'unit_boxes'), Markup.button.callback(t('packs', l), 'unit_packs'), Markup.button.callback(t('units', l), 'unit_units')]]);

function buildCatKb(selected: string[], lang: Lang, doneAction: string) {
  const rows = PRESET_CATS.map((c, i) => [Markup.button.callback(`${selected.includes(c) ? '✅' : '○'} ${c}`, `cat_sel_${i}`)]);
  rows.push([Markup.button.callback(t('cat_custom', lang), 'cat_custom')]);
  if (selected.length > 0) rows.push([Markup.button.callback(`${t('cats_confirm', lang)} (${selected.length})`, doneAction)]);
  return Markup.inlineKeyboard(rows);
}

/**
 * Single-select category keyboard for product creation, request creation, and
 * product category edits.  prefix controls the callback action name so one
 * handler can serve all three contexts: 'prod_pcat', 'req_pcat', 'edit_pcat'.
 */
function buildProdCatKb(lang: Lang, prefix = 'prod_pcat') {
  return Markup.inlineKeyboard(PRESET_CATS.map((c, i) => [Markup.button.callback(`📁 ${c}`, `${prefix}_${i}`)]));
}

function buildEditMenu(prodId: string, lang: Lang) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(t('ef_name', lang), `ep_name_${prodId}`), Markup.button.callback(t('ef_cat', lang), `ep_cat_${prodId}`)],
    [Markup.button.callback(t('ef_desc', lang), `ep_desc_${prodId}`), Markup.button.callback(t('ef_price', lang), `ep_price_${prodId}`)],
    [Markup.button.callback(t('ef_moq', lang), `ep_moq_${prodId}`), Markup.button.callback(t('ef_avail', lang), `ep_avail_${prodId}`)],
    [Markup.button.callback(t('ef_city', lang), `ep_city_${prodId}`), Markup.button.callback(t('ef_scope', lang), `ep_scope_${prodId}`)],
    [Markup.button.callback(t('ef_photos', lang), `ep_photos_${prodId}`)],
    [Markup.button.callback(t('archive_btn', lang), `archive_prod_${prodId}`)],
  ]);
}

// ─── CATALOG HELPERS ──────────────────────────────────────────────────────────

/** Delegates to mivra_search.ts — uses indexed SQL queries, not in-memory scan */
function getCatalogMeta() {
  return dbGetCatalogMeta(repos.db);
}

/**
 * Replaces the old in-memory .filter() chain.
 * Uses FTS5 + weighted scoring from mivra_search.ts when a query is present.
 */
function filterProducts(f?: CatFilter): Product[] {
  return smartSearch(repos.db, { q: f?.q, city: f?.city, category: f?.category }, 0, 50) as Product[];
}
function reqStatusLabel(st: ReqStatus, lang: Lang): string {
  const map: Record<ReqStatus, TKey> = { active: 'req_status_active', offer_received: 'req_status_offer', accepted: 'req_status_accepted', delivered: 'req_status_delivered', completed: 'req_status_completed', cancelled: 'req_status_cancelled' };
  return t(map[st] ?? 'req_status_active', lang);
}

function pushEvent(type: AnalyticsEventType, productId: string, supplierId: number, userId: number) {
  repos.analytics.push({ type, productId, supplierId, userId, at: new Date().toISOString() });
}

function convRate(p: Product): string { return p.viewCount ? ((p.completedDeals / p.viewCount) * 100).toFixed(2) : '0.00'; }
function sortProds(prods: Product[], by: string): Product[] {
  return [...prods].sort((a, b) => {
    if (by === 'contacts') return (b.contactClicks || 0) - (a.contactClicks || 0);
    if (by === 'offers') return (b.offerResponses || 0) - (a.offerResponses || 0);
    if (by === 'deals') return (b.completedDeals || 0) - (a.completedDeals || 0);
    if (by === 'conv') return (b.viewCount ? b.completedDeals / b.viewCount : 0) - (a.viewCount ? a.completedDeals / a.viewCount : 0);
    return (b.viewCount || 0) - (a.viewCount || 0);
  });
}
function buildDashText(prods: Product[], sup: SupplierUser, lang: Lang, sortBy: string): string {
  const tV = prods.reduce((n, p) => n + (p.viewCount || 0), 0);
  const tC = prods.reduce((n, p) => n + (p.contactClicks || 0), 0);
  const tO = prods.reduce((n, p) => n + (p.offerResponses || 0), 0);
  const tD = prods.reduce((n, p) => n + (p.completedDeals || 0), 0);
  const sLabel = t(`da_sort_${sortBy}` as TKey, lang);
  const lines = [`📊 *${t('da_title', lang)}*`, `🏢 ${md(sup.companyName)}`, '', `*${t('da_total_label', lang)}:*`, `${t('views', lang)}: ${tV} | 📞 ${t('da_contacts', lang)}: ${tC}`, `📨 ${t('da_offers', lang)}: ${tO} | ✅ ${t('da_deals', lang)}: ${tD}`, `📈 ${t('da_conversion', lang)}: ${tV ? ((tD / tV) * 100).toFixed(2) : 0}%`, '', `━━━━━━━━━━`, `🏆 ${t('da_top_by', lang)} — ${sLabel}:`, ''];
  const top = prods.slice(0, 5);
  if (!top.length) lines.push(t('da_no_data', lang));
  else top.forEach((p, i) => { lines.push(`${i + 1}. *${md(truncS(p.name, 45))}*`); lines.push(`   👁 ${p.viewCount} | 📞 ${p.contactClicks || 0} | 📨 ${p.offerResponses || 0} | ✅ ${p.completedDeals || 0} | % ${convRate(p)}`); });
  return lines.join('\n');
}
function buildDashKb(lang: Lang, active: string): any {
  const b = (tk: TKey, key: string) => Markup.button.callback((key === active ? '● ' : '') + t(tk, lang), `da_sort_${key}`);
  return Markup.inlineKeyboard([[b('da_sort_views', 'views'), b('da_sort_contacts', 'contacts')], [b('da_sort_offers', 'offers'), b('da_sort_deals', 'deals')], [b('da_sort_conv', 'conv')]]);
}

async function sendProductCard(ctx: any, prod: Product, page: number, total: number, lang: Lang, filter?: CatFilter, viewerUid?: number) {
  // Dedup view counting via SpamGuard (24h per user per product)
  if (viewerUid) {
    if (spam.trackView(viewerUid, prod.id)) { repos.products.incrementView(prod.id); pushEvent('view', prod.id, prod.supplierId, viewerUid); }
  } else { repos.products.incrementView(prod.id); pushEvent('view', prod.id, prod.supplierId, 0); }

  const sup = repos.users.findById(prod.supplierId) as SupplierUser | undefined;
  const filterTag = filter?.category ? `📁 ${md(filter.category)}` : filter?.city ? `📍 ${md(filter.city)}` : filter?.q ? `🔍 "${md(filter.q)}"` : '';
  const scopeLabel = (prod.deliveryScope === 'all_uzbekistan' || prod.deliveryScope === 'uzbekistan') ? t('delivery_scope_uzbekistan', lang) : t('delivery_scope_regional', lang);
  const card = truncC(
    `📦 *${md(truncS(prod.name, 80))}*\n` +
    `🏷 ${md(truncS(prod.category, 50))}\n` +
    `📝 ${md(truncS(prod.description, 180))}\n\n` +
    `💰 *${md(prod.price)}*${prod.priceNegotiable ? ` _(${t('price_neg_label', lang)})_` : ''}\n` +
    `⚖️ ${md(prod.weightVolume)} | 📦 ${md(prod.unitsPerBox)}\n` +
    `📊 Мин: ${md(prod.minOrderQty)}\n` +
    `${t('delivery_scope_title', lang)} ${scopeLabel} | ${prod.deliveryAvailable ? t('delivery_yes', lang) : t('delivery_no', lang)}\n` +
    `✅ ${md(prod.availabilityStatus)} | 📍 ${md(prod.city)}\n\n` +
    `🏢 *${md(prod.supplierName)}*${sup?.approved ? ' ' + t('verified', lang) : ''}\n` +
    `📞 ${md(prod.supplierPhone)}\n` +
    `💬 ${prod.supplierUsername ? md('@' + prod.supplierUsername) : '—'}\n\n` +
    `${page + 1}/${total}${filterTag ? '  ' + filterTag : ''}  ${t('views', lang)}: ${prod.viewCount}`
  );

  const nav = [...(page > 0 ? [Markup.button.callback(t('prev', lang), 'cat_prev')] : []), (page < total - 1 ? [Markup.button.callback(t('next', lang), 'cat_next')] : [])[0]].filter(Boolean);
  const stU = viewerUid ? repos.users.findById(viewerUid) as StoreUser | undefined : undefined;
  const isFav = isSt(stU) && (stU.favorites ?? []).includes(prod.id);
  const kbRows: any[][] = [
    ...(nav.length ? [nav] : []),
    [Markup.button.callback(t('contact', lang), `cat_cnt_${prod.id}`), Markup.button.callback(t('filter', lang), 'cat_filter')],
    ...(isSt(stU) ? [[Markup.button.callback(isFav ? t('remove_from_fav', lang) : t('add_to_fav', lang), isFav ? `fav_rem_${prod.id}` : `fav_add_${prod.id}`)]] : []),
    [Markup.button.callback(t('search', lang), 'cat_search')],
  ];
  const kb = Markup.inlineKeyboard(kbRows);
  const photos = (prod.photos ?? []).filter(Boolean);

  if (photos.length > 1) {
    // Send ALL photos as Telegram media group (caption on first only).
    // Media groups don't support reply_markup, so the nav keyboard arrives
    // in a second plain-text message immediately after.
    await ctx.replyWithMediaGroup(photos.slice(0, 5).map((ph, i) => ({
      type: 'photo' as const,
      media: ph,
      ...(i === 0 ? { caption: card, parse_mode: 'Markdown' as const } : {}),
    })));
    await ctx.reply(`${page + 1}/${total}${filterTag ? '  ' + filterTag : ''}`, kb);
  } else if (photos.length === 1) {
    await ctx.replyWithPhoto(photos[0], { caption: card, parse_mode: 'Markdown', ...kb });
  } else {
    await ctx.reply(card, { parse_mode: 'Markdown', ...kb });
  }
}

async function sendProductCardCompact(ctx: any, p: Product, lang: Lang, extraRows: any[][] = [], showAnalytics = false) {
  const photos = (p.photos ?? []).filter(Boolean);
  const al = showAnalytics ? `\n👁 ${p.viewCount} | 📞 ${p.contactClicks || 0} | 📨 ${p.offerResponses || 0} | ✅ ${p.completedDeals || 0}` : '';
  const cap = truncC(`📦 *${md(truncS(p.name, 80))}* | 💰 ${md(p.price)}\n🏷 ${md(truncS(p.category, 50))} | 📍 ${md(p.city)}\n✅ ${md(truncS(p.availabilityStatus, 50))}${p.archived ? `  ${t('archived_label', lang)}` : ''}${al}\n${t('views', lang)}: ${p.viewCount} | 📅 ${fmtD(p.createdAt)}`);
  const kbRows: any[][] = [...(p.photos.length > 1 ? [[Markup.button.callback(t('view_more_photos', lang), `more_photos_${p.id}`)]] : []), ...extraRows];
  const kb = kbRows.length > 0 ? Markup.inlineKeyboard(kbRows) : {};
  if (photos.length >= 1) await ctx.replyWithPhoto(photos[0], { caption: cap, parse_mode: 'Markdown', ...kb });
  else await ctx.reply(cap, { parse_mode: 'Markdown', ...kb });
}

async function openCatalog(ctx: any, uid: number, lang: Lang, filter?: CatFilter) {
  const list = filterProducts(filter);
  if (!list.length) { await ctx.reply(filter?.q || filter?.city || filter?.category ? t('no_results', lang) : t('cat_empty', lang)); return; }
  const s = getS(uid);
  s.tempData = { ...(s.tempData ?? {}), catPage: 0, catIds: list.map(p => p.id), catFilter: filter ?? {} };
  await sendProductCard(ctx, list[0], 0, list.length, lang, filter, uid);
}

async function registerSupplier(ctx: any, uid: number, d: Record<string, any>, categories: string[]) {
  const { lang: l, companyName, contactPerson, phone, city, businessDescription } = d;
  const u: SupplierUser = { id: uid, firstName: ctx.from.first_name ?? '', username: ctx.from.username, role: 'supplier', lang: l, companyName, contactPerson, phone, city, businessDescription, approved: false, suspended: false, registeredAt: new Date().toISOString(), categories, tier: 'free' };
  repos.users.save(u); clearS(uid);
  await ctx.reply(t('r_sup_pending', l));
  const catLine = categories.length > 0 ? `\n📁 ${categories.join(', ')}` : '';
  await bot.telegram.sendMessage(ADMIN_ID, `🆕 Новый поставщик:\n\n🏢 ${u.companyName}\n👤 ${u.contactPerson}\n📞 ${u.phone}\n📍 ${u.city}\n📝 ${u.businessDescription}${catLine}`, { ...Markup.inlineKeyboard([[Markup.button.callback('✅ Принять', `sup_accept_${uid}`), Markup.button.callback('❌ Отклонить', `sup_reject_${uid}`)]]) }).catch(() => { });
}

// ─── /start ───────────────────────────────────────────────────────────────────

bot.start(async ctx => {
  const uid = ctx.from.id;
  if (isAdmin(uid)) { await ctx.reply('👋 MIVRA Admin Panel', adminKb); return; }
  const u = repos.users.findById(uid);
  if (isSt(u)) { await ctx.reply(`С возвращением, *${md(u.storeName)}*!`, { parse_mode: 'Markdown', ...storeKb(u.lang) }); return; }
  if (isSup(u)) {
    if (u.suspended) { await ctx.reply(t('suspended', u.lang)); return; }
    if (!u.approved) { await ctx.reply(t('pending_sup', u.lang)); return; }
    await ctx.reply(`С возвращением, *${md(u.companyName)}*!`, { parse_mode: 'Markdown', ...supKb(u.lang) }); return;
  }
  clearS(uid);
  await ctx.reply(TR.ru.select_lang, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback(TR.ru.lang_ru, 'lang_ru'), Markup.button.callback(TR.ru.lang_uz, 'lang_uz')]]) });
});

// ─── LANG / ROLE ──────────────────────────────────────────────────────────────

async function showRoleSelect(ctx: any, uid: number, lang: Lang) {
  getS(uid).tempData = { lang };
  await ctx.editMessageText(t('choose_role', lang), { ...Markup.inlineKeyboard([[Markup.button.callback(t('role_store', lang), 'role_store'), Markup.button.callback(t('role_supplier', lang), 'role_supplier')]]) });
}
bot.action('lang_ru', async ctx => { await showRoleSelect(ctx, ctx.from!.id, 'ru'); });
bot.action('lang_uz', async ctx => { await showRoleSelect(ctx, ctx.from!.id, 'uz'); });
bot.action('role_store', async ctx => {
  const s = getS(ctx.from!.id); const l: Lang = s.tempData?.lang ?? 'ru';
  s.step = 'r_sname'; s.tempData = { lang: l }; await ctx.editMessageText(t('r_sname', l));
});
bot.action('role_supplier', async ctx => {
  const s = getS(ctx.from!.id); const l: Lang = s.tempData?.lang ?? 'ru';
  s.step = 'r_company'; s.tempData = { lang: l }; await ctx.editMessageText(t('r_company', l));
});

// ─── INLINE Y/N / UNIT ────────────────────────────────────────────────────────

bot.action(['unit_boxes', 'unit_packs', 'unit_units'], async ctx => {
  const s = getS(ctx.from!.id); if (s.step !== 'req_unit' || !s.tempData) { await ctx.answerCbQuery(); return; }
  const map: Record<string, string> = { unit_boxes: 'Коробки', unit_packs: 'Пачки', unit_units: 'Штуки' };
  s.tempData.unitType = map[ctx.match[0]]; s.step = 'req_city'; await ctx.editMessageText(t('ask_city', s.tempData.lang));
});
bot.action(['offer_del_yes', 'offer_del_no'], async ctx => {
  const s = getS(ctx.from!.id); if (s.step !== 'offer_del' || !s.tempData) { await ctx.answerCbQuery(); return; }
  const l: Lang = s.tempData.lang; s.tempData.deliveryAvailable = ctx.match[0] === 'offer_del_yes'; s.step = 'offer_neg';
  await ctx.editMessageText(t('ask_neg', l), ynKb('offer_neg_yes', 'offer_neg_no', l));
});
bot.action(['offer_neg_yes', 'offer_neg_no'], async ctx => {
  const s = getS(ctx.from!.id); if (s.step !== 'offer_neg' || !s.tempData) { await ctx.answerCbQuery(); return; }
  const l: Lang = s.tempData.lang; s.tempData.priceNegotiable = ctx.match[0] === 'offer_neg_yes'; s.step = 'offer_eta';
  await ctx.editMessageText(t('ask_eta', l));
});
bot.action(['prod_neg_yes', 'prod_neg_no'], async ctx => {
  const s = getS(ctx.from!.id);
  if (!isAct(repos.users.findById(ctx.from!.id)) || s.step !== 'prod_neg' || !s.tempData) { await ctx.answerCbQuery(); return; }
  const l: Lang = s.tempData.lang; s.tempData.priceNegotiable = ctx.match[0] === 'prod_neg_yes'; s.step = 'prod_del';
  await ctx.editMessageText(t('ask_del', l), ynKb('prod_del_yes', 'prod_del_no', l));
});
bot.action(['prod_del_yes', 'prod_del_no'], async ctx => {
  const s = getS(ctx.from!.id);
  if (!isAct(repos.users.findById(ctx.from!.id)) || s.step !== 'prod_del' || !s.tempData) { await ctx.answerCbQuery(); return; }
  const l: Lang = s.tempData.lang; s.tempData.deliveryAvailable = ctx.match[0] === 'prod_del_yes'; s.step = 'prod_city';
  await ctx.editMessageText(t('ask_city', l));
});

// ─── CATEGORIES ───────────────────────────────────────────────────────────────

bot.action(/^cat_sel_(\d+)$/, async ctx => {
  const s = getS(ctx.from!.id); if (!s.tempData) { await ctx.answerCbQuery(); return; }
  const lang = getLang(repos.users.findById(ctx.from!.id));
  const idx = Number(ctx.match[1]); const cat = PRESET_CATS[idx]; if (!cat) { await ctx.answerCbQuery(); return; }
  const sel: string[] = s.tempData.selectedCats ?? [];
  const pos = sel.indexOf(cat); if (pos >= 0) sel.splice(pos, 1); else sel.push(cat);
  s.tempData.selectedCats = sel;
  const isReg = s.step === 'r_cats';
  try { await ctx.editMessageReplyMarkup(buildCatKb(sel, lang, isReg ? 'cats_reg_done' : 'cats_edit_done').reply_markup as any); } catch { }
  await ctx.answerCbQuery(cat);
});
bot.action('cat_custom', async ctx => {
  const s = getS(ctx.from!.id); const isReg = s.step === 'r_cats'; s.step = isReg ? 'r_cats_custom' : 'edit_cats_custom';
  const lang = getLang(repos.users.findById(ctx.from!.id)); await ctx.answerCbQuery(); await ctx.reply(t('cat_custom_hint', lang));
});
bot.action('cats_reg_done', async ctx => {
  const uid = ctx.from!.id; const s = getS(uid); if (s.step !== 'r_cats' || !s.tempData) { await ctx.answerCbQuery(); return; }
  const selected: string[] = s.tempData.selectedCats ?? []; const lang = s.tempData.lang as Lang;
  if (!selected.length) { await ctx.answerCbQuery(t('no_cats_selected', lang)); return; }
  await ctx.answerCbQuery();
  await ctx.editMessageText(`📁 ${selected.join(', ')}`).catch(() => { });
  await registerSupplier(ctx, uid, s.tempData, selected);
});
bot.action('cats_edit_done', async ctx => {
  const uid = ctx.from!.id; const s = getS(uid); const sup = repos.users.findById(uid);
  if (s.step !== 'edit_cats' || !s.tempData || !isSup(sup)) { await ctx.answerCbQuery(); return; }
  const selected: string[] = s.tempData.selectedCats ?? [];
  if (!selected.length) { await ctx.answerCbQuery(t('no_cats_selected', getLang(sup))); return; }
  sup.categories = selected; repos.users.save(sup); clearS(uid); const lang = getLang(sup);
  await ctx.answerCbQuery();
  await ctx.editMessageText(`${t('cats_updated', lang)}\n📁 ${selected.join(', ')}`).catch(() => { });
  await ctx.reply(t('profile', lang), supKb(lang));
});
bot.action('edit_cats_action', async ctx => {
  const uid = ctx.from!.id; const sup = repos.users.findById(uid); if (!isSup(sup)) { await ctx.answerCbQuery(); return; }
  const lang = getLang(sup); const s = getS(uid); s.step = 'edit_cats'; s.tempData = { selectedCats: [...sup.categories] };
  await ctx.answerCbQuery(); await ctx.reply(t('cats_select', lang), buildCatKb([...sup.categories], lang, 'cats_edit_done'));
});

// ─── CATALOG NAVIGATION ───────────────────────────────────────────────────────

bot.action(['cat_prev', 'cat_next'], async ctx => {
  if (!rateLimit(ctx.from!.id, 800)) { await ctx.answerCbQuery(); return; }
  const uid = ctx.from!.id; const s = getS(uid);
  const user = repos.users.findById(uid); if (!isSt(user) || !s.tempData?.catIds?.length) { await ctx.answerCbQuery(); return; }
  const cur = s.tempData.catPage ?? 0; const total = s.tempData.catIds.length;
  const next = ctx.match[0] === 'cat_next' ? Math.min(total - 1, cur + 1) : Math.max(0, cur - 1);
  s.tempData.catPage = next;
  const prod = repos.products.findById(s.tempData!.catIds[next]); if (!prod) { await ctx.answerCbQuery(); return; }
  await ctx.answerCbQuery(); await sendProductCard(ctx, prod, next, total, user.lang, s.tempData.catFilter, uid);
});
bot.action('cat_search', async ctx => {
  const uid = ctx.from!.id; const user = repos.users.findById(uid); if (!isSt(user)) { await ctx.answerCbQuery(); return; }
  getS(uid).step = 'cat_search_q'; await ctx.answerCbQuery(); await ctx.reply(t('search_hint', user.lang));
});
bot.action('cat_filter', async ctx => {
  if (!rateLimit(ctx.from!.id, 1000)) { await ctx.answerCbQuery(); return; }
  const uid = ctx.from!.id; const user = repos.users.findById(uid); if (!isSt(user)) { await ctx.answerCbQuery(); return; }
  const lang = user.lang; const meta = getCatalogMeta(); const s = getS(uid);
  s.tempData = { ...(s.tempData ?? {}), filterCats: meta.categories, filterCities: meta.cities };
  await ctx.answerCbQuery(); await ctx.reply(t('filter_active', lang), Markup.inlineKeyboard([[Markup.button.callback(t('filter_by_cat', lang), 'cat_filter_cat'), Markup.button.callback(t('filter_by_city', lang), 'cat_filter_city')], [Markup.button.callback(t('filter_reset', lang), 'cat_filter_reset')]]));
});
bot.action('cat_filter_cat', async ctx => {
  const uid = ctx.from!.id; const s = getS(uid); const user = repos.users.findById(uid); if (!isSt(user)) { await ctx.answerCbQuery(); return; }
  const cats: string[] = s.tempData?.filterCats ?? getCatalogMeta().categories; if (!cats.length) { await ctx.answerCbQuery('Нет'); return; }
  s.tempData = { ...(s.tempData ?? {}), filterCats: cats }; await ctx.answerCbQuery();
  await ctx.reply('📁', Markup.inlineKeyboard(cats.map((c, i) => [Markup.button.callback(`📁 ${c}`, `cat_fc_${i}`)])));
});
bot.action('cat_filter_city', async ctx => {
  const uid = ctx.from!.id; const s = getS(uid); const user = repos.users.findById(uid); if (!isSt(user)) { await ctx.answerCbQuery(); return; }
  const cities: string[] = s.tempData?.filterCities ?? getCatalogMeta().cities; if (!cities.length) { await ctx.answerCbQuery('Нет'); return; }
  s.tempData = { ...(s.tempData ?? {}), filterCities: cities }; await ctx.answerCbQuery();
  await ctx.reply('📍', Markup.inlineKeyboard(cities.map((c, i) => [Markup.button.callback(`📍 ${c}`, `cat_fci_${i}`)])));
});
bot.action(/^cat_fc_(\d+)$/, async ctx => {
  const uid = ctx.from!.id; const s = getS(uid); const user = repos.users.findById(uid); if (!isSt(user)) { await ctx.answerCbQuery(); return; }
  const cat = (s.tempData?.filterCats ?? [])[Number(ctx.match[1])]; if (!cat) { await ctx.answerCbQuery(); return; }
  await ctx.answerCbQuery(`📁 ${cat}`); await openCatalog(ctx, uid, user.lang, { category: cat });
});
bot.action(/^cat_fci_(\d+)$/, async ctx => {
  const uid = ctx.from!.id; const s = getS(uid); const user = repos.users.findById(uid); if (!isSt(user)) { await ctx.answerCbQuery(); return; }
  const city = (s.tempData?.filterCities ?? [])[Number(ctx.match[1])]; if (!city) { await ctx.answerCbQuery(); return; }
  await ctx.answerCbQuery(`📍 ${city}`); await openCatalog(ctx, uid, user.lang, { city });
});
bot.action('cat_filter_reset', async ctx => {
  const uid = ctx.from!.id; const user = repos.users.findById(uid); if (!isSt(user)) { await ctx.answerCbQuery(); return; }
  await ctx.answerCbQuery(t('filter_reset', user.lang)); await openCatalog(ctx, uid, user.lang);
});
bot.action(/^cat_cnt_(.+)$/, async ctx => {
  const prod = repos.products.findById(ctx.match[1]); if (!prod) { await ctx.answerCbQuery('Не найден'); return; }
  const uid = ctx.from!.id; const lang = getLang(repos.users.findById(uid));
  const sup = repos.users.findById(prod.supplierId) as SupplierUser | undefined;
  const deals = repos.deals.countBySupplierId(prod.supplierId);
  const since = sup?.registeredAt ? fmtD(sup.registeredAt) : '—';
  if (spam.trackContact(uid, prod.id)) { repos.products.incrementContact(prod.id); pushEvent('contact', prod.id, prod.supplierId, uid); }
  await ctx.answerCbQuery();
  await ctx.reply(`🏢 *${md(prod.supplierName)}*${sup?.approved ? ' ✅' : ''}\n📞 ${md(prod.supplierPhone)}\n💬 ${prod.supplierUsername ? md('@' + prod.supplierUsername) : '—'}\n\n${t('completed_deals_lbl', lang)}: *${deals}*\n${t('products_listed_lbl', lang)}: *${repos.products.findBySupplierId(prod.supplierId, false).length}*\n${t('member_since_lbl', lang)}: ${since}`, { parse_mode: 'Markdown' });
});

// ─── M1: COMPETITIVE OFFER BOARD ─────────────────────────────────────────────

bot.action(/^view_offers_(.+)$/, async ctx => {
  const uid = ctx.from!.id;
  const req = repos.requests.findById(ctx.match[1]);
  if (!req || req.storeId !== uid) { await ctx.answerCbQuery('Не найдено'); return; }
  await ctx.answerCbQuery();
  const lang = getLang(repos.users.findById(uid));
  const s = getS(uid); const sortBy = s.tempData?.offerSort ?? 'price';
  const { text, kb } = buildOfferBoard(req, lang, sortBy);
  await ctx.reply(text, { parse_mode: 'Markdown', ...kb });
});

// M1: Re-sort board
bot.action(/^ob_sort_(\w+)_(.+)$/, async ctx => {
  if (!rateLimit(ctx.from!.id, 500)) { await ctx.answerCbQuery(); return; }
  const sort = ctx.match[1]; const reqId = ctx.match[2];
  const uid = ctx.from!.id;
  const req = repos.requests.findById(reqId);
  if (!req || req.storeId !== uid) { await ctx.answerCbQuery(); return; }
  const s = getS(uid); if (!s.tempData) s.tempData = {};
  s.tempData.offerSort = sort;
  const lang = getLang(repos.users.findById(uid));
  const { text, kb } = buildOfferBoard(req, lang, sort);
  try { await ctx.editMessageText(text, { parse_mode: 'Markdown', ...kb }); }
  catch { await ctx.reply(text, { parse_mode: 'Markdown', ...kb }); }
  await ctx.answerCbQuery();
});

// ─── M4: PRE-ACCEPT CONFIRMATION ─────────────────────────────────────────────

// Legacy `accept_` callback redirects to pre-accept
bot.action(/^accept_(.+)_(.+)$/, async ctx => {
  const [, offId, reqId] = ctx.match; const uid = ctx.from!.id;
  const req = repos.requests.findById(reqId);
  const offer = req?.offers.find(o => o.id === offId && o.status === 'pending');
  if (!req || req.storeId !== uid || !canModReq(req.status) || !offer) { await ctx.answerCbQuery('Недоступно'); return; }
  const lang = getLang(repos.users.findById(uid)); const isVer = (repos.users.findById(offer.supplierId) as SupplierUser)?.approved;
  const supDeals = repos.deals.countBySupplierId(offer.supplierId);
  await ctx.answerCbQuery();
  const msg = `${t('pre_accept_msg', lang)}\n\n🏢 *${md(offer.supplierName)}*${isVer ? ' ✅' : ''}\n📞 ${md(offer.supplierPhone)}\n💬 ${offer.supplierUsername ? md('@' + offer.supplierUsername) : '—'}\n💰 ${md(offer.price)} | ⚡ ${md(offer.estimatedDelivery)}\n🏆 ${supDeals} сделок`;
  await ctx.editMessageText(msg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback(t('pre_accept_confirm', lang), `confirm_accept_${offId}_${reqId}`), Markup.button.callback(t('pre_accept_cancel', lang), `view_offers_${reqId}`)]]) });
});

bot.action(/^pre_accept_(.+)_(.+)$/, async ctx => {
  if (!rateLimit(ctx.from!.id)) { await ctx.answerCbQuery(t('slow_down', 'ru')); return; }
  const [, offId, reqId] = ctx.match; const uid = ctx.from!.id;
  const req = repos.requests.findById(reqId);
  const offer = req?.offers.find(o => o.id === offId && o.status === 'pending');
  if (!req || req.storeId !== uid || !canModReq(req.status) || !offer) { await ctx.answerCbQuery('Недоступно'); return; }
  const lang = getLang(repos.users.findById(uid)); const isVer = (repos.users.findById(offer.supplierId) as SupplierUser)?.approved;
  const supDeals = repos.deals.countBySupplierId(offer.supplierId);
  await ctx.answerCbQuery();
  const msg = `${t('pre_accept_msg', lang)}\n\n🏢 *${md(offer.supplierName)}*${isVer ? ' ✅' : ''}\n📞 ${md(offer.supplierPhone)}\n💬 ${offer.supplierUsername ? md('@' + offer.supplierUsername) : '—'}\n💰 ${md(offer.price)} | ⚡ ${md(offer.estimatedDelivery)}\n🏆 ${supDeals} сделок`;
  await ctx.reply(msg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback(t('pre_accept_confirm', lang), `confirm_accept_${offId}_${reqId}`), Markup.button.callback(t('pre_accept_cancel', lang), `view_offers_${reqId}`)]]) });
});

// Final acceptance
bot.action(/^confirm_accept_(.+)_(.+)$/, async ctx => {
  if (!rateLimit(ctx.from!.id)) { await ctx.answerCbQuery(t('slow_down', 'ru')); return; }
  const [, offId, reqId] = ctx.match; const uid = ctx.from!.id;
  const req = repos.requests.findById(reqId);
  if (!req || req.storeId !== uid || !canModReq(req.status)) { await ctx.answerCbQuery('Недоступно'); return; }
  const offer = req.offers.find(o => o.id === offId && o.status === 'pending');
  if (!offer) { await ctx.answerCbQuery('Не найдено'); return; }
  offer.status = 'accepted';
  req.offers.filter(o => o.id !== offId && o.status === 'pending').forEach(o => { o.status = 'rejected'; });
  req.status = 'accepted'; req.acceptedOfferId = offId;
  req.statusHistory = req.statusHistory ?? []; req.statusHistory.push({ status: 'accepted', at: new Date().toISOString() });
  repos.requests.save(req);
  const lang = getLang(repos.users.findById(uid));
  await ctx.editMessageText(`${t('offer_accepted_msg', lang)}\n\n🏢 *${md(offer.supplierName)}*\n📞 ${md(offer.supplierPhone)}\n💬 ${offer.supplierUsername ? md('@' + offer.supplierUsername) : '—'}\n\n${t('req_status_accepted', lang)}`, { parse_mode: 'Markdown' });
  const sL = getLang(repos.users.findById(offer.supplierId));
  await bot.telegram.sendMessage(offer.supplierId, `${t('offer_accepted_notif', sL)}\n\n📦 ${req.product}\n🏪 ${req.storeName}\n📞 ${req.storePhone}`, { ...Markup.inlineKeyboard([[Markup.button.callback(t('mark_delivered_btn', sL), `mark_delivered_${req.id}`)]]) }).catch(() => { });
  for (const o of req.offers.filter(o2 => o2.id !== offId)) {
    const rL = getLang(repos.users.findById(o.supplierId));
    await bot.telegram.sendMessage(o.supplierId, `${t('offer_closed_notif', rL)}\n\n📦 ${req.product}`).catch(() => { });
  }
  await bot.telegram.sendMessage(ADMIN_ID, `✅ Сделка: ${req.product} | ${req.storeName} → ${offer.supplierName}`).catch(() => { });
});

// Reject offer
bot.action(/^reject_(.+)_(.+)$/, async ctx => {
  if (!rateLimit(ctx.from!.id)) { await ctx.answerCbQuery(t('slow_down', 'ru')); return; }
  const [, offId, reqId] = ctx.match; const uid = ctx.from!.id;
  const req = repos.requests.findById(reqId);
  if (!req || req.storeId !== uid || !canModReq(req.status)) { await ctx.answerCbQuery('Недоступно'); return; }
  const offer = req.offers.find(o => o.id === offId && o.status === 'pending');
  if (!offer) { await ctx.answerCbQuery('Не найдено'); return; }
  repos.requests.updateOfferStatus(offId, 'rejected');
  await ctx.editMessageText(t('offer_rejected_msg', getLang(repos.users.findById(uid))));
  await bot.telegram.sendMessage(offer.supplierId, `${t('offer_rejected_notif', getLang(repos.users.findById(offer.supplierId)))}\n\n📦 ${req.product}`).catch(() => { });
});

// ─── M2: SUPPLIER MARKET POSITION ────────────────────────────────────────────

bot.action(/^my_mkt_(.+)$/, async ctx => {
  const uid = ctx.from!.id; const sup = repos.users.findById(uid);
  if (!isAct(sup)) { await ctx.answerCbQuery(); return; }
  const req = repos.requests.findById(ctx.match[1]);
  if (!req) { await ctx.answerCbQuery('Не найдено'); return; }
  const lang = getLang(sup); const text = buildMarketStats(req, uid, lang);
  const myOffer = req.offers.find(o => o.supplierId === uid && o.status === 'pending');
  await ctx.answerCbQuery();
  await ctx.reply(text, {
    parse_mode: 'Markdown',
    ...(myOffer && canModReq(req.status) ? Markup.inlineKeyboard([[Markup.button.callback(t('mkt_improve', lang), `upd_offer_${req.id}`)]]) : {})
  });
});

// ─── M3: OFFER IMPROVEMENT ───────────────────────────────────────────────────

bot.action(/^upd_offer_(.+)$/, async ctx => {
  if (!rateLimit(ctx.from!.id)) { await ctx.answerCbQuery(t('slow_down', 'ru')); return; }
  const uid = ctx.from!.id; const sup = repos.users.findById(uid);
  if (!isAct(sup)) { await ctx.answerCbQuery(t('only_approved', getLang(sup))); return; }
  const req = repos.requests.findById(ctx.match[1]);
  if (!req || !canModReq(req.status)) { await ctx.answerCbQuery(t('req_closed', getLang(sup))); return; }
  const myOffer = req.offers.find(o => o.supplierId === uid && o.status === 'pending');
  if (!myOffer) { await ctx.answerCbQuery(t('already_replied', getLang(sup))); return; }
  const l = getLang(sup); const s = getS(uid);
  s.step = 'upd_price'; s.tempData = { reqId: req.id, offerId: myOffer.id, lang: l, currentPrice: myOffer.price, currentEta: myOffer.estimatedDelivery };
  await ctx.answerCbQuery();
  await ctx.reply(`${t('upd_ask_price', l)}\n\n*Текущая: ${md(myOffer.price)}*`, { parse_mode: 'Markdown' });
});

// ─── DELIVERY LIFECYCLE ───────────────────────────────────────────────────────

bot.action(/^mark_delivered_(.+)$/, async ctx => {
  if (!rateLimit(ctx.from!.id)) { await ctx.answerCbQuery(t('slow_down', 'ru')); return; }
  const uid = ctx.from!.id;
  const req = repos.requests.findById(ctx.match[1]);
  if (!req || req.status !== 'accepted') { await ctx.answerCbQuery('Недоступно'); return; }
  const ao = req.offers.find(o => o.id === req.acceptedOfferId);
  if (!ao || ao.supplierId !== uid) { await ctx.answerCbQuery('Нет прав'); return; }
  req.status = 'delivered'; req.statusHistory = req.statusHistory ?? []; req.statusHistory.push({ status: 'delivered', at: new Date().toISOString() }); repos.requests.updateStatus(req.id, 'delivered');
  const lang = getLang(repos.users.findById(uid));
  await ctx.editMessageText(t('delivered_notif_sup', lang));
  const stL = getLang(repos.users.findById(req.storeId));
  await bot.telegram.sendMessage(req.storeId, `${t('delivered_notif_store', stL)}\n\n📦 *${md(req.product)}*\n🏢 ${md(ao.supplierName)}`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback(t('confirm_delivery_btn', stL), `confirm_delivery_${req.id}`)]]) }).catch(() => { });
  await bot.telegram.sendMessage(ADMIN_ID, `🚚 Доставлено: ${req.product} | ${req.storeName}`).catch(() => { });
});
bot.action(/^confirm_delivery_(.+)$/, async ctx => {
  if (!rateLimit(ctx.from!.id)) { await ctx.answerCbQuery(t('slow_down', 'ru')); return; }
  const uid = ctx.from!.id;
  const req = repos.requests.findById(ctx.match[1]);
  if (!req || req.storeId !== uid || req.status !== 'delivered') { await ctx.answerCbQuery('Недоступно'); return; }
  req.status = 'completed'; req.statusHistory = req.statusHistory ?? []; req.statusHistory.push({ status: 'completed', at: new Date().toISOString() });
  const ao = req.offers.find(o => o.id === req.acceptedOfferId);
  if (ao) {
    const deal: DealRecord = { id: genId(), requestId: req.id, storeName: req.storeName, storeId: req.storeId, supplierName: ao.supplierName, supplierId: ao.supplierId, product: req.product, quantity: req.quantity, unitType: req.unitType, price: ao.price, completedAt: new Date().toISOString() };
    repos.deals.save(deal);
    // Increment completedDeals on the supplier's products that match the deal product name
    const supProds = repos.products.findBySupplierId(ao.supplierId, false);
    const matchingProd = supProds.find(p => p.name.toLowerCase() === req.product.toLowerCase()) ?? supProds[0];
    if (matchingProd) repos.products.incrementCompletedDeals(matchingProd.id);
    await bot.telegram.sendMessage(ao.supplierId, `${t('completed_notif_sup', getLang(repos.users.findById(ao.supplierId)))}\n\n📦 ${req.product}\n🏪 ${req.storeName}`).catch(() => { });
  }
  repos.requests.updateStatus(req.id, 'completed');
  await ctx.editMessageText(t('completed_notif_store', getLang(repos.users.findById(uid))));
  await bot.telegram.sendMessage(ADMIN_ID, `🎉 Завершено: ${req.product} | ${req.storeName} → ${ao?.supplierName ?? '—'}`).catch(() => { });
});

// ─── MY REQUESTS ─────────────────────────────────────────────────────────────

bot.action(/^cancel_req_(.+)$/, async ctx => {
  const req = repos.requests.findById(ctx.match[1]);
  if (!req || req.storeId !== ctx.from!.id || !canModReq(req.status)) { await ctx.answerCbQuery('Недоступно'); return; }
  repos.requests.updateStatus(req.id, 'cancelled');
  await ctx.editMessageText(`❌ Заявка *${md(req.product)}* отменена.`, { parse_mode: 'Markdown' });
});

async function showReqList(ctx: any, reqs: Request[], lang: Lang, label: string) {
  if (!reqs.length) { await ctx.answerCbQuery(`Нет ${label}`); return; }
  await ctx.answerCbQuery();
  for (const req of reqs.slice(-5).reverse()) {
    const pending = req.offers.filter(o => o.status === 'pending').length;
    let btns: any[][] = [];
    if (canModReq(req.status)) btns = [[Markup.button.callback(`💬 (${pending})`, `view_offers_${req.id}`), Markup.button.callback('❌', `cancel_req_${req.id}`)]];
    else if (req.status === 'delivered') btns = [[Markup.button.callback(t('confirm_delivery_btn', lang), `confirm_delivery_${req.id}`)]];
    else if (req.status === 'accepted') btns = [[Markup.button.callback(t('offers_summary_btn', lang), `view_offers_${req.id}`)]];
    await ctx.reply(`📦 *${md(req.product)}* | ${req.quantity} ${req.unitType}\n📍 ${req.city} | ${reqStatusLabel(req.status, lang)}\n📅 ${fmtD(req.createdAt)}`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(btns) });
  }
}
bot.action('my_active', async ctx => { const reqs = repos.requests.findByStore(ctx.from!.id).filter(r => ['active', 'offer_received', 'accepted', 'delivered'].includes(r.status)); await showReqList(ctx, reqs, getLang(repos.users.findById(ctx.from!.id)), 'активных'); });
bot.action('my_completed', async ctx => { const reqs = repos.requests.findByStore(ctx.from!.id).filter(r => r.status === 'completed'); await showReqList(ctx, reqs, getLang(repos.users.findById(ctx.from!.id)), 'завершённых'); });
bot.action('my_cancelled', async ctx => { const reqs = repos.requests.findByStore(ctx.from!.id).filter(r => r.status === 'cancelled'); await showReqList(ctx, reqs, getLang(repos.users.findById(ctx.from!.id)), 'отменённых'); });

// ─── PRODUCT PAGINATION & CATALOG ─────────────────────────────────────────────

async function buildCatalogPage(ctx: any, uid: number, editMessage = false) {
  const s = getS(uid);
  if (!s.catalog) {
    s.catalog = { role: isAdmin(uid) ? 'admin' : 'supplier', category: 'All', page: 0, cursors: [null] };
    persistS(uid);
  }
  const lang = getLang(repos.users.findById(uid));
  const catState = s.catalog;
  
  const opts: any = {
    limit: 10,
    cursor: catState.cursors[catState.page],
    category: catState.category,
    includeArchived: false,
  };
  if (catState.role === 'supplier') opts.supplierId = uid;
  
  const { items, nextCursor } = repos.products.findPaginated(opts);
  
  while (catState.cursors.length <= catState.page + 1) catState.cursors.push(null);
  catState.cursors[catState.page + 1] = nextCursor;
  persistS(uid);

  if (items.length === 0) {
    const text = t('no_prods', lang);
    if (editMessage) await ctx.editMessageText(text).catch(() => {});
    else await ctx.reply(text);
    return;
  }

  let text = `*${t('pg_products', lang)}* | ${catState.category === 'All' ? t('all_cats_lbl', lang) : md(catState.category)} | ${t('pg_page', lang)} ${catState.page + 1}\n\n`;
  const deleteBtns: any[] = [];
  
  items.forEach((p, idx) => {
    const n = idx + 1;
    text += `${n}. 📦 *${md(p.name)}*\n`;
    text += `💰 ${md(p.price)} | 📁 ${md(p.category)}\n`;
    text += `📍 ${md(p.city)} | ✅ ${p.availabilityStatus === 'in_stock' ? 'В наличии' : 'Под заказ'}\n`;
    text += `👁 ${p.viewCount} | 📅 ${fmtD(p.createdAt)}\n\n`;
    deleteBtns.push(Markup.button.callback(`🗑 ${n}`, `pg_del_${p.id}`));
    deleteBtns.push(Markup.button.callback(`🚀 ${n}`, `pg_boost_${p.id}`));
  });

  const kbRows: any[][] = [];
  for (let i = 0; i < deleteBtns.length; i += 4) kbRows.push(deleteBtns.slice(i, i + 4));
  
  const navRow: any[] = [];
  if (catState.page > 0) navRow.push(Markup.button.callback(t('pg_prev', lang), 'pg_prev'));
  if (nextCursor) navRow.push(Markup.button.callback(t('pg_next', lang), 'pg_next'));
  if (navRow.length > 0) kbRows.push(navRow);
  
  kbRows.push([Markup.button.callback(t('pg_filter', lang), 'pg_filter')]);
  
  const optsMsg = { parse_mode: 'Markdown' as const, ...Markup.inlineKeyboard(kbRows) };
  if (editMessage) await ctx.editMessageText(text, optsMsg).catch(() => {});
  else await ctx.reply(text, optsMsg);
}

bot.action('pg_next', async ctx => {
  const uid = ctx.from!.id; const s = getS(uid);
  if (s.catalog && s.catalog.cursors[s.catalog.page + 1]) { s.catalog.page++; persistS(uid); }
  await ctx.answerCbQuery(); await buildCatalogPage(ctx, uid, true);
});

bot.action(/^pg_boost_(.+)$/, async ctx => {
  const prodId = ctx.match[1];
  const uid = ctx.from!.id;
  const prod = repos.products.findById(prodId);
  if (!prod || prod.supplierId !== uid) { await ctx.answerCbQuery('Not found'); return; }

  const txId = Date.now().toString(36) + Math.random().toString(36).substring(2, 7);
  repos.transactions.create({
      id: txId + '_tmp', mivraTxId: txId, userId: uid, productId: prodId,
      type: 'FEATURED', amount: 1000000, status: 'pending',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  });

  const url = buildCheckoutUrl({ mivraTxId: txId, amountTiyins: 1000000 });
  await ctx.answerCbQuery();

  if (!url) {
    await ctx.reply('🚀 *Boost оформлен* — ожидаем настройки платёжного терминала\. Обратитесь к администратору для завершения\.',
      { parse_mode: 'MarkdownV2' });
    return;
  }

  await ctx.reply(`🚀 *Оплата Boost* для товара *${md(prod.name)}*\n\nСтоимость: 10,000 UZS (на 7 дней)\nВыделение цветом и приоритет в каталоге.`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.url('Оплатить (Payme)', url)]])
  });
});

bot.action('pg_prev', async ctx => {
  const uid = ctx.from!.id; const s = getS(uid);
  if (s.catalog && s.catalog.page > 0) { s.catalog.page--; persistS(uid); }
  await ctx.answerCbQuery(); await buildCatalogPage(ctx, uid, true);
});

bot.action(/^pg_del_(.+)$/, async ctx => {
  const uid = ctx.from!.id; const pid = ctx.match[1];
  const prod = repos.products.findById(pid);
  if (!prod) { await ctx.answerCbQuery('Не найден'); return; }
  if (!isAdmin(uid) && prod.supplierId !== uid) { await ctx.answerCbQuery('Нет прав'); return; }
  repos.products.setArchived(pid, true);
  await ctx.answerCbQuery('Удалено');
  await buildCatalogPage(ctx, uid, true);
});

bot.action('pg_filter', async ctx => {
  const uid = ctx.from!.id; const lang = getLang(repos.users.findById(uid));
  const cats = ['Напитки', 'Продукты питания', 'Бакалея', 'Сладости', 'Химия', 'All'];
  const kb = cats.map(c => [Markup.button.callback(c === 'All' ? t('all_cats_lbl', lang) : c, `pg_cat_${c}`)]);
  await ctx.answerCbQuery();
  await ctx.editMessageText(`*${t('pg_filter', lang)}*\n${lang === 'uz' ? 'Kategoriyani tanlang' : 'Выберите категорию'}:`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(kb) }).catch(() => {});
});

bot.action(/^pg_cat_(.+)$/, async ctx => {
  const uid = ctx.from!.id; const s = getS(uid);
  if (!s.catalog) s.catalog = { role: isAdmin(uid) ? 'admin' : 'supplier', category: 'All', page: 0, cursors: [null] };
  s.catalog.category = ctx.match[1]; s.catalog.page = 0; s.catalog.cursors = [null]; persistS(uid);
  await ctx.answerCbQuery(); await buildCatalogPage(ctx, uid, true);
});

// ─── PRODUCT MANAGEMENT ───────────────────────────────────────────────────────

bot.action('add_product', async ctx => {
  const uid = ctx.from!.id; const sup = repos.users.findById(uid);
  if (!isAct(sup)) { await ctx.answerCbQuery(); await ctx.reply(t('not_active', getLang(sup))); return; }
  if (getActiveProds(uid) >= getProductLimit(sup)) { await ctx.answerCbQuery(); await ctx.reply(t('limit_prods', getLang(sup))); return; }
  const l = getLang(sup); const s = getS(uid); s.step = 'prod_name'; s.tempData = { lang: l, photos: [] };
  await ctx.editMessageText(t('p_name', l));
});
bot.action('view_my_products', async ctx => {
  const uid = ctx.from!.id; const sup = repos.users.findById(uid); if (!isAct(sup)) { await ctx.answerCbQuery(); return; }
  const s = getS(uid);
  s.catalog = { role: 'supplier', category: 'All', page: 0, cursors: [null] };
  persistS(uid);
  await ctx.answerCbQuery();
  await buildCatalogPage(ctx, uid, false);
});
bot.action('view_archived_prods', async ctx => {
  const uid = ctx.from!.id; const sup = repos.users.findById(uid); if (!isAct(sup)) { await ctx.answerCbQuery(); return; }
  const archived = repos.products.findBySupplierId(uid, true).filter(p => p.archived); const l = getLang(sup);
  await ctx.answerCbQuery(); if (!archived.length) { await ctx.reply('📭 Архив пуст.'); return; }
  for (const p of archived.slice(-5)) await sendProductCardCompact(ctx, p, l, [[Markup.button.callback(t('restore_btn', l), `restore_prod_${p.id}`)]]);
});
bot.action(/^edit_prod_(.+)$/, async ctx => {
  const uid = ctx.from!.id; const prod = repos.products.findById(ctx.match[1]);
  if (!prod || prod.supplierId !== uid || prod.archived) { await ctx.answerCbQuery('Не найден'); return; }
  const lang = getLang(repos.users.findById(uid)); await ctx.answerCbQuery();
  await ctx.reply(`${t('edit_choose_field', lang)}\n*${md(prod.name)}*`, { parse_mode: 'Markdown', ...buildEditMenu(prod.id, lang) });
});
bot.action(/^ep_(\w+)_(.+)$/, async ctx => {
  const field = ctx.match[1]; const prodId = ctx.match[2];
  const uid = ctx.from!.id; const prod = repos.products.findById(prodId);
  if (!prod || prod.supplierId !== uid || prod.archived) { await ctx.answerCbQuery('Не найден'); return; }
  const lang = getLang(repos.users.findById(uid)); const s = getS(uid);
  s.step = `edit_prod_${field}`; s.tempData = { editProdId: prodId, lang, photos: [] };
  await ctx.answerCbQuery();
  if (field === 'photos') await ctx.reply(t('p_photos', lang));
  else await ctx.reply(`${t(`ef_${field}` as TKey, lang)}\n${t('enter_new_value', lang)}`);
});
bot.action(/^archive_prod_(.+)$/, async ctx => {
  const uid = ctx.from!.id; const prod = repos.products.findById(ctx.match[1]);
  if (!prod || prod.supplierId !== uid) { await ctx.answerCbQuery('Не найден'); return; }
  repos.products.setArchived(prod.id, true); const lang = getLang(repos.users.findById(uid));
  await ctx.editMessageText(t('prod_archived', lang)).catch(async () => { await ctx.reply(t('prod_archived', lang)); });
});
bot.action(/^restore_prod_(.+)$/, async ctx => {
  const uid = ctx.from!.id; const sup = repos.users.findById(uid); if (!isAct(sup)) { await ctx.answerCbQuery(); return; }
  if (getActiveProds(uid) >= getProductLimit(sup)) { await ctx.answerCbQuery(t('limit_prods', getLang(sup))); return; }
  const prod = repos.products.findById(ctx.match[1]); if (!prod || prod.supplierId !== uid) { await ctx.answerCbQuery('Не найден'); return; }
  repos.products.setArchived(prod.id, false); const lang = getLang(sup);
  await ctx.editMessageText(t('prod_restored', lang)).catch(async () => { await ctx.reply(t('prod_restored', lang)); });
});
bot.action(/^more_photos_(.+)$/, async ctx => {
  const prod = repos.products.findById(ctx.match[1]); if (!prod) { await ctx.answerCbQuery(); return; }
  const extras = (prod.photos ?? []).filter(Boolean).slice(1); if (!extras.length) { await ctx.answerCbQuery(); return; }
  await ctx.answerCbQuery();
  if (extras.length === 1) await ctx.replyWithPhoto(extras[0]);
  else await ctx.replyWithMediaGroup(extras.map(p => ({ type: 'photo' as const, media: p })));
});

// ─── FAVOURITES ───────────────────────────────────────────────────────────────

bot.action(/^fav_add_(.+)$/, async ctx => {
  const uid = ctx.from!.id; const user = repos.users.findById(uid) as StoreUser; if (!isSt(user)) { await ctx.answerCbQuery(); return; }
  const pid = ctx.match[1]; if (!repos.products.findById(pid)) { await ctx.answerCbQuery('Не найден'); return; }
  repos.users.addFavorite(uid, pid);
  await ctx.answerCbQuery(t('fav_added', user.lang));
});
bot.action(/^fav_rem_(.+)$/, async ctx => {
  const uid = ctx.from!.id; const user = repos.users.findById(uid) as StoreUser; if (!isSt(user)) { await ctx.answerCbQuery(); return; }
  repos.users.removeFavorite(uid, ctx.match[1]);
  await ctx.answerCbQuery(t('fav_removed', user.lang));
});

// ─── OFFER SUBMISSION ─────────────────────────────────────────────────────────

bot.action(/^start_offer_(.+)$/, async ctx => {
  if (!rateLimit(ctx.from!.id)) { await ctx.answerCbQuery(t('slow_down', 'ru')); return; }
  const uid = ctx.from!.id; const sup = repos.users.findById(uid);
  if (!isAct(sup)) { await ctx.answerCbQuery(t('only_approved', getLang(sup))); return; }
  const req = repos.requests.findById(ctx.match[1]);
  if (!req || !canModReq(req.status)) { await ctx.answerCbQuery(t('req_closed', getLang(sup))); return; }
  if (repos.requests.findById(req.id)?.offers.some(o => o.supplierId === uid)) { await ctx.answerCbQuery(t('already_replied', getLang(sup))); return; }
  const l = getLang(sup); const s = getS(uid); s.step = 'offer_price'; s.tempData = { requestId: req.id, lang: l };
  await ctx.answerCbQuery();
  await ctx.reply(`📦 *${md(req.product)}*\n${req.quantity} ${req.unitType} | 📍 ${req.city}\n\n${t('ask_price', l)}`, { parse_mode: 'Markdown' });
});
bot.action(/^skip_req_(.+)$/, async ctx => { await ctx.answerCbQuery(t('skip_req_btn', getLang(repos.users.findById(ctx.from!.id)))); });
bot.action(/^noop_(.+)$/, async ctx => { await ctx.answerCbQuery(); });

// ─── ADMIN ACTIONS ────────────────────────────────────────────────────────────

bot.action(/^sup_accept_(\d+)$/, async ctx => {
  if (!isAdmin(ctx.from?.id)) { await ctx.answerCbQuery('Нет прав'); return; }
  const sup = repos.users.findById(Number(ctx.match[1])) as SupplierUser; if (!isSup(sup)) { await ctx.answerCbQuery('Не найден'); return; }
  sup.approved = true; repos.users.save(sup); await ctx.editMessageText(`✅ *${md(sup.companyName)}* одобрен.`, { parse_mode: 'Markdown' });
  await bot.telegram.sendMessage(sup.id, `✅ Регистрация одобрена! Напишите /start.`).catch(() => { });
});
bot.action(/^sup_reject_(\d+)$/, async ctx => {
  if (!isAdmin(ctx.from?.id)) { await ctx.answerCbQuery('Нет прав'); return; }
  const sup = repos.users.findById(Number(ctx.match[1])) as SupplierUser; if (!isSup(sup)) { await ctx.answerCbQuery('Не найден'); return; }
  const name = sup.companyName;
  await ctx.editMessageText(`❌ ${name} отклонён.`);
  await bot.telegram.sendMessage(sup.id, '❌ Ваша заявка отклонена.').catch(() => { });
});
bot.action(/^admin_suspend_(\d+)$/, async ctx => {
  if (!isAdmin(ctx.from?.id)) { await ctx.answerCbQuery('Нет прав'); return; }
  const sup = repos.users.findById(Number(ctx.match[1])) as SupplierUser; if (!isSup(sup)) { await ctx.answerCbQuery('Не найден'); return; }
  sup.suspended = !sup.suspended; repos.users.save(sup);
  await ctx.editMessageText(`${sup.suspended ? '⛔' : '✅'} ${sup.companyName} ${sup.suspended ? 'приостановлен' : 'восстановлен'}.`);
  if (sup.suspended) await bot.telegram.sendMessage(sup.id, t('suspended', sup.lang)).catch(() => { });
});
bot.action(/^admin_del_prod_(.+)$/, async ctx => {
  if (!isAdmin(ctx.from?.id)) { await ctx.answerCbQuery('Нет прав'); return; }
  repos.products.delete(ctx.match[1]);
  await ctx.editMessageText('🗑 Товар удалён.');
});
bot.action(/^admin_tier_(\w+)_(\d+)$/, async ctx => {
  if (!isAdmin(ctx.from?.id)) { await ctx.answerCbQuery('Нет прав'); return; }
  const tier = ctx.match[1] as SupplierTier; const sup = repos.users.findById(Number(ctx.match[2])) as SupplierUser;
  if (!isSup(sup) || !TIER_LIMITS[tier]) { await ctx.answerCbQuery('Ошибка'); return; }
  sup.tier = tier; repos.users.save(sup);
  await ctx.editMessageText(`✅ Тариф ${sup.companyName}: ${tier}`);
  await bot.telegram.sendMessage(sup.id, `⭐ Тариф: *${t(`tier_${tier}` as TKey, sup.lang)}*\nЛимит: ${TIER_LIMITS[tier] === Infinity ? '∞' : TIER_LIMITS[tier]}`, { parse_mode: 'Markdown' }).catch(() => { });
});

// ─── DASHBOARD SORT ───────────────────────────────────────────────────────────

bot.action(/^da_sort_(\w+)$/, async ctx => {
  const uid = ctx.from!.id; const sup = repos.users.findById(uid); if (!isAct(sup)) { await ctx.answerCbQuery(); return; }
  const sortBy = ctx.match[1]; const lang = getLang(sup);
  const mine = sortProds(repos.products.findBySupplierId(uid, false), sortBy);
  try { await ctx.editMessageText(buildDashText(mine, sup, lang, sortBy), { parse_mode: 'Markdown', ...buildDashKb(lang, sortBy) }); }
  catch { await ctx.reply(buildDashText(mine, sup, lang, sortBy), { parse_mode: 'Markdown', ...buildDashKb(lang, sortBy) }); }
  await ctx.answerCbQuery();
});

// ─── /offer_<id> ─────────────────────────────────────────────────────────────

bot.hears(/^\/offer_(.+)$/, async ctx => {
  const uid = ctx.from.id; const sup = repos.users.findById(uid);
  if (!isAct(sup)) { await ctx.reply(t('only_approved', getLang(sup))); return; }
  const req = repos.requests.findById(ctx.match[1]);
  if (!req || !canModReq(req.status)) { await ctx.reply(t('req_closed', getLang(sup))); return; }
  if (req.offers.some(o => o.supplierId === uid)) { await ctx.reply(t('already_replied', getLang(sup))); return; }
  const l = getLang(sup); const s = getS(uid); s.step = 'offer_price'; s.tempData = { requestId: req.id, lang: l };
  await ctx.reply(`📦 *${md(req.product)}* | ${req.quantity} ${req.unitType}\n📍 ${req.city}\n\n${t('ask_price', l)}`, { parse_mode: 'Markdown' });
});

// ─── /req_<id> ───────────────────────────────────────────────────────────────

bot.hears(/^\/req_(.+)$/, async ctx => {
  const req = repos.requests.findById(ctx.match[1]);
  if (!req || req.storeId !== ctx.from.id) { await ctx.reply('Заявка не найдена.'); return; }
  const lang = getLang(repos.users.findById(ctx.from.id));
  const pending = req.offers.filter(o => o.status === 'pending').length;
  let btns: any[][] = [];
  if (canModReq(req.status)) btns = [[Markup.button.callback(`💬 (${pending})`, `view_offers_${req.id}`)]];
  else if (req.status === 'delivered') btns = [[Markup.button.callback(t('confirm_delivery_btn', lang), `confirm_delivery_${req.id}`)]];
  else if (req.status === 'accepted') btns = [[Markup.button.callback(t('offers_summary_btn', lang), `view_offers_${req.id}`)]];
  await ctx.reply(`📦 *${md(req.product)}* | ${req.quantity} ${req.unitType}\n${reqStatusLabel(req.status, lang)} | 💬 ${req.offers.length}`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(btns) });
});

// ─── /seed ────────────────────────────────────────────────────────────────────

bot.hears('/seed', async ctx => {
  const uid = ctx.from.id;
  if (!isAdmin(uid)) return;

  const dummySupplierId = 999999999;
  if (!repos.users.findById(dummySupplierId)) {
    const dummySup: SupplierUser = {
      id: dummySupplierId,
      firstName: 'Seeder',
      username: 'seeder_bot',
      role: 'supplier',
      companyName: 'MIVRA Test Supplier',
      contactPerson: 'Admin',
      phone: '+998901234567',
      city: 'Ташкент',
      businessDescription: 'Testing seed data.',
      approved: true,
      suspended: false,
      registeredAt: new Date().toISOString(),
      categories: PRESET_CATS,
      tier: 'enterprise',
      lang: 'ru'
    };
    repos.users.save(dummySup);
  }

  const baseNames = ['Сок Apple', 'Чай Зеленый', 'Кофе Арабика', 'Масло Оливковое', 'Мука Пшеничная', 'Сахар Рафинад', 'Рис Басмати', 'Макароны', 'Сыр Российский', 'Шоколад Молочный', 'Вода Минеральная', 'Печенье Овсяное', 'Кетчуп Томатный', 'Майонез Провансаль', 'Сосиски Говяжьи'];
  const cats = ['Напитки', 'Продукты питания', 'Бакалея', 'Сладости', 'Соусы', 'Мясо'];
  const cities = ['Ташкент', 'Самарканд', 'Бухара', 'Андижан'];

  let count = 0;
  for (let i = 0; i < 110; i++) {
    const pName = `${baseNames[i % baseNames.length]} Pro ${i + 1}`;
    const pCat = cats[i % cats.length];
    const pCity = cities[i % cities.length];
    const price = ((i % 50) + 10) * 1000;

    const prod: Product = {
      id: genId() + i,
      supplierId: dummySupplierId,
      supplierName: 'MIVRA Test Supplier',
      supplierPhone: '+998901234567',
      supplierUsername: 'seeder_bot',
      name: pName,
      category: pCat,
      description: `Тестовое описание для товара ${pName}. Отличное качество, гарантия, доставка.`,
      weightVolume: `${(i % 5) + 1} кг`,
      unitsPerBox: `${(i % 20) + 5} шт`,
      minOrderQty: `${(i % 10) + 1} кор`,
      price: `${price} сум`,
      priceNegotiable: i % 2 === 0,
      deliveryAvailable: i % 3 !== 0,
      deliveryScope: i % 2 === 0 ? 'uzbekistan' : 'regional',
      city: pCity,
      availabilityStatus: 'В наличии',
      photos: [],
      viewCount: Math.floor(Math.random() * 100),
      contactClicks: Math.floor(Math.random() * 20),
      offerResponses: Math.floor(Math.random() * 10),
      completedDeals: Math.floor(Math.random() * 5),
      createdAt: new Date(Date.now() - Math.random() * 10000000000).toISOString(),
      archived: false
    };
    repos.products.save(prod);
    count++;
  }
  await ctx.reply(`✅ Успешно сгенерировано ${count} тестовых товаров для каталога!`);
});

// ─── MAIN TEXT HANDLER ────────────────────────────────────────────────────────

bot.on(message('text'), async ctx => {
  const uid = ctx.from.id; const text = ctx.message.text.trim();
  const s = getS(uid); const user = repos.users.findById(uid);
  const lang = getLang(user);

  // ── Store Registration ────────────────────────────────────────────────────
  if (s.step === 'r_sname') { if (!s.tempData) s.tempData = { lang: 'ru' }; s.tempData.storeName = sanitize(text, 100); s.step = 'r_phone'; persistS(uid); await ctx.reply(t('r_phone', s.tempData.lang)); return; }
  if (s.step === 'r_phone') { if (!s.tempData) { clearS(uid); return; } s.tempData.phone = sanitize(text, 25); s.step = 'r_city'; persistS(uid); await ctx.reply(t('r_city', s.tempData.lang)); return; }
  if (s.step === 'r_city') {
    if (!s.tempData) { clearS(uid); return; }
    const { lang: l, storeName, phone } = s.tempData;
    const u: StoreUser = { id: uid, firstName: ctx.from.first_name, username: ctx.from.username, role: 'store', storeName, phone, city: text, lang: l, registeredAt: new Date().toISOString(), favorites: [] };
    repos.users.save(u); clearS(uid);
    await ctx.reply(`${t('r_store_done', l)}\n\n🏪 *${md(u.storeName)}*\n📍 ${md(text)}`, { parse_mode: 'Markdown', ...storeKb(l) });
    await bot.telegram.sendMessage(ADMIN_ID, `🆕 Новый магазин: ${u.storeName} (${text})`).catch(() => { }); return;
  }

  // ── Supplier Registration ─────────────────────────────────────────────────
  if (s.step === 'r_company') { if (!s.tempData) s.tempData = { lang: 'ru' }; s.tempData.companyName = sanitize(text, 100); s.step = 'r_contact'; persistS(uid); await ctx.reply(t('r_contact', s.tempData.lang)); return; }
  if (s.step === 'r_contact') { if (!s.tempData) { clearS(uid); return; } s.tempData.contactPerson = sanitize(text, 100); s.step = 'r_phone2'; persistS(uid); await ctx.reply(t('r_phone', s.tempData.lang)); return; }
  if (s.step === 'r_phone2') { if (!s.tempData) { clearS(uid); return; } s.tempData.phone = sanitize(text, 25); s.step = 'r_city2'; persistS(uid); await ctx.reply(t('r_city', s.tempData.lang)); return; }
  if (s.step === 'r_city2') { if (!s.tempData) { clearS(uid); return; } s.tempData.city = sanitize(text, 100); s.step = 'r_desc'; persistS(uid); await ctx.reply(t('r_desc', s.tempData.lang)); return; }
  if (s.step === 'r_desc') {
    if (!s.tempData) { clearS(uid); return; }
    s.tempData.businessDescription = text; s.step = 'r_cats'; s.tempData.selectedCats = [];
    await ctx.reply(t('cats_select', s.tempData.lang), buildCatKb([], s.tempData.lang, 'cats_reg_done')); return;
  }
  if (s.step === 'r_cats_custom') {
    if (!s.tempData) { clearS(uid); return; }
    const custom = text.split(',').map(c => c.trim()).filter(Boolean);
    const merged = [...new Set([...(s.tempData.selectedCats ?? []), ...custom])];
    s.tempData.selectedCats = merged; s.step = 'r_cats';
    await ctx.reply(t('cats_select', s.tempData.lang), buildCatKb(merged, s.tempData.lang, 'cats_reg_done')); return;
  }
  if (s.step === 'edit_cats_custom') {
    if (!s.tempData) { clearS(uid); return; }
    const custom = text.split(',').map(c => c.trim()).filter(Boolean);
    const merged = [...new Set([...(s.tempData.selectedCats ?? []), ...custom])];
    s.tempData.selectedCats = merged; s.step = 'edit_cats';
    await ctx.reply(t('cats_select', lang), buildCatKb(merged, lang, 'cats_edit_done')); return;
  }

  // ── Catalog ───────────────────────────────────────────────────────────────
  if (isCmd(text, 'catalog')) { if (!isSt(user)) return; await openCatalog(ctx, uid, user.lang); return; }
  if (s.step === 'cat_search_q') { if (!isSt(user)) { clearS(uid); return; } clearS(uid); await openCatalog(ctx, uid, user.lang, { q: text }); return; }

  // ── Favourites ────────────────────────────────────────────────────────────
  if (isCmd(text, 'favorites')) {
    if (!isSt(user)) return;
    const favIds = user.favorites ?? [];
    if (!favIds.length) { await ctx.reply(t('fav_empty', lang)); return; }
    const favProds = favIds
      .map(id => repos.products.findById(id))
      .filter((p): p is Product => Boolean(p && !p.archived));
    if (!favProds.length) { await ctx.reply(t('fav_empty', lang)); return; }
    const s2 = getS(uid); s2.tempData = { catPage: 0, catIds: favProds.map(p => p.id), catFilter: {} };
    await sendProductCard(ctx, favProds[0], 0, favProds.length, lang, undefined, uid); return;
  }

  // ── Create Request ────────────────────────────────────────────────────────
  if (isCmd(text, 'create_req')) {
    if (!isSt(user)) return;
    const active = repos.requests.findByStore(uid).filter(r => ['active', 'offer_received', 'accepted', 'delivered'].includes(r.status)).length;
    if (active >= MAX_ACTIVE_REQS) { await ctx.reply(t('limit_reqs', lang)); return; }
    s.step = 'req_prod'; s.tempData = { lang }; await ctx.reply(t('ask_prod', lang)); return;
  }
  if (s.step === 'req_prod') { if (!s.tempData) { clearS(uid); return; } s.tempData.product = sanitize(text, 200); s.step = 'req_cat'; persistS(uid); await ctx.reply(t('ask_cat', s.tempData.lang)); return; }
  if (s.step === 'req_cat') { if (!s.tempData) { clearS(uid); return; } s.tempData.category = sanitize(text, 100); s.step = 'req_spec'; persistS(uid); await ctx.reply(t('ask_spec', s.tempData.lang)); return; }
  if (s.step === 'req_spec') { if (!s.tempData) { clearS(uid); return; } s.tempData.specification = skip(text) ? '' : sanitize(text, 500); s.step = 'req_qty'; persistS(uid); await ctx.reply(t('ask_qty', s.tempData.lang)); return; }
  if (s.step === 'req_qty') {
    if (!s.tempData) { clearS(uid); return; }
    if (isNaN(Number(text)) || Number(text) <= 0) { await ctx.reply(t('no_qty_number', s.tempData.lang)); return; }
    s.tempData.quantity = text; s.step = 'req_unit'; await ctx.reply(t('ask_unit', s.tempData.lang), unitKb(s.tempData.lang)); return;
  }
  if (s.step === 'req_city') { if (!s.tempData) { clearS(uid); return; } s.tempData.city = text; s.step = 'req_addr'; await ctx.reply(t('ask_addr', s.tempData.lang)); return; }
  if (s.step === 'req_addr') { if (!s.tempData) { clearS(uid); return; } s.tempData.deliveryAddress = text; s.step = 'req_phone'; await ctx.reply(t('ask_phone', s.tempData.lang)); return; }
  if (s.step === 'req_phone') {
    if (!s.tempData) { clearS(uid); return; }
    if (!isValidPhone(text)) { await ctx.reply(t('bad_phone', s.tempData.lang)); return; }
    s.tempData.phone = text; s.step = 'req_date'; await ctx.reply(t('ask_date', s.tempData.lang)); return;
  }
  if (s.step === 'req_date') { if (!s.tempData) { clearS(uid); return; } s.tempData.requiredDate = skip(text) ? '' : text; s.step = 'req_notes'; await ctx.reply(t('ask_notes', s.tempData.lang)); return; }
  if (s.step === 'req_notes') {
    if (!isSt(user) || !s.tempData) { clearS(uid); await ctx.reply(t('expired', lang)); return; }
    const d = s.tempData;
    if (isDuplicateReq(uid, d.product, d.quantity, d.city)) { await ctx.reply(t('dup_req_smart', d.lang)); clearS(uid); return; }
    const req: Request = { id: genId(), storeId: uid, storeName: user.storeName, storePhone: d.phone, storeUsername: ctx.from.username, product: d.product, category: d.category, specification: d.specification, quantity: d.quantity, unitType: d.unitType, city: d.city, deliveryAddress: d.deliveryAddress, requiredDate: d.requiredDate, additionalNotes: skip(text) ? '' : text, createdAt: new Date().toISOString(), status: 'active', offers: [], statusHistory: [{ status: 'active', at: new Date().toISOString() }] };
    repos.requests.save(req); clearS(uid);
    await ctx.reply(t('req_done', d.lang), storeKb(d.lang));
    const reqCatL = req.category.toLowerCase();
    for (const supplier of repos.users.findApprovedActiveSuppliers()) {
      if (supplier.categories.length > 0) {
        const match = supplier.categories.some(c => { const cl = c.toLowerCase(); return cl === reqCatL || reqCatL.includes(cl) || cl.includes(reqCatL); });
        if (!match) continue;
      }
      const sL = supplier.lang;
      await bot.telegram.sendMessage(supplier.id,
        `${t('new_req_title', sL)}\n\n🏪 *${md(req.storeName)}*${req.storeUsername ? md(' (@' + req.storeUsername + ')') : ''}\n📞 ${md(req.storePhone)}\n\n📦 *${md(req.product)}* (${md(req.category)})\n📊 ${req.quantity} ${req.unitType}\n📍 ${req.city}\n📅 ${req.requiredDate || '—'}\n📝 ${req.additionalNotes || '—'}`,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback(t('send_offer_btn', sL), `start_offer_${req.id}`), Markup.button.callback(t('skip_req_btn', sL), `skip_req_${req.id}`)]]) }
      ).catch(() => { });
    }
    await bot.telegram.sendMessage(ADMIN_ID, `📋 Новая заявка: ${req.product} | ${req.city} | ${user.storeName}`).catch(() => { }); return;
  }

  // ── My Requests ───────────────────────────────────────────────────────────
  if (isCmd(text, 'my_reqs')) {
    if (!isSt(user)) return;
    const myReqs = repos.requests.findByStore(uid);
    const a = myReqs.filter(r => ['active', 'offer_received', 'accepted', 'delivered'].includes(r.status)).length;
    const c = myReqs.filter(r => r.status === 'completed').length;
    const x = myReqs.filter(r => r.status === 'cancelled').length;
    const pur = repos.deals.findByStoreId(uid).length;
    const l2 = pur > 0 ? `\n${t('my_deals_label', lang)}: ${pur}` : '';
    await ctx.reply(`📂 *${t('my_reqs', lang)}*\n🟢 ${a} | ✅ ${c} | ❌ ${x}${l2}`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback(`🟢 (${a})`, 'my_active'), Markup.button.callback(`✅ (${c})`, 'my_completed'), Markup.button.callback(`❌ (${x})`, 'my_cancelled')]]) }); return;
  }

  // ── Supplier: Buyer Requests ──────────────────────────────────────────────
  if (isCmd(text, 'buyer_reqs')) {
    if (!isSup(user)) return;
    if (!isAct(user)) { await ctx.reply(t('not_active', lang)); return; }
    const myDeals = repos.requests.findAll().filter(r => ['accepted', 'delivered'].includes(r.status) && r.acceptedOfferId && r.offers.some(o => o.id === r.acceptedOfferId && o.supplierId === uid));
    if (myDeals.length) {
      await ctx.reply(`${t('active_deals', lang)} (${myDeals.length}):`, { parse_mode: 'Markdown' });
      for (const req of myDeals.slice(-5)) {
        const btns: any[][] = req.status === 'accepted' ? [[Markup.button.callback(t('mark_delivered_btn', lang), `mark_delivered_${req.id}`)]] : [[Markup.button.callback(t('waiting_confirm', lang), `noop_${req.id}`)]];
        await ctx.reply(`📦 *${md(req.product)}* | ${req.quantity} ${req.unitType}\n🏪 ${md(req.storeName)} | ${reqStatusLabel(req.status, lang)}`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(btns) });
      }
    }
    const open = repos.requests.findOpen();
    if (!open.length) { await ctx.reply(t('no_reqs', lang)); return; }
    await ctx.reply(`📋 *${open.length}*`, { parse_mode: 'Markdown' });
    for (const req of open.slice(-10)) {
      const mine = req.offers.some(o => o.supplierId === uid);
      const pending = req.offers.filter(o => o.status === 'pending').length;
      const btns = mine
        ? Markup.inlineKeyboard([[Markup.button.callback(t('mkt_btn', lang), `my_mkt_${req.id}`)]])
        : Markup.inlineKeyboard([[Markup.button.callback(t('send_offer_btn', lang), `start_offer_${req.id}`), Markup.button.callback(t('skip_req_btn', lang), `skip_req_${req.id}`)]]);
      await ctx.reply(
        `📦 *${md(req.product)}* (${md(req.category)})\n📊 ${req.quantity} ${req.unitType} | 📍 ${req.city}\n🏪 *${md(req.storeName)}*${req.storeUsername ? md(' (@' + req.storeUsername + ')') : ''}\n📞 ${req.storePhone}\n📅 ${req.requiredDate || '—'}\n📝 ${req.additionalNotes || '—'}\n💬 ${pending}`,
        { parse_mode: 'Markdown', ...btns }
      );
    }
    return;
  }

  // ── Supplier: My Products ─────────────────────────────────────────────────
  if (isCmd(text, 'my_prods')) {
    if (!isSup(user)) return; if (!isAct(user)) { await ctx.reply(t('not_active', lang)); return; }
    const active = getActiveProds(uid); const limit = getProductLimit(user);
    const archived = repos.products.findBySupplierId(uid, true).filter(p => p.archived).length;
    await ctx.reply(`📦 *${t('active_prods_label', lang)}: ${active}/${limit === Infinity ? '∞' : limit}  ${t('archived_prods_label', lang)}: ${archived}*`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('➕ Добавить', 'add_product'), Markup.button.callback('📋 Активные', 'view_my_products')],
        ...(archived > 0 ? [[Markup.button.callback(t('my_archived_btn', lang), 'view_archived_prods')]] : []),
      ]),
    }); return;
  }

  if (isCmd(text, 'add_prod')) {
    if (!isAct(user)) { await ctx.reply(t('not_active', lang)); return; }
    const active = getActiveProds(uid); const limit = getProductLimit(user as SupplierUser);
    if (active >= limit) { await ctx.reply(t('limit_prods', lang)); return; }
    s.step = 'prod_name'; s.tempData = { lang, photos: [] }; await ctx.reply(t('p_name', lang)); return;
  }

  // ── Supplier: Profile ─────────────────────────────────────────────────────
  if (isCmd(text, 'profile')) {
    if (!isSup(user)) return;
    const deals = repos.deals.countBySupplierId(uid);
    const prods = getActiveProds(uid); const limit = getProductLimit(user);
    await ctx.reply(
      `👤 *${md(user.companyName)}*\n👤 ${md(user.contactPerson)}\n📞 ${md(user.phone)}\n📍 ${md(user.city)}\n💬 ${user.username ? md('@' + user.username) : '—'}\n📝 ${md(user.businessDescription)}\n` +
      (user.categories.length ? `📁 ${user.categories.join(', ')}\n` : '') +
      `\n${user.approved ? '✅ Одобрен' : '⏳ Ожидает'} | ${t('tier_label', lang)}: ${t(`tier_${user.tier}` as TKey, lang)}\n\n━━━━━━━━━━━━\n` +
      `${t('completed_deals_lbl', lang)}: *${deals}*\n${t('products_listed_lbl', lang)}: *${prods}/${limit === Infinity ? '∞' : limit}*\n${t('member_since_lbl', lang)}: ${fmtD(user.registeredAt)}` +
      (user.isPro ? `\n\n⭐ *PRO Подписка* активна до ${fmtD(user.proUntil ?? '')}` : ''),
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
          [Markup.button.callback(t('edit_cats_btn', lang), 'edit_cats_action')],
          ...(user.isPro ? [] : [[Markup.button.callback('⭐ Купить PRO (42,000 UZS)', 'buy_pro')]])
      ]) }
    ); return;
  }

  // ── Dashboard ─────────────────────────────────────────────────────────────
  if (isCmd(text, 'dashboard')) {
    if (!isSup(user)) return; if (!isAct(user)) { await ctx.reply(t('not_active', lang)); return; }
    const sortBy = 'views';
    const mine = sortProds(repos.products.findBySupplierId(uid, false), sortBy);
    await ctx.reply(buildDashText(mine, user, lang, sortBy), { parse_mode: 'Markdown', ...buildDashKb(lang, sortBy) }); return;
  }

  // ── Help ──────────────────────────────────────────────────────────────────
  if (isCmd(text, 'help')) {
    if (isSt(user)) await ctx.reply(`📖 *Помощь — Магазин*\n\n🔍 Каталог — просматривайте товары\n📝 Создать заявку — запрос (макс. ${MAX_ACTIVE_REQS})\n📋 Мои заявки — конкурс предложений, статус\n⭐ Избранное — сохранённые товары`, { parse_mode: 'Markdown' });
    if (isSup(user)) await ctx.reply(`📖 *Помощь — Поставщик*\n\n📥 Заявки — конкурс, ваша позиция\n📦 Мои товары — каталог (макс. ${getProductLimit(user)})\n📊 Аналитика — статистика просмотров\n✏️ Улучшить предложение — обновить цену`, { parse_mode: 'Markdown' });
    return;
  }

  // ── Offer Flow ────────────────────────────────────────────────────────────
  if (s.step === 'offer_price') {
    if (!isAct(user) || !s.tempData) { clearS(uid); await ctx.reply(t('expired', lang)); return; }
    s.tempData.price = text; s.step = 'offer_del'; await ctx.reply(t('ask_del', s.tempData.lang), ynKb('offer_del_yes', 'offer_del_no', s.tempData.lang)); return;
  }
  if (s.step === 'offer_eta') {
    if (!isAct(user) || !s.tempData) { clearS(uid); await ctx.reply(t('expired', lang)); return; }
    s.tempData.estimatedDelivery = text; s.step = 'offer_cmt'; await ctx.reply(t('ask_cmt', s.tempData.lang)); return;
  }
  if (s.step === 'offer_cmt') {
    if (!isAct(user) || !s.tempData) { clearS(uid); await ctx.reply(t('expired', lang)); return; }
    const d = s.tempData; const sup = user as SupplierUser;
    const req = repos.requests.findById(d.requestId);
    if (!req || !canModReq(req.status)) { clearS(uid); await ctx.reply(t('req_closed', d.lang)); return; }
    if (req.offers.some(o => o.supplierId === uid)) { clearS(uid); await ctx.reply(t('already_replied', d.lang)); return; }
    const offer: Offer = { id: genId(), supplierId: uid, supplierName: sup.companyName, supplierPhone: sup.phone, supplierUsername: ctx.from.username, price: d.price, deliveryAvailable: d.deliveryAvailable, priceNegotiable: d.priceNegotiable, estimatedDelivery: d.estimatedDelivery, comment: skip(text) ? '' : text, status: 'pending', createdAt: new Date().toISOString() };
    req.offers.push(offer);
    const supProds = repos.products.findBySupplierId(uid, false);
    const matchingProd = supProds.find(p => p.name.toLowerCase() === req.product.toLowerCase()) ?? supProds[0];
    if (matchingProd) repos.products.incrementOfferResponses(matchingProd.id);
    if (req.status === 'active') { req.status = 'offer_received'; req.statusHistory = req.statusHistory ?? []; req.statusHistory.push({ status: 'offer_received', at: new Date().toISOString() }); }
    repos.requests.save(req);
    clearS(uid);
    await ctx.reply(t('offer_sent', d.lang), supKb(d.lang));
    // M2: Show market position after submission
    const mktText = buildMarketStats(req, uid, d.lang);
    if (req.offers.filter(o => o.status === 'pending').length > 1) {
      await ctx.reply(mktText, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback(t('mkt_improve', d.lang), `upd_offer_${req.id}`)]]) });
    }
    const stL = getLang(repos.users.findById(req.storeId));
    await bot.telegram.sendMessage(req.storeId,
      `💬 Новое предложение по *${md(req.product)}*!\n\n🏢 *${md(sup.companyName)}* ✅\n📞 ${md(sup.phone)}\n💬 ${sup.username ? md('@' + sup.username) : '—'}\n💰 ${md(offer.price)}\n🚚 ${offer.deliveryAvailable ? t('delivery_yes', stL) : t('delivery_no', stL)}\n💬 ${offer.priceNegotiable ? t('price_neg_label', stL) : t('price_fixed_label', stL)}\n📅 ${md(offer.estimatedDelivery)}\n📝 ${md(offer.comment || '—')}\n\nПросмотреть: /req_${req.id}`,
      { parse_mode: 'Markdown' }
    ).catch(() => { });
    await bot.telegram.sendMessage(ADMIN_ID, `💬 ${sup.companyName} → "${req.product}" (${req.storeName})`).catch(() => { }); return;
  }

  // ── M3: Offer Update Flow ─────────────────────────────────────────────────
  if (s.step === 'upd_price') {
    if (!isAct(user) || !s.tempData) { clearS(uid); return; }
    const { reqId, offerId, lang: l, currentEta } = s.tempData;
    if (!skip(text)) {
      const req = repos.requests.findById(reqId);
      const offer = req?.offers.find(o => o.id === offerId && o.supplierId === uid);
      if (offer && req) {
        repos.requests.updateOffer(offerId, { price: text });
        const stL = getLang(repos.users.findById(req.storeId));
        await bot.telegram.sendMessage(req.storeId, `${t('upd_notif_store', stL)}\n\n🏢 ${md((user as SupplierUser).companyName)}\n📦 ${req.product}\n💰 ${md(text)}`, { parse_mode: 'Markdown' }).catch(() => { });
      }
    }
    s.step = 'upd_eta'; await ctx.reply(`${t('upd_ask_eta', l)}\n\n*Текущий: ${md(currentEta)}*`, { parse_mode: 'Markdown' }); return;
  }
  if (s.step === 'upd_eta') {
    if (!isAct(user) || !s.tempData) { clearS(uid); return; }
    const { reqId, offerId, lang: l } = s.tempData;
    if (!skip(text) && text !== '/skip') {
      const req = repos.requests.findById(reqId);
      const offer = req?.offers.find(o => o.id === offerId && o.supplierId === uid);
      if (offer) repos.requests.updateOffer(offerId, { estimatedDelivery: text });
    }
    clearS(uid); await ctx.reply(t('upd_done', l), supKb(l)); return;
  }

  // ── F3: Product Edit Field Handlers ──────────────────────────────────────
  if (s.step && s.step.startsWith('edit_prod_') && s.tempData?.editProdId) {
    const field = s.step.replace('edit_prod_', '');
    const fm: Record<string, keyof Product> = { name: 'name', cat: 'category', desc: 'description', price: 'price', moq: 'minOrderQty', avail: 'availabilityStatus', city: 'city' };
    if (fm[field]) {
      const p2 = repos.products.findById(s.tempData!.editProdId);
      if (p2 && p2.supplierId === uid) { (p2 as any)[fm[field]] = text; repos.products.save(p2); }
      clearS(uid); await ctx.reply(t('prod_updated', lang), supKb(lang)); return;
    }
    if (field === 'photos' && text === '/done') {
      const p2 = repos.products.findById(s.tempData!.editProdId);
      if (p2 && p2.supplierId === uid) { p2.photos = (s.tempData!.photos || []).filter(Boolean).slice(0, 5); repos.products.save(p2); }
      clearS(uid); await ctx.reply(t('prod_updated', lang), supKb(lang)); return;
    }
    if (field === 'photos') return;
  }

  // ── Product Add Flow ──────────────────────────────────────────────────────
  if (s.step === 'prod_name') { if (!isAct(user) || !s.tempData) { clearS(uid); return; } s.tempData.name = sanitize(text, 200); s.step = 'prod_cat'; persistS(uid); await ctx.reply(t('p_cat', s.tempData.lang)); return; }
  if (s.step === 'prod_cat') { if (!isAct(user) || !s.tempData) { clearS(uid); return; } s.tempData.category = sanitize(text, 100); s.step = 'prod_desc'; persistS(uid); await ctx.reply(t('p_desc', s.tempData.lang)); return; }
  if (s.step === 'prod_desc') { if (!isAct(user) || !s.tempData) { clearS(uid); return; } s.tempData.description = sanitize(text, 1000); s.step = 'prod_wv'; persistS(uid); await ctx.reply(t('p_wv', s.tempData.lang)); return; }
  if (s.step === 'prod_wv') { if (!isAct(user) || !s.tempData) { clearS(uid); return; } s.tempData.weightVolume = sanitize(text, 100); s.step = 'prod_upb'; persistS(uid); await ctx.reply(t('p_upb', s.tempData.lang)); return; }
  if (s.step === 'prod_upb') { if (!isAct(user) || !s.tempData) { clearS(uid); return; } s.tempData.unitsPerBox = sanitize(text, 50); s.step = 'prod_moq'; persistS(uid); await ctx.reply(t('p_moq', s.tempData.lang)); return; }
  if (s.step === 'prod_moq') { if (!isAct(user) || !s.tempData) { clearS(uid); return; } s.tempData.minOrderQty = sanitize(text, 50); s.step = 'prod_price'; persistS(uid); await ctx.reply(t('p_price', s.tempData.lang)); return; }
  if (s.step === 'prod_price') { if (!isAct(user) || !s.tempData) { clearS(uid); return; } s.tempData.price = sanitize(text, 100); s.step = 'prod_neg'; persistS(uid); await ctx.reply(t('ask_neg', s.tempData.lang), ynKb('prod_neg_yes', 'prod_neg_no', s.tempData.lang)); return; }
  if (s.step === 'prod_city') { if (!isAct(user) || !s.tempData) { clearS(uid); return; } s.tempData.city = sanitize(text, 100); s.step = 'prod_avail'; persistS(uid); await ctx.reply(t('p_avail', s.tempData.lang)); return; }
  if (s.step === 'prod_avail') { if (!isAct(user) || !s.tempData) { clearS(uid); return; } s.tempData.availabilityStatus = sanitize(text, 100); s.step = 'prod_photos'; if (!s.tempData.photos) s.tempData.photos = []; persistS(uid); await ctx.reply(t('p_photos', s.tempData.lang)); return; }
  if (s.step === 'prod_photos' && text === '/done') {
    if (!isAct(user) || !s.tempData) { clearS(uid); return; }
    const d = s.tempData; const sup = user as SupplierUser;
    const prod: Product = { id: genId(), supplierId: uid, supplierName: sup.companyName, supplierPhone: sup.phone, supplierUsername: ctx.from.username, name: d.name, category: d.category, description: d.description, weightVolume: d.weightVolume, unitsPerBox: d.unitsPerBox, minOrderQty: d.minOrderQty, price: d.price, priceNegotiable: d.priceNegotiable, deliveryAvailable: d.deliveryAvailable, city: d.city, availabilityStatus: d.availabilityStatus, photos: (d.photos || []).filter(Boolean).slice(0, 5), viewCount: 0, createdAt: new Date().toISOString(), archived: false, contactClicks: 0, offerResponses: 0, completedDeals: 0 };
    repos.products.save(prod); clearS(uid);
    await ctx.reply(`${t('p_added', d.lang)}\n\n📦 *${md(prod.name)}*\n💰 ${md(prod.price)}`, { parse_mode: 'Markdown', ...supKb(d.lang) });
    await bot.telegram.sendMessage(ADMIN_ID, `🛍 Новый товар: ${prod.name} от ${sup.companyName}`).catch(() => { }); return;
  }

  // ── Admin Panel ───────────────────────────────────────────────────────────
  if (isAdmin(uid)) {
    if (text === TR.ru.stats) {
      const stats = buildAdminAnalytics(repos.db);
      await ctx.reply(formatAdminStats(stats), { parse_mode: 'Markdown' }); return;
    }
    if (text === TR.ru.all_reqs) {
      const recent = repos.requests.findRecent(10); if (!recent.length) { await ctx.reply('Нет.'); return; }
      for (const r of recent) { const icon = canModReq(r.status) ? '🟢' : r.status === 'accepted' ? '🤝' : r.status === 'delivered' ? '🚚' : r.status === 'completed' ? '✅' : '❌'; await ctx.reply(`${icon} *${md(r.product)}*\n${r.quantity} ${r.unitType} | ${r.city}\n${r.storeName} | ${r.offers.length} предл.`, { parse_mode: 'Markdown' }); }
      return;
    }
    if (text === TR.ru.sups) {
      const sups = repos.users.findSuppliers(); if (!sups.length) { await ctx.reply('Нет.'); return; }
      for (const sup of sups) {
        const deals = repos.deals.countBySupplierId(sup.id);
        const btns = sup.approved ? [[Markup.button.callback(sup.suspended ? '✅ Восст.' : '⛔ Пауза', `admin_suspend_${sup.id}`), Markup.button.callback('⭐ Upgrade', `admin_tier_premium_${sup.id}`)]] : [[Markup.button.callback('✅ Принять', `sup_accept_${sup.id}`), Markup.button.callback('❌ Отклонить', `sup_reject_${sup.id}`)]];
        await ctx.reply(`🏢 *${md(sup.companyName)}*\n📞 ${md(sup.phone)} | 📍 ${md(sup.city)}\n${sup.approved ? '✅' : '⏳'} | ${sup.suspended ? '⛔' : '🟢'} | ${t(`tier_${sup.tier}` as TKey, 'ru')} | 🎯 ${deals}${sup.categories.length ? `\n📁 ${sup.categories.join(', ')}` : ''}`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(btns) });
      }
      return;
    }
    if (text === TR.ru.prods) {
      const uid = ctx.from!.id; const s = getS(uid);
      s.catalog = { role: 'admin', category: 'All', page: 0, cursors: [null] };
      persistS(uid);
      await buildCatalogPage(ctx, uid, false);
      return;
    }
    // Broadcast button: show target selection
    if (text === TR.ru.broadcast_btn) {
      await ctx.reply(t('broadcast_target', 'ru'), Markup.inlineKeyboard([
        [Markup.button.callback(t('broadcast_target_all', 'ru'), 'broadcast_all')],
        [Markup.button.callback(t('broadcast_target_stores', 'ru'), 'broadcast_stores')],
        [Markup.button.callback(t('broadcast_target_sups', 'ru'), 'broadcast_sups')],
      ]));
      return;
    }
  }

  // Broadcast message collection (admin only, outside admin block to catch step)
  if (s.step === 'bc_msg' && isAdmin(uid)) {
    if (!s.tempData) { clearS(uid); return; }
    // Rate limit: max 3 broadcasts per hour via SpamGuard
    const check = spam.checkBroadcast(uid);
    if (!check.ok) {
      clearS(uid);
      await ctx.reply(t('broadcast_limited', 'ru'));
      return;
    }
    const bcTarget = s.tempData.bcTarget;
    const allUsers = repos.users.findAll();
    let targets: User[];
    if (bcTarget === 'stores') targets = allUsers.filter(isSt);
    else if (bcTarget === 'suppliers') targets = allUsers.filter(isSup);
    else targets = allUsers;

    let sent = 0;
    for (const u of targets) {
      try {
        await bot.telegram.sendMessage(u.id, text);
        sent++;
      } catch {}
    }
    clearS(uid);
    await ctx.reply(`${t('broadcast_sent', 'ru')} ${sent}/${targets.length}`);
    return;
  }
});

bot.action('buy_pro', async ctx => {
    const uid = ctx.from!.id;
    const txId = Date.now().toString(36) + Math.random().toString(36).substring(2, 7);
    repos.transactions.create({
        id: txId + '_tmp', mivraTxId: txId, userId: uid,
        type: 'PRO', amount: 4200000, status: 'pending',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    });

    const url = buildCheckoutUrl({ mivraTxId: txId, amountTiyins: 4200000 });
    await ctx.answerCbQuery();

    if (!url) {
      await ctx.reply('⭐ *PRO оформлен* — ожидаем настройки платёжного терминала\. Обратитесь к администратору\.',
        { parse_mode: 'MarkdownV2' });
      return;
    }

    await ctx.reply(`⭐ *Подписка PRO* (на 30 дней)\n\nСтоимость: 42,000 UZS\n\n• Приоритет в поиске\n• Больше лимитов товаров\n• Автоматическое продвижение`, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.url('Оплатить (Payme)', url)]])
    });
});


// ─── PHOTO HANDLER ────────────────────────────────────────────────────────────

bot.on(message('photo'), async ctx => {
  const uid = ctx.from.id; const s = getS(uid);
  const isEdit = s.step?.startsWith('edit_prod_photos') || s.step === 'edit_prod_photos';
  const isAdd = s.step === 'prod_photos';
  if ((!isAdd && !isEdit) || !s.tempData) return;
  if (!isAct(repos.users.findById(uid))) { clearS(uid); return; }
  s.tempData.photos ??= [];
  if (s.tempData.photos.length >= 5) { await ctx.reply('Максимум 5. /done'); return; }
  s.tempData.photos.push(ctx.message.photo[ctx.message.photo.length - 1].file_id);
  await ctx.reply(`📸 ${s.tempData.photos.length}/5 — ещё или /done`);
});

// ─── BROADCAST HANDLER ──────────────────────────────────────────────────────

bot.action('broadcast_all', async ctx => {
  if (!isAdmin(ctx.from?.id)) { await ctx.answerCbQuery(); return; }
  const s = getS(ctx.from!.id); s.step = 'bc_msg'; s.tempData = { bcTarget: 'all' };
  await ctx.answerCbQuery(); await ctx.reply(t('broadcast_ask_msg', 'ru'));
});
bot.action('broadcast_stores', async ctx => {
  if (!isAdmin(ctx.from?.id)) { await ctx.answerCbQuery(); return; }
  const s = getS(ctx.from!.id); s.step = 'bc_msg'; s.tempData = { bcTarget: 'stores' };
  await ctx.answerCbQuery(); await ctx.reply(t('broadcast_ask_msg', 'ru'));
});
bot.action('broadcast_sups', async ctx => {
  if (!isAdmin(ctx.from?.id)) { await ctx.answerCbQuery(); return; }
  const s = getS(ctx.from!.id); s.step = 'bc_msg'; s.tempData = { bcTarget: 'suppliers' };
  await ctx.answerCbQuery(); await ctx.reply(t('broadcast_ask_msg', 'ru'));
});

// ─── LAUNCH ───────────────────────────────────────────────────────────────────

bot.catch((err: unknown, ctx: any) => {
  const msg = err instanceof Error ? err.message : String(err);
  const updateType = ctx?.updateType ?? 'unknown';
  logger.error('BOT', `Unhandled error in ${updateType}`, { error: msg });
  // Notify admin
  bot.telegram.sendMessage(ADMIN_ID, `⚠️ *Bot error*\n\`${updateType}\`\n${msg.slice(0, 300)}`, { parse_mode: 'Markdown' }).catch(() => {});
  try { ctx?.reply?.('⚠️ Произошла ошибка. Попробуйте позже.').catch(() => {}); } catch {}
});
initRepos();
bot.launch();
startPaycomServer(repos, 3000);
logger.info('BOT', 'MIVRA v6.2 started', { env: process.env.NODE_ENV ?? 'development' });
process.once('SIGINT',  () => { closeDb(); bot.stop('SIGINT'); });
process.once('SIGTERM', () => { closeDb(); bot.stop('SIGTERM'); });

// ─── ADMIN: REFUND COMMAND ─────────────────────────────────────────────────────
// Usage: /refund <paycomTxId> <reason...>
// Explicitly revokes PRO/FEATURED and marks refund in DB.
// Admin-only. Separate from Paycom CancelTransaction.

bot.command('refund', async ctx => {
  if (!isAdmin(ctx.from?.id)) return;
  const parts = ctx.message.text.split(' ');
  // /refund [--no-revoke] <txId> <reason...>
  let revokeService = true;
  let argStart = 1;
  if (parts[1] === '--no-revoke') { revokeService = false; argStart = 2; }

  const txId  = parts[argStart];
  const reason = parts.slice(argStart + 1).join(' ');

  if (!txId || !reason) {
    await ctx.reply('Usage: /refund [--no-revoke] <paycomTxId> <reason>');
    return;
  }

  const tx = repos.transactions.findById(txId);
  if (!tx) { await ctx.reply(`❌ Transaction not found: ${txId}`); return; }

  if (tx.status !== 'completed') {
    await ctx.reply(`❌ Can only refund completed transactions. Status: ${tx.status}`);
    return;
  }

  const existingRefunds = repos.refunds.findByTransaction(txId);
  if (existingRefunds.some(r => r.status === 'completed')) {
    await ctx.reply(`⚠️ Refund already completed for this transaction.`);
    return;
  }

  const refundId = Date.now().toString(36) + '_refund';
  repos.refunds.create({
    id: refundId, transactionId: txId, adminId: ctx.from!.id,
    reason, amount: tx.amount, revokeService,
    status: 'pending', createdAt: new Date().toISOString(),
  });

  // Revoke service if requested
  if (revokeService) {
    if (tx.type === 'PRO') {
      const user = repos.users.findById(tx.userId);
      if (user) {
        user.isPro = false;
        user.proUntil = undefined;
        repos.users.save(user);
        logger.info('REFUND', `PRO revoked for user ${tx.userId}`, { refundId, txId, reason });
      }
    } else if (tx.type === 'FEATURED' && tx.productId) {
      const product = repos.products.findById(tx.productId);
      if (product) {
        product.isFeatured = false;
        product.featuredUntil = undefined;
        repos.products.save(product);
        logger.info('REFUND', `FEATURED revoked for product ${tx.productId}`, { refundId, txId, reason });
      }
    }
  }

  repos.refunds.complete(refundId);
  logger.info('REFUND', 'Admin refund processed', { refundId, txId, adminId: ctx.from!.id, revokeService, reason });

  const label = tx.type === 'PRO' ? 'PRO подписка' : 'Featured буст';
  await ctx.reply(
    `✅ *Refund обработан*\n\n` +
    `TX: \`${txId}\`\n` +
    `Тип: ${label}\n` +
    `Сумма: ${(tx.amount / 100).toLocaleString()} UZS\n` +
    `Сервис отозван: ${revokeService ? 'Да' : 'Нет'}\n` +
    `Причина: ${reason}`,
    { parse_mode: 'Markdown' }
  );
});

// /refunds — list recent refunds (admin only)
bot.command('refunds', async ctx => {
  if (!isAdmin(ctx.from?.id)) return;
  const list = repos.refunds.findAll(20);
  if (!list.length) { await ctx.reply('Нет рефандов.'); return; }
  const lines = list.map(r =>
    `• \`${r.id}\` | tx=\`${r.transactionId.slice(0, 10)}\` | ${r.status} | ${r.reason.slice(0, 40)}`
  ).join('\n');
  await ctx.reply(`*Последние рефанды (${list.length}):*\n${lines}`, { parse_mode: 'Markdown' });
});