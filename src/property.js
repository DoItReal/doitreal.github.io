/**
 * Hotel Career - the PROPERTY: persistent capital, building work, and the hours
 * the hotel runs while nobody is watching.
 *
 * `engine.js` simulates one day of hands-on work. This file owns everything that
 * survives that day: the rooms you have paid for, the facilities you have built,
 * the money in the bank, and the clock that keeps running after you close the
 * tab.
 *
 * SAME TWO RULES AS THE REST OF THE PROJECT:
 *   1. NO NON-ASCII anywhere in this file.
 *   2. PURE. No DOM, and NO WALL CLOCK - every function that cares about time
 *      takes `now` (epoch milliseconds) as an argument. The caller owns
 *      `Date.now()`. That is what makes eight offline hours testable in a
 *      millisecond, and it is why the offline economy can be swept headlessly
 *      instead of guessed at.
 *
 * THE OPERATOR'S MODEL, which this implements literally:
 *
 *   "Nothing stops between days. The game starts with the first login and the
 *    first check-in. If the player has no staff at all the hotel is CLOSED while
 *    he is away. If it has enough staff to automate the base - reception,
 *    reservations, housekeeping, maintenance - the game continues. The time he
 *    went offline is recorded, and when he comes back he receives up to EIGHT
 *    HOURS of what he would have made, MINUS a discount for running without
 *    supervision. A General Manager reduces that discount; reaching parity needs
 *    a rewarded ad or the premium pack."
 *
 * Note what that shape buys us: supervised play is always strictly better than
 * idling, so the idle layer feeds the core loop rather than replacing it. If
 * offline ever paid 100% by default there would be no reason to open the game.
 */

import {
  FACILITY, FNB_ROLES, ROLE, TIERS,
  evaluateStars, fairCheque, isFnbRole, outletBrigade,
} from "./engine.js";
import { createHouse, describeHouse, nextRoom, SITE } from "./domain/Floorplan.js";
import { Room, ROOM_STATE } from "./domain/Room.js";
import { Clock, daySeconds } from "./domain/Clock.js";
import { DAY_SOURCE, describeAbsence, settleTimeline } from "./domain/Timeline.js";
import { Calendar } from "./domain/Calendar.js";
import {
  LEVELS, Progression, dayExperience, staffCap, unlocksAt,
} from "./domain/Progression.js";
import {
  createLedger, dayRow, exportLedger, guestRow, guestsOn, recordDay, recordGuests, report,
} from "./domain/Ledger.js";
import { duration as scaledDuration, trainingDuration } from "./domain/Timers.js";
import {
  BOOK_HORIZON, fillBook, rollBook, seedOpeningGuests,
} from "./domain/Bookings.js";
import {
  DEPARTMENT_GOALS, emptyCareer, isUnlocked, nextDepartment, unlockProgress,
} from "./domain/Unlocks.js";

/* ------------------------------------------------------------- building -- */

export const BUILD_KIND = {
  ROOM: "room", FACILITY: "facility", REFURB: "refurb", TRAINING: "training",
};

/** A room already on the books, taken out of service to be brought up to date. */
export const REFURB = "refurb";
export const ROOM = "room";

/**
 * The starting house: eight rooms, nothing else. Everything below has to be
 * paid for out of days actually worked.
 */
export const STARTING_ROOMS = 8;

/**
 * WHAT IS IN THE TILL ON THE MORNING YOU OPEN. The operator's figure:
 * "maybe 50$ in the bank. And thats all."
 *
 * It is not a starting budget, it is a float, and that is the point of it -
 * $50 is roughly one trainee's day. It says, without a line of text, that the
 * hotel cannot pay a wage until it has taken some money, which is why the first
 * check-in matters and why the first hire is a goal rather than a purchase.
 * It was $0 before, so this is more generous than what shipped, not less.
 */
export const STARTING_BANK = 50;

/**
 * HOW FULL THE HOTEL IS ON THE MORNING IT OPENS. Zero: it opens today.
 *
 * Was 0.55, which gave day 1 four check-outs to teach on. The operator directed
 * a cold open on 2026-08-10 with the cost measured and in front of them - day 1
 * loses every check-out, and the check-out lesson moves to day 2. What replaces
 * it is the opening morning: see Schedule.OPENING_PREP_HOURS.
 *
 * Kept as a constant rather than a deleted branch because reversing it is this
 * one number - see maintainBook and docs/DAY1-COLD-OPEN.md.
 */
export const OPENING_OCCUPANCY = 0;

/**
 * Rooms get dearer as the property grows - you run out of easy space long before
 * you run out of ambition. Compounding at 10% per room turns the 30-room 5-star
 * into a genuine long haul (about $32k of rooms alone) without needing a
 * separate late-game currency.
 */
export const ROOM_BASE_COST = 650;
export const ROOM_COST_GROWTH = 1.1;

/** Real seconds of work. These are wall-clock, which is the whole point. */
export const HOUR = 3600;

export const BUILD_CATALOG = {
  [ROOM]: {
    label: "Build a room",
    note: "More rooms is the only way to sell more nights.",
    kind: BUILD_KIND.ROOM,
    seconds: 6 * HOUR,
    repeatable: true,
    requires: [],
  },
  [REFURB]: {
    label: "Refurbish a room",
    note: "Out of inventory while the work runs. Comes back reviewing better.",
    kind: BUILD_KIND.REFURB,
    cost: 320,
    seconds: 2 * HOUR,
    repeatable: true,
    requires: [],
  },
  [FACILITY.BREAKFAST]: {
    label: "Breakfast service",
    note: "Required for 2 stars.",
    kind: BUILD_KIND.FACILITY,
    cost: 900,
    seconds: 3 * HOUR,
    requires: [],
  },
  [FACILITY.BAR]: {
    label: "Bar",
    note: "Required for 3 stars.",
    kind: BUILD_KIND.FACILITY,
    cost: 2200,
    seconds: 10 * HOUR,
    // A bar stands on its own - it is not an extension of the breakfast room.
    requires: [],
  },
  [FACILITY.RESTAURANT]: {
    label: "Restaurant",
    note: "Required for 3 stars. The single biggest jump in what you may charge.",
    kind: BUILD_KIND.FACILITY,
    cost: 4200,
    seconds: 24 * HOUR,
    requires: [FACILITY.BREAKFAST],
  },
  [FACILITY.LAUNDRY]: {
    label: "Laundry",
    note: "Required for 4 stars.",
    kind: BUILD_KIND.FACILITY,
    cost: 1800,
    seconds: 8 * HOUR,
    requires: [],
  },
  [FACILITY.ROOM_SERVICE]: {
    label: "Room service",
    note: "Required for 4 stars. Needs a kitchen to serve from.",
    kind: BUILD_KIND.FACILITY,
    cost: 1500,
    seconds: 6 * HOUR,
    requires: [FACILITY.RESTAURANT],
  },
  [FACILITY.CONCIERGE_DESK]: {
    label: "Concierge desk",
    note: "Required for 5 stars.",
    kind: BUILD_KIND.FACILITY,
    cost: 2600,
    seconds: 10 * HOUR,
    requires: [],
  },
  [FACILITY.SPA]: {
    label: "Spa",
    note: "Required for 5 stars. Two days of building work.",
    kind: BUILD_KIND.FACILITY,
    cost: 9000,
    seconds: 48 * HOUR,
    requires: [FACILITY.LAUNDRY],
  },
};

/* ---------------------------------------------------------------- house -- */

/**
 * THE HOUSE - the property's rooms as real objects.
 *
 * `property.rooms` used to be the whole story: an integer. It is still there,
 * because a hundred call sites read it and it is genuinely the number a player
 * asks for most often, but it is now DERIVED - the invariant
 * `property.rooms === property.house.length` holds after every mutation, and a
 * test asserts it. Anything that changes the house goes through `setHouse` so
 * that invariant cannot rot.
 *
 * Why keep the integer at all: `roomCost`, `certification`, `complexity` and the
 * star requirements all want a count and nothing else. Making them all say
 * `.house.length` would be churn without meaning.
 */
