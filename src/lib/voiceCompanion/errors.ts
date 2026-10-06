import type { Locale } from "./contract";

const messages = {
  NO_KEY: ["Add an OpenAI key in settings to start voice.", "Додайте ключ OpenAI у налаштуваннях, щоб почати голосову розмову."],
  KEY_FROM_ENV: ["The key comes from OPENAI_API_KEY. Change it in the environment.", "Ключ задано через OPENAI_API_KEY. Змініть його в оточенні."],
  CAP_REACHED: ["The monthly voice spend cap has been reached.", "Досягнуто місячної межі витрат на голос."],
  MICROPHONE_REFUSED: ["Microphone access was refused. Allow it to start voice.", "Доступ до мікрофона відхилено. Дозвольте його, щоб почати розмову."],
  AUDIO_REFUSED: ["Allow audio playback in the browser to hear Delegatus.", "Дозвольте відтворення звуку в браузері, щоб чути Делегатуса."],
  FINALIZATION_INCOMPLETE: ["The call ended without confirmed final usage. Its reserved cost is retained.", "Розмова завершилася без підтвердження підсумкових витрат. Зарезервовану суму збережено."],
  PROVIDER_ERROR: ["The voice provider could not continue. Try starting a new session.", "Голосовий сервіс не зміг продовжити. Спробуйте почати нову розмову."],
  no_orchestrator: ["This project has no designated orchestrator.", "У цьому проєкті немає призначеного оркестратора."],
  DELIVERY_UNCONFIRMED: ["Delivery is unconfirmed. Recover the original send before retrying.", "Доставку не підтверджено. Перевірте початкове надсилання перед повтором."],
  SEND_UNCONFIRMED: ["Delivery is not confirmed. Tap Send again to check it: the request goes out once.", "Доставку не підтверджено. Натисніть «Надіслати» ще раз для перевірки: запит піде один раз."],
  REPLY_PENDING: ["Waiting for an orchestrator reply tied to this request.", "Чекаємо на відповідь оркестратора, пов’язану з цим запитом."],
  INPUT_UNPROVEN: ["Finish the request before confirming a delegation.", "Завершіть запит, перш ніж підтверджувати делегацію."],
  INVALID_KEY: ["That does not look like an API key. Paste it again.", "Це не схоже на ключ API. Вставте його ще раз."],
  INVALID_SETTINGS: ["That value cannot be saved.", "Це значення не вдається зберегти."],
  NO_PROJECT: ["Open a project to talk about its work.", "Відкрийте проєкт, щоб говорити про його роботу."],
  COMPANION_UNAVAILABLE: ["Voice Delegatus is unavailable. Try again.", "Голосовий Делегатус недоступний. Спробуйте ще раз."],
} as const;
export function companionErrorMessage(code: string, locale: Locale): string {
  return (messages[code as keyof typeof messages] ?? messages.COMPANION_UNAVAILABLE)[locale === "uk" ? 1 : 0];
}
