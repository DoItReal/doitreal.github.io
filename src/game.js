/**
 * Hotel Career - presentation and input.
 *
 * All operations rules live in engine.js (pure, headlessly tested).
 *
 * Two hard-won rules govern this file:
 *
 *  1. NO NON-ASCII. Icons are short letter badges, not emoji. An earlier build
 *     was corrupted into mojibake by a text round-trip; the fix is not to
 *     re-encode more carefully, it is to have nothing fragile to encode.
 *
 *  2. NODES ARE NOT REBUILT PER FRAME. The clock repaints ~60x a second. Building
 *     the list every frame destroys elements mid-tap and makes the game
 *     unclickable while running - it only worked while paused. Rows are created
 *     when the SET of jobs changes, everything time-varying is updated in place,
 *     and clicks are delegated to a container that is never replaced.
 */

import {
  ENERGY_FLOOR, MAX_LEVEL, OUTLET_SPEC, REVIEW_CATEGORIES, ROOM, TASK, TIERS,
  canStart, canTakeOver, createShift, demandFactor, fairCheque, fairRate, isFnbRole,
  levelConfig, outletBrigade, outletCapacity, outstandingBookings, roleWage,
  roomsAvailable, score, startTask, suggestTask, takeOver,
  taskBoard, taskSeconds, taskUrgency, tick,
  hourSeconds, WAIT_LADDER, addStaffToShift,
} from "./engine.js";
import {
  BUILD_CATALOG, BUILD_KIND, OFFLINE_CAP_SECONDS, REFURB, ROOM as BUILD_ROOM,
  advanceBuilds, applyCareerBaseline, buildBlocker, buildCost,
  buildProgress, buildRemainingSeconds, certification, createProperty, deserialize,
  REMOTE_TRAINING_MULTIPLIER, TRAINING, availableRoster, devFinishAll, devGrant, devRewind,
  devSeedDays, hire, hireBlocker, lockedDepartments, menuBand, menuPrice, openPositions,
  recordWork, unlockProgress, nextDepartment, unlockShare, DEPARTMENT_GOALS,
  recruitmentFee, withRank,
  setMenuPrice, staffCount,
  findStaff, maintenanceSpeedUpSeconds, open as openProperty, resume, roomsUnderConstruction,
  houseOf, describeHouse,
  sellableRooms, sellableRoomList, serialize, settleDay, speedUpBuild, startBuild, startTraining,
  touch as touchProperty, trainingBlocker, trainingSeconds,
  spendable, nightAudit,
  advanceTimeline, clockOf, dayLengthOf, describeAbsence, bookOf, maintainBook, withBook,
  awardDay, rankOf, recordTradingDay, ledgerReport, exportLedger, guestsOn,
} from "./property.js";
import {
  CONDITION_SPEC, FEATURE_SPEC, VIEW_SPEC, LEVELS, reveals, staffCap,
} from "./domain/index.js";
import { UPSELL_POLICY } from "./engine.js";
import { inHouseAtOpen } from "./domain/Bookings.js";
import { duration as timerDuration } from "./domain/Timers.js";
import { Booking, BOOKING_SOURCE } from "./domain/Booking.js";
import { SITE_SPEC } from "./domain/Floorplan.js";
import { Analytics } from "./analytics.js";

const analytics = new Analytics();
const el = (id) => document.getElementById(id);
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const KEY_LEVEL = "hc_level";
const KEY_UNLOCKED = "hc_unlocked";
const KEY_BANK = "hc_bank";
const KEY_SOUND = "hc_sound";
const KEY_TUT = "hc_seen_tutorial";
const KEY_DESIGN = "hc_design";
const KEY_PRICE = "hc_price";
const KEY_RATING = "hc_rating";
const KEY_PROPERTY = "hc_property";

/**
 * Bumped whenever the level design changes materially. Saved progress then
 * rewinds to shift 1 while KEEPING everything already unlocked, so a returning
 * player meets the reworked opening instead of resuming mid-ladder into levels
 * that have been rebalanced underneath them.
 */
const DESIGN_VERSION = "5";

function loadNumber(key, fallback) {
  const value = Number(localStorage.getItem(key));
  return Number.isFinite(value) && value !== 0 ? value : fallback;
}

if (localStorage.getItem(KEY_DESIGN) !== DESIGN_VERSION) {
  const reached = Math.max(loadNumber(KEY_UNLOCKED, 1), loadNumber(KEY_LEVEL, 1));
  localStorage.setItem(KEY_UNLOCKED, String(Math.min(reached, MAX_LEVEL)));
  localStorage.setItem(KEY_LEVEL, "1");
  localStorage.setItem(KEY_DESIGN, DESIGN_VERSION);
}

/**
 * THE PROPERTY IS THE SAVE FILE.
 *
 * Bank, rating, rooms, facilities, roster and the building queue all live in one
 * versioned blob (see property.js). They used to be loose localStorage keys,
 * which is fine until the hotel keeps running while the tab is closed - then
 * they have to be read and written as one consistent snapshot or an interrupted
 * write leaves a hotel with the rooms but not the bill.
 *
 * A save from before the property existed is migrated rather than thrown away:
 * capital and reputation are the two things a returning player would actually
 * mind losing.
 */
function loadProperty(now) {
  const restored = deserialize(localStorage.getItem(KEY_PROPERTY), now);
  if (restored) return restored;
  /**
   * A BRAND NEW GAME MUST NOT PASS `bank: 0`. It did, because the old migration
   * read `KEY_BANK || 0` - which is 0 for a player who has never played - and an
   * explicit 0 beats `createProperty`'s STARTING_BANK default. The opening float
   * is only a default; overriding it with a legacy key that is not there is how
   * a "starting money" change silently does nothing.
   */
  const legacyBank = localStorage.getItem(KEY_BANK);
  return createProperty(now, {
    ...(legacyBank === null ? {} : { bank: Number(legacyBank) || 0 }),
    rating: Number(localStorage.getItem(KEY_RATING)) || 3.5,
  });
}

let saveProperty = function saveProperty() {
  localStorage.setItem(KEY_PROPERTY, serialize(state.property));
}

const state = {
  /** Cash, card, experience and jobs already pushed into the property today. */
  banked: { cash: 0, card: 0, experience: 0, career: {} },
  level: Math.min(loadNumber(KEY_LEVEL, 1), MAX_LEVEL),
  unlocked: Math.min(loadNumber(KEY_UNLOCKED, 1), MAX_LEVEL),
  /** Everything that survives a day: capital, the building, the payroll. */
  property: null,
  shift: null,
  paused: true,
  /** Epoch ms the current pause began, or null. See `frame`. */
  pausedSince: null,
  lastFrame: 0,
  startedAt: 0,
  /** Playtest convenience: run a shift at 1x, 2x or 4x. */
  speed: 1,
  /** The rate set for the next shift, once pricing unlocks. */
  price: Number(localStorage.getItem(KEY_PRICE)) || null,
};

state.property = loadProperty(Date.now());

/** Reputation is the property's, not the session's. */
function rating() {
  return state.property.rating;
}

/** Letter badges: no glyphs, no encoding risk, and they read at a glance. */
/**
 * EVERY TASK TYPE THE ENGINE CAN CREATE MUST HAVE A ROW HERE.
 *
 * THE BUG THIS FIXES, and it was the operator's "blinking tasks which i cant
 * start ... and loose guests". `TASK.CHECK_OUT` was added to the engine when
 * check-out became real work - the biggest item in plan v4 - and no label was
 * ever added here. `LABEL[task.type]` was therefore `undefined`, and the very
 * first departure of the day made `buildJobs` throw on `meta.tone`.
 *
 * What the player saw, in order: the list had ALREADY been cleared by
 * `innerHTML = ""` at the top of the build; the throw aborted it part-way, so
 * rows after the check-out never existed; and because the signature is written
 * at the END of the function it was never written, so `render` rebuilt the list
 * on EVERY FRAME - clearing and half-building it sixty times a second. Rows
 * flashed, taps landed on nodes that were destroyed a frame later, and guests
 * expired while the player tapped at them. Pausing stopped the destruction,
 * which is why the rows became visible on pause and still would not start.
 *
 * `tests/test_game_sources.py` now fails if a task type has no label, because a
 * missing key here is not a cosmetic defect - it takes the floor down.
 */
const LABEL = {
  [TASK.CHECK_IN]: { tag: "IN", name: "Check in", sub: "Give them a room", tone: "in" },
  [TASK.CHECK_OUT]: {
    tag: "OUT", name: "Check out", sub: "Settle the folio and take the key", tone: "out",
  },
  [TASK.REQUEST]: {
    tag: "REQ", name: "Guest request", sub: "Somebody upstairs needs something", tone: "req",
  },
  [TASK.PREP]: {
    tag: "NGT", name: "Prepare for tomorrow",
    sub: "Cut keys, lay out the paperwork - a faster morning", tone: "ngt",
    /**
     * DAY 1 IS THE SAME JOB FOR A DIFFERENT DAY. On the morning you open, the
     * keys you cut are for the guests arriving this afternoon, not tomorrow's -
     * see Schedule.OPENING_PREP_HOURS, and `finishTask`, which credits it to
     * today's pool. Calling it "prepare for tomorrow" on opening morning would
     * describe the wrong day and hide the only return the player can see.
     */
    day1: {
      tag: "OPN", name: "Get a room ready",
      sub: "Cut the key, make out the card - a faster check-in today",
    },
  },
  [TASK.ESCORT]: { tag: "UP", name: "Show up to room", sub: "Optional - costs time, earns a tip", tone: "up" },
  [TASK.CLEAN]: { tag: "HK", name: "Turn the room", sub: "Cannot be sold dirty", tone: "hk" },
  [TASK.REPAIR]: { tag: "MT", name: "Fix the room", sub: "Out of order until fixed", tone: "mt" },
  [TASK.PHONE]: { tag: "TEL", name: "Take the call", sub: "Sells a room - have you got one?", tone: "tel" },
  [TASK.BED]: { tag: "BED", name: "Move the extra bed", sub: "A family needs it, or it is in the way", tone: "bed" },
};
const PAY = {
  [TASK.CHECK_IN]: "+$40", [TASK.ESCORT]: "+tip", [TASK.CLEAN]: "resells",
  [TASK.REPAIR]: "reopens", [TASK.PHONE]: "+booking", [TASK.BED]: "fits 3-4",
  [TASK.CHECK_OUT]: "frees rm", [TASK.REQUEST]: "+happy", [TASK.PREP]: "faster AM",
};
const ROLE_TAG = {
  reception: "IN", bellboy: "UP", housekeeping: "HK", maintenance: "MT", reservations: "TEL",
};

/* ---------------------------------------------------------------- sound -- */
const sound = {
  ctx: null,
  on: localStorage.getItem(KEY_SOUND) !== "off",
  ensure() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) this.ctx = new Ctx();
    }
    return this.ctx;
  },
  play(freq, { duration = 0.08, type = "sine", gain = 0.045, delay = 0 } = {}) {
    if (!this.on) return;
    const ctx = this.ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(gain, t0 + 0.01);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(env).connect(ctx.destination);
    osc.start(t0); osc.stop(t0 + duration + 0.02);
  },
  start() { this.play(520, { type: "triangle", gain: 0.03 }); },
  bell() { [740, 990].forEach((f, i) => this.play(f, { delay: i * 0.06, gain: 0.04 })); },
  tip() { [660, 880, 1100].forEach((f, i) => this.play(f, { delay: i * 0.05, gain: 0.035 })); },
  nope() { this.play(140, { duration: 0.06, gain: 0.03 }); },
  lost() { [300, 200].forEach((f, i) => this.play(f, { delay: i * 0.09, type: "sawtooth", gain: 0.03 })); },
  done() { [523, 659, 784, 1047].forEach((f, i) => this.play(f, { delay: i * 0.1, duration: 0.25, gain: 0.04 })); },
};
el("sound").addEventListener("click", () => {
  sound.on = !sound.on;
  localStorage.setItem(KEY_SOUND, sound.on ? "on" : "off");
  el("sound").style.opacity = sound.on ? "1" : ".4";
});
el("sound").style.opacity = sound.on ? "1" : ".4";

function toast(message, ms = 1700) {
  const node = el("toast");
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove("show"), ms);
}

/* ------------------------------------------------------------- panels -- */
/**
 * OPENING A PANEL STOPS THE HOTEL. CLOSING IT HAS TO START IT AGAIN.
 *
 * THE BUG THIS FIXES, found by `game-designer` and confirmed in source: nine
 * places set `state.paused = true` when a sheet opens and **not one close
 * handler ever set it back**. The only three sites that cleared it were starting
 * a shift, the away card and the end-of-day card. So looking at your rooms and
 * closing the sheet left the hotel frozen behind a button labelled "Resume" that
 * nothing pointed at - and the longer the player explored, the more of their day
 * they lost without being told. On a phone, where the sheets ARE the navigation,
 * that is the whole of navigation broken.
 *
 * IT RESTORES, IT DOES NOT RESUME. A player who paused deliberately and then
 * opened a sheet must still be paused when they close it, so the state from
 * before the first panel opened is what comes back. That is also why the flag is
 * cleared only when the LAST panel closes: sheets can open sheets.
 *
 * Pausing on open is deliberate and stays - it is what makes it safe to read a
 * screen mid-day, and on day 1 it is the only reason a player can look around
 * without losing a guest.
 */
const PANELS = [
  "star-veil", "build-veil", "rooms-veil", "book-veil", "report-veil",
  "fnb-veil", "price-veil", "lvl-veil", "staff-veil",
];

/** What `paused` was before the first panel opened, or null if none is open. */
let pausedBeforePanel = null;

/** One place that owns the flag AND the button, which used to be set apart. */
function setPaused(value) {
  state.paused = value;
  el("pause").textContent = value ? "Resume" : "Pause";
  if (!value) state.lastFrame = performance.now();
}

function anyPanelOpen() {
  return PANELS.some((id) => el(id).classList.contains("show"));
}

function openPanel(id) {
  if (!anyPanelOpen()) pausedBeforePanel = state.paused;
  el(id).classList.add("show");
  setPaused(true);
}

function closePanel(id) {
  el(id).classList.remove("show");
  if (anyPanelOpen()) return;
  setPaused(pausedBeforePanel ?? false);
  pausedBeforePanel = null;
}

/**
 * A wait, in the shortest honest form. Building work is measured in real hours,
 * so "6h 20m" has to read at a glance from the floor without doing arithmetic.
 */