export function setHouse(property, rooms) {
  property.house = rooms;
  property.rooms = rooms.length;
  property.upgradedRooms = rooms.filter((room) => room.condition !== "standard"
    && room.condition !== "tired").length;
  return property;
}

/** Every room the property owns. Never null - an empty house is an empty array. */
export function houseOf(property) {
  return property.house ?? [];
}

/** One room by its stable id, or by INDEX for the older call sites. */
export function roomById(property, roomId) {
  const house = houseOf(property);
  if (typeof roomId === "number") return house[roomId] ?? null;
  return house.find((room) => room.id === roomId) ?? null;
}

/** The rooms you can actually sell tonight, as objects rather than a count. */
export function sellableRoomList(property) {
  return houseOf(property).filter((room) => !room.outOfInventory);
}

export { describeHouse };

/* --------------------------------------------------------------- money -- */

/**
 * What the property can actually spend.
 *
 * Cash AND bank, because a small hotelier pays the builder out of the till if
 * the till is what they have. Keeping them apart on the SCREEN is the point;
 * keeping them apart when deciding whether you can afford something would just
 * be an obstacle, and on day 1 - when everything you own is cash a guest handed
 * you an hour ago - it would be a wall.
 */
export function spendable(property) {
  return (property.bank ?? 0) + (property.cash ?? 0);
}

/**
 * Pay for something. Notes first, then the bank - you spend what is in the till
 * before you make a transfer.
 */
export function spend(property, amount) {
  const fromCash = Math.min(property.cash ?? 0, amount);
  property.cash = (property.cash ?? 0) - fromCash;
  property.bank = (property.bank ?? 0) - (amount - fromCash);
  return property;
}

/**
 * THE NIGHT AUDIT. Every hotel does this and it is where the day's takings stop
 * being notes in a drawer and become money in an account.
 */
export function nightAudit(property) {
  const next = copy(property);
  next.bank += next.cash ?? 0;
  next.cash = 0;
  return next;
}

/** What the NEXT room costs, given how many the property already owns. */
export function roomCost(rooms) {
  const beyondStart = Math.max(0, rooms - STARTING_ROOMS);
  return Math.round(ROOM_BASE_COST * Math.pow(ROOM_COST_GROWTH, beyondStart));
}

export function buildCost(property, key) {
  if (key === ROOM) return roomCost(property.rooms);
  const spec = BUILD_CATALOG[key];
  return spec ? spec.cost : 0;
}

export function buildSeconds(key) {
  const spec = BUILD_CATALOG[key];
  return spec ? spec.seconds : 0;
}

/* -------------------------------------------------------------- hiring --- */

/**
 * HIRING A DEPARTMENT.
 *
 * The career ladder staffs a department each time you are promoted out of it -
 * but it never staffs the LAST one, because that is the job you are doing. The
 * reservations desk was therefore unreachable: offline coverage capped at 80%
 * with no way to close the gap, because you cannot promote past the top.
 *
 * So departments are hireable directly. You may only hire a department you have
 * worked yourself, which is what stops a level-1 player buying their way past
 * the levels that teach the game.
 *
 * Note what hiring your OWN current department does: they do not take work off
 * you while you are on the floor (the day excludes whatever role you are
 * covering), but they DO hold the desk while you are away. Which is exactly what
 * a reservations manager is for.
 */
export const RECRUITMENT_FEE = {
  [ROLE.RECEPTION]: 150,
  [ROLE.BELLBOY]: 120,
  [ROLE.HOUSEKEEPING]: 140,
  [ROLE.MAINTENANCE]: 180,
  [ROLE.RESERVATIONS]: 220,   // a desk that costs you money when it is wrong
  // A chef is the hardest hire in a small hotel and everybody in the trade
  // knows it. Waiters turn over constantly and cost almost nothing to find.
  [ROLE.CHEF]: 320,
  [ROLE.WAITER]: 90,
  [ROLE.BARTENDER]: 140,
};

/** The title of the next rank, for the "not yet" message. */
function LEVELS_TITLE(level) {
  const rank = LEVELS[Math.min(level, 5)];
  return rank ? rank.title.toLowerCase() : "manager";
}

export function recruitmentFee(role) {
  return RECRUITMENT_FEE[role] ?? 150;
}

/**
 * How many people you may employ in one department.
 *
 * One, for everything on the career ladder: two receptionists is two people
 * behind one desk, and the day only ever has one desk. The kitchen and the
 * floor are the exception - a second waiter is literally how a restaurant
 * serves more covers, and capping F&B at one person would make the capacity
 * model pointless.
 */
export const MAX_PER_DEPARTMENT = 1;
export const MAX_PER_FNB_DEPARTMENT = 4;

export function departmentCap(role) {
  return isFnbRole(role) ? MAX_PER_FNB_DEPARTMENT : MAX_PER_DEPARTMENT;
}

export function staffCount(property, role) {
  return property.roster.filter((person) => person.role === role).length;
}

export function hireBlocker(property, role) {
  if (!Object.values(ROLE).includes(role)) return "No such department.";
  const employed = staffCount(property, role);

  /**
   * YOUR RANK DECIDES HOW MUCH HOTEL YOU MAY OPERATE.
   *
   * The operator's ask: "depending on what level is the player he can hire more
   * staff, increase the size of reception". So growing the front desk is a
   * PROMOTION, not a purchase - which is also why a level-1 player cannot buy
   * their way past the levels that teach the game.
   */
  const rankCap = staffCap(rankOf(property).level, role);
  if (rankCap === 0) {
    // NAME THE RANK THAT ACTUALLY OPENS IT. This used to say "a <next rank> may
    // take one on", which is only true for trades unlocking on the very next
    // step: a rank-1 player was told a Head receptionist could employ a
    // reservations manager, and no rank below Front office manager can. B2 was
    // not only that locked departments were hidden - the one reason the game did
    // give was wrong.
    const at = unlocksAt(role);
    return at ? `From ${LEVELS[at].title}. Your rank cannot employ one.`
      : "No rank can employ one.";
  }
  if (employed >= rankCap) {
    return `${employed} is all your rank allows. Promotion raises it.`;
  }

  if (employed >= departmentCap(role)) {
    return isFnbRole(role)
      ? `You already employ ${employed}. That is as many as the outlet can use.`
      : "That department is already staffed.";
  }
  /**
   * YOU OPEN A DEPARTMENT BY DOING ITS WORK. See domain/Unlocks.js.
   *
   * This used to be `learnedRoles.includes(role)` - a list the player never saw,
   * filled in by the ladder rather than by them. The operator could not tell what
   * would open the next department and ended up using the dev panel to force it.
   * Now the condition is a goal with a number on it: ten check-ins and $300 for
   * the receptionist, and so on. The blocker text IS the instruction.
   *
   * F&B is exempt, as before: an owner hires a chef, they never train as one.
   */
  if (!isFnbRole(role)) {
    const progress = unlockProgress(property.career, role);
    if (!progress.met) return progress.gaps.map((g) => g.text).join(", ");
  }
  const fee = recruitmentFee(role);
  if (spendable(property) < fee) return `Costs $${fee}; you hold $${spendable(property)}.`;
  return null;
}

export function canHire(property, role) {
  return hireBlocker(property, role) === null;
}

export function hire(property, role) {
  const blocker = hireBlocker(property, role);
  if (blocker) throw new Error(blocker);
  const next = copy(property);
  spend(next, recruitmentFee(role));
  next.roster.push({ role, tier: 1 });
  return next;
}

/**
 * Every position you are allowed to fill right now - what the hire list shows.
 *
 * Rooms-side: departments you have worked yourself and not yet staffed. F&B:
 * any trade an outlet you have BUILT actually needs, up to the headcount that
 * outlet can use. There is no point offering a bartender to a hotel with no bar.
 */
