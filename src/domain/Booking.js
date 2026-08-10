/**
 * Hotel Career - THE BOOKING, and what it means to put a guest in a room.
 *
 * A booking is not "a guest arriving today". It is a claim on a SPECIFIC room
 * for a SPECIFIC RANGE OF NIGHTS, made before the guest exists on the property,
 * and it is the object the reservations desk actually works with.
 *
 * The old model had reservations that only knew `dueAt` - a moment inside one
 * simulated day. There was no tomorrow, so "is the room free on the 14th" was
 * not a question the code could ask, and the reservations department was
 * reduced to a coin flip on whether the house was full RIGHT NOW. This class and
 * `Calendar` are what make the real job possible.
 *
 * THE PART THE OPERATOR CARES ABOUT MOST: a booking is made for a room GRADE,
 * not a room. Which physical room a grade-2 booking ends up in is the front
 * office's decision, and it is worth real money in both directions:
 *
 *   - Put them somewhere better and say nothing: you have spent the premium you
 *     could have sold, and bought satisfaction and a better review.
 *   - Put them somewhere better and CHARGE for it at the desk: you have made
 *     margin out of a room that was going to sit empty anyway. This is an
 *     upsell, and it sells at a discount to rack because it is a last-minute
 *     impulse, not a planned purchase.
 *   - Put them somewhere worse: that is a downgrade, it costs you money in
 *     compensation and it costs you the review. Sometimes it is still the right
 *     call, because the alternative is turning them away entirely.
 *
 * All three are correct plays. Which is right depends on whether the hotel needs
 * the cash or the rating, and that is the decision the game is built around.
 */

import { ROOM_TYPE, ROOM_TYPE_SPEC, VIEW, VIEW_SPEC } from "./Room.js";

export const BOOKING_STATE = {
  /** On the books, guest has not arrived. */
  CONFIRMED: "confirmed",
  /** Arrived and checked in. */
  IN_HOUSE: "in_house",
  /** Stay completed. */
  DEPARTED: "departed",
  /** Guest cancelled before arrival. */
  CANCELLED: "cancelled",
  /** Never turned up. You held the room and sold nothing. */
  NO_SHOW: "no_show",
  /** Arrived, and the house could not house them. The expensive one. */
  RELOCATED: "relocated",
  /** Refused at the point of sale, on purpose. The cheap one. */
  DECLINED: "declined",
};

export const BOOKING_SOURCE = {
  DIRECT: "direct",
  PHONE: "phone",
  WALK_IN: "walk_in",
  AGENT: "agent",
};

/**
 * What the guest is prepared to accept, as opposed to what they paid for.
 *
 * `requestedType` is a hard requirement - a family of four booked a family room
 * and a twin will not do. `requestedView` is a preference: they will take
 * better without complaint and they will notice worse.
 */
export class Booking {
  constructor(spec = {}) {
    this.id = spec.id ?? `bk-${Math.floor(Math.random() * 1e9)}`;
    /** In-game day number the guest arrives. */
    this.arrivalDay = spec.arrivalDay ?? 1;
    this.nights = Math.max(1, spec.nights ?? 1);
    this.guests = Math.max(1, spec.guests ?? 2);

    this.requestedType = spec.requestedType ?? ROOM_TYPE.DOUBLE;
    this.requestedView = spec.requestedView ?? VIEW.COURTYARD;

    /** Agreed NIGHTLY rate. Fixed when the booking was taken, not at arrival. */
    this.rate = spec.rate ?? 0;
    this.source = spec.source ?? BOOKING_SOURCE.DIRECT;
    this.state = spec.state ?? BOOKING_STATE.CONFIRMED;

    /** The physical room. Null until front office allocates one. */
    this.roomId = spec.roomId ?? null;
    /** Extra charged at the desk for a room better than the one booked. */
    this.upsell = spec.upsell ?? 0;
    /** Paid out because we housed them worse than they booked. */
    this.compensation = spec.compensation ?? 0;

    /** Set when they actually arrive, for the welcome score. */
    this.waitedAtDesk = spec.waitedAtDesk ?? null;
    this.escorted = spec.escorted ?? false;
  }

  /** The night AFTER the last one they sleep - the day the room frees up. */
  get departureDay() { return this.arrivalDay + this.nights; }

  /** Every night this booking occupies, as day numbers. */
  get nightsOccupied() {
    const out = [];
    for (let d = this.arrivalDay; d < this.departureDay; d += 1) out.push(d);
    return out;
  }

  /** Does this booking hold a room on `day`? */
  occupies(day) { return day >= this.arrivalDay && day < this.departureDay; }

  /** Bookings that still need a room: confirmed or already in the building. */
  get active() {
    return this.state === BOOKING_STATE.CONFIRMED || this.state === BOOKING_STATE.IN_HOUSE;
  }

  /** What the room itself earns over the whole stay, before any upsell. */
  get roomRevenue() { return Math.round(this.rate * this.nights); }

  get totalRevenue() { return this.roomRevenue + this.upsell - this.compensation; }

