/**
 * Hotel Career - the DOMAIN layer.
 *
 * Entities with identity, their own rules, and exact serialisation. Everything
 * in here is pure: no DOM, no wall clock, no randomness that is not seeded.
 *
 * WHY THIS EXISTS, in the operator's words: "in future a player has an epic tier
 * receptionist which he wants to sell or trade at the in-game market - it will
 * be a lot easier if everything is an object in the game."
 *
 * That is the right instinct and it has one hard technical consequence, which is
 * the rule every class in this folder obeys: **`toJSON` and `fromJSON` must
 * round-trip exactly.** An item that cannot be serialised, moved between
 * properties and reconstituted identically can never be traded, gifted,
 * inspected by a server, or shown in a market listing. Identity plus exact
 * serialisation is the whole feature; the classes are just how we get it.
 *
 * MIGRATION STATUS. This layer is being introduced alongside the existing
 * functional code, not in place of it, so the 140 tests and the measured balance
 * stay as a safety net throughout. Order of migration:
 *
 *   [x] Room        - types, views, floors, condition, the grade that prices them
 *   [x] Booking     - a claim on a room for a range of nights, plus allocation
 *   [x] Calendar    - the forward booking grid, stranding, and the desk's judgement
 *   [x] Clock       - one continuous timeline from day 1
 *   [x] Progression - experience, ranks, staff caps, and what each rank reveals
 *   [x] Timers      - duration scaled by career pace and property size
 *   [ ] StaffMember - tier, stamina, experience; the first tradeable item
 *   [ ] Outlet      - wraps the F&B model in engine.js
 *   [ ] Property    - absorbs property.js
 *   [ ] Hotel       - the aggregate root that owns all of the above
 */

export {
  Room, ROOM_TYPE, ROOM_TYPE_SPEC, VIEW, VIEW_SPEC, CONDITION, CONDITION_SPEC,
  CONDITION_LADDER, FEATURE, FEATURE_SPEC, ROOM_STATE, FULL_REVEAL, NO_REVEAL,
  floorPremium, FLOOR_PREMIUM_PER_LEVEL, FLOOR_PREMIUM_CAP, GROUND_FLOOR_PENALTY,
} from "./Room.js";

export {
  Booking, BOOKING_STATE, BOOKING_SOURCE, ALLOCATION_STRATEGY,
  evaluateAllocation, rankAllocations,
  UPSELL_CAPTURE, UPGRADE_SATISFACTION_PER_GRADE, DOWNGRADE_SATISFACTION_PER_GRADE,
  DOWNGRADE_COMPENSATION,
} from "./Booking.js";

export { Calendar, DEFAULT_HORIZON, DESK_FORESIGHT, judgeBooking } from "./Calendar.js";

export {
  Clock, PHASE, PHASE_BOUNDS, DAY_SECONDS_BY_LEVEL, daySeconds,
} from "./Clock.js";

/**
 * THE TIMETABLE. Every "what time of day does X happen" - the hours each day
 * covers, when guests arrive, when rooms are checked out, when the night shift
 * runs. One file, so a clock bug is one file. See Schedule.js.
 */
export {
  DAY_START_HOUR, GUARANTEE_HOUR, CHECKOUT_HOURS, ARRIVAL_HOURS, WALK_IN_HOURS,
  NIGHT_PREP_HOURS, EARLY_ARRIVAL_SHARE,
  dayWindow, dayHours, hourSeconds, hourAt, timeOfHour, dayCovers,
  shiftWindow, shiftHours, shiftCovers,
  arrivalTime, checkoutTime, patienceStartsAt, acceptsWalkIns, isNightShift,
} from "./Schedule.js";

export {
  Progression, LEVELS, MAX_LEVEL as MAX_RANK, XP,
  dayExperience, revealedAt, reveals, staffCap,
} from "./Progression.js";

export {
  duration, trainingDuration, humanDuration, pace, scale,
  PACE_BY_LEVEL, SCALE_PER_ROOM, SCALE_CAP, MINIMUM_SECONDS,
} from "./Timers.js";