export function openPositions(property) {
  const ladder = (property.learnedRoles || []).filter((role) => !findStaff(property, role));
  const wanted = new Set();
  for (const facility of property.facilities) {
    for (const role of outletBrigade(facility)) wanted.add(role);
  }
  const kitchen = FNB_ROLES.filter((role) => wanted.has(role)
    && staffCount(property, role) < departmentCap(role));
  return [...ladder, ...kitchen];
}

/**
 * THE DEPARTMENTS THAT ARE NOT OPEN TO YOU YET, and exactly what opens them.
 *
 * B2. `openPositions` lists only what you may fill right now, and the staff
 * screen showed nothing else - so a rank-1 player saw one hire and no ladder.
 * No statement that housekeeping exists, that it opens at Head receptionist, or
 * that reservations is three ranks away. A locked door with a rank written on it
 * is a goal; a locked door with nothing on it is a wall, and the player assumes
 * the game is smaller than it is.
 *
 * ROOMS-SIDE ONLY. F&B trades follow the OUTLET, not the career ladder - there
 * is no point telling a hotel with no bar that it cannot employ a bartender.
 */
/** Re-exported so callers have one import for "what opens a department". */
export { DEPARTMENT_GOALS, unlockProgress, isUnlocked, nextDepartment };

/**
 * Bank experience and the jobs behind it, as they happen. Returns a NEW property.
 * `game.js` calls this every frame with the deltas since the last call.
 */
export function recordWork(property, { experience = 0, career = {}, profit = 0 } = {}) {
  if (!experience && !profit && Object.keys(career).length === 0) return property;
  const next = copy(property);
  const rank = rankOf(next);
  if (experience) rank.award(experience);
  const banked = { ...emptyCareer(), ...(next.career ?? {}) };
  for (const [key, value] of Object.entries(career)) {
    banked[key] = (banked[key] ?? 0) + value;
  }
  banked.profit = Math.max(0, (banked.profit ?? 0) + profit);
  next.career = banked;
  next.progression = rank.toJSON();
  return next;
}

export function lockedDepartments(property) {
  const level = rankOf(property).level;
  const learned = property.learnedRoles || [];
  const locked = [];
  for (const role of Object.values(ROLE)) {
    if (isFnbRole(role)) continue;
    if (findStaff(property, role)) continue;
    const capped = staffCap(level, role) === 0;
    if (!capped && learned.includes(role)) continue;
    const opensAt = unlocksAt(role);
    locked.push({
      role,
      opensAt,
      // Rank first, because it is the one the player cannot act on today. Being
      // told to work a job yourself when your rank could not employ one anyway
      // is an instruction that leads nowhere.
      reason: capped
        ? (opensAt ? `From ${LEVELS[opensAt].title}` : "Never offered")
        : "Work that job yourself first",
    });
  }
  return locked;
}

/* ---------------------------------------------------------------- menu --- */

/**
 * How far off the fair cheque a player may set a menu price. Wider than the
 * room-rate band because the downside here is a real operational one - an empty
 * dining room you are still paying a brigade to stand in - rather than a cap.
 */
export const MENU_BAND = { min: 0.5, max: 2.0 };

export function menuBand(outlet, stars) {
  const fair = fairCheque(outlet, stars);
  return {
    fair,
    min: Math.max(1, Math.round(fair * MENU_BAND.min)),
    max: Math.round(fair * MENU_BAND.max),
  };
}

/** What this outlet currently charges. Absent means "whatever is fair". */
export function menuPrice(property, outlet, stars) {
  const set = (property.menu || {})[outlet];
  return set === undefined || set === null ? fairCheque(outlet, stars) : Math.round(set);
}

export function setMenuPrice(property, outlet, price, stars) {
  const band = menuBand(outlet, stars);
  const next = copy(property);
  next.menu[outlet] = Math.max(band.min, Math.min(band.max, Math.round(price)));
  return next;
}

/* ------------------------------------------------------------ training --- */

/**
 * TRAINING RAISES SKILL, NEVER STAMINA.
 *
 * Already a logged decision: you cannot send a person on a course and get back
 * more constitution. Training moves TIER - how fast and how well they work, and
 * what they cost - and leaves the innate stamina they were hired with alone.
 *
 * The real cost of training is not the fee, it is the ABSENCE. Send somebody on
 * a course and that department is dark until they are back, which is why remote
 * training exists: they stay on the floor, but they learn more slowly because
 * they are working at the same time. Cheaper in cover, dearer in weeks.
 */
export const TRAINING = { ON_SITE: "on_site", REMOTE: "remote" };

/** Hours of course to reach the tier being trained INTO, at full attendance. */
export const TRAINING_HOURS = { 2: 8, 3: 20 };

/**
 * Remote training takes this much longer for the same tier. This is what "grants
 * less experience" means when tier is the only skill axis: the same course, less
 * absorbed per hour, because they are answering the phone through it.
 */
export const REMOTE_TRAINING_MULTIPLIER = 1.8;

export function trainingSeconds(toTier, mode) {
  const base = (TRAINING_HOURS[toTier] || 0) * HOUR;
  return mode === TRAINING.REMOTE ? Math.round(base * REMOTE_TRAINING_MULTIPLIER) : base;
}

/**
 * Whoever holds this department. Where a trade has several people - the kitchen
 * and the floor - this is the LEAST trained of them, because that is who a
 * course is for and who the staff screen should be offering to send.
 */
export function findStaff(property, role) {
  return property.roster
    .filter((person) => person.role === role)
    .reduce((lowest, person) => (!lowest || person.tier < lowest.tier ? person : lowest), null);
}

/** How many of this trade are on an on-site course and therefore not working. */
export function awayCount(property, role) {
  return property.builds.filter((b) => b.kind === BUILD_KIND.TRAINING
    && b.role === role && b.mode === TRAINING.ON_SITE).length;
}

/** Is this department short-handed because somebody is on a course? */
export function isAway(property, role) {
  return awayCount(property, role) > 0;
}

/**
 * The people actually available to work.
 *
 * Used for BOTH the day's roster and the offline coverage, because a department
 * whose only person is on a course is dark either way - that is the whole cost
 * of on-site training, and it has to bite in both places or it is not a cost.
 *
 * It removes ONE person per course, not the whole trade. With a single-person
 * department those are the same thing; with three waiters and one of them at
 * college they are emphatically not, and the earlier version shut the whole
 * restaurant for the duration.
 */
export function availableRoster(property) {
  const budget = {};
  for (const person of property.roster) {
    if (budget[person.role] === undefined) budget[person.role] = awayCount(property, person.role);
  }
  return property.roster.filter((person) => {
    if (budget[person.role] > 0) { budget[person.role] -= 1; return false; }
    return true;
  });
}

export function trainingBlocker(property, role, mode) {
  const person = findStaff(property, role);
  if (!person) return "Nobody in that department to train.";
  const toTier = person.tier + 1;
  if (!TIERS[toTier]) return "Already at the top of their trade.";
  const onCourse = property.builds.filter((b) => b.kind === BUILD_KIND.TRAINING
    && b.role === role).length;
  // You may have several people in a trade, but you cannot send more of them on
  // a course than you employ.
  if (onCourse >= staffCount(property, role)) return "Already on a course.";
  const cost = TIERS[person.tier].upgradeCost;
  if (spendable(property) < cost) return `Costs $${cost}; you hold $${spendable(property)}.`;
  if (mode === TRAINING.ON_SITE && availableRoster(property).length <= 1
    && property.roster.length > 1) {
    // Not a hard rule, just the honest warning that you are stripping the floor.
    return null;
  }
  return null;
}

export function canTrain(property, role, mode) {
  return trainingBlocker(property, role, mode) === null;
}

