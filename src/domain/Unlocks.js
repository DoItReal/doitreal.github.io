/**
 * Hotel Career - WHAT YOU HAVE TO DO TO OPEN A DEPARTMENT.
 *
 * Operator, after playtest:
 *
 *   "i cant progress to the next staff goals normally i have to use dev tools to
 *    skip 1h ... There must be some goals like 10 check-ins and 300$ profit to
 *    unlock receptionist, and is up to the player what he wants to do. With the
 *    other roles too."
 *
 * WHAT THIS REPLACES. A department used to open on two invisible conditions: a
 * rank whose experience bar moved only at midnight, and a `learnedRoles` list
 * the player never saw. Neither was a goal - they were states the game arrived
 * at on its own, which is why the only way to make progress happen was the dev
 * panel. There was nothing to aim at.
 *
 * THE RULE NOW: every department is opened by work the player can see themselves
 * doing, counted as they do it. Ten check-ins is a thing you can decide to go
 * and do. "260 experience" is not.
 *
 * TWO CONDITIONS EACH, DELIBERATELY. A count of the JOB, so the department is
 * earned by doing the work it exists to replace - and a MONEY bar, so a hotel
 * that cannot pay wages cannot hire. Either alone is gameable: work without
 * money hires staff you cannot afford, money without work lets a lucky rate
 * buy a department the player has never seen.
 *
 * UNVERIFIED - all of them except reception. Method: reception's 10 check-ins
 * and $300 are the operator's own numbers. The rest step up from there in
 * proportion to how much later in the arc the department arrives, and are set so
 * each is reachable in roughly one to two days of working that department.
 * These are exactly the sort of figure a playtest corrects, and they are all in
 * this one table so correcting them is a one-file job.
 */

/**
 * @typedef {object} DepartmentGoal
 * @property {string} counter The career counter this department is earned by.
 * @property {number} need    How many.
 * @property {number} profit  Lifetime profit required alongside it.
 * @property {string} doing   What the player is actually doing, in their words.
 */

/** @type {Record<string, DepartmentGoal>} */
export const DEPARTMENT_GOALS = {
  // The operator's own figures.
  reception: { counter: "checkIns", need: 10, profit: 300, doing: "check guests in" },
  bellboy: { counter: "escorts", need: 12, profit: 900, doing: "walk guests to their room" },
  housekeeping: { counter: "cleans", need: 15, profit: 2000, doing: "turn rooms" },
  maintenance: { counter: "repairs", need: 8, profit: 3500, doing: "fix what breaks" },
  reservations: { counter: "calls", need: 12, profit: 5000, doing: "take bookings on the phone" },
};

/* --------------------------------------------------- what OPENS the work -- */

/**
 * WHAT YOU HAVE TO HAVE DONE FOR THE NEXT JOB TO APPEAR AT ALL.
 *
 * Operator, through day 9 of the deployed build: "the game doesnt care much
 * about the goals to unlock more content. The content unlocks with the days
 * passed somehow... this is real bug the content must be unlocked immidiately
 * after completing the goal not after the time passed. And the goal must be
 * completed without hiring the staff, hiring the staff is optional."
 *
 * He was describing `engine.ONBOARDING_DAYS`, keyed by DAY NUMBER 1..5, which
 * overrode the day's task list on a calendar rather than on anything he did.
 * Hence bellboy work appearing on day 3 and maintenance on day 8-9 however much
 * of the job he had actually finished.
 *
 * TWO RUNGS PER DEPARTMENT, WHICH IS THE WHOLE DESIGN. `game-designer` measured
 * the obvious version - wiring DEPARTMENT_GOALS straight into the task list -
 * and it stretches the eleven-minute teaching arc to about day 17: at the
 * measured supply, twelve escorts lands ~day 6, fifteen cleans ~day 10, eight
 * repairs ~day 14. So the goal is doing two jobs and they are split here:
 *
 *   LEARN - this table. Small, WORK ONLY, no money. It opens the CONTENT.
 *   HIRE  - DEPARTMENT_GOALS above, unchanged, work + profit. It opens the HIRE.
 *
 * Content on work alone is the operator's own framing: the goals teach the
 * mechanics and hiring is the optional automation. The money half asks "can the
 * payroll carry a wage", which has nothing to do with whether the player is
 * ready to be shown a mop - and gating on it would withhold teaching from
 * exactly the player doing worst.
 *
 * HIRING CANNOT ADVANCE A GATE, and that is load-bearing rather than incidental:
 * these read `career`, which only the PLAYER's own hands write. Staff finishing
 * a job does not move it. See the test.
 *
 * UNVERIFIED - 4 / 4 / 4 / 3. Method: the smallest count that reads as "you have
 * done this job a few times", backsolved against the measured arrival and
 * departure supply so each gate lands on or before the day the current arc
 * teaches that department - 4 check-ins by mid day 1 (6 arrivals), 4 escorts by
 * mid day 3, 4 cleans by day 4 (5 departures), 3 repairs by day 5. That
 * reproduces the measured 1-2-3-4-5 shape from what the player did rather than
 * from the calendar, which is the entire point. Plausible range 3-6.
 */