  /** The grade of room this booking PAID for - the baseline an allocation is judged against. */
  get bookedMultiplier() {
    const type = ROOM_TYPE_SPEC[this.requestedType] ?? ROOM_TYPE_SPEC[ROOM_TYPE.DOUBLE];
    const view = VIEW_SPEC[this.requestedView] ?? VIEW_SPEC[VIEW.COURTYARD];
    return Math.round(type.rate * (1 + view.premium) * 1000) / 1000;
  }

  toJSON() {
    return {
      id: this.id, arrivalDay: this.arrivalDay, nights: this.nights, guests: this.guests,
      requestedType: this.requestedType, requestedView: this.requestedView,
      rate: this.rate, source: this.source, state: this.state, roomId: this.roomId,
      upsell: this.upsell, compensation: this.compensation,
      waitedAtDesk: this.waitedAtDesk, escorted: this.escorted,
    };
  }

  static fromJSON(data) { return new Booking(data); }

  clone() { return Booking.fromJSON(this.toJSON()); }
}

/* ------------------------------------------------------------ allocation -- */

/**
 * What happens when you put THIS booking in THAT room.
 *
 * Returns the whole picture rather than a boolean, because every field is a
 * thing the allocation screen should be able to show the player before they
 * commit: can it physically hold them, is it a step up or down, what could you
 * charge for the difference, and what will it do to the review if you give it
 * away instead.
 */

/**
 * An upsell at the desk sells for less than the same room sold in advance -
 * it is an impulse purchase against a room that was otherwise going to sit
 * empty, and the guest knows it.
 */
export const UPSELL_CAPTURE = 0.55;

/**
 * A free upgrade is worth more goodwill than its money, because the guest did
 * not expect it. This is the number that makes "chase the rating" a real
 * strategy rather than a slogan.
 */
export const UPGRADE_SATISFACTION_PER_GRADE = 9;

/** ...and a downgrade costs more than it saves, for exactly the same reason. */
export const DOWNGRADE_SATISFACTION_PER_GRADE = 14;

/** Compensation you owe per grade step down, as a share of the nightly rate. */
export const DOWNGRADE_COMPENSATION = 0.35;

export function evaluateAllocation(room, booking) {
  const delta = Math.round((room.rateMultiplier - booking.bookedMultiplier) * 1000) / 1000;
  const steps = delta / 0.1;                 // a "grade step" is 10% of base rate
  const nightly = Math.max(0, delta) * (booking.rate / Math.max(0.01, booking.bookedMultiplier));

  return {
    roomId: room.id,
    fits: room.fits(booking.guests),
    couldFit: room.couldFit(booking.guests),
    needsExtraBed: !room.fits(booking.guests) && room.couldFit(booking.guests),
    delta,
    /** Positive = better than booked, negative = worse. */
    direction: delta > 0.005 ? "upgrade" : delta < -0.005 ? "downgrade" : "as_booked",
    /** What you could ask at the desk for the difference, for the whole stay. */
    upsellPrice: Math.max(0, Math.round(nightly * booking.nights * UPSELL_CAPTURE)),
    /** What giving it away instead buys you in guest satisfaction. */
    satisfactionIfFree: delta > 0
      ? Math.round(steps * UPGRADE_SATISFACTION_PER_GRADE)
      : Math.round(steps * DOWNGRADE_SATISFACTION_PER_GRADE),
    /** What you owe them if this is worse than they booked. */
    compensation: delta < 0
      ? Math.round(Math.abs(delta) * booking.rate * booking.nights * DOWNGRADE_COMPENSATION)
      : 0,
  };
}

/**
 * Rank the rooms you COULD give this booking, best allocation first.
 *
 * "Best" is deliberately not "highest grade". The default strategy is TIGHTEST
 * FIT: give them the least valuable room that still honours what they booked,
 * and keep the sea-view suite free for somebody who will pay for it. That is
 * what a competent front office does, and it is the behaviour a player has to
 * consciously override when they decide to buy a rating instead.
 */
export const ALLOCATION_STRATEGY = {
  /** Protect the good rooms. The professional default. */
  TIGHTEST: "tightest",
  /** Give away the best room available. Buys reviews, spends money. */
  GENEROUS: "generous",
  /** Highest upsell opportunity - offer them the upgrade and charge for it. */
  UPSELL: "upsell",
};

export function rankAllocations(rooms, booking, strategy = ALLOCATION_STRATEGY.TIGHTEST) {
  const options = rooms
    .map((room) => ({ room, ...evaluateAllocation(room, booking) }))
    .filter((o) => o.couldFit);

  const byGrade = (a, b) => a.room.rateMultiplier - b.room.rateMultiplier;

  if (strategy === ALLOCATION_STRATEGY.GENEROUS) return options.sort((a, b) => byGrade(b, a));
  if (strategy === ALLOCATION_STRATEGY.UPSELL) {
    return options.sort((a, b) => b.upsellPrice - a.upsellPrice || byGrade(a, b));
  }
  // Tightest: honour the booking first (never downgrade if an equal exists),
  // then the cheapest room that does.
  return options.sort((a, b) => {
    const aOk = a.delta >= -0.005 ? 0 : 1;
    const bOk = b.delta >= -0.005 ? 0 : 1;
    return aOk - bOk || byGrade(a, b);
  });
}