export function startTraining(property, role, mode, now) {
  const blocker = trainingBlocker(property, role, mode);
  if (blocker) throw new Error(blocker);

  const person = findStaff(property, role);
  const toTier = person.tier + 1;
  const cost = TIERS[person.tier].upgradeCost;
  const seconds = trainingDuration(trainingSeconds(toTier, mode), rankOf(property).level);

  const next = copy(property);
  spend(next, cost);
  next.builds.push({
    id: next.nextBuildId,
    key: `training:${role}`,
    kind: BUILD_KIND.TRAINING,
    label: `${role} to ${TIERS[toTier].name}`,
    cost,
    role,
    mode,
    toTier,
    roomId: null,
    startedAt: now,
    readyAt: now + seconds * 1000,
  });
  next.nextBuildId += 1;
  return next;
}

/* ------------------------------------------------------------- offline --- */

/**
 * The four departments that let the hotel run itself. Weighted, because they are
 * not equally load-bearing: nobody gets a key without a receptionist, whereas a
 * missing maintenance man costs you the occasional room rather than the day.
 * Weights sum to 1.
 */
export const AUTOMATION_WEIGHT = {
  [ROLE.RECEPTION]: 0.4,
  [ROLE.HOUSEKEEPING]: 0.28,
  [ROLE.RESERVATIONS]: 0.2,
  [ROLE.MAINTENANCE]: 0.12,
};

export const AUTOMATION_ROLES = Object.keys(AUTOMATION_WEIGHT);

/** Eight hours. Longer than a night's sleep, shorter than a working day. */
export const OFFLINE_CAP_SECONDS = 8 * HOUR;

/**
 * One real hour away = one business day run without you. This is the exchange
 * rate between the wall clock and the simulated day, and it is the single number
 * that decides whether the idle layer is a trickle or a replacement for playing.
 * At the level-3 target of $400 net a day, a full unsupervised eight hours pays
 * roughly $400 x 8 x 0.55 = $1760 - about two fifths of a restaurant. Enough to
 * be worth coming back for, nowhere near enough to build the hotel for you.
 */
export const OFFLINE_SECONDS_PER_DAY = HOUR;

/**
 * The unsupervised discount, as a multiplier on what supervised play earns.
 *
 * FLOOR is a skeleton crew, CEILING is all four departments staffed. Neither
 * reaches 1: a hotel running without its owner leaves money on the desk, and
 * that gap is the reason to open the game.
 */
export const OFFLINE_FLOOR = 0.15;
export const OFFLINE_CEILING = 0.55;

/** Each General Manager level claws back some of the gap. */
export const GM_STEP = 0.05;
/** ...but management alone tops out here. Parity is a boost, never a hire. */
export const OFFLINE_MAX_UNBOOSTED = 0.8;

/**
 * How much of the base the current roster covers, 0..1. Several people in one
 * department do not cover it twice.
 */
export function automationCoverage(roster) {
  const filled = new Set(roster.map((person) => person.role));
  let covered = 0;
  for (const role of AUTOMATION_ROLES) {
    if (filled.has(role)) covered += AUTOMATION_WEIGHT[role];
  }
  return Math.round(covered * 1000) / 1000;
}

/** Which departments are dark - the list the return screen should show. */
export function automationGaps(roster) {
  const filled = new Set(roster.map((person) => person.role));
  return AUTOMATION_ROLES.filter((role) => !filled.has(role));
}

/**
 * A SMALL, SIMPLE HOUSE NEEDS LESS WATCHING.
 *
 * Eight rooms and a breakfast bar genuinely does run itself for a morning; a
 * thirty-room four-star with a restaurant, a bar, room service and a spa does
 * not, and every operator who has tried to leave one alone knows it. So the
 * unsupervised discount is not a flat number - it starts generous and tightens
 * as the property grows.
 *
 * This is also the answer to a real playtest complaint: at a flat 55%, the
 * first hotel a player owns pays too little on return to be worth coming back
 * for, precisely when the game most needs them to come back. Making the early
 * property nearly self-running fixes that WITHOUT paying for performance that
 * was not demonstrated - the rate it multiplies is still the measured one.
 */
export const OFFLINE_SIMPLE_BONUS = 0.22;
/** Rooms at which a property counts as fully complex for this purpose. */
export const COMPLEXITY_ROOMS = 26;

export function complexity(property) {
  const rooms = Math.max(0, (property.rooms || 0) - STARTING_ROOMS)
    / Math.max(1, COMPLEXITY_ROOMS - STARTING_ROOMS);
  const outlets = (property.facilities || []).length / 7;
  return Math.max(0, Math.min(1, rooms * 0.65 + outlets * 0.35));
}

/** The multiplier applied to unsupervised hours, before any ad or pack boost. */
export function supervisionFactor(property) {
  // Available, not employed: somebody on a course is not covering their desk.
  const coverage = automationCoverage(availableRoster(property));
  if (coverage === 0) return 0;
  const base = OFFLINE_FLOOR + (OFFLINE_CEILING - OFFLINE_FLOOR) * coverage;
  // The simplicity bonus is earned by COVERAGE too - an unstaffed small hotel
  // is not self-running, it is shut.
  const simple = OFFLINE_SIMPLE_BONUS * (1 - complexity(property)) * coverage;
  return Math.min(OFFLINE_MAX_UNBOOSTED,
    base + simple + (property.gmLevel || 0) * GM_STEP);
}

/**
 * What a day of this hotel is worth, MEASURED - never assumed.
 *
 * The rate comes from days the player has actually settled, so the offline
 * economy cannot pay out for performance that was never demonstrated. A property
 * that has never finished a day accrues nothing, and a property whose days do
 * not cover their own payroll accrues nothing either - you do not come back to a
 * debt, but you do not get paid for losing money.
 */
export const RATE_SAMPLE_DAYS = 5;

export function measuredNetPerDay(property) {
  // WORKED days only. An unsupervised day is a payout, not a measurement - see
  // the `unmeasured` note in settleDay.
  const days = property.days.filter((d) => d.unmeasured !== true).slice(-RATE_SAMPLE_DAYS);
  if (days.length === 0) return 0;
  const total = days.reduce((sum, day) => sum + day.net, 0);
  return Math.max(0, total / days.length);
}

/**
 * What the hotel made while the player was away.
 *
 * `boostSeconds` is offline time already paid for at full rate by a rewarded ad
 * or the premium pack. It is applied to the FRONT of the window, so a boost is
 * worth the same whether it was banked before leaving or claimed on return.
 *
 * Returns a report, not a mutation - `claimOffline` is what actually moves money.
 */