export const CONTENT_GATES = [
  { stage: 1, counter: "checkIns", need: 4, opens: "the bellboy's work" },
  { stage: 2, counter: "escorts", need: 4, opens: "housekeeping's work" },
  { stage: 3, counter: "cleans", need: 4, opens: "maintenance's work" },
  { stage: 4, counter: "repairs", need: 3, opens: "the reservations desk" },
  { stage: 5, counter: "calls", need: 12, opens: "the whole floor" },
];

/**
 * How far along the teaching arc this career has actually got, 0 to 5.
 *
 * DERIVED, NEVER STORED. A stored stage can drift from the career it was
 * computed from, which is the class of bug that produced "full bar, $16 more
 * profit, nothing moving" - two numbers for one truth. It also means no save
 * migration: an existing player's stage falls out of counters they already have.
 *
 * SEQUENTIAL AND MONOTONE. Stage 3 requires 1 and 2 behind it, so a player who
 * somehow banks cleans before escorts does not skip the escort lesson.
 */
export function contentStage(career = {}) {
  let stage = 0;
  for (const gate of CONTENT_GATES) {
    if ((career[gate.counter] ?? 0) < gate.need) break;
    stage = gate.stage;
  }
  return stage;
}

/**
 * WHAT A GATE ACTUALLY HANDED YOU, in the words the player would use.
 *
 * Operator: "Just after completing the goal give little description of the
 * unlocked content (you can hire now receptionist, you can do the bellboy work:
 * moving beds, show up rooms etc.. and like that for all other goals)."
 *
 * Two lines, because two different things open and conflating them is what the
 * old goal line did: WORK is what you may now do yourself, and HIRE is the
 * person you may now pay to stop doing it. The hire half is deliberately
 * phrased as an option, never an instruction - it is the player's business
 * whether they ever take it.
 */
export const UNLOCK_NOTES = {
  1: {
    work: "You can do the bellboy's work now: show guests up to their room and move the extra beds.",
    hire: null,
  },
  2: {
    work: "Housekeeping is open to you: turn a room and it can be sold again tonight.",
    hire: null,
  },
  3: {
    work: "Maintenance is yours: things break now, and a broken room cannot be sold until you fix it.",
    hire: null,
  },
  4: {
    work: "The phone is live. Take a booking and you are selling rooms you have not filled yet.",
    hire: null,
  },
  5: {
    work: "Every job in the hotel is open to you.",
    hire: null,
  },
};

/**
 * WHICH CONTENT STAGE OPENS HIRING FOR EACH DEPARTMENT.
 *
 * Operator: "Unlocking the next job does not unlock the staff hiring for the
 * previous one now. I get to reservation manager and still cant hire
 * receptionist."
 *
 * He is right, and the split that caused it was mine. Content opened on a small
 * work-only gate (4 check-ins) while HIRING still needed `DEPARTMENT_GOALS` (10
 * check-ins AND $300), so a player could be doing the reservations desk and
 * still be told "6 more to check guests in" for a receptionist. Two ladders at
 * different speeds, and the player is standing on both.
 *
 * ONE LADDER NOW. Reaching the stage that opens the NEXT job's work is exactly
 * the evidence that you are done learning the PREVIOUS one - so it opens that
 * department's hire at the same moment. Stage 1 opens the bellboy's work and
 * lets you hire a receptionist; stage 2 opens housekeeping's work and lets you
 * hire a bellboy; and so on.
 *
 * Affordability is still real - the recruitment fee and the daily wage are
 * checked when you actually hire - but a LIFETIME PROFIT figure is no longer in
 * the way of an unlock. That number was asking "has this hotel ever been worth
 * something", which is not the same question as "have you learned this job".
 */
