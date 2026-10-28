// The most a lever may be set to from a shared link. The sliders stop at these numbers. A visitor's changes stay in their browser,
// so these are only the slider ranges (the old "send an idea" caps in the database were removed with Suggestions).

export const PLAY_CAPS = { leads: 10000, clients: 100000, price: 10000000, headcount: 500 } as const;
