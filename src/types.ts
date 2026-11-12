export interface AppEnv {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  APP_ENV: string;
  APP_BASE_URL?: string;
  AUDIO_UPLOAD_SECRET: string;
  TELEGRAM_MEDIA_CHAT_ID: string;
}

export interface UserRow {
  telegram_user_id: number;
  chat_id: number;
  first_name: string | null;
  current_lesson: number;
  selected_lesson: number | null;
  start_date: string | null;
  state: string;
  pending_input: string | null;
  pending_json: string | null;
  paused: number;
  completed: number;
  delivery_blocked: number;
  time_zone: string;
  time_zone_confirmed_at_ms: number | null;
  pending_time_zone: string | null;
  pending_time_zone_effective_at_ms: number | null;
  audio_delivery: "on_demand" | "automatic";
  next_lesson_at_ms: number | null;
  next_night_at_ms: number | null;
  last_ephemeral_message_ids_json: string | null;
  ephemeral_generation: number;
}

export interface LessonRow {
  lesson_number: number;
  title_fa: string;
  reminder_fa: string;
  full_text_fa: string;
  text_url_fa: string;
  audio_url_fa: string | null;
  telegram_audio_file_id: string | null;
  telegram_audio_file_unique_id: string | null;
  telegram_audio_duration: number | null;
  telegram_audio_uploading_at_ms: number | null;
  schedule_type: string;
  schedule_options_json: string;
}

export interface DailyRow {
  user_id: number;
  course_date: string;
  lesson_number: number;
  status: string;
  lesson_sent_at_ms: number | null;
  night_question_sent_at_ms: number | null;
  tomorrow_action: "next" | "repeat" | "pause" | "complete" | "restart" | null;
  schedule_kind: string | null;
  schedule_value: string | null;
  schedule_slots_json: string | null;
  audio_sent_at_ms: number | null;
  audio_message_id: number | null;
  studied_at_ms: number | null;
}

export type CourseOption =
  | { kind: "times_per_day"; count: number }
  | { kind: "interval"; minutes: number };

export interface ReminderSlot {
  ordinal: number;
  total: number;
  atMs: number;
  time: string;
}

export interface PendingSchedule {
  date: string;
  lesson: number;
  kind: "count" | "interval" | "custom_times";
  value: string;
  label: string;
  allTimes: string[];
  missedTimes: string[];
  slots: ReminderSlot[];
  needsDenseConfirmation: boolean;
}

export interface TelegramUser {
  id: number;
  first_name: string;
}

export interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  from?: TelegramUser;
  text?: string;
  web_app_data?: { data: string; button_text: string };
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  data?: string;
  message?: TelegramMessage;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface InlineButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineButton[][];
}

export interface ReplyKeyboardMarkup {
  keyboard: Array<Array<{ text: string; web_app?: { url: string } }>>;
  resize_keyboard?: boolean;
  one_time_keyboard?: boolean;
  input_field_placeholder?: string;
}

export interface ReplyKeyboardRemove {
  remove_keyboard: true;
}

export type TelegramReplyMarkup = InlineKeyboardMarkup | ReplyKeyboardMarkup | ReplyKeyboardRemove;
