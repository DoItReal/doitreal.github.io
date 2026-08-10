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

/**
 * THE SHIFT MAY NOT GET THE WHOLE DAY, AND IT HAS TO KNOW THAT.
 *
 * The operator, on the deployed build: "the clock shows 22:00 and there is
 * check-in it says: 'Check-in early than 14:00 - 2 hours until'. 00:00 is not
 * 14:00 this is totally wrong. From where does everything gets the time?"
 *
 * Two answers, which was the bug. The header reads the property timeline and was
 * right. The job board read the SHIFT, and the shift was handed the REMAINING
 * seconds of the day (`clockOf(property).secondsToDayEnd`) while still mapping
 * its own `elapsed` across the whole day window. Come back at 20:00 and the shift
 * believed its t=0 was midnight and stretched the last four hours over a full
 * twenty-four. Every hour derived from it - the 14:00 guarantee, check-out,
 * walk-ins, night prep, arrivals - was wrong by that offset.
 *
 * The fix is not a global clock object. `property.js` and `engine.js` are pure -
 * `now` is always an argument, never `Date.now()` - and a mutable singleton
 * holding wall-clock state would break replay determinism, the headless pacing
 * harness and the offline economy tests. The operator's real complaint was that
 * there were TWO authorities for "what hour is it". So there is still one, here,
 * and the shift now carries the hour it STARTED at: its elapsed seconds map onto
 * [startHour, midnight] instead of [dayStart, midnight].
 *
 * `startHour` of null means "the whole day", which is what a cold start on any
 * day is, and is why every existing caller and test is untouched by this.
 */
export function shiftWindow(day, startHour = null) {
  const { from, to } = dayWindow(day);
  if (startHour === null || !Number.isFinite(startHour)) return { from, to };
  return { from: Math.max(from, Math.min(to, startHour)), to };
}

/** How many in-game hours are left to play from this shift's start. */
export function shiftHours(day, startHour = null) {
  const { from, to } = shiftWindow(day, startHour);
  return Math.max(0, to - from);
}

/**
 * Does this hour still happen inside a shift that began at `startHour`?
 *
 * False means the event is in the PAST - a 09:00 arrival in a shift that opens
 * at 20:00 already happened, while the player was away, and `advanceTimeline`
 * has already priced those hours. The caller must DROP it, not clamp it to zero:
 * `timeOfHour` below clamps, and clamping is exactly how you get a pile of
 * impossible tasks dumped on the board at t=0.
 *
 * The hour is clamped into the DAY first so day 1 keeps behaving as it did:
 * "06:30" on a day that opens at 08:00 is the start of the day, not a miss.
 */
export function shiftCovers(day, hour, startHour = null) {
  const { from, to } = dayWindow(day);
  const inDay = Math.max(from, Math.min(to, hour));
  return inDay >= shiftWindow(day, startHour).from;
}

/** Real seconds one in-game hour lasts, on a shift of `durationSec`. */
export function hourSeconds(day, durationSec, startHour = null) {
  const hours = shiftHours(day, startHour);
  return hours > 0 ? durationSec / hours : durationSec;
}

/** The clock face at `elapsed` seconds into the shift. */
export function hourAt(day, durationSec, elapsed, startHour = null) {
  const { from } = shiftWindow(day, startHour);
  const progress = durationSec > 0 ? Math.max(0, Math.min(1, elapsed / durationSec)) : 0;
  return from + progress * shiftHours(day, startHour);
}

/**
 * The moment inside the shift at which a given hour falls.
 *
 * Returns 0 for an hour that has already passed when the shift begins - on day 1,
 * which opens at 08:00, "06:30" is simply the start of the day rather than a
 * negative time. That is what makes day 1 safe to schedule against without every
 * caller special-casing it.
 *
 * That clamp is a convenience, not a licence: ask `shiftCovers` FIRST if the
 * answer "this never happens today" is a possible one. See its note.
 */
