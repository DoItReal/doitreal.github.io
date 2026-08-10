/**
 * Hotel Career - HOW LONG THINGS TAKE, and why it is not one number.
 *
 * THE COMPLAINT THIS ANSWERS, verbatim: "the building time of 24hrs is not very
 * catchy at the beginning... no one wants to play a game where in the first 5-10
 * minutes they get 24/48hrs to build something or to train a staff."
 *
 * Correct, and the old catalogue was worse than it looked: those hours were
 * fixed, so the FIRST thing a new player could afford was also one of the
 * slowest things in the game. The first session ended with a countdown and
 * nothing to do.
 *
 * THE MODEL. A job's duration is its catalogue time scaled by two independent
 * factors, and keeping them independent is the point:
 *
 *   PACE (career level)    - how fast the world moves for a player at this rank.
 *                            Level 1 runs at 2% of catalogue. A 24-hour
 *                            restaurant is 29 minutes; a 3-hour breakfast room
 *                            is 3.6 minutes. Nothing in the first session takes
 *                            longer than the day it happens in.
 *
 *   SCALE (property size)  - big buildings take longer. A refurbishment in a
 *                            30-room hotel is a bigger job than in an 8-room one,
 *                            and this is what stops the late game from being
 *                            trivially fast once PACE has stopped shrinking.
 *
 * Why two factors rather than one curve: pace is about the PLAYER's experience
 * of time and scale is about the HOTEL. A returning expert starting a second
 * property should get the fast small-hotel timers, not their own rank's slow
 * ones. Fold them together and that becomes impossible to express.
 *
 * The honest framing for a player: early timers are short because an eight-room
 * hotel is a small building, and they lengthen because you are running a bigger
 * one. That is true, which matters more here than it usually would - this game's
 * whole pitch is that its numbers mean something.
 */

/**
 * Share of the catalogue duration a player of this level actually waits.
 *
 * Level 5 is still only 55%, not 100%. The catalogue times were written for a
 * game with no continuous clock; against a real timeline where the hotel trades
 * whether or not you are watching, full-length builds are simply too slow, and
 * pretending otherwise would just push people toward speed-ups. If we ever want
 * the raw numbers back they belong in the catalogue, not hidden in this curve.
 */
export const PACE_BY_LEVEL = {
  1: 0.02,   // a 24h restaurant becomes 29 minutes
  2: 0.06,   // ...1h 26m
  3: 0.16,   // ...3h 50m
  4: 0.34,   // ...8h 10m
  5: 0.55,   // ...13h 12m
};

export function pace(level) {
  return PACE_BY_LEVEL[Math.max(1, Math.min(5, level))] ?? 0.55;
}

/**
 * Size factor. Flat at the starting house, rising with rooms owned. Deliberately
 * gentle - it is a texture on top of pace, not a second wall.
 */
export const SCALE_PER_ROOM = 0.018;
export const SCALE_BASE_ROOMS = 8;
export const SCALE_CAP = 1.6;

export function scale(rooms) {
  const over = Math.max(0, (rooms ?? SCALE_BASE_ROOMS) - SCALE_BASE_ROOMS);
  return Math.min(SCALE_CAP, 1 + over * SCALE_PER_ROOM);
}

/** Nothing is ever instant - a job with no wait teaches the player nothing. */
export const MINIMUM_SECONDS = 20;

/**
 * The real duration of a job, in seconds.
 *
 * @param {number} catalogueSeconds The published time from BUILD_CATALOG.
 * @param {number} level            Career level - the PACE factor.
 * @param {number} rooms            Rooms owned - the SCALE factor.
 */
export function duration(catalogueSeconds, level, rooms) {
  return Math.max(MINIMUM_SECONDS, Math.round(catalogueSeconds * pace(level) * scale(rooms)));
}

/**
 * Training is scaled the same way but on its own, shallower pace: a course is a
 * course, and it should not become nearly free just because the player is new.
 * The absence it causes is the real cost anyway - see property.js.
 */
export const TRAINING_PACE_FLOOR = 0.12;

export function trainingDuration(catalogueSeconds, level) {
  const p = Math.max(TRAINING_PACE_FLOOR, pace(level));
  return Math.max(MINIMUM_SECONDS, Math.round(catalogueSeconds * p));
}

/**
 * What the build screen should print. Kept here rather than in the UI so the
 * tests can assert on the thing the player actually reads.
 */
export function humanDuration(seconds) {
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const hours = seconds / 3600;
  return hours < 10 ? `${hours.toFixed(1)}h` : `${Math.round(hours)}h`;
}
