/**
 * Hotel Career - EXPERIENCE, LEVELS, AND WHAT EACH ONE UNLOCKS.
 *
 * WHAT THIS REPLACES. Levels used to be "shifts": you passed a profit target and
 * were handed the next job, a bigger house and another member of staff, all at
 * once. That is a level SELECT, not progression - and because each level shipped
 * its own room count and roster, the player's actual hotel was beside the point.
 *
 * Now a level is a rank YOU hold, earned by running the hotel, and it gates two
 * separate things:
 *
 *   1. HOW MUCH HOTEL YOU MAY OPERATE - how many people you can employ in each
 *      department, and therefore how big the property can usefully get. A
 *      one-man front desk cannot run twenty rooms, and the game should say so
 *      rather than let the player build into a wall they cannot see.
 *
 *   2. HOW MUCH OF THE SIMULATION IS VISIBLE. Room types, views, the forward
 *      booking grid and upselling are all running from day 1 - they are simply
 *      not SHOWN yet. The hotel does not change under the player at a level
 *      boundary; the instrumentation does. That is the operator's "simple early,
 *      complex later" without two different games underneath.
 *
 * Experience comes from operating, not from winning. You earn it by selling
 * nights, keeping guests happy and turning a profit - so a bad day is slower
 * progress, never a wall.
 */

/* ------------------------------------------------------------ earning XP -- */

/**
 * What each thing the hotel does is worth. Weighted so that RUNNING THE HOTEL
 * WELL beats running it big: a night sold to a happy guest is worth more than
 * two nights sold to unhappy ones.
 */
export const XP = {
  NIGHT_SOLD: 6,
  CHECK_IN: 4,
  /** Per whole star of the review, so a 5-star review pays five times a 1-star. */
  REVIEW_STAR: 5,
  /** Per $100 of profit on a settled day. */
  PROFIT_PER_100: 8,
  /** Getting a guest into a better room than they booked and being paid for it. */
  UPSELL: 12,
  /** Surviving a day at all. Small - presence is not achievement. */
  DAY_SETTLED: 15,

  /** ...and what it costs you. Mistakes are taught, not just penalised in cash. */
  WALKED_OUT: -20,
  RELOCATED: -45,
  COVER_TURNED_AWAY: -3,
};

/** Experience a settled day is worth, from the numbers that day produced. */
export function dayExperience(result) {
  const rating = result.rating ?? 0;
  return Math.max(0, Math.round(
    XP.DAY_SETTLED
    + (result.nightsSold ?? 0) * XP.NIGHT_SOLD
    + (result.checkedIn ?? 0) * XP.CHECK_IN
    + rating * XP.REVIEW_STAR
    + Math.max(0, (result.profit ?? 0) / 100) * XP.PROFIT_PER_100
    + (result.upsells ?? 0) * XP.UPSELL
    + (result.walkedOut ?? 0) * XP.WALKED_OUT
    + (result.overbooked ?? 0) * XP.RELOCATED
    + (result.coversTurnedAway ?? 0) * XP.COVER_TURNED_AWAY,
  ));
}

/* ------------------------------------------------------------- the ranks -- */

/**
 * A level needs BOTH experience and a property that justifies it. XP alone
 * would let somebody grind a tiny hotel to the top; requirements alone would let
 * a lucky windfall buy a rank. You have to have done the job AND built the
 * thing - which is what a real promotion is.
 *
 * `staffCaps` is the important half. It is what the operator asked for: the
 * level decides how many people you may employ, so "increase the size of
 * reception" is a promotion, not a purchase.
 */
export const LEVELS = {
  1: {
    title: "Receptionist",
    subtitle: "Eight rooms and you are the front desk.",
    xp: 0,
    requires: {},
    staffCaps: { reception: 1 },
    /**
     * TYPE AND CAPACITY FROM DAY ONE. Designer's correction: allocation is the
     * core decision and type is the PROMISE a booking makes. A player who
     * cannot see that 402 is a suite and 105 sleeps one is tapping doors, not
     * deciding. Hiding the mechanic is not easing into it.
     */
    reveals: ["roomType", "roomCondition"],
  },
  2: {
    title: "Head receptionist",
    subtitle: "Somebody else works the desk. You decide who sleeps where.",
    xp: 260,
    requires: { rooms: 8, rating: 3.0 },
    staffCaps: { reception: 1, bellboy: 1, housekeeping: 1 },
    /**
     * THE VIEW, AND THE UPGRADE ECONOMY WITH IT - moved down from rank 3.
     *
     * Gating views later meant the first ranks taught "rooms are
     * interchangeable", which the player then has to UNLEARN - far more
     * expensive than learning late. `arrivalsList` is the step before the full
     * grid: the concept early, the tool late.
     */
    reveals: ["roomView", "allocation", "upsell", "arrivalsList"],
  },
  3: {
    title: "Duty manager",
    subtitle: "The floor runs itself. The rate and the room list are yours.",
    xp: 900,
    requires: { rooms: 12, rating: 3.5, facilities: ["breakfast"] },
    staffCaps: { reception: 2, bellboy: 1, housekeeping: 2, maintenance: 1, chef: 1, waiter: 1 },
    reveals: ["roomFloor"],
  },
  4: {
    title: "Front office manager",
    subtitle: "You are selling rooms you have not got yet.",
    xp: 2600,
    requires: { rooms: 16, rating: 4.0, facilities: ["breakfast", "restaurant"] },
    staffCaps: {
      reception: 3, bellboy: 2, housekeeping: 3, maintenance: 2,
      reservations: 1, chef: 2, waiter: 3, bartender: 1,
    },
    // THE FORWARD GRID - the rank at which reservations becomes the game rather
    // than a coin flip. "A beginner handed a spreadsheet learns nothing"
    // survived review; this gate stays.
    reveals: ["forwardGrid", "stranding"],
  },
  5: {
    title: "General manager",
    subtitle: "Every department reports to you. So does every mistake.",
    xp: 7000,
    requires: { rooms: 22, rating: 4.3, facilities: ["breakfast", "restaurant", "bar"] },
    staffCaps: {
      reception: 4, bellboy: 3, housekeeping: 5, maintenance: 3,
      reservations: 2, chef: 3, waiter: 4, bartender: 2,
    },
    reveals: ["roomFeatures", "yieldManagement"],
  },
};

