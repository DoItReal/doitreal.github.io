/**
 * Hotel Career - THE ROOM.
 *
 * The first real domain object, and the template for every one after it.
 *
 * WHY THIS IS A CLASS AND THE REST OF THE GAME IS NOT (yet). A room used to be a
 * plain object inside a shift: `{ id, beds, state }`, regenerated from scratch
 * every day. That is fine while every room is identical. It stops being fine the
 * moment room 402 is a sea-view junior suite that a player has refurbished twice
 * and may one day want to show off, trade, or be told is worth more than 401.
 * An entity with identity, its own rules, and its own serialisation is what that
 * needs, and it is what the whole codebase is migrating toward.
 *
 * THE THREE RULES EVERY DOMAIN CLASS FOLLOWS:
 *   1. NO NON-ASCII. Same as the rest of the project.
 *   2. NO WALL CLOCK. Nothing in here reads Date.now(). Time arrives as an
 *      argument or as a day number.
 *   3. `toJSON` / `fromJSON` ROUND-TRIP EXACTLY. This is not politeness - it is
 *      the requirement that makes an item tradeable later. If a room cannot be
 *      serialised, handed to another system and reconstituted identically, it
 *      can never leave the property it was built in.
 *
 * WHAT A HOTELIER KNOWS THAT THE OLD MODEL DID NOT:
 *
 * Two rooms with the same bed count are not the same product. 402 faces the sea
 * on the fourth floor and 108 faces an airshaft next to the lift. They cost the
 * same to clean and they sell for wildly different money, and deciding WHO GETS
 * WHICH is the daily judgement call that front office actually makes. Give the
 * sea view away to a guest who booked interior and you have spent real money on
 * goodwill; sell it to them at check-in and you have made margin out of nothing.
 * Both are correct plays. Which one is right depends on whether you need the
 * cash or the rating - and that is the decision this class exists to enable.
 */

/* ------------------------------------------------------------- taxonomy -- */

/**
 * Room types, as a small hotel actually books them. Capacity is people, not
 * beds: a double sleeps two in one bed, a twin sleeps two in two.
 *
 * `rate` is the multiplier on the house's base rate for this type alone, before
 * any view, floor or condition premium. A suite at 2.4x a standard double is
 * about right for a city hotel and is deliberately at the conservative end.
 */
export const ROOM_TYPE = {
  SINGLE: "single",
  DOUBLE: "double",
  TWIN: "twin",
  FAMILY: "family",
  JUNIOR_SUITE: "junior_suite",
  SUITE: "suite",
};

export const ROOM_TYPE_SPEC = {
  [ROOM_TYPE.SINGLE]: { label: "Single", beds: 1, capacity: 1, rate: 0.75, extraBeds: 0 },
  [ROOM_TYPE.DOUBLE]: { label: "Double", beds: 1, capacity: 2, rate: 1.0, extraBeds: 1 },
  [ROOM_TYPE.TWIN]: { label: "Twin", beds: 2, capacity: 2, rate: 1.0, extraBeds: 1 },
  [ROOM_TYPE.FAMILY]: { label: "Family", beds: 2, capacity: 4, rate: 1.35, extraBeds: 1 },
  [ROOM_TYPE.JUNIOR_SUITE]: {
    label: "Junior suite", beds: 1, capacity: 3, rate: 1.7, extraBeds: 1,
  },
  [ROOM_TYPE.SUITE]: { label: "Suite", beds: 2, capacity: 4, rate: 2.4, extraBeds: 2 },
};

/**
 * THE VIEW. The operator called this out as one of the most important things in
 * the game, and they are right: it is the largest single price differentiator
 * between two otherwise identical rooms, and it costs nothing to run.
 *
 * Premiums are ADDITIVE fractions of the type rate. An interior room is a
 * genuine discount - guests know an airshaft when they see one - which is what
 * makes "we only have an interior left" a real problem rather than a shrug.
 */
export const VIEW = {
  INTERIOR: "interior",
  COURTYARD: "courtyard",
  CITY: "city",
  GARDEN: "garden",
  POOL: "pool",
  SEA: "sea",
};

export const VIEW_SPEC = {
  [VIEW.INTERIOR]: { label: "Interior", premium: -0.08, prestige: 0 },
  [VIEW.COURTYARD]: { label: "Courtyard", premium: 0.0, prestige: 1 },
  [VIEW.CITY]: { label: "City", premium: 0.08, prestige: 2 },
  [VIEW.GARDEN]: { label: "Garden", premium: 0.12, prestige: 3 },
  [VIEW.POOL]: { label: "Pool", premium: 0.18, prestige: 4 },
  [VIEW.SEA]: { label: "Sea", premium: 0.32, prestige: 5 },
};

