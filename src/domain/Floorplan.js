/**
 * Hotel Career - THE FLOORPLAN. Where rooms come from.
 *
 * `property.rooms` used to be an integer. Turning it into real `Room` objects
 * raises a question an integer never had to answer: what ARE these rooms? Eight
 * identical doubles is not a hotel, and randomising every attribute per room
 * gives you a building with a sea view on the ground floor next to an interior
 * room on the fourth, which is not a hotel either.
 *
 * SO THE BUILDING HAS A SITE, and the site is fixed for the life of the
 * property. A seafront hotel has sea views on the upper floors and side rooms
 * that do not; a city hotel has none at all and its premium comes from height
 * and quiet instead. That is why two 20-room 3-stars can be worth different
 * money, and it is the sort of thing the player should discover about their own
 * building rather than be told.
 *
 * DETERMINISTIC. Same seed, same house, every time. This matters more than it
 * looks: an existing save has no rooms in it, so migrating it means GENERATING
 * the house it always implicitly had. If that generation were random, a player
 * who cleared their cache would come back to a different hotel.
 */

import { mulberry32 } from "../engine.js";
import {
  CONDITION, FEATURE, Room, ROOM_TYPE, VIEW,
} from "./Room.js";

/**
 * What the building looks out at. Chosen once, when the property is created.
 *
 * The weights are the view mix of the WHOLE building; height then decides who
 * gets the good end of it (see `viewFor`). A seafront hotel still has rooms
 * facing the car park, and those rooms are the ones you sell last.
 */
export const SITE = {
  CITY: "city",
  SEAFRONT: "seafront",
  GARDEN: "garden",
};

export const SITE_SPEC = {
  [SITE.CITY]: {
    label: "City centre",
    note: "No view to sell. Height and quiet are your only premiums.",
    views: [
      { view: VIEW.INTERIOR, weight: 0.30 },
      { view: VIEW.COURTYARD, weight: 0.34 },
      { view: VIEW.CITY, weight: 0.36 },
    ],
  },
  [SITE.SEAFRONT]: {
    label: "Seafront",
    note: "The upper floors sell themselves. The side rooms are the problem.",
    views: [
      { view: VIEW.INTERIOR, weight: 0.18 },
      { view: VIEW.COURTYARD, weight: 0.20 },
      { view: VIEW.CITY, weight: 0.18 },
      { view: VIEW.POOL, weight: 0.14 },
      { view: VIEW.SEA, weight: 0.30 },
    ],
  },
  [SITE.GARDEN]: {
    label: "Garden",
    note: "Quiet, green, and even the cheap rooms look at something.",
    views: [
      { view: VIEW.COURTYARD, weight: 0.28 },
      { view: VIEW.GARDEN, weight: 0.44 },
      { view: VIEW.POOL, weight: 0.28 },
    ],
  },
};

/** A small hotel is not a tower. Six doors to a landing reads about right. */
export const ROOMS_PER_FLOOR = 6;

/**
 * The room mix of a small independent hotel. Overwhelmingly doubles and twins,
 * a few singles for the lone business traveller, a couple of family rooms, and
 * one or two suites which are the rooms you actually make money on.
 */
export const TYPE_MIX = [
  { type: ROOM_TYPE.DOUBLE, weight: 0.36 },
  { type: ROOM_TYPE.TWIN, weight: 0.29 },
  { type: ROOM_TYPE.SINGLE, weight: 0.15 },
  { type: ROOM_TYPE.FAMILY, weight: 0.12 },
  { type: ROOM_TYPE.JUNIOR_SUITE, weight: 0.06 },
  { type: ROOM_TYPE.SUITE, weight: 0.02 },
];

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
 * Which view this room gets.
 *
 * Height biases toward the good end of the site's mix, because it does in life:
 * the fourth floor sees over the building opposite and the ground floor sees the
 * bins. Implemented by pulling the roll toward 1 on higher floors rather than by
 * a separate table, so a city hotel still cannot conjure a sea view.
 */
export function viewFor(site, floor, topFloor, roll) {
  const spec = SITE_SPEC[site] ?? SITE_SPEC[SITE.CITY];
  const height = topFloor > 1 ? Math.max(0, floor - 1) / (topFloor - 1) : 0;
  // Sorted worst-to-best already, so skewing the roll upward skews the view up.
  const skewed = Math.min(0.999, roll * (1 - height * 0.55) + height * 0.55);
  return pick(spec.views, skewed, "view");
}

/**
 * The best rooms are upstairs. A suite on the ground floor next to reception is
 * a room nobody would build, so type is skewed by height too - gently, because a
 * small hotel does put family rooms wherever they fit.
 */
export function typeFor(floor, topFloor, roll) {
  const height = topFloor > 1 ? Math.max(0, floor - 1) / (topFloor - 1) : 0;
  const skewed = Math.min(0.999, roll * (1 - height * 0.3) + height * 0.3);
  // TYPE_MIX is ordered by commonness, not by value, so pull the good types
  // toward the top floors explicitly rather than by skewing alone.
  const type = pick(TYPE_MIX, skewed, "type");
  if (height > 0.7 && roll > 0.86) return ROOM_TYPE.SUITE;
  if (height > 0.5 && roll > 0.8) return ROOM_TYPE.JUNIOR_SUITE;
  if (height < 0.25 && (type === ROOM_TYPE.SUITE || type === ROOM_TYPE.JUNIOR_SUITE)) {
    return ROOM_TYPE.DOUBLE;
  }
  return type;
}