export const MAX_LEVEL = 5;

/** Everything revealed at or below this level, as a set. */
export function revealedAt(level) {
  const out = new Set();
  for (let l = 1; l <= Math.min(level, MAX_LEVEL); l += 1) {
    for (const key of LEVELS[l].reveals) out.add(key);
  }
  return out;
}

export function reveals(level, feature) {
  return revealedAt(level).has(feature);
}

/** How many of this trade the player's rank permits. Zero means not yet. */
export function staffCap(level, role) {
  const caps = LEVELS[Math.max(1, Math.min(MAX_LEVEL, level))].staffCaps;
  return caps[role] ?? 0;
}

/**
 * The FIRST rank that may employ this trade at all. Null if no rank ever can.
 *
 * B2: locked departments were hidden with no statement of when they open, and
 * where a reason was shown it was wrong - `hireBlocker` said "a
 * <next rank> may take one on", which is only true for the trades that happen to
 * unlock on the very next step. A rank-1 player was told a Head receptionist
 * could employ a reservations manager. Reservations does not appear in any
 * `staffCaps` until rank 4.
 */
export function unlocksAt(role) {
  for (let level = 1; level <= MAX_LEVEL; level += 1) {
    if (staffCap(level, role) > 0) return level;
  }
  return null;
}

export class Progression {
  constructor(spec = {}) {
    this.level = spec.level ?? 1;
    this.experience = spec.experience ?? 0;
    /** Lifetime total, never spent. What a profile screen would show. */
    this.lifetime = spec.lifetime ?? spec.experience ?? 0;
  }

  get rank() { return LEVELS[this.level]; }
  get next() { return LEVELS[this.level + 1] ?? null; }

  award(amount) {
    const gained = Math.max(0, Math.round(amount));
    this.experience += gained;
    this.lifetime += gained;
    return gained;
  }

  /**
   * Everything still standing between the player and their next rank, said in
   * the terms they can act on. Returns an empty array when they are ready.
   */
  blockers(property) {
    const next = this.next;
    if (!next) return [];
    const gaps = [];
    if (this.experience < next.xp) {
      gaps.push({
        kind: "experience",
        text: `${next.xp - this.experience} more experience`,
        have: this.experience, need: next.xp,
      });
    }
    const need = next.requires;
    if (need.rooms && (property.rooms ?? 0) < need.rooms) {
      gaps.push({
        kind: "rooms",
        text: `${need.rooms} rooms (you have ${property.rooms ?? 0})`,
        have: property.rooms ?? 0, need: need.rooms,
      });
    }
    if (need.rating && (property.rating ?? 0) < need.rating) {
      gaps.push({
        kind: "rating",
        text: `a ${need.rating.toFixed(1)} rating (you are at ${(property.rating ?? 0).toFixed(1)})`,
        have: property.rating ?? 0, need: need.rating,
      });
    }
    for (const facility of need.facilities ?? []) {
      if (!(property.facilities ?? []).includes(facility)) {
        gaps.push({ kind: "facility", text: `a ${facility.replace(/_/g, " ")}` });
      }
    }
    return gaps;
  }

  canPromote(property) {
    return this.next !== null && this.blockers(property).length === 0;
  }

  /**
   * Take the promotion. Experience is NOT spent - it is a record of what you
   * have done, not a currency. Spending it would mean a general manager and a
   * receptionist could show the same number, which is nonsense.
   */
  promote(property) {
    if (!this.canPromote(property)) return false;
    this.level += 1;
    return true;
  }

  toJSON() {
    return { level: this.level, experience: this.experience, lifetime: this.lifetime };
  }

  static fromJSON(data) { return new Progression(data ?? {}); }
}
