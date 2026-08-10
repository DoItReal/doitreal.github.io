/**
 * Hotel Career - THE TIMELINE. Turning real time into settled business days.
 *
 * This is the seam between the wall clock and the ledger, and it exists because
 * the operator's model demands something the old code could not do: run EVERY
 * intervening day, one at a time, through the same path a played day uses.
 *
 * The old `resume()` paid a lump sum for an absence. That was fine while a "day"
 * was a 145-second session with no position on any calendar. It stops being fine
 * the moment days are numbered: a booking for day 14 has to actually arrive on
 * day 14, guests mid-stay have to check out on the right morning, and a player
 * who was away for three days needs to come back to three settled days in their
 * ledger - not one payment covering a period nothing happened in.
 *
 * TWO THINGS THIS FIXES BY CONSTRUCTION:
 *
 * 1. THE EXCHANGE RATE IS NO LONGER A SEPARATE CONSTANT. `OFFLINE_SECONDS_PER_DAY`
 *    used to be its own number - one real hour per business day - sitting next to
 *    a day simulation that ran for 145 seconds. Those two facts had nothing to do
 *    with each other and could drift apart silently. Now the offline rate uses
 *    `daySeconds(level)`, the same number the live clock uses, so a day is a day
 *    whether you watched it or not. At level 1 that means eight hours away really
 *    is forty-eight business days - which sounds like a lot until you remember a
 *    level-1 day nets tens of dollars, not hundreds.
 *
 * 2. SETTLEMENT IS IDEMPOTENT AND DAY-NUMBERED. `property.lastSettledDay` is the
 *    high-water mark. A day cannot be settled twice, which is what makes it safe
 *    for BOTH the live loop and the return path to call this. Without it, the
 *    obvious bug is a day that pays once when the tab regains focus and again
 *    when the shift ends.
 *
 * Pure. `now` is an argument, as everywhere below `game.js`.
 */

import { Clock, daySeconds } from "./Clock.js";

/**
 * How a settled day was earned. The return card shows these verbatim, because
 * "your hotel was shut for two of those days" is the most useful thing it can
 * possibly say and the old lump sum could not express it.
 */
export const DAY_SOURCE = {
  /** You were at the desk. The day's own simulation produced this number. */
  WORKED: "worked",
  /** Staff ran it without you, at the supervision discount. */
  UNSUPERVISED: "unsupervised",
  /** Nobody on the automation roster, so the doors never opened. */
  CLOSED: "closed",
  /** Past the offline cap. The day happened; it paid nothing. */
  PAST_CAP: "past_cap",
  /** No settled history to price against - the hotel has never proved it earns. */
  UNRATED: "unrated",
};

/**
 * Settle every day that has ended since the property was last seen.
 *
 * @param {object} property   The property. Not mutated.
 * @param {object} deps       `measuredNetPerDay`, `supervisionFactor`, `settleDay`
 *                            and `capSeconds` are injected rather than imported,
 *                            because `property.js` already imports this file's
 *                            neighbours and a cycle here would be a real one.
 * @param {number} now        Epoch ms.
 */
export function settleTimeline(property, deps, now, options = {}) {
  const {
    measuredNetPerDay, supervisionFactor, settleDay, capSeconds,
  } = deps;

  const clock = Clock.fromJSON(property.clock ?? { day: 1, elapsed: 0, level: 1 });
  clock.level = options.level ?? clock.level;

  const elapsedReal = Math.max(0, (now - (property.lastSeenAt ?? now)) / 1000);

  // The window the game pays for. Everything past it happened and earned
  // nothing - which is a rule of the game, stated in hours, never priced as a
  // loss. See DESIGN.md 13.
  const paidSeconds = Math.min(elapsedReal, capSeconds);

  const rolled = clock.advance(elapsedReal);
  const netPerDay = measuredNetPerDay(property);
  const factor = supervisionFactor(property);

  let next = property;
  const settled = [];
  let paidLeft = paidSeconds;

  for (const day of rolled) {
    // Days already in the ledger cannot be settled again. This is what makes
    // the function safe to call from both the live loop and the return path.
    if (day <= (property.lastSettledDay ?? 0)) continue;

    // How much of THIS day fell inside the paid window. A day straddling the
    // cap earns the fraction that fell inside it, which is the only answer that
    // does not create a cliff at the boundary.
    // PER-DAY LENGTH. Onboarding days are shorter than a rank's ordinary day,
    // so a single fixed length would price day 1 as though it were day 40 and
    // pay six times over for it.
    const dayLength = daySeconds(clock.level, day);
    const covered = Math.max(0, Math.min(dayLength, paidLeft));
    paidLeft -= covered;
    const share = covered / dayLength;

    let source = DAY_SOURCE.UNSUPERVISED;
    let net = 0;
    if (factor === 0) source = DAY_SOURCE.CLOSED;
    else if (netPerDay <= 0) source = DAY_SOURCE.UNRATED;
    else if (share <= 0) source = DAY_SOURCE.PAST_CAP;
    else net = Math.round(netPerDay * factor * share);

    next = settleDay(next, {
      net,
      durationSec: dayLength,
      rating: null,
      day,
      source,
      // An unsupervised day must never become the evidence that the hotel earns
      // this much - that would let the offline rate bootstrap itself upward off
      // its own output. Only worked days feed `measuredNetPerDay`.
      unmeasured: true,
    }, now);
    settled.push({ day, net, source, share: Math.round(share * 100) / 100 });
  }

  const result = { ...next };
  result.clock = clock.toJSON();
  result.lastSettledDay = Math.max(property.lastSettledDay ?? 0, ...rolled, 0);
  result.lastSeenAt = now;

  return {
    property: result,
    clock,
    settled,
    daysRolled: rolled.length,
    elapsedReal,
    paidSeconds,
    /** Hours the cap held. Stated in hours, never in money. */
    hoursPastCap: Math.round((Math.max(0, elapsedReal - paidSeconds) / 3600) * 10) / 10,
    earned: settled.reduce((sum, d) => sum + d.net, 0),
    factor,
    netPerDay,
  };
}

/**
 * A one-line summary of an absence, in the order a person reads it.
 *
 * Deliberately counts the days by KIND rather than listing every one: coming
 * back to "38 days, 38 rows" is not information, it is a wall.
 */
export function describeAbsence(report) {
  if (report.daysRolled === 0) return null;
  const by = {};
  for (const day of report.settled) by[day.source] = (by[day.source] ?? 0) + 1;

  const parts = [];
  if (by[DAY_SOURCE.UNSUPERVISED]) {
    parts.push(`${by[DAY_SOURCE.UNSUPERVISED]} day${by[DAY_SOURCE.UNSUPERVISED] === 1 ? "" : "s"} `
      + `run by your staff at ${Math.round(report.factor * 100)}%`);
  }
  if (by[DAY_SOURCE.CLOSED]) {
    parts.push(`${by[DAY_SOURCE.CLOSED]} shut - nobody on the automation roster`);
  }
  if (by[DAY_SOURCE.UNRATED]) {
    parts.push(`${by[DAY_SOURCE.UNRATED]} unpriced - no profitable day to go on yet`);
  }
  if (by[DAY_SOURCE.PAST_CAP]) {
    parts.push(`${by[DAY_SOURCE.PAST_CAP]} beyond the cap`);
  }
  return parts.join(", ");
}
