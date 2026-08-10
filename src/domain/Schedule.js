/**
 * Hotel Career - THE TIMETABLE. Every "what time of day does X happen" lives
 * here, and nowhere else.
 *
 * WHY THIS FILE EXISTS. The operator, after a playtest:
 *
 *   "I want you to refactor the code and modularize it so it can be easy
 *    mantained system by system, and not looking in everything just to fix a
 *    bug with the clock..."
 *
 * They were right, and the evidence was in the bug reports. The hours of the
 * hotel's day had ended up spread across three files: `Clock.js` owned the
 * mapping from elapsed seconds to a clock face, `engine.js` separately decided
 * when guests arrived, when rooms were checked out, when the night shift ran and
 * when a guest's patience started, and `game.js` painted a clock derived from
 * yet another calculation. Fixing "guests are arriving at 3am" meant reading all
 * three and knowing which one was authoritative.
 *
 * So: this module is the authority on the hotel's timetable. Clock.js asks it
 * what hour it is; engine.js asks it when things happen. Neither decides.
 *
 * THE ONE RULE FOR EDITING THIS FILE: an hour named here is an hour a hotelier
 * would recognise. Every constant below came from the operator, and where the
 * game needs something they did not specify it is marked UNVERIFIED with the
 * reasoning. This is a domain file, not a tuning file.
 *
 * Pure, and takes no wall clock - like everything else below `game.js`.
 */

/**
 * THE HOUR EACH DAY STARTS AT.
 *
 * A day is normally the whole twenty-four hours, midnight to midnight, because
 * the operator rejected a compressed day outright: "the day start at 08:00 which
 * is not accurate for 24 hours it must be accurate."
 *
 * DAY 1 IS THE EXCEPTION, and it is the operator's: "make day 1 start from 08:00,
 * and then the time moves normally." You take the keys in the morning. There is
 * no night shift to work before you have arrived, and no guest is checking out at
 * two in the morning of a hotel you do not own yet.
 *
 * So day 1 runs 08:00 to midnight - sixteen hours in its 150 seconds - and every
 * day after it runs the full twenty-four.
 */
export const DAY_START_HOUR = { 1: 8 };

/** The hours this day covers. `to` is always midnight. */
export function dayWindow(day) {
  return { from: DAY_START_HOUR[day] ?? 0, to: 24 };
}

/** How many in-game hours this day contains. */
export function dayHours(day) {
  const { from, to } = dayWindow(day);
  return to - from;
}

/** Real seconds one in-game hour lasts, on a day of `durationSec`. */
export function hourSeconds(day, durationSec) {
  return durationSec / dayHours(day);
}

/** The clock face at `elapsed` seconds into the day. */
export function hourAt(day, durationSec, elapsed) {
  const { from } = dayWindow(day);
  const progress = durationSec > 0 ? Math.max(0, Math.min(1, elapsed / durationSec)) : 0;
  return from + progress * dayHours(day);
}

/**
 * The moment inside the day at which a given hour falls.
 *
 * Returns 0 for an hour that has already passed when the day begins - on day 1,
 * which opens at 08:00, "06:30" is simply the start of the day rather than a
 * negative time. That is what makes day 1 safe to schedule against without every
 * caller special-casing it.
 */
export function timeOfHour(day, durationSec, hour) {
  const { from, to } = dayWindow(day);
  const clamped = Math.max(from, Math.min(to, hour));
  return ((clamped - from) / dayHours(day)) * durationSec;
}

/** Is this hour inside the day at all? Day 1 has no small hours. */
export function dayCovers(day, hour) {
  const { from, to } = dayWindow(day);
  return hour >= from && hour < to;
}

/* ----------------------------------------------------------- the hours -- */

/**
 * CHECK-IN IS FROM 14:00. The operator's brief, and the promise the hotel makes.
 *
 * It is NOT a gate on admission - a room that is free and clean can be given to
 * an early guest, and that still earns its small satisfaction. What it governs is
 * the guest's PATIENCE: before it the hotel owes them nothing, so nothing is
 * ticking. See WAIT_LADDER in engine.js.
 */
export const GUARANTEE_HOUR = 14;

/**
 * WHEN THE HOUSE EMPTIES. "Check-out until 12:00" - the operator's brief - and a
 * hotel's departures bunch in the last hours before the deadline rather than
 * spreading evenly through the morning.
 */
export const CHECKOUT_HOURS = { from: 6.5, to: 12 };