/**
 * Condition, which is what refurbishment moves. A tired room is not a broken
 * room - it is perfectly sellable and it quietly costs you rate and reviews,
 * which is exactly how tired rooms work in life.
 */
export const CONDITION = {
  TIRED: "tired",
  STANDARD: "standard",
  REFURBISHED: "refurbished",
  PREMIUM: "premium",
};

export const CONDITION_SPEC = {
  [CONDITION.TIRED]: { label: "Tired", premium: -0.12, review: -0.7 },
  [CONDITION.STANDARD]: { label: "Standard", premium: 0.0, review: 0 },
  [CONDITION.REFURBISHED]: { label: "Refurbished", premium: 0.1, review: 0.6 },
  [CONDITION.PREMIUM]: { label: "Premium", premium: 0.2, review: 1.0 },
};

/** The order refurbishment walks. Nothing skips a step. */
export const CONDITION_LADDER = [
  CONDITION.TIRED, CONDITION.STANDARD, CONDITION.REFURBISHED, CONDITION.PREMIUM,
];

/**
 * Optional features. Kept as a set rather than flags so adding "connecting" or
 * "pet friendly" later does not change the shape of a saved room.
 */
export const FEATURE = {
  BALCONY: "balcony",
  ACCESSIBLE: "accessible",
  QUIET: "quiet",
  CORNER: "corner",
};

export const FEATURE_SPEC = {
  [FEATURE.BALCONY]: { label: "Balcony", premium: 0.07 },
  [FEATURE.ACCESSIBLE]: { label: "Accessible", premium: 0.0 },
  [FEATURE.QUIET]: { label: "Quiet", premium: 0.04 },
  [FEATURE.CORNER]: { label: "Corner", premium: 0.05 },
};

/** Housekeeping / engineering state. Unchanged in meaning from the old model. */
export const ROOM_STATE = {
  CLEAN: "clean",
  OCCUPIED: "occupied",
  DIRTY: "dirty",
  BROKEN: "broken",
  /** Taken out of inventory on purpose - refurbishment, or a long repair. */
  OUT_OF_SERVICE: "out_of_service",
};

/**
 * A higher floor is quieter and sees further, and the ground floor next to
 * reception is the room nobody wants. Capped so a tower does not run away.
 */
export const FLOOR_PREMIUM_PER_LEVEL = 0.022;
export const FLOOR_PREMIUM_CAP = 0.11;
export const GROUND_FLOOR_PENALTY = -0.03;

export function floorPremium(floor) {
  if (floor <= 0) return GROUND_FLOOR_PENALTY;
  return Math.min(FLOOR_PREMIUM_CAP, floor * FLOOR_PREMIUM_PER_LEVEL);
}

/* ----------------------------------------------------------------- room -- */

export class Room {
  /**
   * @param {object} spec
   * @param {string} spec.id     Stable identity. Survives saves, and is what a
   *                             future trade or transfer would move.
   * @param {number} spec.number Door number, e.g. 402. Floor is derived from it
   *                             unless given, because that is how buildings work.
   */
  constructor(spec = {}) {
    this.id = spec.id ?? `room-${spec.number ?? 0}`;
    this.number = spec.number ?? 101;
    this.floor = spec.floor ?? Math.floor(this.number / 100);
    this.type = spec.type ?? ROOM_TYPE.DOUBLE;
    this.view = spec.view ?? VIEW.COURTYARD;
    this.condition = spec.condition ?? CONDITION.STANDARD;
    this.features = new Set(spec.features ?? []);

    this.state = spec.state ?? ROOM_STATE.CLEAN;
    /** An extra bed physically wheeled in. Raises capacity, costs linen. */
    this.extraBeds = spec.extraBeds ?? 0;
    /** Set while a guest is in residence; null otherwise. */
    this.bookingId = spec.bookingId ?? null;

    /** Remembered for the review: how the guest FOUND the room on arrival. */
    this.arrivedDirty = spec.arrivedDirty ?? false;
    this.arrivedBroken = spec.arrivedBroken ?? false;
  }

  get spec() { return ROOM_TYPE_SPEC[this.type]; }

  get label() { return `${this.number}`; }

  /** People this room can sleep, including any extra bed already in it. */
  get capacity() { return this.spec.capacity + this.extraBeds; }

