/**
 * Hotel Career - THE FORWARD BOOKING GRID.
 *
 * This is the thing the reservations desk actually is, and it is the single
 * largest piece of realism the game was missing. `DESIGN.md` section 11 records
 * the operator describing the real job and choosing to defer it; this is that
 * deferral being paid off.
 *
 * WHAT WAS WRONG BEFORE. The old desk asked one question - "is the house full
 * right now?" - and if the answer was no, it took the booking. That is not the
 * job. The job is forward-looking and it is made of questions the old model
 * could not even express:
 *
 *   - Is room 402 free on the 14th, and for all three nights, not just the first?
 *   - If I put this one-nighter in the only family room, does the four-night
 *     family booking I already hold become unhousable? (This is STRANDING, and
 *     it is the mistake that separates a trainee from a head of department.)
 *   - The house is full on Thursday but empty Wednesday and Friday. Do I take a
 *     three-night booking I can only half honour?
 *   - Am I better off refusing this booking than taking it and relocating them?
 *
 * The grid is what lets all of those be asked. Everything in here is pure and
 * works in DAY NUMBERS - it has no idea what a clock is.
 *
 * PERFORMANCE NOTE, because this runs on a phone: availability is computed by
 * walking the bookings, not by materialising a room x day matrix. A 30-room
 * hotel with a 30-day horizon would be 900 cells rebuilt on every keystroke;
 * walking the (far smaller) list of live bookings is cheaper and never goes
 * stale. `occupancyGrid` materialises one only when the UI asks to draw it.
 */

import { BOOKING_STATE, Booking, rankAllocations, ALLOCATION_STRATEGY } from "./Booking.js";
import { ROOM_STATE } from "./Room.js";

/** How far ahead the book is kept and drawn. Two weeks reads well on a phone. */
export const DEFAULT_HORIZON = 14;

export class Calendar {
  constructor(spec = {}) {
    /** @type {Map<string, Booking>} */
    this.bookings = new Map();
    for (const b of spec.bookings ?? []) {
      const booking = b instanceof Booking ? b : Booking.fromJSON(b);
      this.bookings.set(booking.id, booking);
    }
    this.horizon = spec.horizon ?? DEFAULT_HORIZON;
  }

  add(booking) {
    this.bookings.set(booking.id, booking);
    return booking;
  }

  get(id) { return this.bookings.get(id) ?? null; }

  remove(id) { return this.bookings.delete(id); }

  /** Every booking that still has a claim on a room. */
  get live() {
    return [...this.bookings.values()].filter((b) => b.active);
  }