/**
 * WHEN BOOKED GUESTS TURN UP.
 *
 * The operator, after seeing arrivals at three in the morning: "The guests
 * usually arrive after 08:00 now i get many check-ins between 00:00 and 08:00
 * this is not okay. the time for check-in is 14:00 no guests will arive that
 * early or they will book the previous day and just check-in with delay which is
 * fine."
 *
 *   EARLY, 09:00-14:00 - ahead of the guarantee. Admitted if the room is ready,
 *   waiting for free if it is not. This is the "book the previous day and check
 *   in with delay" case, and it is the only reason to model an early arrival.
 *   THE REST, 14:00-22:00 - from the moment check-in is promised.
 *
 * Nobody arrives before 09:00 and nobody arrives after 22:00.
 */
export const ARRIVAL_HOURS = { earliest: 9, guarantee: GUARANTEE_HOUR, latest: 22 };

/**
 * WHEN SOMEBODY WALKS IN OFF THE STREET WITHOUT A BOOKING.
 *
 * THE BUG THIS FIXES. Booked arrivals were anchored to real hours and walk-ins
 * were not - they were a flat per-second probability across the whole day, so a
 * measured day 1 produced a walk-in at 06:18 while every booked guest correctly
 * arrived after 08:30. That is what the operator saw.
 *
 * A walk-in is a late, unplanned arrival: someone whose plans changed, or who
 * gave up on somewhere else. They come in the afternoon and evening, and the
 * hotel is not receiving strangers at dawn.
 *
 * UNVERIFIED: the 12:00-23:00 span. Method - it starts around the time the
 * front desk could actually house someone (rooms turned) and runs to the last
 * hour a tired traveller would still try a door. The operator should correct it.
 */
export const WALK_IN_HOURS = { from: 12, to: 23 };

/**
 * THE NIGHT SHIFT. Operator: "after 00:00 usually there is less work at
 * reception so put receptionist to work on preparing for the next day."
 *
 * Midnight until the morning gets going. Day 1 has none of this, because day 1
 * begins at 08:00 - which is correct rather than a special case: you cannot work
 * a night shift before you own the hotel.
 */
export const NIGHT_PREP_HOURS = { from: 0, to: 6.5 };

/* ------------------------------------------------------- what schedules -- */

/**
 * WHEN A BOOKED GUEST TURNS UP. A quarter of them ahead of the guarantee, the
 * rest from 14:00 into the evening. See ARRIVAL_HOURS.
 *
 * UNVERIFIED: the 25% early share. Method - the smallest share that keeps the
 * day opening with something to do while leaving the afternoon carrying the
 * majority. Plausible range 0.15-0.35.
 */
export const EARLY_ARRIVAL_SHARE = 0.25;

export function arrivalTime(index, total, day, durationSec, random) {
  const n = Math.max(1, total);
  const jitter = () => (random() - 0.5) * 6;
  const at = (hour) => timeOfHour(day, durationSec, hour);
  const early = Math.max(1, Math.round(n * EARLY_ARRIVAL_SHARE));

  if (index < early) {
    const from = at(ARRIVAL_HOURS.earliest);
    const width = at(ARRIVAL_HOURS.guarantee) - from;
    return Math.max(0, from + (index * width) / early + jitter());
  }
  /**
   * Divided by `after`, not `after - 1`. Pushing the last arrival all the way to
   * the end of the span was tried and measured WORSE: on a day with three
   * arrivals it opens a hole in the MIDDLE (79.5s) instead of a shorter one at
   * the tail (50s), and a gap in the middle of the day is the one the operator
   * complained about.
   */
  const from = at(ARRIVAL_HOURS.guarantee);
  const width = Math.max(0, at(ARRIVAL_HOURS.latest) - from);
  const after = n - early;
  return Math.max(from, from + ((index - early) * width) / Math.max(1, after) + jitter());
}

/** When a departing guest comes down to settle. See CHECKOUT_HOURS. */
export function checkoutTime(day, durationSec, random) {
  const from = timeOfHour(day, durationSec, CHECKOUT_HOURS.from);
  const to = timeOfHour(day, durationSec, CHECKOUT_HOURS.to);
  return from + random() * Math.max(0, to - from);
}

/** When this guest's patience starts running - never before the guarantee. */
export function patienceStartsAt(day, durationSec, arrivedAt) {
  return Math.max(arrivedAt, timeOfHour(day, durationSec, GUARANTEE_HOUR));
}

/** Is the desk inside its walk-in hours right now? */
export function acceptsWalkIns(day, durationSec, elapsed) {
  const hour = hourAt(day, durationSec, elapsed);
  return hour >= WALK_IN_HOURS.from && hour < WALK_IN_HOURS.to;
}

/** Is the desk inside the night shift right now? */
export function isNightShift(day, durationSec, elapsed) {
  const hour = hourAt(day, durationSec, elapsed);
  return hour >= NIGHT_PREP_HOURS.from && hour < NIGHT_PREP_HOURS.to;
}
