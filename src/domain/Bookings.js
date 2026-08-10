/**
 * Hotel Career - FILLING THE BOOK.
 *
 * The `Calendar` knows how to answer questions about a forward book. This is
 * what puts bookings IN it.
 *
 * WHY A GENERATOR AND NOT RANDOM ARRIVALS. The old model invented today's
 * arrivals at the start of today, which meant there was no tomorrow to look at
 * and "is 402 free on the 14th" was not a question the code could hold. A
 * forward book has to be built AHEAD - bookings for the 14th have to exist on
 * the 9th, or the reservations desk has nothing to be good or bad at.
 *
 * THE RULE THAT KEEPS IT HONEST: this only ever creates bookings the property
 * could actually house. A book full of impossible reservations is not a
 * challenge, it is a bug that looks like one - the player would open the grid
 * to find they were oversold on a day they had never traded. Overbooking has to
 * be something the PLAYER does by taking a call they should have refused, which
 * is exactly what `judgeBooking` is for.
 *
 * Deterministic in the seed, so the same property fills the same way.
 */

import { mulberry32 } from "../engine.js";
import { Booking, BOOKING_SOURCE } from "./Booking.js";
import { ROOM_TYPE_SPEC } from "./Room.js";

/** How many days ahead the book is kept populated. */
export const BOOK_HORIZON = 14;

/**
 * Arrivals per room per day, at fair rate.
 *
 * A hotel running near 70% occupancy on an average stay of about 2.8 nights
 * turns over roughly a quarter of its rooms a day. That is the number this is,
 * and it is why a bigger house does not just mean bigger numbers - it means
 * more arrivals to handle in the same day.
 */
export const ARRIVALS_PER_ROOM = 0.25;

/**
 * THE ONBOARDING CURVE, decaying to the real number by day 6.
 *
 * A hotel's first week under a new owner is busy, and a player's first week
 * needs to be. This is not a difficulty ramp in disguise - it settles onto the
 * simulation's own figure rather than staying inflated.
 */
export const ONBOARDING_ARRIVALS = { 1: 3.0, 2: 2.6, 3: 2.2, 4: 1.8, 5: 1.4 };

export function arrivalMultiplier(day) {
  return ONBOARDING_ARRIVALS[day] ?? 1;
}

/**
 * THE OPENING WEEK IS FULL OF SHORT STAYS - and this is the fix for a starved
 * book, not a difficulty knob.
 *
 * THE ARITHMETIC, from `reality-check` and confirmed here. `E[NIGHTS_MIX]` is
 * 2.82 nights. Occupancy DEMANDED by the generator is
 * `ARRIVALS_PER_ROOM x multiplier x nights`, so:
 *
 *   day 1  0.25 x 3.0 x 2.82 = 212%      day 4  0.25 x 1.8 x 2.82 = 127%
 *   day 2  0.25 x 2.6 x 2.82 = 183%      day 5  0.25 x 1.4 x 2.82 =  99%
 *   day 3  0.25 x 2.2 x 2.82 = 155%      day 6+ 0.25 x 1.0 x 2.82 = 70.5%
 *
 * The day-6 baseline is right and matches the comment on ARRIVALS_PER_ROOM. The
 * onboarding multiplier asks the building to be MORE THAN FULL for the first
 * four days, so `fillBook` hits `availableRooms() === []`, breaks, and the book
 * starves. Measured, day 2 got 2 arrivals against day 1's 6 - not because the
 * curve wanted fewer but because there was nowhere to put them.
 *
 * Raising the multiplier cannot fix that; it is already over 100%. The lever is
 * the OTHER term. A short stay frees the room again, and a room that comes free
 * is a room that can be sold again - which is day 1's check-out lesson repeating
 * rather than a balance patch.
 *
 * IT STOPS AT DAY 4, and `game-designer` was right to insist on it. Day 5 is the
 * reservations manager, whose subject is literally "many 2, 3 and 7 day stays"
 * and the maths of when a room comes free. A book of one-nighters would delete
 * the lesson the day exists to teach. So this is a supply fix for the opening
 * days only, and the real mix is back by day 5.
 *
 * UNVERIFIED. Method: chosen so demanded occupancy lands near 85% on days 1-2
 * rather than 212% and 183%, leaving genuine headroom for the book to fill.
 */