  /** How many more beds could physically be wheeled in. */
  get spareBedSlots() { return Math.max(0, this.spec.extraBeds - this.extraBeds); }

  /** The most people this room could EVER take, if you wheeled beds in. */
  get maxCapacity() { return this.spec.capacity + this.spec.extraBeds; }

  /**
   * THE NUMBER EVERYTHING ELSE HANGS OFF.
   *
   * What this room is worth as a multiple of the house's base rate. Type is
   * multiplicative (a suite is a different product); view, floor, condition and
   * features are additive premiums on top of it (they modify the same product).
   * That is the right shape: a sea view is worth proportionally more on a suite
   * than on a single, which is true.
   */
  get rateMultiplier() {
    const premium = VIEW_SPEC[this.view].premium
      + floorPremium(this.floor)
      + CONDITION_SPEC[this.condition].premium
      + [...this.features].reduce((sum, f) => sum + (FEATURE_SPEC[f]?.premium ?? 0), 0);
    return Math.round(this.spec.rate * (1 + premium) * 1000) / 1000;
  }

  /**
   * The grade a guest perceives, 0..100. Used to rank rooms against each other
   * for upgrades and to decide whether an allocation is a treat or an insult.
   * Deliberately derived from the same premiums as the rate, so a room that
   * costs more is a room that feels better - no second table to keep in sync.
   */
  get grade() {
    return Math.round(Math.max(0, Math.min(100, this.rateMultiplier * 38)));
  }

  /** What this room does to the guest's opinion of the ROOM itself, before service. */
  get reviewModifier() {
    return CONDITION_SPEC[this.condition].review
      + (VIEW_SPEC[this.view].prestige - 2) * 0.16;
  }

  get sellable() {
    return this.state === ROOM_STATE.CLEAN;
  }

  get outOfInventory() {
    return this.state === ROOM_STATE.OUT_OF_SERVICE;
  }

  /** Can this room physically sleep a party of `guests` right now? */
  fits(guests) { return this.capacity >= guests; }

  /** ...and could it, if somebody wheeled a bed in? */
  couldFit(guests) { return this.maxCapacity >= guests; }

  /**
   * Move one step up the condition ladder. This is what a completed
   * refurbishment does, and it is why refurbishing a tired room is worth more
   * than refurbishing a standard one.
   */
  improve() {
    const at = CONDITION_LADDER.indexOf(this.condition);
    if (at >= 0 && at < CONDITION_LADDER.length - 1) {
      this.condition = CONDITION_LADDER[at + 1];
    }
    return this;
  }

  /** Rooms tire. Called by the season/maintenance model, not by the day. */
  wear() {
    const at = CONDITION_LADDER.indexOf(this.condition);
    if (at > 0) this.condition = CONDITION_LADDER[at - 1];
    return this;
  }

  describe(reveal = FULL_REVEAL) {
    const parts = [];
    if (reveal.type) parts.push(this.spec.label);
    if (reveal.view) parts.push(`${VIEW_SPEC[this.view].label.toLowerCase()} view`);
    if (reveal.condition && this.condition !== CONDITION.STANDARD) {
      parts.push(CONDITION_SPEC[this.condition].label.toLowerCase());
    }
    return parts.join(", ") || "Room";
  }

  toJSON() {
    return {
      id: this.id, number: this.number, floor: this.floor, type: this.type,
      view: this.view, condition: this.condition, features: [...this.features],
      state: this.state, extraBeds: this.extraBeds, bookingId: this.bookingId,
      arrivedDirty: this.arrivedDirty, arrivedBroken: this.arrivedBroken,
    };
  }

  static fromJSON(data) { return new Room(data); }

  clone() { return Room.fromJSON(this.toJSON()); }
}

/**
 * WHAT THE PLAYER IS ALLOWED TO SEE YET.
 *
 * The operator asked for the early levels to stay simple and the later ones to
 * get progressively deeper. Rather than building two room models, ONE model is
 * always simulated and the UI is told how much of it to reveal. A level-1 player
 * sees eight rooms; a level-4 player sees that 402 is a sea-view junior suite on
 * the top floor. Nothing about the simulation changes underneath them, so their
 * hotel does not silently become a different hotel at a level boundary.
 */
export const FULL_REVEAL = {
  number: true, type: true, view: true, floor: true, condition: true, features: true,
};

export const NO_REVEAL = {
  number: true, type: false, view: false, floor: false, condition: false, features: false,
};
