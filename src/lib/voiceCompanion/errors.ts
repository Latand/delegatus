import type { Locale } from "./contract";

/** Every failure the companion says, in English and Ukrainian. The product is named in Latin letters in both. */
export const COMPANION_MESSAGES = {
  NO_KEY: ["Add an OpenAI key in settings to start voice.", "Додайте ключ OpenAI у налаштуваннях, щоб почати голосову розмову."],
  KEY_FROM_ENV: ["The key comes from OPENAI_API_KEY. Change it in the environment.", "Ключ задано через OPENAI_API_KEY. Змініть його в оточенні."],
  CAP_REACHED: ["The monthly voice spend cap has been reached.", "Досягнуто місячної межі витрат на голос."],
  MICROPHONE_REFUSED: ["Microphone access was refused. Allow it to start voice.", "Доступ до мікрофона відхилено. Дозвольте його, щоб почати розмову."],
  AUDIO_REFUSED: ["Allow audio playback in the browser to hear Delegatus.", "Дозвольте відтворення звуку в браузері, щоб чути Delegatus."],
  FINALIZATION_INCOMPLETE: ["The call ended without confirmed final usage. Its reserved cost is retained.", "Розмова завершилася без підтвердження підсумкових витрат. Зарезервовану суму збережено."],
  PROVIDER_ERROR: ["The voice provider could not continue. Try starting a new session.", "Голосовий сервіс не зміг продовжити. Спробуйте почати нову розмову."],
  MINT_UNCERTAIN: ["The provider did not confirm whether the last voice session started, so it may still be running and billing. Its cost is kept. Check your OpenAI usage, then allow a new call in Voice Delegatus settings.", "Сервіс не підтвердив, чи почалася попередня голосова розмова, тож вона може ще тривати й коштувати грошей. Її вартість збережено. Перевірте використання в OpenAI, а тоді дозвольте нову розмову в налаштуваннях Голосового Delegatus."],
  CODEX_LIMIT_REACHED: ["Every Codex account Delegatus can use has reached its plan limit. Voice is back when one resets.", "Усі акаунти Codex, які може взяти Delegatus, вичерпали ліміт плану. Голос повернеться, щойно один із них оновиться."],
  CODEX_LIMIT_ENDED: ["The call ended: its Codex account reached its plan limit. A new call takes an account that still has room.", "Розмову завершено: акаунт Codex вичерпав ліміт плану. Нова розмова візьме акаунт, у якого ще є запас."],
  NO_CODEX_ACCOUNT: ["No Codex account that Delegatus manages is signed in. Add one in Codex accounts to start voice.", "Немає жодного акаунта Codex, яким керує Delegatus. Додайте його в «Акаунтах Codex», щоб почати розмову."],
  CODEX_AUTH_REQUIRED: ["The Codex account is not signed in with ChatGPT. Sign in to it again in Codex accounts.", "Акаунт Codex не ввійшов через ChatGPT. Увійдіть у нього знову в «Акаунтах Codex»."],
  CODEX_UNSUPPORTED: ["This Codex version cannot run the voice. Update Codex and try again.", "Ця версія Codex не підтримує голос. Оновіть Codex і спробуйте ще раз."],
  no_orchestrator: ["This project has no designated orchestrator.", "У цьому проєкті немає призначеного оркестратора."],
  DELIVERY_FAILED: ["The delivery failed. Nothing reached the orchestrator.", "Доставка не вдалася. Оркестратор нічого не отримав."],
  DELIVERY_UNCONFIRMED: ["Delivery is unconfirmed. Recover the original send before retrying.", "Доставку не підтверджено. Перевірте початкове надсилання перед повтором."],
  SEND_UNCONFIRMED: ["Delivery is not confirmed. Tap Send again to check it: the request goes out once.", "Доставку не підтверджено. Натисніть «Надіслати» ще раз для перевірки: запит піде один раз."],
  REPLY_PENDING: ["Waiting for an orchestrator reply tied to this request.", "Чекаємо на відповідь оркестратора, пов’язану з цим запитом."],
  INPUT_UNPROVEN: ["Finish the request before confirming a delegation.", "Завершіть запит, перш ніж підтверджувати делегацію."],
  INVALID_KEY: ["That does not look like an API key. Paste it again.", "Це не схоже на ключ API. Вставте його ще раз."],
  INVALID_SETTINGS: ["That value cannot be saved.", "Це значення не вдається зберегти."],
  NO_PROJECT: ["Open a project to talk about its work.", "Відкрийте проєкт, щоб говорити про його роботу."],
  COMPANION_UNAVAILABLE: ["Voice Delegatus is unavailable. Try again.", "Голосовий Delegatus недоступний. Спробуйте ще раз."],
  CONTEXT_UNCONFIRMED: ["The selected project is not confirmed yet. Your microphone is paused while Delegatus retries.", "Вибраний проєкт ще не підтверджено. Мікрофон призупинено, поки Delegatus повторює запит."],
} as const;
/** When a plan window resets: the time within a day, the date after that. */
export function limitResetText(resetsAt: number, locale: Locale, now = Date.now()): string {
  return new Intl.DateTimeFormat(locale, resetsAt * 1000 - now < 86_400_000 ? { hour: "2-digit", minute: "2-digit" }
    : { day: "numeric", month: "short" }).format(new Date(resetsAt * 1000));
}
export function companionErrorMessage(code: string, locale: Locale, detail: { resetsAt?: number | null; now?: number } = {}): string {
  if (code === "CODEX_LIMIT_REACHED" && typeof detail.resetsAt === "number") {
    const time = limitResetText(detail.resetsAt, locale, detail.now);
    return locale === "uk" ? `Усі акаунти Codex, які може взяти Delegatus, вичерпали ліміт плану. Найближче оновлення: ${time}.`
      : `Every Codex account Delegatus can use has reached its plan limit. The first one resets: ${time}.`;
  }
  if (code.startsWith("DELIVERY_REFUSED:")) {
    const reason = code.slice("DELIVERY_REFUSED:".length).replaceAll("_", " ").toLowerCase();
    return locale === "uk" ? `Розмова оркестратора відхилила повідомлення (${reason}). Нічого не надіслано.`
      : `The orchestrator's conversation refused the message (${reason}). Nothing was sent.`;
  }
  return (COMPANION_MESSAGES[code as keyof typeof COMPANION_MESSAGES] ?? COMPANION_MESSAGES.COMPANION_UNAVAILABLE)[locale === "uk" ? 1 : 0];
}