export const ONBOARDING_SHORT_STAY = { 1: 0.7, 2: 0.6, 3: 0.35, 4: 0.15 };

export function shortStayBias(day) {
  return ONBOARDING_SHORT_STAY[day] ?? 0;
}

/** Nights, matching the mix the engine already uses. */
export const NIGHTS_MIX = [
  { nights: 1, weight: 0.18 }, { nights: 2, weight: 0.30 }, { nights: 3, weight: 0.26 },
  { nights: 4, weight: 0.14 }, { nights: 5, weight: 0.07 }, { nights: 7, weight: 0.05 },
];

export const PARTY_MIX = [
  { guests: 1, weight: 0.26 }, { guests: 2, weight: 0.46 },
  { guests: 3, weight: 0.20 }, { guests: 4, weight: 0.08 },
];

/**
 * THE PARTY SIZES THIS BUILDING CAN ACTUALLY TAKE, renormalised.
 *
 * THE BUG THIS FIXES, measured 2026-08-10. The opening eight-room house tops out
 * at THREE heads - capacity 2 plus one extra bed, and two of the eight are
 * singles. `PARTY_MIX` draws a party of four with weight 0.08 regardless. That
 * party can never be housed, `availableRooms` returns `[]`, and `fillBook` used
 * to `break` - so the FIRST family of four in the random stream deleted the rest
 * of that day's arrivals.
 *
 * Measured on the shipped house (`createHouse(8, { seed: 20260809 })`, every
 * room a single, twin or double): day 1 produced exactly 3 arrivals on every
 * seed, against a generator target of 6, and no amount of demand moved it.
 * Emptying the hotel entirely still gave 3, which is what proves it was never
 * about capacity. `continue` alone gives 5.
 *
 * `continue` is still not the whole fix, and `reality-check` was right about
 * why: an unhousable party that is merely SKIPPED is demand that silently
 * evaporates. Drawing only from what the building can hold means
 * `availableRooms() === []` recovers its honest meaning - genuinely full - and
 * the file's top rule ("only ever creates bookings the property could actually
 * house") holds by construction rather than by a guard.
 *
 * What it does NOT do is pretend the segment does not exist: a house with no
 * family room simply is not sold to families, which is a real constraint a
 * hotelier would recognise and a legible reason to build one.
 */
export function housableParties(house) {
  const ceiling = house.reduce((most, room) => {
    const spec = ROOM_TYPE_SPEC[room.type];
    return Math.max(most, spec.capacity + spec.extraBeds);
  }, 0);
  const usable = PARTY_MIX.filter((row) => row.guests <= ceiling);
  // A building that cannot take even one head is not a hotel; fall back rather
  // than hand `pick` an empty table.
  return usable.length ? usable : [PARTY_MIX[0]];
}

function pick(table, roll, key) {
  const total = table.reduce((sum, row) => sum + row.weight, 0);
  let r = roll * total;
  for (const row of table) {
    r -= row.weight;
    if (r <= 0) return row[key];
  }
  return table[table.length - 1][key];
}

/**
 * The type this booking asks for, weighted by what the building actually has -
 * and by party size, because a family of four does not book a single.
 */
export function requestTypeFor(house, guests, roll) {
  const usable = house.filter((room) => ROOM_TYPE_SPEC[room.type].capacity
    + ROOM_TYPE_SPEC[room.type].extraBeds >= guests);
  const pool = usable.length ? usable : house;
  const counts = {};
  for (const room of pool) counts[room.type] = (counts[room.type] ?? 0) + 1;
  const table = Object.entries(counts).map(([type, n]) => ({ type, weight: n }));
  return pick(table, roll, "type");
}