  /** Bookings arriving on this day - the day's expected arrivals list. */
  arrivalsOn(day) {
    return this.live.filter((b) => b.arrivalDay === day)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Bookings whose last night was yesterday - this morning's departures. */
  departuresOn(day) {
    return [...this.bookings.values()]
      .filter((b) => b.state === BOOKING_STATE.IN_HOUSE && b.departureDay === day);
  }

  /** Bookings sleeping in the house on this night. */
  inHouseOn(day) {
    return this.live.filter((b) => b.occupies(day));
  }

  /** Heads sleeping in the house on this night - what F&B trades against. */
  headsOn(day) {
    return this.inHouseOn(day).reduce((total, b) => total + b.guests, 0);
  }

  /**
   * Is this room free for the WHOLE span? Not "free tonight" - the distinction
   * the old model could not draw and the one that causes every real overbooking.
   */
  isRoomFree(roomId, fromDay, nights, ignoreBookingId = null) {
    const until = fromDay + nights;
    for (const booking of this.live) {
      if (booking.roomId !== roomId) continue;
      if (booking.id === ignoreBookingId) continue;
      // Two ranges overlap unless one ends before the other starts.
      if (booking.arrivalDay < until && fromDay < booking.departureDay) return false;
    }
    return true;
  }

  /**
   * The rooms that could take this booking for its whole stay.
   *
   * A room out of service (being refurbished) is excluded for the whole span -
   * you cannot sell a room that is having its bathroom replaced, even on the
   * nights the builders are not in it.
   */
  availableRooms(rooms, fromDay, nights, { guests = 1, ignoreBookingId = null } = {}) {
    return rooms.filter((room) => !room.outOfInventory
      && room.couldFit(guests)
      && this.isRoomFree(room.id, fromDay, nights, ignoreBookingId));
  }

  /**
   * STRANDING - the question that makes this department a skill.
   *
   * Putting a guest in a room is not free even when the room is empty. If a
   * one-night booking takes the only room that can hold a four-night family
   * already on the books, that family now has nowhere to go, and you will find
   * out on the day.
   *
   * Returns the bookings that would become unhousable. An empty array means the
   * allocation is safe. Deliberately returns the CASUALTIES rather than a
   * boolean, so the UI can say "this strands the Wilsons, 4 nights from the
   * 14th" instead of greying a button out.
   */
  wouldStrand(rooms, booking, roomId) {
    const others = this.live
      .filter((b) => b.id !== booking.id && b.roomId === null)
      .sort((a, b) => b.nights - a.nights || b.guests - a.guests);

    // Provisionally place this booking, then try to house everyone else in
    // descending order of how hard they are to place. Longest and largest first
    // is the standard greedy allocation and it is what a human does by eye.
    const trial = new Calendar({ bookings: this.live.map((b) => b.clone()), horizon: this.horizon });
    const mine = trial.get(booking.id) ?? trial.add(booking.clone());
    mine.roomId = roomId;

    const stranded = [];
    for (const other of others) {
      const options = trial.availableRooms(rooms, other.arrivalDay, other.nights, {
        guests: other.guests,
      });
      if (options.length === 0) { stranded.push(other); continue; }
      // Take the tightest fit so the trial does not waste good rooms and
      // manufacture a stranding that would not really happen.
      const pick = rankAllocations(options, other, ALLOCATION_STRATEGY.TIGHTEST)[0];
      trial.get(other.id).roomId = pick.room.id;
    }
    return stranded;
  }

  /**
   * Can we accept a NEW booking for this span at all, and what does it cost us?
   *
   * This is what the reservations desk consults before saying yes. It is also
   * what the AI desk uses when it is answering the phone for you - see
   * `judgeBooking`.
   */
  assess(rooms, booking) {
    const options = this.availableRooms(rooms, booking.arrivalDay, booking.nights, {
      guests: booking.guests, ignoreBookingId: booking.id,
    });
    if (options.length === 0) {
      return { acceptable: false, reason: "no_room", options: [], stranded: [] };
    }
    const ranked = rankAllocations(options, booking, ALLOCATION_STRATEGY.TIGHTEST);
    const best = ranked[0];
    const stranded = this.wouldStrand(rooms, booking, best.room.id);
    return {
      acceptable: true,
      reason: stranded.length ? "strands_others" : "ok",
      options: ranked,
      stranded,
      best,
    };
  }

  /**
   * Put a guest in a room, and settle the money that allocation implies.
   *
   * `charge` decides what happens to a better room than the one booked: charge
   * for it (an upsell at the desk) or hand it over (goodwill). The whole point
   * of the operator's note is that BOTH are legitimate, so neither is default.
   */
  allocate(room, booking, { charge = false } = {}) {
    const outcome = rankAllocations([room], booking)[0];
    booking.roomId = room.id;
    if (outcome.direction === "upgrade" && charge) booking.upsell = outcome.upsellPrice;
    if (outcome.direction === "downgrade") booking.compensation = outcome.compensation;
    return {
      ...outcome,
      charged: outcome.direction === "upgrade" && charge,
      // Goodwill only lands if you did NOT charge for it. A guest who paid for
      // the upgrade got a fair trade, not a treat.
      satisfaction: outcome.direction === "upgrade" && charge ? 0 : outcome.satisfactionIfFree,
    };
  }

  /**
   * Occupancy as a room x day matrix, for drawing. Built on demand only.
   *
   * Each cell is null (free) or the booking id holding it, so the UI can colour
   * a continuous stay as one bar rather than N separate blocks - which is how a
   * real property management system draws it and the only way a grid is
   * readable at a glance.
   */
  occupancyGrid(rooms, fromDay, days = this.horizon) {
    const held = new Map();
    for (const booking of this.live) {
      if (booking.roomId === null) continue;
      for (const day of booking.nightsOccupied) {
        if (day < fromDay || day >= fromDay + days) continue;
        held.set(`${booking.roomId}:${day}`, booking.id);
      }
    }
    return rooms.map((room) => ({
      room,
      cells: Array.from({ length: days }, (_, i) => {
        const day = fromDay + i;
        const bookingId = held.get(`${room.id}:${day}`) ?? null;
        const booking = bookingId ? this.get(bookingId) : null;
        return {
          day,
          bookingId,
          booking,
          /** First night of a stay - where the UI draws the guest's name. */
          starts: booking ? booking.arrivalDay === day : false,
          outOfService: room.outOfInventory,
        };
      }),
    }));
  }

  /** Rooms sold versus rooms owned, per day. The number every hotelier reads first. */
  occupancyRate(rooms, day) {
    const sellable = rooms.filter((r) => !r.outOfInventory).length;
    if (sellable === 0) return 0;
    const sold = this.inHouseOn(day).filter((b) => b.roomId !== null).length;
    return Math.round((sold / sellable) * 100) / 100;
  }

  /** Bookings on the books with no room behind them - the desk's work queue. */
  unallocated() {
    return this.live.filter((b) => b.roomId === null)
      .sort((a, b) => a.arrivalDay - b.arrivalDay || b.nights - a.nights);
  }

  toJSON() {
    return {
      horizon: this.horizon,
      bookings: [...this.bookings.values()].map((b) => b.toJSON()),
    };
  }

  static fromJSON(data) { return new Calendar(data ?? {}); }
}

/**
 * THE RESERVATIONS DESK, v2 - a judgement instead of a coin flip.
 *
 * v1 rolled a die weighted by tier when the house was already full. It could not
 * see tomorrow, so it could not be wrong for the right reasons. This version
 * consults the grid, and TIER decides how far ahead the person can see:
 *
 *   Trainee        - checks the arrival night only. Will happily sell night one
 *                    of a three-night stay and create a relocation on night two.
 *   Experienced    - checks the whole span. Sound, but does not think about who
 *                    else is coming.
 *   Head of dept.  - checks the span AND whether accepting strands somebody
 *                    already on the books. This is the actual job.
 *
 * That is a far better upgrade story than "45% -> 95% accuracy", because the
 * player can SEE the difference in the mistakes each tier makes.
 */
export const DESK_FORESIGHT = {
  1: { nights: 1, checksStranding: false, label: "checks tonight only" },
  2: { nights: Infinity, checksStranding: false, label: "checks the whole stay" },
  3: { nights: Infinity, checksStranding: true, label: "checks the stay and the book" },
};

export function judgeBooking(calendar, rooms, booking, tier = 1) {
  const sight = DESK_FORESIGHT[tier] ?? DESK_FORESIGHT[1];
  const nights = Math.min(booking.nights, sight.nights);

  const options = calendar.availableRooms(rooms, booking.arrivalDay, nights, {
    guests: booking.guests,
  });
  if (options.length === 0) {
    return { accept: false, reason: "no_room", sawStranding: false };
  }
  if (sight.checksStranding) {
    const best = rankAllocations(options, booking, ALLOCATION_STRATEGY.TIGHTEST)[0];
    const stranded = calendar.wouldStrand(rooms, booking, best.room.id);
    if (stranded.length > 0) {
      return { accept: false, reason: "would_strand", sawStranding: true, stranded };
    }
  }
  return { accept: true, reason: "ok", sawStranding: sight.checksStranding };
}