export function offlineReport(property, now, options = {}) {
  const boostSeconds = Math.max(0, options.boostSeconds || 0);
  const elapsed = Math.max(0, (now - property.lastSeenAt) / 1000);
  const onDuty = availableRoster(property);

  const empty = {
    elapsedSeconds: elapsed, paidSeconds: 0, cappedSeconds: 0,
    coverage: automationCoverage(onDuty), gaps: automationGaps(onDuty),
    factor: 0, netPerDay: measuredNetPerDay(property), boostedSeconds: 0,
    earned: 0, hoursPastCap: 0, forgoneToSupervision: 0, closed: false,
    allAway: false, reason: null,
  };

  if (property.openedAt === null) {
    return { ...empty, reason: "not_open" };
  }
  // Nobody who can open the doors: they stayed locked the whole time. A brigade
  // on its own does NOT keep a hotel trading - a chef cannot check anybody in -
  // so this is measured against the automation departments, not the headcount.
  if (automationCoverage(onDuty) === 0) {
    const roomsSide = property.roster.filter((person) => !isFnbRole(person.role));
    return {
      ...empty,
      closed: true,
      // Either nobody is on the payroll at all, or everyone you have is away on
      // a course - a distinction the return card should draw, because the fix
      // is different.
      allAway: roomsSide.length > 0,
      reason: roomsSide.length > 0 ? "all_away" : "closed",
    };
  }
  if (empty.netPerDay <= 0) {
    return { ...empty, reason: "no_measured_day" };
  }

  const paid = Math.min(elapsed, OFFLINE_CAP_SECONDS);
  const factor = supervisionFactor(property);
  const boosted = Math.min(paid, boostSeconds);
  const plain = paid - boosted;
  const perSecond = empty.netPerDay / OFFLINE_SECONDS_PER_DAY;

  const earned = Math.round(perSecond * (boosted + plain * factor));
  const supervised = perSecond * paid;

  return {
    ...empty,
    paidSeconds: paid,
    cappedSeconds: Math.max(0, elapsed - paid),
    factor,
    boostedSeconds: boosted,
    earned,
    // WHAT SUPERVISION WAS WORTH, inside the window the game actually pays for.
    // Bounded by the cap, so it is a real, closeable gap and an honest reason to
    // hire a manager.
    forgoneToSupervision: Math.round(supervised - earned),
    /**
     * Hours past the cap, as HOURS - deliberately not as money.
     *
     * This used to be priced, and it was the single most misleading number on
     * the screen: skip forty-eight hours and the game told the player it had
     * cost them $15,793. That is not a loss - the hotel was never going to pay
     * for two unattended days - it is a manufactured regret, and inventing one
     * to sell a boost is exactly the dark pattern the charter forbids. The
     * hours are still stated, because "the cap held" IS information the player
     * needs; the imaginary dollar value is gone.
     */
    hoursPastCap: Math.round((Math.max(0, elapsed - paid) / 3600) * 10) / 10,
    reason: earned > 0 ? "earned" : "nothing",
  };
}

/* -------------------------------------------------------------- the state -- */

export function createProperty(now, options = {}) {
  return {
    /** Set by the first check-in. Until then there is no hotel to run. */
    openedAt: options.openedAt ?? null,
    lastSeenAt: now,
    /** The opening float. See STARTING_BANK - $50, and it is meant to be tight. */
    bank: options.bank ?? STARTING_BANK,
    /**
     * THE TILL. Money guests have handed over in notes, today.
     *
     * Separate from the bank because they behave differently and because the
     * operator asked for it: cash is in your hand the moment a guest pays and
     * it is what a small hotel lives on; card settles to the bank, and the bank
     * is what a contractor is paid from. The night audit moves one to the other.
     */
    cash: options.cash ?? 0,
    rating: options.rating ?? 3.5,
    rooms: options.rooms ?? STARTING_ROOMS,
    /**
     * What the front desk does with a better room than the guest booked:
     * protect it, sell it, or hand it over. A standing policy rather than a
     * prompt on every arrival - see UPSELL_POLICY in engine.js.
     */
    upsellPolicy: options.upsellPolicy ?? "protect",
    /**
     * What the building looks out at. Chosen once and never changed - it is the
     * single biggest reason two hotels of the same size are worth different
     * money, and the player should discover it about their own building.
     */
    site: options.site ?? SITE.CITY,
    /**
     * The house the CAREER has handed you so far, as opposed to the house you
     * have paid for. Remembered separately so a promotion adds rooms on top of
     * the ones you built instead of overwriting them - see applyCareerBaseline.
     */
    baselineRooms: options.baselineRooms ?? options.rooms ?? STARTING_ROOMS,
    /** Rooms brought up to date. They review better; they are still rooms. */
    upgradedRooms: options.upgradedRooms ?? 0,
    facilities: options.facilities ? [...options.facilities] : [],
    roster: options.roster ? options.roster.map((p) => ({ ...p })) : [],
    /**
     * The department the OWNER works personally.
     *
     * It counts for certification - an inspector does not care that the person
     * on the desk owns the building - but deliberately NOT for offline coverage,
     * because the owner is exactly who is not there. That asymmetry is the whole
     * reason a one-person hotel is a real 1-star and still shut when you leave.
     */
    ownerRole: options.ownerRole ?? null,
    /** Departments the player has worked themselves, and may therefore hire. */
    learnedRoles: options.learnedRoles ? [...options.learnedRoles] : [],
    /**
     * The menu. What the player charges per cover in each outlet, keyed by
     * FACILITY. An outlet absent from here trades at its fair cheque, which is
     * what a new restaurant opens at until somebody decides otherwise.
     */
    menu: options.menu ? { ...options.menu } : {},
    /** Work in progress. Contractors do not stop because you logged out. */
    builds: [],
    /** Settled days, newest last. The ONLY source of the offline rate. */
    days: [],
    gmLevel: options.gmLevel ?? 0,
    nextBuildId: 1,
    /**
     * ONE CONTINUOUS TIMELINE. The hotel opens on day 1 and the clock never
     * stops - see domain/Clock.js. Stored as plain JSON so the property stays a
     * plain object for the rest of the migration.
     */
    clock: options.clock ?? new Clock({
      startedAt: now, day: options.day ?? 1, level: options.level ?? 1,
    }).toJSON(),
    /**
     * The highest day number already in the ledger. Settlement is idempotent
     * against this, which is what lets both the live loop and the return path
     * call it without a day ever paying twice.
     */
    lastSettledDay: options.lastSettledDay ?? 0,
    /**
     * The highest day already PAID IN EXPERIENCE. Deliberately separate from
     * `lastSettledDay`: the money for a day can be banked by the offline path
     * while the player was in fact at the desk, and they are still owed the
     * experience for having worked it. See awardWorkedDay in game.js.
     */
    lastAwardedDay: options.lastAwardedDay ?? 0,
    /**
     * NIGHT-SHIFT WORK BANKED FOR TOMORROW. See NIGHT_PREP in engine.js: keys
     * cut and paperwork laid out overnight make the next morning's check-ins
     * quicker. It survives the day because that is the entire point of it.
     */
    preppedFor: options.preppedFor ?? 0,
    /**
     * WHAT THE PLAYER HAS ACTUALLY DONE, counted as they do it. This is what
     * opens departments - see domain/Unlocks.js - and it is updated live from
     * the floor rather than at settle, because a goal you cannot watch move is
     * not a goal.
     */
    career: { ...emptyCareer(), ...(options.career ?? {}) },
    /**
     * THE FORWARD BOOK. Reservations for days that have not happened yet, which
     * is what makes the reservations department a job rather than a coin flip.
     * Stored as plain JSON; `bookOf` hands back a real Calendar.
     */
    book: options.book ?? { horizon: BOOK_HORIZON, bookings: [] },
    /**
     * THE PLAYER'S RANK. Earned by operating, not by passing a level. It gates
     * how many people you may employ and how much of the simulation is shown -
     * see domain/Progression.js.
     */
    progression: options.progression ?? new Progression({ level: options.level ?? 1 }).toJSON(),
    /**
     * THE BOOKS. One itemised row per trading day plus the guest register -
     * see domain/Ledger.js. Plain JSON on purpose: this is the shape that moves
     * to a real database without being rewritten.
     */
    ledger: options.ledger ?? createLedger(),
    /**
     * The rooms themselves. Generated deterministically from the seed so that a
     * save with no house in it - every save written before today - reconstructs
     * the house it always implicitly had, identically, every time.
     */
    house: options.house
      ? options.house.map((r) => (r instanceof Room ? r.clone() : Room.fromJSON(r)))
      : createHouse(options.rooms ?? STARTING_ROOMS, {
        site: options.site ?? SITE.CITY,
        seed: options.houseSeed ?? 20260809,
        upgraded: options.upgradedRooms ?? 0,
      }),
  };
}

function copy(property) {
  return {
    ...property,
    // Rooms are entities, so they are CLONED, not shared. A copied property that
    // shared its rooms would let a rejected build mutate the live house.
    house: houseOf(property).map((room) => room.clone()),
    menu: { ...(property.menu || {}) },
    facilities: [...property.facilities],
    learnedRoles: [...(property.learnedRoles || [])],
    roster: property.roster.map((p) => ({ ...p })),
    builds: property.builds.map((b) => ({ ...b })),
    days: property.days.map((d) => ({ ...d })),
  };
}