export const HIRE_STAGE = {
  reception: 1,
  bellboy: 2,
  housekeeping: 3,
  maintenance: 4,
  reservations: 5,
};

/** Has the player done enough of this job to stop doing it themselves? */
export function hireUnlocked(career = {}, role) {
  const need = HIRE_STAGE[role];
  if (!need) return true;
  return contentStage(career) >= need;
}

/** What is still missing before this department can be hired, in the player's words. */
export function hireGap(career = {}, role) {
  if (hireUnlocked(career, role)) return null;
  const need = HIRE_STAGE[role];
  // The gate the player is standing on, on the way to that stage.
  const at = contentStage(career);
  const gate = CONTENT_GATES.find((g) => g.stage === Math.min(need, at + 1));
  if (!gate) return "Not yet.";
  const have = Math.max(0, career[gate.counter] ?? 0);
  const step = `${Math.max(0, gate.need - have)} more to ${GATE_DOING[gate.counter] ?? gate.counter}`;
  /**
   * SAY WHEN IT IS FURTHER THAN THE NEXT STEP. A department three stages away
   * was being labelled with the very next gate - "maintenance: 4 more to turn
   * rooms" - which reads as a promise that turning four rooms hires an engineer.
   * The next step is still the right instruction; it just must not pretend to be
   * the last one.
   */
  const after = need - at - 1;
  if (after <= 0) return step;
  return `${step}, then ${after} more job${after === 1 ? "" : "s"} to learn`;
}

/** What each gate counter is, said the way the player would say it. */
export const GATE_DOING = {
  checkIns: "check guests in",
  escorts: "show guests up to their room",
  cleans: "turn rooms",
  repairs: "fix what breaks",
  calls: "take bookings on the phone",
};

/**
 * A DEPARTMENT AS A PERSON. "hire a reception" and "hire a housekeeping" are
 * not things anybody says - the role key is a department, and the player hires
 * a human out of it.
 */
export const ROLE_PERSON = {
  reception: "receptionist",
  bellboy: "bellboy",
  housekeeping: "housekeeper",
  maintenance: "maintenance engineer",
  reservations: "reservations manager",
};

/** What HIRING a department opens, once its work is learned. */
export const HIRE_NOTES = {
  reception: "You can hire a receptionist now - they hold the desk while you are away.",
  bellboy: "You can hire a bellboy now.",
  housekeeping: "You can hire housekeeping now.",
  maintenance: "You can hire a maintenance engineer now.",
  reservations: "You can hire a reservations manager now.",
};

/** The gate the player is working on now, or null once the arc is complete. */
export function nextContentGate(career = {}) {
  const stage = contentStage(career);
  return CONTENT_GATES.find((gate) => gate.stage === stage + 1) ?? null;
}

/** A fresh career: every counter at zero. */
export function emptyCareer() {
  return {
    checkIns: 0, checkOuts: 0, escorts: 0, cleans: 0,
    repairs: 0, calls: 0, requests: 0, preps: 0, profit: 0,
  };
}

/**
 * How far along this department is, and what is still missing.
 *
 * Returns gaps in the terms the player acts in - "6 more check-ins", not a
 * ratio - because this text goes straight onto the floor and onto the staff
 * screen, and it is the only instruction the game gives about what to do next.
 */