/**
 * Top the book up so every day inside the horizon has plausible arrivals.
 *
 * Returns the bookings ADDED, so the caller can report "six new enquiries" and
 * the analytics can tell generated demand from demand the player created by
 * answering the phone.
 *
 * @param {Calendar} calendar Mutated - bookings are added to it.
 * @param {Room[]} house      The building, used for both fit and availability.
 */
export function fillBook(calendar, house, options = {}) {
  const {
    today = 1, horizon = BOOK_HORIZON, demand = 1, rate = 0, seed = 1,
    perRoom = ARRIVALS_PER_ROOM,
  } = options;

  const random = mulberry32(seed + today * 7919);
  const added = [];
  const sellable = house.filter((room) => !room.outOfInventory);
  if (sellable.length === 0) return added;
  // Only party sizes this building can take. See housableParties.
  const parties = housableParties(sellable);

  for (let day = today; day < today + horizon; day += 1) {
    // Days closer to today are already largely booked; the far end of the
    // horizon fills gradually, which is what a real pick-up curve looks like.
    const maturity = Math.min(1, (horizon - (day - today)) / horizon + 0.25);
    const target = Math.round(
      sellable.length * perRoom * demand * maturity * arrivalMultiplier(day));
    const already = calendar.arrivalsOn(day).length;

    for (let i = already; i < target; i += 1) {
      const guests = pick(parties, random(), "guests");
      let nights = pick(NIGHTS_MIX, random(), "nights");
      // See ONBOARDING_SHORT_STAY. Trimmed, never replaced - the long stays are
      // still in there, which is what keeps day 5's lesson intact.
      if (random() < shortStayBias(day)) nights = Math.min(nights, 1 + Math.floor(random() * 2));
      const requestedType = requestTypeFor(sellable, guests, random());

      // ONLY IF IT CAN ACTUALLY BE HOUSED. See the note at the top: the
      // generator must never create the overbooking, only the opportunity.
      //
      // CONTINUE, NOT BREAK. One enquiry that will not fit is not evidence the
      // book is closed - a hotel that cannot take a four-night family takes the
      // next call. Breaking here threw away the REST of the day's demand on the
      // strength of a single awkward request, and measured, that cost day 1 half
      // its arrivals. The `random()` keeps the id draw the placed branch makes,
      // so the stream does not depend on which way this went.
      const free = calendar.availableRooms(sellable, day, nights, { guests });
      if (free.length === 0) { random(); continue; }

      const booking = new Booking({
        id: `bk-${day}-${i}-${Math.floor(random() * 1e6)}`,
        arrivalDay: day, nights, guests, requestedType,
        requestedView: free[0].view,
        rate,
        source: BOOKING_SOURCE.DIRECT,
      });
      // Hold a room straight away. An unallocated book is a work queue, and a
      // player who has never seen the grid should not open it to a backlog.
      const room = free.reduce((best, r) =>
        (r.rateMultiplier < best.rateMultiplier ? r : best), free[0]);
      booking.roomId = room.id;
      calendar.add(booking);
      added.push(booking);
    }
  }
  return added;
}

/**
 * Move the book on by a day: depart anyone whose stay ended, and drop bookings
 * that are far enough in the past to be history rather than state.
 *
 * Kept separate from `fillBook` because they answer different questions and are
 * called at different moments - departures happen at rollover, filling happens
 * whenever the book looks thin.
 */
export function rollBook(calendar, today, options = {}) {
  const keepDays = options.keepDays ?? 30;
  const departed = [];
  for (const booking of [...calendar.bookings.values()]) {
    // STRICTLY BEFORE TODAY. A booking whose departureDay is today has not
    // left yet - they are upstairs at eight in the morning and they check out
    // during the day. Departing them at rollover made them invisible to the day
    // that was supposed to process them: no check-outs, so no dirty rooms, no
    // housekeeping work, and - the symptom that gave it away - no reviews at
    // all, so the hotel's rating sat at its opening value for forty days.
    if (booking.active && booking.departureDay < today) {
      booking.state = "departed";
      departed.push(booking);
    }
    // Forget the deep past. A ledger of every guest who ever stayed is a memory
    // leak on a phone, and nothing reads it.
    if (booking.departureDay < today - keepDays) calendar.remove(booking.id);
  }
  return departed;
}

