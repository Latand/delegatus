import type { Locale } from "./contract";

const messages = {
  NO_KEY: ["Add an OpenAI key in settings to start voice.", "Додайте ключ OpenAI у налаштуваннях, щоб почати голосову розмову."],
  KEY_FROM_ENV: ["The key comes from OPENAI_API_KEY. Change it in the environment.", "Ключ задано через OPENAI_API_KEY. Змініть його в оточенні."],
  CAP_REACHED: ["The monthly voice spend cap has been reached.", "Досягнуто місячної межі витрат на голос."],
  MICROPHONE_REFUSED: ["Microphone access was refused. Allow it to start voice.", "Доступ до мікрофона відхилено. Дозвольте його, щоб почати розмову."],
  PROVIDER_ERROR: ["The voice provider could not continue. Try starting a new session.", "Голосовий сервіс не зміг продовжити. Спробуйте почати нову розмову."],
  no_orchestrator: ["This project has no designated orchestrator.", "У цьому проєкті немає призначеного оркестратора."],
  DELIVERY_UNCONFIRMED: ["Delivery is unconfirmed. Recover the original send before retrying.", "Доставку не підтверджено. Перевірте початкове надсилання перед повтором."],
  REPLY_PENDING: ["Waiting for an orchestrator reply tied to this request.", "Чекаємо на відповідь оркестратора, пов’язану з цим запитом."],
  INPUT_UNPROVEN: ["Finish the request before confirming a delegation.", "Завершіть запит, перш ніж підтверджувати делегацію."],
  COMPANION_UNAVAILABLE: ["Voice Delegatus is unavailable. Try again.", "Голосовий Делегатус недоступний. Спробуйте ще раз."],
} as const;
export function companionErrorMessage(code: string, locale: Locale): string {
  return (messages[code as keyof typeof messages] ?? messages.COMPANION_UNAVAILABLE)[locale === "uk" ? 1 : 0];
}