export function unlockProgress(career = {}, role) {
  const goal = DEPARTMENT_GOALS[role];
  if (!goal) return { known: false, met: true, gaps: [], goal: null };

  const done = Math.max(0, career[goal.counter] ?? 0);
  const profit = Math.max(0, career.profit ?? 0);
  const gaps = [];

  if (done < goal.need) {
    gaps.push({
      kind: "work",
      text: `${goal.need - done} more to ${goal.doing}`,
      have: done,
      need: goal.need,
    });
  }
  if (profit < goal.profit) {
    gaps.push({
      kind: "profit",
      text: `$${goal.profit - profit} more profit`,
      have: profit,
      need: goal.profit,
    });
  }
  return { known: true, met: gaps.length === 0, gaps, goal };
}

export function isUnlocked(career, role) {
  return unlockProgress(career, role).met;
}

/**
 * The department the player is closest to opening, and has not opened yet.
 *
 * What the floor's goal line shows. Closest by the WORK counter rather than by
 * money, because the work is the part the player controls minute to minute -
 * money follows from it.
 */
export function nextDepartment(career = {}, staffedRoles = [], options = {}) {
  const staffed = new Set(staffedRoles);
  /**
   * A GOAL YOU HAVE MET BUT NOT ACTED ON MUST NOT BLOCK THE NEXT ONE.
   *
   * Operator: "When i fulfilled the first goal and it let me hire reception the
   * goal doesnt change auto, if i do not want to hire reception is up to me. The
   * next goal must not be stopped."
   *
   * Hiring is the player's choice - the whole point of the design is that they
   * CAN work every job themselves and pay nobody. So a met goal is an offer
   * standing open, not a gate: `skipMet` walks past anything already earned and
   * shows the next thing there is to go and do. The offer does not expire - the
   * staff screen still has the position open whenever they want it.
   */
  const skipMet = options.skipMet === true;
  /**
   * ONLY DEPARTMENTS THE PLAYER'S RANK COULD ACTUALLY EMPLOY.
   *
   * THE BUG THIS FIXES, found while auditing the goals after the operator's
   * playtest: this ranked departments purely by how far along their WORK
   * counter was, and ignored rank entirely. Measured with a probe - a rank-1
   * player who has answered six phones is told "Open reservations", a
   * department no rank below 4 may employ. The goal line is the game's only
   * instruction about what to do next, so that is an instruction leading
   * nowhere, and day 5 hands the player phone calls BY DESIGN, so the arc
   * itself triggers it.
   *
   * This is the same defect `Progression.unlocksAt` was written to fix on the
   * staff screen - "a rank-1 player was told a Head receptionist could employ a
   * reservations manager" - reappearing in a second place. Which is the
   * argument for `employable` being passed in rather than recomputed: the
   * caller already knows the rank, and this module stays dependency-free.
   *
   * Omitted means no filter, so every existing caller and test behaves as it did.
   */
  const employable = options.employable ? new Set(options.employable) : null;
  let best = null;
  for (const role of Object.keys(DEPARTMENT_GOALS)) {
    if (staffed.has(role)) continue;
    if (employable && !employable.has(role)) continue;
    const progress = unlockProgress(career, role);
    if (skipMet && progress.met) continue;
    const goal = progress.goal;
    const share = Math.min(1, (career[goal.counter] ?? 0) / goal.need);
    if (!best || share > best.share) best = { role, share, ...progress };
  }
  return best;
}

/**
 * How far along this department is, as ONE number, bound by whichever half is
 * furthest behind.
 *
 * THE BUG THIS FIXES. The floor's goal bar was drawn from the WORK gap alone,
 * and a gap that is MET is simply absent from the list - so once the player had
 * done the ten check-ins, the bar jumped to 100% and stayed there while the
 * money half was still short. The operator saw exactly that: a full bar, and
 * "$16 more profit" underneath it, with nothing moving. A bar that reads done
 * on an unmet goal is worse than no bar.
 *
 * Both halves have to be met, so the honest single number is the minimum.
 */
export function unlockShare(career = {}, role) {
  const goal = DEPARTMENT_GOALS[role];
  if (!goal) return 1;
  const work = Math.min(1, Math.max(0, career[goal.counter] ?? 0) / Math.max(1, goal.need));
  const money = Math.min(1, Math.max(0, career.profit ?? 0) / Math.max(1, goal.profit));
  return Math.min(work, money);
}
