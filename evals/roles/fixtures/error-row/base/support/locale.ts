// Standalone adapter for the single translation key used by the pinned component.
export function useLocale() { return { t: (_key: string, values: { title: string }) => `Actions: ${values.title}` }; }
