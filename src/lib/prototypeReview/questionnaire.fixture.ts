export const questions = [
  { id: "place", text: "Where should this live?", options: [{ label: "Existing review", recommended: true }, { label: "New window" }] },
  { id: "scope", text: "Which surfaces?", multiple: true, options: [{ label: "Desktop", recommended: true }, { label: "Phone" }] },
  { id: "timing", text: "When should work start?", other: true, options: [{ label: "After answering", recommended: true }, { label: "Later" }] },
];
