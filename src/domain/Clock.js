/**
 * Hotel Career - THE CLOCK. One continuous timeline, starting at day 1.
 *
 * WHAT THIS REPLACES. The game used to be a series of disconnected "days": you
 * pressed start, played 145 seconds, got a results card, and the next day began
 * from a freshly generated house. Guests who were mid-stay vanished. The
 * operator's objection was exact - two minutes is not a day, and a hotel does
 * not restart every morning.
 *
 * So there is now ONE timeline. The hotel opens on day 1 and the clock never
 * stops. A "day" is a position on it, not a session. You can be present for a
 * day or absent for it; either way it happens, guests arrive against bookings
 * made days ago, and tomorrow starts exactly where today ended.
 *
 * THE DAY LENGTH SPEEDS UP WITH LEVEL - deliberately backwards.
 *
 * A new player must see a day turn over inside their first session or nothing
 * about the game makes sense: they cannot understand a booking for "the 14th"
 * if they have never watched the 13th arrive. So day 1 is ten minutes. By the
 * time somebody is running a 4-star with three outlets they have plenty to do
 * and a fast clock would just be stressful, so a day stretches toward an hour.
 *
 * Note this is the OPPOSITE of the usual mobile pattern, where timers lengthen
 * to sell speed-ups. Here the clock slows because the content thickens, and the
 * player's time per in-game day stays roughly constant.
 */

/** Real seconds one in-game day takes, by career level. */
export const DAY_SECONDS_BY_LEVEL = {
  1: 10 * 60,     // ten minutes - a whole day inside a first session
  2: 15 * 60,
  3: 25 * 60,
  4: 40 * 60,
  5: 60 * 60,     // an hour, which is also the offline exchange rate
};

/**
 * THE ONBOARDING RAMP - shorter days for the first week, and DAY NUMBER WINS.
 *
 * Day number beats rank deliberately: the player promotes to rank 2 on about
 * day 2, and the rank curve would otherwise stretch the day in the middle of
 * the ramp - exactly where it must not. `engine.ONBOARDING_DAYS` applies the
 * same rule to the CONTENT of each day, which is where it mattered more.
 *
 * RECUT 2026-08-10, on `game-designer`'s arithmetic against a measured session.
 *
 * The old curve - 180/240/300/420/540 - cost 1680s = 28 MINUTES to reach the end
 * of day 5, against an acceptance test of TEN. Day 4 opened at 19 minutes and
 * day 5 at 28, so three of the five departments the arc exists to teach were
 * invisible to the only test the prototype has to pass. The days were also
 * getting LONGER while measured work per day got smaller, which is why the dead
 * gap grew from 22.8s on day 1 to 305.3s on day 5.
 *
 * The recut is 670s = 11 minutes 10. Day 5 - "from the most important jobs",
 * says the operator - opens at 8:40, so the ten-minute mark lands inside a brand
 * new department and the natural stopping point is just past it. That is the
 * shape "ten minutes that make you want an eleventh" actually asks for.
 *
 * DAY 1 CAME DOWN FROM 180s TO 150s, and the reason is content, not pacing.
 * Escorting a guest to their room is the BELLBOY's job and the operator's arc
 * puts the bellboy on day 2, so day 1 lost a task type it used to carry. Its
 * length had to follow: measured, 180s left it running out of work at 120s.
 */
export const ONBOARDING_DAY_SECONDS = { 1: 150, 2: 120, 3: 120, 4: 130, 5: 150 };

export function daySeconds(level, day = null) {
  if (day !== null && ONBOARDING_DAY_SECONDS[day]) return ONBOARDING_DAY_SECONDS[day];
  return DAY_SECONDS_BY_LEVEL[Math.max(1, Math.min(5, level))] ?? 3600;
}

/**
 * The parts of a day the hotel actually distinguishes. Real front office runs on
 * these boundaries and the simulation should too: departures are a morning
 * problem, arrivals are an afternoon one, and the restaurant is an evening one.
 */
export const PHASE = {
  NIGHT: "night",         // 00:00-06:00  quiet, night audit
  MORNING: "morning",     // 06:00-12:00  checkouts, housekeeping starts
  AFTERNOON: "afternoon", // 12:00-18:00  arrivals, check-ins
  EVENING: "evening",     // 18:00-24:00  dinner service, the bar
};

/**
 * THE HOURS THE PLAYABLE DAY COVERS. A FULL TWENTY-FOUR.
 *
 * This was briefly compressed to 08:00-20:00 to give the operator's 12:00-14:00
 * pinch a bigger share of the screen time. The operator rejected it on sight:
 * "the day start at 08:00 which is not accurate for 24 hours it must be
 * accurate." The clock on a hotel wall is not a game camera, and a day that
 * skips the night is not a day.
 *
 * WHAT THAT COSTS, STATED SO NOBODY RE-DISCOVERS IT. A literal mapping gives the
 * 12:00-14:00 window 2/24 = 8.3% of the day, and puts a quarter of every day in
 * the small hours when a one-star front desk has almost nothing to do.
 *
 * THE OPERATOR'S OWN ANSWER TO THAT is not to hide the night but to fill it, and
 * it is recorded in DESIGN.md rather than built here: "after 00:00 usually there
 * is less work at reception so put receptionist to work on preparing for the
 * next day... he can prepare keys, information he has to give to the guests" -
 * and that preparation is meant to make the NEXT day's check-ins faster. Night
 * shift as setup for the morning, which is exactly how a real night audit works.
 *
 * NOTE WHAT THIS IS NOT. There is still no 14:00 check-in gate. Readiness blocks
 * a check-in; the hour never does. What 14:00 governs is the guest's PATIENCE -
 * see WAIT_LADDER in engine.js and dec-20260809-6fdee8.
 */