/** Door number from position. 101, 102 ... 201, 202. How buildings are numbered. */
export function roomNumber(floor, indexOnFloor) {
  return floor * 100 + indexOnFloor + 1;
}

/**
 * Build a house of `count` rooms. Deterministic in `seed`.
 *
 * @param {number} count  How many rooms the property owns.
 * @param {object} options
 * @param {string} options.site      SITE value. Fixed for the property's life.
 * @param {number} options.seed      Anything stable - the property's opening time works.
 * @param {number} options.upgraded  How many rooms have been refurbished. Applied
 *                                   to the BEST rooms first, which is what an
 *                                   owner actually does: you refurbish the suite
 *                                   before you refurbish the single.
 */
export function createHouse(count, options = {}) {
  const site = options.site ?? SITE.CITY;
  const random = mulberry32(options.seed ?? 20260809);
  const total = Math.max(0, Math.round(count));
  const topFloor = Math.max(1, Math.ceil(total / ROOMS_PER_FLOOR));

  const rooms = [];
  for (let i = 0; i < total; i += 1) {
    const floor = Math.min(topFloor, Math.floor(i / ROOMS_PER_FLOOR) + 1);
    const indexOnFloor = i % ROOMS_PER_FLOOR;
    const number = roomNumber(floor, indexOnFloor);

    const type = typeFor(floor, topFloor, random());
    const view = viewFor(site, floor, topFloor, random());

    const features = [];
    // The rooms at each end of a landing are corner rooms, and they are bigger.
    if (indexOnFloor === 0 || indexOnFloor === ROOMS_PER_FLOOR - 1) features.push(FEATURE.CORNER);
    // Balconies belong to the good views, not to every room.
    if ((view === VIEW.SEA || view === VIEW.GARDEN || view === VIEW.POOL) && random() < 0.55) {
      features.push(FEATURE.BALCONY);
    }
    // Away from the lift and the stairs.
    if (indexOnFloor >= 3 && random() < 0.4) features.push(FEATURE.QUIET);
    // Every hotel needs one, and it is always on the ground or first floor.
    if (i === 1 && total >= 4) features.push(FEATURE.ACCESSIBLE);

    rooms.push(new Room({
      id: `r${number}`, number, floor, type, view,
      condition: CONDITION.STANDARD, features,
    }));
  }

  // Refurbishments land on the most valuable rooms first.
  const upgraded = Math.min(total, Math.max(0, options.upgraded ?? 0));
  if (upgraded > 0) {
    [...rooms]
      .sort((a, b) => b.rateMultiplier - a.rateMultiplier)
      .slice(0, upgraded)
      .forEach((room) => room.improve());
  }

  return rooms;
}

/**
 * The next room to add when a build completes.
 *
 * It goes on the lowest floor with space, or opens a new landing. Deliberately
 * NOT random in the same way the initial house is: the player watched this one
 * get built, so it should be a plausible next door rather than a surprise suite.
 */
export function nextRoom(existing, options = {}) {
  const site = options.site ?? SITE.CITY;
  const random = mulberry32((options.seed ?? 1) + existing.length * 977);

  const byFloor = new Map();
  for (const room of existing) byFloor.set(room.floor, (byFloor.get(room.floor) ?? 0) + 1);

  let floor = 1;
  while ((byFloor.get(floor) ?? 0) >= ROOMS_PER_FLOOR) floor += 1;
  const indexOnFloor = byFloor.get(floor) ?? 0;
  const topFloor = Math.max(floor, ...existing.map((r) => r.floor), 1);

  const number = roomNumber(floor, indexOnFloor);
  const type = typeFor(floor, topFloor, random());
  const view = viewFor(site, floor, topFloor, random());
  const features = [];
  if (indexOnFloor === 0 || indexOnFloor === ROOMS_PER_FLOOR - 1) features.push(FEATURE.CORNER);
  if ((view === VIEW.SEA || view === VIEW.GARDEN || view === VIEW.POOL) && random() < 0.55) {
    features.push(FEATURE.BALCONY);
  }

  return new Room({
    id: `r${number}`, number, floor, type, view,
    // A room you have just had built is new, not standard.
    condition: CONDITION.REFURBISHED, features,
  });
}

/** A one-line summary of the house, for the rooms screen header. */
export function describeHouse(rooms) {
  if (rooms.length === 0) return "No rooms yet.";
  const byType = {};
  for (const room of rooms) byType[room.type] = (byType[room.type] ?? 0) + 1;
  const floors = new Set(rooms.map((r) => r.floor)).size;
  const parts = Object.entries(byType)
    .sort((a, b) => b[1] - a[1])
    .map(([type, n]) => `${n} ${type.replace(/_/g, " ")}`);
  return `${rooms.length} rooms over ${floors} floor${floors === 1 ? "" : "s"} - ${parts.join(", ")}`;
}