export function timeOfHour(day, durationSec, hour, startHour = null) {
  const { from, to } = shiftWindow(day, startHour);
  const hours = shiftHours(day, startHour);
  if (hours <= 0) return 0;
  const clamped = Math.max(from, Math.min(to, hour));
  return ((clamped - from) / hours) * durationSec;
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

/**
 * THE OPENING MORNING - day 1, and only day 1.
 *
 * Operator directive, 2026-08-10: "you get a hotel which opens just right now.
 * It must have no occupied rooms, no staff, maybe 50$ in the bank."
 *
 * A hotel that opens today has nobody upstairs, so day 1 has no check-outs to
 * open on and no guest before 09:00. Measured, that put the first thing the
 * player could touch at 11.0s of a 150s day - the worst opening a prototype
 * whose acceptance test is "catchy within ten minutes" could have.
 *
 * The answer is not to invent guests. It is the same answer the operator
 * already gave for the small hours: give the empty time the job it really has.
 * On the morning you open, the desk is being SET UP - keys cut, registration
 * cards laid out, the rack made ready - which is `TASK.PREP`, one window
 * earlier. It pays out today rather than tomorrow, because the guests it is for
 * arrive this afternoon.
 *
 * THE BUG THIS ALSO FIXES: `ONBOARDING_DAYS[1]` has listed `TASK.PREP` since the
 * teaching arc was written, and day 1 could never spawn one - the spawn guard
 * asks `isNightShift`, and day 1 begins at 08:00. Day 1 has been advertising a
 * task type it cannot produce. Found by `game-designer`, 2026-08-10.
 *
 * UNVERIFIED: the 08:00-12:00 span. Method - it starts when the doors open and
 * ends at the check-out deadline, after which the day is about guests rather
 * than preparation. The operator should correct it.
 */
export const OPENING_PREP_HOURS = { from: 8, to: 12 };

/**
 * WHEN THE VERY FIRST GUEST OF ALL TURNS UP.
 *
 * 08:20 on day 1, before `ARRIVAL_HOURS.earliest`, and deliberately so: this is
 * the one arrival that is not a distribution. Somebody booked the week you
 * announced you were opening and they are on the step when you unlock. The
 * brief admits them - "if the room is free and clean, they can be checked in" -
 * and every room in a hotel that has never traded is free and clean.
 *
 * It applies to day 1 only. From day 2 arrivals follow ARRIVAL_HOURS like
 * everyone else.
 */
export const OPENING_DAY_FIRST_ARRIVAL_HOUR = 8.33;

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

/**
 * Returns null for an arrival whose hour is already behind a late-starting
 * shift. Those guests are not lost, they are simply not this shift's: they
 * turned up while the player was away and the offline path has already priced
 * them. See `shiftCovers`.
 */
export function arrivalTime(index, total, day, durationSec, random, startHour = null) {
  const n = Math.max(1, total);
  const jitter = () => (random() - 0.5) * 6;
  const at = (hour) => timeOfHour(day, durationSec, hour, startHour);
  const covers = (hour) => shiftCovers(day, hour, startHour);
  const early = Math.max(1, Math.round(n * EARLY_ARRIVAL_SHARE));

  // The first guest the hotel ever has is on the step, not in a distribution.
  // See OPENING_DAY_FIRST_ARRIVAL_HOUR. No jitter: this one is a scripted beat.
  if (day === 1 && index === 0) {
    return covers(OPENING_DAY_FIRST_ARRIVAL_HOUR) ? at(OPENING_DAY_FIRST_ARRIVAL_HOUR) : null;
  }

  /**
   * The nominal hour an arrival is spread to, before jitter. On a whole-day
   * shift `at(nominal)` and `from + share * width` are the same number, but only
   * algebraically - the seconds form is kept for the default path so the pacing
   * baseline stays bit-identical. A late shift has to go through the HOUR,
   * because `at()` clamps everything before the start to 0 and would otherwise
   * squash the surviving guests toward the opening second.
   */
  const wholeDay = shiftWindow(day, startHour).from === dayWindow(day).from;
  const spread = (fromHour, toHour, share) => {
    const nominal = fromHour + (toHour - fromHour) * share;
    if (!covers(nominal)) return null;
    return wholeDay ? undefined : at(nominal);
  };

  if (index < early) {
    const from = at(ARRIVAL_HOURS.earliest);
    const width = at(ARRIVAL_HOURS.guarantee) - from;
    // Drawn before the coverage test so the seeded stream is identical whether
    // or not this arrival lands in the shift. Determinism is not negotiable.
    const j = jitter();
    const exact = spread(ARRIVAL_HOURS.earliest, ARRIVAL_HOURS.guarantee, index / early);
    if (exact === null) return null;
    if (exact !== undefined) return Math.max(0, exact + j);
    return Math.max(0, from + (index * width) / early + j);
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
  const j = jitter();
  const exact = spread(
    ARRIVAL_HOURS.guarantee, ARRIVAL_HOURS.latest, (index - early) / Math.max(1, after),
  );
  if (exact === null) return null;
  if (exact !== undefined) return Math.max(0, exact + j);
  return Math.max(from, from + ((index - early) * width) / Math.max(1, after) + j);
}

/**
 * When a departing guest comes down to settle. See CHECKOUT_HOURS.
 *
 * Null when the whole check-out window is behind a late-starting shift: a shift
 * that opens at 20:00 has no departures left to take, because they left at noon.
 */
export function checkoutTime(day, durationSec, random, startHour = null) {
  const roll = random();
  if (!shiftCovers(day, CHECKOUT_HOURS.to, startHour)) return null;
  const from = timeOfHour(day, durationSec, CHECKOUT_HOURS.from, startHour);
  const to = timeOfHour(day, durationSec, CHECKOUT_HOURS.to, startHour);
  return from + roll * Math.max(0, to - from);
}

/** When this guest's patience starts running - never before the guarantee. */
export function patienceStartsAt(day, durationSec, arrivedAt, startHour = null) {
  // On a shift that opens after 14:00 this clamps to 0, which is right: the
  // promise is already due, so the hotel is late from the moment they walk in.
  return Math.max(arrivedAt, timeOfHour(day, durationSec, GUARANTEE_HOUR, startHour));
}

/** Is the desk inside its walk-in hours right now? */
export function acceptsWalkIns(day, durationSec, elapsed, startHour = null) {
  const hour = hourAt(day, durationSec, elapsed, startHour);
  return hour >= WALK_IN_HOURS.from && hour < WALK_IN_HOURS.to;
}

/** Is the desk inside the night shift right now? */
export function isNightShift(day, durationSec, elapsed, startHour = null) {
  const hour = hourAt(day, durationSec, elapsed, startHour);
  return hour >= NIGHT_PREP_HOURS.from && hour < NIGHT_PREP_HOURS.to;
}

/**
 * Is this the opening morning - the one window where preparation is for TODAY?
 * See OPENING_PREP_HOURS. Day 1 only; every other day preps at night, for the
 * morning after.
 */
export function isOpeningPrep(day, durationSec, elapsed, startHour = null) {
  if (day !== 1) return false;
  const hour = hourAt(day, durationSec, elapsed, startHour);
  return hour >= OPENING_PREP_HOURS.from && hour < OPENING_PREP_HOURS.to;
}

/** Is the desk doing preparation work of either kind right now? */
export function isPrepTime(day, durationSec, elapsed, startHour = null) {
  return isNightShift(day, durationSec, elapsed, startHour)
    || isOpeningPrep(day, durationSec, elapsed, startHour);
}

/** The window preparation runs in on this day, in hours. */
export function prepWindow(day) {
  return day === 1 ? OPENING_PREP_HOURS : NIGHT_PREP_HOURS;
}