/** The hotel exists from the first guest handed a key, not from install. */
export function open(property, now) {
  if (property.openedAt !== null) return property;
  const next = copy(property);
  next.openedAt = now;
  next.lastSeenAt = now;
  return next;
}

/* --------------------------------------------------------------- rooms --- */

/**
 * Rooms you can actually sell tonight. A room being built does not exist yet and
 * a room being refurbished is out of service - which is the operational cost of
 * improving the place, and is meant to be felt.
 */
export function sellableRooms(property) {
  return sellableRoomList(property).length;
}

/** Rooms under construction - owned on paper, not yet on the floor. */
export function roomsUnderConstruction(property) {
  return property.builds.filter((b) => b.kind === BUILD_KIND.ROOM).length;
}

/* --------------------------------------------------------------- builds -- */

/**
 * Why this build cannot start, or null if it can. Returning the REASON rather
 * than a boolean is what lets the build screen say "you need the restaurant
 * first" instead of greying a row out silently.
 */
export function buildBlocker(property, key, options = {}) {
  const spec = BUILD_CATALOG[key];
  if (!spec) return "No such build.";

  const already = new Set(property.facilities);
  if (spec.kind === BUILD_KIND.FACILITY && already.has(key)) return "Already built.";
  if (!spec.repeatable && property.builds.some((b) => b.key === key)) {
    return "Already under way.";
  }
  for (const need of spec.requires) {
    if (!already.has(need)) {
      const label = BUILD_CATALOG[need] ? BUILD_CATALOG[need].label : need.replace(/_/g, " ");
      return `Needs ${label} first.`;
    }
  }
  if (spec.kind === BUILD_KIND.REFURB) {
    // You cannot refurbish the last room you have left to sell.
    if (sellableRooms(property) <= 1) return "No room to spare - build another first.";
    if (options.roomId !== undefined) {
      const room = roomById(property, options.roomId);
      if (!room) return "Every room is already up to date.";
      if (room.condition === "premium") return "That room is already as good as it gets.";
      if (property.builds.some((b) => b.roomId === options.roomId)) {
        return "That room is already being worked on.";
      }
    }
  }
  const cost = buildCost(property, key);
  if (spendable(property) < cost) return `Costs $${cost}; you hold $${spendable(property)}.`;
  return null;
}

export function canBuild(property, key, options = {}) {
  return buildBlocker(property, key, options) === null;
}

/**
 * Commission work. Money leaves the bank NOW - a deposit to a builder is gone
 * whether or not you like the result - and the job lands on the queue with a
 * real finish time.
 */
export function startBuild(property, key, now, options = {}) {
  const blocker = buildBlocker(property, key, options);
  if (blocker) throw new Error(blocker);

  const spec = BUILD_CATALOG[key];
  const cost = buildCost(property, key);
  const next = copy(property);
  spend(next, cost);
  /**
   * THE CATALOGUE TIME IS NOT THE WAIT.
   *
   * Scaled by career pace and property size - see domain/Timers.js. A 24-hour
   * restaurant is 29 minutes for a beginner and 13 hours for a general manager
   * with 30 rooms, which is the operator's "nobody wants a 24hr timer in the
   * first ten minutes" answered without lying about what the catalogue says.
   *
   * This was written and tested days before it was connected to anything, and
   * a 40-day playthrough is what caught it: the starting hotel was still at one
   * star on day 40 because a three-hour breakfast room takes eighteen level-1
   * days to build if nothing scales it.
   */
  const seconds = scaledDuration(spec.seconds, rankOf(property).level, property.rooms);
  next.builds.push({
    id: next.nextBuildId,
    key,
    kind: spec.kind,
    label: spec.label,
    cost,
    roomId: options.roomId ?? null,
    startedAt: now,
    readyAt: now + seconds * 1000,
  });
  next.nextBuildId += 1;

  // A room being refurbished is OUT of inventory from the moment the builders
  // are booked, not from when they turn up. That is the operational cost of
  // improving the place and it is meant to be felt.
  if (spec.kind === BUILD_KIND.REFURB && options.roomId !== undefined) {
    const room = roomById(next, options.roomId);
    if (room) room.state = ROOM_STATE.OUT_OF_SERVICE;
  }
  return next;
}

export function buildRemainingSeconds(build, now) {
  return Math.max(0, (build.readyAt - now) / 1000);
}

export function buildProgress(build, now) {
  const total = build.readyAt - build.startedAt;
  if (total <= 0) return 1;
  return Math.max(0, Math.min(1, (now - build.startedAt) / total));
}

/**
 * Bring the queue forward to `now` and hand back what finished.
 *
 * Called on every return to the app, so eight offline hours of building land in
 * one step. Completions are returned rather than announced, because the caller
 * is the only thing that knows whether to toast them or list them on a card.
 */
export function advanceBuilds(property, now) {
  const next = copy(property);
  const completed = [];
  const stillRunning = [];

  for (const build of next.builds) {
    if (now < build.readyAt) { stillRunning.push(build); continue; }
    completed.push(build);
    if (build.kind === BUILD_KIND.ROOM) {
      // A finished room is a real door with a number, not an increment.
      const room = nextRoom(houseOf(next), { site: next.site, seed: next.openedAt ?? 1 });
      setHouse(next, [...houseOf(next), room]);
      build.roomId = room.id;
    } else if (build.kind === BUILD_KIND.REFURB) {
      const room = roomById(next, build.roomId) ?? houseOf(next).find((r) => r.outOfInventory);
      if (room) {
        room.improve();
        room.state = ROOM_STATE.CLEAN;
      }
      setHouse(next, houseOf(next));
    } else if (build.kind === BUILD_KIND.TRAINING) {
      // The least trained of that trade is the one who went, so they are the
      // one who comes back qualified.
      const person = findStaff(next, build.role);
      // Tier only. Stamina is innate and is deliberately not touched here.
      if (person) person.tier = Math.max(person.tier, build.toTier);
    } else if (build.kind === BUILD_KIND.FACILITY && !next.facilities.includes(build.key)) {
      next.facilities.push(build.key);
    }
  }
  next.builds = stillRunning;
  return { property: next, completed };
}

/**
 * Take time off a job.
 *
 * This is the honest rewarded placement described in DESIGN 3/LATER: the player
 * is ALREADY waiting and genuinely wants the wait shorter, so the ad is a favour
 * rather than a toll. The maintenance manager grants some of this free, which is
 * why `source` is recorded - a free speed-up and a paid one must be tellable
 * apart when the playtest data comes back.
 */
export function speedUpBuild(property, buildId, seconds, now, source = "free") {
  const next = copy(property);
  const build = next.builds.find((b) => b.id === buildId);
  if (!build) throw new Error(`No build ${buildId}`);
  build.readyAt = Math.max(now, build.readyAt - seconds * 1000);
  build.speedUps = [...(build.speedUps || []), { seconds, source, at: now }];
  return next;
}

/** Free seconds the maintenance department shaves off a build, per tap. */
export function maintenanceSpeedUpSeconds(property) {
  const person = property.roster.find((p) => p.role === ROLE.MAINTENANCE);
  if (!person) return 0;
  return 60 * person.tier;   // one minute at trainee, three at head of department
}

/* --------------------------------------------------- settling and stars --- */

/**
 * Bank a finished day. `net` is takings minus wages, exactly as `score()` reports
 * it, so the offline rate is derived from the same number the player was shown.
 */