function shortWait(seconds) {
  const total = Math.max(0, Math.ceil(seconds));
  if (total < 60) return `${total}s`;
  const minutes = Math.ceil(total / 60);
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** A value that floats up off the takings meter when money moves. */
function floatUp(text, tone) {
  if (reduceMotion) return;
  const anchor = el("money").getBoundingClientRect();
  const node = document.createElement("div");
  node.className = `float ${tone}`;
  node.textContent = text;
  node.style.left = `${anchor.left}px`;
  node.style.top = `${anchor.top}px`;
  document.body.appendChild(node);
  node.addEventListener("animationend", () => node.remove());
}

/** Five star outlines, filled to the hotel's class. Drawn in CSS, no glyphs. */
function paintStars(filled) {
  const row = el("starrow");
  if (row.childElementCount !== 5) {
    row.innerHTML = "";
    for (let i = 0; i < 5; i += 1) row.appendChild(document.createElement("i"));
  }
  for (let i = 0; i < 5; i += 1) row.children[i].className = i < filled ? "on" : "";
}

/* --------------------------------------------------------------- shifts -- */
/**
 * The house the day is played in. A room being built does not exist yet and a
 * room under refurbishment is out of service, so neither can be sold tonight -
 * which is the operational cost of improving the place, and is meant to hurt a
 * little.
 */
function shiftOptions(level) {
  const config = levelConfig(level);
  return {
    rooms: sellableRooms(state.property),
    upgradedRooms: state.property.upgradedRooms,
    // THE ACTUAL ROOMS. Real doors with numbers, types, views and floors, so the
    // day prices a sea-view suite differently from an interior single. Rooms out
    // of service for a refurbishment are not in this list, which is why the
    // count above and this array agree.
    house: sellableRoomList(state.property),
    upsellPolicy: state.property.upsellPolicy,
    // THE DAY PLAYS THE BOOK. Today's arrivals were reserved on earlier days,
    // and whoever is already upstairs is upstairs because their stay covers
    // today - not because a dice roll said so. This is what "the next day
    // starts where the last one ended" actually means in code.
    today: clockOf(state.property).day,
    arrivals: bookOf(state.property).arrivalsOn(clockOf(state.property).day),
    inHouse: inHouseAtOpen(bookOf(state.property), clockOf(state.property).day),
    // The day's running view of the forward book: free rooms per night, index 0
    // being tonight. This is what the desk consults on the phone - a whole
    // Calendar cloned on every tick would be far too expensive on a phone.
    forwardFree: forwardFreeFor(state.property),
    // THE FLOOR RUNS THE WHOLE DAY. Starting mid-day - after an absence, or
    // after the clock rolled while the tab was hidden - opens a shift for the
    // time that is LEFT, not a fresh full one, so the countdown on screen and
    // the clock in the header can never disagree.
    durationSec: Math.max(30, clockOf(state.property).secondsToDayEnd),
    facilities: state.property.facilities,
    // What each outlet charges per cover. Set on the F&B screen; it survives
    // the day exactly as the room rate does.
    menu: { ...(state.property.menu || {}) },
    /**
     * EVERYONE ON THE PAYROLL WHO IS HERE TODAY. B1, and it made the only
     * purchase the game offers a new player do nothing at all.
     *
     * This used to filter out anybody sharing the player's own role - "whatever
     * you are covering yourself is not also covered by staff". But `config.role`
     * is the job the PLAYER works and `config.hired` never contains it, so the
     * filter could only ever remove somebody the player had gone to the staff
     * screen and paid for: at rank 1, the $150 receptionist, the single hire
     * available. They drew a wage and never touched a task.
     *
     * A receptionist is a second body at the desk, not a duplicate of the owner.
     * They take the overflow while the player is mid-check-in, which is the
     * whole reason to buy one on day 1 - the "they cover you while you are away"
     * story does not start being true until the player has somewhere else to be.
     *
     * Offline coverage is a DIFFERENT question and is not answered here: see
     * `automationCoverage` in property.js, which deliberately does not count the
     * owner.
     */
    roster: availableRoster(state.property),
    rating: rating(),
    // Last night's preparation, spent on this morning's check-ins. See NIGHT_PREP.
    preppedFor: state.property.preppedFor ?? 0,
  };
}

/**
 * Has the day on the clock already been worked?
 *
 * A day is ten minutes at level 1 and an hour at level 5; a hands-on session is
 * a couple of minutes. So the player can be at the desk for only part of their
 * own day, and the rest is run by staff - which is exactly the shape of the
 * business. What they cannot do is work the SAME day four times over and bank
 * it four times, so the floor is available once per day and then the clock has
 * to turn over.
 */
function dayAlreadyWorked() {
  return (state.property.lastSettledDay || 0) >= clockOf(state.property).day;
}

/**
 * Free rooms per night for the next fortnight, from the forward book.
 *
 * Computed once when a day starts and then carried by the shift, which
 * decrements it as calls are taken. That means a second call cannot sell the
 * same room twice within one day, without the day having to hold the book.
 */
/**
 * THE WAIT A PLAYER WILL ACTUALLY HAVE, not the catalogue number.
 *
 * RED TEAM FINDING. `startBuild` schedules `scaledDuration(catalogue, rank,
 * rooms)` - about 7 minutes for a room at rank 1 - while every label in this
 * file printed `BUILD_CATALOG[key].seconds`, the raw catalogue figure, which
 * says SIX HOURS. The button lied by a factor of fifty, the analytics event
 * logged the lie, the operator read the button and reported a six-hour build,
 * and a whole plan item was written to "fix" a timer that was already fine.
 *
 * property.js documents the distinction in a comment. The UI ignored it.
 */
function realBuildSeconds(key) {
  return timerDuration(
    BUILD_CATALOG[key].seconds, rankOf(state.property).level, state.property.rooms,
  );
}

function forwardFreeFor(property) {
  const calendar = bookOf(property);
  const rooms = sellableRoomList(property);
  const today = clockOf(property).day;
  return Array.from({ length: 14 }, (_, i) => {
    const day = today + i;
    const taken = calendar.live.filter((b) => b.roomId !== null && b.occupies(day)).length;
    return Math.max(0, rooms.length - taken);
  });
}

/**
 * Open the floor for the current day, if it has not been worked.
 *
 * Returns false when the day is already in the ledger, which is the guard that
 * stops a player working day 6 four times over and banking it four times. The
 * clock has to turn over first - which is the whole shape of the game now.
 */
function beginDay() {
  /**
   * THE DESK IS OPEN WHENEVER YOU ARE THERE - any number of times in a day.
   *
   * There used to be a lockout here: work the day once and the floor closed
   * until the clock turned over. It was defending something real - a day must
   * not be banked twice - in the wrong place, because banking is already
   * idempotent against `property.lastSettledDay`. Belt on top of braces, and
   * the belt was the part the player felt: at rank 1 it left roughly eight of
   * every ten minutes as dead air with a countdown pointed at it.
   *
   * Present time earns the full result; absent time earns the supervision
   * discount, which `advanceTimeline` already handles.
   */
  startShift(state.level);
  return true;
}

/**
 * MONEY LANDS WHEN THE GUEST PAYS, NOT AT MIDNIGHT.
 *
 * The operator's report: "when there is no day ending like in real-life there
 * is no accumulating in the bank amount. This is not right." Exactly right - the
 * day used to bank everything at settle, so for the whole of a ten-minute day
 * the player watched a till figure climb while their bank sat at zero, unable
 * to afford anything. On day 1 that is the entire session.
 *
 * So every payment is pushed into the property as it is taken: notes to the
 * till, card to the bank. `state.banked` is the high-water mark of what has
 * already been pushed, so a re-render or a pause can never bank it twice.
 */
/**
 * EXPERIENCE AND THE JOBS BEHIND IT, BANKED AS THEY HAPPEN.
 *
 * The operator: "the experience and the rewards must be in real-time not awarded
 * in the end of the day/shift. You do something, you earn experience."
 *
 * Money already worked this way - see `syncTakings`, which pushes every payment
 * into the till as the guest pays. Experience did not: it was computed once at
 * settle, so an hour at the desk moved nothing on screen until midnight, and the
 * department goals that depend on the work moved nothing either. That is why the
 * only way to make progress happen was the dev panel.
 *
 * `state.banked` is the high-water mark of what has already been pushed, exactly
 * as it is for cash, so a re-render or a pause can never bank the same job twice.
 */
function syncCareer() {
  const shift = state.shift;
  if (!shift) return;
  const experience = Math.max(0, (shift.experience ?? 0) - state.banked.experience);
  const career = {};
  for (const [key, total] of Object.entries(shift.career ?? {})) {
    const delta = total - (state.banked.career[key] ?? 0);
    if (delta > 0) career[key] = delta;
  }
  if (!experience && Object.keys(career).length === 0) return;

  const before = rankOf(state.property).level;
  state.property = recordWork(state.property, { experience, career });
  state.banked.experience += experience;
  for (const [key, delta] of Object.entries(career)) {
    state.banked.career[key] = (state.banked.career[key] ?? 0) + delta;
  }
  // A promotion can now land mid-shift, which is the point of paying live.
  const rank = rankOf(state.property);
  if (rank.canPromote(state.property) && rank.promote(state.property)) {
    state.property = withRank(state.property, rank);
    state.level = rank.level;
    state.unlocked = Math.max(state.unlocked, rank.level);
    localStorage.setItem(KEY_LEVEL, String(rank.level));
    localStorage.setItem(KEY_UNLOCKED, String(state.unlocked));
    analytics.track("promotion", { from: before, to: rank.level });
    toast(`Promoted: ${LEVELS[rank.level].title}`);
    sound.done();
  }
}

function syncTakings() {
  const shift = state.shift;
  if (!shift) return;
  const cash = Math.round(shift.cash) - state.banked.cash;
  const card = Math.round(shift.card) - state.banked.card;
  if (cash === 0 && card === 0) return;
  state.property = {
    ...state.property,
    cash: (state.property.cash ?? 0) + cash,
    bank: (state.property.bank ?? 0) + card,
  };
  state.banked.cash += cash;
  state.banked.card += card;
}

function startShift(level) {
  state.level = level;
  state.banked = { cash: 0, card: 0, experience: 0, career: {} };
  const config = levelConfig(level);
  // A promotion hands you a bigger house and another department. It adds to what
  // you have built; it never knocks a room down or sacks anybody.
  state.property = applyCareerBaseline(
    state.property, config.rooms, config.hired.map((h) => h.role), config.role,
  );
  saveProperty();

  const options = shiftOptions(level);
  const probe = createShift(level, 1, options);
  const fair = fairRate(probe.stars, rating());
  if (!config.pricingEnabled) state.price = null;
  else if (state.price === null) state.price = fair;
  state.shift = createShift(level, 20260808, {
    ...options,
    price: config.pricingEnabled ? state.price : null,
  });
  setPaused(false);
  state.startedAt = Date.now();
  state.lastFrame = performance.now();
  localStorage.setItem(KEY_LEVEL, String(level));
  analytics.levelStart(level);
  el("end-veil").classList.remove("show");
  el("pause").textContent = "Pause";
  jobNodes.clear();
  el("jobs").innerHTML = "";
  el("jobs").dataset.signature = "";
  render();
}

/* -------------------------------------------------------------- render -- */
const jobNodes = new Map();
/** The three group headers, kept so they move with the list instead of being rebuilt. */
const groupHeads = new Map();

/**
 * ONLY the jobs nobody is on, plus the one the player is doing.
 *
 * What staff are handling lives in the crew strip instead, so the list the
 * player reads is exactly the list they can act on. Sorted by task id, a stable
 * order, so rows never reshuffle under a thumb mid-tap.
 */
function myJobs(shift) {
  const board = taskBoard(shift);
  const rows = [];
  if (shift.player.taskId !== null) {
    const mine = shift.tasks.find((t) => t.id === shift.player.taskId);
    if (mine) rows.push({ task: mine, group: "mine", doing: true });
  }
  for (const task of board.mine.slice().sort((a, b) => a.id - b.id)) {
    rows.push({ task, group: "mine", doing: false });
  }
  for (const task of board.staff) rows.push({ task, group: "staff", doing: false });
  for (const task of board.blocked) rows.push({ task, group: "blocked", doing: false });
  return rows;
}

function jobSignature(shift) {
  return myJobs(shift)
    .map(({ task, group, doing }) => `${task.id}:${group}${doing ? "*" : ""}`).join(",");
}

/**
 * The label this task wears TODAY. Only prep differs, and only on day 1 - see
 * the `day1` note on LABEL[TASK.PREP].
 */
function labelFor(task) {
  const meta = LABEL[task.type];
  return meta.day1 && (state.shift?.today ?? 1) === 1 ? { ...meta, ...meta.day1 } : meta;
}

/** One job row, built once and then owned by `jobNodes` until the task goes. */
function makeJobNode(task) {
  const meta = labelFor(task);
  const node = document.createElement("div");
  node.className = "job appear";
  node.dataset.task = String(task.id);

  const badge = document.createElement("div");
  badge.className = `badge ${meta.tone}`;
  badge.textContent = meta.tag;
  node.appendChild(badge);

  const txt = document.createElement("div");
  txt.className = "txt";
  const name = document.createElement("div");
  name.className = "name";
  name.textContent = meta.name;
  const sub = document.createElement("div");
  sub.className = "sub";
  txt.appendChild(name);
  txt.appendChild(sub);
  node.appendChild(txt);

  const where = document.createElement("div");
  where.className = "where";
  where.textContent = task.roomId !== null ? `Rm ${task.roomId + 1}` : "Desk";
  node.appendChild(where);

  const pay = document.createElement("div");
  pay.className = "pay";
  pay.textContent = PAY[task.type];
  node.appendChild(pay);

  const fuse = document.createElement("div");
  fuse.className = "fuse";
  node.appendChild(fuse);

  if (!reduceMotion) {
    node.addEventListener("animationend",
      () => node.classList.remove("appear"), { once: true });
  }
  return node;
}

const GROUP_HEAD = {
  mine: "Waiting on you",
  staff: "Your staff are on these - tap to take over",
  blocked: "Nobody can do these yet",
};

function makeGroupHead(group) {
  const head = document.createElement("div");
  head.className = `grouphead ${group}`;
  head.textContent = GROUP_HEAD[group];
  return head;
}

/**
 * RECONCILE the list. Only touch what actually changed.
 *
 * THE BUG THIS FIXES, and it is invariant 4 in this project's own README being
 * broken in the file the invariant is written in. This used to open with
 * `list.innerHTML = ""` and rebuild every row whenever the task SET changed at
 * all - measured at 46 full rebuilds on day 1, one every 3.9 seconds. Two things
 * followed, and the operator reported both as one symptom:
 *
 *   "i see blinking tasks which i cant start"
 *
 *   1. Every surviving row was a brand new element, so every row replayed the
 *      `appear` animation. One guest arriving made the whole board flash.
 *   2. A rebuild landing between touchstart and click destroyed the node under
 *      the thumb, and the tap went nowhere. Guests then expired while the player
 *      was tapping a row that kept being replaced.
 *
 * So nodes are now CREATED when a task appears, MOVED only if their position
 * changed, and REMOVED only when their task is gone. A row that stays put is not
 * touched at all, which is what makes it tappable.
 */
function buildJobs() {
  const shift = state.shift;
  const list = el("jobs");
  const rows = myJobs(shift);

  if (rows.length === 0) {
    if (list.dataset.signature !== "empty") {
      list.innerHTML = "";
      jobNodes.clear();
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "Nothing waiting on you. It will not last.";
      list.appendChild(empty);
    }
    list.dataset.signature = jobSignature(shift);
    return;
  }
  // Leaving the empty-state card behind would push every job row down by one.
  if (list.dataset.signature === "empty" || list.dataset.signature === "rest") {
    list.innerHTML = "";
    jobNodes.clear();
  }

  // The order the list SHOULD be in, as real elements. Headers are cached on the
  // container so they are moved rather than rebuilt along with everything else.
  const wanted = [];
  let lastGroup = null;
  for (const { task, group } of rows) {
    if (group !== lastGroup) {
      if (!groupHeads.has(group)) groupHeads.set(group, makeGroupHead(group));
      wanted.push(groupHeads.get(group));
      lastGroup = group;
    }
    let node = jobNodes.get(task.id);
    if (!node) {
      node = makeJobNode(task);
      jobNodes.set(task.id, node);
    }
    wanted.push(node);
  }

  const keep = new Set(wanted);
  for (const child of [...list.children]) if (!keep.has(child)) child.remove();
  for (const [id, node] of jobNodes) if (!keep.has(node)) jobNodes.delete(id);

  /**
   * WALK A REFERENCE NODE, DO NOT INDEX THE LIVE COLLECTION.
   *
   * The obvious version of this - `if (list.children[i] !== wanted[i])
   * insertBefore(...)` - is what made the operator report that "everything" was
   * flashing. `list.children` is LIVE: the moment one row is inserted every
   * index below it shifts by one, so every remaining row then compares unequal
   * and gets re-inserted too. Re-inserting a node restarts its CSS animations,
   * so a single new job re-animated the entire board.
   *
   * Measured: the row set changes about once every 3.5 seconds on a real day, so
   * that cascade was firing constantly.
   *
   * Walking a reference pointer instead touches only the rows genuinely out of
   * place, because inserting before `ref` does not move `ref`.
   */
  let ref = list.firstChild;
  for (const node of wanted) {
    if (ref === node) { ref = ref.nextSibling; continue; }
    list.insertBefore(node, ref);
  }

  list.dataset.signature = jobSignature(shift);
}

/**
 * THE CLOCK THE PLAYER SEES, interpolated between heartbeats.
 *
 * `property.clock` is authoritative and is moved by `advanceTimeline` every ten
 * seconds. That is the right cadence for settling a ledger and the wrong one for
 * a clock face: on a 180-second day, ten real seconds is eighty in-game minutes,
 * so the header sat still and then jumped. The operator: "it moves by steps of
 * a lot seconds not second by second."
 *
 * So the eye gets a projection and the books keep the heartbeat. `lastSeenAt` is
 * stamped by the same call that last moved the clock, which is what makes this
 * exact rather than an estimate, and `projected` refuses to roll the day - the
 * heartbeat owns rollover because rollover is a settlement.
 */
/**
 * THE NEXT RANK AND WHAT IT WANTS. B3, and it is painted on every screen state
 * because the complaint was that no goal was visible ANYWHERE.
 *
 * `Progression.blockers` already phrases every gap in terms the player can act
 * on - "260 more experience", "12 rooms (you have 8)". Nothing new is invented
 * here; the rank sheet's own numbers are simply moved to where the player is
 * already looking. It states a direction, never a pass mark: there is no failing
 * this line, only being further from it.
 */
/**
 * The day's profit so far, at four times a second rather than sixty.
 *
 * `paintGoal` runs inside `render`, and `render` runs every animation frame, so
 * a bare `score(shift)` here would price the whole day's F&B trade sixty times a
 * second on a phone. Nothing the player can read changes faster than this, and
 * this file has a history of frame-cost bugs.
 */
let profitCache = { at: 0, value: 0 };
function runningProfit() {
  if (!state.shift || state.shift.over) return 0;
  const now = performance.now();
  if (now - profitCache.at < 250) return profitCache.value;
  profitCache = { at: now, value: Math.max(0, score(state.shift).profit ?? 0) };
  return profitCache.value;
}

function paintGoal() {
  const rank = rankOf(state.property);
  const next = rank.next;
  const label = el("goalrank");
  const need = el("goalneed");
  const bar = el("goalbar");

  if (!next) {
    label.textContent = "General manager";
    need.textContent = "the top of the ladder - now grow the group";
    bar.style.width = "100%";
    return;
  }
  /**
   * THE DEPARTMENT GOAL LEADS, because it is the one the player can go and do.
   *
   * Operator: "There must be some goals like 10 check-ins and 300$ profit to
   * unlock receptionist, and is up to the player what he wants to do." A rank
   * requirement is a consequence; a department goal is an instruction. So the
   * line shows the nearest department you have not opened, and falls back to the
   * rank once they are all open.
   */
  const staffed = (state.property.roster ?? []).map((person) => person.role);
  /**
   * TODAY'S PROFIT COUNTS TOWARD THE GOAL WHILE THE DAY IS STILL RUNNING.
   *
   * Operator's playtest: "it gets to 16$ more profit for finishing Open
   * reception object and stays here no matter what i do." Two things were
   * wrong. The first was real and structural, and is fixed in `settleDay` -
   * lifetime profit was only ever credited by this file, so days that closed
   * any other way never counted. The second is this one: profit is a DAY
   * number, banked at midnight, so even on a day that WAS going to count, the
   * goal line sat frozen for the whole day and only jumped once, at the end.
   * A goal you cannot watch move is the exact thing domain/Unlocks.js exists to
   * get rid of.
   *
   * So the LINE adds the day's profit so far. This is display only - nothing is
   * banked here, `settleDay` still does that once - which is what keeps it
   * honest when the running figure dips as wages accrue.
   */
  const career = { ...state.property.career };
  const running = runningProfit();
  if (running > 0) career.profit = (career.profit ?? 0) + running;
  /**
   * ONLY DEPARTMENTS THIS RANK COULD EMPLOY. Without this the line tells a
   * rank-1 player who has answered a few phones to "Open reservations", which
   * no rank below 4 may employ - an instruction that leads nowhere, and day 5
   * hands out phone calls by design. See nextDepartment.
   */
  const level = rank.level;
  const employable = Object.keys(DEPARTMENT_GOALS).filter((role) => staffCap(level, role) > 0);
  const department = nextDepartment(career, staffed, { employable });
  /**
   * THE EARNED-BUT-UNTAKEN OFFER IS A NOTE, NOT THE GOAL. See nextDepartment's
   * skipMet. The player may never want to hire - working every job yourself and
   * paying nobody is a legitimate way to play - so the line names the next thing
   * to DO and mentions the standing offer beside it.
   */
  const earned = nextDepartment(career, staffed, { employable });
  const ahead = nextDepartment(career, staffed, { employable, skipMet: true });
  if (earned && earned.met && ahead) {
    label.textContent = `Open ${ahead.role}`;
    need.textContent = `${ahead.gaps.map((g) => g.text).join("  -  ")}`
      + `   (a ${earned.role} is waiting on the Staff screen whenever you want one)`;
    bar.style.width = `${Math.max(0, Math.min(100, unlockShare(career, ahead.role) * 100))}%`;
    return;
  }
  if (department && !department.met) {
    label.textContent = `Open ${department.role}`;
    need.textContent = department.gaps.map((g) => g.text).join("  -  ");
    /**
     * BOUND BY WHICHEVER HALF IS FURTHEST BEHIND. This used to read the WORK gap
     * alone, and a met gap is absent from the list - so the bar hit 100% the
     * moment the check-ins were done and sat there while the money was still
     * short. The operator saw a full bar over "$16 more profit". See unlockShare.
     */
    bar.style.width = `${Math.max(0, Math.min(100, unlockShare(career, department.role) * 100))}%`;
    return;
  }
  if (department && department.met) {
    label.textContent = `Hire a ${department.role}`;
    need.textContent = "the goal is met - the position is open on the Staff screen";
    bar.style.width = "100%";
    return;
  }

  const gaps = rank.blockers(state.property);
  label.textContent = `Next: ${next.title}`;
  need.textContent = gaps.length
    ? gaps.map((g) => g.text).join("  -  ")
    : "ready - it lands at the end of the day";
  // Experience is the one gap with a meaningful ratio behind it; the others are
  // thresholds you either meet or do not, and a bar would imply otherwise.
  bar.style.width = `${Math.max(0, Math.min(100,
    (rank.experience / Math.max(1, next.xp)) * 100))}%`;
}

function displayClock() {
  const clock = clockOf(state.property);
  const seen = state.property.lastSeenAt ?? Date.now();
  // Frozen at the instant of pausing - see the note in `frame`. The hotel is
  // stopped, so the clock face has to be stopped with it.
  const at = state.pausedSince ?? Date.now();
  return clock.projected((at - seen) / 1000);
}

/**
 * The floor when today is already settled: no shift, a clock counting down to
 * the next trading day, and every management screen still reachable. This is
 * the state a mobile player spends most of their time in - the hotel is running,
 * they are not on the desk - so it has to say something useful rather than
 * look broken.
 */
function paintRestDay() {
  const clock = displayClock();
  el("clock").textContent = clock.label;
  el("clock").classList.remove("urgent");
  el("lvlnum").textContent = String(rankOf(state.property).level);
  el("daytime").textContent = "rank";
  el("role").textContent = LEVELS[rankOf(state.property).level].title;
  el("bank").textContent = `$${state.property.bank}`;
  el("ratingnow").textContent = rating().toFixed(1);
  paintStars(certification(state.property).stars);
  el("hotelclass").textContent = `${certification(state.property).stars}-star`;
  paintGoal();

  el("money").textContent = "-";
  el("money2").textContent = `$${state.property.cash ?? 0}`;
  el("bank").textContent = `$${state.property.bank}`;
  el("today").textContent = "--";
  el("today").classList.remove("neg");
  el("mgoal").textContent = `day ${clock.day} settled`;
  el("mbar").style.width = "100%";
  el("wagenote").textContent = `next day in ${shortWait(clock.secondsToDayEnd)}`;

  const jobs = el("jobs");
  if (jobs.dataset.signature !== "rest") {
    jobs.innerHTML = "";
    const card = document.createElement("div");
    card.className = "job";
    card.innerHTML = "<div class=\"jobtext\"><b>Today is done</b>"
      + "<span>Your staff have the floor. Build, hire, set the rate, "
      + "or look at the book for tomorrow.</span></div>";
    jobs.appendChild(card);
    jobs.dataset.signature = "rest";
  }
  el("crew").style.display = "none";
}

function paint() {
  const shift = state.shift;
  if (!shift) { paintRestDay(); return; }
  const clock = displayClock();
  const result = score(shift);
  const config = shift.config;

  /**
   * A CLOCK FACE, NOT A COUNTDOWN. Game designer's call, and the rule they
   * wrote down is worth keeping in front of whoever edits this next:
   *
   *   Count DOWN to things that arrive. Count UP, or not at all, for time that
   *   merely passes.
   *
   * `04:12` shrinking and turning red says an amount of your time is being
   * consumed and something is taken away at zero. `14:20` says this is when it
   * is in the hotel. Same underlying number, opposite emotion - and the first
   * one is the arcade frame the operator rejected twice.
   *
   * Build and course timers keep their countdowns: those are things coming
   * TOWARD the player, and they are the reason to come back.
   */
  /**
   * ONE CLOCK. The operator: "i need only 1 clock showing the day i am in and
   * the hour with the new system."
   *
   * There were two, and after the countdown became a clock face they both
   * showed the hour - the header button and the top bar arguing with each
   * other. The top bar now carries the whole thing, "Day 6, 14:20", and the
   * button beside it says what it opens: your rank.
   */
  el("clock").textContent = clock.label;
  el("clock").classList.remove("urgent");
  el("lvlnum").textContent = String(rankOf(state.property).level);
  el("daytime").textContent = "rank";
  el("role").textContent = config.title;
  paintStars(result.stars);
  el("hotelclass").textContent = `${result.stars}-star`;
  el("ratingnow").textContent = rating().toFixed(1);
  paintGoal();

  // TAKINGS, not profit: the till only ever goes up, so a shift no longer opens
  // at minus the payroll. Wages come out at the end, on the results card.
  /**
   * CASH, BANK, TODAY - the three figures the operator asked for.
   *
   * Cash is the till and it moves the moment a guest pays. Bank is what card
   * payments settle into and what the till is swept into overnight. Today is
   * the day's profit so far, and it is the only one of the three that can be
   * negative - which is the honest picture, because wages and stock are being
   * spent whether or not anybody has checked in yet.
   */
  const outgoings = result.wages + result.supplies + result.facilityCosts;
  el("money").textContent = `$${result.takings + result.facilityRevenue}`;
  el("money2").textContent = `$${state.property.cash ?? 0}`;
  el("bank").textContent = `$${state.property.bank}`;
  const today = result.profit;
  el("today").textContent = `${today < 0 ? "-" : "+"}$${Math.abs(today)}`;
  el("today").classList.toggle("neg", today < 0);
  el("mgoal").textContent = `rev $${result.takings + result.facilityRevenue}`
    + `  exp $${outgoings}`;
  el("mbar").style.width = `${Math.max(0, Math.min(100,
    (result.takings / Math.max(1, outgoings)) * 100))}%`;
  el("wagenote").textContent = result.wages
    ? `payroll -$${result.wages} at close` : "no payroll yet";

  // Work on site keeps running while the day is played, so it is worth a glance
  // from the floor rather than only from the build screen.
  const works = el("worksnote");
  const running = state.property.builds.length;
  works.style.display = running ? "" : "none";
  if (running) {
    const soonest = state.property.builds
      .reduce((first, b) => (b.readyAt < first.readyAt ? b : first), state.property.builds[0]);
    works.textContent = `${running} on site - next ${shortWait(buildRemainingSeconds(soonest, Date.now()))}`;
  }

  // RUNNING COSTS. Wages were always visible; stock was not, and without it the
  // player reads occupancy as pure profit. The laundry line is the interesting
  // one - it quotes what a laundry saved, or would have saved, TODAY.
  el("supplies").textContent = `-$${result.supplies}`;
  // Food and beverage against the heads currently in the house. Live, so filling
  // the hotel visibly fills the restaurant.
  const covers = Object.values(result.facilityBreakdown)
    .reduce((total, line) => total + line.covers, 0);
  el("supplybreak").textContent = result.facilityRevenue || result.facilityCosts
    ? `F&B ${result.facilityNet < 0 ? "-" : "+"}$${Math.abs(result.facilityNet)}`
      + ` (${covers} covers of ${result.guestsInHouse})`
    : "";
  el("laundrynote").textContent = result.laundrySwing === 0 ? ""
    : result.hasLaundry
      ? `own laundry saved $${result.laundrySwing}`
      : `a laundry would save $${result.laundrySwing}`;
  el("sat").textContent = String(result.satisfaction);
  el("sbar").style.width = `${shift.satisfaction}%`;
  el("smark").style.left = `${config.targetSatisfaction}%`;
  el("sbar").classList.toggle("short", shift.satisfaction < config.targetSatisfaction);

  // The floor, with who is on each room. "YOU" marks a room nobody is covering.
  const rooms = el("rooms");
  if (rooms.childElementCount !== shift.rooms.length) {
    rooms.innerHTML = "";
    shift.rooms.forEach(() => {
      const node = document.createElement("div");
      node.innerHTML = "<b></b><span></span>";
      rooms.appendChild(node);
    });
  }
  shift.rooms.forEach((room, i) => {
    const node = rooms.children[i];
    const job = shift.tasks.find((t) => t.roomId === room.id && t.doneAt === null);
    const needsMe = Boolean(job && job.claimedBy === null);
    const roomCls = `room ${room.state}` + (needsMe ? " needsme" : "");
    if (node.className !== roomCls) node.className = roomCls;
    // The door number, now that rooms are real doors. Falls back to a position
    // for a standalone shift with no floorplan behind it.
    node.querySelector("b").textContent = room.entity ? String(room.entity.number) : String(i + 1);
    node.querySelector("span").textContent =
      needsMe ? "YOU"
        : job ? "staff"
          : room.state === ROOM.OCCUPIED ? "in" : "ready";
  });

  // the book
  const outstanding = outstandingBookings(shift);
  const free = roomsAvailable(shift);
  const bookNode = el("book");
  bookNode.className = "book" + (outstanding > free ? " tight" : "");
  bookNode.querySelector(".due").textContent = String(outstanding);
  bookNode.querySelector(".free").textContent = String(free);
  const over = bookNode.querySelector(".over");
  over.textContent = shift.overbooked ? `${shift.overbooked} turned away` : "";
  over.style.display = shift.overbooked ? "" : "none";

  // the crew - this is where staff work lives, so it stays off the jobs list
  const crew = el("crew");
  if (crew.childElementCount !== shift.staff.length) {
    crew.innerHTML = "";
    shift.staff.forEach(() => {
      const node = document.createElement("div");
      node.innerHTML = '<div class="top"><i></i><b></b></div>'
        + '<div class="ebar"><span></span></div><em></em>';
      crew.appendChild(node);
    });
    crew.style.display = shift.staff.length ? "" : "none";
  }
  shift.staff.forEach((person, i) => {
    const node = crew.children[i];
    const busy = person.taskId !== null;
    const tired = person.energy < ENERGY_FLOOR;
    node.className = "member" + (busy ? " working" : "") + (tired ? " tired" : "");
    node.querySelector("i").textContent = ROLE_TAG[person.role] || "--";
    node.querySelector("b").textContent = person.role;
    node.querySelector(".ebar span").style.width = `${(person.energy / person.maxEnergy) * 100}%`;
    node.querySelector("em").textContent = tired ? "resting" : busy ? "on a job" : "free";
  });

  // the jobs
  for (const { task, group, doing } of myJobs(shift)) {
    const node = jobNodes.get(task.id);
    if (!node) continue;
    const urgency = taskUrgency(shift, task);

    /**
     * WHILE YOU ARE ON A JOB, NOTHING ELSE CAN BE STARTED - and the board never
     * said so. `canStart` and `canTakeOver` both refuse outright while
     * `player.taskId` is set, yet every other row still went `crit` and shook
     * its badge, which is this UI's loudest "tap me now". The operator tapped,
     * got a refusal toast, and watched guests expire meanwhile:
     *
     *   "i see blinking tasks which i cant start ... and loose guests"
     *
     * Pausing made it worse rather than better, which is why it read as a bug
     * and not as a rule: a paused floor never ticks, so the job in hand never
     * finishes and NOTHING can be started until the game is unpaused again.
     *
     * The fuse keeps running on these rows. That part was honest - the guest
     * really is still waiting - and hiding it would be the dishonest fix.
     */
    const busy = shift.player.taskId !== null && !doing;

    let cls = "job";
    if (doing) cls += " mine";
    else if (group === "staff") cls += " onstaff";
    else if (group === "blocked") cls += " blocked";
    else {
      if (task.type === TASK.ESCORT) cls += " optional";
      if (busy) cls += " waiting";
      else if (urgency > 0.75) cls += " crit";
      else if (urgency > 0.5) cls += " warn";
    }
    if (node.classList.contains("appear")) cls += " appear";
    if (node.classList.contains("flash")) cls += " flash";
    // Only when it actually differs. Assigning the same string still writes the
    // attribute and invites a style recalc sixty times a second, for nothing.
    if (node.className !== cls) node.className = cls;

    const sub = node.querySelector(".sub");
    if (doing) sub.textContent = "You are on it now";
    else if (group === "blocked") sub.textContent = "No room ready - turn or fix one first";
    else if (group === "staff") {
      const person = shift.staff.find((p) => p.id === task.claimedBy);
      sub.textContent = person ? `${person.role} has it` : "staff have it";
    } else if (busy) sub.textContent = "Waiting - you are on another job";
    else if (task.type === TASK.CHECK_IN && task.dueFrom !== undefined
      && shift.time < task.dueFrom) {
      /**
       * THE 14:00 GUARANTEE, SAID OUT LOUD. See WAIT_LADDER in engine.js. An
       * early guest is not a problem yet and the board must not imply they are -
       * but the player has to learn that 14:00 is coming, or the rule is
       * invisible until it bites.
       */
      const mins = Math.max(0, Math.ceil((task.dueFrom - shift.time)
        / hourSeconds(shift) * 60));
      sub.textContent = `Early - check-in is from 14:00 (${mins} min)`;
    } else if (task.type === TASK.CHECK_IN && task.dueFrom !== undefined) {
      const lateHours = (shift.time - task.dueFrom) / hourSeconds(shift);
      sub.textContent = lateHours < WAIT_LADDER.graceHours
        ? "Waiting for their room"
        : `${Math.floor(lateHours)}h late - they are looking elsewhere`;
    } else sub.textContent = labelFor(task).sub;

    const fuse = node.querySelector(".fuse");
    if (doing) {
      const total = taskSeconds(task.type, "player");
      const done = 1 - Math.max(0, (shift.player.busyUntil - shift.time) / total);
      fuse.style.width = `${Math.min(100, done * 100)}%`;
    } else if (task.type === TASK.CHECK_IN && task.dueFrom !== undefined
      && shift.time < task.dueFrom) {
      // NOT TICKING YET. The operator: "the countdown must not start until then."
      fuse.style.width = "100%";
    } else if (task.expiresAt !== null) {
      fuse.style.width = `${(1 - urgency) * 100}%`;
    } else {
      fuse.style.width = "100%";
    }
  }
}

function render() {
  if (el("jobs").dataset.signature !== jobSignature(state.shift)) buildJobs();
  paint();
}

// Delegated once, onto a container that is never replaced.
el("jobs").addEventListener("click", (event) => {
  const node = event.target.closest("[data-task]");
  if (node) pickJob(Number(node.dataset.task));
});

function pickJob(taskId) {
  const shift = state.shift;
  const task = shift.tasks.find((t) => t.id === taskId);
  if (!task) return;

  if (shift.player.taskId !== null) {
    if (shift.player.taskId !== taskId) { sound.nope(); toast("You are already on a job."); }
    return;
  }

  // Mucking in: take a job off a staff member who is drowning.
  if (canTakeOver(shift, taskId)) {
    const person = shift.staff.find((p) => p.id === task.claimedBy);
    state.shift = takeOver(shift, taskId);
    sound.start();
    toast(person ? `Taken off the ${person.role} - you are faster.` : "Taken over.");
    analytics.track("task_take_over", { level: state.level, type: task.type });
    render();
    return;
  }

  if (!canStart(shift, taskId)) {
    sound.nope();
    toast(task.type === TASK.CHECK_IN
      ? "No room ready - turn or fix one first." : "You cannot take that right now.");
    return;
  }
  state.shift = startTask(shift, taskId);
  sound.start();
  analytics.track("task_start", { level: state.level, type: task.type });
  render();
}

/* ----------------------------------------------------------------- loop -- */
function frame(now) {
  requestAnimationFrame(frame);
  const shift = state.shift;
  /**
   * PAUSE STOPS THE HOTEL, NOT JUST THE FLOOR.
   *
   * It used to stop only the floor: the heartbeat kept rolling days and settling
   * them whatever this flag said, so the operator paused and watched the clock
   * carry on without them - and a day could roll over, and be banked, while the
   * game was supposedly stopped.
   *
   * `state.paused` is set from a dozen places (every panel that opens), so the
   * transition is detected HERE rather than at each of them - one choke point
   * that cannot be forgotten by the next thing that opens a screen.
   *
   * Every millisecond spent paused is handed back to `lastSeenAt` on resume, so
   * the pause accrues nothing, rolls nothing, and is not later billed back as
   * time the player was away.
   */
  if (state.paused) {
    if (state.pausedSince === null) state.pausedSince = Date.now();
  } else if (state.pausedSince !== null) {
    state.property.lastSeenAt += Date.now() - state.pausedSince;
    state.pausedSince = null;
    saveProperty();
  }
  // Painted outside the early return so it keeps moving second by second while
  // the game runs. While paused `displayClock` freezes it, which is now honest:
  // the clock is stopped because the hotel is.
  el("clock").textContent = displayClock().label;
  if (!shift || state.paused || shift.over) { state.lastFrame = now; return; }

  const dt = Math.min(0.25, (now - state.lastFrame) / 1000) * state.speed;
  state.lastFrame = now;
  const before = {
    money: shift.money, walked: shift.walkedOut, tips: shift.tips, over: shift.overbooked,
    checkedIn: shift.checkedIn,
  };
  state.shift = tick(shift, dt);
  const after = state.shift;

  // THE HOTEL BEGINS AT THE FIRST KEY HANDED OVER, not at install. Until then
  // there is no trading history and nothing accrues while the game is closed.
  if (after.checkedIn > before.checkedIn && state.property.openedAt === null) {
    state.property = openProperty(state.property, Date.now());
    saveProperty();
    analytics.track("hotel_opened", { level: state.level });
  }

  if (after.overbooked > before.over) {
    sound.lost();
    floatUp("-$90 relocated", "bad");
    toast("Nowhere to put them. Relocated at our cost.");
  } else if (after.walkedOut > before.walked) {
    sound.lost();
    floatUp("walked out", "bad");
  } else if (after.money > before.money) {
    const gained = Math.round(after.money - before.money);
    if (after.tips > before.tips) sound.tip(); else sound.bell();
    floatUp(`+$${gained}`, "good");
  }

  // THE DAY ROLLS, IT DOES NOT END. Settle it and open the next one in the same
  // breath. A modal at a natural boundary is an exit ramp - it is where players
  // quit, which is exactly why level-based games put one there.
  syncTakings();
  syncCareer();
  if (after.over) { endShift(); beginDay(); }
  render();
}

/**
 * EXPERIENCE FOR A DAY WORKED, banked exactly once against `lastAwardedDay`.
 *
 * Split out of `endShift` because there are two ways into it now: the ordinary
 * one, and the case where the heartbeat already banked the MONEY as an absence
 * while the player was actually at the desk. The second path used to pay
 * nothing at all - see the note on the guard in `endShift`.
 */
function awardWorkedDay(result, workedDay) {
  const award = awardDay(state.property, result);
  state.property = award.property;
  state.property.lastAwardedDay = Math.max(
    state.property.lastAwardedDay || 0, workedDay,
  );
  if (award.promoted) {
    state.level = award.to;
    state.unlocked = Math.max(state.unlocked, award.to);
    localStorage.setItem(KEY_LEVEL, String(award.to));
    localStorage.setItem(KEY_UNLOCKED, String(state.unlocked));
    analytics.track("promotion", { from: award.from, to: award.to });
  }
  return award;
}

/**
 * @param {number|null} dayWorked The day this shift BELONGS to. Pass it whenever
 *   the caller has already moved the clock - see the heartbeat.
 */
function endShift(dayWorked = null) {
  const result = score(state.shift);
  const seconds = Math.round((Date.now() - state.startedAt) / 1000);
  analytics.levelComplete(state.level, result.profit, result.target, seconds);
  analytics.track("shift_end", {
    level: state.level, profit: result.profit, takings: result.takings, wages: result.wages,
    satisfaction: result.satisfaction, checked_in: result.checkedIn, walked: result.walkedOut,
    overbooked: result.overbooked, missed: result.missed, passed: result.passed,
  });
  sound.done();

  // Settle the day into the property. Capital carries forward - that is what
  // pays for rooms and facilities later, so a day is never a reset to zero - and
  // the settled net is ALSO what the offline economy is priced from, so the
  // hotel can never be paid for a performance it did not actually turn in.
  const bankBefore = state.property.bank;
  const ratingBefore = rating();
  // THE DAY YOU WORKED IS THE DAY ON THE CLOCK. Recording the day number is
  // what stops the timeline settling it a second time as an unsupervised day -
  // see lastSettledDay in property.js. Without it, working a day and then
  // switching tabs would pay for it twice.
  /**
   * THE DAY THIS SHIFT BELONGS TO, WHICH IS NOT ALWAYS THE DAY ON THE CLOCK.
   *
   * THE BUG: the heartbeat calls `advanceTimeline` FIRST - rolling the clock to
   * the new day - and only then closes the running shift. Reading the day off
   * the clock here therefore recorded the day you had just worked against
   * TOMORROW, and set `lastAwardedDay` a day ahead. So the worked day earned no
   * experience, and the next day found `alreadyAwarded` already true and earned
   * none either. Every day, silently.
   *
   * The caller that moved the clock is the only one that knows which day ended,
   * so it now says.
   */
  const workedDay = dayWorked ?? clockOf(state.property).day;
  /**
   * BANK THE DAY ONCE, whatever route got us here.
   *
   * The guard lives in endShift rather than in each caller because there turned
   * out to be three ways to finish a day twice - working it again from the
   * results card, and re-opening the floor after changing the rate - and a
   * fourth would have been added eventually. A day is settled if the ledger
   * already has it, full stop.
   */
  /**
   * BANKING AND BEING PAID FOR IT ARE TWO DIFFERENT HIGH-WATER MARKS, and
   * collapsing them into one silently ate the player's whole career.
   *
   * THE BUG, reported by the operator as "I was unable to get more experience".
   * `awardDay` is called at the BOTTOM of this function. This guard was at the
   * top and tested `lastSettledDay` - which the ten-second heartbeat sets when
   * `advanceTimeline` rolls the day. `settleTimeline` never awards experience.
   * So whenever the heartbeat rolled the day before this function got to it, the
   * day was banked as an absence and the player earned NOTHING for having worked
   * it - no experience, no ledger row, no promotion check.
   *
   * And the heartbeat wins by default rather than by accident: `frame` clamps
   * `dt` to 0.25s and returns early while paused, so the shift clock can only
   * ever LOSE time against the wall clock, never make it up. Pausing once is
   * enough to guarantee it.
   *
   * So money is still banked once - `lastSettledDay` - and experience is now
   * banked once against its own mark, `lastAwardedDay`. A day that was paid as
   * an absence still owes the player the experience they worked for.
   */
  const alreadySettled = (state.property.lastSettledDay || 0) >= workedDay;
  const alreadyAwarded = (state.property.lastAwardedDay || 0) >= workedDay;
  if (alreadySettled && alreadyAwarded) return;
  if (alreadySettled) {
    // The money went in as an absence. The experience did not go in at all.
    awardWorkedDay(result, workedDay);
    saveProperty();
    return;
  }
  state.property = settleDay(state.property, {
    net: result.profit,
    durationSec: state.shift.config.durationSec,
    rating: result.rating,
    day: workedDay,
    // Room money is already in the till and the bank - settle the rest.
    banked: result.takings,
  }, Date.now());
  // THE NIGHT AUDIT. The day's notes stop being notes and become an account
  // balance, which is what every hotel does at the close of business.
  state.property = nightAudit(state.property);
  state.property.lastSettledDay = Math.max(state.property.lastSettledDay || 0, workedDay);

  // THE DAY'S SALES GO INTO THE BOOK. Without this the reservations desk works
  // for nothing: every call taken would evaporate at midnight and the forward
  // grid would only ever show demand the generator invented.
  if (state.shift.enquiriesTaken.length > 0) {
    const calendar = bookOf(state.property);
    const rooms = sellableRoomList(state.property);
    let placed = 0;
    for (const enquiry of state.shift.enquiriesTaken) {
      const arrivalDay = workedDay + enquiry.inDays;
      const free = calendar.availableRooms(rooms, arrivalDay, enquiry.nights, {
        guests: enquiry.guests,
      });
      if (free.length === 0) continue;
      const room = free.reduce((best, r) =>
        (r.rateMultiplier < best.rateMultiplier ? r : best), free[0]);
      calendar.add(new Booking({
        id: `ph-${workedDay}-${placed}-${Math.floor(Math.random() * 1e6)}`,
        arrivalDay, nights: enquiry.nights, guests: enquiry.guests,
        requestedType: room.type, requestedView: room.view,
        rate: state.shift.roomRate, source: BOOKING_SOURCE.PHONE, roomId: room.id,
      }));
      placed += 1;
    }
    state.property = withBook(state.property, calendar);
  }
  saveProperty();
  if (result.passed && state.level >= state.unlocked && state.level < MAX_LEVEL) {
    state.unlocked = state.level + 1;
    localStorage.setItem(KEY_UNLOCKED, String(state.unlocked));
  }

  /**
   * EXPERIENCE, AND THE PROMOTION IT EVENTUALLY BUYS.
   *
   * A rank is no longer something a level select hands over for clearing a
   * profit target. It is earned by operating - and it needs the property to
   * justify it as well, so nobody grinds a tiny hotel to general manager.
   */
  /**
   * TONIGHT'S PREPARATION BECOMES TOMORROW'S MORNING. Whatever was not used
   * today is not carried on top - a desk prepares for the day ahead, not for
   * the rest of the month.
   */
  state.property = { ...state.property, preppedFor: result.prepDone ?? 0 };
  /**
   * LIFETIME PROFIT IS NOT CREDITED HERE ANY MORE. `settleDay` does it, because
   * that is the funnel EVERY day goes through - including the ones that close
   * while the app is shut, which this path never saw. Crediting it here as well
   * would count a worked day twice. See settleDay in property.js.
   */

  // THE BOOKS. Every line of the day, itemised, before anything summarises it.
  state.property = recordTradingDay(state.property, result, {
    day: workedDay, at: Date.now(), source: "worked",
    occupancy: state.shift.roomCount
      ? Math.round((result.checkedIn / state.shift.roomCount) * 100) / 100 : null,
  });
  const award = awardWorkedDay(result, workedDay);
  saveProperty();

  const moneyOk = result.profit >= result.target;
  el("end-title").textContent = award.promoted
    ? `Promoted: ${LEVELS[award.to].title}`
    : result.passed ? "Good shift."
    : moneyOk ? "You made the money and lost the room."
      : "Not enough in the till.";
  el("end-sub").textContent = award.promoted
    ? `${LEVELS[award.to].subtitle} You may now employ more people - see Staff.`
    : result.passed
    ? `$${result.profit} profit against $${result.target}, guests at ${result.satisfaction}.`
    : !moneyOk
      ? `$${result.profit} profit of the $${result.target} needed `
        + `(takings $${result.takings}, wages $${result.wages}).`
      : `Satisfaction ${result.satisfaction}, you needed ${result.targetSatisfaction}. `
        + "Rushing them has a price.";
  el("end-profit").textContent = `$${result.profit}`;
  el("end-sat").textContent = String(result.satisfaction);
  el("end-in").textContent = String(result.checkedIn);
  el("end-out").textContent = String(result.walkedOut + result.overbooked);
  // The day's P&L, in the order a hotelier reads it.
  const stockLines = Object.entries(result.supplyByKind)
    .filter(([, spent]) => spent > 0)
    .map(([kind, spent]) => `${kind} $${spent}`)
    .join(", ");
  // Every outlet on its own line, with the two numbers an operator reads first:
  // covers, and what it contributed AFTER its own brigade and its own rent.
  const fnbLines = Object.entries(result.facilityBreakdown)
    .map(([key, line]) => {
      const name = key.replace(/_/g, " ");
      const money = `${line.net < 0 ? "-" : "+"}$${Math.abs(line.net)}`;
      if (!line.trades) return `${name} ${money}`;
      if (!line.open) return `${name} SHUT ${money}`;
      return `${name} ${line.covers}cv @$${line.cheque} ${money}`;
    })
    .join(", ");

  el("end-books").textContent =
    `Rooms $${result.takings}`
    + (result.facilityNet ? `  ${result.facilityNet < 0 ? "-" : "+"} F&B `
      + `$${Math.abs(result.facilityNet)}` : "")
    + `  -  wages $${result.wages}  -  stock $${result.supplies}  =  $${result.profit}. `
    + (stockLines ? `Stock: ${stockLines}. ` : "")
    + (fnbLines ? `Facilities: ${fnbLines}. ` : "")
    + (result.facilityLabour
      ? `Brigade $${result.facilityLabour} is charged inside F&B, not in wages. ` : "")
    + (result.coversTurnedAway
      ? `Turned away ${result.coversTurnedAway} covers you had no one to serve. ` : "")
    + `Bank $${bankBefore} to $${state.property.bank}. `
    + `Rate $${result.roomRate}, ${result.tipsGiven} of ${result.escortsDone} guests tipped.`
    + (result.upsells
      ? `Sold ${result.upsells} upgrade${result.upsells === 1 ? "" : "s"} at the desk `
        + `for $${result.upsellRevenue} (${result.upsellsDeclined} declined). ` : "")
    + (result.upgradesGiven
      ? `Gave away ${result.upgradesGiven} better room`
        + `${result.upgradesGiven === 1 ? "" : "s"} for the goodwill. ` : "")
    + (result.enquiriesTaken
      ? `The phone won ${result.enquiriesTaken} stay`
        + `${result.enquiriesTaken === 1 ? "" : "s"} for the days ahead. ` : "")
    + (result.roomsHeldBack
      ? `Your desk kept a room back ${result.roomsHeldBack} time`
        + `${result.roomsHeldBack === 1 ? "" : "s"} rather than sell the last one. ` : "")
    + (result.bookingsDeclined
      ? ` Reservations turned away ${result.bookingsDeclined} booking`
        + `${result.bookingsDeclined === 1 ? "" : "s"} the house could not hold.` : "")
    + (result.laundrySwing === 0 ? ""
      : result.hasLaundry
        ? ` Your laundry saved $${result.laundrySwing} on linen today.`
        : ` Sending linen out cost you $${result.laundrySwing} more than a laundry would.`);

  // What guests actually said, and how it moved the standing reputation.
  // Reputation moves slowly: one night cannot rescue or ruin a hotel, so the
  // property applies the average rather than the night's score.
  const ratingNode = el("end-rating");
  const reviewsNode = el("end-reviews");
  reviewsNode.innerHTML = "";
  if (result.rating !== null) {
    ratingNode.textContent = `Guests rated tonight ${result.rating} / 5  `
      + `(${result.reviews} reviews)  -  hotel now ${rating().toFixed(1)}`
      + (rating() === ratingBefore ? "" : ` (was ${ratingBefore.toFixed(1)})`);
    for (const key of REVIEW_CATEGORIES) {
      const cell = document.createElement("div");
      cell.innerHTML = `<b>${result.categoryAverages[key] ?? "-"}</b><span>${key}</span>`;
      reviewsNode.appendChild(cell);
    }
  } else {
    ratingNode.textContent = "Nobody stayed long enough to leave a review.";
  }

  const box = el("hirebox");
  if (result.passed && state.level < MAX_LEVEL) {
    const next = levelConfig(state.level + 1);
    box.style.display = "";
    el("hire-title").textContent = `Hire a ${state.shift.config.role}`;
    el("hire-body").textContent = "They take it over from now on - slower than you, and "
      + `$${roleWage(state.shift.config.role, 1)} a shift whether they are busy or not. `
      + "You move to "
      + `${next.title.toLowerCase()}. ${next.subtitle}`;
    el("end-next").textContent = "Back to the floor";
  } else if (result.passed) {
    box.style.display = "";
    el("hire-title").textContent = "You have learned every job";
    el("hire-body").textContent = "Five roles is the whole ladder. The hotel is the game now: "
      + "spend the bank on rooms and facilities, and the stars will follow. Next after that: "
      + "several staff per department, training, and poaching a rival's head of department.";
    el("end-next").textContent = "Back to the floor";
  } else {
    box.style.display = "none";
    el("end-next").textContent = "Back to the floor";
  }
  /**
   * SILENCE ON AN ORDINARY DAY, AN INTERRUPT ON A PROMOTION.
   *
   * The contrast is the point. A modal at a natural boundary is an exit ramp -
   * it is where players quit, which is exactly why level-based games put one
   * there - and if every day ends in one, a promotion is just another modal.
   * A day that merely closed gets a toast and a figure the player can pull up.
   */
  if (award.promoted) {
    el("end-veil").classList.add("show");
    setPaused(true);
  } else {
    const arrow = result.profit >= 0 ? "+" : "-";
    toast(`Day ${workedDay} closed ${arrow}$${Math.abs(result.profit)}.`);
  }
}

/* --------------------------------------------------------- staff sheet -- */
/**
 * The people, and the course they are on.
 *
 * Same node discipline as the jobs list and the build screen, because this panel
 * also runs down a clock: rows are created when the SET changes, countdowns are
 * written in place.
 */
const staffNodes = new Map();
let staffTimer = null;
/** On-site or remote. Remembered between visits; it is a standing policy. */
let trainingMode = TRAINING.ON_SITE;

function staffSignature(property) {
  return [
    property.bank,
    property.roster.map((p) => `${p.role}:${p.tier}`).sort().join(","),
    property.facilities.join(","),
    (property.learnedRoles || []).join(","),
    // Rank moves what is locked, so the sheet has to be rebuilt on a promotion.
    rankOf(property).level,
    property.builds.filter((b) => b.kind === BUILD_KIND.TRAINING)
      .map((b) => `${b.id}:${b.mode}`).join(","),
    trainingMode,
  ].join(";");
}

function payroll(property) {
  return property.roster.reduce((total, p) => total + roleWage(p.role, p.tier), 0);
}

function staffSheetNodes() {
  const property = state.property;
  const sheet = el("staff-sheet");
  sheet.innerHTML = "";
  staffNodes.clear();

  el("staff-sub").textContent = property.roster.length
    ? `Payroll $${payroll(property)} a day, paid whether they are needed or not.`
    : "Nobody on the payroll yet.";

  if (property.roster.length === 0) {
    const none = document.createElement("p");
    none.style.color = "var(--muted)";
    none.textContent = "You are the entire hotel. Finish a day to hire your first.";
    sheet.appendChild(none);
  } else {
    // The standing choice: cover, or speed. Stated as the trade it actually is.
    const modes = document.createElement("div");
    modes.className = "modes";
    for (const [mode, label] of [[TRAINING.ON_SITE, "On site"], [TRAINING.REMOTE, "Remote"]]) {
      const button = document.createElement("button");
      button.textContent = label;
      button.className = mode === trainingMode ? "" : "off";
      button.dataset.mode = mode;
      modes.appendChild(button);
    }
    sheet.appendChild(modes);

    const explain = document.createElement("p");
    explain.className = "roadmap";
    explain.style.margin = "0 0 8px";
    explain.textContent = trainingMode === TRAINING.ON_SITE
      ? "On site: they leave the floor entirely until the course ends. That department is "
        + "dark - including for the hours you are away."
      : "Remote: they stay on the desk and learn through it, so the same course takes "
        + `${REMOTE_TRAINING_MULTIPLIER}x as long. Same fee.`;
    sheet.appendChild(explain);
  }

  // Sorted so the kitchen and the floor sit together, and so a second waiter
  // lands next to the first rather than at the bottom of the list.
  const ordered = property.roster
    .map((person, index) => ({ person, index }))
    .sort((a, b) => (isFnbRole(a.person.role) ? 1 : 0) - (isFnbRole(b.person.role) ? 1 : 0)
      || a.person.role.localeCompare(b.person.role));

  let seenOfRole = {};
  for (const { person, index } of ordered) {
    const spec = TIERS[person.tier];
    const nextTier = TIERS[person.tier + 1];
    const course = property.builds.find((b) => b.kind === BUILD_KIND.TRAINING
      && b.role === person.role);
    seenOfRole[person.role] = (seenOfRole[person.role] || 0) + 1;
    const nth = seenOfRole[person.role];
    const several = staffCount(property, person.role) > 1;

    const row = document.createElement("div");
    row.className = "row" + (course ? " working" : "");
    const who = document.createElement("div");
    who.className = "who";
    who.innerHTML = "<b></b><span></span>";
    who.querySelector("b").textContent = several ? `${person.role} ${nth}` : person.role;
    row.appendChild(who);
    if (course) {
      const bar = document.createElement("div");
      bar.className = "wbar";
      bar.innerHTML = "<span></span>";
      who.appendChild(bar);
    }

    const button = document.createElement("button");
    if (course) {
      button.textContent = "On a course";
      button.disabled = true;
    } else if (!nextTier) {
      button.textContent = "Top tier";
      button.disabled = true;
      button.title = "Nothing left to teach them";
    } else {
      const blocker = trainingBlocker(property, person.role, trainingMode);
      button.textContent = `Train $${spec.upgradeCost}`;
      button.disabled = Boolean(blocker);
      button.title = blocker
        || `${shortWait(trainingSeconds(person.tier + 1, trainingMode))} to ${nextTier.name}`;
      if (!blocker) button.dataset.train = person.role;
    }
    row.appendChild(button);

    sheet.appendChild(row);
    staffNodes.set(index, row);
  }

  // OPEN POSITIONS. The ladder staffs each department as you are promoted out of
  // it, but never the one you are standing in - which is why the reservations
  // desk can only ever be filled here.
  const open = openPositions(property);
  if (open.length) {
    const head = document.createElement("div");
    head.className = "sectionhead";
    head.textContent = "Departments you can staff";
    sheet.appendChild(head);

    for (const role of open) {
      const fee = recruitmentFee(role);
      const blocker = hireBlocker(property, role);
      const row = document.createElement("div");
      row.className = "row" + (blocker ? " cantafford" : "");
      const who = document.createElement("div");
      who.className = "who";
      who.innerHTML = "<b></b><span></span>";
      who.querySelector("b").textContent = role;
      who.querySelector("span").textContent = blocker
        || (isFnbRole(role)
          ? `$${roleWage(role, 1)}/day. ${fnbHireReason(property, role)}`
          : role === property.ownerRole
            ? `$${roleWage(role, 1)}/day. You work this desk yourself, so they hold it `
              + "while you are away."
            : `$${roleWage(role, 1)}/day, and they cover it while you are away.`);
      if (blocker) who.querySelector("span").className = "why";
      row.appendChild(who);

      const price = document.createElement("div");
      price.className = "cost";
      price.textContent = `$${fee}`;
      row.appendChild(price);

      const button = document.createElement("button");
      button.textContent = "Hire";
      button.disabled = Boolean(blocker);
      if (!blocker) button.dataset.hire = role;
      row.appendChild(button);
      sheet.appendChild(row);
    }
  }

  /**
   * THE REST OF THE LADDER, locked, with the rank that opens each one. B2.
   *
   * The player has to be able to see the shape of the career they are in from
   * the first day of it. Shown after the positions they CAN fill, so it reads as
   * what comes next rather than as a list of refusals.
   */
  const locked = lockedDepartments(property);
  if (locked.length) {
    const head = document.createElement("div");
    head.className = "sectionhead";
    head.textContent = "Not yet open to you";
    sheet.appendChild(head);

    for (const { role, reason } of locked) {
      const row = document.createElement("div");
      row.className = "row cantafford";
      const who = document.createElement("div");
      who.className = "who";
      who.innerHTML = "<b></b><span class=\"why\"></span>";
      who.querySelector("b").textContent = role;
      who.querySelector("span").textContent = reason;
      row.appendChild(who);

      const price = document.createElement("div");
      price.className = "cost";
      price.textContent = `$${recruitmentFee(role)}`;
      row.appendChild(price);

      const button = document.createElement("button");
      button.textContent = "Locked";
      button.disabled = true;
      row.appendChild(button);
      sheet.appendChild(row);
    }
  }

  const note = document.createElement("p");
  note.className = "roadmap";
  note.textContent = "Training raises SKILL - how fast they work and what they cost - and never "
    + "stamina: you cannot send someone on a course and get back more constitution. Planned: "
    + "several people per department, experience earned by working, and poaching a rival's "
    + "head of department.";
  sheet.appendChild(note);

  sheet.dataset.signature = staffSignature(property);
}

/** Per-second repaint: course clocks and energy only, never structure. */
function paintStaffSheet() {
  const now = Date.now();
  const property = state.property;
  const shift = state.shift;

  property.roster.forEach((person, index) => {
    const row = staffNodes.get(index);
    if (!row) return;
    const spec = TIERS[person.tier];
    const course = property.builds.find((b) => b.kind === BUILD_KIND.TRAINING
      && b.role === person.role);
    // Energy belongs to the person working TODAY, so it comes from the shift.
    const onFloor = shift ? shift.staff.find((s) => s.role === person.role) : null;

    let status = `${spec.name} - $${roleWage(person.role, person.tier)}/day`;
    if (course) {
      status += ` - ${course.mode === TRAINING.REMOTE ? "remote course" : "away on a course"}, `
        + `${shortWait(buildRemainingSeconds(course, now))} left`;
    } else if (onFloor) {
      status += ` - energy ${Math.round(onFloor.energy)}/${onFloor.maxEnergy}`;
    }
    row.querySelector("span").textContent = status;

    const bar = row.querySelector(".wbar span");
    if (course && bar) bar.style.width = `${buildProgress(course, now) * 100}%`;
  });
}

function renderStaffSheet() {
  if (el("staff-sheet").dataset.signature !== staffSignature(state.property)) staffSheetNodes();
  paintStaffSheet();
}

el("staff-sheet").addEventListener("click", (event) => {
  const modeNode = event.target.closest("[data-mode]");
  if (modeNode) {
    trainingMode = modeNode.dataset.mode;
    renderStaffSheet();
    return;
  }

  const hireNode = event.target.closest("[data-hire]");
  if (hireNode) {
    const role = hireNode.dataset.hire;
    const blocker = hireBlocker(state.property, role);
    if (blocker) { sound.nope(); toast(blocker); return; }
    state.property = hire(state.property, role);
    // ON THE FLOOR TODAY, not after the next refresh. See addStaffToShift.
    if (state.shift && !state.shift.over) state.shift = addStaffToShift(state.shift, { role });
    saveProperty();
    sound.done();
    toast(role === state.property.ownerRole
      ? `${role} hired - they hold the desk while you are away.`
      : `${role} hired at $${roleWage(role, 1)} a day.`);
    analytics.track("hire", { role, fee: recruitmentFee(role) });
    renderStaffSheet();
    render();
    return;
  }

  const node = event.target.closest("[data-train]");
  if (!node) return;
  const role = node.dataset.train;
  const blocker = trainingBlocker(state.property, role, trainingMode);
  if (blocker) { sound.nope(); toast(blocker); return; }

  const person = findStaff(state.property, role);
  const seconds = trainingSeconds(person.tier + 1, trainingMode);
  state.property = startTraining(state.property, role, trainingMode, Date.now());
  saveProperty();
  sound.bell();
  toast(trainingMode === TRAINING.ON_SITE
    ? `${role} is off the floor for ${shortWait(seconds)}.`
    : `${role} is on a remote course - ${shortWait(seconds)}, still working.`);
  analytics.track("training_start", { role, mode: trainingMode, seconds, tier: person.tier + 1 });
  renderStaffSheet();
});

/* ------------------------------------------------------ star inspection -- */
/**
 * THE PROGRESS SHEET - what your rank is, and precisely what is between you and
 * the next one.
 *
 * Replaces the level select, which let a player jump to any shift they had
 * cleared. That made sense when a level was a self-contained puzzle. It makes
 * none at all now that there is one hotel on one timeline: you cannot replay
 * day 6, and your rank is a thing you hold rather than a thing you pick.
 */
function renderProgressSheet() {
  const property = state.property;
  const rank = rankOf(property);
  const sheet = el("lvl-grid");
  sheet.innerHTML = "";

  el("lvl-title").textContent = LEVELS[rank.level].title;
  const next = rank.next;
  el("lvl-sub").textContent = next
    ? `${rank.experience} experience. ${LEVELS[rank.level].subtitle}`
    : `${rank.experience} experience. You have run every department there is.`;

  if (next) {
    const head = document.createElement("div");
    head.className = "sectionhead";
    head.textContent = `To make ${next.title.toLowerCase()}`;
    sheet.appendChild(head);

    const blockers = rank.blockers(property);
    if (blockers.length === 0) {
      const row = document.createElement("div");
      row.className = "row";
      row.innerHTML = "<div class=\"who\"><b>Ready</b><span>Finish a day and the "
        + "promotion is yours.</span></div>";
      sheet.appendChild(row);
    }
    for (const gap of blockers) {
      const row = document.createElement("div");
      row.className = "row";
      const who = document.createElement("div");
      who.className = "who";
      who.innerHTML = "<b></b><span></span>";
      who.querySelector("b").textContent = gap.text;
      who.querySelector("span").textContent = gap.kind === "experience"
        ? "earned by selling nights, keeping guests happy, and turning a profit"
        : "the property has to justify the rank, not just your experience";
      row.appendChild(who);
      sheet.appendChild(row);
    }
  }

  const caps = document.createElement("div");
  caps.className = "sectionhead";
  caps.textContent = "People you may employ";
  sheet.appendChild(caps);
  for (const [role, cap] of Object.entries(LEVELS[rank.level].staffCaps)) {
    const row = document.createElement("div");
    row.className = "row";
    const who = document.createElement("div");
    who.className = "who";
    who.innerHTML = "<b></b><span></span>";
    who.querySelector("b").textContent = role;
    who.querySelector("span").textContent = `${staffCountOf(property, role)} of ${cap}`;
    row.appendChild(who);
    sheet.appendChild(row);
  }

  const note = document.createElement("p");
  note.className = "roadmap";
  note.textContent = "Rank is earned by running the hotel, not by clearing a target. It "
    + "decides how many people you may employ - growing the front desk is a promotion, not "
    + "a purchase - and how much of the operation you are shown.";
  sheet.appendChild(note);
}

function staffCountOf(property, role) {
  return property.roster.filter((p) => p.role === role).length;
}

function renderStarSheet() {
  const shift = state.shift;
  const cert = shift.certification;
  const sheet = el("star-sheet");
  sheet.innerHTML = "";

  el("star-title").textContent = `${cert.stars}-star hotel`;
  el("star-sub").textContent = cert.missing.length
    ? `Stars are certified, not earned by service. For ${cert.nextStar} stars you still need:`
    : "This property meets every requirement of its class.";

  for (const gap of cert.missing) {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `<div class="who"><b>${gap}</b><span>required for `
      + `${cert.nextStar} stars</span></div>`;
    sheet.appendChild(row);
  }

  const note = document.createElement("p");
  note.className = "roadmap";
  note.textContent = `Your guests rate you ${rating().toFixed(1)} out of 5 - that is `
    + "reputation, and it decides what you can charge. Stars are the building: rooms, "
    + "a restaurant, a bar, the departments you staff. A spotless 1-star is still a "
    + "1-star. Build is where you spend the bank on the ones you are missing.";
  sheet.appendChild(note);
}

el("starbtn").addEventListener("click", () => {
  renderStarSheet();
  openPanel("star-veil");
});
el("star-close").addEventListener("click", () => closePanel("star-veil"));

/* --------------------------------------------------------------- build -- */
/**
 * The build screen. Same discipline as the jobs list and for the same reason:
 * this panel repaints every second to run down the clocks, so rows are created
 * only when the SET of things changes and everything time-varying is written in
 * place. Rebuilding it on the tick would destroy a button under a thumb.
 */
const buildNodes = new Map();
let buildTimer = null;

function buildSignature(property) {
  return [
    property.bank, property.rooms, property.upgradedRooms,
    property.facilities.slice().sort().join("|"),
    property.builds.map((b) => `${b.id}:${b.key}:${b.readyAt}`).join(","),
  ].join(";");
}

/** The next room in line for a refurbishment - the first one not already done. */
function nextRefurbRoom(property) {
  const queued = property.builds.filter((b) => b.kind === BUILD_KIND.REFURB).length;
  return property.upgradedRooms + queued;
}

function buildOptionsFor(key) {
  return key === REFURB ? { roomId: nextRefurbRoom(state.property) } : {};
}

function makeRow(className) {
  const row = document.createElement("div");
  row.className = className;
  const who = document.createElement("div");
  who.className = "who";
  who.innerHTML = "<b></b><span></span>";
  row.appendChild(who);
  return row;
}

function buildSheetNodes() {
  const property = state.property;
  const sheet = el("build-sheet");
  sheet.innerHTML = "";
  buildNodes.clear();

  if (property.builds.length) {
    const head = document.createElement("div");
    head.className = "sectionhead";
    head.textContent = "On site now";
    sheet.appendChild(head);

    for (const work of property.builds) {
      const row = makeRow("row working");
      row.dataset.work = String(work.id);
      row.querySelector("b").textContent = work.label;
      const bar = document.createElement("div");
      bar.className = "wbar";
      bar.innerHTML = "<span></span>";
      row.querySelector(".who").appendChild(bar);

      const free = maintenanceSpeedUpSeconds(property);
      const used = (work.speedUps || []).some((s) => s.source === "maintenance");
      const button = document.createElement("button");
      button.textContent = free && !used ? `-${shortWait(free)}` : "--";
      button.disabled = !free || used;
      button.title = !free
        ? "Hire a maintenance man and they will shorten a job for you"
        : used ? "Maintenance have already been on this one" : "Free, from your maintenance man";
      if (!button.disabled) button.dataset.speed = String(work.id);
      row.appendChild(button);

      sheet.appendChild(row);
      buildNodes.set(`w${work.id}`, row);
    }
  }

  const head = document.createElement("div");
  head.className = "sectionhead";
  head.textContent = "Spend the bank";
  sheet.appendChild(head);

  for (const key of Object.keys(BUILD_CATALOG)) {
    const spec = BUILD_CATALOG[key];
    const options = buildOptionsFor(key);
    const blocker = buildBlocker(property, key, options);
    const cost = buildCost(property, key);

    // A facility already standing is not a thing to buy; it is a thing you have.
    if (spec.kind === BUILD_KIND.FACILITY && property.facilities.includes(key)) continue;

    const row = makeRow("row" + (blocker ? " cantafford" : ""));
    if (!blocker) row.dataset.build = key;
    row.querySelector("b").textContent = key === BUILD_ROOM
      ? `${spec.label} (${property.rooms + 1} in total)` : spec.label;
    const sub = row.querySelector("span");
    sub.textContent = blocker || spec.note;
    if (blocker) sub.className = "why";

    const price = document.createElement("div");
    price.className = "cost";
    price.textContent = `$${cost}`;
    row.appendChild(price);

    const button = document.createElement("button");
    button.textContent = shortWait(spec.seconds);
    button.disabled = Boolean(blocker);
    if (!blocker) button.dataset.build = key;
    row.appendChild(button);

    sheet.appendChild(row);
  }

  const note = document.createElement("p");
  note.className = "roadmap";
  note.textContent = "Work runs on a real clock and keeps running while the game is closed. "
    + "A room being built is not yours to sell yet, and a room being refurbished is out of "
    + "service until the work is done. Planned: a rewarded speed-up for when you are genuinely "
    + "waiting, and a maintenance manager whose free one gets longer as they are trained.";
  sheet.appendChild(note);

  sheet.dataset.signature = buildSignature(property);
}

/** The per-second repaint: clocks and bars only, never structure. */
function paintBuildSheet() {
  const now = Date.now();
  const property = state.property;
  const cert = certification(property);

  el("build-title").textContent = `${cert.stars}-star, ${property.rooms} rooms`;
  el("build-sub").textContent = `$${property.bank} in the bank. `
    + `${sellableRooms(property)} rooms sellable tonight`
    + (roomsUnderConstruction(property) ? `, ${roomsUnderConstruction(property)} being built` : "")
    + ". "
    + (cert.missing.length
      ? `For ${cert.nextStar} stars you still need: ${cert.missing.join(", ")}.`
      : "This property meets every requirement of its class.");

  for (const work of property.builds) {
    const row = buildNodes.get(`w${work.id}`);
    if (!row) continue;
    row.querySelector("span").textContent = `${shortWait(buildRemainingSeconds(work, now))} left`;
    row.querySelector(".wbar span").style.width = `${buildProgress(work, now) * 100}%`;
  }
}

function renderBuildSheet() {
  if (el("build-sheet").dataset.signature !== buildSignature(state.property)) buildSheetNodes();
  paintBuildSheet();
}

/**
 * Finished work is applied wherever we notice it - on the build screen, on
 * return to the app, at the end of a day. `advanceBuilds` is idempotent, so
 * calling it often is cheap and calling it late is only ever a display lag.
 */
function collectFinishedWork(announce = true) {
  const done = advanceBuilds(state.property, Date.now());
  if (done.completed.length === 0) return [];
  state.property = done.property;
  saveProperty();
  if (announce) {
    // A facility is not open the moment the builders leave - you do not start
    // serving dinner at four in the afternoon. It trades from the next day, and
    // saying so is better than letting the player wonder why nothing changed.
    const opensTomorrow = done.completed.some((b) => b.kind === BUILD_KIND.FACILITY
      || b.kind === BUILD_KIND.ROOM);
    toast(done.completed.length === 1
      ? `${done.completed[0].label} is finished.${opensTomorrow ? " Open from tomorrow." : ""}`
      : `${done.completed.length} jobs finished on site.`
        + `${opensTomorrow ? " In service from tomorrow." : ""}`);
    sound.done();
  }
  analytics.track("build_complete", { count: done.completed.length });
  return done.completed;
}

el("buildbtn").addEventListener("click", () => {
  collectFinishedWork();
  renderBuildSheet();
  openPanel("build-veil");
  clearInterval(buildTimer);
  buildTimer = setInterval(() => {
    collectFinishedWork();
    renderBuildSheet();
  }, 1000);
});

el("build-close").addEventListener("click", () => {
  closePanel("build-veil");
  clearInterval(buildTimer);
  buildTimer = null;
});

/* ------------------------------------------------ food and beverage --- */
/**
 * THE F&B SCREEN.
 *
 * One card per outlet the property has BUILT, showing the four things an
 * operator looks at before anything else: is it open, who is in it, what it
 * charges, and what it made today. The two decisions live here - the brigade
 * and the menu price - because they are the same decision seen from two ends,
 * and splitting them across two screens hides that.
 *
 * Repainted on open and after every action, never on a timer: nothing on it
 * counts down.
 */

/** Why you would hire this trade, said in the terms the outlet cares about. */
function fnbHireReason(property, role) {
  const outlets = property.facilities.filter((f) => outletBrigade(f).includes(role));
  if (outlets.length === 0) return "No outlet needs one yet.";
  const shut = outlets.filter((f) => outletCapacity(f, property.roster).covers === 0);
  const names = (list) => list.map((f) => OUTLET_SPEC[f].label.toLowerCase()).join(" and ");
  return shut.length
    ? `The ${names(shut)} cannot open without one.`
    : `More covers in the ${names(outlets)}.`;
}

/** The outlets this property owns, in the order money flows through them. */
function builtOutlets(property) {
  return ["breakfast", "restaurant", "bar", "room_service", "spa"]
    .filter((key) => property.facilities.includes(key));
}

/** Today's line for an outlet, read from the day currently on the floor. */
function outletLine(outlet) {
  const result = state.shift ? score(state.shift) : null;
  return result && result.facilityBreakdown ? result.facilityBreakdown[outlet] : null;
}

function renderFnbSheet() {
  const property = state.property;
  const sheet = el("fnb-sheet");
  const stars = state.shift ? state.shift.stars : certification(property).stars;
  sheet.innerHTML = "";

  const outlets = builtOutlets(property);
  el("fnb-sub").textContent = outlets.length
    ? "An outlet with nobody in it does not open - and still pays its rent. The price you "
      + "set moves how many guests eat in AND what every cover is worth."
    : "You have not built an outlet yet. Breakfast is the cheapest way in, and it is what a "
      + "second star needs.";

  for (const outlet of outlets) {
    const spec = OUTLET_SPEC[outlet];
    const capacity = outletCapacity(outlet, property.roster);
    const price = menuPrice(property, outlet, stars);
    const band = menuBand(outlet, stars);
    const line = outletLine(outlet);

    const card = document.createElement("div");
    card.className = "row" + (capacity.missing.length ? " cantafford" : "");

    const who = document.createElement("div");
    who.className = "who";
    who.innerHTML = "<b></b><span></span>";
    who.querySelector("b").textContent = spec.label;

    // Who is in it, and - if it is short-handed - exactly which trade to hire.
    const brigade = outletBrigade(outlet);
    const crewText = brigade.length === 0
      ? "no brigade modelled yet"
      : brigade.map((role) => `${staffCount(property, role)} ${role}`).join(", ");
    let status;
    if (capacity.missing.length) {
      status = `SHUT - no ${capacity.missing.join(", no ")}. Upkeep is charged anyway.`;
    } else if (capacity.covers === Infinity) {
      status = `${crewText} - no capacity limit modelled`;
    } else {
      status = `${crewText} - serves ${Math.round(capacity.covers)} covers`
        + (capacity.limitedBy ? `, capped by the ${capacity.limitedBy}` : "");
    }
    who.querySelector("span").textContent = status;
    if (capacity.missing.length) who.querySelector("span").className = "why";
    card.appendChild(who);
    sheet.appendChild(card);

    // The menu price. Same control as the room rate, same logic, its own units.
    const priceRow = document.createElement("div");
    priceRow.className = "menurow";
    priceRow.innerHTML = "<label></label><input type=\"range\" aria-label=\"Menu price\"><b></b>";
    const range = priceRow.querySelector("input");
    range.min = String(band.min);
    range.max = String(band.max);
    range.value = String(Math.max(band.min, Math.min(band.max, price)));
    range.dataset.menu = outlet;
    priceRow.querySelector("label").textContent = "Per cover";
    priceRow.querySelector("b").textContent = `$${price} `
      + (price === band.fair ? "fair" : price > band.fair ? "over" : "under");
    sheet.appendChild(priceRow);

    // The outlet's own P&L, in the order a restaurant manager reads it.
    const books = document.createElement("p");
    books.className = "roadmap";
    books.style.margin = "0 0 10px";
    if (!line || !line.trades) {
      books.textContent = "";
    } else if (!line.open) {
      books.textContent = `Closed today. Upkeep -$${line.upkeep}`
        + (line.labour ? `, brigade -$${line.labour}` : "")
        + (line.turnedAway ? `. ${line.turnedAway} guests wanted it.` : ".");
    } else {
      books.textContent = `${line.covers} covers at $${line.cheque} = $${line.revenue}`
        + `  -  food $${line.foodCost} (${line.foodCostPct}%)`
        + `  -  drink $${line.drinkCost} (${line.pourCostPct}%)`
        + (line.waste ? `  -  waste $${line.waste}` : "")
        + `  -  brigade $${line.labour}  -  upkeep $${line.upkeep}`
        + `  =  ${line.net < 0 ? "-" : "+"}$${Math.abs(line.net)}`
        + (line.turnedAway
          ? `. Turned away ${line.turnedAway} (${line.refusedShare}%) - another `
            + `${line.limitedBy} would serve them.`
          : ".");
    }
    sheet.appendChild(books);
  }

  // The brigade you can still take on, without leaving the screen.
  const openings = openPositions(property).filter(isFnbRole);
  if (openings.length) {
    const head = document.createElement("div");
    head.className = "sectionhead";
    head.textContent = "Kitchen and floor";
    sheet.appendChild(head);

    for (const role of openings) {
      const blocker = hireBlocker(property, role);
      const row = document.createElement("div");
      row.className = "row" + (blocker ? " cantafford" : "");
      const who = document.createElement("div");
      who.className = "who";
      who.innerHTML = "<b></b><span></span>";
      who.querySelector("b").textContent = staffCount(property, role)
        ? `Another ${role}` : role;
      who.querySelector("span").textContent = blocker
        || `$${roleWage(role, 1)}/day. ${fnbHireReason(property, role)}`;
      if (blocker) who.querySelector("span").className = "why";
      row.appendChild(who);

      const cost = document.createElement("div");
      cost.className = "cost";
      cost.textContent = `$${recruitmentFee(role)}`;
      row.appendChild(cost);

      const button = document.createElement("button");
      button.textContent = "Hire";
      button.disabled = Boolean(blocker);
      if (!blocker) button.dataset.hire = role;
      row.appendChild(button);
      sheet.appendChild(row);
    }
  }

  const note = document.createElement("p");
  note.className = "roadmap";
  note.textContent = "Food cost is what the plate costs to make, so charging more widens the "
    + "margin - up to the point where the dining room empties and the kitchen bins what it "
    + "prepped. Drink is a pour cost, a percentage, which is why the bar is the profitable "
    + "half of every hotel's F&B. Planned: purchase orders and par levels, a head chef whose "
    + "menu lifts capture, and covers walking in from the street.";
  sheet.appendChild(note);
}

/* --------------------------------------------------------------- rooms -- */
/**
 * THE ROOMS SCREEN.
 *
 * The property's actual building, floor by floor. This is where the operator's
 * "the rooms view is very important" becomes something the player can act on:
 * until you can SEE that 306 is a sea-view junior suite and 102 is an interior
 * single, the fact that they earn different money is invisible and might as well
 * not be modelled.
 *
 * IT REVEALS ITSELF WITH RANK, and the simulation underneath never changes. A
 * level-1 player sees eight doors and their state - that is all a receptionist
 * needs. Type and condition appear at 2, the view and what it is worth at 3,
 * floors and features at 4. The hotel is the same hotel throughout; only the
 * instrumentation grows. See Progression.js for why that is the right way round.
 *
 * Repainted on open and after any action. Nothing on it counts down, so it does
 * not need a timer - which also means it can afford to be the densest screen in
 * the game without costing anything on a phone.
 */

/** The rank we are drawing for. Career level today; Progression.level later. */
function roomReveal(feature) {
  return reveals(state.level, feature);
}

/** A room's worth against the average room in this house, as a percentage. */
function roomPremium(room, house) {
  const average = house.reduce((sum, r) => sum + r.rateMultiplier, 0) / Math.max(1, house.length);
  return Math.round((room.rateMultiplier / (average || 1) - 1) * 100);
}

/** What the day currently thinks of this room, if a day is running. */
function roomLiveState(room) {
  const shift = state.shift;
  if (!shift) return null;
  return shift.rooms.find((r) => r.id === room.id) ?? null;
}

function renderRoomsSheet() {
  const property = state.property;
  const house = houseOf(property);
  const sheet = el("rooms-sheet");
  sheet.innerHTML = "";

  const site = SITE_SPEC[property.site] ?? SITE_SPEC.city;
  el("rooms-sub").textContent = roomReveal("roomView")
    ? `${describeHouse(house)}. ${site.note}`
    : describeHouse(house);

  // Sorted by door number, which is also floor order - the way a housekeeping
  // sheet is printed, and the order a person walks the building in.
  const byFloor = new Map();
  for (const room of [...house].sort((a, b) => a.number - b.number)) {
    if (!byFloor.has(room.floor)) byFloor.set(room.floor, []);
    byFloor.get(room.floor).push(room);
  }

  for (const [floor, rooms] of [...byFloor.entries()].sort((a, b) => a[0] - b[0])) {
    if (roomReveal("roomFloor") && byFloor.size > 1) {
      const head = document.createElement("div");
      head.className = "sectionhead";
      head.textContent = `Floor ${floor}`;
      sheet.appendChild(head);
    }

    for (const room of rooms) {
      const live = roomLiveState(room);
      const stateKey = live ? live.state : room.state;

      const row = document.createElement("div");
      row.className = `row roomrow ${stateKey}`;

      const door = document.createElement("b");
      door.className = "door";
      door.textContent = String(room.number);
      row.appendChild(door);

      const who = document.createElement("div");
      who.className = "who";
      who.innerHTML = "<b></b><span></span>";

      // The headline: what this room IS, as much of it as the rank reveals.
      const title = [];
      if (roomReveal("roomType")) title.push(room.spec.label);
      if (roomReveal("roomView")) title.push(`${VIEW_SPEC[room.view].label.toLowerCase()} view`);
      who.querySelector("b").textContent = title.join(", ") || "Guest room";

      // The line under it: capacity always - it is the thing that decides who
      // can sleep here and a receptionist needs it from day one - then condition
      // and features as they unlock.
      const detail = [`sleeps ${room.capacity}`];
      if (room.spareBedSlots > 0 && roomReveal("roomType")) {
        detail.push(`+${room.spareBedSlots} extra bed${room.spareBedSlots === 1 ? "" : "s"}`);
      }
      // Condition is only worth a word when it is NOT standard - printing
      // "standard" on nineteen rows out of twenty is noise, and it buries the
      // one tired room that actually needs the player's money.
      if (roomReveal("roomCondition") && room.condition !== "standard") {
        detail.push(CONDITION_SPEC[room.condition].label.toLowerCase());
      }
      if (roomReveal("roomFeatures")) {
        for (const f of room.features) detail.push(FEATURE_SPEC[f].label.toLowerCase());
      }
      who.querySelector("span").textContent = detail.join(" - ");
      row.appendChild(who);

      // What it is worth. Only once the player has something to do with the
      // information - before level 3 there is no allocation decision to make,
      // so a premium column would be noise.
      if (roomReveal("roomView")) {
        const premium = roomPremium(room, house);
        const worth = document.createElement("div");
        worth.className = `cost ${premium > 0 ? "over" : premium < 0 ? "under" : ""}`;
        worth.textContent = premium === 0 ? "rate" : `${premium > 0 ? "+" : ""}${premium}%`;
        worth.title = "What this room is worth against the rate you set";
        row.appendChild(worth);
      }

      const pill = document.createElement("em");
      pill.className = `pill ${stateKey}`;
      pill.textContent = room.outOfInventory ? "works"
        : stateKey === "occupied" ? "in"
          : stateKey === "dirty" ? "strip"
            : stateKey === "broken" ? "fault" : "ready";
      row.appendChild(pill);

      sheet.appendChild(row);
    }
  }

  const note = document.createElement("p");
  note.className = "roadmap";
  note.textContent = roomReveal("roomView")
    ? "Every room is priced against the rate you set, not instead of it - raise the rate and "
      + "the whole building moves. Which guest gets which room is the decision worth money: "
      + "give a better room away for the review, or sell the difference at the desk."
    : "More of this appears as you are promoted. A room is not just a room - who you put "
      + "where is the front desk's real job, and you will be doing it soon enough.";
  sheet.appendChild(note);
}

el("rooms").addEventListener("click", () => {
  renderRoomsSheet();
  openPanel("rooms-veil");
});

el("rooms-close").addEventListener("click", () => {
  closePanel("rooms-veil");
});

/* ---------------------------------------------------------------- book -- */
/**
 * THE BOOK - the forward reservation grid.
 *
 * The single largest piece of realism the game was missing, and the reason the
 * reservations department existed as a coin flip for so long. A room x day
 * matrix, rooms down the side and the next fortnight across, with a continuous
 * stay drawn as one bar rather than N blocks - which is how every property
 * management system in the world draws it and the only way it is readable.
 *
 * MOBILE: the room column is pinned and the days scroll horizontally inside
 * their own container, so the page body never scrolls sideways.
 *
 * It only appears at level 4. Below that the same screen shows TODAY'S ARRIVALS
 * as a list, because a beginner handed a spreadsheet learns nothing - and until
 * you have felt a house fill up, a fortnight of columns is not information.
 */
const BOOK_DAYS = 14;

function renderBookSheet() {
  const property = state.property;
  const calendar = bookOf(property);
  const today = clockOf(property).day;
  const rooms = sellableRoomList(property);
  const sheet = el("book-sheet");
  sheet.innerHTML = "";

  const arrivals = calendar.arrivalsOn(today);
  const staying = inHouseAtOpen(calendar, today);
  // "0 already in the house, 25% occupied" reads as a contradiction. It is not -
  // the two numbers count different things - so they are named for what they
  // actually are: who was here at breakfast, and how much of the house is sold
  // for tonight.
  el("book-sub").textContent = `Day ${today}: ${arrivals.length} arriving, `
    + `${staying.length} staying on from yesterday, `
    + `${Math.round(calendar.occupancyRate(rooms, today) * 100)}% of the house sold tonight.`;

  if (!reveals(state.level, "forwardGrid")) {
    // The beginner's view: just who is coming today, longest stays first.
    for (const booking of [...arrivals].sort((a, b) => b.nights - a.nights)) {
      const room = rooms.find((r) => r.id === booking.roomId);
      const row = document.createElement("div");
      row.className = "row";
      const who = document.createElement("div");
      who.className = "who";
      who.innerHTML = "<b></b><span></span>";
      who.querySelector("b").textContent = `${booking.guests} guest`
        + `${booking.guests === 1 ? "" : "s"}, ${booking.nights} night`
        + `${booking.nights === 1 ? "" : "s"}`;
      who.querySelector("span").textContent = room
        ? `room ${room.number}` : "no room allocated yet";
      row.appendChild(who);
      sheet.appendChild(row);
    }
    const note = document.createElement("p");
    note.className = "roadmap";
    note.textContent = "Today's arrivals. The full fortnight ahead - and the job of "
      + "deciding which booking to take and which to turn away - opens up as you are "
      + "promoted.";
    sheet.appendChild(note);
    return;
  }

  // THE GRID.
  const scroller = document.createElement("div");
  scroller.className = "gridscroll";
  const grid = document.createElement("div");
  grid.className = "bookgrid";
  grid.style.setProperty("--days", String(BOOK_DAYS));

  const corner = document.createElement("div");
  corner.className = "gcell ghead gcorner";
  corner.textContent = "Room";
  grid.appendChild(corner);
  for (let i = 0; i < BOOK_DAYS; i += 1) {
    const head = document.createElement("div");
    head.className = "gcell ghead" + (i === 0 ? " gtoday" : "");
    head.textContent = String(today + i);
    grid.appendChild(head);
  }

  for (const row of calendar.occupancyGrid(rooms, today, BOOK_DAYS)) {
    const label = document.createElement("div");
    label.className = "gcell glabel";
    label.textContent = String(row.room.number);
    grid.appendChild(label);
    for (const cell of row.cells) {
      const node = document.createElement("div");
      const held = Boolean(cell.bookingId);
      node.className = "gcell"
        + (held ? " gheld" : " gfree")
        + (cell.starts ? " gstart" : "")
        + (cell.outOfService ? " gshut" : "");
      if (held && cell.starts) node.textContent = String(cell.booking.guests);
      node.title = held
        ? `${cell.booking.guests} guests, ${cell.booking.nights} nights from day `
          + `${cell.booking.arrivalDay}`
        : `Room ${row.room.number} free on day ${cell.day}`;
      grid.appendChild(node);
    }
  }
  scroller.appendChild(grid);
  sheet.appendChild(scroller);

  const note = document.createElement("p");
  note.className = "roadmap";
  note.textContent = "Each bar is one stay. A room is only free if it is free for EVERY "
    + "night a booking needs - which is why taking a short booking can strand a longer one "
    + "you already hold. Your reservations desk sees as far ahead as its training allows.";
  sheet.appendChild(note);
}

el("book").addEventListener("click", () => {
  renderBookSheet();
  openPanel("book-veil");
});

el("book-close").addEventListener("click", () => {
  closePanel("book-veil");
});

/* -------------------------------------------------------------- reports -- */
/**
 * THE BOOKS, as a screen. Tap the bank figure.
 *
 * The ledger stores every line separately (domain/Ledger.js) so a question
 * nobody has asked yet is a query rather than a code change. This screen shows
 * the three cuts an owner actually asks for - the period, the day list, and
 * where the money went - and hands the whole thing over as JSON, which is the
 * shape it will keep when it becomes a real database.
 */
const REPORT_SPANS = [
  { label: "Last 7 days", days: 7 },
  { label: "Last 30", days: 30 },
  { label: "All time", days: Infinity },
];
let reportSpan = 7;
/** When set, the reports screen leads with TODAY rather than a settled span. */
let reportToday = null;

function money(n) { return `${n < 0 ? "-" : ""}$${Math.abs(Math.round(n))}`; }

function renderReports() {
  const property = state.property;
  const today = clockOf(property).day;
  const from = reportSpan === Infinity ? -Infinity : today - reportSpan + 1;
  const r = ledgerReport(property.ledger, { from, to: today });
  const sheet = el("report-sheet");
  sheet.innerHTML = "";

  // TODAY FIRST, when the player tapped the Today figure. A day in progress is
  // not in the ledger yet - it has not been settled - so it is read straight
  // off the running shift and shown above the settled history.
  if (reportToday) {
    const t = reportToday;
    const head = document.createElement("div");
    head.className = "sectionhead";
    head.textContent = `Today - day ${clockOf(property).day}, in progress`;
    sheet.appendChild(head);
    const row = (label, value, strong = false) => {
      const n = document.createElement("div");
      n.className = "awayrow" + (strong ? "" : " dark");
      n.innerHTML = "<span></span><b></b>";
      n.querySelector("span").textContent = label;
      n.querySelector("b").textContent = value;
      sheet.appendChild(n);
    };
    row("Rooms", money(t.takings - t.tips - t.upsellRevenue), true);
    if (t.tips) row("Tips", money(t.tips), true);
    if (t.upsellRevenue) row("Upgrades sold", money(t.upsellRevenue), true);
    if (t.facilityRevenue) row("Food & beverage", money(t.facilityRevenue), true);
    row("Paid in cash", money(t.cash), true);
    row("Paid by card", money(t.card), true);
    row("Wages", money(-t.wages));
    if (t.facilityLabour) row("F&B brigade", money(-t.facilityLabour));
    if (t.facilityCogs) row("F&B cost of goods", money(-t.facilityCogs));
    if (t.facilityUpkeep) row("Facility upkeep", money(-t.facilityUpkeep));
    for (const [kind, spent] of Object.entries(t.supplyByKind ?? {})) {
      if (spent > 0) row(`Stock: ${kind}`, money(-spent));
    }
    row("Profit so far", money(t.profit), true);
    for (const [outlet, line] of Object.entries(t.facilityBreakdown ?? {})) {
      row(`  ${outlet.replace(/_/g, " ")} - ${line.covers ?? 0} covers`, money(line.net ?? 0),
        (line.net ?? 0) >= 0);
    }
  }

  el("report-sub").textContent = r.days === 0
    ? "No trading days in the books yet. Finish a day and the numbers land here."
    : `Days ${r.from} to ${r.to}. ${r.days} trading day${r.days === 1 ? "" : "s"}.`;

  const modes = document.createElement("div");
  modes.className = "modes";
  for (const span of REPORT_SPANS) {
    const b = document.createElement("button");
    b.textContent = span.label;
    b.className = span.days === reportSpan ? "" : "off";
    b.dataset.span = String(span.days);
    modes.appendChild(b);
  }
  sheet.appendChild(modes);
  if (r.days === 0) return;

  const line = (label, value, strong = false) => {
    const row = document.createElement("div");
    row.className = "awayrow" + (strong ? "" : " dark");
    row.innerHTML = "<span></span><b></b>";
    row.querySelector("span").textContent = label;
    row.querySelector("b").textContent = value;
    sheet.appendChild(row);
  };
  const head = (text) => {
    const h = document.createElement("div");
    h.className = "sectionhead";
    h.textContent = text;
    sheet.appendChild(h);
  };

  head("Revenue");
  line("Rooms", money(r.roomsRevenue), true);
  line("Food & beverage", money(r.fnbRevenue), true);
  line("Upgrades sold at the desk", money(r.upsellRevenue), true);
  line("Tips", money(r.tips), true);
  line("Total revenue", money(r.revenue), true);

  head("Costs");
  line("Rooms-side wages", money(r.wages));
  line("F&B brigade", money(r.fnbBrigade));
  line("F&B cost of goods", money(r.fnbCogs));
  line("Facility upkeep", money(r.fnbUpkeep));
  for (const [kind, spent] of Object.entries(r.supplyByKind)) {
    if (spent > 0) line(`Stock: ${kind}`, money(spent));
  }
  line("Total costs", money(r.costs));

  head("Result");
  line("Profit", money(r.profit), true);
  if (r.margin !== null) line("Margin", `${r.margin}%`, true);
  if (r.adr !== null) line("Average daily rate", money(r.adr), true);
  line("Nights sold", String(r.nightsSold), true);
  if (r.averageRating !== null) line("Average rating", `${r.averageRating} / 5`, true);
  if (r.bestDay) line("Best day", `day ${r.bestDay.day}, ${money(r.bestDay.profit)}`, true);
  if (r.worstDay) line("Worst day", `day ${r.worstDay.day}, ${money(r.worstDay.profit)}`);

  if (r.walkedOut || r.relocated) {
    head("What it cost you");
    if (r.walkedOut) line("Guests who walked out", String(r.walkedOut));
    if (r.relocated) line("Guests relocated", String(r.relocated));
  }

  if (Object.keys(r.outlets).length) {
    head("Per outlet");
    for (const [outlet, o] of Object.entries(r.outlets)) {
      line(`${outlet.replace(/_/g, " ")} - ${o.covers} covers`, money(o.net), o.net >= 0);
    }
  }

  head("The register");
  const guests = (property.ledger.guests ?? []).slice(-8).reverse();
  if (guests.length === 0) {
    line("No departures recorded yet", "-");
  } else {
    for (const g of guests) {
      line(`${g.guests} in ${g.roomNumber ?? g.roomId}, days ${g.arrivalDay}-${g.departureDay - 1}`,
        money(g.revenue), true);
    }
  }

  const note = document.createElement("p");
  note.className = "roadmap";
  note.textContent = "Every line above is stored separately rather than as a total, so a "
    + "question nobody has asked yet is a query rather than a rewrite. Export hands over "
    + "the whole thing as JSON - the shape it keeps when this becomes a database.";
  sheet.appendChild(note);
}

el("report-sheet").addEventListener("click", (event) => {
  const node = event.target.closest("[data-span]");
  if (!node) return;
  reportSpan = Number(node.dataset.span);
  renderReports();
});

/** Today's own P&L, per department. Tapping the Today figure opens it. */
el("today").addEventListener("click", () => {
  if (!state.shift) { renderReports(); openPanel("report-veil"); return; }
  const r = score(state.shift);
  reportToday = r;
  renderReports();
  openPanel("report-veil");
});

el("bank").addEventListener("click", () => {
  reportToday = null;
  renderReports();
  openPanel("report-veil");
});
el("report-close").addEventListener("click", () => closePanel("report-veil"));

el("report-export").addEventListener("click", () => {
  const json = exportLedger(state.property.ledger, {
    at: Date.now(),
    property: {
      day: clockOf(state.property).day, rooms: state.property.rooms,
      site: state.property.site, bank: state.property.bank,
      rating: state.property.rating, rank: rankOf(state.property).level,
    },
  });
  const blob = new Blob([json], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `hotel-books-day${clockOf(state.property).day}.json`;
  a.click();
  toast("Books exported as JSON.");
});

el("fnbbtn").addEventListener("click", () => {
  renderFnbSheet();
  openPanel("fnb-veil");
});

el("fnb-close").addEventListener("click", () => {
  closePanel("fnb-veil");
});

el("fnb-sheet").addEventListener("input", (event) => {
  const node = event.target.closest("[data-menu]");
  if (!node) return;
  const outlet = node.dataset.menu;
  const stars = state.shift ? state.shift.stars : certification(state.property).stars;
  state.property = setMenuPrice(state.property, outlet, Number(node.value), stars);
  saveProperty();
  // The new price applies to the day already running, exactly as the room rate
  // does for later arrivals - a kitchen can reprice tonight's menu.
  if (state.shift) state.shift.menu = { ...state.property.menu };
  renderFnbSheet();
  render();
});

el("fnb-sheet").addEventListener("click", (event) => {
  const node = event.target.closest("[data-hire]");
  if (!node) return;
  const role = node.dataset.hire;
  const blocker = hireBlocker(state.property, role);
  if (blocker) { sound.nope(); toast(blocker); return; }
  state.property = hire(state.property, role);
  // Brigade roles work the outlets rather than the board, but they are still
  // counted from the shift's staff list, so the same rule applies.
  if (state.shift && !state.shift.over) state.shift = addStaffToShift(state.shift, { role });
  saveProperty();
  sound.done();
  toast(`${role} hired at $${roleWage(role, 1)} a day.`);
  analytics.track("hire", { role, fee: recruitmentFee(role) });
  renderFnbSheet();
  render();
});

el("build-sheet").addEventListener("click", (event) => {
  const speedNode = event.target.closest("[data-speed]");
  if (speedNode) {
    const id = Number(speedNode.dataset.speed);
    const seconds = maintenanceSpeedUpSeconds(state.property);
    state.property = speedUpBuild(state.property, id, seconds, Date.now(), "maintenance");
    saveProperty();
    collectFinishedWork();
    sound.start();
    toast(`Maintenance took ${shortWait(seconds)} off it.`);
    analytics.track("speed_up", { source: "maintenance", seconds });
    renderBuildSheet();
    return;
  }

  const node = event.target.closest("[data-build]");
  if (!node) return;
  const key = node.dataset.build;
  const options = buildOptionsFor(key);
  const blocker = buildBlocker(state.property, key, options);
  if (blocker) { sound.nope(); toast(blocker); return; }

  const cost = buildCost(state.property, key);
  state.property = startBuild(state.property, key, Date.now(), options);
  saveProperty();
  sound.bell();
  toast(`Booked. ${shortWait(realBuildSeconds(key))} of work, $${cost} paid.`);
  analytics.track("build_start", { key, cost, seconds: BUILD_CATALOG[key].seconds });
  renderBuildSheet();
  render();
});

/* ------------------------------------------------------- while you were out */
/**
 * The hotel does not stop because the owner went home - but it does not run as
 * well without them, and it only runs at all if somebody is on the payroll.
 *
 * This card exists to make that honest rather than magical. It states the hours
 * that were paid, the hours lost past the cap, which departments were dark, and
 * how much supervision would have been worth. A player who is being asked to
 * come back more often, hire a manager, or eventually pay for an offline pack
 * deserves to see the actual arithmetic behind the offer.
 */
function showAwayCard(report, completed) {
  const sheet = el("away-sheet");
  sheet.innerHTML = "";

  const hours = report.paidSeconds / 3600;
  el("away-earned").textContent = `$${report.earned}`;
  el("away-paid").textContent = report.daysRolled
    ? `${report.daysRolled} day${report.daysRolled === 1 ? "" : "s"}`
    : shortWait(report.paidSeconds);
  el("away-factor").textContent = report.factor
    ? `${Math.round(report.factor * 100)}%` : "--";

  const summary = describeAbsence(report);
  if (report.daysRolled > 0 && summary) {
    el("away-title").textContent = report.daysRolled === 1
      ? "Yesterday" : `${report.daysRolled} days passed`;
    el("away-sub").textContent = `${summary}. Your hotel is on day `
      + `${clockOf(state.property).day}.`;
  } else if (report.closed) {
    el("away-title").textContent = "The hotel was shut";
    el("away-sub").textContent = "Nobody is on the payroll, so there was no one to open the "
      + "doors. Hire a receptionist and the place keeps trading while you are away.";
  } else if (report.reason === "no_measured_day") {
    el("away-title").textContent = "Nothing to go on yet";
    el("away-sub").textContent = "The hotel has not yet finished a day that covered its own "
      + "wages, so there is no honest rate to pay you at. Work a profitable day first.";
  } else {
    el("away-title").textContent = "While you were away";
    el("away-sub").textContent = `${shortWait(report.elapsedSeconds)} away. `
      + `Your staff ran the place at ${Math.round(report.factor * 100)}% of what it makes `
      + "with you on the floor.";
  }

  const line = (label, value, dark = false) => {
    const row = document.createElement("div");
    row.className = "awayrow" + (dark ? " dark" : "");
    row.innerHTML = `<span></span><b></b>`;
    row.querySelector("span").textContent = label;
    row.querySelector("b").textContent = value;
    sheet.appendChild(row);
  };

  if (report.earned > 0) {
    line(`${report.settled.filter((d) => d.net > 0).length} days at `
      + `$${Math.round(report.netPerDay)} a day, run at ${Math.round(report.factor * 100)}%`,
      `$${report.earned}`);
    // What supervision was worth, as the honest counterfactual: these days were
    // run at a discount, and being here closes that gap. Derived from the days
    // actually settled rather than from a lump sum, so it can never exceed what
    // the player could really have earned.
    const supervised = Math.round(report.earned / Math.max(0.01, report.factor));
    if (supervised > report.earned) {
      line("Left on the desk, unsupervised", `-$${supervised - report.earned}`, true);
    }
    if (report.hoursPastCap > 0) {
      // Stated in HOURS, never in money. Pricing them told a player who had
      // skipped two days that it had "cost" them fifteen thousand dollars - a
      // sum the hotel was never going to make, invented purely to make an
      // upgrade look necessary. The cap is a rule of the game, not a loss.
      line(`Beyond the ${OFFLINE_CAP_SECONDS / 3600}h cap`,
        `${report.hoursPastCap}h unpaid`, true);
    }
  }
  for (const gap of report.gaps ?? []) line(`No ${gap} on duty`, "unstaffed", true);
  for (const work of completed) line(work.label, "finished");

  el("away-note").textContent = (report.gaps ?? []).length
    ? "Every department you staff raises what the hotel earns without you. Reaching what it "
      + "makes with you on the floor is not something management alone can do."
    : report.hoursPastCap > 0
      ? "Your base is fully staffed - this is as much as the hotel earns unsupervised. The "
        + "cap is deliberate: the hotel banks eight hours and no more, however long you are "
        + "gone, so a week away is worth the same as a night."
      : "Your base is fully staffed - this is as much as the hotel earns unsupervised.";

  el("away-veil").classList.add("show");
}

el("away-ok").addEventListener("click", () => {
  el("away-veil").classList.remove("show");
  setPaused(false);
  state.lastFrame = performance.now();
  render();
});

/**
 * Come back to the property: run the builders forward, settle the hours it
 * traded without us, and say so if there is anything worth saying. Called on
 * boot AND whenever the tab becomes visible again, because on the web that is
 * what "the player came back" actually looks like.
 */
/**
 * SAVE MIGRATION FOR RANK.
 *
 * Every save written before rank existed has a career level in localStorage and
 * a progression that defaults to 1. Left alone, a player who had reached shift 4
 * would open the game as a receptionist with five people on the payroll, all of
 * them over their rank's headcount. Nothing would be deleted - the cap only
 * gates HIRING - but it would read as a demotion, which is worse than a bug.
 *
 * So the rank inherits the career level the player had actually reached.
 */
function reconcileRank() {
  const rank = rankOf(state.property);
  const reached = Math.max(state.level, state.unlocked, 1);
  if (rank.level >= reached) return;
  rank.level = Math.min(reached, MAX_LEVEL);
  // Credit the experience that rank implies, so the progress screen does not
  // show a general manager with nothing to their name.
  rank.experience = Math.max(rank.experience, LEVELS[rank.level].xp);
  rank.lifetime = Math.max(rank.lifetime, rank.experience);
  state.property = { ...state.property, progression: rank.toJSON() };
  saveProperty();
}

function returnToProperty() {
  reconcileRank();
  const dayBefore = clockOf(state.property).day;
  // ORDER MATTERS AND IT IS THIS WAY ROUND. The days are priced against the
  // property AS IT STOOD WHILE THEY PASSED, before any build or course
  // completes. Advancing first was a real bug once: a receptionist away on a
  // course came back, the course completed, and the absence was then priced as
  // though the desk had been staffed throughout.
  const timeline = advanceTimeline(state.property, Date.now(), { level: state.level });
  const built = advanceBuilds(timeline.property, Date.now());
  // Depart finished stays, forget the deep past, and top the forward horizon
  // back up - a player away for a week must not return to an empty fortnight.
  state.property = maintainBook(built.property, { rate: state.price ?? 0 }).property;
  const back = {
    property: built.property,
    completed: built.completed,
    offline: timeline,
  };
  saveProperty();

  const worthShowing = state.property.openedAt !== null
    && (timeline.earned > 0 || built.completed.length > 0 || timeline.daysRolled > 0);
  if (worthShowing) {
    analytics.track("offline_return", {
      away_seconds: Math.round(timeline.elapsedReal),
      earned: timeline.earned,
      factor: timeline.factor,
      days_rolled: timeline.daysRolled,
      builds_finished: built.completed.length,
    });
    setPaused(true);
    showAwayCard(back.offline, back.completed);
  }
  // A new day while we were away means a new day to work. Open the floor for
  // it; if it is already settled, beginDay leaves the player on the rest view.
  if (clockOf(state.property).day !== dayBefore || !state.shift) beginDay();
  return back;
}

/**
 * Stamp the property as watched while the game is open, so a long session is
 * not later billed back as offline time. Thirty seconds is fine granularity for
 * an economy priced in hours.
 */
/**
 * THE HEARTBEAT, which is now the same code path as coming back from an absence.
 *
 * It used to be `touch()` - stamp the property as seen so a long session was not
 * later billed back as offline time. That was right when a day was a session.
 * Now that the clock is continuous, days have to roll over while the tab is OPEN
 * too, and they have to settle the same way they would have if it had been shut.
 * One path, so live time and idle time can never disagree.
 *
 * Safe to run every ten seconds because settlement is idempotent against
 * `lastSettledDay`: between rollovers it does nothing but move the clock.
 */
const heartbeat = setInterval(() => {
  if (document.hidden) return;
  // PAUSED MEANS PAUSED. `frame` hands the paused interval back to `lastSeenAt`
  // on resume, so nothing is lost by simply not advancing here.
  if (state.paused) return;
  const before = clockOf(state.property).day;

  /**
   * CLOSE THE WORKED DAY BEFORE THE TIMELINE PRICES IT AS AN ABSENCE.
   *
   * ORDER IS THE WHOLE BUG, and it caused two symptoms that looked unrelated.
   * `advanceTimeline` settles any day that rolled - as UNSUPERVISED, flagged
   * `unmeasured: true`, at the offline rate. It used to run FIRST, so a day the
   * player had actually worked went into the ledger as an absence:
   *
   *   - The player earned no experience for it (fixed separately, but this is
   *     the reason it kept happening).
   *   - `measuredNetPerDay` ignores unmeasured days, so with every worked day
   *     recorded as an absence the hotel had NO measured earnings - and the
   *     offline economy pays `netPerDay x factor`, which is zero times anything.
   *     The operator: "this gives me 0$".
   *
   * So the shift is closed FIRST, banking the real day at its real profit and
   * stamping `lastSettledDay`. `advanceTimeline` then skips it, because
   * settlement is idempotent against exactly that mark.
   */
  const seen = state.property.lastSeenAt ?? Date.now();
  const willRoll = (Date.now() - seen) / 1000 >= clockOf(state.property).secondsToDayEnd;
  if (willRoll && state.shift && !state.shift.over) {
    state.shift = { ...state.shift, over: true };
    endShift(before);
  }

  const timeline = advanceTimeline(state.property, Date.now(), { level: state.level });
  state.property = timeline.property;
  saveProperty();
  if (clockOf(state.property).day !== before) {
    // Anything still open here worked a day the clock had already passed.
    if (state.shift && !state.shift.over) {
      state.shift = { ...state.shift, over: true };
      endShift(before);
    }
    // A new trading day: roll the book with it, then say so - the rollover is
    // the rhythm the whole game runs on.
    state.property = maintainBook(state.property, { rate: state.price ?? 0 }).property;
    saveProperty();
    const today = clockOf(state.property).day;
    const due = bookOf(state.property).arrivalsOn(today).length;
    toast(`Day ${today}. ${due} arrival${due === 1 ? "" : "s"} expected.`);
    beginDay();
    render();
  }
}, 10000);

/* -------------------------------------------------- the allocation policy -- */
/**
 * WHAT THE DESK DOES WITH A BETTER ROOM THAN THE GUEST BOOKED.
 *
 * It lives on the rate screen because it is the same kind of decision as the
 * rate: both are about what you will trade for occupancy and reputation. And it
 * is only offered once the player can SEE room views, because before that two
 * rooms look identical and this would be three buttons with no visible effect.
 *
 * A standing policy, not a prompt on every arrival. Per-guest would be more
 * faithful and completely unplayable on a phone - and a real front office is
 * briefed once rather than supervised guest by guest, so this is also how it
 * actually works.
 */
const POLICY_COPY = {
  [UPSELL_POLICY.PROTECT]: {
    label: "Protect",
    note: "Honour the booking and keep the good rooms for guests who will pay for them. "
      + "What a competent front office does by default.",
  },
  [UPSELL_POLICY.SELL]: {
    label: "Sell up",
    note: "Offer the better room at the desk. Most guests say no; the ones who say yes are "
      + "margin on a room that was going to sit empty anyway.",
  },
  [UPSELL_POLICY.DELIGHT]: {
    label: "Give it",
    note: "Hand the better room over without being asked. Costs you the premium and buys "
      + "the reviews that let you charge more for everything.",
  },
};

function renderPolicyControl() {
  const box = el("policy-box");
  if (!reveals(state.level, "upsell")) { box.style.display = "none"; return; }
  box.style.display = "";

  const modes = el("policy-modes");
  modes.innerHTML = "";
  for (const key of Object.values(UPSELL_POLICY)) {
    const button = document.createElement("button");
    button.textContent = POLICY_COPY[key].label;
    button.className = key === state.property.upsellPolicy ? "" : "off";
    button.dataset.policy = key;
    modes.appendChild(button);
  }
  el("policy-note").textContent = POLICY_COPY[state.property.upsellPolicy].note;
}

el("policy-modes").addEventListener("click", (event) => {
  const node = event.target.closest("[data-policy]");
  if (!node) return;
  state.property = { ...state.property, upsellPolicy: node.dataset.policy };
  saveProperty();
  // Applies to the day already running - a desk can be re-briefed mid-shift.
  if (state.shift) state.shift.upsellPolicy = node.dataset.policy;
  sound.start();
  renderPolicyControl();
});

/* --------------------------------------------------------------- rate -- */
function priceBand() {
  const fair = state.shift ? state.shift.fairRate : 40;
  return { fair, min: Math.round(fair * 0.55), max: Math.round(fair * 1.7) };
}

function renderPricePanel() {
  const { fair, min, max } = priceBand();
  const price = state.price ?? fair;
  const range = el("price-range");
  range.min = String(min);
  range.max = String(max);
  range.value = String(price);
  el("price-val").textContent = String(price);
  el("price-sub").textContent =
    `A ${state.shift.stars}-star at ${rating().toFixed(1)} can fairly ask about $${fair}.`;

  const demand = demandFactor(price, fair);
  const ratio = price / fair;
  el("price-demand").textContent =
    demand > 1.2 ? "Full" : demand > 0.9 ? "Steady" : demand > 0.6 ? "Thin" : "Quiet";
  el("price-expect").textContent =
    ratio > 1.25 ? "Demanding" : ratio > 0.95 ? "Normal" : "Forgiving";
  el("price-tips").textContent = ratio > 1.2 ? "Generous" : ratio > 0.85 ? "Occasional" : "Rare";
  el("price-note").textContent = ratio > 1.2
    ? "Charge above your standing and the phone goes quiet - and the guests who do come will not forgive a wait."
    : ratio < 0.85
      ? "Cheap fills the house and buys forgiving guests, but you will work hard for little, and you can sell rooms you do not have."
      : "About right for your class and rating.";
}

el("price-range").addEventListener("input", (event) => {
  state.price = Number(event.target.value);
  renderPricePanel();
});
el("pricebtn").addEventListener("click", () => {
  if (!state.shift.config.pricingEnabled) {
    toast("The rate is fixed until you run your own reservations.");
    return;
  }
  renderPricePanel();
  renderPolicyControl();
  openPanel("price-veil");
});
el("price-ok").addEventListener("click", () => {
  closePanel("price-veil");
  localStorage.setItem(KEY_PRICE, String(state.price));
  analytics.track("price_set", { level: state.level, price: state.price });
  // Applies to the day already running rather than restarting it. Restarting
  // was how a day could be worked - and banked - twice, and a hotel can reprice
  // mid-afternoon anyway: it moves what later arrivals pay, not what the guests
  // already upstairs were charged.
  if (state.shift) state.shift.roomRate = state.price;
  render();
});

/* -------------------------------------------------------------- speed -- */
el("speed").addEventListener("click", () => {
  state.speed = state.speed === 1 ? 2 : state.speed === 2 ? 4 : 1;
  el("speed").textContent = `${state.speed}x`;
  analytics.track("speed_set", { speed: state.speed });
});

/* --------------------------------------------------------- level picker -- */
function renderLevelPicker() {
  const grid = el("lvl-grid");
  grid.innerHTML = "";
  el("lvl-sub").textContent =
    `Shift ${state.unlocked} is as far as you have got. Replay any of them.`;

  for (let level = 1; level <= MAX_LEVEL; level += 1) {
    const config = levelConfig(level);
    const locked = level > state.unlocked;
    const row = document.createElement("div");
    row.className = "lvlrow" + (locked ? " locked" : "")
      + (level === state.level ? " current" : "");
    if (!locked) row.dataset.level = String(level);

    const num = document.createElement("i");
    num.textContent = String(level);
    row.appendChild(num);

    const what = document.createElement("div");
    what.className = "what";
    what.innerHTML = `<b>${config.title}</b><span>shift ${level} `
      + `- target $${config.targetProfit}</span>`;
    row.appendChild(what);

    const state_ = document.createElement("span");
    state_.style.cssText = "font-size:10.5px;color:var(--muted)";
    state_.textContent = locked ? "locked" : level === state.level ? "playing" : "play";
    row.appendChild(state_);

    grid.appendChild(row);
  }
}

el("lvlbtn").addEventListener("click", () => {
  renderProgressSheet();
  openPanel("lvl-veil");
});
el("lvl-close").addEventListener("click", () => closePanel("lvl-veil"));
el("lvl-grid").addEventListener("click", (event) => {
  const row = event.target.closest("[data-level]");
  if (!row) return;
  closePanel("lvl-veil");
  startShift(Number(row.dataset.level));
});

el("staffbtn").addEventListener("click", () => {
  collectFinishedWork();
  renderStaffSheet();
  openPanel("staff-veil");
  clearInterval(staffTimer);
  staffTimer = setInterval(() => {
    collectFinishedWork();
    renderStaffSheet();
  }, 1000);
});
el("staff-close").addEventListener("click", () => {
  closePanel("staff-veil");
  clearInterval(staffTimer);
  staffTimer = null;
});

/* ------------------------------------------------------------- controls -- */
el("hint").addEventListener("click", () => {
  const suggestion = suggestTask(state.shift);
  if (!suggestion) { toast("Nothing you can take right now."); return; }
  const node = jobNodes.get(suggestion.id);
  if (node) {
    node.classList.add("flash");
    node.scrollIntoView({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
    setTimeout(() => node.classList.remove("flash"), 1300);
  }
  analytics.track("hint_used", { level: state.level, type: suggestion.type });
});

el("pause").addEventListener("click", () => setPaused(!state.paused));

/**
 * There is no "next shift" any more, because there is no next shift to pick -
 * there is tomorrow, and it arrives on the clock. The button closes the card
 * and puts the player back on the floor of a day that is now settled.
 */
el("end-next").addEventListener("click", () => {
  el("end-veil").classList.remove("show");
  state.shift = null;
  setPaused(false);
  render();
});
el("end-retry").addEventListener("click", () => {
  el("end-veil").classList.remove("show");
  state.shift = null;
  render();
});

el("export").addEventListener("click", (event) => {
  event.preventDefault();
  const blob = new Blob([analytics.export()], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "hotel-career-playtest.json";
  link.click();
});

/**
 * THE OPENING, IN FOUR BEATS.
 *
 * What this replaces: one paragraph of instructions behind a button labelled
 * "Open up". It explained escorting - a task that moved to day 2 with the
 * bellboy and does not exist on day 1 - and it explained the controls before the
 * player had touched anything. Every piece of onboarding research says the same
 * thing about that: let them act first. "Every video watched is a user lost."
 *
 * THE RULES THESE BEATS FOLLOW, and they are the genre's rather than ours:
 *   - state the fantasy, not the controls;
 *   - show the balance sheet, because $50 IS the hook - it says the hotel cannot
 *     pay a wage until it takes some money;
 *   - put the first guest on the step before the last beat, so the thing waiting
 *     behind the card is a person and not a menu;
 *   - close on the next goal, which the game already tracks (domain/Unlocks.js).
 *
 * Data, not markup, so the Godot port takes the copy and leaves index.html.
 */
const INTRO_BEATS = [
  {
    step: "08:00", title: "The keys are yours.",
    body: "Eight rooms. Nobody upstairs, nobody on the payroll, and the hotel "
      + "opens today.",
    note: "You are the front desk.",
  },
  {
    step: "The till", title: "$50.",
    body: "That is about one day's wage for one person - and you have not hired "
      + "anyone. The hotel pays for itself out of tonight's rooms or it does not "
      + "pay at all.",
    note: "Nothing here is bought with money you do not have.",
  },
  {
    step: "The morning", title: "Get the desk ready.",
    body: "Cut a key and make out a card for every room before the doors open. "
      + "Every one you do makes a check-in faster this afternoon.",
    note: "Tap a job to do it yourself - one at a time.",
  },
  {
    step: "08:20", title: "Your first guest is at the door.",
    body: "They booked the week you announced you were opening. Check them in "
      + "and the room is paid for.",
    note: "Then: 10 check-ins and $300 profit hires your first receptionist.",
  },
];

let introBeat = 0;

function paintIntro() {
  const beat = INTRO_BEATS[introBeat];
  el("tut-step").textContent = beat.step;
  el("tut-title").textContent = beat.title;
  el("tut-body").textContent = beat.body;
  el("tut-note").textContent = beat.note;
  el("tut-go").textContent = introBeat === INTRO_BEATS.length - 1 ? "Open up" : "Next";
}

el("tut-go").addEventListener("click", () => {
  sound.ensure();
  if (introBeat < INTRO_BEATS.length - 1) {
    introBeat += 1;
    paintIntro();
    sound.start();
    analytics.track("tutorial_beat", { beat: introBeat });
    return;
  }
  el("tut-veil").classList.remove("show");
  localStorage.setItem(KEY_TUT, "1");
  analytics.track("tutorial_complete");
  // NOW the hotel opens - see the boot block. `returnToProperty` ends in
  // `beginDay`, so the day is built against a clock that has not been running
  // behind the cards.
  setPaused(false);
  returnToProperty();
  render();
});

window.addEventListener("pagehide", () => {
  state.property = touchProperty(state.property, Date.now());
  saveProperty();
  analytics.sessionEnd();
});

/**
 * On the web, leaving is a hidden tab and coming back is a visible one. Going
 * away stamps the clock so the hotel starts trading unsupervised from that
 * moment; coming back settles what it made.
 */
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (state.shift && !state.shift.over) setPaused(true);
    state.property = touchProperty(state.property, Date.now());
    saveProperty();
    return;
  }
  collectFinishedWork(false);
  returnToProperty();
  render();
});

/* ------------------------------------------------------------ dev panel -- */
/**
 * A test harness for the operator, wired ONLY when the page is opened with
 * `#dev`. A player who never types that never has these buttons, and nothing
 * below is reachable from the shipped UI.
 *
 * The important design rule here: every button drives the REAL code path.
 * "Skip 8h" winds the property's clocks back and then runs the ordinary resume -
 * so the builders complete through `advanceBuilds`, the offline hours are priced
 * through `offlineReport`, and the eight-hour cap and the supervision discount
 * both still apply. A button that set the finished state directly would let a
 * broken economy sail through a playtest, which is the opposite of the point.
 */
const DEV = window.location.hash.toLowerCase().includes("dev");

function devApply(label, mutate) {
  state.property = mutate(state.property);
  saveProperty();
  collectFinishedWork(false);
  render();
  if (el("build-veil").classList.contains("show")) renderBuildSheet();
  if (el("staff-veil").classList.contains("show")) renderStaffSheet();
  if (el("fnb-veil").classList.contains("show")) renderFnbSheet();
  if (el("rooms-veil").classList.contains("show")) renderRoomsSheet();
  if (el("book-veil").classList.contains("show")) renderBookSheet();
  if (el("report-veil").classList.contains("show")) renderReports();
  toast(`[dev] ${label}`);
  analytics.track("dev_tool", { action: label });
}

/** Skip time the honest way: rewind the clocks, then resume as normal. */
function devSkip(hours) {
  state.property = devRewind(state.property, hours * 3600);
  saveProperty();
  const back = returnToProperty();
  render();
  if (el("build-veil").classList.contains("show")) renderBuildSheet();
  if (el("staff-veil").classList.contains("show")) renderStaffSheet();
  if (el("fnb-veil").classList.contains("show")) renderFnbSheet();
  if (el("rooms-veil").classList.contains("show")) renderRoomsSheet();
  if (el("book-veil").classList.contains("show")) renderBookSheet();
  if (el("report-veil").classList.contains("show")) renderReports();
  analytics.track("dev_tool", { action: `skip_${hours}h`, earned: back.offline.earned });
}

if (DEV) {
  document.body.classList.add("devon");
  el("devbar").classList.add("on");

  el("dev-finish").addEventListener("click", () => devApply("all work finished",
    (p) => devFinishAll(p, Date.now())));

  el("dev-skip1").addEventListener("click", () => devSkip(1));
  el("dev-skip8").addEventListener("click", () => devSkip(8));
  el("dev-skip48").addEventListener("click", () => devSkip(48));

  el("dev-cash").addEventListener("click", () => devApply("+$10,000", (p) => devGrant(p, 10000)));

  el("dev-days").addEventListener("click", () => devApply("5 trading days seeded",
    (p) => devSeedDays(p, 400, 5, Date.now())));

  // Ends the CURRENT day immediately, through the normal end-of-day path.
  el("dev-endday").addEventListener("click", () => {
    if (!state.shift || state.shift.over) { toast("[dev] no day running"); return; }
    state.shift = { ...state.shift, time: state.shift.config.durationSec, over: true };
    endShift();
    render();
    analytics.track("dev_tool", { action: "end_day" });
  });

  /**
   * PROMOTE. "Unlock all shifts" meant something when there was a shift select;
   * now the useful tool is a rank, because rank is what gates headcount and
   * what the screens reveal. One step at a time so a tester can watch each
   * reveal land rather than jumping straight to the end.
   */
  el("dev-unlock").addEventListener("click", () => {
    const rank = rankOf(state.property);
    if (!rank.next) { toast("[dev] already general manager"); return; }
    rank.level += 1;
    rank.experience = Math.max(rank.experience, LEVELS[rank.level].xp);
    state.property = { ...state.property, progression: rank.toJSON() };
    state.level = rank.level;
    state.unlocked = Math.max(state.unlocked, rank.level);
    localStorage.setItem(KEY_LEVEL, String(rank.level));
    localStorage.setItem(KEY_UNLOCKED, String(state.unlocked));
    saveProperty();
    toast(`[dev] promoted to ${LEVELS[rank.level].title}`);
    render();
    analytics.track("dev_tool", { action: "promote", to: rank.level });
  });

  el("dev-wipe").addEventListener("click", () => {
    /**
     * WIPE MEANS WIPE, INCLUDING THE CLOCK.
     *
     * This cleared localStorage and printed "reload the page" - and then did
     * not reload. The in-memory property, clock and all, survived, and the very
     * next heartbeat wrote it straight back. The operator hit exactly that:
     * "even wiping out save from the #dev doesnt resets the time".
     *
     * So it stops the heartbeat, blocks any further write, and reloads.
     */
    for (const key of [KEY_PROPERTY, KEY_LEVEL, KEY_UNLOCKED, KEY_BANK, KEY_RATING,
      KEY_PRICE, KEY_TUT, KEY_DESIGN]) localStorage.removeItem(key);
    clearInterval(heartbeat);
    saveProperty = () => {};
    toast("[dev] save wiped - reloading");
    setTimeout(() => window.location.reload(), 250);
  });
}

/* ------------------------------------------------------------------ boot -- */
// Bring the property up to date BEFORE the first shift is built, so the day is
// played in the hotel as it stands now - including anything that finished while
// the game was shut.
const bootConfig = levelConfig(state.level);
state.property = applyCareerBaseline(
  state.property, bootConfig.rooms, bootConfig.hired.map((h) => h.role), bootConfig.role,
);

/**
 * THE FIRST DAY DOES NOT START UNTIL THE PLAYER CLOSES THE LAST CARD.
 *
 * Operator: "when i start when wiped save, the game starts while i still read
 * the intro text, it must start when i close the last dialog box."
 *
 * It was true and the cause was the ORDER here. `returnToProperty` opens the
 * floor - it ends in `beginDay`, which is right for every other entry into the
 * game - and boot called it BEFORE putting the intro up. So the day was already
 * running, and its clock already moving, behind four cards of reading. On a
 * 150-second day, a minute of reading is a third of it gone.
 *
 * So a first run is paused first, shown the cards, and only opens the floor when
 * the last one is dismissed. `setPaused(true)` before anything else means even
 * the heartbeat is held - it returns early while paused, and `frame` hands the
 * whole paused interval back to `lastSeenAt`, so the hotel is not billed for
 * the time the player spent reading.
 */
const firstRun = !localStorage.getItem(KEY_TUT);
if (firstRun) {
  setPaused(true);
  introBeat = 0;
  paintIntro();
  el("tut-veil").classList.add("show");
  analytics.track("tutorial_start");
  render();
  requestAnimationFrame(frame);
} else {
  returnToProperty();
  render();
  requestAnimationFrame(frame);
  beginDay();
  // startShift unpauses; if the return card is up, the floor waits behind it.
  if (el("away-veil").classList.contains("show")) setPaused(true);
}