/** Bookings sleeping in the house tonight, with the rooms they hold. */
export function inHouseTonight(calendar, day) {
  return calendar.inHouseOn(day).filter((b) => b.roomId !== null);
}

/**
 * Who is in the building when the day OPENS - which is not the same list as
 * who is in it tonight, and the difference is the entire morning.
 *
 * `inHouseOn(day)` answers "who sleeps here tonight", so it correctly excludes
 * a guest whose last night was yesterday. But that guest is still upstairs at
 * eight in the morning, still has to check out, and their room still has to be
 * turned before it can be sold again. Leave them out and the house never
 * generates a single departure - which is exactly what happened the first time
 * this was wired, and it produced a hotel where no room ever came free.
 */
/**
 * OPEN THE HOTEL WITH PEOPLE IN IT - and as of 2026-08-10, we do not.
 *
 * `fillBook` starts at `today`, so nothing ever had `arrivalDay < 1`. This
 * seeds the book BACKWARDS instead: stays that began before day 1 and run into
 * it, some of them leaving on the first morning, which used to be where day 1's
 * check-outs came from.
 *
 * IT IS NO LONGER CALLED ON A NEW PROPERTY. The operator directed a cold open -
 * "you get a hotel which opens just right now, no occupied rooms, no staff" -
 * and `maintainBook`'s `openingOccupancy` now defaults to 0. The function is
 * kept, parameterised and tested because reversing that decision is one number:
 * `reality-check` argued for a handover of 2-3 rooms and measured well
 * (`docs/DAY1-COLD-OPEN.md`), and the operator chose the pure cold open over it
 * with the numbers in front of them.
 *
 * The cost of the cold open, and what pays for it, is the opening prep window -
 * see `Schedule.OPENING_PREP_HOURS`. Day 1 has no check-outs; it has the morning
 * you spend getting the desk ready to receive the first guest of all.
 */
export function seedOpeningGuests(calendar, house, options = {}) {
  const { today = 1, rate = 0, seed = 1, occupancy = 0.55 } = options;
  const random = mulberry32(seed + 31337);
  const sellable = house.filter((room) => !room.outOfInventory);
  const wanted = Math.round(sellable.length * occupancy * 1.4);
  const added = [];
  const parties = housableParties(sellable);

  for (let i = 0; i < wanted; i += 1) {
    const guests = pick(parties, random(), "guests");
    const nights = pick(NIGHTS_MIX, random(), "nights");
    // Somewhere between one night in and their last night, so the morning has
    // departures AND the house has people staying on.
    // Between one night in and their LAST night inclusive, so some of them
    // leave this very morning. Excluding those - which the first cut did, with
    // `<= today` - left day 1 with no check-outs at all, which is precisely the
    // lesson day 1 exists to teach.
    const elapsed = 1 + Math.floor(random() * nights);
    const arrivalDay = today - elapsed;
    if (arrivalDay + nights < today) continue;

    const free = calendar.availableRooms(sellable, arrivalDay, nights, { guests });
    if (free.length === 0) continue;
    const room = free.reduce((best, r) =>
      (r.rateMultiplier < best.rateMultiplier ? r : best), free[0]);

    const booking = new Booking({
      id: `seed-${i}-${Math.floor(random() * 1e6)}`,
      arrivalDay, nights, guests,
      requestedType: room.type, requestedView: room.view,
      rate, source: BOOKING_SOURCE.DIRECT, roomId: room.id,
    });
    calendar.add(booking);
    added.push(booking);
  }
  return added;
}

export function inHouseAtOpen(calendar, day) {
  return calendar.live.filter((b) => b.roomId !== null
    && b.arrivalDay < day && b.departureDay >= day);
}