export function settleDay(property, day, now) {
  const next = copy(property);
  /**
   * ROOM MONEY HAS ALREADY LANDED. It went into the till and the bank as each
   * guest paid, which is the whole point of the change - the player watches it
   * climb instead of waiting for midnight. So settling applies only what has
   * NOT yet been banked: the F&B contribution and the payroll, both of which a
   * hotel really does settle at the end of the day rather than per guest.
   */
  const alreadyBanked = Math.round(day.banked ?? 0);
  next.bank = Math.max(0, next.bank + Math.round(day.net) - alreadyBanked);
  next.days.push({
    net: Math.round(day.net),
    durationSec: day.durationSec,
    rating: day.rating ?? null,
    at: now,
    /** Where this day sits on the timeline. Null for a legacy session. */
    day: day.day ?? null,
    /** How it was earned - worked, unsupervised, shut. See DAY_SOURCE. */
    source: day.source ?? DAY_SOURCE.WORKED,
    /**
     * Days the player did not work are NOT evidence of what the hotel earns.
     * Without this flag the offline rate bootstraps off its own output: pay an
     * unsupervised day, record it, then price the next absence from a number
     * the hotel never actually demonstrated.
     */
    unmeasured: day.unmeasured === true,
    // Days manufactured by the dev panel are labelled, so a measured rate can
    // always be told from a seeded one if these ever reach analytics.
    synthetic: day.synthetic === true,
  });
  if (day.rating !== null && day.rating !== undefined) {
    // Reputation moves slowly: one night cannot rescue or ruin a hotel.
    next.rating = Math.round((next.rating * 0.72 + day.rating * 0.28) * 100) / 100;
  }
  next.lastSeenAt = now;
  return next;
}

/**
 * Mark the property as watched right now.
 *
 * Offline pay is `now - lastSeenAt`, so time spent with the game OPEN has to be
 * stamped as seen or a long play session would later be billed back as though
 * nobody was there. This is the heartbeat that keeps supervised time supervised.
 */
export function touch(property, now) {
  const next = copy(property);
  next.lastSeenAt = now;
  return next;
}

/** Move the offline earnings into the bank and reset the clock. */
export function claimOffline(property, now, options = {}) {
  const report = offlineReport(property, now, options);
  const next = copy(property);
  next.bank += report.earned;
  next.lastSeenAt = now;
  return { property: next, report };
}

/**
 * Reconcile the property with where the player has got to in their career.
 *
 * The level ladder in `engine.js` still describes the house and the payroll each
 * promotion arrives with. That is a DIFFERENT thing from what the player has
 * bought, and the two have to be kept apart: reaching the maintenance role hands
 * you a fourteen-room hotel, but if you had already built your way to eighteen
 * it must hand you the DIFFERENCE, not knock four rooms down. Same for the
 * roster - a promotion staffs a department, it never un-staffs one.
 *
 * Idempotent, so it is safe to call on every boot and every promotion.
 */
export function applyCareerBaseline(property, baselineRooms, roles = [], ownerRole = null) {
  const next = copy(property);
  next.ownerRole = ownerRole;
  // Working a department is how you learn it, and learning it is what lets you
  // hire for it later. Every role the ladder has already handed to staff was
  // one you worked yourself on the way past.
  next.learnedRoles = [...new Set([...(next.learnedRoles || []), ...roles,
    ...(ownerRole ? [ownerRole] : [])])];
  if (baselineRooms > next.baselineRooms) {
    const added = baselineRooms - next.baselineRooms;
    const house = houseOf(next);
    for (let i = 0; i < added; i += 1) {
      house.push(nextRoom(house, { site: next.site, seed: next.openedAt ?? 1 }));
    }
    setHouse(next, house);
    next.baselineRooms = baselineRooms;
  }
  /**
   * A PROMOTION NO LONGER HANDS YOU FREE STAFF.
   *
   * It used to push a fresh hire onto the roster for every role the rank's
   * config listed, so reaching a rank silently staffed the department below it -
   * the operator: "unlocks and hires auto the next staff unlocked". That made
   * the one decision the career is about (who to hire, and when you can afford
   * them) into something the game did for you while you were not looking.
   *
   * The rank still governs how many people you MAY employ - `staffCap` - and the
   * department goals govern when the position opens. Filling it is a purchase
   * the player makes.
   */
  return next;
}

/**
 * Everything the star inspector looks at, drawn from the property itself.
 *
 * The owner's own department counts. An inspector checking that reception is
 * staffed does not care that the person behind the desk owns the building -
 * which is why a one-person hotel is an honest 1-star rather than an unrated
 * one. Contrast `automationCoverage`, where the owner deliberately does not
 * count, because there the whole question is what happens when they leave.
 */
export function certification(property) {
  const staff = property.roster.map((p) => p.role);
  if (property.ownerRole) staff.push(property.ownerRole);
  return evaluateStars({
    rooms: property.rooms,
    facilities: property.facilities,
    staff,
    rating: property.rating,
  });
}

/**
 * Return to the app: work out what the hotel earned without you, then let the
 * builders hand over.
 *
 * ORDER MATTERS, AND IT IS THIS WAY ROUND ON PURPOSE. The hours are priced
 * against the property AS IT STOOD WHILE THEY PASSED, before any completion is
 * applied. Advancing first was a real bug: a receptionist who was away on a
 * course for those eight hours came back, the course completed, and the absence
 * was then priced as though the desk had been staffed the whole time - the game
 * paid for cover that nobody provided.
 *
 * The same principle covers the other direction: a room finished six hours ago
 * was not earning for those six hours. That one is already safe because the
 * offline rate is measured from days actually played, not from the floorplan.
 */
export function resume(property, now, options = {}) {
  const report = offlineReport(property, now, options);
  const advanced = advanceBuilds(property, now);
  const next = copy(advanced.property);
  next.bank += report.earned;
  next.lastSeenAt = now;
  return { property: next, completed: advanced.completed, offline: report };
}

/* ------------------------------------------------------------ timeline --- */

/**
 * Bring the property up to `now`: roll the clock, settle every day that ended.
 *
 * The dependency injection into `settleTimeline` looks fussy but is load
 * bearing - `domain/Timeline.js` must not import this file, because this file
 * already imports it, and a cycle between the two would be a real one rather
 * than something a bundler quietly resolves.
 */
export function advanceTimeline(property, now, options = {}) {
  return settleTimeline(property, {
    measuredNetPerDay,
    supervisionFactor,
    settleDay,
    capSeconds: OFFLINE_CAP_SECONDS,
  }, now, options);
}

export { DAY_SOURCE, describeAbsence };

/* ---------------------------------------------------------------- book --- */

/** The forward book as a working Calendar. */
export function bookOf(property) {
  return Calendar.fromJSON(property.book ?? { horizon: BOOK_HORIZON, bookings: [] });
}

/** Put a Calendar back onto the property. Returns a NEW property. */
export function withBook(property, calendar) {
  const next = copy(property);
  next.book = calendar.toJSON();
  return next;
}

/**
 * Keep the book honest for the day we are now on: depart finished stays, forget
 * the deep past, and top the forward horizon back up.
 *
 * Called on every rollover and on every return, because a player who has been
 * away a week must not come back to an empty fortnight.
 */
export function maintainBook(property, options = {}) {
  const calendar = bookOf(property);
  const today = clockOf(property).day;
  const house = sellableRoomList(property);

  /**
   * FIRST CALL EVER. The hotel used to open 55% full so day 1 had check-outs to
   * teach on. It now opens EMPTY - the operator's directive of 2026-08-10, "you
   * get a hotel which opens just right now ... no occupied rooms, no staff".
   *
   * `openingOccupancy` is the one number that reverses it, and it is a number
   * rather than a deleted call on purpose: `reality-check` argued for seeding
   * 2-3 rooms as a handover from the previous owner and measured better on the
   * first tap. The operator chose the cold open with that measurement in front
   * of them. See docs/DAY1-COLD-OPEN.md.
   */
  const openingOccupancy = options.openingOccupancy ?? OPENING_OCCUPANCY;
  if (openingOccupancy > 0
    && calendar.live.length === 0 && (property.ledger?.days?.length ?? 0) === 0) {
    seedOpeningGuests(calendar, house, {
      today, rate: options.rate ?? 0, seed: property.openedAt ?? 1,
      occupancy: openingOccupancy,
    });
  }
  const departed = rollBook(calendar, today);
  const added = fillBook(calendar, house, {
    today,
    rate: options.rate ?? 0,
    demand: options.demand ?? 1,
    seed: property.openedAt ?? 1,
  });
  // Departing guests go into the register on their way out: that is the point
  // at which their whole stay - nights, room, what they paid - is known.
  const booked = recordDepartures(withBook(property, calendar), departed);
  return { property: booked, departed, added, calendar };
}