export const OPERATING_WINDOW = { from: 0, to: 24 };

export const PHASE_BOUNDS = [
  { phase: PHASE.NIGHT, from: 0, to: 6 },
  { phase: PHASE.MORNING, from: 6, to: 12 },
  { phase: PHASE.AFTERNOON, from: 12, to: 18 },
  { phase: PHASE.EVENING, from: 18, to: 24 },
];

export class Clock {
  /**
   * @param {object} spec
   * @param {number} spec.startedAt Epoch ms when day 1 began. The ONLY wall-clock
   *                                value in the domain, and it is passed in.
   */
  constructor(spec = {}) {
    this.startedAt = spec.startedAt ?? 0;
    this.day = spec.day ?? 1;
    /** Seconds elapsed inside the current day, 0 .. daySeconds(level). */
    this.elapsed = spec.elapsed ?? 0;
    this.level = spec.level ?? 1;
    /** Days that have rolled over and not yet been settled into the ledger. */
    this.pendingSettlements = spec.pendingSettlements ?? 0;
  }

  get dayLength() { return daySeconds(this.level, this.day); }

  /** Position through the day, 0..1. */
  get progress() { return Math.max(0, Math.min(1, this.elapsed / this.dayLength)); }

  /**
   * In-game hour. What the UI puts on the clock face. A real 24-hour day - see
   * OPERATING_WINDOW for why it is literal and what filling the night costs.
   */
  get hour() {
    const { from, to } = OPERATING_WINDOW;
    return from + this.progress * (to - from);
  }

  get phase() {
    const h = this.hour;
    return (PHASE_BOUNDS.find((b) => h >= b.from && h < b.to) ?? PHASE_BOUNDS[0]).phase;
  }

  /** "Day 12, 14:30" - the one string the header shows. */
  get label() {
    const h = Math.floor(this.hour);
    const m = Math.floor((this.hour - h) * 60);
    return `Day ${this.day}, ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  /**
   * Advance by real seconds and report every day boundary crossed.
   *
   * Returns the day numbers that ENDED, so the caller can settle each one in
   * order. Coming back after two real days must run every intervening day
   * through the same code path a played day uses - never a lump sum, or the
   * simulation and the idle layer diverge and the player can feel it.
   */
  advance(seconds) {
    const rolled = [];
    let left = Math.max(0, seconds);
    // Guard against a pathological absence turning into a million iterations;
    // the offline cap upstream should stop this long before it matters.
    let guard = 0;
    while (left > 0 && guard < 10000) {
      const remaining = this.dayLength - this.elapsed;
      if (left < remaining) { this.elapsed += left; break; }
      left -= remaining;
      rolled.push(this.day);
      this.day += 1;
      this.elapsed = 0;
      guard += 1;
    }
    this.pendingSettlements += rolled.length;
    return rolled;
  }

  /** Real seconds until the current day ends. What a "next day in..." pill shows. */
  get secondsToDayEnd() { return Math.max(0, this.dayLength - this.elapsed); }

  /**
   * A DISPLAY-ONLY copy, carried forward by `seconds`. Never rolls the day.
   *
   * THE BUG THIS FIXES. The stored clock is only moved by `advanceTimeline`,
   * which runs on a ten-second heartbeat. Ten real seconds on a 180-second day
   * is EIGHTY IN-GAME MINUTES, so the header read "Day 1, 09:20" for ten
   * seconds and then jumped to "Day 1, 10:40". The operator reported it exactly:
   * "it moves by steps of a lot seconds not second by second."
   *
   * Settlement must stay on the heartbeat - it writes to the ledger and must not
   * run sixty times a second - so the fix is to interpolate for the EYE only.
   * The projection is exact rather than a guess, because `lastSeenAt` is stamped
   * by the same call that last moved this clock.
   *
   * It stops dead at the end of the day on purpose. A rollover is a settlement,
   * settlement belongs to the heartbeat, and a display that rolled the day over
   * first would show a day the ledger had never heard of.
   */
  projected(seconds) {
    const ahead = Math.max(0, seconds);
    const next = new Clock(this.toJSON());
    next.elapsed = Math.min(this.dayLength, this.elapsed + ahead);
    return next;
  }

  toJSON() {
    return {
      startedAt: this.startedAt, day: this.day, elapsed: this.elapsed,
      level: this.level, pendingSettlements: this.pendingSettlements,
    };
  }

  static fromJSON(data) { return new Clock(data ?? {}); }
}