/* --------------------------------------------------------- progression --- */

export function rankOf(property) {
  return Progression.fromJSON(property.progression ?? { level: 1, experience: 0 });
}

export function withRank(property, progression) {
  const next = copy(property);
  next.progression = progression.toJSON();
  return next;
}

/**
 * Bank a day's experience and take the promotion if it has been earned.
 *
 * Returns what happened rather than just the property, because a promotion is
 * the single most important thing the game can tell a player and the caller has
 * to be able to make a moment of it.
 */
export function awardDay(property, result) {
  const rank = rankOf(property);
  // The roster decides which work the OWNER is still paid experience for - see
  // dayExperience. A desk you employ somebody to hold is not your rank any more.
  const gained = rank.award(dayExperience(result, {
    staffed: (property.roster ?? []).map((person) => person.role),
  }));
  const before = rank.level;
  const promoted = rank.promote(property);
  return {
    property: withRank(property, rank),
    gained,
    promoted,
    from: before,
    to: rank.level,
  };
}

/* -------------------------------------------------------------- the books -- */

/** Write one fully itemised trading day into the books. */
export function recordTradingDay(property, result, context = {}) {
  const next = copy(property);
  next.ledger = recordDay(next.ledger, dayRow(result, {
    day: context.day ?? clockOf(property).day,
    at: context.at ?? null,
    source: context.source ?? "worked",
    rank: rankOf(property).level,
    rooms: property.rooms,
    occupancy: context.occupancy ?? null,
  }));
  return next;
}

/** Write departing guests into the register - who was here, and when. */
export function recordDepartures(property, departed) {
  if (!departed || departed.length === 0) return property;
  const next = copy(property);
  const rows = departed.map((booking) => {
    const room = roomById(next, booking.roomId);
    return guestRow(booking, {
      roomNumber: room ? room.number : null,
      roomType: room ? room.type : null,
    });
  });
  next.ledger = recordGuests(next.ledger, rows);
  return next;
}

export { report as ledgerReport, guestsOn, exportLedger };

/** The clock as an object, for anything that wants the day or the hour. */
export function clockOf(property) {
  return Clock.fromJSON(property.clock ?? { day: 1, elapsed: 0, level: 1 });
}

/** Real seconds one business day takes at this property's current rank. */
export function dayLengthOf(property) {
  const c = clockOf(property);
  return daySeconds(c.level, c.day);
}

/* --------------------------------------------------------- test harness -- */

/**
 * DEVELOPMENT ONLY. Wind every clock in the property back by `seconds`, so it is
 * exactly as if that much time had passed.
 *
 * The point of doing it this way rather than adding an "instant finish" that
 * sets state directly: everything downstream still runs through the REAL code
 * path. `advanceBuilds` still completes the job, `offlineReport` still prices
 * the hours, the cap and the supervision factor still apply. A test button that
 * skipped that would let a broken economy pass a playtest.
 *
 * Not reachable from the shipped UI - `game.js` only wires the dev panel when
 * the page is opened with `#dev`.
 */
export function devRewind(property, seconds) {
  const ms = seconds * 1000;
  const next = copy(property);
  next.lastSeenAt -= ms;
  if (next.openedAt !== null) next.openedAt -= ms;
  next.builds = next.builds.map((build) => ({
    ...build,
    startedAt: build.startedAt - ms,
    readyAt: build.readyAt - ms,
  }));
  return next;
}

/**
 * DEVELOPMENT ONLY. Bring every job on the queue due right now.
 *
 * Note it does NOT apply the completions itself - it only moves the deadlines,
 * so the caller's ordinary `advanceBuilds` is still what finishes the work. Same
 * reason as `devRewind`: the test button must not be a second implementation.
 */
export function devFinishAll(property, now) {
  const next = copy(property);
  next.builds = next.builds.map((build) => ({ ...build, readyAt: now }));
  return next;
}

/** DEVELOPMENT ONLY. Put money in the bank without working for it. */
export function devGrant(property, amount) {
  const next = copy(property);
  next.bank = Math.max(0, next.bank + amount);
  return next;
}

/**
 * DEVELOPMENT ONLY. Give the property a settled trading history, so the offline
 * economy has a measured rate to work from without playing days by hand. Marked
 * so the days can be told from real ones if they ever reach analytics.
 */
export function devSeedDays(property, net, count, now) {
  let next = property;
  for (let i = 0; i < count; i += 1) {
    next = settleDay(next, { net, durationSec: 145, rating: null, synthetic: true }, now);
  }
  return next;
}

/* ------------------------------------------------------ save and restore -- */

/**
 * Serialised state is versioned so a save written by an older build can be
 * recognised and dropped rather than silently misread. The property is the
 * player's entire investment; reading it wrong is worse than starting over
 * knowingly.
 */
export const SAVE_VERSION = 1;

export function serialize(property) {
  return JSON.stringify({
    version: SAVE_VERSION,
    property: { ...property, house: houseOf(property).map((room) => room.toJSON()) },
  });
}

export function deserialize(text, now) {
  if (!text) return null;
  let parsed;
  try { parsed = JSON.parse(text); } catch (error) { return null; }
  if (!parsed || parsed.version !== SAVE_VERSION || !parsed.property) return null;
  const saved = parsed.property;
  const base = createProperty(now);
  const restored = {
    ...base,
    ...saved,
    menu: saved.menu && typeof saved.menu === "object" ? { ...saved.menu } : {},
    facilities: Array.isArray(saved.facilities) ? saved.facilities : [],
    roster: Array.isArray(saved.roster) ? saved.roster : [],
    builds: Array.isArray(saved.builds) ? saved.builds : [],
    days: Array.isArray(saved.days) ? saved.days : [],
    site: saved.site ?? SITE.CITY,
    upsellPolicy: saved.upsellPolicy ?? "protect",
    cash: saved.cash ?? 0,
    progression: saved.progression ?? new Progression({ level: 1 }).toJSON(),
    ledger: saved.ledger && Array.isArray(saved.ledger.days) ? saved.ledger : createLedger(),
    book: saved.book && Array.isArray(saved.book.bookings)
      ? saved.book : { horizon: BOOK_HORIZON, bookings: [] },
    clock: saved.clock ?? new Clock({ startedAt: saved.openedAt ?? now, day: 1 }).toJSON(),
    lastSettledDay: saved.lastSettledDay ?? 0,
    lastAwardedDay: saved.lastAwardedDay ?? 0,
    preppedFor: saved.preppedFor ?? 0,
    career: { ...emptyCareer(), ...(saved.career ?? {}) },
  };

  // SAVE MIGRATION. Every save written before today has a room COUNT and no
  // house. Generate the house it always implicitly had - deterministically, from
  // the property's own opening time, so a player who reloads twice gets the same
  // building both times rather than a fresh hotel.
  restored.house = Array.isArray(saved.house)
    ? saved.house.map((room) => Room.fromJSON(room))
    : createHouse(saved.rooms ?? STARTING_ROOMS, {
      site: restored.site,
      seed: saved.openedAt ?? 20260809,
      upgraded: saved.upgradedRooms ?? 0,
    });
  restored.rooms = restored.house.length;
  return restored;
}
